import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Isolate the perps ledger on disk so these tests never touch live state.
process.env.PERP_STATE_DIR = mkdtempSync(path.join(tmpdir(), 'perps-test-'));

import {
  borrowAccrualUsd,
  computeSleeveBudget,
  decideSleeveAction,
  smartLeverage,
  smartLeverageView,
  stopInsideLiquidation,
  type PerpSleeveConfig,
  type SleeveInputs,
} from '../src/perpStrategy.js';
import { PerpStore, type PerpLedger } from '../src/perpStore.js';
import { PerpPriceFeed, PERP_MARKETS } from '../src/perpPrice.js';

/** Fresh isolated ledger dir per test (stateDir is read at construction time). */
function freshStore(mode: 'paper' | 'live'): PerpStore {
  process.env.PERP_STATE_DIR = mkdtempSync(path.join(tmpdir(), 'perps-store-'));
  return new PerpStore(mode);
}

const cfg = (over: Partial<PerpSleeveConfig> = {}): PerpSleeveConfig => ({
  enabled: true,
  profitSharePct: 0.5,
  maxEquityPct: 0.1,
  maxMarginUsd: 250,
  maxLeverage: 3,
  hedgeRatio: 0.8,
  hedgeLeverage: 2,
  hedgeTriggerPct: 0.15,
  stopLossMarginPct: 0.25,
  maxLossUsd: 75,
  overlayEnabled: false,
  overlayBudgetPct: 0.5,
  baselineEquityUsd: 0,
  ...over,
});

const ledger = (over: Partial<PerpLedger> = {}): PerpLedger => ({
  version: 1,
  principalFloorUsd: 0,
  peakEquityUsd: 0,
  outstandingMarginUsd: 0,
  realizedPnlUsd: 0,
  feesPaidUsd: 0,
  position: null,
  halted: false,
  haltReason: '',
  lastActionAt: 0,
  history: [],
  ...over,
});

const inputs = (over: Partial<SleeveInputs> = {}): SleeveInputs => ({
  equityUsd: 10_500,
  ledger: ledger(),
  gridNetLongUsd: 0,
  markPrice: 116,
  ...over,
});

test('budget is 0 when equity is at or below the principal floor', () => {
  // Equity exactly at the floor -> no earned profit -> nothing to deploy.
  assert.equal(computeSleeveBudget(cfg(), inputs({ equityUsd: 10_000, ledger: ledger({ principalFloorUsd: 10_000 }) })), 0);
  // Equity BELOW the floor (a drawdown): budget must be exactly 0, never negative.
  const b = computeSleeveBudget(cfg(), inputs({ equityUsd: 9_200, ledger: ledger({ principalFloorUsd: 10_000 }) }));
  assert.equal(b, 0);
  assert.ok(b >= 0);
});

test('negative sleeve PnL shrinks budget but never risks principal', () => {
  // Sleeve lost money and equity dipped below the floor: budget sits at 0
  // rather than "owing" margin.
  const led = ledger({ principalFloorUsd: 10_500, realizedPnlUsd: -40 });
  assert.equal(computeSleeveBudget(cfg(), inputs({ equityUsd: 10_480, ledger: led })), 0);
});

test('budget = profit above floor * share, clamped by equity cap and USD ceiling', () => {
  // 500 profit * 0.5 = 250, equity cap = 10500*0.1 = 1050, ceiling 250 -> 250
  assert.equal(
    computeSleeveBudget(cfg(), inputs({ equityUsd: 10_500, ledger: ledger({ principalFloorUsd: 10_000 }) })),
    250
  );
  // Small profit: 40 * 0.5 = 20
  assert.equal(
    computeSleeveBudget(cfg(), inputs({ equityUsd: 10_040, ledger: ledger({ principalFloorUsd: 10_000 }) })),
    20
  );
  // equity cap dominates: 5000 profit on high equity, cap 10% of 10500=1050, ceiling 250 -> 250
  assert.equal(
    computeSleeveBudget(cfg({ maxMarginUsd: 10_000 }), inputs({ equityUsd: 10_500, ledger: ledger({ principalFloorUsd: 5_500 }) })),
    1050
  );
});

test('halted sleeve deploys nothing regardless of profit', () => {
  const led = ledger({ principalFloorUsd: 10_000, halted: true, haltReason: 'loss ceiling' });
  assert.equal(computeSleeveBudget(cfg(), inputs({ equityUsd: 11_000, ledger: led })), 0);
});

test('disabled sleeve deploys nothing', () => {
  assert.equal(computeSleeveBudget(cfg({ enabled: false }), inputs({ equityUsd: 11_000, ledger: ledger({ principalFloorUsd: 10_000 }) })), 0);
});

test('hedge fires on grid net-long above trigger and is a short', () => {
  // grid long 2000 on 10500 equity = 19% >= 15% trigger.
  const d = decideSleeveAction(cfg(), inputs({ equityUsd: 10_500, ledger: ledger({ principalFloorUsd: 10_000 }), gridNetLongUsd: 2_000 }));
  assert.equal(d.intent, 'hedge');
  assert.equal(d.side, 'short');
  assert.ok(d.marginUsd > 0);
  // Hedge margin is min(budget, gridLong*hedgeRatio) = min(250, 1600) = 250.
  assert.equal(d.marginUsd, 250);
  assert.ok(d.marginUsd <= computeSleeveBudget(cfg(), inputs({ equityUsd: 10_500, ledger: ledger({ principalFloorUsd: 10_000 }), gridNetLongUsd: 2_000 })));
});

test('hedge does not fire below the exposure trigger', () => {
  const d = decideSleeveAction(cfg(), inputs({ equityUsd: 10_500, ledger: ledger({ principalFloorUsd: 10_000 }), gridNetLongUsd: 500 }));
  assert.equal(d.marginUsd, 0);
  assert.match(d.reason, /no action|minimum|profit/);
});

test('overlay is considered only when enabled and no hedge applies', () => {
  const off = decideSleeveAction(cfg(), inputs({ equityUsd: 10_500, ledger: ledger({ principalFloorUsd: 10_000 }), gridNetLongUsd: 0 }));
  assert.equal(off.marginUsd, 0);

  const on = decideSleeveAction(cfg({ overlayEnabled: true }), inputs({ equityUsd: 10_500, ledger: ledger({ principalFloorUsd: 10_000 }), gridNetLongUsd: 0 }));
  assert.equal(on.intent, 'overlay');
  assert.equal(on.side, 'long');
  assert.equal(on.marginUsd, 125); // 250 budget * 0.5 overlay share
});

test('no sane mark price means no action', () => {
  const d = decideSleeveAction(cfg(), inputs({ equityUsd: 10_500, ledger: ledger({ principalFloorUsd: 10_000 }), gridNetLongUsd: 2_000, markPrice: 0 }));
  assert.equal(d.marginUsd, 0);
});

test('stop must sit inside liquidation (the leverage failure mode)', () => {
  // Short entry 100, liq 120 -> 20% adverse. Stop 25% margin / 2x = 12.5% adverse < 20% -> SAFE.
  assert.equal(stopInsideLiquidation('short', 100, 120, 0.25, 2), true);
  // Stop beyond liq: 40% margin / 2x = 20% adverse == 20% liq -> NOT inside.
  assert.equal(stopInsideLiquidation('short', 100, 120, 0.4, 2), false);
  // Long: entry 100, liq 80 -> 20%. 25%/2 = 12.5% -> safe.
  assert.equal(stopInsideLiquidation('long', 100, 80, 0.25, 2), true);
  // Bad inputs fail closed.
  assert.equal(stopInsideLiquidation('short', 0, 120, 0.25, 2), false);
});

test('principal floor seeds once, ratchets up only, and never down', () => {
  const s = freshStore('paper');
  // Seeding with a configured baseline locks that principal in place.
  s.seedFloor(10_000, 9_500);
  assert.equal(s.snapshotLedger().principalFloorUsd, 9_500);
  // Re-seeding is a no-op — the floor is stable.
  s.seedFloor(20_000, 1);
  assert.equal(s.snapshotLedger().principalFloorUsd, 9_500);
  // Raising banks profit into untouchable principal.
  s.raiseFloor(10_500);
  assert.equal(s.snapshotLedger().principalFloorUsd, 10_500);
  // A drawdown must NOT lower the floor, so banked profit cannot be re-risked.
  s.raiseFloor(9_000);
  assert.equal(s.snapshotLedger().principalFloorUsd, 10_500);
});

test('auto-seed uses the first observed equity when no baseline is configured', () => {
  const s = freshStore('paper');
  s.seedFloor(10_000, 0); // 0 => auto-seed
  assert.equal(s.snapshotLedger().principalFloorUsd, 10_000);
});

test('realized loss + loss ceiling halts the sleeve and stops deployment', () => {
  const s = freshStore('paper');
  s.seedFloor(10_000, 10_500);
  s.rollRealized(-80, 2); // breaches -75 ceiling
  assert.ok(s.snapshotLedger().realizedPnlUsd <= -75);
  s.setHalt('realized loss breached ceiling');
  assert.equal(s.snapshotLedger().halted, true);
  assert.equal(
    computeSleeveBudget(cfg(), { equityUsd: 11_000, ledger: s.snapshotLedger(), gridNetLongUsd: 2_000, markPrice: 116 }),
    0
  );
});

test('outstanding margin prevents double-deploying the same profit', () => {
  const led = ledger({ principalFloorUsd: 10_000, outstandingMarginUsd: 250 });
  // 500 profit * 0.5 = 250, but 250 already at work -> 0 available.
  assert.equal(computeSleeveBudget(cfg(), inputs({ equityUsd: 10_500, ledger: led })), 0);
});

test('perps ledger is stored in its own file, separate from the spot book', () => {
  const s = freshStore('live');
  s.seedFloor(12_345, 0);
  const file = path.join(process.env.PERP_STATE_DIR!, 'perps-live.json');
  assert.ok(existsSync(file), 'perps ledger file should exist');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.principalFloorUsd, 12_345);
  // The filename is namespaced perps-<mode>, not state-<mode>.
  assert.match(file, /perps-live\.json$/);
});

test('a venue liquidation price CLOSER than our stop forces a hard reject', () => {  // Long with leverage 3: liquidation at -33% would be far; force it closer.
  // Our stop is 25% of MARGIN = 25/3 = 8.33% adverse price move.
  // A liquidation only 5% away must be rejected (venue would fire first).
  const stopPct = 0.25;
  const lev = 3;
  // entry 100, liquidation 95 (5% away) -> stop needs < 5%, it is 8.33% -> reject.
  assert.equal(stopInsideLiquidation('long', 100, 95, stopPct, lev), false);
  // Healthy venue liquidation 33% away -> accept.
  assert.equal(stopInsideLiquidation('long', 100, 67, stopPct, lev), true);
  // Short side, mirrored.
  assert.equal(stopInsideLiquidation('short', 100, 105, stopPct, lev), false);
  assert.equal(stopInsideLiquidation('short', 100, 133, stopPct, lev), true);
});

test('carry accrues linearly and is 0-safe for non-positive inputs', () => {
  // $10,000 notional, 0.0006%/hr, 24h -> 10000*0.000006*24 = 1.44 USD.
  assert.ok(Math.abs(borrowAccrualUsd(10_000, 0.000006, 24) - 1.44) < 1e-9);
  // Idempotent: same inputs => same output (safe to recompute every tick).
  assert.equal(borrowAccrualUsd(10_000, 0.000006, 24), borrowAccrualUsd(10_000, 0.000006, 24));
  // Negative/NaN inputs must never produce a negative cost.
  assert.equal(borrowAccrualUsd(-5, 0.000006, 24), 0);
  assert.equal(borrowAccrualUsd(10_000, -0.5, 24), 0);
  assert.equal(borrowAccrualUsd(10_000, 0.000006, -1), 0);
});

test('a long-held, flat-price position is stopped by carry alone', () => {
  // 30 days at a flat mark: only borrow accumulates. This must trip the stop
  // even though the price never moved, which the mark-only check would miss.
  const notional = 10_000;
  const stopUsd = 250; // 25% of a $1,000 margin
  const borrow30d = borrowAccrualUsd(notional, 0.000006, 24 * 30); // ~43.2
  assert.ok(borrow30d < stopUsd, 'carry is a slow bleed, not an instant stop');
  // But it is non-zero and grows — the ceiling is no longer blind to it.
  assert.ok(borrow30d > 0);
  const borrow90d = borrowAccrualUsd(notional, 0.000006, 24 * 90);
  assert.ok(borrow90d > borrow30d, 'carry grows with time');
});

test('perps ledger writes atomically (no .tmp left behind, valid JSON)', () => {
  const s = freshStore('live');
  s.seedFloor(9_999, 0);
  const file = path.join(process.env.PERP_STATE_DIR!, 'perps-live.json');
  // No temp artifact may survive a successful save.
  assert.equal(existsSync(`${file}.tmp`), false);
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.principalFloorUsd, 9_999);
});

test('mark feed commits only prints that pass the anomaly gate', async () => {
  const feed = new PerpPriceFeed({ apiUrl: 'https://perps-api.jup.ag/v1', maxSingleJumpPct: 0.15 });
  // First print always accepted (no prior).
  const m1 = await feed.fetch(PERP_MARKETS.SOL);
  assert.ok(m1 && m1.price > 0, 'first fetch should return a live mark');
  assert.equal(feed.healthy(), true);
  assert.equal(feed.lastPrice(), m1!.price);
  // A glitched +50% print is rejected, leaving the last good mark intact.
  const glitch = await feed.fetch(PERP_MARKETS.SOL);
  if (glitch) {
    assert.ok(Math.abs(glitch.price - m1!.price) / m1!.price <= 0.15, 'committed print must be within the jump gate');
  }
});

test('computeSleeveBudget: maxMarginUsd=0 means uncapped, not a $0 ceiling', () => {
  // The fallback sizing path must agree with deployableSleeveUsd: 0 is "no USD
  // ceiling", bounded by the equity cap — not a literal zero-dollar budget.
  const c = cfg({ enabled: true, maxMarginUsd: 0, profitSharePct: 1, maxEquityPct: 0.1 });
  const b = computeSleeveBudget(c, inputs({ equityUsd: 10_500, ledger: ledger({ principalFloorUsd: 10_000 }) }));
  assert.ok(b > 0, 'budget must not collapse to 0 when maxMarginUsd is 0');
  // eligible profit $500, equity cap $1,050 -> the profit term binds.
  assert.ok(Math.abs(b - 500) < 1e-9, `expected 500, got ${b}`);
});

test('hedge sizes margin as notional/leverage — never over-hedges past neutral', () => {
  // With hedgeRatio 0.8 the hedge NOTIONAL must be 0.8x the grid delta, so the
  // MARGIN is 0.8*delta/lev. Sizing the ratio directly as margin would leverage
  // it into 1.6x the delta and flip the book net-short.
  const c = cfg({ enabled: true, profitSharePct: 1, maxEquityPct: 0.5, hedgeRatio: 0.8, hedgeLeverage: 2, hedgeTriggerPct: 0.15, maxLeverage: 3 });
  const gridDelta = 2_000; // 20% of equity -> above the 15% trigger
  const d = decideSleeveAction(c, inputs({
    equityUsd: 10_500,
    ledger: ledger({ principalFloorUsd: 10_000 }),
    gridNetLongUsd: gridDelta,
    deployableMarginUsd: 10_000,
  }));
  assert.equal(d.intent, 'hedge');
  const lev = 2; // hedge uses its own knob, not maxLeverage
  const hedgeNotional = d.marginUsd * lev;
  assert.ok(Math.abs(hedgeNotional - gridDelta * 0.8) < 1e-6, `hedge notional ${hedgeNotional} must equal 0.8*delta`);
  assert.ok(hedgeNotional < gridDelta, 'hedge must not exceed the delta (would become net-short)');
});

test('hedge auto-scales leverage so a PnL-sized budget covers the excess delta', () => {
  // Real-world shape: grid delta (~$5,650) far exceeds the profit-funded budget
  // (~$400). With maxNetExposurePct = 0 the target is the full delta, so
  // auto-scaling must raise the hedge leverage up to hedgeLeverageMax.
  const budget = 400;
  const gridDelta = 5_650;
  const c = cfg({
    enabled: true,
    profitSharePct: 1,
    maxEquityPct: 0.5,
    hedgeRatio: 1.0,
    hedgeLeverage: 1,
    hedgeLeverageMax: 15,
    maxNetExposurePct: 0,
    hedgeTriggerPct: 0.15,
    maxLeverage: 3,
  });
  const d = decideSleeveAction(c, inputs({
    equityUsd: 10_500,
    ledger: ledger({ principalFloorUsd: 10_000 }),
    gridNetLongUsd: gridDelta,
    deployableMarginUsd: budget,
    vol24RangePct: 0.01, // calm market: volatility cap (20.8x) does not bind
  }));
  assert.equal(d.intent, 'hedge');
  // neededLev = 5650/400 = 14.125 -> within [1,15], so notional must hit delta.
  assert.ok(d.lev > 5, `auto-leverage ${d.lev} must exceed a fixed 5x to cover the delta`);
  assert.ok(d.marginUsd <= budget + 1e-9, 'must never post more margin than the budget');
  const notional = d.marginUsd * d.lev;
  assert.ok(Math.abs(notional - gridDelta) < 1e-6, `notional ${notional} must equal the delta ${gridDelta}`);
});

test('hedge TRIMS only the excess above the exposure cap — keeps the strategy upside', () => {
  // This is the "be smart" requirement: we never neutralize the whole bag. With
  // equity 10k and a 35% cap we keep $3,500 net-long and hedge only the excess.
  const equity = 10_000;
  const gridDelta = 6_000; // 60% exposure, well above the 15% hedge trigger
  const capPct = 0.35;
  const capUsd = equity * capPct; // 3,500 kept
  const excess = gridDelta - capUsd; // 2,500 to shed
  const c = cfg({
    enabled: true,
    profitSharePct: 1,
    maxEquityPct: 0.5,
    hedgeRatio: 1.0,
    hedgeLeverage: 1,
    hedgeLeverageMax: 3,
    maxNetExposurePct: capPct,
    hedgeTriggerPct: 0.15,
    maxLeverage: 3,
  });
  const d = decideSleeveAction(c, inputs({
    equityUsd: equity,
    ledger: ledger({ principalFloorUsd: 9_000 }),
    gridNetLongUsd: gridDelta,
    deployableMarginUsd: 5_000, // ample budget
  }));
  assert.equal(d.intent, 'hedge');
  // neededLev = 2500/5000 = 0.5 -> clamped to floor 1, so notional = 2500.
  const notional = d.marginUsd * d.lev;
  assert.ok(Math.abs(notional - excess) < 1e-6, `must hedge exactly the excess ${excess}, not the whole delta`);
  assert.ok(notional < gridDelta, 'must NOT neutralize the entire bag');
  // Post-hedge exposure must land at the cap, not zero.
  const postExposure = (gridDelta - notional) / equity;
  assert.ok(Math.abs(postExposure - capPct) < 1e-9, `post-hedge exposure ${postExposure} must equal the cap ${capPct}`);
  assert.match(d.reason, /trim/);
});

test('hedge is idle when the book is already inside the exposure cap', () => {
  // 20% exposure with a 35% cap -> nothing to trim. The strategy keeps its full
  // upside; we do not spend margin to neutralize exposure we are happy with.
  const c = cfg({
    enabled: true,
    profitSharePct: 1,
    maxEquityPct: 0.5,
    hedgeRatio: 1.0,
    hedgeLeverage: 1,
    hedgeLeverageMax: 3,
    maxNetExposurePct: 0.35,
    hedgeTriggerPct: 0.15,
    maxLeverage: 3,
  });
  const d = decideSleeveAction(c, inputs({
    equityUsd: 10_000,
    ledger: ledger({ principalFloorUsd: 9_000 }),
    gridNetLongUsd: 2_000, // 20% of equity -> inside the cap
    deployableMarginUsd: 5_000,
  }));
  assert.equal(d.marginUsd, 0, 'inside the cap -> no margin spent hedging');
  assert.equal(d.reason.includes('trim'), false, 'no trim should be proposed');
});

test('hedge leverage never exceeds hedgeLeverageMax and reports a partial trim', () => {
  // Excess far too big for the budget even at the ceiling -> trims as much as it
  // can and says 'partial' rather than pretending to be complete.
  const equity = 200_000;
  const c = cfg({
    enabled: true,
    profitSharePct: 1,
    maxEquityPct: 0.5,
    hedgeRatio: 1.0,
    hedgeLeverage: 1,
    hedgeLeverageMax: 10,
    maxNetExposurePct: 0, // full delta is the target here
    hedgeTriggerPct: 0.15,
    maxLeverage: 3,
  });
  const gridDelta = 100_000;
  const d = decideSleeveAction(c, inputs({
    equityUsd: equity,
    ledger: ledger({ principalFloorUsd: 100_000 }),
    gridNetLongUsd: gridDelta,
    deployableMarginUsd: 100,
    vol24RangePct: 0.01, // calm market: volatility cap (20.8x) does not bind here
  }));
  assert.equal(d.intent, 'hedge');
  assert.equal(d.lev, 10, 'leverage must cap exactly at hedgeLeverageMax');
  assert.ok(d.marginUsd * d.lev < gridDelta, 'partial trim must not claim to cover the delta');
  assert.match(d.reason, /partial/);
});

// ---------------------------------------------------------------------------
// SMART LEVERAGE — derived from live market AND bag state, fails safe, never
// hardcoded. The leverage is the product of a volatility survival bound and
// three penalties (bag concentration, market direction, liquidity), so no single
// magic number determines it.
// ---------------------------------------------------------------------------

const ctx = (o: Partial<Parameters<typeof smartLeverage>[0]> = {}) => ({
  stopLossMarginPct: 0.25,
  vol24RangePct: 0.01,
  volMultiplier: 1.2,
  bagExposurePct: 0,
  exposureCapPct: 0.35,
  momentum24HPct: 0,
  volumeUsd: 50_000_000,
  minVolumeUsd: 10_000_000,
  ceilingOverride: 0,
  ...o,
});

test('smartLeverage: calm market, no penalty inputs -> full survival bound (no hardcoded cap)', () => {
  // 1% daily range, 25% stop, survive 1.2x -> 0.25/(1.2*0.01) = 20.83x.
  // ceilingOverride 0 means DERIVE the ceiling: it must equal the survival bound,
  // NOT a hardcoded number like 5.
  const lev = smartLeverage(ctx({ vol24RangePct: 0.01 }));
  assert.ok(Math.abs(lev - 20.8333) < 0.01, `expected ~20.83x derived, got ${lev}`);
});

test('smartLeverage: turbulence forces leverage DOWN autonomously', () => {
  // 12% daily range -> 0.25/(1.2*0.12)=1.74x. The market, not a constant, sets it.
  const lev = smartLeverage(ctx({ vol24RangePct: 0.12 }));
  assert.ok(Math.abs(lev - 1.7361) < 0.01, `expected ~1.74x, got ${lev}`);
});

test('smartLeverage: unknown or extreme volatility fails SAFE at 1x, never guesses big', () => {
  assert.equal(smartLeverage(ctx({ vol24RangePct: 0 })), 1, 'no volatility data -> 1x');
  assert.equal(smartLeverage(ctx({ vol24RangePct: 0.3 })), 1, 'violent market -> 1x floor');
});

test('smartLeverage: bag concentration pulls leverage down — it cannot be ignored', () => {
  // Same calm market, but our book is 70% of equity against a 35% cap. We are
  // concentrated, so the sleeve must take less leverage on top of it.
  const base = smartLeverage(ctx({ vol24RangePct: 0.01, bagExposurePct: 0 }));
  const concentrated = smartLeverage(ctx({ vol24RangePct: 0.01, bagExposurePct: 0.7 }));
  assert.ok(concentrated < base, `concentration must reduce leverage (${concentrated} vs ${base})`);
  // factor = cap/exposure = 0.35/0.7 = 0.5 -> 20.83 * 0.5 = 10.4x
  assert.ok(Math.abs(concentrated - base * 0.5) < 0.1, `expected half of ${base}, got ${concentrated}`);
});

test('smartLeverage: a bag within the cap is NOT penalized (only excess risk counts)', () => {
  const atCap = smartLeverage(ctx({ vol24RangePct: 0.01, bagExposurePct: 0.35 }));
  const underCap = smartLeverage(ctx({ vol24RangePct: 0.01, bagExposurePct: 0.1 }));
  assert.ok(Math.abs(atCap - underCap) < 0.01, 'being under the cap must not change leverage');
});

test('smartLeverage: falling market reduces leverage, rising market does not inflate it', () => {
  const flat = smartLeverage(ctx({ momentum24HPct: 0 }));
  const falling = smartLeverage(ctx({ momentum24HPct: -0.1 }));
  const rising = smartLeverage(ctx({ momentum24HPct: 0.15 }));
  assert.ok(falling < flat, `a down tape must cut leverage (${falling} vs ${flat})`);
  assert.ok(rising <= flat + 1e-9, 'an up tape must never inflate leverage above the bound');
});

test('smartLeverage: thin liquidity reduces leverage, deep liquidity does not', () => {
  const deep = smartLeverage(ctx({ volumeUsd: 50_000_000 }));
  const thin = smartLeverage(ctx({ volumeUsd: 3_000_000 }));
  assert.ok(thin < deep, `thin book must cut leverage (${thin} vs ${deep})`);
});

test('smartLeverage: ceilingOverride pins a policy cap but the market still governs below it', () => {
  // Policy wants <= 5x. In a calm market the derived number would be 20.8x, so
  // the policy cap binds. But in a violent market the market bound must win.
  const calm = smartLeverage(ctx({ vol24RangePct: 0.01, ceilingOverride: 5 }));
  assert.equal(calm, 5, 'policy ceiling must bind in a calm market');
  const violent = smartLeverage(ctx({ vol24RangePct: 0.25, ceilingOverride: 5 }));
  assert.ok(violent < 5, 'the market bound must govern below any policy ceiling');
});

test('smartLeverage never exceeds the derived ceiling, ever', () => {
  for (const vol of [0.005, 0.02, 0.05, 0.12]) {
    for (const ceil of [0, 2, 3, 5, 20]) {
      const v = smartLeverageView(ctx({ vol24RangePct: vol, ceilingOverride: ceil }));
      assert.ok(v.recommended <= v.ceiling + 1e-9, `leverage ${v.recommended} must respect ceiling ${v.ceiling}`);
      assert.ok(v.recommended <= v.survivalBound + 1e-9, 'must never exceed the survival bound');
    }
  }
});

test('smartLeverageView exposes every penalty so the number is never a black box', () => {
  const concentrated = smartLeverageView(
    ctx({ vol24RangePct: 0.01, bagExposurePct: 0.7, momentum24HPct: -0.1, volumeUsd: 3_000_000 })
  );
  assert.ok(concentrated.exposureFactor < 1, 'bag penalty must be reported');
  assert.ok(concentrated.momentumFactor < 1, 'direction penalty must be reported');
  assert.ok(concentrated.liquidityFactor < 1, 'liquidity penalty must be reported');
  assert.ok(concentrated.recommended < concentrated.survivalBound, 'penalties must lower the result');
  assert.match(concentrated.explanation, /bag/);
  assert.match(concentrated.explanation, /market down/);
  assert.match(concentrated.explanation, /thin volume/);

  const clean = smartLeverageView(ctx({ vol24RangePct: 0.01, bagExposurePct: 0 }));
  assert.equal(clean.exposureFactor, 1);
  assert.equal(clean.momentumFactor, 1);
  assert.equal(clean.liquidityFactor, 1);
});

test('smartLeverageView fails safe when market data is missing', () => {
  const v = smartLeverageView(ctx({ vol24RangePct: 0 }));
  assert.equal(v.recommended, 1);
  assert.match(v.explanation, /failing safe/);
});

test('overlay leverage is derived from bag + market, not a static 3x', () => {
  // The bug this replaces: a hardcoded clamp(...,1,3) silently ignored the
  // configured ceiling. Now a calm market with the ceiling raised must reach it.
  const c = cfg({
    enabled: true,
    profitSharePct: 1,
    maxEquityPct: 0.5,
    overlayEnabled: true,
    overlayBudgetPct: 1,
    maxLeverage: 5,
    leverageVolMultiplier: 1.2,
    leverageMinVolumeUsd: 10_000_000,
    maxNetExposurePct: 0,
    hedgeTriggerPct: 1, // disable hedge so the overlay tier is reached
  });
  const calm = decideSleeveAction(c, inputs({
    equityUsd: 10_500,
    ledger: ledger({ principalFloorUsd: 10_000 }),
    gridNetLongUsd: 0,
    deployableMarginUsd: 400,
    vol24RangePct: 0.01,
    volumeUsd: 50_000_000,
  }));
  assert.equal(calm.intent, 'overlay');
  assert.equal(calm.lev, 5, 'calm market must reach the raised ceiling, not a static 3x');

  const turb = decideSleeveAction(c, inputs({
    equityUsd: 10_500,
    ledger: ledger({ principalFloorUsd: 10_000 }),
    gridNetLongUsd: 0,
    deployableMarginUsd: 400,
    vol24RangePct: 0.12,
    volumeUsd: 50_000_000,
  }));
  assert.equal(turb.intent, 'overlay');
  assert.ok(turb.lev < 5, `turbulence must pull the overlay leverage down (got ${turb.lev})`);
  assert.match(turb.reason, /overlay/);

  // Thin liquidity must reduce it further, proving the market feed is live-wired.
  // Use a higher-vol context so the survival bound (4.17x) sits below the policy
  // ceiling, letting the liquidity penalty actually show through.
  const deep = decideSleeveAction(c, inputs({
    equityUsd: 10_500,
    ledger: ledger({ principalFloorUsd: 10_000 }),
    gridNetLongUsd: 0,
    deployableMarginUsd: 400,
    vol24RangePct: 0.05,
    volumeUsd: 50_000_000,
  }));
  const thin = decideSleeveAction(c, inputs({
    equityUsd: 10_500,
    ledger: ledger({ principalFloorUsd: 10_000 }),
    gridNetLongUsd: 0,
    deployableMarginUsd: 400,
    vol24RangePct: 0.05,
    volumeUsd: 1_000_000,
  }));
  assert.ok(thin.lev < deep.lev, `thin liquidity must cut overlay leverage (${thin.lev} vs ${deep.lev})`);
});

test('hedge leverage is capped by the same bag+market model, not just hedgeLeverageMax', () => {
  // Even with hedgeLeverageMax raised, a turbulent market must pull the effective
  // hedge leverage down to something our stop can survive.
  const c = cfg({
    enabled: true,
    profitSharePct: 1,
    maxEquityPct: 0.5,
    hedgeRatio: 1.0,
    hedgeLeverage: 1,
    hedgeLeverageMax: 15,
    leverageVolMultiplier: 1.2,
    maxNetExposurePct: 0,
    hedgeTriggerPct: 0.15,
    maxLeverage: 5,
  });
  const d = decideSleeveAction(c, inputs({
    equityUsd: 10_500,
    ledger: ledger({ principalFloorUsd: 10_000 }),
    gridNetLongUsd: 5_000,
    deployableMarginUsd: 100,
    vol24RangePct: 0.12, // turbulent -> survival bound ~1.74x
    volumeUsd: 50_000_000,
  }));
  assert.equal(d.intent, 'hedge');
  assert.ok(d.lev <= 1.7400, `hedge leverage ${d.lev} must respect the market survival bound`);
});

test('hedge leverage drops when our bag is over-concentrated', () => {
  const c = cfg({
    enabled: true,
    profitSharePct: 1,
    maxEquityPct: 0.5,
    hedgeRatio: 1.0,
    hedgeLeverage: 1,
    hedgeLeverageMax: 15,
    leverageVolMultiplier: 1.2,
    maxNetExposurePct: 0.35,
    hedgeTriggerPct: 0.15,
    maxLeverage: 5,
  });
  // Book is 80% of equity -> far over the 35% cap, so the bag penalty binds.
  const d = decideSleeveAction(c, inputs({
    equityUsd: 10_000,
    ledger: ledger({ principalFloorUsd: 9_000 }),
    gridNetLongUsd: 8_000,
    deployableMarginUsd: 5_000,
    vol24RangePct: 0.01,
    volumeUsd: 50_000_000,
  }));
  assert.equal(d.intent, 'hedge');
  // survival 20.83x, bag factor 0.35/0.8=0.4375 -> ~9.1x, still under hedgeLeverageMax 15.
  assert.ok(d.lev < 15, `concentration must pull hedge leverage below the ceiling (got ${d.lev})`);
  assert.ok(d.lev < 20, 'must not exceed the survival bound');
});

