// ---------------------------------------------------------------------------
// NO FABRICATED MARKET EXTREMES
// ---------------------------------------------------------------------------
// The price oracle must never invent a "24h high/low". When neither the real
// on-chain DEX history nor the live polled candles cover the window, recentHigh
// and recentLow return 0 ("unknown"), NOT a made-up cushion around spot. A
// fabricated extreme would render on the dashboard as if it were observed, and
// feed the grid band. Callers treat 0 as no reading.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig, StrategyConfig, RiskConfig } from '../src/config.js';
import { PriceOracle } from '../src/price.js';

process.env.NODE_ENV = 'test'; // disable STATE_PERSIST load/save in tests

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const risk: RiskConfig = {
  maxUsdcPosition: 400, hardStopPct: 0.25, unrealizedHardStopPct: 0.2,
  maxSlippageBps: 100, maxStalePricePolls: 5, autoCircuitBreaker: true,
  maxSingleJumpPct: 0.15,
};
const strategies: StrategyConfig = {
  grid: {
    baseAsset: 'SOL', quoteAsset: 'USDC', baseMint: SOL, quoteMint: USDC,
    lowerPrice: 99, upperPrice: 115, numLevels: 8, usdcPerGrid: 10,
    enabled: true, historyHours: 48, reanchorMinutes: 5, deadzoneSteps: 0.5,
    compoundPct: 1.0, volSizingEnabled: true, vwapSkewEnabled: true, skewStrength: 2.0,
  },
  dca: {
    baseAsset: 'SOL', quoteAsset: 'USDC', baseMint: SOL, quoteMint: USDC,
    intervalMinutes: 60, usdcAmountPerBuy: 10, dipPctBelowVwap: 3, enabled: true,
    takeProfitPct: 8, trailingPct: 2, takeProfitSlicePct: 25, tpCooldownMinutes: 30,
    vaEnabled: false, vaTargetSol: 5, vaHorizonBuys: 30,
  },
  memes: [],
};

function cfg(): AppConfig {
  return {
    mode: 'paper', rpcUrl: 'https://api.mainnet-beta.solana.com',
    jupiterApiUrl: 'https://api.jup.ag/swap/v2', pollIntervalMs: 1000,
    refreshIntervalMs: 1000, walletKeyPath: './wallet.key',
    birdeyeApiKey: 'test', strategies, risk,
  };
}

test('recentHigh/Low return 0 (unknown), never an invented cushion', () => {
  const o = new PriceOracle(cfg());
  o.__setPrice(100, true); // sets spot; does not fabricate history
  // Wipe any history/candles the setter may have left, then ask for extremes.
  (o as unknown as { history: unknown[] }).history = [];
  (o as unknown as { candles: unknown[] }).candles = [];
  assert.equal(o.recentHigh(24 * 60), 0, 'high must be unknown, not price*1.05');
  assert.equal(o.recentLow(24 * 60), 0, 'low must be unknown, not price*0.95');
});

test('the old +/-5% cushion is gone (would have been 105 / 95 at spot 100)', () => {
  const o = new PriceOracle(cfg());
  o.__setPrice(100, true);
  (o as unknown as { history: unknown[] }).history = [];
  (o as unknown as { candles: unknown[] }).candles = [];
  assert.notEqual(o.recentHigh(24 * 60), 105, 'must not be the old price*1.05');
  assert.notEqual(o.recentLow(24 * 60), 95, 'must not be the old price*0.95');
});

test('real print history IS used when present (unchanged when data exists)', () => {
  const real = [
    { ts: Date.now() - 60_000, open: 100, high: 128, low: 97, close: 120, volumeUsd: 1000 },
  ];
  const o = new PriceOracle(cfg());
  (o as unknown as { history: typeof real }).history = real;
  assert.equal(o.recentHigh(24 * 60), 128, 'real observed high');
  assert.equal(o.recentLow(24 * 60), 97, 'real observed low');
});
