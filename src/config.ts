import 'dotenv/config';

export type Mode = 'paper' | 'live';

/**
 * Jupiter's legacy endpoints (quote-api.jup.ag / lite-api.jup.ag) were
 * decommissioned. Any configured value pointing at them is silently upgraded
 * to the current Swap API V2 base URL so a stale .env can never break the bot.
 */
const CURRENT_JUPITER_BASE = 'https://api.jup.ag/swap/v2';
const DEPRECATED_JUPITER_HOSTS = ['quote-api.jup.ag', 'lite-api.jup.ag'];

function normalizeJupiterUrl(value: string | undefined): string {
  if (!value) return CURRENT_JUPITER_BASE;
  if (DEPRECATED_JUPITER_HOSTS.some((h) => value.includes(h))) {
    console.warn(
      `[config] Deprecated Jupiter URL "${value}" -> using "${CURRENT_JUPITER_BASE}"`
    );
    return CURRENT_JUPITER_BASE;
  }
  return value;
}

export interface GridConfig {
  baseAsset: string; // 'SOL'
  quoteAsset: string; // 'USDC'
  baseMint: string;
  quoteMint: string;
  lowerPrice: number; // grid lower bound in USDC (legacy; adaptive grid ignores)
  upperPrice: number; // grid upper bound in USDC (legacy; adaptive grid ignores)
  numLevels: number; // number of buy/sell levels
  usdcPerGrid: number; // USDC allocated per (base) buy level
  enabled: boolean;
  /** Minutes of on-chain history used to size the band ("looks backwards"). */
  historyHours: number;
  /** Minutes between re-anchors (how fast the grid follows a trending market). */
  reanchorMinutes: number;
  /** Anti-churn (Feature 2): minimum distance (fraction of a step) price must
   *  move from a fill before we re-arm the opposite side. Prevents double-fee
   *  whipsaws on micro-oscillations. */
  deadzoneSteps: number;
  /** Min consecutive polls the drifted price must persist before re-anchoring
   *  (confirms a real move vs. a single glitchy print that would otherwise
   *  re-center the band on a bogus price). */
  reanchorConfirmPolls?: number;
  /** Compounding (Feature 3): reinvest realized PnL by scaling grid notional.
   *  1.0 means a PnL equal to the capital cap doubles per-level size. */
  compoundPct: number;
  /** Volatility-scaled sizing (Feature 5): OVERSIZE in calm tape (levels likelier
   *  to fill), UNDERSIZE in violent tape (avoid catching a falling knife). */
  volSizingEnabled: boolean;
  /** VWAP skew (Feature 4): weight capital toward levels BELOW VWAP (buy dips)
   *  and away from levels ABOVE VWAP (don't over-buy strength). */
  vwapSkewEnabled: boolean;
  skewStrength: number;
  /** Anchor-weighted ladder growth factor (GRID_LADDER_WEIGHT_K, 0 = even).
   *  Optional so hand-built test configs stay valid; loadConfig always sets it. */
  ladderWeightK?: number;
}

export interface DcaConfig {
  baseAsset: string;
  quoteAsset: string;
  baseMint: string;
  quoteMint: string;
  intervalMinutes: number;
  usdcAmountPerBuy: number;
  dipPctBelowVwap: number; // trigger only when price dips below VWAP by this %
  enabled: boolean;
  // Trailing take-profit leg: ring-fence profit on accumulated DCA position.
  takeProfitPct: number; // trigger only once price is this % above avg cost
  trailingPct: number; // give back this % from the peak before selling a slice
  takeProfitSlicePct: number; // fraction of held SOL to bank per take-profit fill
  /** Min interval between take-profit slice sells (minutes). Prevents a rapid
   *  re-drain when price oscillates around the trail-back level right after a
   *  sell resets the trailing peak. */
  tpCooldownMinutes: number;
  /** Fee-aware minimum buy notional (USD). A DCA buy pays a near-constant
   *  network/priority fee per swap, so a micro-buy (e.g. a tiny value-average
   *  increment) spends more on fees than it banks. Never fire a buy below this
   *  notional — bump it up (subject to cap) instead. */
  minBuyUsd?: number;
  // Value averaging (Feature 1): follow a target SOL position path instead of a
  // fixed $ amount — buy MORE when you're behind (cheap), buy LESS when ahead.
  vaEnabled: boolean;
  vaTargetSol: number; // terminal target position in SOL
  vaHorizonBuys: number; // number of buys over which to reach the target
}

export interface RiskConfig {
  maxUsdcPosition: number; // hard cap on USDC deployed to bots (enforced on every buy)
  hardStopPct: number; // e.g. -0.15 = stop out if cumulative PnL drops 15% of maxUsdcPosition (REALIZED only)
  /** Unrealized draw-down guard: pause if the OPEN position is underwater by
   *  this fraction of maxUsdcPosition. A falling market can bleed unrealized
   *  PnL far past the realized hard-stop before anything closes — this switch
   *  halts deployment once the open basket sinks too deep instead of averaging
   *  a falling knife. Fires independently of the realized hard-stop. */
  unrealizedHardStopPct: number; // e.g. -0.20 = pause when open PnL <= -20% of maxUsdcPosition
  maxSlippageBps: number; // Jupiter slippage in basis points
  maxStalePricePolls: number; // safety: skip acting after N consecutive failed price fetches
  /**
   * Single-poll sanity gate for the price oracle. A freshly-fetched price that
   * differs from the previously-committed price by MORE than this fraction is
   * treated as an anomaly (a bad/glitched quote — e.g. the ~$5.97 print on a
   * ~$107 SOL) and is NOT committed to the stream. This prevents a 30-50x
   * single-poll "flash" from triggering crossed-fill SELLs or a DCA trailing
   * sell against a fabricated price. A genuine market move will pass across
   * multiple successive polls. e.g. 0.15 = reject >15% single-poll jump.
   */
  maxSingleJumpPct: number;

  /** AUTO CIRCUIT-BREAKER (#9): if ALL price/quote sources fail for
   *  maxStalePricePolls consecutive polls, auto-arm the live kill-switch
   *  (hard-halt the swap path) instead of limping on stale data. 1 = on, 0 = off. */
  autoCircuitBreaker: boolean;
}

/**
 * A graduated meme (e.g. CYB via pump.fun). Designed as a self-contained slot
 * so more memes can be added later by appending to MEME_SLOTS. Each slot owns
 * its own real GeckoTerminal OHLCV feed, capital cap, and thin-liquidity logic.
 */
export interface MemeSlotConfig {
  id: string; // 'cyb'
  baseAsset: string; // 'CYB'
  quoteAsset: string; // 'USDC'
  baseMint: string; // CYB mint
  quoteMint: string; // USDC mint
  pool: string; // GeckoTerminal pool id (solana_<addr>)
  /** Direct PumpSwap pool address. When set, this meme slot swaps DIRECTLY
   *  against PumpSwap (pAMMBay6o…) instead of Jupiter — required for thin
   *  graduated pump.fun pools Jupiter no longer routes. Quote must be SOL. */
  pumpPool?: string;
  enabled: boolean;
  maxUsdcPosition: number; // ring-fenced capital cap for this meme
  maxSlippageBps: number; // hard slippage ceiling (thick can't absorb)
  usdcPerBuy: number; // notional per buy slice
  minIntervalMinutes: number; // min time between buys (slow, thin)
  targetDepositPct: number; // target USDC reservation of cap per tranche
  historyHours: number; // real history window for band sizing
  admissionMinVolumeUsd: number; // refuse to deploy until real 24h volume >= this
  admissionMinLiquidityUsd: number; // refuse if real pool liquidity < this
  /** Staggered take-profit ladder: each rung banks `slicePct` when price runs
   *  `targetPct` (fraction above avg cost) AND price is at/near its local peak
   *  (trailing give-back). Later rungs lock gains progressively on a meme run
   *  instead of giving everything back waiting for one trailing stop. */
  tpRungs: { targetPct: number; slicePct: number }[];
  /** Per-slot loss ceiling (USD). If this slot's REALIZED PnL breaches -maxLossUsd,
   *  the slot stops accumulating (defensive halt) while the trailing take-profit
   *  still unwinds any remaining size. 0 = disabled. Ring-fences risk so a
   *  single meme rug can't drain the rest of the wallet. */
  maxLossUsd: number;
  /** Dead-book exit (fraction, 0 = disabled): if the pool's REAL liquidity drops
   *  below (peakLiquidity * (1 - liquidityDecayExitPct)) since we started holding,
   *  treat it as exit-liquidity withdrawal / rug signal — halt accumulation and
   *  defensively sell out the remaining position at market. */
  liquidityDecayExitPct: number;
}

export interface StrategyConfig {
  grid: GridConfig;
  dca: DcaConfig;
  memes: MemeSlotConfig[];
  perps: PerpSleeveConfig;
}

/**
 * Perps sleeve configuration.
 *
 * The sleeve is a profit-funded, risk-isolated overlay on the spot book. It can
 * ONLY deploy profit above a ratcheting high-water mark, so base capital is
 * never at risk. Defaults are conservative and the sleeve is OFF unless
 * PERPS_ENABLED=1 is set deliberately.
 */
/** Conservative default used when a caller builds a config without a perps
 *  block (e.g. minimal test fixtures). Disabled, so it is inert by default. */
export const DEFAULT_PERPS_CONFIG: PerpSleeveConfig = {
  enabled: false,
  // "Use the entire PnL": default to 1.0 so ALL eligible profit is deployable,
  // leaving only the risk caps below (equity %) as the true ceiling.
  profitSharePct: 1.0,
  cashUsePct: 1.0,
  // Default USDC floor for the static DEFAULT_PERPS_CONFIG shape (the env-loaded
  // config overrides this with the live USDC_MIN_RESERVE value).
  usdcFloorUsd: 30,
  // Fraction of the sleeve's OWN banked realized PnL (read live from the trade
  // tape) that is deployable. 0 disables the realized-PnL funding path.
  realizedProfitUsePct: 1.0,
  // Trailing window (hours) for the windowed-realized profit signal.
  profitWindowHours: 168,
  // Minimum real fills before the tape is trusted enough to size from.
  minFillsForConfidence: 8,
  // Venue cost model for the paper/live estimate (open/close fee, hourly borrow).
  openFeePct: 0.0006,
  hourlyBorrowPct: 0.000006,
  // Hard safety cap: sleeve margin may never exceed this fraction of equity.
  // This is the last-resort ceiling that keeps the sleeve from over-deploying
  // even when profit is large. 10% is conservative; raise deliberately.
  maxEquityPct: 0.1,
  // Absolute USD ceiling. 0 (default) = NO USD ceiling: deploy the full computed
  // profit, bounded only by the equity-% cap above and liquid cash.
  maxMarginUsd: 0,
  // When the loss ceiling trips, also flatten any open position (default off:
  // halt blocks new margin only, leaving the live position managed).
  haltClosesOpen: false,
  // POLICY CEILING OVERRIDE. 0 (default) = NO hardcoded ceiling: the leverage
  // ceiling is DERIVED from the venue's live volatility each poll. Set > 0 only
  // to pin an absolute cap for policy; even then the volatility/survival bound
  // still governs below it. This repo ships with no magic leverage number.
  maxLeverage: 0,
  // How many recent 24h ranges of adverse move the position must SURVIVE before
  // our margin stop is hit. Higher = safer = lower leverage. 1.2 means we stop
  // only after a move 1.2x the entire day's range — beyond ordinary noise. This
  // is a POLICY input (how much shock we insist on surviving), not a result.
  leverageVolMultiplier: 1.2,
  // Market liquidity floor: below this 24h traded volume the book is treated as
  // thin and leverage is scaled down. Policy input, not a magic number.
  leverageMinVolumeUsd: 10_000_000,
  hedgeRatio: 1.0,
  // Hedging uses its own leverage, independent of maxLeverage (which caps the
  // directional overlay). The controller auto-scales from this floor up to
  // hedgeLeverageMax when the excess delta exceeds what one unit of leverage can
  // fund — but never further, because the hedge is a TRIM, not a conversion.
  hedgeLeverage: 1,
  // SANE ceiling. We deliberately do NOT crank leverage to cover a spot book many
  // times the sleeve's size: full neutralization would bleed borrow on the whole
  // notional and let normal price noise stop us out. 3x keeps our stop far inside
  // liquidation and lets the hedge actually hold.
  hedgeLeverageMax: 3,
  // The whole point: cap net-long exposure as a fraction of equity. We do NOT
  // delta-neutral the entire bag — the spot net-long is the strategy's upside and
  // working capital. We only shed the EXCESS above this target, funded from
  // profit, at sane leverage. 0 disables the cap (hedge relative to the full
  // delta, the old behavior).
  maxNetExposurePct: 0.35,
  hedgeTriggerPct: 0.15,
  stopLossMarginPct: 0.25,
  maxLossUsd: 75,
  overlayEnabled: false,
  overlayBudgetPct: 0.5,
  // Short-only by default: the hedge is always a short, and the overlay defaults
  // to short too, so the sleeve never goes long unless an operator opts in.
  overlaySide: 'short',
  shortOnly: true,
  baselineEquityUsd: 0,
  apiUrl: 'https://perps-api.jup.ag/v1',
  slippageBps: 100,
};

export interface PerpSleeveConfig {
  enabled: boolean;
  /** Fraction of eligible profit (equity above the floor) deployable. */
  profitSharePct: number;
  /** Fraction of *liquid USDC* deployable — SOL inventory cannot post margin. */
  cashUsePct: number;
  /**
   * Deployable fraction of the sleeve's OWN banked realized PnL (read live from
   * the trade tape). This is the "+$521.10 since inception" path — realized PnL
   * already banked, so it is safe to risk on a hedge. 0 disables it. Never
   * negative, never exceeds liquid cash.
   */
  realizedProfitUsePct: number;
  /** Trailing window (hours) for the windowed-realized signal. */
  profitWindowHours: number;
  /** Confidence floor: minimum real fills before the tape is trusted to size. */
  minFillsForConfidence: number;
  /** Venue open/close fee as a fraction of notional (cost model). */
  openFeePct: number;
  /** Venue hourly borrow rate as a fraction of notional (cost model). */
  hourlyBorrowPct: number;
  /** Absolute cap on sleeve margin as a fraction of equity (final safety ceiling). */
  maxEquityPct: number;
  /**
   * Hard USDC floor the sleeve may never spend. Perps posts USDC as margin, so
   * without this the sleeve could drain the cash the spot grid/DCA needs to
   * keep trading. Defaults to the spot `USDC_MIN_RESERVE` so the spot book's
   * working cash is always protected. Raise it to hold back more.
   */
  usdcFloorUsd: number;
  /** Hard USD ceiling on margin. 0 = uncapped (deploy full computed profit). */
  maxMarginUsd: number;
  /**
   * When the loss ceiling trips, also flatten any open position. Default false:
   * "halt" blocks NEW margin only and keeps managing the live position.
   */
  haltClosesOpen: boolean;
  /**
   * POLICY leverage ceiling override. 0 (default) = no hardcoded ceiling: the
   * ceiling is DERIVED from live venue volatility. Set > 0 only to pin an
   * absolute policy cap; the volatility/survival bound still governs below it.
   */
  maxLeverage: number;
  /**
   * Volatility multiple. The position is sized so it SURVIVES an adverse move of
   * this many recent 24h ranges before the margin stop triggers. Higher = safer
   * = lower leverage. A POLICY input (shock tolerance), never a magic result.
   */
  leverageVolMultiplier: number;
  /**
   * Market-liquidity floor (USD 24h volume). Below this the book is thin and
   * leverage is scaled down. Policy input, not a hardcoded leverage.
   */
  leverageMinVolumeUsd?: number;
  /** Hedge: fraction of grid net-long delta to neutralize (0..1). 1.0 = full. */
  hedgeRatio: number;
  /**
   * Minimum leverage for the delta-neutral hedge. The controller auto-scales UP
   * from here (up to hedgeLeverageMax) so a profit-sized budget can still match
   * a much larger grid delta. Independent of maxLeverage (which caps the
   * directional overlay, not the hedge).
   */
  hedgeLeverage: number;
  /**
   * Hard ceiling on auto-scaled hedge leverage. The controller picks the smallest
   * leverage that lets the deployable budget reach the target notional, never
   * exceeding this. Kept intentionally low (default 3) because the hedge is a
   * trim, not a full neutralization: high leverage would stop out on ordinary
   * price noise and bleed borrow on notional far larger than the sleeve.
   */
  hedgeLeverageMax: number;
  /**
   * Cap on net-long exposure as a fraction of equity. The hedge targets only the
   * EXCESS above this, so the strategy keeps its directional upside and we never
   * pay to neutralize the whole bag. 0 = no cap (hedge against the full delta).
   */
  maxNetExposurePct: number;
  /** Hedge arms only when grid net-long exposure exceeds this fraction of equity. */
  hedgeTriggerPct: number;
  /** Stop is placed at this fraction of margin loss — must sit INSIDE liquidation. */
  stopLossMarginPct: number;
  /** Loss ceiling (USD): sleeve halts if its own realized loss breaches this. */
  maxLossUsd: number;
  /** Directional overlay (Tier 3). Off by default. */
  overlayEnabled: boolean;
  /** Fraction of sleeve budget the overlay may use. */
  overlayBudgetPct: number;
  /**
   * Direction the overlay takes when enabled. Defaults to 'short' so the sleeve
   * is short-only unless an operator opts into longs. The hedge is always short.
   */
  overlaySide?: 'long' | 'short';
  /**
   * Hard guard: when true the sleeve refuses to open a LONG at all. Default
   * true — perps only ever shorts (trim net-long spot SOL, or short overlay).
   */
  shortOnly?: boolean;
  /** Principal floor in USD. 0 = auto-seed to the first observed equity. */
  baselineEquityUsd: number;
  /** Jupiter Perps API base, e.g. https://perps-api.jup.ag/v1 */
  apiUrl: string;
  /** slippage ceiling in bps for perp open/close */
  slippageBps: number;
}

export interface AppConfig {
  mode: Mode;
  rpcUrl: string;
  jupiterApiUrl: string;
  pollIntervalMs: number;
  refreshIntervalMs: number; // dashboard price refresh
  walletKeyPath: string; // paper/live keypair file
  strategies: StrategyConfig;
  risk: RiskConfig;
  /** BirdEye API key (needed for real on-chain OHLCV candles → VWAP for meme
   *  tokens like CYB). Free key from pro.birdeye.so. GeckoTerminal only serves
   *  liquidity/24h-volume as a keyless fallback — we do NOT need its key, and
   *  we do NOT use CoinGecko for meme data at all. */
  birdeyeApiKey?: string;
}

const envNumber = (key: string, fallback: number, min?: number, max?: number): number => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  // Some bounds enforce plausibility so a typo'd negative/clamped value can
  // never silently produce a dangerous config (e.g. negative slippage).
  let out = n;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
};

const envBool = (key: string, fallback: boolean): boolean => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  // Accept the spellings an operator actually types. The old exact-match check
  // meant PERPS_SHORT_ONLY=TRUE (or yes/on) silently DISABLED the short-only
  // guard — the value most likely to be written for a safety flag.
  const norm = v.trim().toLowerCase();
  if (norm === 'true' || norm === '1' || norm === 'yes' || norm === 'on') return true;
  if (norm === 'false' || norm === '0' || norm === 'no' || norm === 'off') return false;
  console.warn(`[config] ${key}="${v}" is not a recognized boolean; using ${fallback}`);
  return fallback;
};

export function loadConfig(): AppConfig {
  return {
    mode: (process.env.TRADE_MODE as Mode) || 'paper',
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    jupiterApiUrl: normalizeJupiterUrl(process.env.JUPITER_API_URL),
    pollIntervalMs: envNumber('POLL_INTERVAL_MS', 30000),
    refreshIntervalMs: envNumber('REFRESH_INTERVAL_MS', 5000),
    walletKeyPath: process.env.WALLET_KEY_PATH || './wallet.key',
    birdeyeApiKey: process.env.BIRDEYE_API_KEY || undefined,
    strategies: {
      grid: {
        baseAsset: 'SOL',
        quoteAsset: 'USDC',
        baseMint: 'So11111111111111111111111111111111111111112',
        quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        lowerPrice: envNumber('GRID_LOWER', 120),
        upperPrice: envNumber('GRID_UPPER', 180),
        numLevels: envNumber('GRID_LEVELS', 8, 2, 100),
        usdcPerGrid: envNumber('GRID_USDC_PER_LEVEL', 20, 1, 1e6),
        enabled: envBool('GRID_ENABLED', true),
        historyHours: envNumber('GRID_HISTORY_HOURS', 48, 1, 2160),
        reanchorMinutes: envNumber('GRID_REANCHOR_MIN', 240, 1, 1440),
        deadzoneSteps: envNumber('GRID_DEADZONE_STEPS', 2, 0, 10),
        reanchorConfirmPolls: envNumber('GRID_REANCHOR_CONFIRM_POLLS', 3, 1, 100),
        compoundPct: envNumber('GRID_COMPOUND_PCT', 0, 0, 10),
        volSizingEnabled: envBool('GRID_VOL_SIZING', true),
        vwapSkewEnabled: envBool('GRID_VWAP_SKEW', true),
        skewStrength: envNumber('GRID_SKEW_STRENGTH', 0.35, 0, 10),
        ladderWeightK: envNumber('GRID_LADDER_WEIGHT_K', 0.12, 0, 3),
      },
      dca: {
        baseAsset: 'SOL',
        quoteAsset: 'USDC',
        baseMint: 'So11111111111111111111111111111111111111112',
        quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        intervalMinutes: envNumber('DCA_INTERVAL_MIN', 120, 1, 1440),
        usdcAmountPerBuy: envNumber('DCA_USDC_PER_BUY', 25, 1, 1e6),
        dipPctBelowVwap: envNumber('DCA_DIP_PCT', 3, 0.01, 100),
        enabled: envBool('DCA_ENABLED', true),
        takeProfitPct: envNumber('DCA_TP_PCT', 1.0, 0, 100),
        trailingPct: envNumber('DCA_TRAILING_PCT', 4, 0, 99),
        takeProfitSlicePct: envNumber('DCA_TP_SLICE_PCT', 50, 1, 100),
        tpCooldownMinutes: envNumber('DCA_TP_COOLDOWN_MIN', 30, 0, 10080),
        vaEnabled: envBool('DCA_VA_ENABLED', true),
        vaTargetSol: envNumber('DCA_VA_TARGET_SOL', 5, 0.1, 1e6),
        vaHorizonBuys: envNumber('DCA_VA_HORIZON_BUYS', 12, 1, 100000),
        minBuyUsd: envNumber('DCA_MIN_BUY_USD', 15, 1, 1e6),
      },
      memes: [
        {
          // CYB — graduated meme via pump.fun, thin but real liquidity.
          id: 'cyb',
          baseAsset: 'CYB',
          quoteAsset: 'USDC',
          baseMint: 'J2hyZSVokSTuy3bG85A5xfs3umCeGtqZZEdKtGTTpump',
          quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          pool: 'solana_CHVehKRbncDPDr1od9EYA1vp635wwFdZgXdzEXXT6v96',
          // Direct PumpSwap execution (Jupiter no longer routes this pool).
          pumpPool: 'CHVehKRbncDPDr1od9EYA1vp635wwFdZgXdzEXXT6v96',
          enabled: envBool('CYB_ENABLED', true),
          maxUsdcPosition: envNumber('CYB_MAX_USDC', 200),
          maxSlippageBps: envNumber('CYB_SLIPPAGE_BPS', 500, 0, 2000),
          usdcPerBuy: envNumber('CYB_USDC_PER_BUY', 10, 1, 1000),
          minIntervalMinutes: envNumber('CYB_MIN_INTERVAL_MIN', 5, 1, 1440),
          targetDepositPct: envNumber('CYB_TARGET_DEPOSIT_PCT', 0.6, 0.01, 1),
          historyHours: envNumber('CYB_HISTORY_HOURS', 72, 1, 2160),
          admissionMinVolumeUsd: envNumber('CYB_MIN_VOL_USD', 100, 0, 1e9),
          admissionMinLiquidityUsd: envNumber('CYB_MIN_LIQ_USD', 1000, 0, 1e9),
          maxLossUsd: envNumber('CYB_MAX_LOSS_USD', 60, 0, 1e9),
          liquidityDecayExitPct: envNumber('CYB_LIQ_DECAY_EXIT_PCT', 0.5, 0, 0.95),
          // Staggered ladder: bank 40% at +50%, 30% more at +100%, rest trails.
          tpRungs: [
            { targetPct: 0.5, slicePct: 0.4 },
            { targetPct: 1.0, slicePct: 0.3 },
          ],
        },
      ],
      // PERPS SLEEVE (profit-funded, risk-isolated leverage overlay).
      // OFF by default: PERPS_ENABLED must be set deliberately. Even when on,
      // it deploys ONLY profit above a ratcheting high-water mark, so the spot
      // grid/DCA book (base capital) is never at risk.
      perps: {
        enabled: envBool('PERPS_ENABLED', false),
        profitSharePct: envNumber('PERPS_PROFIT_SHARE_PCT', 1.0, 0, 1),
        // Only liquid USDC can be posted as margin; SOL is inventory. NOTE this
        // is a PHYSICAL CEILING, not a funding source: the sleeve is funded from
        // PnL (equity above the principal floor + banked realized PnL), and the
        // raw bag can never ADD to that — it can only limit how much of the PnL
        // is postable right now. Leave at 1.0 unless you want to cap how much of
        // the liquid bag may simultaneously back a position.
        cashUsePct: envNumber('PERPS_CASH_USE_PCT', 1.0, 0, 1),
        // Fraction of banked realized PnL the sleeve may risk.
        realizedProfitUsePct: envNumber('PERPS_REALIZED_USE_PCT', 1.0, 0, 1),
        profitWindowHours: envNumber('PERPS_PROFIT_WINDOW_HOURS', 168, 1, 8760),
        minFillsForConfidence: envNumber('PERPS_MIN_FILLS', 8, 0, 1e6),
        openFeePct: envNumber('PERPS_OPEN_FEE_PCT', 0.0006, 0, 0.1),
        hourlyBorrowPct: envNumber('PERPS_HOURLY_BORROW_PCT', 0.000006, 0, 0.01),
        maxEquityPct: envNumber('PERPS_MAX_EQUITY_PCT', 0.1, 0, 1),
        // Never spend below this USDC amount: the spot grid/DCA keeps working.
        // Defaults to the same floor the spot sizer uses, so enabling perps can
        // not starve the spot book of its working cash.
        usdcFloorUsd: envNumber(
          'PERPS_USDC_FLOOR_USD',
          envNumber('USDC_MIN_RESERVE', 30, 0, 1e9),
          0,
          1e9
        ),
        maxMarginUsd: envNumber('PERPS_MAX_MARGIN_USD', 0, 0, 1e9),
        haltClosesOpen: envBool('PERPS_HALT_CLOSES_OPEN', false),
        // 0 = derive the ceiling from live volatility (no hardcoded leverage).
        maxLeverage: envNumber('PERPS_MAX_LEVERAGE', 0, 0, 20),
        leverageVolMultiplier: envNumber('PERPS_LEVERAGE_VOL_MULTIPLIER', 1.2, 0.1, 10),
        leverageMinVolumeUsd: envNumber('PERPS_LEVERAGE_MIN_VOLUME_USD', 10_000_000, 0, 1e12),
        hedgeRatio: envNumber('PERPS_HEDGE_RATIO', 1.0, 0, 1),
        hedgeLeverage: envNumber('PERPS_HEDGE_LEVERAGE', 1, 1, 20),
        hedgeLeverageMax: envNumber('PERPS_HEDGE_LEVERAGE_MAX', 3, 1, 20),
        maxNetExposurePct: envNumber('PERPS_MAX_NET_EXPOSURE_PCT', 0.35, 0, 1),
        hedgeTriggerPct: envNumber('PERPS_HEDGE_TRIGGER_PCT', 0.15, 0, 1),
        stopLossMarginPct: envNumber('PERPS_STOP_LOSS_MARGIN_PCT', 0.25, 0.01, 0.99),
        maxLossUsd: envNumber('PERPS_MAX_LOSS_USD', 75, 0, 1e9),
        overlayEnabled: envBool('PERPS_OVERLAY_ENABLED', false),
        overlayBudgetPct: envNumber('PERPS_OVERLAY_BUDGET_PCT', 0.5, 0, 1),
        // Direction the Tier-3 overlay takes when enabled. The sleeve is
        // SHORT-ONLY by default: the hedge is always a short (it trims net-long
        // spot SOL), and the overlay defaults to short too, so the sleeve never
        // goes long unless an operator explicitly opts in via overlaySide=long
        // AND shortOnly=0.
        overlaySide: (process.env.PERPS_OVERLAY_SIDE === 'long' ? 'long' : 'short') as
          | 'long'
          | 'short',
        // Hard guard: refuse to open a LONG at all. Default on — the sleeve only
        // ever shorts. Turn off ONLY to allow the Tier-3 overlay to go long.
        shortOnly: envBool('PERPS_SHORT_ONLY', true),
        // Untouchable principal. Set this to lock a specific principal amount;
        // 0 auto-seeds to the first observed equity, so the sleeve must first
        // EARN profit before it can deploy anything.
        baselineEquityUsd: envNumber('PERPS_PRINCIPAL_FLOOR_USD', 0, 0, 1e12),
        apiUrl: process.env.PERPS_API_URL || 'https://perps-api.jup.ag/v1',
        slippageBps: envNumber('PERPS_SLIPPAGE_BPS', 100, 1, 2000),
      },
    },
    risk: {
      maxUsdcPosition: envNumber('RISK_MAX_USDC', 400, 1, 1e9),
      hardStopPct: envNumber('RISK_HARD_STOP_PCT', 0.25, 0, 0.99),
      unrealizedHardStopPct: envNumber('RISK_UNREALIZED_STOP_PCT', 0.20, 0, 0.99),
      maxSlippageBps: envNumber('RISK_SLIPPAGE_BPS', 100, 0, 2000),
      maxStalePricePolls: envNumber('RISK_MAX_STALE_POLLS', 5, 1, 1000),
      autoCircuitBreaker: envBool('RISK_AUTO_CIRCUIT_BREAKER', true),
      maxSingleJumpPct: envNumber('RISK_MAX_SINGLE_JUMP_PCT', 0.05, 0.02, 1),
    },
  };
}
