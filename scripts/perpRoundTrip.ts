/**
 * PERPS LIVE ROUND-TRIP (keeper-routed) — the CORRECT automation path.
 *
 * Jupiter Perps requires the KEEPER to co-sign and land the transaction
 * (build reply carries `requireKeeperSignature: true`). So the flow is:
 *   build -> sign user-side -> POST /transaction/execute {action} -> txid -> confirm.
 * Submitting directly to the RPC fails signature/landing, which is the bug this
 * script exists to catch.
 *
 *   PERPS_SMOKE=1 npx tsx scripts/perpRoundTrip.ts
 *
 * Proves, for a real position: open (short hedge) lands, the position appears,
 * then a FULL close (entirePosition:true) lands and the position is GONE.
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

/** Sign user-side then route through the keeper; confirm the returned txid. */
async function execute(action: string, serializedTxBase64: string, signer: Keypair, conn: Connection) {
  const tx = VersionedTransaction.deserialize(Buffer.from(serializedTxBase64, 'base64'));
  tx.sign([signer]);
  const signedB64 = Buffer.from(tx.serialize()).toString('base64');
  const exec = await post('/transaction/execute', { action, serializedTxBase64: signedB64 });
  const txid = exec.txid || exec.signature;
  if (!txid) return { ok: false, error: `execute returned no txid: ${JSON.stringify(exec)}` };
  for (let i = 0; i < 40; i++) {
    const s = (await conn.getSignatureStatuses([txid], { searchTransactionHistory: true })).value[0];
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
      if (s.err) return { ok: false, error: `tx failed on-chain: ${JSON.stringify(s.err)}`, txid };
      return { ok: true, txid };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, error: 'not confirmed in 60s', txid };
}

async function main() {
  if (process.env.PERPS_SMOKE !== '1') return console.log('skip (PERPS_SMOKE!=1)');
  const cfg = loadConfig();
  const signer: Keypair = loadKeypair(cfg);
  const wallet = signer.publicKey.toBase58();
  const conn = new Connection(process.env.PERPS_SMOKE_RPC || cfg.rpcUrl, 'confirmed');
  const market = PERP_MARKETS[cfg.strategies.grid.baseAsset] ?? PERP_MARKETS.SOL;
  console.log('wallet', wallet, '| collateral $' + USD);

  // ---- OPEN ---------------------------------------------------------------
  console.log('[1] build increase (short)...');
  const inc = await post('/positions/increase', {
    collateralMint: USDC, marketMint: market, inputMint: USDC,
    collateralTokenDelta: String(Math.round(USD * 1e6)),
    leverage: '2', side: 'short', maxSlippageBps: '100', walletAddress: wallet,
  });
  if (inc.code) return console.log('    REJECTED', inc.code, inc.message);
  const pubkey = inc.positionPubkey;
  console.log(`    ok: entry ${inc.quote?.entryPriceUsd} liq ${inc.quote?.liquidationPriceUsd} pos ${pubkey}`);
  console.log('[2] sign + route via keeper...');
  const open = await execute('increase-position', inc.serializedTxBase64, signer, conn);
  if (!open.ok) return console.log('    OPEN FAILED:', open.error);
  console.log(`    landed ${open.txid}`);

  // ---- VERIFY POSITION ----------------------------------------------------
  console.log('[3] GET /positions...');
  const before = await (await fetch(`${API}/positions?walletAddress=${wallet}`)).json() as any;
  const pos = (before.dataList || [])[0];
  if (!pos) return console.log('    no position returned — aborting');
  console.log(`    position ${pos.positionPubkey} collateral ${pos.collateralUsd}`);

  // ---- CLOSE (full) -------------------------------------------------------
  // The venue's decrease endpoint requires positionPubkey, collateralUsdDelta,
  // sizeUsdDelta and desiredMint. For a full exit we pass the position's entire
  // collateral and size. (entirePosition:true is honored alongside.)
  console.log('[4] build decrease (full exit)...');
  const dec = await post('/positions/decrease', {
    positionPubkey: pos.positionPubkey || pubkey,
    collateralUsdDelta: String(pos.collateralUsd ?? 0),
    sizeUsdDelta: String(pos.sizeUsdDelta ?? pos.collateralUsd ?? 0),
    desiredMint: USDC,
    entirePosition: true,
    maxSlippageBps: '100',
  });
  if (dec.code) return console.log('    DECREASE REJECTED', dec.code, dec.message);
  console.log('[5] sign + route via keeper...');
  const close = await execute('decrease-position', dec.serializedTxBase64, signer, conn);
  if (!close.ok) return console.log('    CLOSE FAILED:', close.error);
  console.log(`    landed ${close.txid}`);

  const after = await (await fetch(`${API}/positions?walletAddress=${wallet}`)).json() as any;
  const remaining = (after.dataList || []).length;
  console.log(`\nRESULT: ${remaining === 0 ? 'ROUND-TRIP OK — flat' : 'STILL OPEN (' + remaining + ')'}`);
}

main().catch((e) => { console.error('round-trip error:', e?.message ?? e); process.exit(1); });
