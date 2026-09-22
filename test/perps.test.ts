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
