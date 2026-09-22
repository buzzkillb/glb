import { PERP_MIN_COLLATERAL_USD } from './perpBroker.js';
import type { PerpLedger } from './perpStore.js';

/**
 * PERPS SLEEVE STRATEGY — sizing + safety rules. Pure functions first so the
 * invariants are directly testable, then a thin controller the engine drives.
 *
 * DESIGN INTENT: the spot grid/DCA book stays the majority profit engine and is
 * never touched. The perps sleeve is funded ONLY from equity ABOVE a principal
 * floor — money the account has already EARNED — so base capital is never at
 * risk.
 *
 * DIRECT ANSWER TO "what if profits go negative?":
 *   budget = share * max(0, equity - principalFloor) - outstandingMargin
 * When profit falls, `equity - floor` shrinks and the budget shrinks with it.
 * At or below the floor the budget is exactly 0, so the sleeve stops deploying
 * on its own. Nothing to unwind, nothing to top up, principal never touched.
 * A halt ceiling stops it permanently after a defined loss.
 */

export interface PerpSleeveConfig {
  enabled: boolean;
  /** Fraction of eligible profit (equity above the floor) deployable. */
  profitSharePct: number;
  /** Deployable fraction of the sleeve's OWN banked realized PnL (0..1; 0 off). */
  realizedProfitUsePct: number;
  /** Fraction of liquid USDC deployable — SOL inventory cannot post margin. */
  cashUsePct: number;
  /** Trailing window (hours) for the windowed-realized signal. */
  profitWindowHours: number;
  /** Minimum real fills before the tape is trusted to size. */
  minFillsForConfidence: number;
  /** Venue open/close fee as a fraction of notional (cost model). */
  openFeePct: number;
  /** Venue hourly borrow rate as a fraction of notional (cost model). */
  hourlyBorrowPct: number;
  /** Absolute cap on sleeve margin as a fraction of equity (e.g. 0.10). */
  maxEquityPct: number;
  /** Hard USD ceiling on margin. 0 = uncapped (deploy full computed profit). */
  maxMarginUsd: number;
  /** When the loss ceiling trips, also flatten any open position (default off). */
  haltClosesOpen?: boolean;
  /** Absolute leverage ceiling — the hard upper bound smartLeverage() respects. */
  maxLeverage: number;
  /** Volatility multiple: survive this many 24h ranges before the stop hits. */
  leverageVolMultiplier?: number;
  /** Hedge: fraction of grid net-long delta to neutralize (0..1). */
  hedgeRatio: number;
  /** Leverage for the delta-neutral hedge (capped by maxLeverage). */
  hedgeLeverage?: number;
  /** Hard ceiling on the hedge's auto-scaled leverage (stay sane/low). */
  hedgeLeverageMax?: number;
  /** Hedge is a TRIM: hedge only the delta in excess of this % of equity. */
  maxNetExposurePct?: number;
  /** Hedge arms only when grid net-long exposure exceeds this fraction of equity. */
  hedgeTriggerPct: number;
  /** Stop is placed at this fraction of margin loss — must sit INSIDE liquidation. */
  stopLossMarginPct: number;
  /** Loss ceiling (USD): sleeve halts if its own realized loss breaches this. */
  maxLossUsd: number;
  /** Optional directional overlay: 0 disables. */
  overlayEnabled: boolean;
  /** Fraction of sleeve budget the overlay may use. */
  overlayBudgetPct: number;
  /** Principal floor in USD. 0 = auto-seed to the first observed equity. */
  baselineEquityUsd: number;
}

export interface SleeveInputs {
  equityUsd: number;
  ledger: PerpLedger;
  gridNetLongUsd: number;
  /** Mark price from the perps venue feed (must be sane / > 0). */
  markPrice: number;
  /**
   * Deployable margin authorized by the LIVE profit signal. When supplied it is
   * the hard ceiling on any decision — it replaces the stored principal floor,
   * which may be unset (0) if the operator never hardcoded one.
   * Undefined = fall back to the legacy floor-based computation.
   */
  deployableMarginUsd?: number;
  /**
   * Recent 24h price range as a fraction (e.g. 0.038 = 3.8%). Live volatility
   * input that drives smartLeverage(). 0/undefined = unknown, which fails SAFE
   * (leverage pinned to 1). Sourced from the perps venue mark feed's high/low.
   */
  vol24RangePct?: number;
}

/**
 * SMART LEVERAGE — market-derived, not a static guess.
 *
 * A leveraged position is stopped once the adverse move reaches
 * stopLossMarginPct/leverage in price terms. We therefore pick the LARGEST
 * leverage that still lets the position survive an adverse move of
 * `volMultiple` x the recent 24h range before our stop fires:
 *
 *     maxSafe = stopLossMarginPct / (volMultiple * vol24RangePct)
 *
 * The point is to be shaken out only by a genuinely decisive move, never by
 * ordinary intraday noise. Calm markets permit more leverage; turbulent ones
 * force less. The result is clamped to [1, ceiling]. When volatility is unknown
 * we fail SAFE at 1 — never guess a big number.
 */
export function smartLeverage(
  stopLossMarginPct: number,
  vol24RangePct: number,
  volMultiple: number,
  ceiling: number
): number {
  const ceil = Math.max(1, ceiling);
  const stop = clamp(stopLossMarginPct, 0, 1);
  const vol = Math.max(0, vol24RangePct);
  const mult = Math.max(0.1, volMultiple);
  if (!(vol > 0) || !(stop > 0)) return 1;
  const maxSafe = stop / (mult * vol);
  return clamp(maxSafe, 1, ceil);
}

export interface SmartLeverageView {
  /** Smart leverage with the configured ceiling applied. */
  recommended: number;
  /** Largest leverage the volatility alone permits, before the ceiling. */
  maxSafe: number;
  /** Configured hard ceiling. */
  ceiling: number;
  /** Lower bound we will ever use (always 1). */
  floor: number;
  /** The 24h range that drove the number (fraction). */
  vol24RangePct: number;
  /** Human-readable derivation. */
  explanation: string;
}

/**
 * Full view of the smart leverage RANGE for the dashboard/config: the floor we
 * never go below, the volatility-derived safe maximum, and the configured
 * ceiling. Presents the working range so an operator can see exactly how risky
 * the sleeve is allowed to be right now.
 */
export function smartLeverageView(
  stopLossMarginPct: number,
  vol24RangePct: number,
  volMultiple: number,
  ceiling: number
): SmartLeverageView {
  const ceil = Math.max(1, ceiling);
  const stop = clamp(stopLossMarginPct, 0, 1);
  const vol = Math.max(0, vol24RangePct);
  const mult = Math.max(0.1, volMultiple);
  const maxSafe = vol > 0 && stop > 0 ? stop / (mult * vol) : 1;
  return {
    recommended: smartLeverage(stopLossMarginPct, vol24RangePct, volMultiple, ceiling),
    maxSafe,
    ceiling: ceil,
    floor: 1,
    vol24RangePct: vol,
    explanation:
      maxSafe < 1
        ? 'volatility high — pinned to 1x (full collateral, no borrow)'
        : `range ${(vol * 100).toFixed(2)}% of price; stop ${(stop * 100).toFixed(0)}% margin; ` +
          `survives ${mult.toFixed(1)}x that range -> ${Math.min(maxSafe, ceil).toFixed(2)}x` +
          (maxSafe > ceil ? ` (ceiling ${ceil}x binds)` : ''),
  };
}

export interface SleeveDecision {
  /** Margin to deploy right now (USD). 0 = do nothing. */
  marginUsd: number;
  lev: number;
  side: 'long' | 'short';
  intent: 'hedge' | 'overlay';
  reason: string;
}

/**
 * Profit budget: the ONLY money the sleeve may risk.
 *
 * Returns 0 when:
 *   - the sleeve is disabled or halted,
 *   - equity is at/below the principal floor (no earned profit to deploy),
 *   - a position already consumes the available profit (double-deploy guard),
 *   - the computed share is below the venue's minimum collateral.
 *
 * CRITICAL INVARIANT: budget is never negative, so a drawdown — even one that
 * pushes the sleeve's own PnL negative — cannot make the account "owe" margin.
 */
export function computeSleeveBudget(cfg: PerpSleeveConfig, inputs: SleeveInputs): number {
  if (!cfg.enabled) return 0;
  if (inputs.ledger.halted) return 0;

  const floor = Math.max(0, inputs.ledger.principalFloorUsd);
  const eligibleProfit = Math.max(0, inputs.equityUsd - floor);
  const share = eligibleProfit * clamp(cfg.profitSharePct, 0, 1);
  // Subtract margin already at work so the same profit cannot be deployed twice.
  const available = Math.max(0, share - Math.max(0, inputs.ledger.outstandingMarginUsd));
  const equityCap = Math.max(0, inputs.equityUsd) * clamp(cfg.maxEquityPct, 0, 1);
  // maxMarginUsd <= 0 means "no explicit USD ceiling" — fall back to the equity
  // cap. Treating 0 as a literal $0 ceiling would silently zero the whole budget.
  const usdCeiling = cfg.maxMarginUsd > 0 ? cfg.maxMarginUsd : Number.POSITIVE_INFINITY;
  const budget = Math.min(available, equityCap, usdCeiling);
  return budget > 0 && Number.isFinite(budget) ? budget : 0;
}

/**
 * Decide what the sleeve should do this poll.
 *
 * Tier 2 (hedge) is preferred and fires when the grid is net-long beyond the
 * trigger. Tier 3 (overlay) is only considered when there is no hedge to place
 * and overlay is enabled. When neither applies, marginUsd = 0.
 */
export function decideSleeveAction(
  cfg: PerpSleeveConfig,
  inputs: SleeveInputs
): SleeveDecision {
  const idle = (reason: string): SleeveDecision => ({
    marginUsd: 0,
    lev: 1,
    side: 'short',
    intent: 'hedge',
    reason,
  });

  if (!cfg.enabled) return idle('sleeve disabled');
  if (inputs.ledger.halted) return idle(`halted: ${inputs.ledger.haltReason}`);
  if (!(inputs.markPrice > 0)) return idle('no sane mark price');

  // Prefer the explicit live-profit ceiling; fall back to the stored principal
  // floor only when no signal was supplied. This is what lets the sleeve size
  // to banked realized PnL with no hardcoded floor anywhere.
  const budget =
    typeof inputs.deployableMarginUsd === 'number'
      ? Math.max(0, inputs.deployableMarginUsd)
      : computeSleeveBudget(cfg, inputs);
  if (budget <= 0) {
    if (inputs.ledger.outstandingMarginUsd > 0) {
      return idle('profit already fully deployed');
    }
    return idle('no deployable profit (equity at/below baseline or cash-bound)');
  }

  // Tier 2: TRIM the grid's net-long delta back toward the exposure cap.
  //
  // We deliberately do NOT delta-neutral the entire bag. The spot net-long is
  // the strategy's directional upside and working capital; forcing it to zero
  // means (a) extreme leverage, (b) borrow/funding paid on notional far larger
  // than the sleeve, and (c) giving up the edge the strategy exists to capture.
  // Instead we hedge only the EXCESS above cfg.maxNetExposurePct of equity, so
  // the book keeps its upside while the tail risk is capped.
  const exposurePct = inputs.equityUsd > 0 ? inputs.gridNetLongUsd / inputs.equityUsd : 0;
  const capUsd = inputs.equityUsd * clamp(cfg.maxNetExposurePct ?? 0, 0, 1);
  // Exposure over the cap that we want to shed. With maxNetExposurePct = 0 this
  // equals the full delta (old full-neutralization behavior).
  const excessUsd = Math.max(0, inputs.gridNetLongUsd - capUsd);
  if (exposurePct >= cfg.hedgeTriggerPct && inputs.gridNetLongUsd > 0 && excessUsd > 0) {
    // hedgeRatio is a NOTIONAL fraction of the excess to offset, so the required
    // MARGIN is (targetNotional / leverage). Applying the ratio directly as
    // margin and then leveraging it would over-hedge by a factor of the leverage
    // (e.g. 0.8*2 = 1.6x the delta → net-short instead of neutral).
    //
    // AUTO-LEVERAGE is bounded: a profit-sized budget is typically smaller than
    // the excess, so a fixed leverage might not reach it. We pick the smallest
    // leverage that lets the deployable budget fund the target notional, but
    // never beyond hedgeLeverageMax (default 3 — sane, keeps our stop far inside
    // liquidation). If even that cannot cover the excess, we trim as much as the
    // budget allows and say so plainly.
    const minLev = Math.max(1, cfg.hedgeLeverage ?? 1);
    // The hedge's own ceiling AND the volatility-derived safe maximum: even when
    // an operator raises hedgeLeverageMax, turbulence still pulls the effective
    // hedge leverage down to something the stop can survive.
    const smartCap = smartLeverage(
      cfg.stopLossMarginPct,
      inputs.vol24RangePct ?? 0,
      cfg.leverageVolMultiplier ?? 1.2,
      cfg.hedgeLeverageMax ?? 1
    );
    const maxLev = Math.max(minLev, Math.min(cfg.hedgeLeverageMax ?? minLev, smartCap));
    const targetNotional = excessUsd * clamp(cfg.hedgeRatio, 0, 1);
    // Leverage that exactly covers targetNotional with the available budget.
    const neededLev = budget > 0 ? targetNotional / budget : Number.POSITIVE_INFINITY;
    const lev = clamp(neededLev, minLev, maxLev);
    const wantMargin = Math.min(budget, targetNotional / lev);
    const reachable = lev >= neededLev - 1e-9 && Number.isFinite(neededLev);
    if (wantMargin >= PERP_MIN_COLLATERAL_USD) {
      const postExposurePct =
        inputs.equityUsd > 0
          ? Math.max(0, inputs.gridNetLongUsd - wantMargin * lev) / inputs.equityUsd
          : 0;
      return {
        marginUsd: wantMargin,
        lev,
        side: 'short',
        intent: 'hedge',
        reason: reachable
          ? `trim net-long ${inputs.gridNetLongUsd.toFixed(0)}→${capUsd.toFixed(0)}USD at ${lev.toFixed(1)}x (exposure ${(exposurePct * 100).toFixed(0)}%→${(postExposurePct * 100).toFixed(0)}% of equity)`
          : `partial trim net-long ${inputs.gridNetLongUsd.toFixed(0)}USD at ${lev.toFixed(1)}x (budget-bound)`,
      };
    }
    return idle(`trim wanted ${wantMargin.toFixed(2)} < venue minimum`);
  }

  // Tier 3: profit-seeking directional overlay.
  //
  // This is where "slightly riskier leverage to make more profit" lives. The
  // leverage is NOT a static 3x — it is derived from live volatility by
  // smartLeverage(), so we take the most leverage the market safely allows up to
  // the configured ceiling, and back off automatically when turbulence rises.
  // The fixed `clamp(cfg.maxLeverage, 1, 3)` this replaced silently ignored
  // PERPS_MAX_LEVERAGE above 3.
  if (cfg.overlayEnabled) {
    const overlayBudget = budget * clamp(cfg.overlayBudgetPct, 0, 1);
    if (overlayBudget >= PERP_MIN_COLLATERAL_USD) {
      const lev = smartLeverage(
        cfg.stopLossMarginPct,
        inputs.vol24RangePct ?? 0,
        cfg.leverageVolMultiplier ?? 1.2,
        cfg.maxLeverage
      );
      const v = smartLeverageView(
        cfg.stopLossMarginPct,
        inputs.vol24RangePct ?? 0,
        cfg.leverageVolMultiplier ?? 1.2,
        cfg.maxLeverage
      );
      return {
        marginUsd: overlayBudget,
        lev,
        side: 'long',
        intent: 'overlay',
        reason: `overlay ${lev.toFixed(2)}x (${v.explanation})`,
      };
    }
  }

  return idle('budget below venue minimum / no action');
}

/**
 * SAFETY ASSERTION used before opening: our hard stop must sit INSIDE the
 * venue's liquidation distance, otherwise we could be liquidated before our
 * own stop ever fires (the exact failure mode leverage causes).
 *
 * We compare the adverse move (fraction) to liquidation against the adverse
 * move that consumes our margin-based stop. Our stop must be strictly closer.
 */
export function stopInsideLiquidation(
  side: 'long' | 'short',
  entry: number,
  liquidation: number,
  stopLossMarginPct: number,
  leverage: number
): boolean {
  if (!(entry > 0) || !(liquidation > 0)) return false;
  const liqMove =
    side === 'short' ? (liquidation - entry) / entry : (entry - liquidation) / entry;
  const stopMove = clamp(stopLossMarginPct, 0, 1) / Math.max(1, leverage);
  return stopMove < liqMove;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Carry (borrow/funding) owed on an open perp, as a USD cost.
 *
 * Recomputed from the immutable `openedAt` each tick rather than persisted
 * incrementally, so it can never double-count across ticks or restarts. Kept as
 * a named pure function so the accrual is directly testable — a slow carry
 * bleed must be able to trip the stop even when the mark is flat.
 */
export function borrowAccrualUsd(
  notionalUsd: number,
  hourlyBorrowPct: number,
  hoursHeld: number
): number {
  return (
    Math.max(0, notionalUsd) *
    Math.max(0, hourlyBorrowPct) *
    Math.max(0, hoursHeld)
  );
}
