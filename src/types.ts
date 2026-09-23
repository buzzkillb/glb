import type { GridConfig, DcaConfig, MemeSlotConfig, PerpSleeveConfig } from './config.js';
import type { LeverageBreakdown } from './perpStrategy.js';

export type Side = 'BUY' | 'SELL';

/** One strategy book's rolling performance row (dashboard telemetry). */
export interface PerfBook {
  strategyId: string;
  /** Banked PnL in the window (sum of SELL realizedPnlUsd, gross). */
  realizedPnlUsd: number;
  /** Total fees paid in the window. */
  feesUsd: number;
  /** Net = realized − fees. */
  netPnlUsd: number;
  /** Completed fills in the window. */
  fills: number;
  /** Fills per hour (window-normalized). */
  fillsPerHour: number;
  /** Average banked profit per profitable SELL, USD. */
  avgWinUsd: number;
  /** Average banked loss per losing SELL, USD (negative). */
  avgLossUsd: number;
  /** Win rate on SELLs in the window (0..1). */
  winRate: number;
  /** Profit factor: Σ wins / |Σ losses| (Infinity when no losses). */
  profitFactor: number;
}

export type OrderKind = 'GRID_BUY' | 'GRID_SELL' | 'DCA_BUY' | 'DCA_SELL';

export type OrderStatus = 'OPEN' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export interface Order {
  id: string;
  kind: OrderKind;
  side: Side;
  /** limit price in USDC (per SOL) */
  price: number;
  /** amount of base asset (SOL) for this order */
  baseQty: number;
  /** amount of quote asset (USDC) reserved */
  quoteQty: number;
  status: OrderStatus;
  createdAt: number;
  filledAt?: number;
  fillPrice?: number;
  /** paper vs live */
  mode: 'paper' | 'live';
  strategyId: string;
  note?: string;
}

export type TradeDirection = 'BUY' | 'SELL';

export interface Trade {
  id: string;
  orderId: string;
  strategyId: string;
  direction: TradeDirection;
  /** execution price in USDC per SOL */
  price: number;
  baseQty: number;
  quoteQty: number;
  feeUsd: number; // simulated/estimated fee
  realizedPnlUsd?: number; // for SELLs that close a cost basis
  ts: number;
  mode: 'paper' | 'live';
}

export interface Position {
  baseAsset: string;
  quoteAsset: string;
  baseQty: number; // SOL held
  quoteQty: number; // USDC held
  avgCostPerBase: number; // average cost basis per SOL
}

export interface AccountState {
  mode: 'paper' | 'live';
  balances: {
    SOL: number;
    USDC: number;
  };
  positions: Record<string, Position>; // key: `${base}/${quote}`
  vwap?: number; // rolling VWAP for DCA dip trigger
  realizedPnlUsd: number;
  /** Cumulative fees paid across ALL trades (not just the visible snapshot). */
  feesPaidUsd: number;
  openQty: number; // SOL currently held by bots
}

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

export interface GridState {
  levels: GridLevelState[];
  enabled: boolean;
  /** RING-FENCED SUB-BOOK (H3): grid's own slice of the SOL position.
   *  The grid cost-guard (sellBelowCostWouldLose) reads THIS basis, not the
   *  aggregate commingled position, so a cheap DCA lot can never let the grid
   *  arm a below-cost sell against grid-owned lots. */
  subBook?: StrategySubBook;
}

export interface GridLevelState {
  /** price of this level in USDC */
  price: number;
  /** outstanding buy order id (null if none) */
  buyOrderId?: string;
  /** outstanding sell order id (null if none) */
  sellOrderId?: string;
  baseQty: number;
}

export interface DcaState {
  enabled: boolean;
  lastBuyAt?: number;
  /** Highest price seen since the last take-profit reset (trailing peak). */
  peakPrice?: number;
  /** True after price first crosses avgCost*(1+tp) — countdown to a trail-out. */
  tpArmed?: boolean;
  lastTpAt?: number;
  /** Number of DCA buys completed (drives the value-averaging target path). */
  buys?: number;
  /** RING-FENCED SUB-BOOK (H3): DCA's own slice of the SOL position.
   *  baseQty/avgCost here are maintained by the broker on every DCA fill so
   *  DCA take-profit logic can act on DCA capital only, independent of grid. */
  subBook?: StrategySubBook;
}

/**
 * Per-strategy ring-fenced ledger of the shared SOL/USDC position (H3).
 * Invariant maintained by every fill path: the sum of all sub-book baseQty
 * must equal the aggregate SOL/USDC position baseQty, and each strategy's
 * PnL/cost decisions (grid cost-guard, DCA take-profit) read its OWN book,
 * never the commingled aggregate.
 */
export interface StrategySubBook {
  baseQty: number;
  avgCostPerBase: number;
  /** Cumulative realized PnL booked by THIS strategy's sells (USD). */
  realizedPnlUsd: number;
  /** Cumulative fees paid by THIS strategy's fills (USD). */
  feesPaidUsd: number;
  /**
   * Cumulative book-vs-chain reconciliation trims (USD, measurement only).
   * These are NOT fees: they correct sub-book inventory for native-SOL network
   * fees and shrink-to-available sells already booked elsewhere. Kept separate
   * so per-strategy fee/net reporting stays honest.
   */
  reconAdjustUsd?: number;
}

/**
 * Runtime state for one graduated-meme slot (CYB, and future memes). Fully
 * ring-fenced from the SOL book. All stats surface REAL on-chain data.
 */
export interface MemeState {
  id: string;
  enabled: boolean;
  /** Real current price in USDC (0 until data arrives; never invented). */
  price: number;
  /** Real volume-weighted average price from on-chain OHLCV volume. */
  vwap: number;
  high24h: number;
  low24h: number;
  vol24hUsd: number;
  liquidityUsd: number;
  /** Held base qty of this meme. */
  baseQty: number;
  avgCostPerBase: number;
  realizedPnlUsd: number;
  feesPaidUsd: number;
  /** USDC committed = held base at average cost. */
  deployedUsd: number;
  buys: number;
  /** Real 24h volume / liquidity admission gate. */
  admitted: boolean;
  admissionReason: string;
  lastBuyAt?: number;
  tpArmed?: boolean;
  peakPrice?: number;
  lastTpAt?: number;
  /** Ring-fenced loss stop: true once this slot's REALIZED PnL breached its
   *  per-slot loss ceiling — accumulation halted, trailing TP still unwinds. */
  lossStopped?: boolean;
  /** Highest real pool liquidity seen since we started holding (dead-book base). */
  peakLiquidityUsd?: number;
  /** True once real liquidity decayed past the exit threshold — defensive exit done. */
  deadBookExited?: boolean;
  /** Index of the next take-profit rung to fire (0 = first rung). */
  tpRungIndex?: number;
}

export interface StrategyRuntimeState {
  grid: GridState;
  dca: DcaState;
  memes: Record<string, MemeState>;
  /** PERPS SLEEVE (risk-isolated leverage overlay). Always present so the
   *  dashboard/API has a home for it even when disabled. */
  perps: PerpsState;
}

/**
 * Dashboard view of the perps sleeve. Measurement/observability only — the
 * sleeve's authoritative ledger lives in `.botstate/perps-<mode>.json` and is
 * deliberately separate from the spot book.
 */
export interface PerpsState {
  enabled: boolean;
  halted: boolean;
  haltReason: string;
  /** Sane mark price from the perps venue feed (0 = none/rejected). */
  markPrice: number;
  markHealthy: boolean;
  feedRejectReason: string;
  /** Untouchable principal floor: the sleeve may only deploy equity ABOVE this. */
  principalFloorUsd: number;
  /** Peak equity observed (observability only). */
  peakEquityUsd: number;
  /** Margin currently committed to an open position. */
  outstandingMarginUsd: number;
  /** max(0, equity - floor): the only profit the sleeve may ever risk. */
  eligibleProfitUsd: number;
  /**
   * DYNAMIC profit signal derived from the bot's own persisted records
   * (equity archive + trade journal). This is what sizes the sleeve live, with
   * no hardcoded floor. null-safe fields default to 0/'' when unavailable.
   */
  profit: {
    /** Equity at the earliest point in our own record (never a literal). */
    baselineEquityUsd: number;
    baselineSource: 'archive' | 'journal' | 'none';
    /** Live equity the detector observed (echoed for debuggability). */
    currentEquityUsd: number;
    /** max(0, equity - baseline): genuinely earned net profit. */
    newProfitUsd: number;
    /** Liquid USDC — the only money that can be posted as perp margin. */
    freeCashUsd: number;
    /** Lifetime banked realized PnL from the trade tape. */
    lifetimeRealizedUsd: number;
    /** Realized PnL inside the trailing window. */
    windowRealizedUsd: number;
    /** Non-synthetic fills on the tape (confidence signal). */
    sampleFills: number;
    ready: boolean;
    note: string;
  };
  sleeveBudgetUsd: number;
  /** sleeveBudgetUsd / equity, 0..1 */
  edgePct: number;
  /** Grid-owned SOL inventory valued at mark (the thing a hedge neutralizes). */
  gridNetLongUsd: number;
  /** gridNetLongUsd / equity, 0..1 */
  exposurePct: number;
  hedgeActive: boolean;
  hedgeCoveragePct: number;
  /** Floor share of margin that banks the hedge (0 = disabled). */
  hedgeTakeProfitPct: number;
  /** Ceiling the dynamic target may ride to while a downtrend stays intact. */
  hedgeTakeProfitMaxPct: number;
  /**
   * LIVE dynamic take-profit plan for the open hedge — recomputed each tick from
   * venue volatility and momentum. Exposes the target share/USD, whether the
   * move is judged exhausted, and whether banking has fired, so the number is
   * never a black box. Null when no hedge is open.
   */
  hedgeTakeProfitPlan: {
    targetPct: number;
    targetUsd: number;
    exhausted: boolean;
    fired: boolean;
    reason: string;
  } | null;
  /** Minutes to wait after a close before the sleeve re-arms (0 = disabled). */
  hedgeRearmCooldownMinutes: number;
  /**
   * Cap we allow the spot book to stay net-long, as a fraction of equity. A
   * hedge trims only the EXCESS above this — we do NOT delta-neutral the whole
   * bag, because the spot net-long is the strategy's upside and working capital.
   */
  maxNetExposurePct: number;
  /** Hard USDC floor the sleeve may never spend (keeps the spot book's cash working). */
  usdcFloorUsd: number;
  /** USD of net-long the cap permits us to keep (never hedged). */
  exposureCapUsd: number;
  /** Notional the trim must offset: the EXCESS above the cap, not the whole delta. */
  targetHedgeNotionalUsd: number;
  /** Margin required to shed the excess at the hedge leverage. */
  marginToNeutralizeUsd: number;
  /** True when the book is inside the exposure cap (trim complete). */
  withinExposureCap: boolean;
  /** Hedge notional currently held toward the excess (progress display). */
  hedgeNotionalUsd: number;
  /** Configured hard leverage ceiling for the sleeve. */
  maxLeverage: number;
  /**
   * Smart leverage working range derived from live state — venue volatility
   * (survival bound), our bag concentration, market direction, and market
   * liquidity — plus the policy ceiling. Fully auditable: every penalty is
   * exposed so the number is never a black box, and nothing is hardcoded.
   */
  leverageRange: LeverageBreakdown;
  realizedPnlUsd: number;
  feesPaidUsd: number;
  open: {
    side: 'long' | 'short';
    collateralUsd: number;
    leverage: number;
    entryPriceUsd: number;
    liquidationPriceUsd: number;
    notionalUsd: number;
    openedAt: number;
    /** Raw mark-to-market PnL (USD) on the open position at the current mark. */
    unrealizedPnlUsd?: number;
    /** Borrow/funding carry accrued (USD) — a cost that grows while held. */
    carryUsd?: number;
    /** unrealizedPnlUsd − carryUsd: the net PnL the stop/take-profit judge. */
    netPnlUsd?: number;
  } | null;
  /** For a short: (liquidation - mark)/mark as a fraction; positive = safe. */
  liquidationBufferPct: number;
  /** Human-readable reason for the last sizing decision (why it did/didn't act). */
  lastDecision: string;
  note: string;
}

export interface Snapshot {
  ts: number;
  mode: 'paper' | 'live';
  price: number;
  account: AccountState;
  orders: Order[];
  trades: Trade[];
  strategies: StrategyRuntimeState;
  config: {
    grid: GridConfig;
    dca: DcaConfig;
    memes: MemeSlotConfig[];
    perps: PerpSleeveConfig;
  };
  /**
   * PERFORMANCE TELEMETRY (measurement-only). `books` is the 24h rolling
   * window; `books7d` / `booksAll` cover 7 days and all-time so a week of
   * live data can actually be analyzed, not just yesterday's slice.
   */
  perf: {
    books: PerfBook[];
    books7d: PerfBook[];
    booksAll: PerfBook[];
    /** Grid band occupancy: share of sampled polls inside [lower, upper]. */
    band: {
      lower: number;
      upper: number;
      /** 0..1 share of the last N equity samples inside the band. */
      insidePct: number;
      /** Number of samples the estimate is based on. */
      samples: number;
    };
  };
  /** Rolling market context surfaced to the dashboard. */
  market: {
    vwap: number;
    high24h: number;
    low24h: number;
    /** SOL price ~24h ago (0 = not enough history yet). */
    price24hAgo: number;
  };
  risk: {
    maxUsdcPosition: number;
    /** USDC currently committed to resting buys + held SOL at cost. */
    deployedUsd: number;
    hardStopPct: number;
    /** Realized losses that trigger a full pause. */
    unrealizedHardStopPct: number;
    /** Current unrealized PnL on the open SOL basket (USD, negative = underwater). */
    unrealizedPnlUsd: number;
    maxSlippageBps: number;
    paused: boolean;
    /** Non-empty when a risk rule has paused the bot (realized/unrealized/other). */
    pauseReason?: string;
  };
  /** Rolling equity curve (ts + equity USD) for the dashboard chart. */
  equityHistory: { ts: number; equityUsd: number }[];
  /**
   * ACCOUNTABILITY AUDIT (measurement-only). Cross-checks the forever trade
   * journal against the on-chain wallet, the strategy books, and the equity
   * ring so the operator can verify the algorithm's reported PnL reconciles
   * with real wallet movement instead of trusting a number in isolation.
   */
  audit: {
    /** Fills in the forever journal (all strategies). */
    journalFills: number;
    /** Grid+DCA BUY fills in the journal. */
    journalBuys: number;
    /** Grid+DCA SELL fills in the journal. */
    journalSells: number;
    /** Gross USDC spent on journaled grid+DCA buys. */
    journalBuyUsd: number;
    /** Gross USDC proceeds from journaled grid+DCA sells. */
    journalSellUsd: number;
    /** Banked SELL realized PnL across the journal. */
    journalRealizedUsd: number;
    /** Fees across the journal. */
    journalFeesUsd: number;
    /** Synthetic smoke-test fills excluded from all analytics above. */
    syntheticFills: number;
    /** Fills still held in the in-memory ledger (capped). */
    ledgerFills: number;
    /** True when the ledger has hit its cap (older fills only in journal). */
    ledgerCapped: boolean;
    chainSol: number;
    chainUsdc: number;
    equityUsd: number;
    positionBaseQty: number;
    avgCostPerBase: number;
    /** Journal-attributable SOL still held. */
    trackedQty: number | null;
    /** SOL on-chain not explained by any journaled fill (deposits/manual). */
    untrackedQty: number | null;
    booksSolQty: number;
    booksMatchChain: boolean;
    equityRingStartUsd: number | null;
    equityRingSpanHours: number;
  };
}
