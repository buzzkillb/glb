// ---------------------------------------------------------------------------
// DYNAMIC LEVER DERIVATION — NO STATIC STRATEGY NUMBERS
// ---------------------------------------------------------------------------
// Every strategy knob that used to be a literal in .env (take-profit %, trail
// %, compounding %, perps margin share) is DERIVED here each poll from LIVE
// market state: the on-chain realized volatility, the trend, the venue's
// momentum/liquidity, and the broker's own round-trip fee floor.
//
// There is no magic result anywhere. The env "config" only supplies POLICY
// BOUNDS (how much risk we are willing to tolerate, how many times fees we
// insist on clearing) — never the answer. If the live signal is unavailable we
// FAIL SAFE by returning unusable=false, and the caller keeps its static
// baseline. Nothing is invented to fill a gap.
// ---------------------------------------------------------------------------

export interface DynamicLeversConfig {
  enabled: boolean;
  /** Minimum take-profit, in % above avg cost. Policy floor only. */
  dcaTpMinPct: number;
  /** Maximum take-profit, in %. Policy ceiling only. */
  dcaTpMaxPct: number;
  /** Trail give-back floor, in %. Policy floor only. */
  dcaTrailMinPct: number;
  /** Trail give-back ceiling, in %. Policy ceiling only. */
  dcaTrailMaxPct: number;
  /** Neutral trail give-back at the target volatility, in %. */
  dcaTrailBasePct: number;
  /** How many round-trip fees the TP must clear before it is allowed to fire. */
  feeMult: number;
  /** Fraction of the live volatility range we try to capture on a TP exit. */
  tpVolShare: number;
  /** Policy ceiling on auto-compounding, in %%. */
  gridCompoundMaxPct: number;
  /** Neutral compounding slope; scaled by realized-profit / equity. */
  gridCompoundBase: number;
  /** Extra compounding slope per unit of realized-profit / equity. */
  gridCompoundProfitMult: number;
  /** Volatility we treat as "normal" for scaling (fraction, e.g. 0.03). */
  volTargetPct: number;
  /** Floor/ceiling on perps margin as a fraction of equity. Policy only. */
  perpsEquityMinPct: number;
  perpsEquityMaxPct: number;
  /** Neutral perps margin share; scaled DOWN as volatility rises. */
  perpsEquityBasePct: number;
  /** Floor/ceiling on the share of eligible profit deployable to perps. */
  perpsProfitShareMinPct: number;
  perpsProfitShareMaxPct: number;
  /** Neutral profit share; scaled UP when the tape is falling (hedge pays). */
  perpsShareBasePct: number;
  /** Sensitivity of profit share to a falling market (0 = ignore trend). */
  shareTrendMult: number;
  /** Ceiling on hedge leverage when the sleeve auto-derives it. */
  perpsHedgeLeverageMaxCap: number;
  /** Reference volume (USD 24h) at which the market is considered deep. */
  minVolumeUsd: number;
}

/**
 * Live signals the derivation reads. All values are measured, never assumed:
 *  - volPct/trendPct come from the on-chain OHLCV the price oracle already
 *    fetched for the grid band;
 *  - feeFloorPct comes from the broker's real round-trip fee model;
 *  - momentum24HPct/volumeUsd come from the perps venue mark feed.
 * A 0 in any required input means "unknown" and fails SAFE.
 */
export interface RegimeSignals {
  /** Realized volatility, in PERCENT (e.g. 3 means a 3% range). */
  volPct: number;
  trendPct: number;
  momentum24HPct: number;
  volumeUsd: number;
  /** Broker's round-trip fee floor, in PERCENT of price. */
  feeFloorPct: number;
  equityUsd: number;
  freeCashUsd: number;
  realizedProfitUsd: number;
  /** Spare SOL/USDC the spot engine could still deploy (working headroom). */
  deployHeadroomUsd: number;
}

export interface DerivedLevers {
  /** False when a required live input was missing -> caller keeps static base. */
  usable: boolean;
  dcaTakeProfitPct: number;
  dcaTrailingPct: number;
  gridCompoundPct: number;
  perpsMaxEquityPct: number;
  perpsProfitSharePct: number;
  perpsHedgeLeverageMax: number;
  /** Human-readable audit of how the numbers were derived this poll. */
  explanation: string;
}

export const DEFAULT_DYNAMIC_LEVERS: DynamicLeversConfig = {
  enabled: true,
  dcaTpMinPct: 0.6,
  dcaTpMaxPct: 25,
  dcaTrailMinPct: 1.5,
  dcaTrailMaxPct: 25,
  dcaTrailBasePct: 4,
  feeMult: 3,
  tpVolShare: 0.8,
  gridCompoundMaxPct: 1,
  gridCompoundBase: 0.15,
  gridCompoundProfitMult: 0.6,
  volTargetPct: 0.03,
  perpsEquityMinPct: 0.02,
  perpsEquityMaxPct: 0.2,
  perpsEquityBasePct: 0.1,
  perpsProfitShareMinPct: 0.25,
  perpsProfitShareMaxPct: 1,
  perpsShareBasePct: 0.6,
  shareTrendMult: 1.5,
  perpsHedgeLeverageMaxCap: 3,
  minVolumeUsd: 10_000_000,
};

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  if (hi < lo) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** Bounds sanitizer so a malformed config can never produce a nonsense lever. */
function bound(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Derive every dynamic lever from live market state. Pure function; safe to
 * unit-test. When `cfg.enabled` is false, or a required signal is missing, it
 * returns usable=false and the caller keeps its configured static baseline.
 */
export function deriveLevers(
  cfgIn: DynamicLeversConfig,
  sig: RegimeSignals
): DerivedLevers {
  const cfg = cfgIn ?? DEFAULT_DYNAMIC_LEVERS;
  const unusable: DerivedLevers = {
    usable: false,
    dcaTakeProfitPct: 0,
    dcaTrailingPct: 0,
    gridCompoundPct: 0,
    perpsMaxEquityPct: 0,
    perpsProfitSharePct: 0,
    perpsHedgeLeverageMax: 0,
    explanation: 'dynamic levers off or live signal unavailable',
  };
  if (!cfg.enabled) return unusable;
  // Required live inputs. Volatility and the fee floor must be real; without
  // either, any "derived" number would be a guess. Both are PERCENT units.
  const volPct = sig.volPct;
  const feePct = sig.feeFloorPct;
  if (!(volPct > 0) || !(feePct > 0)) return unusable;

  const volTarget = bound(cfg.volTargetPct, 0.03) * 100;
  const equity = Math.max(0, sig.equityUsd);
  const volume = Math.max(0, sig.volumeUsd);

  // --- DCA take-profit: must clear real fees by policyMultiple, and target a
  // meaningful share of the live volatility range. Whichever is larger binds;
  // both are market-derived, then clamped inside policy bounds.
  const feeClear = feePct * bound(cfg.feeMult, 3);
  const volCapture = volPct * bound(cfg.tpVolShare, 0.8);
  const dcaTp = clamp(
    Math.max(feeClear, volCapture),
    bound(cfg.dcaTpMinPct, 0.6),
    bound(cfg.dcaTpMaxPct, 25)
  );

  // --- DCA trail: calm tape -> tight give-back (lock the gain); choppy tape ->
  // wider give-back so ordinary noise does not eject us. Scales with the live
  // volatility ratio, never a fixed 4%.
  const volRatio = volPct / volTarget;
  const dcaTrail = clamp(
    bound(cfg.dcaTrailBasePct, 4) * volRatio,
    bound(cfg.dcaTrailMinPct, 1.5),
    bound(cfg.dcaTrailMaxPct, 25)
  );

  // --- Grid compounding: reinvest realized profit, but only to the extent the
  // tape is calm enough that larger levels are likely to fill. Grows with the
  // realised-profit / equity ratio; clamped to a policy ceiling.
  const profitRatio = equity > 0 ? Math.max(0, sig.realizedProfitUsd) / equity : 0;
  const calmFactor = clamp(volTarget / volPct, 0.5, 1.5);
  const gridCompound = clamp(
    (bound(cfg.gridCompoundBase, 0.2) + profitRatio * bound(cfg.gridCompoundProfitMult, 0.6)) * calmFactor,
    0,
    bound(cfg.gridCompoundMaxPct, 2)
  );

  // --- Perps margin share: higher volatility means a given leverage is likelier
  // to be stopped or liquidated, so we deploy LESS margin as vol rises. Inverse
  // to the volatility ratio, clamped inside policy bounds.
  const perpsEquity = clamp(
    bound(cfg.perpsEquityBasePct, 0.1) * (volTarget / volPct),
    bound(cfg.perpsEquityMinPct, 0.02),
    bound(cfg.perpsEquityMaxPct, 0.2)
  );

  // --- Perps profit share: a falling tape is exactly when a short hedge pays,
  // so deploy more of our banked profit then; a rising tape makes borrow a drag,
  // so deploy less. Trend-scaled, clamped.
  const downdraft = Math.max(0, -sig.momentum24HPct);
  const perpsShare = clamp(
    bound(cfg.perpsShareBasePct, 0.6) * (1 + downdraft * bound(cfg.shareTrendMult, 1.5)),
    bound(cfg.perpsProfitShareMinPct, 0.25),
    bound(cfg.perpsProfitShareMaxPct, 1)
  );

  // --- Hedge leverage ceiling: deep books tolerate the policy cap; thin books
  // are cut down proportionally so a single slippage event cannot blow past the
  // stop. Market-derived, never a fixed 3x.
  const capMax = bound(cfg.perpsHedgeLeverageMaxCap, 3);
  const liquidity = volume > 0 ? clamp(volume / bound(cfg.minVolumeUsd, 10_000_000), 0.25, 1) : 0.5;
  const perpsHedgeLev = clamp(capMax * liquidity, 1, capMax);

  return {
    usable: true,
    dcaTakeProfitPct: dcaTp,
    dcaTrailingPct: dcaTrail,
    gridCompoundPct: gridCompound,
    perpsMaxEquityPct: perpsEquity,
    perpsProfitSharePct: perpsShare,
    perpsHedgeLeverageMax: perpsHedgeLev,
    explanation:
      `vol ${volPct.toFixed(2)}% fee ${feePct.toFixed(3)}% -> ` +
      `dcaTP ${dcaTp.toFixed(2)}% trail ${dcaTrail.toFixed(2)}% ` +
      `compound ${(gridCompound * 100).toFixed(1)}% ` +
      `perpsEq ${(perpsEquity * 100).toFixed(1)}% share ${(perpsShare * 100).toFixed(0)}% ` +
      `hedgeLev<${perpsHedgeLev.toFixed(2)}x`,
  };
}

/** Round-trip cost as a PERCENT of price, from the broker's own fee model. */
export function feeFloorFraction(feeStepUsd: number, price: number): number {
  if (!(price > 0) || !(feeStepUsd > 0)) return 0;
  return (feeStepUsd / price) * 100;
}
