import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from './config.js';
import type {
  AccountState,
  Order,
  Trade,
  StrategyRuntimeState,
  StrategySubBook,
  Snapshot,
  Position,
  PerfBook,
} from './types.js';
import { notify } from './notify.js';
import {
  appendJournal,
  appendEquityArchive,
  readJournal,
  seedJournalFromLedger,
  reconcileCostBasis,
  distributeUntracked,
  isSyntheticFill,
  type FillEntry,
  type CostBasisResult,
} from './journal.js';

const STATE_DIR = join(process.cwd(), '.botstate');

/** Coarse cadence for the forever equity archive (15 min). */
const EQUITY_ARCHIVE_MS = 15 * 60_000;

/** Downsample a time series to at most `max` points, keeping the last point. */
/**
 * Neutral perps-sleeve view. Always present so the dashboard/API has a stable
 * shape even before the sleeve has run or when it is disabled.
 */
function emptyPerpsState(): import('./types.js').PerpsState {
  return {
    enabled: false,
    halted: false,
    haltReason: '',
    markPrice: 0,
    markHealthy: false,
    feedRejectReason: '',
    principalFloorUsd: 0,
    peakEquityUsd: 0,
    outstandingMarginUsd: 0,
    eligibleProfitUsd: 0,
    profit: {
      baselineEquityUsd: 0,
      baselineSource: 'none',
      currentEquityUsd: 0,
      newProfitUsd: 0,
      freeCashUsd: 0,
      lifetimeRealizedUsd: 0,
      windowRealizedUsd: 0,
      sampleFills: 0,
      ready: false,
      note: 'not computed yet',
    },
    sleeveBudgetUsd: 0,
    edgePct: 0,
    gridNetLongUsd: 0,
    exposurePct: 0,
    hedgeActive: false,
    hedgeCoveragePct: 0,
    maxNetExposurePct: 0,
    exposureCapUsd: 0,
    targetHedgeNotionalUsd: 0,
    marginToNeutralizeUsd: 0,
    withinExposureCap: true,
    hedgeNotionalUsd: 0,
    maxLeverage: 0,
    leverageRange: {
      survivalBound: 1,
      ceiling: 1,
      exposureFactor: 1,
      momentumFactor: 1,
      liquidityFactor: 1,
      recommended: 1,
      floor: 1,
      vol24RangePct: 0,
      bagExposurePct: 0,
      momentum24HPct: 0,
      volumeUsd: 0,
      explanation: 'no market data yet — failing safe at 1x',
    },
    realizedPnlUsd: 0,
    feesPaidUsd: 0,
    open: null,
    liquidationBufferPct: 0,
    lastDecision: 'not started',
    note: '',
  };
}

function decimate<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]!);
  const last = arr[arr.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export interface StoreEvents {
  order: (o: Order) => void;
  trade: (t: Trade) => void;
  snapshot: (s: Snapshot) => void;
}

export class StateStore extends EventEmitter {
  account: AccountState;
  orders: Order[] = [];
  trades: Trade[] = [];
  strategies: StrategyRuntimeState;
  price = 0;
  paused = false;
  pauseReason = '';
  /** Rolling equity-curve history (ts + equity USD) for the dashboard chart.
   *  Appended at most once per poll; ring-buffered to keep the payload small. */
  equityHistory: { ts: number; equityUsd: number }[] = [];
  /** 7 days of equity samples at the default 30s poll ≈ 20k points. */
  private maxEquityPoints = 20_160;
  private maxOrders = 2000;
  private maxTrades = 5000;
  /** Accumulated band-occupancy counters (persisted with state). */
  private bandSamples = 0;
  private bandInside = 0;
  /** Last real market context from the engine, so REST/plain snapshots also
   *  surface live VWAP + 24h range instead of falling back to zeros. */
  private lastMarket: { vwap: number; high24h: number; low24h: number; price24hAgo: number };
  /** Throttle for the forever equity archive (one coarse sample / 15 min). */
  private lastEquityArchiveAt = 0;
  /** Last cost-basis reconciliation result (for the accountability audit UI). */
  private lastCostBasis?: CostBasisResult;

  /**
   * PERPS SLEEVE hook: when set (by the engine), the snapshot includes the
   * sleeve's live view. Kept as an injected provider so the store never depends
   * on the perps module — the human trader/dashboard can always see sleeve
   * state, and the sleeve's own ledger stays isolated.
   */
  perpsProvider?: () => import('./types.js').PerpsState;

  /** Perps ledger tape reader (open/close/halt/reject) for the dashboard. */
  perpsLedgerProvider?: () => unknown;

  constructor(private cfg: AppConfig) {
    super();
    this.account = {
      mode: cfg.mode,
      balances: this.initialBalances(),
      positions: {},
      realizedPnlUsd: 0,
      feesPaidUsd: 0,
      openQty: 0,
      vwap: 0,
    };
    this.lastMarket = { vwap: 0, high24h: 0, low24h: 0, price24hAgo: 0 };
    this.strategies = {
      grid: {
        enabled: cfg.strategies.grid.enabled,
        levels: [],
      },
      dca: {
        enabled: cfg.strategies.dca.enabled,
        lastBuyAt: undefined,
      },
      memes: {},
      perps: emptyPerpsState(),
    };
    // Seed ring-fenced meme slots so the dashboard/API always has a home for them.
    for (const m of cfg.strategies.memes) {
      this.strategies.memes[m.id] = {
        id: m.id,
        enabled: m.enabled,
        price: 0, vwap: 0, high24h: 0, low24h: 0,
        vol24hUsd: 0, liquidityUsd: 0,
        baseQty: 0, avgCostPerBase: 0,
        realizedPnlUsd: 0, feesPaidUsd: 0, deployedUsd: 0,
        buys: 0,
        admitted: false, admissionReason: 'pending',
      };
    }
    // CRASH RECOVERY: reconcile any previously-persisted runtime state (same
    // mode) so a restart keeps positions/pnl/trailing signals instead of resetting.
    this.loadPersisted();
    // FOREVER JOURNAL: seed the append-only audit trail from whatever fills
    // the ledger still holds, so history predating this upgrade is not lost.
    this.initJournal();
  }

  /**
   * Seed the forever trade journal from the in-memory ledger (idempotent) and
   * reconcile the persisted SOL cost basis against the real trade tape.
   * Called once at startup. Measurement only — never throws.
   */
  private initJournal(): void {
    try {
      const seeded = seedJournalFromLedger(this.cfg.mode, this.trades);
      if (seeded > 0) console.log(`[journal] seeded ${seeded} historical fills into the forever journal`);
    } catch (e) {
      console.warn(`[journal] seed failed: ${(e as Error).message}`);
    }
  }

  private initialBalances(): { SOL: number; USDC: number } {
    // In paper mode we simulate a balance. We allocate a fixed notional of USDC.
    // Paper default: 1000 USDC + 5 SOL so grid/dca has room.
    if (this.cfg.mode === 'paper') {
      return { SOL: 5, USDC: 1000 };
    }
    // Live mode: balances are polled from chain + Jito; start at zero and overlay.
    return { SOL: 0, USDC: 0 };
  }

  upsertPosition(pos: Position): void {
    const key = `${pos.baseAsset}/${pos.quoteAsset}`;
    this.account.positions[key] = pos;
  }

  getPosition(base: string, quote: string): Position | undefined {
    return this.account.positions[`${base}/${quote}`];
  }

  /**
   * RING-FENCED SUB-BOOKS (H3): lazily create/return a strategy's own slice of
   * the shared SOL position. Grid and DCA each get an independent ledger for
   * qty/cost/PnL/fees; the aggregate Position remains the source of truth for
   * balances, and every fill path must keep sum(subBooks) === position.baseQty.
   */
  subBook(strategy: 'grid' | 'dca'): StrategySubBook {
    const book =
      strategy === 'grid' ? this.strategies.grid.subBook : this.strategies.dca.subBook;
    if (book) return book;
    const fresh: StrategySubBook = { baseQty: 0, avgCostPerBase: 0, realizedPnlUsd: 0, feesPaidUsd: 0 };
    if (strategy === 'grid') this.strategies.grid.subBook = fresh;
    else this.strategies.dca.subBook = fresh;
    return fresh;
  }

  /** Conservation invariant (H3): Σ sub-book qty === aggregate position qty. */
  subBooksConserved(): boolean {
    const pos = this.getPosition('SOL', 'USDC');
    const total =
      (this.strategies.grid.subBook?.baseQty ?? 0) +
      (this.strategies.dca.subBook?.baseQty ?? 0);
    return Math.abs(total - (pos ? pos.baseQty : 0)) < 1e-6;
  }

  /**
   * Reconcile the grid/dca sub-book quantities down to the real on-chain
   * position after a balance sync. Network/priority fees are paid from NATIVE
   * SOL, so every swap burns a hair more SOL than the strategy books record,
   * and the shrink-to-available path can also sell less than the book expected.
   * Over a session those tiny gaps accumulate: the books drift above the chain
   * balance (the dashboard's "held SOL" then overstates reality). This trims
   * the excess proportionally between the books and books it as fees — the
   * difference genuinely was fees — so sum(subBooks) === position.baseQty
   * again (the H3 conservation invariant holds against on-chain truth).
   * Returns the trimmed SOL (0 when already consistent). Never mints SOL back
   * if the books understate the chain balance; the next fill reconciles that.
   */
  reconcileSubBooksToPosition(priceUsd: number): number {
    const pos = this.getPosition('SOL', 'USDC');
    if (!pos || !(priceUsd > 0)) return 0;
    const g = this.strategies.grid.subBook;
    const d = this.strategies.dca.subBook;
    if (!g && !d) return 0;
    const gq = g?.baseQty ?? 0;
    const dq = d?.baseQty ?? 0;
    const total = gq + dq;
    const drift = total - pos.baseQty;
    if (drift <= 1e-9 || total <= 0) return 0;
    const trim = Math.min(drift, total);
    const trimUsd = trim * priceUsd;
    // Book the trim as a reconciliation adjustment, NOT as fees: real network
    // fees are already captured per-trade (recordTrade). Valuing the inventory
    // correction at spot inflated feesPaidUsd (e.g. a 5 SOL trim during a
    // rally logged as ~$560 of "fees"), making per-strategy Net dishonest.
    if (g && gq > 0) {
      const share = gq / total;
      g.baseQty -= trim * share;
      g.reconAdjustUsd = (g.reconAdjustUsd ?? 0) + trimUsd * share;
    }
    if (d && dq > 0) {
      const share = dq / total;
      d.baseQty -= trim * share;
      d.reconAdjustUsd = (d.reconAdjustUsd ?? 0) + trimUsd * share;
    }
    return trim;
  }

  upsertOrder(order: Order): void {
    const i = this.orders.findIndex((o) => o.id === order.id);
    if (i >= 0) {
      this.orders[i] = order;
    } else {
      this.orders.unshift(order);
    }
    if (this.orders.length > this.maxOrders) {
      this.orders = this.orders.slice(0, this.maxOrders);
    }
    this.emit('order', order);
  }

  recordTrade(trade: Trade): void {
    this.trades.unshift(trade);
    // FOREVER JOURNAL: mirror every fill into the append-only JSONL audit
    // trail so history survives the 5000-fill ledger cap. Best-effort.
    appendJournal(this.cfg.mode, [trade]);
    // Maintain a cumulative running fee total so the dashboard never loses fees
    // once trades age out of the visible snapshot window.
    if (trade.feeUsd) this.account.feesPaidUsd += trade.feeUsd;
    if (this.trades.length > this.maxTrades) {
      this.trades = this.trades.slice(0, this.maxTrades);
    }
    this.emit('trade', trade);

    // NOTIFICATIONS (#8): alert on meaningful, real events — realized profit
    // banks and realized losses — so a supervised wallet gets pinged without
    // watching the terminal. Marked quiet (log-only, no Telegram) so routine
    // fills don't spam; the dashboard + event log keep the full audit trail.
    if (typeof trade.realizedPnlUsd === 'number') {
      const dir = trade.direction;
      if (dir === 'SELL' && trade.realizedPnlUsd > 0) {
        notify('profit', `TP bank +${trade.realizedPnlUsd.toFixed(2)} (${trade.strategyId} @ ${trade.price.toFixed(4)})`, true);
      } else if (dir === 'SELL' && trade.realizedPnlUsd < 0) {
        notify('loss', `Realized -${Math.abs(trade.realizedPnlUsd).toFixed(2)} (${trade.strategyId} @ ${trade.price.toFixed(4)})`);
      }
    }
  }

  newOrderId(): string {
    return randomUUID();
  }

  /**
   * Total USDC currently committed to open grid buy orders + DCA basket value.
   * Used to enforce the RISK_MAX_USDC deployment cap on every new buy.
   */
  totalDeployedUsd(): number {
    let deployed = 0;
    // USDC reserved by resting grid BUY orders (fills when price drops to them).
    for (const o of this.orders) {
      if (o.status === 'OPEN' && o.side === 'BUY') deployed += o.quoteQty;
    }
    // Add the value of SOL currently held at current price (cost basis).
    const pos = this.account.positions['SOL/USDC'];
    if (pos && pos.baseQty > 0 && this.price > 0) {
      deployed += pos.baseQty * pos.avgCostPerBase;
    }
    return deployed;
  }

  /** Build and emit a full snapshot for the dashboard. */
  snapshot(
    cfg: AppConfig,
    market: { vwap: number; high24h: number; low24h: number; price24hAgo: number } = { vwap: 0, high24h: 0, low24h: 0, price24hAgo: 0 }
  ): Snapshot {
    // Persist the latest real market context; when called without one (REST),
    // fall back to the most recent real values rather than zeros.
    if (market.vwap) this.lastMarket.vwap = market.vwap;
    if (market.high24h) this.lastMarket.high24h = market.high24h;
    if (market.low24h) this.lastMarket.low24h = market.low24h;
    if (market.price24hAgo) this.lastMarket.price24hAgo = market.price24hAgo;
    market = { ...this.lastMarket };
    this.account.vwap = market.vwap || this.account.vwap;
    const s: Snapshot = {
      ts: Date.now(),
      mode: cfg.mode,
      price: this.price,
      account: this.account,
      orders: this.orders.slice(0, 200),
      trades: this.trades.slice(0, 200),
      strategies: this.strategies,
      config: {
        grid: cfg.strategies.grid,
        dca: cfg.strategies.dca,
        memes: cfg.strategies.memes,
        perps: cfg.strategies.perps,
      },
      market,
      risk: {
        maxUsdcPosition: cfg.risk.maxUsdcPosition,
        deployedUsd: this.totalDeployedUsd(),
        hardStopPct: cfg.risk.hardStopPct,
        unrealizedHardStopPct: cfg.risk.unrealizedHardStopPct,
        unrealizedPnlUsd: this.unrealizedPnlUsd(),
        maxSlippageBps: cfg.risk.maxSlippageBps,
        paused: this.paused,
        pauseReason: this.pauseReason,
      },
      perf: this.computePerf(cfg),
      // ACCOUNTABILITY AUDIT: journal vs chain vs books, so the operator can
      // verify the algorithm's reported PnL against real wallet movement.
      audit: this.audit(),
      // Chart payload: decimate the full 7-day ring to ~600 points so the
      // dashboard shows the whole week without a megabyte per update.
      equityHistory: decimate(this.equityHistory, 600),
    };
    // PERPS SLEEVE view (measurement-only, isolated ledger) when wired.
    if (this.perpsProvider) {
      try {
        s.strategies.perps = this.perpsProvider();
      } catch (e) {
        console.warn(`[perps] snapshot view failed: ${(e as Error).message}`);
      }
    }
    // Sample one equity point per poll for the dashboard curve.
    this.sampleEquity();
    this.emit('snapshot', s);
    return s;
  }

  /**
   * Current UNREALIZED PnL on the open SOL basket: (current price - avg cost) *
   * held qty. Negative = the open position is underwater. Meme slots are NOT
   * included here — they're ring-fenced and tracked inside their own slot.
   */
  unrealizedPnlUsd(): number {
    const pos = this.account.positions['SOL/USDC'];
    if (!pos || pos.baseQty <= 0 || pos.avgCostPerBase <= 0 || this.price <= 0) return 0;
    return (this.price - pos.avgCostPerBase) * pos.baseQty;
  }

  /**
   * Record the current equity into the rolling curve (called once per poll).
   *
   * CORRECT DEFINITION — equity = value of everything the wallet holds:
   *   USDC cash + SOL held at current market price.
   *
   * Crucially we do NOT add realized/unrealized PnL here. Every buy spent USDC
   * to gain SOL (fees included) and every sell returned proceeds into USDC, so
   * the profit/loss is ALREADY embedded in the two balances. Adding realized +
   * unrealized on top would double-count the same P&L and make the curve drift
   * ever higher relative to true net worth as positions grow. (Prior versions
   * summed all four terms — the dashboard Net Worth vs Equity gap was this bug.)
   * Ring-buffered so the persisted/streamed payload stays small.
   */
  sampleEquity(): void {
    const now = Date.now();
    const last = this.equityHistory[this.equityHistory.length - 1];
    if (last && now - last.ts < 5000) return; // dedupe within a poll window
    const stable = this.account.balances.USDC ?? 0;
    const nativeSolUsd = (this.account.balances.SOL ?? 0) * this.price;
    const sample = { ts: now, equityUsd: stable + nativeSolUsd };
    this.equityHistory.push(sample);
    if (this.equityHistory.length > this.maxEquityPoints) {
      this.equityHistory = this.equityHistory.slice(-this.maxEquityPoints);
    }
    // FOREVER ARCHIVE: persist a coarse (15-min) equity sample so the curve
    // survives past the 7-day ring and long-horizon drawdowns are analysable.
    if (now - this.lastEquityArchiveAt >= EQUITY_ARCHIVE_MS) {
      this.lastEquityArchiveAt = now;
      appendEquityArchive(this.cfg.mode, sample);
    }
  }

  /**
   * Reconcile the persisted aggregate + per-strategy SOL cost basis against the
   * real trade tape and the on-chain balance.
   *
   * Fixes the accounting drift where avgCostPerBase only moved on tracked fills
   * (and defaulted to spot) while basis removal used a proportional quoteQty
   * shrink — so the book basis ($109.56) diverged from the tape (~$105) and from
   * the chain inventory. The honest basis is:
   *   (trade-attributable remaining cost + untracked SOL at market) / total SOL.
   * SOL with no matching fills (deposits/manual transfers) is explicitly valued
   * at spot and attributed to the strategies that hold inventory, so books and
   * chain reconcile and unrealized PnL stops lying. Measurement-only: this only
   * rewrites cost basis, never quantities or realized PnL.
   */
  reconcileCostBasisFromJournal(spotPrice: number): CostBasisResult | undefined {
    try {
      const pos = this.getPosition('SOL', 'USDC');
      if (!pos || !(spotPrice > 0)) return undefined;
      const chainQty = this.account.balances.SOL ?? pos.baseQty;
      if (!(chainQty > 0)) return undefined;
      const fills: FillEntry[] = readJournal(this.cfg.mode)
        .filter((t) => t.strategyId === 'grid' || t.strategyId === 'dca')
        .map((t) => ({
          ts: t.ts,
          direction: t.direction,
          baseQty: t.baseQty,
          quoteQty: t.quoteQty,
        }));
      if (!fills.length) return undefined;
      const res = reconcileCostBasis(fills, chainQty, spotPrice);
      const prior = pos.avgCostPerBase;
      pos.avgCostPerBase = res.avgCostPerBase;
      pos.baseQty = chainQty;
      this.upsertPosition(pos);
      // Per-strategy books: keep their own tape-derived basis, then attribute
      // any *deficit* between the books and the chain (usually untracked
      // deposit SOL, or native-SOL fees the engine later trims) pro-rata at
      // spot. Distributing only the deficit — never the full untracked amount —
      // keeps sum(books) === chain even when the engine's own reconcile has
      // already trimmed the books to the wallet.
      const gBook = this.strategies.grid.subBook;
      const dBook = this.strategies.dca.subBook;
      const booksSum = (gBook?.baseQty ?? 0) + (dBook?.baseQty ?? 0);
      const deficit = Math.max(0, chainQty - booksSum);
      const weights: Record<string, number> = {
        grid: gBook?.baseQty ?? 0,
        dca: dBook?.baseQty ?? 0,
      };
      const share = distributeUntracked(weights, deficit);
      for (const [id, qty] of Object.entries(share)) {
        if (qty <= 0) continue;
        const book = id === 'grid' ? gBook : dBook;
        if (!book) continue;
        const total = book.baseQty + qty;
        if (total <= 0) continue;
        // Untracked SOL is assumed acquired at the current market price.
        book.avgCostPerBase =
          (book.baseQty * book.avgCostPerBase + qty * spotPrice) / total;
        book.baseQty = total;
      }
      this.lastCostBasis = res;
      if (Math.abs(prior - res.avgCostPerBase) / (res.avgCostPerBase || 1) > 0.005) {
        console.log(
          `[reconcile] cost basis ${prior.toFixed(4)} -> ${res.avgCostPerBase.toFixed(4)} ` +
          `(tracked ${res.trackedQty.toFixed(3)} + untracked ${res.untrackedQty.toFixed(3)} SOL)`
        );
      }
      return res;
    } catch (e) {
      console.warn(`[reconcile] cost-basis failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * Accounting audit (measurement-only): does the recorded tape explain the
   * on-chain inventory and the equity movement? Surface this to the operator so
   * "the algo reports +$X" can be cross-checked against real wallet movement.
   */
  audit(): Snapshot['audit'] {
    const pos = this.getPosition('SOL', 'USDC');
    const chainSol = this.account.balances.SOL ?? 0;
    const chainUsdc = this.account.balances.USDC ?? 0;
    const equity = chainUsdc + chainSol * (this.price || 0);
    const journal = readJournal(this.cfg.mode);
    let buys = 0, sells = 0, buyUsd = 0, sellUsd = 0, realized = 0, fees = 0;
    let synthetic = 0;
    for (const t of readJournal(this.cfg.mode, { includeSynthetic: true })) {
      if (isSyntheticFill(t)) { synthetic++; continue; }
      if (t.strategyId !== 'grid' && t.strategyId !== 'dca') continue;
      fees += t.feeUsd || 0;
      if (t.direction === 'BUY') { buys++; buyUsd += t.quoteQty || 0; }
      else {
        sells++; sellUsd += t.quoteQty || 0;
        realized += t.realizedPnlUsd ?? 0;
      }
    }
    const basis = this.lastCostBasis;
    const booksSum =
      (this.strategies.grid.subBook?.baseQty ?? 0) + (this.strategies.dca.subBook?.baseQty ?? 0);
    return {
      journalFills: journal.length,
      journalBuys: buys,
      journalSells: sells,
      journalBuyUsd: buyUsd,
      journalSellUsd: sellUsd,
      journalRealizedUsd: realized,
      journalFeesUsd: fees,
      syntheticFills: synthetic,
      ledgerFills: this.trades.length,
      ledgerCapped: this.trades.length >= this.maxTrades,
      chainSol,
      chainUsdc,
      equityUsd: equity,
      positionBaseQty: pos?.baseQty ?? 0,
      avgCostPerBase: pos?.avgCostPerBase ?? 0,
      trackedQty: basis?.trackedQty ?? null,
      untrackedQty: basis?.untrackedQty ?? null,
      booksSolQty: booksSum,
      booksMatchChain: Math.abs(booksSum - chainSol) < 1e-3,
      equityRingStartUsd: this.equityHistory[0]?.equityUsd ?? null,
      equityRingSpanHours: this.equityHistory.length
        ? (this.equityHistory[this.equityHistory.length - 1]!.ts - this.equityHistory[0]!.ts) / 3_600_000
        : 0,
    };
  }

  // ---------------------------------------------------------------------------
  // CRASH RECOVERY / STATE PERSISTENCE (#7)
  //
  // The engine holds all positions/orders/meme state in memory. A crash or
  // restart would otherwise reset peak/trailing/realized signals and orphan
  // resting orders. We persist a compact snapshot of recoverable state to
  // .botstate/state.json (mode-keyed) on a debounced interval and on shutdown,
  // then reconcile from it on the next launch. Live balances are NOT persisted —
  // they're always re-read from chain on startup so a stale file can never
  // fabricate a balance. Paper balances ARE restored (they're simulated).
  // ---------------------------------------------------------------------------

  private static enabled(): boolean {
    const v = process.env.STATE_PERSIST;
    if (v !== undefined) return v === '1' || v.toLowerCase() === 'true';
    // Allow tests to force it off via STATE_PERSIST=0 (set before construct).
    return process.env.NODE_ENV === 'test' ? false : true; // on by default otherwise
  }

  /** Name the state file per mode so paper and live never clobber each other. */
  private static fileFor(mode: string): string {
    return join(STATE_DIR, `state-${mode}.json`);
  }

  /** Restore persisted state into this fresh store (called once at construct). */
  loadPersisted(): void {
    if (!StateStore.enabled()) return;
    const file = StateStore.fileFor(this.cfg.mode);
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {
        account?: AccountState;
        orders?: Order[];
        trades?: Trade[];
        strategies?: StrategyRuntimeState;
        paused?: boolean;
        pauseReason?: string;
        bandSamples?: number;
        bandInside?: number;
        equityHistory?: { ts: number; equityUsd: number }[];
      };
      // Only restore position/realized state from the same mode's file; balance
      // is refreshed from chain in live (never trust a stale persisted balance).
      if (raw.account) {
        if (this.cfg.mode === 'paper') {
          this.account = { ...this.account, ...raw.account };
        } else {
          // Live: keep balances at zero (re-read on chain) but restore positions
          // + running realized PnL / fees so the engine reconciles correctly.
          this.account.realizedPnlUsd = raw.account.realizedPnlUsd ?? 0;
          this.account.feesPaidUsd = raw.account.feesPaidUsd ?? 0;
          if (raw.account.positions) this.account.positions = raw.account.positions;
          this.account.openQty = raw.account.openQty ?? 0;
        }
      }
      if (Array.isArray(raw.orders)) this.orders = raw.orders;
      if (Array.isArray(raw.trades)) this.trades = raw.trades;
      if (typeof raw.bandSamples === 'number') this.bandSamples = raw.bandSamples;
      if (typeof raw.bandInside === 'number') this.bandInside = raw.bandInside;
      if (Array.isArray(raw.equityHistory)) {
        this.equityHistory = raw.equityHistory as { ts: number; equityUsd: number }[];
      }
      if (raw.strategies) {
        // Overlay persisted strategy state onto the freshly-seeded slots so we
        // keep any slots that exist now while restoring grid/dca/meme progre.
        if (raw.strategies.grid) {
          this.strategies.grid = { ...this.strategies.grid, ...raw.strategies.grid, enabled: this.strategies.grid.enabled };
        }
        if (raw.strategies.dca) {
          this.strategies.dca = { ...this.strategies.dca, ...raw.strategies.dca, enabled: this.strategies.dca.enabled };
        }
        // ONE-TIME LEDGER CORRECTION: prior builds booked reconcile-trims into
        // subBook.feesPaidUsd, inflating per-strategy fees (e.g. DCA showed
        // $11k of "fees" that were really inventory corrections). Real fees
        // live in the trade ledger, so rebuild each SOL sub-book's fee total
        // from actual recorded trades and move the residual to reconAdjustUsd.
        for (const id of ['grid', 'dca'] as const) {
          const book = this.strategies[id].subBook;
          if (!book) continue;
          const realFees = this.trades
            .filter((t) => t.strategyId === id)
            .reduce((s, t) => s + (t.feeUsd || 0), 0);
          const inflated = Math.max(0, book.feesPaidUsd - realFees);
          if (inflated > 0.01) {
            book.reconAdjustUsd = (book.reconAdjustUsd ?? 0) + inflated;
            book.feesPaidUsd = realFees;
            console.log(
              `[persist] ledger correction (${id}): moved ${inflated.toFixed(2)} ` +
              `of reconcile-trims out of fees into reconAdjust (real fees ${realFees.toFixed(2)})`
            );
          }
        }
        for (const [id, m] of Object.entries(raw.strategies.memes ?? {})) {
          if (this.strategies.memes[id]) this.strategies.memes[id] = { ...this.strategies.memes[id], ...m };
        }
      }
      this.paused = !!raw.paused;
      // Only carry the pause reason across if we actually restored as PAUSED.
      // A reason with paused=false is a stale leftover from a prior run and
      // would otherwise show on the dashboard contradicting the LIVE status.
      this.pauseReason = this.paused ? (raw.pauseReason ?? '') : '';
      console.log(`[persist] restored runtime state from ${file}`);
    } catch (e) {
      console.warn(`[persist] could not restore state: ${(e as Error).message}`);
    }
  }

  /**
   * PERFORMANCE TELEMETRY (B): 24h rolling, measurement-only. Derived entirely
   * from real recorded trades and the live grid band; drives no trading
   * decisions. This is the evidence base for tuning step size / level count /
   * TP params from live data instead of guesses.
   */
  private computePerf(cfg: AppConfig): Snapshot['perf'] {
    void cfg; // band comes from live level state, not static config
    const booksFor = (windowMs: number): PerfBook[] => {
      const cutoff = windowMs === 0 ? 0 : Date.now() - windowMs;
      const recent = this.trades.filter((t) => t.ts >= cutoff);
      const byId = new Map<string, Trade[]>();
      for (const t of recent) {
        const arr = byId.get(t.strategyId) ?? [];
        arr.push(t);
        byId.set(t.strategyId, arr);
      }
      const books: PerfBook[] = [];
      for (const [strategyId, trades] of byId) {
        let realized = 0;
        let fees = 0;
        const wins: number[] = [];
        const losses: number[] = [];
        for (const t of trades) {
          fees += t.feeUsd || 0;
          if (t.direction === 'SELL' && typeof t.realizedPnlUsd === 'number') {
            realized += t.realizedPnlUsd;
            if (t.realizedPnlUsd > 0) wins.push(t.realizedPnlUsd);
            else if (t.realizedPnlUsd < 0) losses.push(t.realizedPnlUsd);
          }
        }
        const sumWins = wins.reduce((s, v) => s + v, 0);
        const sumLosses = losses.reduce((s, v) => s + v, 0);
        const sells = wins.length + losses.length;
        const earliest = trades.reduce((m, t) => Math.min(m, t.ts), Date.now());
        const spanH = Math.max(1 / 60, (Date.now() - earliest) / 3600_000);
        books.push({
          strategyId,
          realizedPnlUsd: realized,
          feesUsd: fees,
          netPnlUsd: realized - fees,
          fills: trades.length,
          fillsPerHour: trades.length / spanH,
          avgWinUsd: wins.length ? sumWins / wins.length : 0,
          avgLossUsd: losses.length ? sumLosses / losses.length : 0,
          winRate: sells ? wins.length / sells : 0,
          profitFactor: sumLosses < 0 ? sumWins / Math.abs(sumLosses) : sumWins > 0 ? Infinity : 0,
        });
      }
      books.sort((a, b) => b.netPnlUsd - a.netPnlUsd);
      return books;
    };

    // Band occupancy: is the CURRENT tape inside the armed ladder's price
    // edges? (min/max of live level prices). A dedicated multi-sample ring
    // buffer would refine this later; the snapshot updates every poll, so the
    // dashboard effectively gets the live reading.
    const levelPrices = this.strategies.grid.levels
      .map((l) => l.price)
      .filter((p) => p > 0);
    const hasBand = levelPrices.length >= 2 && this.price > 0;
    const lower = hasBand ? Math.min(...levelPrices) : 0;
    const upper = hasBand ? Math.max(...levelPrices) : 0;

    // ACCUMULATED occupancy (persisted): every snapshot tick with an armed
    // band contributes one in/out sample. This turns the "is price in band
    // right now" reading into a real % over days — the number that tells us
    // whether the band actually contains tape.
    if (hasBand) {
      this.bandSamples++;
      if (this.price >= lower && this.price <= upper) this.bandInside++;
    }

    return {
      books: booksFor(24 * 3600_000),
      books7d: booksFor(7 * 24 * 3600_000),
      booksAll: booksFor(0),
      band: {
        lower,
        upper,
        insidePct: this.bandSamples > 0 ? this.bandInside / this.bandSamples : 0,
        samples: this.bandSamples,
      },
    };
  }

  /** Serialize recoverable state to the mode-keyed file. */
  private persistedPayload(): Record<string, unknown> {
    return {
      account: this.account,
      orders: this.orders.slice(0, this.maxOrders),
      trades: this.trades.slice(0, this.maxTrades),
      strategies: this.strategies,
      paused: this.paused,
      pauseReason: this.pauseReason,
      bandSamples: this.bandSamples,
      bandInside: this.bandInside,
      equityHistory: this.equityHistory,
    };
  }

  /**
   * Persist current state synchronously. Called manually on a debounced
   * interval and on shutdown. Throwing is swallowed — persistence must never
   * crash the trading loop.
   */
  persistNow(): void {
    if (!StateStore.enabled()) return;
    try {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      // SECURITY (audit M2): state files contain balances/PnL/orders — restrict
      // to owner-only so other local users on a shared machine can't read them.
      // ATOMICITY (audit #3): write a sibling temp file then rename over the
      // target. rename is atomic on POSIX, so a crash mid-write can never leave
      // a truncated state file (which would corrupt balances/orders/positions).
      // Matches the journal/history/perps stores, which already do this.
      const file = StateStore.fileFor(this.cfg.mode);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.persistedPayload()), {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(tmp, file);
    } catch (e) {
      console.warn(`[persist] write failed: ${(e as Error).message}`);
    }
  }
}
