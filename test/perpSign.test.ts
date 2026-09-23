import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Keep any perps ledger writes off the live state dir.
process.env.PERP_STATE_DIR = mkdtempSync(path.join(tmpdir(), 'perp-sign-'));

import { perpUnrealizedPnlUsd } from '../src/perpStrategy.js';

/**
 * These pin the SIGN of unrealized perp PnL. A SHORT must profit when the mark
 * FALLS. The previous `dir * (mark - entry)` form inverted every short, which
 * silently reversed the stop/halt logic — the one failure mode that loses money
 * on real capital. No prior test covered this, which is why it shipped.
 */
test('short PnL is positive when the mark falls (favorable)', () => {
  // 2x short: $50 collateral -> $100 notional; mark 100 -> 90 = -10% move.
  const pnl = perpUnrealizedPnlUsd('short', 100, 90, 100);
  assert.ok(pnl > 0, `expected a short to profit on a drop, got ${pnl}`);
  assert.equal(pnl, 10); // 10% of $100 notional
});

test('short PnL is negative when the mark rises (adverse)', () => {
  const pnl = perpUnrealizedPnlUsd('short', 100, 110, 100);
  assert.ok(pnl < 0, `expected a short to lose on a rise, got ${pnl}`);
  assert.equal(pnl, -10);
});

test('long PnL is positive when the mark rises (favorable)', () => {
  const pnl = perpUnrealizedPnlUsd('long', 100, 110, 100);
  assert.equal(pnl, 10);
});

test('long PnL is negative when the mark falls (adverse)', () => {
  const pnl = perpUnrealizedPnlUsd('long', 100, 90, 100);
  assert.equal(pnl, -10);
});

test('flat mark yields zero PnL on either side', () => {
  assert.equal(perpUnrealizedPnlUsd('short', 100, 100, 100), 0);
  assert.equal(perpUnrealizedPnlUsd('long', 100, 100, 100), 0);
});

test('degenerate inputs fail safe to zero, never NaN/Infinity', () => {
  assert.equal(perpUnrealizedPnlUsd('short', 0, 90, 100), 0);
  assert.equal(perpUnrealizedPnlUsd('short', 100, 0, 100), 0);
  assert.equal(perpUnrealizedPnlUsd('long', 100, 110, -5), 0);
  assert.ok(Number.isFinite(perpUnrealizedPnlUsd('short', 100, 90, 100)));
});

/**
 * The short-only guard is a SAFETY flag. Operators write booleans in many
 * spellings; the exact-match parser used to read PERPS_SHORT_ONLY=TRUE as
 * false and silently disable the guard.
 */
test('PERPS_SHORT_ONLY accepts common boolean spellings case-insensitively', async () => {
  const { loadConfig } = await import('../src/config.js');
  delete process.env.PERP_STATE_DIR; // loadConfig must not depend on it
  for (const v of ['TRUE', 'True', 'true', '1', 'yes', 'on']) {
    process.env.PERPS_SHORT_ONLY = v;
    assert.equal(loadConfig().strategies.perps?.shortOnly, true, `PERPS_SHORT_ONLY=${v}`);
  }
  for (const v of ['FALSE', 'false', '0', 'no', 'off']) {
    process.env.PERPS_SHORT_ONLY = v;
    assert.equal(loadConfig().strategies.perps?.shortOnly, false, `PERPS_SHORT_ONLY=${v}`);
  }
  delete process.env.PERPS_SHORT_ONLY;
  // Default remains the SAFE posture (short-only on).
  assert.equal(loadConfig().strategies.perps?.shortOnly, true);
});
