// ---------------------------------------------------------------------------
// Perps × grid/DCA coordination — hedge the exposure we are ABOUT TO hold
// ---------------------------------------------------------------------------
// The sleeve previously sized only against TODAY's grid/dca net-long. A crash
// fills armed grid levels and scheduled DCA buys INTO the decline, so the newly
// accumulated SOL was unhedged until the next re-size — the hedge perpetually
// lagged the dip. decideSleeveAction now accepts `plannedAccumUsd` (the pending
// spot accumulation) and targets actual + planned. These tests pin that:
//   - planned accumulation RAISES the hedgeable exposure and the trim notional,
//   - zero planned accumulation preserves the old reactive behaviour exactly,
//   - the inert case (no exposure, nothing planned) stays idle.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSleeveAction, type PerpSleeveConfig, type SleeveInputs } from '../src/perpStrategy.js';
import type { PerpLedger } from '../src/perpStore.js';

const led = (o: Partial<PerpLedger> = {}): PerpLedger => ({
  enabled: true, halted: false, haltReason: '', principalFloorUsd: 0,
  peakEquityUsd: 20_000, outstandingMarginUsd: 0, position: null,
  realizedPnlUsd: 0, lifetimeRealizedUsd: 1_000, openedAt: 0, lastTickAt: Date.now(),
  ...o,
} as PerpLedger);

const cfg = (o: Partial<PerpSleeveConfig> = {}): PerpSleeveConfig => ({
  enabled: true, profitSharePct: 1, realizedProfitUsePct: 1, cashUsePct: 1,
  profitWindowHours: 168, minFillsForConfidence: 1, openFeePct: 0.0006,
  hourlyBorrowPct: 0.000006, maxEquityPct: 1, maxMarginUsd: 0, maxLeverage: 6,
  hedgeRatio: 1, hedgeTriggerPct: 0.15, stopLossMarginPct: 0.25, maxLossUsd: 100,
  overlayEnabled: false, overlayBudgetPct: 0.5, baselineEquityUsd: 0,
  maxNetExposurePct: 0.35, hedgeLeverage: 1, hedgeLeverageMax: 3,
  hedgeTakeProfitPct: 0.25, hedgeTakeProfitMaxPct: 0.6,
  ...o,
} as PerpSleeveConfig);

const baseInputs = (o: Partial<SleeveInputs> = {}): SleeveInputs => ({
  equityUsd: 10_000,
  ledger: led(),
  gridNetLongUsd: 5_000, // 50% of equity — over the 35% cap
  markPrice: 115,
  deployableMarginUsd: 500,
  ...o,
});

test('coordination: planned spot buys raise the hedgeable exposure', () => {
  // Budget generous enough not to be the binding constraint, so the difference
  // reflects the planned notional rather than a cap.
  const d0 = decideSleeveAction(cfg(), baseInputs({ plannedAccumUsd: 0, deployableMarginUsd: 5_000 }));
  const d1 = decideSleeveAction(cfg(), baseInputs({ plannedAccumUsd: 1_000, deployableMarginUsd: 5_000 }));
  assert.equal(d0.intent, 'hedge');
  assert.equal(d1.intent, 'hedge');
  // The trim target must grow by the planned notional (hedgeRatio = 1), so the
  // margin/leverage combination covers MORE than without anticipation.
  assert.ok(d1.marginUsd * d1.lev > d0.marginUsd * d0.lev, 'planned buys must enlarge the hedge');
});

test('coordination: zero planned accumulation preserves reactive behaviour', () => {
  const withZero = decideSleeveAction(cfg(), baseInputs({ plannedAccumUsd: 0 }));
  const omitted = decideSleeveAction(cfg(), baseInputs());
  assert.deepEqual(
    { m: withZero.marginUsd, l: withZero.lev, r: withZero.reason },
    { m: omitted.marginUsd, l: omitted.lev, r: omitted.reason }
  );
});

test('coordination: reason text discloses the included planned buys', () => {
  const d = decideSleeveAction(cfg(), baseInputs({ plannedAccumUsd: 1_000 }));
  assert.match(d.reason, /planned grid\/DCA buys/);
});

test('coordination: planned buys alone can arm a hedge when current bag is under the cap', () => {
  // Bag at 20% of equity (under the 35% cap) yields zero excess — idle. But a
  // large scheduled accumulation pushes hedgeable exposure over the cap, so the
  // hedge arms BEFORE the dip buys fill, not after.
  const quiet = decideSleeveAction(
    cfg(),
    baseInputs({ gridNetLongUsd: 2_000, plannedAccumUsd: 0, deployableMarginUsd: 500 })
  );
  const amidDip = decideSleeveAction(
    cfg(),
    baseInputs({ gridNetLongUsd: 2_000, plannedAccumUsd: 2_000, deployableMarginUsd: 500 })
  );
  assert.equal(quiet.intent, 'hedge');
  assert.equal(quiet.marginUsd, 0, 'nothing over the cap -> no hedge yet');
  assert.equal(amidDip.intent, 'hedge');
  assert.ok(amidDip.marginUsd > 0, 'planned accumulation alone must arm the hedge');
});

test('coordination: idle when there is no exposure and nothing planned', () => {
  const d = decideSleeveAction(
    cfg(),
    baseInputs({ gridNetLongUsd: 0, plannedAccumUsd: 0, deployableMarginUsd: 500 })
  );
  assert.equal(d.marginUsd, 0);
});

test('coordination: no budget means no hedge even with planned accumulation', () => {
  const d = decideSleeveAction(
    cfg(),
    baseInputs({ plannedAccumUsd: 2_000, deployableMarginUsd: 0 })
  );
  assert.equal(d.marginUsd, 0);
  assert.match(d.reason, /profit/);
});
