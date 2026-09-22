import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Isolate the journal/archive dir so these tests never touch live records.
// The journal resolves its dir at import time, so this must be set first.
process.env.BOT_STATE_DIR = mkdtempSync(path.join(tmpdir(), 'perps-profit-'));

import {
  deployableSleeveUsd,
  detectProfit,
  type ProfitSignal,
} from '../src/perpProfit.js';

/** Write a synthetic equity archive + journal tape into the isolated dir. */
function seed(records: { ts: number; equityUsd: number }[], fills: { ts: number; realizedPnlUsd: number }[] = []) {
  const dir = process.env.BOT_STATE_DIR!;
  writeFileSync(path.join(dir, 'equity-live.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (fills.length) {
    writeFileSync(
      path.join(dir, 'trades-live.jsonl'),
      fills
        .map((f) => JSON.stringify({ ts: f.ts, strategyId: 'grid', direction: 'SELL', baseQty: 1, quoteQty: 100, realizedPnlUsd: f.realizedPnlUsd }))
        .join('\n') + '\n'
    );
  }
}

const DAY = 86_400_000;
const NOW = Date.now();

test('baseline is derived from the earliest archived equity sample, not hardcoded', () => {
  seed([
    { ts: NOW - 10 * DAY, equityUsd: 10_000 },
    { ts: NOW - 5 * DAY, equityUsd: 10_200 },
    { ts: NOW, equityUsd: 10_565 },
  ]);
  const s = detectProfit('live', 10_565, 9_000);
  assert.equal(s.baselineSource, 'archive');
  assert.equal(s.baselineEquityUsd, 10_000);
  assert.equal(s.newProfitUsd, 565);
});

test('deployable profit uses the live signal rather than a fixed floor', () => {
  seed([
    { ts: NOW - 10 * DAY, equityUsd: 10_000 },
    { ts: NOW, equityUsd: 11_000 },
  ]);
  const s = detectProfit('live', 11_000, 9_000);
  // 1000 profit * 0.5 share = 500; cash 9000*0.5 = 4500; equity cap 1100; ceiling 250.
  const budget = deployableSleeveUsd({ profitSharePct: 0.5, cashUsePct: 0.5, maxEquityPct: 0.1, maxMarginUsd: 250 }, s);
  assert.equal(budget, 250);
});

test('budget collapses to 0 at/below the dynamic baseline', () => {
  seed([
    { ts: NOW - 10 * DAY, equityUsd: 10_000 },
    { ts: NOW, equityUsd: 9_800 },
  ]);
  const s = detectProfit('live', 9_800, 8_000);
  assert.equal(s.newProfitUsd, 0);
  assert.equal(deployableSleeveUsd({ profitSharePct: 0.5, cashUsePct: 0.5, maxEquityPct: 0.1, maxMarginUsd: 250 }, s), 0);
});

test('budget is limited by liquid cash, not by SOL inventory', () => {
  seed([
    { ts: NOW - 10 * DAY, equityUsd: 10_000 },
    { ts: NOW, equityUsd: 12_000 },
  ]);
  // 2000 profit, but only $30 of spendable USDC -> cash term binds.
  const s = detectProfit('live', 12_000, 30);
  const budget = deployableSleeveUsd({ profitSharePct: 0.5, cashUsePct: 0.5, maxEquityPct: 0.1, maxMarginUsd: 250 }, s);
  assert.equal(budget, 15); // 30 * 0.5
});

test('an empty record yields no baseline and no deployment', () => {
  seed([]);
  const s = detectProfit('live', 10_500, 5_000);
  assert.equal(s.baselineEquityUsd, null);
  assert.equal(s.ready, false);
  assert.equal(deployableSleeveUsd({ profitSharePct: 0.5, cashUsePct: 0.5, maxEquityPct: 0.1, maxMarginUsd: 250 }, s), 0);
});

test('lifetime realized PnL is detected from the tape', () => {
  seed(
    [{ ts: NOW - 10 * DAY, equityUsd: 10_000 }, { ts: NOW, equityUsd: 10_500 }],
    [
      { ts: NOW - 3 * DAY, realizedPnlUsd: 300 },
      { ts: NOW - 1 * DAY, realizedPnlUsd: 222 },
    ]
  );
  const s = detectProfit('live', 10_500, 9_000);
  assert.equal(s.lifetimeRealizedUsd, 522);
  assert.ok(s.sampleFills >= 2);
});

test('banked realized PnL caps deployment (only banked money is risked)', () => {
  // 2000 net profit, but only 100 actually banked realized -> realized term binds.
  seed(
    [{ ts: NOW - 10 * DAY, equityUsd: 10_000 }, { ts: NOW, equityUsd: 12_000 }],
    [{ ts: NOW - 2 * DAY, realizedPnlUsd: 100 }]
  );
  const s = detectProfit('live', 12_000, 9_000);
  const budget = deployableSleeveUsd(
    { profitSharePct: 0.5, realizedProfitUsePct: 0.5, cashUsePct: 0.5, maxEquityPct: 0.1, maxMarginUsd: 250 },
    s
  );
  // realized ceiling = 100 * 0.5 = 50, which is below profit share (1000) & cap.
  assert.equal(budget, 50);
});

test('realized-profit path can be disabled with 0 and never goes negative', () => {
  seed(
    [{ ts: NOW - 10 * DAY, equityUsd: 10_000 }, { ts: NOW, equityUsd: 12_000 }],
    [{ ts: NOW - 2 * DAY, realizedPnlUsd: 100 }]
  );
  const s = detectProfit('live', 12_000, 9_000);
  const off = deployableSleeveUsd(
    { profitSharePct: 0.5, realizedProfitUsePct: 0, cashUsePct: 0.5, maxEquityPct: 0.1, maxMarginUsd: 250 },
    s
  );
  assert.equal(off, 250); // realized term disabled -> profit/cap binds
  // A negative tape must not produce a negative budget.
  seed(
    [{ ts: NOW - 10 * DAY, equityUsd: 10_000 }, { ts: NOW, equityUsd: 10_500 }],
    [{ ts: NOW - 2 * DAY, realizedPnlUsd: -400 }]
  );
  const neg = detectProfit('live', 10_500, 9_000);
  assert.ok(neg.lifetimeRealizedUsd < 0);
  const b = deployableSleeveUsd(
    { profitSharePct: 0.5, realizedProfitUsePct: 0.5, cashUsePct: 0.5, maxEquityPct: 0.1, maxMarginUsd: 250 },
    neg
  );
  assert.ok(b >= 0);
});

test('outstanding margin is subtracted so profit is never deployed twice', () => {
  // Full-profit config: profit above baseline is the only binding term here.
  const cfg = { profitSharePct: 1, realizedProfitUsePct: 1, cashUsePct: 1, maxEquityPct: 0.1, maxMarginUsd: 0 };
  seed([{ ts: NOW - 10 * DAY, equityUsd: 10_000 }, { ts: NOW, equityUsd: 10_500 }], [
    { ts: NOW - 1 * DAY, realizedPnlUsd: 400 },
  ]);
  const s = detectProfit('live', 10_500, 9_000);
  // Profit is $500 but banked realized PnL is only $400, which caps it (you may
  // only risk money actually banked). With no position open, $400 is deployable.
  assert.equal(deployableSleeveUsd(cfg, s, 0), 400);
  // $300 already committed -> only the remaining $100 may be deployed.
  assert.equal(deployableSleeveUsd(cfg, s, 300), 100);
  // More margin at work than the ceiling -> exactly 0, never negative.
  assert.equal(deployableSleeveUsd(cfg, s, 800), 0);
});

test('profit banked before the archive began is NOT erased by the baseline', () => {
  // Trading started before the equity archive existed. $300 was banked pre-archive
  // and is already baked into the first archived equity sample (10_300). The
  // second sample (10_800) is net worth after those gains plus another $200.
  // Using the raw first sample as baseline would show only $500 of profit and
  // silently drop the $300. The true trading origin is 10_300 - 300 = 10_000,
  // so eligible profit must be 10_800 - 10_000 = 800.
  seed(
    [{ ts: NOW - 5 * DAY, equityUsd: 10_300 }, { ts: NOW, equityUsd: 10_800 }],
    [
      { ts: NOW - 20 * DAY, realizedPnlUsd: 300 }, // pre-archive, must still count
      { ts: NOW - 2 * DAY, realizedPnlUsd: 200 },
    ]
  );
  const s = detectProfit('live', 10_800, 9_000);
  assert.equal(s.baselineEquityUsd, 10_000, 'baseline reconstructed to trading origin');
  assert.equal(s.newProfitUsd, 800, 'all banked profit is credited, incl. pre-archive');
  // Full-PnL config: the realized ceiling is 500, below the 800 equity gain.
  const cfg = { profitSharePct: 1, realizedProfitUsePct: 1, cashUsePct: 1, maxEquityPct: 0.1, maxMarginUsd: 0 };
  assert.equal(deployableSleeveUsd(cfg, s, 0), 500);
});

test('a non-positive equity sample is never archived (boot-time 0 guard)', async () => {
  // The live path must reject a transient 0 equity (chain not synced yet) so a
  // fake crash can never become the profit baseline.
  const fresh = mkdtempSync(path.join(tmpdir(), 'perps-archive-'));
  const prev = process.env.BOT_STATE_DIR;
  process.env.BOT_STATE_DIR = fresh;
  try {
    const { appendEquityArchive, readEquityArchive } = await import('../src/journal.js');
    appendEquityArchive('live', { ts: NOW - 1000, equityUsd: 0 });
    appendEquityArchive('live', { ts: NOW, equityUsd: 10_500 });
    const got = readEquityArchive('live');
    assert.equal(got.length, 1, 'only the real sample is archived');
    assert.equal(got[0].equityUsd, 10_500);
  } finally {
    process.env.BOT_STATE_DIR = prev;
  }
});
