import { PERP_MIN_COLLATERAL_USD, PERP_MIN_LEVERAGE } from './perpBroker.js';
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
  /** Market-liquidity floor (USD 24h volume) below which leverage is scaled down. */
  leverageMinVolumeUsd?: number;
  /** Hedge: fraction of grid net-long delta to neutralize (0..1). */
  hedgeRatio: number;
  /** Leverage for the delta-neutral hedge (capped by maxLeverage). */
  hedgeLeverage?: number;
  /** Hard ceiling on the hedge's auto-scaled leverage (stay sane/low). */
  hedgeLeverageMax?: number;
  /** Hedge is a TRIM: hedge only the delta in excess of this % of equity. */
  maxNetExposurePct?: number;
  /** Hard guard: when true the sleeve refuses to open a LONG at all. */
  shortOnly?: boolean;
  /** Direction the Tier-3 overlay takes when enabled (default 'short'). */
  overlaySide?: 'long' | 'short';
  /**
   * Live USDC floor the sleeve may never spend. Set by loadConfig from
   * PERPS_USDC_FLOOR_USD (default USDC_MIN_RESERVE). Optional so hand-built
   * test configs stay valid.
   */
  usdcFloorUsd?: number;
  /** Hedge arms only when grid net-long exposure exceeds this fraction of equity. */
  hedgeTriggerPct: number;
  /** Stop is placed at this fraction of margin loss — must sit INSIDE liquidation. */
  stopLossMarginPct: number;
  /**
   * MINIMUM take-profit share of posted margin for a hedge short (the floor).
   * The live target is dynamic (see planHedgeTakeProfit): it rides a real
   * downtrend for more, and collapses to this floor the moment the move
   * exhausts so we bank before a bounce gives the gain back. 0 disables.
   */
  hedgeTakeProfitPct?: number;
  /** Ceiling on the dynamic take-profit share of margin (defaults to the floor). */
  hedgeTakeProfitMaxPct?: number;
  /** Exhaustion sensitivity vs the venue 24h range (default 1). */
  hedgeTakeProfitVolFactor?: number;
  /**
   * Minutes to wait after a hedge take-profit/unwind before re-arming. Without
   * it, re-opening at the same mark could immediately re-trigger the take-profit
   * and churn venue fees for zero edge.
   */
  hedgeRearmCooldownMinutes?: number;
  /** Loss ceiling (USD): sleeve halts if its own realized loss breaches this. */
  maxLossUsd: number;
  /** Optional directional overlay: 0 disables. */
  overlayEnabled: boolean;
  /** Fraction of sleeve budget the overlay may use. */
  overlayBudgetPct: number;
  overlayTakeProfitPct?: number;
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
  /**
   * Live 24h price change as a fraction (negative = falling market). Feeds the
   * market-direction penalty in smartLeverage(). 0/undefined = flat/unknown.
   */
  momentum24HPct?: number;
  /**
   * Live 24h traded volume, USD. Feeds the market-liquidity penalty so leverage
   * backs off in thin books. 0/undefined = no liquidity data (no penalty).
   */
  volumeUsd?: number;
}

/**
 * SMART LEVERAGE — FULLY DERIVED FROM LIVE STATE. NO HARDCODED RESULT.
 *
 * There is no fixed "use 5x" anywhere. The leverage is COMPUTED every poll from
 * four live inputs: the venue's own volatility, our bag's concentration, the
 * market's direction, and the market's liquidity. Each can only PULL THE NUMBER
 * DOWN; none can invent extra risk. If any input is missing we fail SAFE at 1x.
 *
 *   1. SURVIVAL BOUND (volatility). A position is stopped once the adverse move
 *      reaches stopLossMarginPct/leverage in price terms, so the largest leverage
 *      that survives `volMultiplier` x the recent 24h range before our stop fires
 *      is  stop / (volMultiplier * vol24RangePct).  Calm market -> high number,
 *      turbulent -> low. This is the ceiling, and it is market-derived.
 *
 *   2. BAG CONCENTRATION. If our spot net-long is already a large fraction of
 *      equity, we are NOT diversified, so the sleeve must take less leverage on
 *      top of it. Factor = exposureCap / max(exposureCap, bagExposure). A bag at
 *      the cap pays no penalty; a bag 2x over the cap halves the leverage.
 *
 *   3. MARKET DIRECTION. A long overlay into a falling market is fighting the
 *      tape, so leverage scales with 24h momentum. Falling -> less; flat/up ->
 *      no penalty. Capped so a strong uptrend never *inflates* beyond the bound.
 *
 *   4. MARKET LIQUIDITY. Thin volume means slippage and gap risk, so leverage
 *      scales with 24h traded volume relative to a policy minimum. Deep market ->
 *      no penalty; thin -> less.
 *
 * The product is clamped to [1, survivalBound], so the invariant that our stop
 * always sits inside liquidation is preserved by construction, and the only
 * "numbers" left are policy inputs (env-overridable), never magic results.
 */
export interface LeverageContext {
  /** Fraction of margin we risk before our own stop closes the position. */
  stopLossMarginPct: number;
  /** Live 24h high-low range as a fraction of price (venue mark feed). */
  vol24RangePct: number;
  /** How many 24h ranges of adverse move we insist on surviving. */
  volMultiplier: number;
  /** Our spot net-long exposure as a fraction of equity (bag concentration). */
  bagExposurePct: number;
  /** Exposure fraction we consider acceptable before penalizing leverage. */
  exposureCapPct: number;
  /** Live 24h price change as a fraction (negative = falling market). */
  momentum24HPct: number;
  /** Live 24h traded volume, USD (market liquidity). */
  volumeUsd: number;
  /** Volume below which we treat the market as thin and cut leverage. */
  minVolumeUsd: number;
  /** Policy ceiling override. <= 0 means "derive it from the survival bound". */
  ceilingOverride: number;
}

/** The four derived penalties and the resulting leverage — fully auditable. */
export interface LeverageBreakdown {
  /** Largest leverage the volatility alone permits (pre-penalty ceiling). */
  survivalBound: number;
  /** Ceiling actually applied (override if supplied, else the survival bound). */
  ceiling: number;
  /** Multiplier for bag concentration (<= 1). */
  exposureFactor: number;
  /** Multiplier for market direction (<= 1). */
  momentumFactor: number;
  /** Multiplier for market liquidity (<= 1). */
  liquidityFactor: number;
  /** Leverage we would use right now. */
  recommended: number;
  /** Always 1 — the safe floor. */
  floor: number;
  /** Live inputs, echoed for the dashboard so the number is never a black box. */
  vol24RangePct: number;
  bagExposurePct: number;
  momentum24HPct: number;
  volumeUsd: number;
  /** Human-readable derivation. */
  explanation: string;
}

function deriveLeverage(ctx: LeverageContext): LeverageBreakdown {
  const stop = clamp(ctx.stopLossMarginPct, 0, 1);
  const vol = Math.max(0, ctx.vol24RangePct);
  const mult = Math.max(0.1, ctx.volMultiplier);

  const failSafe: LeverageBreakdown = {
    survivalBound: 1,
    ceiling: 1,
    exposureFactor: 1,
    momentumFactor: 1,
    liquidityFactor: 1,
    recommended: 1,
    floor: 1,
    vol24RangePct: vol,
    bagExposurePct: ctx.bagExposurePct,
    momentum24HPct: ctx.momentum24HPct,
    volumeUsd: ctx.volumeUsd,
    explanation: 'no volatility data yet — failing safe at 1x',
  };
  if (!(stop > 0) || !(vol > 0)) return failSafe;

  // 1. Survival bound: the market's own volatility sets the ceiling.
  const survivalBound = stop / (mult * vol);

  // 2. Bag concentration: penalize leverage only for the part of our book that
  //    sits ABOVE the exposure we consider acceptable. Never rewarded for being
  //    under the cap (factor caps at 1) — concentration can only hurt.
  const cap = Math.max(0, ctx.exposureCapPct);
  const exposure = Math.max(0, ctx.bagExposurePct);
  const exposureFactor =
    exposure > cap && cap > 0 ? clamp(cap / exposure, 0.25, 1) : 1;

  // 3. Market direction: a long overlay into a falling tape gets less leverage.
  //    1% down -> 0.98, 10% down -> 0.8; flat/up never exceeds 1.
  const momentumFactor = clamp(1 + Math.min(0, ctx.momentum24HPct) * 2, 0.5, 1);

  // 4. Market liquidity: thin books get less leverage. Deep market -> 1.
  const minVol = Math.max(0, ctx.minVolumeUsd);
  const liquidityFactor =
    minVol > 0 ? clamp(Math.max(0, ctx.volumeUsd) / minVol, 0.5, 1) : 1;

  // The ceiling is the market-derived survival bound unless the operator pins an
  // explicit override — and even then the bound still governs below it.
  const ceiling =
    ctx.ceilingOverride > 0
      ? Math.min(Math.max(1, ctx.ceilingOverride), survivalBound)
      : survivalBound;

  const raw = survivalBound * exposureFactor * momentumFactor * liquidityFactor;
  const recommended = clamp(raw, 1, Math.max(1, ceiling));

  const binds: string[] = [];
  if (ctx.ceilingOverride > 0 && ctx.ceilingOverride < survivalBound) binds.push('policy ceiling');
  if (exposureFactor < 1) binds.push(`bag ${(exposure * 100).toFixed(0)}% vs cap ${(cap * 100).toFixed(0)}%`);
  if (momentumFactor < 1) binds.push(`market down ${(ctx.momentum24HPct * 100).toFixed(1)}%`);
  if (liquidityFactor < 1) binds.push(`thin volume ${Math.round(ctx.volumeUsd).toLocaleString()}`);

  return {
    survivalBound,
    ceiling,
    exposureFactor,
    momentumFactor,
    liquidityFactor,
    recommended,
    floor: 1,
    vol24RangePct: vol,
    bagExposurePct: exposure,
    momentum24HPct: ctx.momentum24HPct,
    volumeUsd: ctx.volumeUsd,
    explanation:
      `vol ${(vol * 100).toFixed(2)}% range -> survive ${mult.toFixed(1)}x -> ${survivalBound.toFixed(2)}x; ` +
      `penalties x${(exposureFactor * momentumFactor * liquidityFactor).toFixed(3)}` +
      (binds.length ? ` (${binds.join(', ')})` : '') +
      ` -> ${recommended.toFixed(2)}x`,
  };
}

/** Derived leverage for a decision — market- and bag-aware, never hardcoded. */
export function smartLeverage(ctx: LeverageContext): number {
  return deriveLeverage(ctx).recommended;
}

/** Full auditable breakdown so the dashboard can show exactly how it was derived. */
export function smartLeverageView(ctx: LeverageContext): LeverageBreakdown {
  return deriveLeverage(ctx);
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
    // The venue rejects < 1.1x, so our floor must clear it. Policy may raise it.
    const minLev = Math.max(PERP_MIN_LEVERAGE, cfg.hedgeLeverage ?? 1);
    // The hedge's own ceiling AND the derived safe maximum: even when an operator
    // raises hedgeLeverageMax, bag concentration / turbulence / thin liquidity
    // still pull the effective hedge leverage down to something the stop survives.
    const hedgeCap = leverageContext(cfg, inputs, cfg.hedgeLeverageMax ?? minLev);
    const smartCap = smartLeverage(hedgeCap);
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
      const ctx = leverageContext(cfg, inputs, cfg.maxLeverage);
      // Clamp to the venue's enforced floor: a fail-safe of 1x would be rejected.
      const lev = Math.max(PERP_MIN_LEVERAGE, smartLeverage(ctx));
      const v = smartLeverageView(ctx);
      // Direction: default short. shortOnly (default true) is a hard guard so
      // the sleeve never goes long unless an operator opts in explicitly.
      const wantLong = cfg.overlaySide === 'long';
      if (wantLong && (cfg.shortOnly ?? true)) {
        return idle('overlay wants long but shortOnly guard forbids it');
      }
      return {
        marginUsd: overlayBudget,
        lev,
        side: wantLong ? 'long' : 'short',
        intent: 'overlay',
        reason: `overlay ${lev.toFixed(2)}x ${wantLong ? 'long' : 'short'} (${v.explanation})`,
      };
    }
  }

  return idle('budget below venue minimum / no action');
}

/**
 * Assemble the FULL live leverage context: venue volatility, our bag's
 * concentration, market direction, market liquidity, and the policy ceiling.
 * Every field is an INPUT, so the leverage is derived from actual state rather
 * than a hardcoded constant. Kept in one place so the hedge and the overlay use
 * exactly the same risk model.
 */
function leverageContext(
  cfg: PerpSleeveConfig,
  inputs: SleeveInputs,
  ceilingOverride: number
): LeverageContext {
  const equity = Math.max(0, inputs.equityUsd);
  return {
    stopLossMarginPct: cfg.stopLossMarginPct,
    vol24RangePct: inputs.vol24RangePct ?? 0,
    volMultiplier: cfg.leverageVolMultiplier ?? 1.2,
    bagExposurePct: equity > 0 ? Math.max(0, inputs.gridNetLongUsd) / equity : 0,
    exposureCapPct: cfg.maxNetExposurePct ?? 0,
    momentum24HPct: inputs.momentum24HPct ?? 0,
    volumeUsd: inputs.volumeUsd ?? 0,
    minVolumeUsd: cfg.leverageMinVolumeUsd ?? 0,
    ceilingOverride,
  };
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
 * Should an open HEDGE be banked now? The hedge exists to be USEFUL, not to sit
 * flat forever: it should realise a profit once it has earned enough of its
 * posted margin, and otherwise stay on until the stop or an exposure unwind.
 *
 * Pure and side-effect-free so the take-profit rule is directly testable:
 *   - `hedgeTakeProfitPct <= 0` disables take-profit (hedge-only, stop/unwind).
 *   - otherwise true when net PnL (incl. carry) reaches tp% of posted margin.
 */
export function hedgeTakeProfitHit(
  netPnlUsd: number,
  collateralUsd: number,
  hedgeTakeProfitPct: number | undefined
): boolean {
  const tp = hedgeTakeProfitPct ?? 0;
  if (!(tp > 0) || !(collateralUsd > 0)) return false;
  return netPnlUsd >= collateralUsd * tp;
}

/** Live state the dynamic hedge take-profit reacts to. */
export interface HedgeProfitContext {
  /** Current unrealized PnL (USD) on the short. */
  netPnlUsd: number;
  /** Posted margin (USD) — the scale the target is expressed in. */
  collateralUsd: number;
  /** Entry price of the short. */
  entryPriceUsd: number;
  /** Current mark price — used to size the favourable price move honestly. */
  markPriceUsd: number;
  /** Whether the hedge is in profit right now (netPnlUsd > 0). */
  profitable: boolean;
  /** Venue 24h price range as a fraction of price (volatility). */
  vol24RangePct?: number;
  /** Live 24h price change as a fraction (negative = market falling). */
  momentum24HPct?: number;
  /** Minimum bank share of margin (floor). <= 0 disables. */
  minTakeProfitPct?: number;
  /** Maximum bank share of margin (ceiling). Defaults to min when unset. */
  maxTakeProfitPct?: number;
  /** Exhaustion sensitivity vs the 24h range. Default 1. */
  volFactor?: number;
}

/**
 * DYNAMIC HEDGE TAKE-PROFIT — the short is trying to make money on the
 * DOWNSIDE, so its exit must be as adaptive as the entry, not a fixed percent.
 *
 * When the market is falling, the correct behaviour is to RIDE the winning
 * short to a target proportional to who is participating (the venue's live
 * volatility), and to give the target back (collapse to the floor) the moment
 * two things tell us the move is exhausted:
 *   - the favourable move has already spanned the 24h range (a full traversal),
 *   - or the 24h momentum has flipped to flat/up (the downtrend is over).
 *
 * Once exhaustion is flagged we BANK NOW: holding further only invites a bounce
 * that hands the gain back. Every number is derived from live state, and the
 * floor/ceiling are configuration — never a hardcoded magic result.
 */
export function planHedgeTakeProfit(ctx: HedgeProfitContext): {
  /** Share of margin that BANKS the short right now. */
  targetPct: number;
  /** Margin PnL (USD) at which banking fires. */
  targetUsd: number;
  /** True when the move is judged spent and we should bank now. */
  exhausted: boolean;
  /** True when the current gain has already reached the target. */
  fired: boolean;
  reason: string;
} {
  const floor = Math.max(0, ctx.minTakeProfitPct ?? 0);
  const ceil = Math.max(floor, ctx.maxTakeProfitPct ?? floor);
  const vol = Math.max(0, ctx.vol24RangePct ?? 0);
  const mom = ctx.momentum24HPct ?? 0;
  const volFactor = Math.max(0.05, ctx.volFactor ?? 1);

  if (!(floor > 0)) {
    return {
      targetPct: 0,
      targetUsd: 0,
      exhausted: false,
      fired: false,
      reason: 'take-profit disabled',
    };
  }

  // Favourable PRICE move so far, as a fraction of entry (a short gains on a
  // fall). This is the honest "how far has the trade run" measure — distinct
  // from the margin return, which is inflated by leverage.
  const favourableMovePct =
    ctx.profitable && ctx.entryPriceUsd > 0 && ctx.markPriceUsd > 0
      ? Math.max(0, (ctx.entryPriceUsd - ctx.markPriceUsd) / ctx.entryPriceUsd)
      : 0;

  // Exhaustion: a full 24h-range traversal in our favour, or momentum no longer
  // negative. Either means the downward move is spent — bank before a bounce.
  const exhausted =
    (vol > 0 && favourableMovePct >= vol * volFactor) || (ctx.profitable && mom >= 0);

  // Target: ride the trend toward the ceiling while it is intact, else the floor.
  const ride = Math.min(ceil, floor + Math.max(0, -mom) * volFactor * 2);
  const targetPct = exhausted ? floor : Math.max(floor, Math.min(ceil, ride));
  const targetUsd = ctx.collateralUsd * targetPct;
  const fired = ctx.profitable && ctx.netPnlUsd >= targetUsd;

  return {
    targetPct,
    targetUsd,
    exhausted,
    fired,
    reason: fired
      ? exhausted
        ? `banking: move exhausted (24h ${(mom * 100).toFixed(1)}%, range ${(vol * 100).toFixed(1)}%) at ${(targetPct * 100).toFixed(0)}% margin`
        : `banking: rode downtrend to ${(targetPct * 100).toFixed(0)}% margin`
      : `holding: ${(targetPct * 100).toFixed(0)}% target (${exhausted ? 'exhausted' : 'trend intact'}), net ${ctx.netPnlUsd.toFixed(2)} USD`,
  };
}

/**
 * Has the sleeve's re-arm cooldown elapsed? After a close we wait so the sleeve
 * cannot immediately re-enter at the same mark and churn venue fees for no edge.
 * `cooldownMinutes <= 0` disables. A zero `lastActionAt` (never traded) is ready.
 */
export function rearmCooldownElapsed(
  nowMs: number,
  lastActionAtMs: number,
  cooldownMinutes: number | undefined
): boolean {
  const cd = (cooldownMinutes ?? 0) * 60_000;
  if (!(cd > 0)) return true;
  if (!(lastActionAtMs > 0)) return true;
  return nowMs - lastActionAtMs >= cd;
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

/**
 * Unrealized PnL of a perp position at the current mark, in USD.
 *
 * SIGN IS THE WHOLE POINT: a SHORT profits when the mark FALLS and a LONG when
 * it rises. Computing the move in the position's own favour makes the sign
 * unambiguous — the earlier `dir * (mark - entry)` form made every short lose
 * when the market fell, which inverted the stop/halt logic.
 */
export function perpUnrealizedPnlUsd(
  side: 'long' | 'short',
  entryPriceUsd: number,
  markPriceUsd: number,
  notionalUsd: number
): number {
  if (!(entryPriceUsd > 0) || !(markPriceUsd > 0)) return 0;
  const move =
    (side === 'long' ? markPriceUsd - entryPriceUsd : entryPriceUsd - markPriceUsd) /
    entryPriceUsd;
  return move * Math.max(0, notionalUsd);
}
