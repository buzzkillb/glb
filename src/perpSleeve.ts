import { DEFAULT_PERPS_CONFIG, type AppConfig } from './config.js';
import { detectProfit, deployableSleeveUsd, type ProfitSignal } from './perpProfit.js';
import type { Keypair } from '@solana/web3.js';
import { PerpBroker } from './perpBroker.js';
import { PerpPriceFeed, PERP_MARKETS } from './perpPrice.js';
import { PerpStore, type PerpPosition } from './perpStore.js';
import {
  borrowAccrualUsd,
  decideSleeveAction,
  perpUnrealizedPnlUsd,
  smartLeverageView,
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

  /**
   * Directional net-long SOL exposure in USD at the given mark — the hedge
   * target. It MUST include BOTH ring-fenced spot sub-books: DCA inventory is
   * just as directional as grid inventory, so hedging only the grid book left
   * the DCA leg's SOL unhedged (and made the target jump the instant the grid
   * book emptied).
   */
  private gridNetLongUsd(mark: number): number {
    const gridQty = this.store.strategies.grid.subBook?.baseQty ?? 0;
    const dcaQty = this.store.strategies.dca.subBook?.baseQty ?? 0;
    // Legacy fallback ONLY when neither ring-fenced book exists at all. Falling
    // back to the whole wallet whenever a book read zero counted unrelated
    // on-chain SOL as "grid long" and could trim inventory we do not own.
    const anyBook = this.store.strategies.grid.subBook || this.store.strategies.dca.subBook;
    const qty = anyBook ? gridQty + dcaQty : (this.store.audit().chainSol ?? 0);
    return Math.max(0, qty * mark);
  }

  private equityUsd(): number {
    // Reuse the store's own chain-vs-books equity calc (spot book only), then
    // add back the sleeve's own open-position equity. Posting margin moves USDC
    // out of the wallet into the venue's position account, so the raw wallet
    // equity dips by the margin amount even though the position still holds
    // equivalent value. Without this add-back the profit signal would collapse
    // by exactly the margin just deployed — a self-cancelling budget.
    return this.store.audit().equityUsd + this.perpPositionEquityUsd(this.feed.lastPrice());
  }

  /**
   * Mark-to-market equity of the open perp position: collateral plus unrealized
   * PnL minus accrued carry, floored at 0. Returns 0 when flat. Pure and
   * synchronous so it is safe to call from the dashboard view path.
   */
  private perpPositionEquityUsd(mark: number): number {
    const pos = this.ledger.snapshotLedger().position;
    if (!pos) return 0;
    const p = this.cfg.strategies.perps ?? DEFAULT_PERPS_CONFIG;
    const notional = pos.collateralUsd * pos.leverage;
    const pnl = perpUnrealizedPnlUsd(pos.side, pos.entryPriceUsd, mark, notional);
    const hoursHeld = Math.max(0, (Date.now() - pos.openedAt) / 3_600_000);
    const carry = borrowAccrualUsd(notional, p.hourlyBorrowPct, hoursHeld);
    return Math.max(0, pos.collateralUsd + pnl - carry);
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
    // Only liquid wallet USDC can be posted as margin, so free cash stays the
    // wallet balance — margin already committed is genuinely gone from here.
    const freeCashUsd = audit.chainUsdc ?? 0;
    try {
      // equityUsd() adds the open position's mark-to-market value back, keeping
      // true net worth stable across an open/close so the budget is not
      // self-cancelling (see equityUsd()).
      this.profit = detectProfit(this.cfg.mode, this.equityUsd(), freeCashUsd, {
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
  /**
   * Read-only observability pass: refresh the mark feed so the dashboard shows
   * a live price even when the sleeve is disabled. Never sizes or trades, and
   * never touches the ledger — safe to call unconditionally.
   */
  async observe(): Promise<void> {
    const asset = this.cfg.strategies.grid.baseAsset;
    const mint = PERP_MARKETS[asset];
    if (!mint) return;
    try {
      await this.feed.fetch(mint);
      this.markHealthy = this.feed.healthy();
      this.feedReject = this.feed.rejectReason();
    } catch (e) {
      this.feedReject = `mark fetch failed: ${(e as Error).message}`;
      this.markHealthy = false;
    }
  }

  async tick(): Promise<void> {
    const p = this.cfg.strategies.perps ?? DEFAULT_PERPS_CONFIG;
    if (!p.enabled) {
      // Still surface a live mark so the dashboard tab is informative rather
      // than blank while the sleeve is off. Read-only: no sizing, no orders.
      await this.observe();
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
    // A ceiling of 0 means NO loss ceiling (derive-only posture). Without this
    // guard, `realized <= -0` would halt the sleeve on the first flat close.
    if (p.maxLossUsd > 0 && this.ledger.snapshotLedger().realizedPnlUsd <= -p.maxLossUsd) {
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
        // Route through settleClose so a rejected venue close does NOT book us
        // flat and orphan a live position.
        const held = this.ledger.snapshotLedger().position;
        if (p.haltClosesOpen && held) {
          const notional = held.collateralUsd * held.leverage;
          const hpnl = perpUnrealizedPnlUsd(held.side, held.entryPriceUsd, mark.price, notional);
          const hoursHeld = Math.max(0, (Date.now() - held.openedAt) / 3_600_000);
          const carry = borrowAccrualUsd(notional, p.hourlyBorrowPct, hoursHeld);
          const fee = held.collateralUsd * p.openFeePct * held.leverage;
          await this.settleClose(held, notional, mark.price, hpnl - carry, fee, 'flattened on halt');
        }
      }
    }

    // Live volatility, direction and liquidity for smartLeverage(): the venue
    // mark feed's 24h high/low/change/volume give us the real market state. This
    // is what makes leverage market- and bag-derived rather than a static guess.
    const vol24RangePct =
      mark.price > 0 && mark.priceHigh24H > 0 && mark.priceLow24H > 0 && mark.priceHigh24H >= mark.priceLow24H
        ? (mark.priceHigh24H - mark.priceLow24H) / mark.price
        : 0;

    const inputs: SleeveInputs = {
      equityUsd: equity,
      ledger: this.ledger.snapshotLedger(),
      gridNetLongUsd: this.gridNetLongUsd(mark.price),
      markPrice: mark.price,
      vol24RangePct,
      // The venue returns priceChange24H as a USD delta (e.g. -0.06), NOT a
      // fraction. Normalize to a fractional return so the market-direction
      // penalty is scale-correct for any asset, and clamp to a sane band.
      momentum24HPct: mark.price > 0 ? Math.max(-1, Math.min(1, mark.priceChange24H / mark.price)) : 0,
      volumeUsd: mark.volumeUsd,
    };

    const open = this.ledger.snapshotLedger().position;
    if (open) {
      await this.manageOpen(open, mark.price, p, inputs);
      return;
    }

    // Deployable amount comes from the LIVE signal (net-worth gain since our
    // baseline, capped by banked realized PnL and liquid cash), then the
    // strategy decides WHERE to deploy it. Budget 0 => no action, always safe.
    // Outstanding margin is subtracted so already-deployed profit is never
    // counted twice (the live and stored budget paths must agree).
    const deployable = profit
      ? deployableSleeveUsd(
          {
            profitSharePct: p.profitSharePct,
            realizedProfitUsePct: p.realizedProfitUsePct,
            cashUsePct: p.cashUsePct,
            maxEquityPct: p.maxEquityPct,
            maxMarginUsd: p.maxMarginUsd,
            usdcFloorUsd: p.usdcFloorUsd,
          },
          profit,
          this.ledger.snapshotLedger().outstandingMarginUsd
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
    const notional = pos.collateralUsd * pos.leverage;
    const pnl = perpUnrealizedPnlUsd(pos.side, pos.entryPriceUsd, mark, notional);

    // Borrow/funding accrual: recomputed idempotently from openedAt each tick
    // (never persisted incrementally, so it cannot double-count). Real perps
    // charge carry on open positions; ignoring it would make the stop/halt
    // ceilings optimistically late.
    const hoursHeld = Math.max(0, (Date.now() - pos.openedAt) / 3_600_000);
    const borrowUsd = borrowAccrualUsd(notional, p.hourlyBorrowPct, hoursHeld);
    const netPnl = pnl - borrowUsd; // PnL the safety ceilings must judge

    const stopUsd = pos.collateralUsd * p.stopLossMarginPct;

    // SAFETY: if we are past our margin stop (INCLUDING carry), close — our stop
    // is verified to sit INSIDE liquidation at open, so it fires before the venue.
    if (netPnl <= -stopUsd) {
      // `netPnl` already includes carry, so the fee line records ONLY the open
      // fee. Adding borrowUsd here too would count carry twice across
      // realizedPnlUsd and feesPaidUsd.
      const fee = pos.collateralUsd * p.openFeePct * pos.leverage;
      const ok = await this.settleClose(
        pos,
        notional,
        mark,
        netPnl,
        fee,
        `stop hit: net loss ${netPnl.toFixed(2)} (mark ${pnl.toFixed(2)}, carry ${borrowUsd.toFixed(3)}) <= -${stopUsd.toFixed(2)}`
      );
      if (ok) this.lastDecision = `closed ${pos.side} at stop (${pnl.toFixed(2)} USD)`;
      return;
    }

    // Hedge unwinds itself once grid exposure is back below the trigger.
    if (pos.intent === 'hedge') {
      const exposurePct = inputs.equityUsd > 0 ? inputs.gridNetLongUsd / inputs.equityUsd : 0;
      if (exposurePct < p.hedgeTriggerPct) {
        const fee = pos.collateralUsd * p.openFeePct * pos.leverage;
        const ok = await this.settleClose(
          pos,
          notional,
          mark,
          netPnl,
          fee,
          `hedge unwound: exposure back to ${(exposurePct * 100).toFixed(1)}%`
        );
        if (ok) this.lastDecision = `hedge unwound (exposure ${(exposurePct * 100).toFixed(1)}%)`;
      } else {
        this.lastDecision = `holding hedge (net ${netPnl.toFixed(2)} USD, carry ${borrowUsd.toFixed(3)})`;
      }
      return;
    }

    // Tier-3 overlay exit: take a PROFIT when the move has run far enough, or
    // cut a loss. Without an exit the overlay could only ever round-trip its
    // gain back to the stop (it has no unwind condition like the hedge does).
    // Profit target is expressed in margin terms so it is independent of
    // leverage: bank when unrealized gain reaches the take-profit share of the
    // margin posted, and cut at the same margin stop used for hedges.
    const tpUsd = pos.collateralUsd * (this.cfg.strategies.perps?.overlayTakeProfitPct ?? 0.5);
    if (netPnl >= tpUsd || netPnl <= -stopUsd) {
      const fee = pos.collateralUsd * p.openFeePct * pos.leverage;
      const why = netPnl >= tpUsd ? 'overlay take-profit' : 'overlay stop';
      const ok = await this.settleClose(
        pos,
        notional,
        mark,
        netPnl,
        fee,
        `${why}: net ${netPnl.toFixed(2)} USD (carry ${borrowUsd.toFixed(3)})`
      );
      if (ok) this.lastDecision = `closed overlay ${why.toLowerCase()} (${netPnl.toFixed(2)} USD)`;
      return;
    }
    this.lastDecision = `holding overlay (net ${netPnl.toFixed(2)} USD, carry ${borrowUsd.toFixed(3)})`;
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

  /**
   * Close a position at the venue FIRST, and only book the ledger flat once the
   * venue confirms it. The previous order booked the ledger flat before awaiting
   * the close, so a rejected/failed close left us believing we were flat while
   * the venue still held a live position — the next tick would open a SECOND
   * position on top of it, unmanaged. This mirrors the grid's "never trust the
   * ledger over the chain" rule.
   *
   * Paper mode skips the venue entirely (no network in paper), mirroring
   * openPosition, so paper stays self-contained and deterministic.
   */
  private async settleClose(
    pos: PerpPosition,
    notional: number,
    mark: number,
    netPnl: number,
    fee: number,
    note: string
  ): Promise<boolean> {
    if (this.cfg.mode === 'live') {
      const res = await this.broker.close({
        asset: this.cfg.strategies.grid.baseAsset,
        side: pos.side,
        collateralUsd: pos.collateralUsd,
        notionalUsd: notional,
        positionPubkey: pos.positionPubkey ?? '',
        walletAddress: this.walletAddr(),
        signer: this.signer,
      });
      if (!res.ok) {
        // The position still exists on-chain: keep it, do NOT book flat.
        this.ledger.record({
          ts: Date.now(),
          kind: 'reject',
          side: pos.side,
          collateralUsd: pos.collateralUsd,
          note: `close rejected: ${res.error ?? 'unknown'}; position retained`,
        });
        this.lastDecision = `close failed: ${res.error ?? 'unknown'}`;
        return false;
      }
    }
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
      note,
    });
    return true;
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
  /**
   * CROSS-BOOK CLAIM: the USD of equity the sleeve has claimed for itself —
   * margin already posted (outstanding) plus the budget it is deployable right
   * now. The spot sizer subtracts this from equity before deriving grid/DCA
   * budgets, so the SAME profit is never deployed by both books. Derived live
   * from the sleeve's own numbers (no literal), and 0 when perps is off/flat —
   * so spot sizing is unchanged whenever perps is disabled or idle.
   */
  spotClaimUsd(): number {
    const v = this.view();
    // When the sleeve is OFF it is deploying nothing, so it claims nothing and
    // spot sizing is unchanged. `view()` deliberately still computes a budget
    // for the dashboard while disabled, so gate on `enabled` here, not on the
    // budget being 0.
    if (!v.enabled) return 0;
    return Math.max(0, v.outstandingMarginUsd + v.sleeveBudgetUsd);
  }

  /**
   * Dashboard/API view of the sleeve. Pure read — no side effects.
   */
  view(): PerpsState {
    const p = this.cfg.strategies.perps ?? DEFAULT_PERPS_CONFIG;
    // The dashboard must show the live signal even while the sleeve is disabled
    // (disabled => tick() never runs, so `this.profit` stays null and the tab
    // would otherwise read zeros). Compute on demand. A cached signal with a
    // zero/invalid equity is treated as stale: at boot the chain balances may
    // not have synced yet, and caching that first sample would freeze the tab.
    const profit =
      this.profit && this.profit.currentEquityUsd > 0 && this.profit.ready
        ? this.profit
        : this.refreshProfit();
    const led = this.ledger.snapshotLedger();
    const equity = this.equityUsd();
    const mark = this.feed.lastPrice();
    const gridLong = mark > 0 ? this.gridNetLongUsd(mark) : 0;
    const eligible = Math.max(0, equity - led.principalFloorUsd);
    // Deployable budget comes from the LIVE profit signal, not a stored floor,
    // net of margin already at work so the displayed number matches what can
    // actually be committed now.
    const budget = profit
      ? deployableSleeveUsd(
          {
            profitSharePct: p.profitSharePct,
            realizedProfitUsePct: p.realizedProfitUsePct,
            cashUsePct: p.cashUsePct,
            maxEquityPct: p.maxEquityPct,
            maxMarginUsd: p.maxMarginUsd,
            usdcFloorUsd: p.usdcFloorUsd,
          },
          profit,
          led.outstandingMarginUsd
        )
      : 0;
    // TRIM target: we hedge only the exposure ABOVE the cap, not the whole bag.
    // The spot net-long is the strategy's upside and working capital; forcing it
    // to zero costs leverage and carry for no reason.
    const exposureCapUsd = equity * Math.max(0, Math.min(1, p.maxNetExposurePct ?? 0));
    const excessUsd = Math.max(0, gridLong - exposureCapUsd);
    // Leverage the hedge WOULD use right now, mirroring the auto-scaling in
    // decideSleeveAction: the smallest leverage that lets the deployable budget
    // reach the excess notional, bounded by the configured floor/ceiling. Used
    // only to report the margin the trim would require, so the dashboard matches
    // what the controller would actually do.
    const minLev = Math.max(1, p.hedgeLeverage ?? 1);
    const maxLev = Math.max(minLev, p.hedgeLeverageMax ?? minLev);
    const hedgeLev = Math.max(
      minLev,
      Math.min(
        maxLev,
        excessUsd > 0 && budget > 0
          ? (excessUsd * Math.max(0, Math.min(1, p.hedgeRatio))) / budget
          : minLev
      )
    );
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
      // The real untouchable floor is the dynamic baseline (trading-origin
      // equity). The stored ledger floor is only populated when explicitly
      // configured, so fall back to the live baseline — otherwise the tab would
      // show "$0.00 floor" while the copy claims funding is gated above it.
      principalFloorUsd:
        led.principalFloorUsd > 0
          ? led.principalFloorUsd
          : profit?.baselineEquityUsd ?? 0,
      peakEquityUsd: led.peakEquityUsd,
      outstandingMarginUsd: led.outstandingMarginUsd,
      eligibleProfitUsd: profit ? profit.newProfitUsd : eligible,
      profit: {
        baselineEquityUsd: profit?.baselineEquityUsd ?? 0,
        baselineSource: profit?.baselineSource ?? 'none',
        // Echo the live inputs the detector saw — makes "budget is 0" debuggable
        // instead of opaque when chain balances are stale/unavailable.
        currentEquityUsd: profit?.currentEquityUsd ?? equity,
        newProfitUsd: profit?.newProfitUsd ?? 0,
        freeCashUsd: profit?.freeCashUsd ?? 0,
        lifetimeRealizedUsd: profit?.lifetimeRealizedUsd ?? 0,
        windowRealizedUsd: profit?.windowRealizedUsd ?? 0,
        sampleFills: profit?.sampleFills ?? 0,
        ready: profit?.ready ?? false,
        note: profit?.note ?? 'not computed yet',
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
      /** Cap we allow the spot book to stay net-long (fraction of equity). */
      maxNetExposurePct: Math.max(0, Math.min(1, p.maxNetExposurePct ?? 0)),
      /** Hard USDC floor the sleeve may never spend (keeps spot's cash working). */
      usdcFloorUsd: Math.max(0, p.usdcFloorUsd ?? 0),
      /** USD of net-long that cap permits us to keep (never hedged). */
      exposureCapUsd,
      /**
       * Notional the trim must offset — the EXCESS above the cap, not the whole
       * delta. This is the honest target: we are capping exposure, not
       * converting the book to market-neutral.
       */
      targetHedgeNotionalUsd: excessUsd,
      /**
       * True when the book is inside the exposure cap (trim complete). Full
       * delta-neutrality is NOT the goal, so this replaces "hedgeNeutral".
       */
      withinExposureCap: gridLong <= exposureCapUsd + 1e-6,
      /** Margin required to shed the excess at the configured hedge leverage. */
      marginToNeutralizeUsd: excessUsd > 0 ? excessUsd / hedgeLev : 0,
      /** Notional currently hedged toward the excess (for progress display). */
      hedgeNotionalUsd: pos && pos.intent === 'hedge' ? pos.collateralUsd * pos.leverage : 0,
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
      // SMART LEVERAGE RANGE: derived from live volatility, not a static guess.
      // Shows the floor we never go below, the volatility-derived safe maximum,
      // and the configured ceiling, so the operator can see exactly how risky
      // the sleeve is allowed to be right now.
      maxLeverage: p.maxLeverage,
      leverageRange: (() => {
        const m = this.feed.mark();
        const vol =
          m && m.price > 0 && m.priceHigh24H > 0 && m.priceLow24H > 0
            ? (m.priceHigh24H - m.priceLow24H) / m.price
            : 0;
        const equity = this.equityUsd();
        const mark = this.feed.lastPrice();
        return smartLeverageView({
          stopLossMarginPct: p.stopLossMarginPct,
          vol24RangePct: vol,
          volMultiplier: p.leverageVolMultiplier ?? 1.2,
          bagExposurePct: equity > 0 && mark > 0 ? this.gridNetLongUsd(mark) / equity : 0,
          exposureCapPct: p.maxNetExposurePct ?? 0,
          // Venue priceChange24H is a USD delta; normalize to a fraction.
          momentum24HPct:
            m && m.price > 0 ? Math.max(-1, Math.min(1, m.priceChange24H / m.price)) : 0,
          volumeUsd: m?.volumeUsd ?? 0,
          minVolumeUsd: p.leverageMinVolumeUsd ?? 0,
          ceilingOverride: p.maxLeverage,
        });
      })(),
      note:
        'Sleeve is funded ONLY by equity above the untouchable principal floor; base spot capital is never at risk.',
    };
  }
}
