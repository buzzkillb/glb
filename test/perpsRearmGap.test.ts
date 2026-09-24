// ---------------------------------------------------------------------------
// Post-close re-arm: close the cooldown gap ONLY for genuinely new exposure
// ---------------------------------------------------------------------------
// After a winning hedge banks, the re-arm cooldown starts. A dip can then fill
// fresh grid/DCA buys the closed hedge no longer covers — leaving real inventory
// unhedged until the cooldown lapses. rearmJustifiedByNewExposure lets the sleeve
// re-arm immediately when NEW unhedged exposure has appeared, while still
// blocking fee-churn re-entry at the same/no exposure.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { rearmJustifiedByNewExposure, rearmCooldownElapsed } from '../src/perpStrategy.js';

test('re-arm: no new exposure keeps the cooldown (same bag, no churn)', () => {
  assert.equal(rearmJustifiedByNewExposure(5_000, 5_000, 25), false);
});

test('re-arm: less exposure than at close never re-arms early', () => {
  assert.equal(rearmJustifiedByNewExposure(4_800, 5_000, 25), false);
});

test('re-arm: real NEW exposure inside the cooldown re-arms immediately', () => {
  assert.equal(rearmJustifiedByNewExposure(5_100, 5_000, 25), true);
});

test('re-arm: exactly at the minimum threshold is enough', () => {
  assert.equal(rearmJustifiedByNewExposure(5_025, 5_000, 25), true);
});

test('re-arm: just below the threshold waits (noise is not a dip-fill)', () => {
  assert.equal(rearmJustifiedByNewExposure(5_020, 5_000, 25), false);
});

test('re-arm: disabled (threshold 0) never re-arms early', () => {
  assert.equal(rearmJustifiedByNewExposure(9_000, 5_000, 0), false);
});

test('re-arm: a first-ever close with no prior exposure record re-arms on any new bag', () => {
  assert.equal(rearmJustifiedByNewExposure(1_000, 0, 25), true);
});

test('cooldown: still elapses normally on the clock (unchanged behavior)', () => {
  const now = 10_000_000;
  assert.equal(rearmCooldownElapsed(now, now - 60_000, 30), false, '1 min into 30 -> blocked');
  assert.equal(rearmCooldownElapsed(now, now - 31 * 60_000, 30), true, '31 min into 30 -> elapsed');
});

test('cooldown: zero/undefined cooldown always allows entry', () => {
  assert.equal(rearmCooldownElapsed(5_000, 4_999, 0), true);
  assert.equal(rearmCooldownElapsed(5_000, 4_999, undefined), true);
});
