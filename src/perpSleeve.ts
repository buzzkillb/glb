import { DEFAULT_PERPS_CONFIG, type AppConfig } from './config.js';
import { detectProfit, deployableSleeveUsd, type ProfitSignal } from './perpProfit.js';
import type { Keypair } from '@solana/web3.js';
import { PerpBroker } from './perpBroker.js';
import { PerpPriceFeed, PERP_MARKETS } from './perpPrice.js';
import { PerpStore, type PerpPosition } from './perpStore.js';
import {
  computeSleeveBudget,
  decideSleeveAction,
  stopInsideLiquidation,
  type PerpSleeveConfig,
  type SleeveInputs,
} from './perpStrategy.js';
import type { PerpsState } from './types.js';
import type { StateStore } from './store.js';

/**
 * PERPS SLEEVE CONTROLLER.
 *
 * Ties the keyless perps mark feed, the isolated perps ledger, and the
 * profit-funded sizing rules into the SAME loop the grid runs on. It is
 * deliberately additive: it never mutates the spot account or the grid/DCA
 * sub-books — it only *reads* them to size a hedge and writes to its own
 * `perps-<mode>.json` ledger.
 *
 * SAFETY POSTURE:
 *   - builds are always attempted so the dashboard shows a live quote, but a
 *     real transaction is only SENT when LIVE_ARM=1 (dry-run/kill-switch guard
 *     is enforced inside PerpBroker).
 *   - a position is only booked when the venue returns entry AND liquidation
 *     prices, and our stop is verified to sit INSIDE liquidation.
 *   - a realized-loss ceiling halts the sleeve permanently until cleared.
 */
export class PerpSleeve {
  private feed: PerpPriceFeed;
  private ledger: PerpStore;
  private broker: PerpBroker;
  private lastDecision = 'idle';
  private markHealthy = false;
  private feedReject = '';
  /** Latest dynamic profit signal derived from the bot's own records. */
  private profit: ProfitSignal | null = null;

  constructor(
    private cfg: AppConfig,
    private store: StateStore,
    private signer?: Keypair
  ) {
    const p = cfg.strategies.perps ?? DEFAULT_PERPS_CONFIG;
    this.feed = new PerpPriceFeed({
      apiUrl: p.apiUrl,
      maxSingleJumpPct: cfg.risk.maxSingleJumpPct,
    });
    this.ledger = new PerpStore(cfg.mode);
    this.broker = new PerpBroker({
      apiUrl: p.apiUrl,
      rpcUrl: cfg.rpcUrl,
      slippageBps: p.slippageBps,
      // Only send real txs in live mode; dry-run/kill-switch still gate inside.
      paper: cfg.mode !== 'live',
    });
  }

  /** Grid-owned SOL inventory in USD at the given mark — the hedge target. */
  private gridNetLongUsd(mark: number): number {
    const g = this.store.strategies.grid.subBook;
    const gridQty = g?.baseQty ?? 0;
    // Fall back to the wallet's actual SOL when the grid sub-book is empty or
    // mid-recycle: the exposure still exists on-chain even if the book is flat.
    const walletSol = this.store.audit().chainSol ?? 0;
    const qty = gridQty > 0 ? gridQty : walletSol;
    return Math.max(0, qty * mark);
  }

  private equityUsd(): number {
    // Reuse the store's own chain-vs-books equity calc (spot book only).
    return this.store.audit().equityUsd;
  }

  /**
   * Refresh the LIVE profit signal from our own records. This replaces any
   * hardcoded floor: the baseline is the first equity sample we ever archived,
   * and the deployable amount is limited to liquid USDC so SOL grid inventory
   * is never double-counted as spendable margin. The window and confidence
   * thresholds are operator-configurable, never literals.
   */
  private refreshProfit(): ProfitSignal | null {
    const p = this.cfg.strategies.perps ?? DEFAULT_PERPS_CONFIG;
    const audit = this.store.audit();
    const freeCashUsd = audit.chainUsdc ?? 0;
    try {
      this.profit = detectProfit(this.cfg.mode, audit.equityUsd, freeCashUsd, {
        windowHours: p.profitWindowHours,
        minFillsForConfidence: p.minFillsForConfidence,
      });
    } catch (e) {
      console.warn(`[perps] profit detect failed: ${(e as Error).message}`);
    }
    return this.profit;
  }

  /**
   * One sleeve step. Fetch the venue mark, seed/track the principal floor, then
   * either manage an open position or consider opening one. Returns void;
   * read state via `view()` for the dashboard.
   */
  async tick(): Promise<void> {
    const p = this.cfg.strategies.perps ?? DEFAULT_PERPS_CONFIG;
    if (!p.enabled) {
      this.lastDecision = 'sleeve disabled';
      return;
    }

    const asset = this.cfg.strategies.grid.baseAsset; // SOL
    const mint = PERP_MARKETS[asset];
    if (!mint) {
      this.lastDecision = `no perp market for ${asset}`;
      return;
    }

    const mark = await this.feed.fetch(mint);
    this.markHealthy = this.feed.healthy();
    this.feedReject = this.feed.rejectReason();
    if (!mark) {
      this.lastDecision = `mark rejected/unavailable: ${this.feedReject}`;
      return;
    }

    const equity = this.equityUsd();
    // Dynamic profit signal from our own archive/journal — no hardcoded floor.
    const profit = this.refreshProfit();
    // Keep a stored principal floor ONLY when explicitly configured; otherwise
    // the live signal (baseline = first archived equity) is authoritative.
    if (p.baselineEquityUsd > 0) this.ledger.seedFloor(equity, p.baselineEquityUsd);
    // Observability only — tracks the all-time peak net worth.
    this.ledger.observePeakEquity(equity);

    // Loss ceiling: a breach halts the sleeve (no new margin) permanently.
    const halted = this.ledger.snapshotLedger().halted;
    if (this.ledger.snapshotLedger().realizedPnlUsd <= -p.maxLossUsd) {
      if (!halted) {
        this.ledger.setHalt(
          `realized loss ${this.ledger.snapshotLedger().realizedPnlUsd.toFixed(2)} breached -${p.maxLossUsd}`
        );
        this.ledger.record({
          ts: Date.now(),
          kind: 'halt',
          note: `sleeve halted: loss ceiling`,
        });
        // Optional: flatten immediately instead of leaving the position managed.
        const held = this.ledger.snapshotLedger().position;
        if (p.haltClosesOpen && held) {
          const notional = held.collateralUsd * held.leverage;
          await this.broker.close({
            asset: this.cfg.strategies.grid.baseAsset,
            side: held.side,
            notionalUsd: notional,
            walletAddress: this.walletAddr(),
            signer: this.signer,
          });
          this.ledger.setPosition(null);
          this.ledger.record({ ts: Date.now(), kind: 'close', side: held.side, note: 'flattened on halt' });
        }
      }
    }

    const inputs: SleeveInputs = {
      equityUsd: equity,
      ledger: this.ledger.snapshotLedger(),
      gridNetLongUsd: this.gridNetLongUsd(mark.price),
      markPrice: mark.price,
    };

    const open = this.ledger.snapshotLedger().position;
    if (open) {
      await this.manageOpen(open, mark.price, p, inputs);
      return;
    }

    // Deployable amount comes from the LIVE signal (net-worth gain since our
    // baseline, capped by banked realized PnL and liquid cash), then the
    // strategy decides WHERE to deploy it. Budget 0 => no action, always safe.
    const deployable = profit
      ? deployableSleeveUsd(
          {
            profitSharePct: p.profitSharePct,
            realizedProfitUsePct: p.realizedProfitUsePct,
            cashUsePct: p.cashUsePct,
            maxEquityPct: p.maxEquityPct,
            maxMarginUsd: p.maxMarginUsd,
          },
          profit
        )
      : 0;

    if (deployable <= 0) {
      this.lastDecision = profit?.note ?? 'no deployable profit yet';
      return;
    }

    // Hand the live ceiling to the strategy so it never re-derives a floor.
    const signaledInputs: SleeveInputs = { ...inputs, deployableMarginUsd: deployable };
    const decision = decideSleeveAction(p, signaledInputs);
    const marginUsd = Math.min(decision.marginUsd, deployable);
    if (marginUsd <= 0) {
      this.lastDecision = decision.reason;
      return;
    }

    await this.openPosition({ ...decision, marginUsd }, mark.price, p);
  }

  private async manageOpen(
    pos: PerpPosition,
    mark: number,
    p: PerpSleeveConfig,
    inputs: SleeveInputs
  ): Promise<void> {
    // Unrealized PnL on the perp (paper/mark model — identical formula to what
    // the venue would report).
    const dir = pos.side === 'short' ? 1 : -1; // short profits when mark falls
    const moveFrac = (mark - pos.entryPriceUsd) / pos.entryPriceUsd;
    const notional = pos.collateralUsd * pos.leverage;
    const pnl = dir * moveFrac * notional;

    // Borrow/funding accrual: recomputed idempotently from openedAt each tick
    // (never persisted incrementally, so it cannot double-count). Real perps
    // charge carry on open positions; ignoring it would make the stop/halt
    // ceilings optimistically late.
    const hoursHeld = Math.max(0, (Date.now() - pos.openedAt) / 3_600_000);
    const borrowUsd = notional * p.hourlyBorrowPct * hoursHeld;
    const netPnl = pnl - borrowUsd; // PnL the safety ceilings must judge

    const stopUsd = pos.collateralUsd * p.stopLossMarginPct;

    // SAFETY: if we are past our margin stop (INCLUDING carry), close — our stop
    // is verified to sit INSIDE liquidation at open, so it fires before the venue.
    if (netPnl <= -stopUsd) {
      const fee = pos.collateralUsd * p.openFeePct * pos.leverage + borrowUsd;
      this.ledger.setPosition(null);
      this.ledger.rollRealized(netPnl, fee);
      this.ledger.record({
        ts: Date.now(),
        kind: 'close',
        side: pos.side,
        collateralUsd: pos.collateralUsd,
        notionalUsd: notional,
        pnlUsd: netPnl,
        price: mark,
        note: `stop hit: net loss ${netPnl.toFixed(2)} (mark ${pnl.toFixed(2)}, carry ${borrowUsd.toFixed(3)}) <= -${stopUsd.toFixed(2)}`,
      });
      await this.broker.close({
        asset: this.cfg.strategies.grid.baseAsset,
        side: pos.side,
        notionalUsd: notional,
        walletAddress: this.walletAddr(),
        signer: this.signer,
      });
      this.lastDecision = `closed ${pos.side} at stop (${pnl.toFixed(2)} USD)`;
      return;
    }

    // Hedge unwinds itself once grid exposure is back below the trigger.
    if (pos.intent === 'hedge') {
      const exposurePct = inputs.equityUsd > 0 ? inputs.gridNetLongUsd / inputs.equityUsd : 0;
      if (exposurePct < p.hedgeTriggerPct) {
        const fee = pos.collateralUsd * p.openFeePct * pos.leverage + borrowUsd;
        this.ledger.setPosition(null);
        this.ledger.rollRealized(netPnl, fee);
        this.ledger.record({
          ts: Date.now(),
          kind: 'close',
          side: pos.side,
          collateralUsd: pos.collateralUsd,
          notionalUsd: notional,
          pnlUsd: netPnl,
          price: mark,
          note: `hedge unwound: exposure back to ${(exposurePct * 100).toFixed(1)}%`,
        });
        await this.broker.close({
          asset: this.cfg.strategies.grid.baseAsset,
          side: pos.side,
          notionalUsd: notional,
          walletAddress: this.walletAddr(),
          signer: this.signer,
        });
        this.lastDecision = `hedge unwound (exposure ${(exposurePct * 100).toFixed(1)}%)`;
      } else {
        this.lastDecision = `holding hedge (net ${netPnl.toFixed(2)} USD, carry ${borrowUsd.toFixed(3)})`;
      }
    } else {
      this.lastDecision = `holding overlay (net ${netPnl.toFixed(2)} USD, carry ${borrowUsd.toFixed(3)})`;
    }
  }

  private walletAddr(): string {
    if (!this.signer) return '';
    return this.signer.publicKey.toBase58();
  }

  private async openPosition(
    decision: { marginUsd: number; lev: number; side: 'long' | 'short'; intent: 'hedge' | 'overlay'; reason: string },
    mark: number,
    p: PerpSleeveConfig
  ): Promise<void> {
    const addr = this.walletAddr();
    const live = this.cfg.mode === 'live';

    // Paper mode cannot build a venue tx (no funded signer), so synthesize a
    // conservative LOCAL quote from the mark. This keeps paper fully
    // self-contained and still exercises sizing, ledger, and dashboard.
    if (!live && !addr) {
      const q = this.localQuote(decision, mark, p);
      if (!stopInsideLiquidation(decision.side, q.entryPriceUsd, q.liquidationPriceUsd, p.stopLossMarginPct, q.leverage)) {
        this.lastDecision = 'rejected (paper): stop not inside liquidation';
        return;
      }
      this.bookPosition(decision, q);
      return;
    }

    if (!addr) {
      this.lastDecision = 'no wallet address available';
      return;
    }

    const res = await this.broker.open({
      asset: this.cfg.strategies.grid.baseAsset,
      side: decision.side,
      collateralUsd: decision.marginUsd,
      leverage: decision.lev,
      walletAddress: addr,
      signer: this.signer,
    });

    if (!res.ok || !res.quote) {
      this.ledger.record({
        ts: Date.now(),
        kind: 'reject',
        side: decision.side,
        collateralUsd: decision.marginUsd,
        note: `open rejected: ${res.error}`,
      });
      this.lastDecision = `open rejected: ${res.error}`;
      return;
    }

    const q = res.quote;
    // SAFETY ASSERTION: our stop must sit inside the venue liquidation.
    if (
      !stopInsideLiquidation(decision.side, q.entryPriceUsd, q.liquidationPriceUsd, p.stopLossMarginPct, q.leverage)
    ) {
      this.ledger.record({
        ts: Date.now(),
        kind: 'reject',
        side: decision.side,
        collateralUsd: decision.marginUsd,
        note: `stop at ${(p.stopLossMarginPct * 100).toFixed(0)}% margin not inside liquidation ${q.liquidationPriceUsd}`,
      });
      this.lastDecision = 'rejected: stop not inside liquidation';
      return;
    }

    this.bookPosition(decision, {
      entryPriceUsd: q.entryPriceUsd,
      liquidationPriceUsd: q.liquidationPriceUsd,
      openFeeUsd: q.openFeeUsd,
      leverage: q.leverage,
      collateralUsd: q.collateralUsd,
      notionalUsd: q.notionalUsd,
      positionPubkey: q.positionPubkey,
    });
  }

  /**
   * Paper-only synthetic quote. Models the venue exactly enough to exercise
   * sizing/ledger/dashboard without a network round-trip or a funded signer:
   * a position is liquidated when roughly (1 - 1/leverage) adverse, and the
   * open fee is ~0.06% of notional (matches live pool-info).
   */
  private localQuote(
    decision: { marginUsd: number; lev: number; side: 'long' | 'short'; reason: string; intent: 'hedge' | 'overlay' },
    mark: number,
    p: PerpSleeveConfig
  ) {
    const lev = Math.max(1, decision.lev);
    const adverseToLiq = 1 - 1 / lev; // rough venue approximation
    const entry = mark;
    const liquidation =
      decision.side === 'short' ? entry * (1 + adverseToLiq) : entry * (1 - adverseToLiq);
    return {
      entryPriceUsd: entry,
      liquidationPriceUsd: liquidation,
      openFeeUsd: decision.marginUsd * lev * p.openFeePct,
      leverage: lev,
      collateralUsd: decision.marginUsd,
      notionalUsd: decision.marginUsd * lev,
      positionPubkey: `paper-${Date.now()}`,
    };
  }

  /** Book an opened position into the isolated ledger + tape. */
  private bookPosition(
    decision: { side: 'long' | 'short'; intent: 'hedge' | 'overlay'; reason: string },
    q: {
      entryPriceUsd: number;
      liquidationPriceUsd: number;
      openFeeUsd: number;
      leverage: number;
      collateralUsd: number;
      notionalUsd: number;
      positionPubkey?: string;
    }
  ): void {
    const pos: PerpPosition = {
      side: decision.side,
      collateralUsd: q.collateralUsd,
      leverage: q.leverage,
      entryPriceUsd: q.entryPriceUsd,
      liquidationPriceUsd: q.liquidationPriceUsd,
      openedAt: Date.now(),
      positionPubkey: q.positionPubkey,
      intent: decision.intent,
    };
    this.ledger.setPosition(pos);
    this.ledger.rollRealized(0, q.openFeeUsd);
    this.ledger.record({
      ts: Date.now(),
      kind: 'open',
      side: decision.side,
      collateralUsd: q.collateralUsd,
      notionalUsd: q.notionalUsd,
      price: q.entryPriceUsd,
      note: `${decision.intent} opened: ${decision.reason}; liq ${q.liquidationPriceUsd.toFixed(2)}`,
    });
    this.lastDecision = `opened ${decision.side} ${decision.intent} (${q.collateralUsd} @ ${q.leverage}x)`;
  }

  /** Perps ledger tape (open/close/halt/reject) for the dashboard tab. */
  ledgerView(): { halted: boolean; haltReason: string; realizedPnlUsd: number; feesPaidUsd: number; principalFloorUsd: number; outstandingMarginUsd: number; peakEquityUsd: number; history: unknown[] } {
    const l = this.ledger.snapshotLedger();
    return {
      halted: l.halted,
      haltReason: l.haltReason,
      realizedPnlUsd: l.realizedPnlUsd,
      feesPaidUsd: l.feesPaidUsd,
      principalFloorUsd: l.principalFloorUsd,
      outstandingMarginUsd: l.outstandingMarginUsd,
      peakEquityUsd: l.peakEquityUsd,
      history: l.history.slice(-100),
    };
  }

  /**
   * Dashboard/API view of the sleeve. Pure read — no side effects.
   */
  view(): PerpsState {
    const p = this.cfg.strategies.perps ?? DEFAULT_PERPS_CONFIG;
    const led = this.ledger.snapshotLedger();
    const equity = this.equityUsd();
    const mark = this.feed.lastPrice();
    const gridLong = mark > 0 ? this.gridNetLongUsd(mark) : 0;
    const eligible = Math.max(0, equity - led.principalFloorUsd);
    // Deployable budget comes from the LIVE profit signal, not a stored floor.
    const budget = this.profit
      ? deployableSleeveUsd(
          {
            profitSharePct: p.profitSharePct,
            realizedProfitUsePct: p.realizedProfitUsePct,
            cashUsePct: p.cashUsePct,
            maxEquityPct: p.maxEquityPct,
            maxMarginUsd: p.maxMarginUsd,
          },
          this.profit
        )
      : 0;
    const pos = led.position;
    const liquidationBufferPct =
      pos && mark > 0
        ? pos.side === 'short'
          ? (pos.liquidationPriceUsd - mark) / mark
          : (mark - pos.liquidationPriceUsd) / mark
        : 0;

    return {
      enabled: p.enabled,
      halted: led.halted,
      haltReason: led.haltReason,
      markPrice: mark,
      markHealthy: this.markHealthy,
      feedRejectReason: this.feedReject,
      principalFloorUsd: led.principalFloorUsd,
      peakEquityUsd: led.peakEquityUsd,
      outstandingMarginUsd: led.outstandingMarginUsd,
      eligibleProfitUsd: this.profit ? this.profit.newProfitUsd : eligible,
      profit: {
        baselineEquityUsd: this.profit?.baselineEquityUsd ?? 0,
        baselineSource: this.profit?.baselineSource ?? 'none',
        newProfitUsd: this.profit?.newProfitUsd ?? 0,
        freeCashUsd: this.profit?.freeCashUsd ?? 0,
        lifetimeRealizedUsd: this.profit?.lifetimeRealizedUsd ?? 0,
        windowRealizedUsd: this.profit?.windowRealizedUsd ?? 0,
        sampleFills: this.profit?.sampleFills ?? 0,
        ready: this.profit?.ready ?? false,
        note: this.profit?.note ?? 'not computed yet',
      },
      sleeveBudgetUsd: budget,
      edgePct: equity > 0 ? budget / equity : 0,
      gridNetLongUsd: gridLong,
      exposurePct: equity > 0 ? gridLong / equity : 0,
      hedgeActive: !!pos && pos.intent === 'hedge',
      hedgeCoveragePct:
        pos && pos.intent === 'hedge' && gridLong > 0
          ? Math.min(1, (pos.collateralUsd * pos.leverage) / gridLong)
          : 0,
      realizedPnlUsd: led.realizedPnlUsd,
      feesPaidUsd: led.feesPaidUsd,
      open: pos
        ? {
            side: pos.side,
            collateralUsd: pos.collateralUsd,
            leverage: pos.leverage,
            entryPriceUsd: pos.entryPriceUsd,
            liquidationPriceUsd: pos.liquidationPriceUsd,
            notionalUsd: pos.collateralUsd * pos.leverage,
            openedAt: pos.openedAt,
          }
        : null,
      liquidationBufferPct,
      lastDecision: this.lastDecision,
      note:
        'Sleeve is funded ONLY by equity above the untouchable principal floor; base spot capital is never at risk.',
    };
  }
}
