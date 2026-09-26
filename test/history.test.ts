import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollupDay } from '../src/history.js';
import type { Trade } from '../src/types.js';

function t(ts: number, strategyId: 'grid' | 'dca' | 'memes', direction: 'BUY' | 'SELL', overrides: Partial<Trade> = {}): Trade {
  return {
    id: `t${ts}-${strategyId}-${direction}-${Math.random()}`,
    ts,
    strategyId,
    direction,
    price: 104,
    baseQty: 1,
    quoteQty: 104,
    feeUsd: 0.05,
    ...overrides,
  } as Trade;
}

const DAY = '2026-09-18T12:00:00Z';

test('rollupDay aggregates only grid+dca (memes excluded)', () => {
  const ts = Date.parse(DAY);
  const rows = rollupDay('2026-09-18', [
    t(ts, 'grid', 'SELL', { realizedPnlUsd: 2, feeUsd: 0.1 }),
    t(ts, 'dca', 'SELL', { realizedPnlUsd: -1, feeUsd: 0.2 }),
    t(ts, 'memes', 'SELL', { realizedPnlUsd: 100, feeUsd: 5 }), // must be ignored
    t(ts, 'grid', 'BUY', { feeUsd: 0.1 }),
  ]);
  assert.equal(rows.fills, 3, 'meme fill excluded');
  assert.ok(Math.abs(rows.realizedUsd - 1) < 1e-9, 'only grid+dca realized counted');
  assert.ok(Math.abs(rows.feesUsd - 0.4) < 1e-9);
  assert.ok(Math.abs(rows.netUsd - 0.6) < 1e-9);
  assert.equal(rows.roundTrips, 2);
  assert.equal(rows.noData, false);
});

test('rollupDay marks an idle day noData (not a misleading zero)', () => {
  const rows = rollupDay('2026-09-15', []);
  assert.equal(rows.fills, 0);
  assert.equal(rows.noData, true);
  assert.equal(rows.netUsd, 0);
});

test('rollupDay computes win rate, averages, and profit factor', () => {
  const ts = Date.parse(DAY);
  const rows = rollupDay('2026-09-18', [
    t(ts, 'grid', 'SELL', { realizedPnlUsd: 3 }),
    t(ts, 'grid', 'SELL', { realizedPnlUsd: 1 }),
    t(ts, 'dca', 'SELL', { realizedPnlUsd: -2 }),
  ]);
  assert.equal(rows.winRate, 2 / 3);
  assert.ok(Math.abs(rows.avgWinUsd - 2) < 1e-9);
  assert.ok(Math.abs(rows.avgLossUsd + 2) < 1e-9);
  assert.ok(Math.abs(rows.profitFactor! - 2) < 1e-9, 'PF = 4/2');
});

test('rollupDay with no losing sells reports PF null (shown as infinity)', () => {
  const ts = Date.parse(DAY);
  const rows = rollupDay('2026-09-18', [t(ts, 'grid', 'SELL', { realizedPnlUsd: 5 })]);
  assert.equal(rows.profitFactor, null);
  assert.equal(rows.winRate, 1);
});

test('rollupDay skips trades from other days', () => {
  const ts = Date.parse(DAY);
  const other = ts - 48 * 3600e3;
  const rows = rollupDay('2026-09-18', [
    t(ts, 'grid', 'SELL', { realizedPnlUsd: 4 }),
    t(other, 'grid', 'SELL', { realizedPnlUsd: 999 }),
  ]);
  assert.ok(Math.abs(rows.realizedUsd - 4) < 1e-9);
  assert.equal(rows.fills, 1);
});

test('EOD price: last-fill fallback marks the day when no price sample exists', () => {
  // The History tab's price column regressed to permanent '-' because nothing
  // ever wrote priceEod. Journal-rebuilt days must fall back to the LAST FILL
  // price — a real execution, not a fabricated mark.
  const early = Date.parse('2026-09-18T01:00:00Z');
  const late = Date.parse('2026-09-18T23:00:00Z');
    const rows = rollupDay('2026-09-18', [
      t(early, 'grid', 'SELL', { price: 100, realizedPnlUsd: 1 }),
      t(late, 'grid', 'BUY', { price: 119.5 }),
    ]);
    assert.equal(rows.priceEod, 119.5, 'EOD price = last fill of the day');
    assert.equal(rows.source, 'journal');
});
