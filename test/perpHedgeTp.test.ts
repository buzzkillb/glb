import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hedgeTakeProfitHit, rearmCooldownElapsed } from '../src/perpStrategy.js';

/**
 * HEDGE TAKE-PROFIT + RE-ARM COOLDOWN.
 *
 * The hedge short must actually BANK money when the market falls, otherwise the
 * sleeve can only ever protect and never realise a profit — dead weight. These
 * tests pin the take-profit rule (banked once a % of posted margin is earned),
 * that it can be disabled, and that a re-arm cooldown prevents fee churn from
 * immediately re-opening a hedge at the same mark.
 */

test('hedge take-profit fires once net PnL reaches the % of posted margin', () => {
  // 25% of a $200 margin = $50 profit target.
  assert.equal(hedgeTakeProfitHit(49.99, 200, 0.25), false);
  assert.equal(hedgeTakeProfitHit(50, 200, 0.25), true);
  assert.equal(hedgeTakeProfitHit(75, 200, 0.25), true);
});

test('hedge take-profit does NOT fire while the hedge is losing', () => {
  assert.equal(hedgeTakeProfitHit(-30, 200, 0.25), false);
  assert.equal(hedgeTakeProfitHit(0, 200, 0.25), false);
});

test('hedgeTakeProfitPct = 0 (or undefined) disables take-profit entirely', () => {
  assert.equal(hedgeTakeProfitHit(1e6, 200, 0), false);
  assert.equal(hedgeTakeProfitHit(1e6, 200, undefined), false);
});

test('hedge take-profit scales with the posted margin, not a fixed USD number', () => {
  // Same % of a larger margin needs a larger absolute profit.
  assert.equal(hedgeTakeProfitHit(50, 400, 0.25), false);
  assert.equal(hedgeTakeProfitHit(100, 400, 0.25), true);
});

test('hedge take-profit is inert on a zero/undefined margin (no position)', () => {
  assert.equal(hedgeTakeProfitHit(1e6, 0, 0.25), false);
});

test('re-arm cooldown blocks immediate re-entry then releases after the window', () => {
  const t0 = 1_000_000_000_000; // arbitrary epoch ms
  const cooldown = 30; // minutes
  // Just traded: blocked.
  assert.equal(rearmCooldownElapsed(t0, t0, cooldown), false);
  assert.equal(rearmCooldownElapsed(t0 + 29 * 60_000, t0, cooldown), false);
  // Window elapsed: ready.
  assert.equal(rearmCooldownElapsed(t0 + 30 * 60_000, t0, cooldown), true);
  assert.equal(rearmCooldownElapsed(t0 + 60 * 60_000, t0, cooldown), true);
});

test('re-arm cooldown disabled (0/undefined) is always ready', () => {
  const t0 = 1_000_000_000_000;
  assert.equal(rearmCooldownElapsed(t0, t0, 0), true);
  assert.equal(rearmCooldownElapsed(t0, t0, undefined), true);
});

test('a sleeve that has never traded (lastActionAt=0) is ready to arm', () => {
  const t0 = 1_000_000_000_000;
  assert.equal(rearmCooldownElapsed(t0, 0, 30), true);
});
