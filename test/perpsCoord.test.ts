import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSleeveAction, type PerpSleeveConfig, type SleeveInputs } from '../src/perpStrategy.js';
import type { PerpLedger } from '../src/perpStore.js';

const now = Date.now();
const led = (o: Partial<PerpLedger> = {}): PerpLedger => ({
  enabled: true, halted: false, haltReason: '', principalFloorUsd: 10_000,
  peakEquityUsd: 20_000, outstandingMarginUsd: 0, position: null,
  realizedPnlUsd: 0, lifetimeRealizedUsd: 500, openedAt: 0, lastTickAt: now,
  ...o,
} as PerpLedger);

const baseCfg = (o: Partial<PerpSleeveConfig> = {}): PerpSleeveConfig => ({
  enabled: true, profitSharePct: 1, realizedProfitUsePct: 1, cashUsePct: 1,
  profitWindowHours: 168, minFillsForConfidence: 1, openFeePct: 0.0006,
  hourlyBorrowPct: 0.000006, maxEquityPct: 1, maxMarginUsd: 0, maxLeverage: 6,
  hedgeRatio: 1, hedgeTriggerPct: 0, stopLossMarginPct: 0.25, maxLossUsd: 100,
  overlayEnabled: false, overlayBudgetPct: 0.5, baselineEquityUsd: 10_000,
  maxNetExposurePct: 0.35, ...o,
} as PerpSleeveConfig);

const inputs = (o: Partial<SleeveInputs> = {}): SleeveInputs => ({
  equityUsd: 20_000, ledger: led(), gridNetLongUsd: 20_000, markPrice: 200,
  vol24RangePct: 0.04, momentum24HPct: 0, volumeUsd: 5e9,
  ...o,
} as SleeveInputs);

test('short-only guard: overlay configured long is refused while shortOnly=true', () => {
  const cfg = baseCfg({ overlayEnabled: true, overlaySide: 'long', shortOnly: true });
  const d = decideSleeveAction(cfg, inputs());
  // With no excess to trim (cap 35% of 20k = 7k, long 20k => excess 13k exists),
  // the trim may fire first; force a no-excess book so the overlay branch is hit.
  const d2 = decideSleeveAction(cfg, inputs({ gridNetLongUsd: 0 }));
  assert.notEqual(d2.intent, 'overlay');
  assert.match(d2.reason, /shortOnly/);
});

test('short-only guard off allows the long overlay through', () => {
  const cfg = baseCfg({ overlayEnabled: true, overlaySide: 'long', shortOnly: false });
  const d = decideSleeveAction(cfg, inputs({ gridNetLongUsd: 0 }));
  assert.equal(d.intent, 'overlay');
  assert.equal(d.side, 'long');
});

test('default direction is short: overlay with defaults never longs', () => {
  const cfg = baseCfg({ overlayEnabled: true }); // no overlaySide => 'short'
  const d = decideSleeveAction(cfg, inputs({ gridNetLongUsd: 0 }));
  assert.equal(d.intent, 'overlay');
  assert.equal(d.side, 'short');
});
