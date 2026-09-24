// ---------------------------------------------------------------------------
// Risk gate — unrealized draw-down pause must NOT be a permanent latch
// ---------------------------------------------------------------------------
// Regression guard. The engine used to `return` immediately whenever `paused`
// was set, so the UNREALIZED draw-down pause — a transient market condition —
// became permanent: one one-off underwater mark (or a bad price print) froze the
// bot forever, forfeiting every future fill. The guard must CLEAR when the open
// book recovers, while the REALIZED stop stays latched as a banked loss.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNREALIZED_PAUSE_PREFIX,
  unrealizedThresholdUsd,
  unrealizedTriggered,
  unrealizedPauseCleared,
} from '../src/riskGate.js';

test('threshold: scales with max position size', () => {
  assert.equal(unrealizedThresholdUsd(10_000, 0.2), 2_000);
});

test('threshold: disabled guard yields null (never trips)', () => {
  assert.equal(unrealizedThresholdUsd(10_000, 0), null);
  assert.equal(unrealizedThresholdUsd(0, 0.2), null);
});

test('triggered: underwater past threshold trips', () => {
  assert.equal(unrealizedTriggered(-2_500, 10_000, 0.2), true);
});

test('triggered: exactly at threshold trips (inclusive)', () => {
  assert.equal(unrealizedTriggered(-2_000, 10_000, 0.2), true);
});

test('triggered: recovered book does not trip', () => {
  assert.equal(unrealizedTriggered(-1_200, 10_000, 0.2), false);
  assert.equal(unrealizedTriggered(500, 10_000, 0.2), false);
});

test('triggered: disabled guard never trips even deep underwater', () => {
  assert.equal(unrealizedTriggered(-9_999, 10_000, 0), false);
});

test('recovery: a latched unrealized pause CLEARS once the book recovers', () => {
  const reason = `${UNREALIZED_PAUSE_PREFIX} -2500.00 <= -2000.00`;
  assert.equal(unrealizedPauseCleared(true, reason, -1_000, 10_000, 0.2), true);
});

test('recovery: unrealized pause stays latched while still underwater', () => {
  const reason = `${UNREALIZED_PAUSE_PREFIX} -2500.00 <= -2000.00`;
  assert.equal(unrealizedPauseCleared(true, reason, -2_500, 10_000, 0.2), false);
});

test('recovery: a REALIZED-loss pause is never cleared by this guard', () => {
  assert.equal(
    unrealizedPauseCleared(true, 'realized loss -3000.00 <= -2000.00', 500, 10_000, 0.2),
    false
  );
});

test('recovery: not paused means nothing to clear', () => {
  assert.equal(unrealizedPauseCleared(false, '', -1_000, 10_000, 0.2), false);
});

test('recovery: disabling the guard clears a stale unrealized pause', () => {
  const reason = `${UNREALIZED_PAUSE_PREFIX} -2500.00 <= -2000.00`;
  assert.equal(unrealizedPauseCleared(true, reason, -9_000, 10_000, 0), true);
});
