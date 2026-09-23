import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hedgeTakeProfitHit, planHedgeTakeProfit, rearmCooldownElapsed } from '../src/perpStrategy.js';

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

/**
 * DYNAMIC HEDGE TAKE-PROFIT — the perps leg is meant to make money on the
 * DOWNSIDE, so its exit must react to live state, not a fixed percent. While a
 * real downtrend is intact the target RIDES toward the ceiling; the moment the
 * move is exhausted (momentum flattens/up, or the favourable move has covered
 * the 24h range) it collapses to the floor and banks before a bounce hands the
 * gain back. Every number is derived from live state — the floor/ceiling are
 * config, never a hardcoded result.
 */

test('dynamic target rides a live downtrend above the floor', () => {
  const plan = planHedgeTakeProfit({
    netPnlUsd: 10,
    collateralUsd: 200,
    entryPriceUsd: 100,
    markPriceUsd: 98,
    profitable: true,
    vol24RangePct: 0.05,
    momentum24HPct: -0.04, // falling market -> trend intact
    minTakeProfitPct: 0.25,
    maxTakeProfitPct: 0.6,
    volFactor: 1,
  });
  assert.equal(plan.exhausted, false);
  assert.ok(plan.targetPct > 0.25, `expected ride above floor, got ${plan.targetPct}`);
  assert.ok(plan.targetPct <= 0.6);
  assert.equal(plan.fired, false); // only 10 USD vs a >50 USD target
});

test('momentum flipping flat/up marks the move spent and banks at the floor', () => {
  const plan = planHedgeTakeProfit({
    netPnlUsd: 55,
    collateralUsd: 200,
    entryPriceUsd: 100,
    markPriceUsd: 96,
    profitable: true,
    vol24RangePct: 0.05,
    momentum24HPct: 0, // downtrend over
    minTakeProfitPct: 0.25,
    maxTakeProfitPct: 0.6,
    volFactor: 1,
  });
  assert.equal(plan.exhausted, true);
  assert.equal(plan.targetPct, 0.25); // collapsed to floor
  assert.equal(plan.fired, true); // 55 >= 50, bank now
  assert.match(plan.reason, /banking/);
});

test('a favourable move that covers the 24h range is treated as exhausted', () => {
  const plan = planHedgeTakeProfit({
    netPnlUsd: 5,
    collateralUsd: 200,
    entryPriceUsd: 100,
    markPriceUsd: 95, // 5% fall, exactly the 24h range
    profitable: true,
    vol24RangePct: 0.05,
    momentum24HPct: -0.01, // still nominally falling
    minTakeProfitPct: 0.25,
    maxTakeProfitPct: 0.6,
    volFactor: 1,
  });
  assert.equal(plan.exhausted, true);
  assert.equal(plan.targetPct, 0.25);
});

test('a losing hedge never fires and never exhausts into a bank', () => {
  const plan = planHedgeTakeProfit({
    netPnlUsd: -20,
    collateralUsd: 200,
    entryPriceUsd: 100,
    markPriceUsd: 103,
    profitable: false,
    vol24RangePct: 0.05,
    momentum24HPct: 0.02,
    minTakeProfitPct: 0.25,
    maxTakeProfitPct: 0.6,
    volFactor: 1,
  });
  assert.equal(plan.fired, false);
  assert.equal(plan.exhausted, false);
});

test('planHedgeTakeProfit is disabled when the floor is 0', () => {
  const plan = planHedgeTakeProfit({
    netPnlUsd: 1e6,
    collateralUsd: 200,
    entryPriceUsd: 100,
    markPriceUsd: 90,
    profitable: true,
    minTakeProfitPct: 0,
  });
  assert.equal(plan.fired, false);
  assert.equal(plan.targetPct, 0);
  assert.equal(plan.reason, 'take-profit disabled');
});

test('ceiling below floor is clamped so the target can never invert', () => {
  const plan = planHedgeTakeProfit({
    netPnlUsd: 100,
    collateralUsd: 100,
    entryPriceUsd: 100,
    markPriceUsd: 99,
    profitable: true,
    momentum24HPct: -0.1,
    minTakeProfitPct: 0.3,
    maxTakeProfitPct: 0.1, // invalid: below the floor
    volFactor: 1,
  });
  assert.ok(plan.targetPct >= 0.3, `target must not fall below the floor: ${plan.targetPct}`);
});
