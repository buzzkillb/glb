import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLevers, DEFAULT_DYNAMIC_LEVERS, feeFloorFraction } from '../src/regime.js';

// The dynamic lever engine must NEVER invent a number. These tests pin the two
// hard requirements: (1) it derives from live inputs, (2) it fails SAFE (usable
// =false) rather than guessing when a required live input is missing.

const base = {
  volPct: 3, // PERCENT — e.g. a 3% realized range
  momentum24HPct: 0,
  volumeUsd: 50_000_000,
  feeFloorPct: 0.08, // PERCENT — broker round-trip fee floor
  equityUsd: 10_000,
  freeCashUsd: 10_000, // fully liquid, so the profit-share cap doesn't bind
  realizedProfitUsd: 500,
};

test('dynamic levers: fails safe when volatility is unknown (never guesses)', () => {
  const d = deriveLevers(DEFAULT_DYNAMIC_LEVERS, { ...base, volPct: 0 });
  assert.equal(d.usable, false);
});

test('dynamic levers: fails safe when the fee floor is unknown', () => {
  const d = deriveLevers(DEFAULT_DYNAMIC_LEVERS, { ...base, feeFloorPct: 0 });
  assert.equal(d.usable, false);
});

test('dynamic levers: disabled returns unusable so strategies keep baseline', () => {
  const d = deriveLevers({ ...DEFAULT_DYNAMIC_LEVERS, enabled: false }, base);
  assert.equal(d.usable, false);
});

test('dynamic levers: TP must clear the live fee floor by the policy multiple', () => {
  const d = deriveLevers(DEFAULT_DYNAMIC_LEVERS, {
    ...base,
    volPct: 0.01, // tiny tape -> volatility term negligible
    feeFloorPct: 1, // 1% round-trip fee floor
  });
  assert.equal(d.usable, true);
  // fee 1% * policy mult 3 = 3% minimum, and vol capture is far smaller.
  assert.ok(d.dcaTakeProfitPct >= 3, `expected >= 3, got ${d.dcaTakeProfitPct}`);
});

test('dynamic levers: TP rises with the live volatility range', () => {
  const calm = deriveLevers(DEFAULT_DYNAMIC_LEVERS, { ...base, volPct: 1, feeFloorPct: 0.05 });
  const wild = deriveLevers(DEFAULT_DYNAMIC_LEVERS, { ...base, volPct: 10, feeFloorPct: 0.05 });
  assert.ok(wild.dcaTakeProfitPct > calm.dcaTakeProfitPct);
});

test('dynamic levers: trail widens with volatility, tightens when calm', () => {
  const calm = deriveLevers(DEFAULT_DYNAMIC_LEVERS, { ...base, volPct: 1 });
  const wild = deriveLevers(DEFAULT_DYNAMIC_LEVERS, { ...base, volPct: 9 });
  assert.ok(wild.dcaTrailingPct > calm.dcaTrailingPct);
});

test('dynamic levers: perps margin share shrinks as volatility rises', () => {
  const calm = deriveLevers(DEFAULT_DYNAMIC_LEVERS, { ...base, volPct: 1 });
  const wild = deriveLevers(DEFAULT_DYNAMIC_LEVERS, { ...base, volPct: 15 });
  assert.ok(wild.perpsMaxEquityPct < calm.perpsMaxEquityPct);
});

test('dynamic levers: perps profit share grows on a falling tape', () => {
  const flat = deriveLevers(DEFAULT_DYNAMIC_LEVERS, { ...base, momentum24HPct: 0 });
  const falling = deriveLevers(DEFAULT_DYNAMIC_LEVERS, { ...base, momentum24HPct: -0.2 });
  assert.ok(falling.perpsProfitSharePct > flat.perpsProfitSharePct);
});

test('dynamic levers: profit share capped by free cash actually on hand', () => {
  // Same falling tape, but almost all equity is tied up in spot: you cannot
  // post profit you do not hold as settled cash.
  const liquid = deriveLevers(DEFAULT_DYNAMIC_LEVERS, {
    ...base,
    momentum24HPct: -0.2,
    freeCashUsd: 10_000,
  });
  const illiquid = deriveLevers(DEFAULT_DYNAMIC_LEVERS, {
    ...base,
    momentum24HPct: -0.2,
    freeCashUsd: 500,
    equityUsd: 10_000,
  });
  assert.ok(illiquid.perpsProfitSharePct <= liquid.perpsProfitSharePct);
});

test('dynamic levers: hedge-leverage ceiling cuts down in a thin book', () => {
  const deep = deriveLevers(DEFAULT_DYNAMIC_LEVERS, { ...base, volumeUsd: 200_000_000 });
  const thin = deriveLevers(DEFAULT_DYNAMIC_LEVERS, { ...base, volumeUsd: 2_500_000 });
  assert.ok(thin.perpsHedgeLeverageMax < deep.perpsHedgeLeverageMax);
  assert.ok(thin.perpsHedgeLeverageMax >= 1, 'never below 1x');
});

test('dynamic levers: compounding grows with realized-profit ratio', () => {
  const small = deriveLevers(DEFAULT_DYNAMIC_LEVERS, { ...base, realizedProfitUsd: 100 });
  const large = deriveLevers(DEFAULT_DYNAMIC_LEVERS, { ...base, realizedProfitUsd: 5_000 });
  assert.ok(large.gridCompoundPct >= small.gridCompoundPct);
});

test('dynamic levers: every lever stays inside its configured policy bounds', () => {
  for (const volPct of [0.1, 1, 5, 50, 100]) {
    const d = deriveLevers(DEFAULT_DYNAMIC_LEVERS, { ...base, volPct });
    assert.ok(d.usable);
    assert.ok(d.dcaTakeProfitPct >= DEFAULT_DYNAMIC_LEVERS.dcaTpMinPct);
    assert.ok(d.dcaTakeProfitPct <= DEFAULT_DYNAMIC_LEVERS.dcaTpMaxPct);
    assert.ok(d.dcaTrailingPct >= DEFAULT_DYNAMIC_LEVERS.dcaTrailMinPct);
    assert.ok(d.dcaTrailingPct <= DEFAULT_DYNAMIC_LEVERS.dcaTrailMaxPct);
    assert.ok(d.gridCompoundPct >= 0);
    assert.ok(d.gridCompoundPct <= DEFAULT_DYNAMIC_LEVERS.gridCompoundMaxPct);
    assert.ok(d.perpsMaxEquityPct >= DEFAULT_DYNAMIC_LEVERS.perpsEquityMinPct);
    assert.ok(d.perpsMaxEquityPct <= DEFAULT_DYNAMIC_LEVERS.perpsEquityMaxPct);
    assert.ok(d.perpsProfitSharePct >= DEFAULT_DYNAMIC_LEVERS.perpsProfitShareMinPct);
    assert.ok(d.perpsProfitSharePct <= DEFAULT_DYNAMIC_LEVERS.perpsProfitShareMaxPct);
    assert.ok(d.perpsHedgeLeverageMax >= 1);
    assert.ok(d.perpsHedgeLeverageMax <= DEFAULT_DYNAMIC_LEVERS.perpsHedgeLeverageMaxCap);
  }
});

test('feeFloorFraction returns a real PERCENT, 0 when inputs are unknown', () => {
  assert.equal(feeFloorFraction(0.1, 100), 0.1); // $0.10 on $100 = 0.1%
  assert.equal(feeFloorFraction(0, 100), 0);
  assert.equal(feeFloorFraction(0.1, 0), 0);
});
