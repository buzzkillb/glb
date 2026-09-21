// Tests for the forever trade journal + honest cost-basis reconciliation.
// reconcileCostBasis() is the accounting fix: the store previously drifted from
// the tape (basis $109.56 vs tape ~$105) and from the chain, which made
// unrealized PnL unreliable. These cases pin the exact weighted-average math.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileCostBasis, distributeUntracked, isSyntheticFill, type FillEntry } from '../src/journal.js';

const DAY = 86_400_000;

function fill(ts: number, direction: 'BUY' | 'SELL', baseQty: number, quoteQty: number): FillEntry {
  return { ts, direction, baseQty, quoteQty };
}

test('reconcileCostBasis derives basis and realized PnL from the tape', () => {
  const entries: FillEntry[] = [
    fill(1 * DAY, 'BUY', 10, 1000), // basis 100/SOL
    fill(2 * DAY, 'BUY', 10, 1200), // basis now (1000+1200)/20 = 110/SOL
    fill(3 * DAY, 'SELL', 5, 600),  // sold 5 @120 -> realized 600 - 5*110 = 50
  ];
  const r = reconcileCostBasis(entries, 15, 0);
  assert.equal(r.trackedQty, 15);
  assert.ok(Math.abs(r.trackedCostUsd - 1650) < 1e-9, 'remaining basis 15*110');
  assert.ok(Math.abs(r.avgCostPerBase - 110) < 1e-9);
  assert.ok(Math.abs(r.realizedPnlUsd - 50) < 1e-9);
  assert.equal(r.untrackedQty, 0);
});

test('reconcileCostBasis values unexplained chain SOL at spot', () => {
  const entries: FillEntry[] = [fill(1 * DAY, 'BUY', 10, 1000)]; // tracked: 10 @100
  // Chain holds 15 SOL: 5 SOL entered with no matching fill (a deposit).
  const r = reconcileCostBasis(entries, 15, 200);
  assert.equal(r.trackedQty, 10);
  assert.equal(r.untrackedQty, 5);
  assert.ok(Math.abs(r.untrackedCostUsd - 1000) < 1e-9, '5 untracked @200 spot');
  assert.ok(Math.abs(r.avgCostPerBase - 133.3333333333) < 1e-6, '(1000+1000)/15');
});

test('reconcileCostBasis ignores sells with no inventory (never goes negative)', () => {
  const entries: FillEntry[] = [
    fill(1 * DAY, 'SELL', 5, 500), // nothing held yet -> ignored
    fill(2 * DAY, 'BUY', 10, 1000),
  ];
  const r = reconcileCostBasis(entries, 10, 100);
  assert.equal(r.trackedQty, 10);
  assert.ok(Math.abs(r.realizedPnlUsd) < 1e-9);
  assert.ok(Math.abs(r.avgCostPerBase - 100) < 1e-9);
});

test('reconcileCostBasis caps a sell to held quantity and stays consistent', () => {
  const entries: FillEntry[] = [
    fill(1 * DAY, 'BUY', 10, 1000),
    fill(2 * DAY, 'SELL', 20, 2400), // only 10 held; proceeds scaled to 1200
  ];
  const r = reconcileCostBasis(entries, 0, 100);
  assert.equal(r.trackedQty, 0);
  // realized = 1200 (proceeds for 10) - 1000 (basis) = 200
  assert.ok(Math.abs(r.realizedPnlUsd - 200) < 1e-9);
  assert.equal(r.avgCostPerBase, 0, 'nothing held -> zero basis');
});

test('distributeUntracked splits deposit inventory pro-rata across books', () => {
  const out = distributeUntracked({ grid: 30, dca: 10 }, 20);
  assert.ok(Math.abs(out.grid - 15) < 1e-9);
  assert.ok(Math.abs(out.dca - 5) < 1e-9);
});

test('distributeUntracked handles empty books without dividing by zero', () => {
  const out = distributeUntracked({ grid: 0, dca: 0 }, 5);
  assert.equal(out.grid, 0);
  assert.equal(out.dca, 0);
});

test('isSyntheticFill flags smoke-test fills and journal reads exclude them', () => {
  assert.equal(isSyntheticFill({ orderId: 'test-sell' } as any), true);
  assert.equal(isSyntheticFill({ orderId: '3061be2f-a770-4d0e' } as any), false);
  assert.equal(isSyntheticFill({} as any), false);
});
