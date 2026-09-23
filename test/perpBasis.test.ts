import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PERP_STATE_DIR = mkdtempSync(path.join(tmpdir(), 'perp-basis-'));

import { PerpSleeve } from '../src/perpSleeve.js';

/**
 * The hedge TARGET basis. The sleeve hedges directional net-long SOL; that
 * exposure lives in BOTH ring-fenced spot sub-books (grid AND dca). The
 * previous code hedged ONLY the grid book, leaving the DCA leg's SOL unhedged,
 * and fell back to the WHOLE wallet's SOL whenever the grid book read zero —
 * so the same wallet produced two different exposure numbers depending on grid
 * state. These tests pin the basis so the hedge cannot silently under-insure.
 */

function sleeveWithStore(store: any): PerpSleeve {
  const cfg = {
    mode: 'paper',
    strategies: {
      grid: { baseAsset: 'SOL', quoteAsset: 'USDC', baseMint: 'SOL', quoteMint: 'USDC' },
      perps: {
        enabled: true, profitSharePct: 0.5, realizedProfitUsePct: 1, cashUsePct: 1,
        profitWindowHours: 168, minFillsForConfidence: 1, openFeePct: 0.0006,
        hourlyBorrowPct: 0.000006, maxEquityPct: 0.1, maxMarginUsd: 0,
        maxLeverage: 0, hedgeRatio: 1, hedgeTriggerPct: 0.15,
        stopLossMarginPct: 0.25, maxLossUsd: 0, overlayEnabled: false,
        overlayBudgetPct: 0.5, baselineEquityUsd: 0, apiUrl: '', slippageBps: 100,
        usdcFloorUsd: 30, maxNetExposurePct: 0.35,
      },
      dca: {},
    },
    risk: { maxSingleJumpPct: 0.05 },
    rpcUrl: 'https://api.mainnet-beta.solana.com',
  } as any;
  return new PerpSleeve(cfg, store);
}

const stubStore = (o: any) => ({
  strategies: {
    grid: { subBook: o.grid ?? null },
    dca: { subBook: o.dca ?? null },
  },
  audit: () => ({ chainSol: o.chainSol ?? 0 }),
});

// Reach the private helper through the public surface it feeds.
function basis(s: PerpSleeve, mark: number): number {
  return (s as any).gridNetLongUsd(mark);
}

test('hedge target sums grid AND dca inventory (both are directional SOL)', () => {
  const s = sleeveWithStore(stubStore({
    grid: { baseQty: 10, avgCostPerBase: 100, realizedPnlUsd: 0, feesPaidUsd: 0 },
    dca: { baseQty: 5, avgCostPerBase: 100, realizedPnlUsd: 0, feesPaidUsd: 0 },
    chainSol: 999, // must be ignored while books exist
  }));
  assert.equal(basis(s, 100), 1500); // (10 + 5) * 100
});

test('empty grid book does NOT fall back to the whole wallet when dca book exists', () => {
  const s = sleeveWithStore(stubStore({
    grid: { baseQty: 0, avgCostPerBase: 0, realizedPnlUsd: 0, feesPaidUsd: 0 },
    dca: { baseQty: 7, avgCostPerBase: 100, realizedPnlUsd: 0, feesPaidUsd: 0 },
    chainSol: 500,
  }));
  assert.equal(basis(s, 100), 700); // dca only — NOT 50000 from chainSol
});

test('legacy fallback to chain SOL only when no ring-fenced book exists at all', () => {
  const s = sleeveWithStore(stubStore({ grid: null, dca: null, chainSol: 12 }));
  assert.equal(basis(s, 100), 1200);
});

test('basis never goes negative on a short/empty book', () => {
  const s = sleeveWithStore(stubStore({
    grid: { baseQty: 0, avgCostPerBase: 0, realizedPnlUsd: 0, feesPaidUsd: 0 },
    dca: { baseQty: 0, avgCostPerBase: 0, realizedPnlUsd: 0, feesPaidUsd: 0 },
    chainSol: -3, // defensive
  }));
  assert.equal(basis(s, 100), 0);
});
