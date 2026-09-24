// ---------------------------------------------------------------------------
// Price-feed hardening — smart bad-data handling
// ---------------------------------------------------------------------------
// The bot leaned on a single 5% jump gate to reject garbage, which (a) froze the
// feed on a GENUINE sharp move and (b) trusted any one fallback source blindly.
// These tests pin the two new behaviours:
//   1) classifyPrice labels WHY a print is suspicious (so a recurring anomaly can
//      be promoted to a real move instead of being rejected forever), and
//   2) corroboratedMedian discards a lone outlier when independent sources can
//      vouch for each other, and refuses to commit a single unverified number.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPrice, corroboratedMedian } from '../src/price.js';

test('classifyPrice: clean print is ok', () => {
  assert.equal(classifyPrice({ p: 115, prev: 114, maxSingleJumpPct: 0.15 }), 'ok');
});

test('classifyPrice: flags a >max jump as single-jump (not silently ok)', () => {
  assert.equal(classifyPrice({ p: 70, prev: 114, maxSingleJumpPct: 0.15 }), 'single-jump');
});

test('classifyPrice: non-positive is distinct from a jump', () => {
  assert.equal(classifyPrice({ p: 0, prev: 114, maxSingleJumpPct: 0.15 }), 'non-positive');
  assert.equal(classifyPrice({ p: -3, prev: 114, maxSingleJumpPct: 0.15 }), 'non-positive');
});

test('classifyPrice: far outside traded range is labeled outside-range', () => {
  assert.equal(
    classifyPrice({ p: 900, prev: 0, maxSingleJumpPct: 0.15, historyHigh: 120, historyLow: 100 }),
    'outside-range'
  );
});

test('corroboratedMedian: two independent sources that agree yield their median', () => {
  const r = corroboratedMedian(
    [
      { source: 'binance', price: 114.0 },
      { source: 'coinbase', price: 114.2 },
    ],
    0.01,
    2
  );
  assert.ok(r);
  assert.equal(r.sources.length, 2);
  assert.ok(r.price > 113.9 && r.price < 114.3);
});

test('corroboratedMedian: a lone outlier is discarded, not averaged in', () => {
  const r = corroboratedMedian(
    [
      { source: 'binance', price: 114.0 },
      { source: 'coinbase', price: 114.2 },
      { source: 'jupiter', price: 10.34 }, // the classic bad print
    ],
    0.01,
    2
  );
  assert.ok(r);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].source, 'jupiter');
  assert.ok(r.price > 113.9 && r.price < 114.3);
});

test('corroboratedMedian: a single unverified source is NOT committed', () => {
  const r = corroboratedMedian([{ source: 'binance', price: 114.0 }], 0.01, 2);
  assert.equal(r, null);
});

test('corroboratedMedian: all-disagreeing sources yield null (never trust a lone number)', () => {
  const r = corroboratedMedian(
    [
      { source: 'binance', price: 100 },
      { source: 'coinbase', price: 150 },
    ],
    0.01,
    2
  );
  assert.equal(r, null);
});

test('corroboratedMedian: ignores non-positive and NaN prints entirely', () => {
  const r = corroboratedMedian(
    [
      { source: 'binance', price: 114.0 },
      { source: 'coinbase', price: 114.2 },
      { source: 'jupiter', price: 0 },
      { source: 'gecko', price: NaN },
    ],
    0.01,
    2
  );
  assert.ok(r);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.sources.length, 2);
});
