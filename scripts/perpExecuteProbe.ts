/**
 * PERPS EXECUTION PATH PROBE — which submission route actually lands on-chain?
 *
 * Jupiter Perps exposes POST /transaction/execute ("requires the keeper to sign
 * and execute"). This probe determines whether we must route through the keeper
 * (sign user-side, then POST the signed tx to /transaction/execute) rather than
 * submitting directly to the RPC.
 *
 *   PERPS_SMOKE=1 npx tsx scripts/perpExecuteProbe.ts
 */
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { loadConfig } from '../src/config.js';
import { loadKeypair } from '../src/wallet.js';
import { PERP_MARKETS } from '../src/perpPrice.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const API = (process.env.PERPS_API_URL || 'https://perps-api.jup.ag/v1').replace(/\/$/, '');
const USD = Number(process.env.PERPS_SMOKE_USD || 11);

const post = async (p: string, b: unknown) => {
  const r = await fetch(API + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
    signal: AbortSignal.timeout(25_000),
  });
  return (await r.json()) as Record<string, any>;
};

async function main() {
  if (process.env.PERPS_SMOKE !== '1') return console.log('skip (PERPS_SMOKE!=1)');
  const cfg = loadConfig();
  const signer: Keypair = loadKeypair(cfg);
  const wallet = signer.publicKey.toBase58();
  const market = PERP_MARKETS[cfg.strategies.grid.baseAsset] ?? PERP_MARKETS.SOL;
  console.log('wallet', wallet);

  console.log('[1] build increase...');
  const inc = await post('/positions/increase', {
    collateralMint: USDC, marketMint: market, inputMint: USDC,
    collateralTokenDelta: String(Math.round(USD * 1e6)),
    leverage: '2', side: 'short', maxSlippageBps: '100', walletAddress: wallet,
  });
  if (inc.code) return console.log('build rejected', inc.code, inc.message);
  console.log('    keeperRequired =', inc.requireKeeperSignature, '| positionPubkey', inc.positionPubkey);

  // Sign user-side.
  const tx = VersionedTransaction.deserialize(Buffer.from(inc.serializedTxBase64, 'base64'));
  tx.sign([signer]);
  const signedB64 = Buffer.from(tx.serialize()).toString('base64');

  console.log('[2] route via /transaction/execute (keeper signs + lands)...');
  const exec = await post('/transaction/execute', {
    action: 'increase-position',
    serializedTxBase64: signedB64,
  });
  console.log('    execute responded:', JSON.stringify(exec).slice(0, 300));

  const txid = exec.txid || exec.signature;
  if (txid) {
    const conn = new Connection(process.env.PERPS_SMOKE_RPC || cfg.rpcUrl, 'confirmed');
    for (let i = 0; i < 30; i++) {
      const s = (await conn.getSignatureStatuses([txid], { searchTransactionHistory: true })).value[0];
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
        console.log(`    LANDED on-chain: ${txid} err=${s.err}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(`    submitted but not confirmed in 60s: ${txid}`);
    return;
  }
  // No txid returned — did direct submit work? It didn't earlier. Report raw.
  console.log('    no txid returned; execute had no signature to confirm');
}

main().catch((e) => { console.error('probe error:', e?.message ?? e); process.exit(1); });
