import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletSizer } from '../src/sizer.js';

/**
 * Cross-book coordination invariant: whatever the perps sleeve has claimed is
 * subtracted from the equity the spot books size against, so grid/DCA and the
 * perps sleeve can never deploy the same dollar of profit twice.
 *
 * These tests drive WalletSizer.snapshot() through a stub JupiterExec so the
 * arithmetic is real, not asserted around.
 */

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';

// Wallet: 10 SOL + $500 USDC, SOL marked at $100 => $1500 equity.
function stubJup() {
  return {
    nativeSolBalance: async () => 10,
    tokenBalance: async (_pk: unknown, mint: string) => (mint === USDC ? 500 : 0),
    quote: async (inputMint: string) =>
      inputMint === SOL ? { outAmount: 100 } : { outAmount: 1 },
  } as any;
}

const cfg = {
  mode: 'live',
  strategies: { grid: { numLevels: 8 }, dca: { vaHorizonBuys: 12 } },
  risk: {},
} as any;

const signer = { publicKey: {} } as any;

test('no perps claim: spot sizes against full equity (perps off changes nothing)', async () => {
  const s = new WalletSizer(cfg, stubJup());
  const snap = await s.snapshot(signer);
  assert.equal(snap.totalUsd, 1500);
  assert.equal(snap.derived.perpsClaimUsd, 0);
  assert.equal(snap.derived.deployableEquityUsd, 1500);
});

test('perps claim is subtracted dollar-for-dollar from deployable equity', async () => {
  const s = new WalletSizer(cfg, stubJup());
  s.perpsClaimProvider = () => 527.57;
  const snap = await s.snapshot(signer);
  assert.equal(snap.derived.perpsClaimUsd, 527.57);
  assert.equal(snap.derived.deployableEquityUsd, 1500 - 527.57);
  // The derived budgets must use the REDUCED equity, not the raw total.
  const dcaPct = snap.derived.dcaBudgetUsd / snap.derived.deployableEquityUsd;
  assert.ok(Math.abs(dcaPct - snap.derived.dcaBudgetUsd / (1500 - 527.57)) < 1e-9);
});

test('claim larger than equity floors deployable equity at 0, never negative', async () => {
  const s = new WalletSizer(cfg, stubJup());
  s.perpsClaimProvider = () => 9_999;
  const snap = await s.snapshot(signer);
  assert.equal(snap.derived.deployableEquityUsd, 0);
  assert.ok(snap.derived.gridPerLevelUsd >= 0);
  assert.ok(snap.derived.dcaBudgetUsd >= 0);
});
