import { readEquityArchive, readJournal, type EquitySample } from './journal.js';

/**
 * DYNAMIC PROFIT DETECTOR.
 *
 * No hardcoded principal floor. The sleeve's deployable budget is derived LIVE
 * from the bot's own persisted records:
 *
 *   1. the forever equity archive  (`.botstate/equity-*.jsonl`) — real net-worth
 *      history, so "profit since the start of our record" is measurable, and
 *   2. the trade journal           (`.botstate/trades-*.jsonl`) — banked realized
 *      PnL per fill.
 *
 * The baseline is not a magic number: it is the FIRST equity sample we ever
 * recorded. Profit above that baseline is genuinely earned money. Because the
 * baseline comes from the archive it self-adjusts over time — as the record
 * grows the baseline stays anchored to the origin, and the eligible amount
 * tracks whatever the account has actually made.
 *
 * The sleeve can only ever deploy profit, and only the liquid (USDC) portion of
 * it — SOL held in the grid is inventory, not spendable margin. If the account
 * is back at/below its origin, deployable profit is exactly 0.
 */

export interface ProfitSignal {
  /** Equity at the origin of our own record (dynamic, never hardcoded). */
  baselineEquityUsd: number | null;
  baselineTs: number | null;
  /** Current net-worth value of the wallet (USDC + SOL at mark). */
  currentEquityUsd: number;
  /** Liquid USDC only — the part that can actually be posted as perp margin. */
  freeCashUsd: number;
  /** max(0, equity - baseline): genuinely earned net profit. */
  newProfitUsd: number;
  /** Lifetime banked realized PnL from the trade tape (gross, pre-fee). */
  lifetimeRealizedUsd: number;
  /** Realized PnL inside the trailing analysis window. */
  windowRealizedUsd: number;
  /** How many non-synthetic fills the tape holds (confidence signal). */
  sampleFills: number;
  /** Where the baseline came from. */
  baselineSource: 'archive' | 'journal' | 'none';
  /** True when we have enough history to size a sleeve at all. */
  ready: boolean;
  note: string;
}

export interface ProfitDetectorConfig {
  /** Trailing window used for the windowProfit signal (hours). Configurable. */
  windowHours: number;
  /** Refuse to deploy until the tape has at least this many real fills. */
  minFillsForConfidence: number;
}

const DEFAULT: ProfitDetectorConfig = { windowHours: 168, minFillsForConfidence: 8 };

/**
 * Compute the live profit signal from the bot's own persisted records.
 *
 * @param mode          'paper' | 'live' — selects which archive/journal to read
 * @param currentEquityUsd  live equity from the store's own chain reconcile
 * @param freeCashUsd   liquid USDC balance (only this can be posted as margin)
 */
export function detectProfit(
  mode: 'paper' | 'live',
  currentEquityUsd: number,
  freeCashUsd: number,
  cfg: ProfitDetectorConfig = DEFAULT
): ProfitSignal {
  const archive = readEquityArchive(mode);
  const tape = readJournal(mode).filter((t) => t.strategyId === 'grid' || t.strategyId === 'dca');

  const lifetimeRealizedUsd = tape.reduce((s, t) => s + (t.realizedPnlUsd ?? 0), 0);
  const now = Date.now();
  const windowStart = now - cfg.windowHours * 3_600_000;
  const windowRealizedUsd = tape
    .filter((t) => t.ts >= windowStart)
    .reduce((s, t) => s + (t.realizedPnlUsd ?? 0), 0);

  // Baseline = earliest point in our own record. Prefer the equity archive
  // because it is net-worth truth; fall back to the journal's first fill.
  let baselineEquityUsd: number | null = null;
  let baselineTs: number | null = null;
  let baselineSource: ProfitSignal['baselineSource'] = 'none';

  const first = earliest(archive);
  if (first) {
    baselineEquityUsd = first.equityUsd;
    baselineTs = first.ts;
    baselineSource = 'archive';
  } else if (tape.length) {
    // No archive yet: approximate the origin from the first fill's implied
    // equity. We cannot know cash exactly, so use lifetime realized as a floor.
    const firstFill = tape.reduce((a, b) => (a.ts < b.ts ? a : b));
    baselineEquityUsd = Math.max(0, currentEquityUsd - lifetimeRealizedUsd);
    baselineTs = firstFill.ts;
    baselineSource = 'journal';
  }

  const newProfitUsd =
    baselineEquityUsd != null ? Math.max(0, currentEquityUsd - baselineEquityUsd) : 0;

  const ready = tape.length >= cfg.minFillsForConfidence || archive.length >= 2;

  const note = !baselineEquityUsd
    ? 'no record yet — baseline will anchor on the first equity sample'
    : baselineSource === 'archive'
      ? `baseline anchored to first archived equity sample (${new Date(baselineTs!).toISOString().slice(0, 10)})`
      : 'baseline approximated from first journal fill';

  return {
    baselineEquityUsd,
    baselineTs,
    currentEquityUsd,
    freeCashUsd,
    newProfitUsd,
    lifetimeRealizedUsd,
    windowRealizedUsd,
    sampleFills: tape.length,
    baselineSource,
    ready,
    note,
  };
}

/**
 * How much margin the sleeve may actually deploy, derived from the live signal.
 *
 *   deployable = min( profitShare * newProfit,          <- net gain since baseline
 *                     realizedShare * lifetimeRealized,  <- money actually banked
 *                     freeCash * cashUsePct,              <- only real, liquid money
 *                     equity * maxEquityPct,
 *                     maxMarginUsd )
 *
 * The realized-PnL term is a CAP, not an addend: it enforces "you may only risk
 * money you have actually banked" and prevents double-counting realized profit
 * against the net-worth gain (realized gains are already inside `newProfit`).
 *
 * Every term is 0-or-negative-safe, so a drawdown collapses the budget to 0
 * instead of ever producing a negative or principal-eating number.
 */
export function deployableSleeveUsd(
  cfg: {
    profitSharePct: number;
    realizedProfitUsePct: number;
    cashUsePct: number;
    maxEquityPct: number;
    maxMarginUsd: number;
  },
  signal: ProfitSignal
): number {
  if (!signal.ready) return 0;
  if (signal.newProfitUsd <= 0) return 0;

  const fromProfit = signal.newProfitUsd * clamp(cfg.profitSharePct, 0, 1);
  // Banked realized PnL ceiling (0 disables the term entirely).
  const realizedShare = clamp(cfg.realizedProfitUsePct, 0, 1);
  const fromRealized =
    realizedShare > 0
      ? Math.max(0, signal.lifetimeRealizedUsd) * realizedShare
      : Number.POSITIVE_INFINITY;
  const fromCash = Math.max(0, signal.freeCashUsd) * clamp(cfg.cashUsePct, 0, 1);
  const equityCap = Math.max(0, signal.currentEquityUsd) * clamp(cfg.maxEquityPct, 0, 1);
  // maxMarginUsd <= 0 means "no USD ceiling": deploy the full computed profit,
  // bounded only by liquid cash and the equity-% safety cap.
  const usdCeiling = cfg.maxMarginUsd > 0 ? cfg.maxMarginUsd : Number.POSITIVE_INFINITY;
  const budget = Math.min(fromProfit, fromRealized, fromCash, equityCap, usdCeiling);
  return budget > 0 && Number.isFinite(budget) ? budget : 0;
}

function earliest(samples: EquitySample[]): EquitySample | null {
  let best: EquitySample | null = null;
  for (const s of samples) {
    if (!best || s.ts < best.ts) best = s;
  }
  return best;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}
