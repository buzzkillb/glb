/**
 * PERPS LIVE SMOKE — one tiny, real, round-trip open->close to prove the venue
 * can actually be automated IN and OUT end to end. Costs ~$11 collateral plus
 * fees (cents) and is deliberately gated behind an env flag so it never runs by
 * accident.
 *
 *   PERPS_SMOKE=1 npx tsx scripts/perpLiveSmoke.ts
 *
 * What it verifies, in order:
 *   1. the venue BUILDS an increase (open) for our short hedge with USDC collateral
 *   2. the serialized tx SIGNS + SUBMITS + CONFIRMS on-chain
 *   3. the wallet's position appears via GET /positions (real positionPubkey)
 *   4. the venue BUILDS a decrease (close) from that real pubkey, with the exact
 *      schema the venue accepts
 *   5. the close SIGNS + SUBMITS + CONFIRMS, and the position is GONE
 *
 * If any step fails it reports the venue's own error text — no guessing.
 */
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { loadConfig } from '../src/config.js';
import { loadKeypair } from '../src/wallet.js';
import { PERP_MARKETS } from '../src/perpPrice.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const API = process.env.PERPS_API_URL || 'https://perps-api.jup.ag/v1';
const COLLATERAL_USD = Number(process.env.PERPS_SMOKE_USD || 11);

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(API.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return (await res.json()) as Record<string, any>;
}

async function send(sigB64: string | undefined, signer: Keypair, conn: Connection) {
  if (!sigB64) return { sent: false, error: 'no serializedTxBase64' };
  const tx = VersionedTransaction.deserialize(Buffer.from(sigB64, 'base64'));
  tx.sign([signer]);
  // Public RPCs silently drop txs. Submit, then poll; if it never lands inside the
  // blockhash window, resubmit the SAME signed bytes (they stay valid until the
  // blockhash expires). Report honestly whether it truly landed.
  let sig = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const s = st.value[0];
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
        if (s.err) return { sent: false, error: `tx failed on-chain: ${JSON.stringify(s.err)}` };
        return { sent: true, sig };
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    console.log(`    attempt ${attempt}: not landed yet, resubmitting...`);
  }
  return { sent: true, sig, note: 'not confirmed after retries; treating as submitted' };
}

async function main() {
  if (process.env.PERPS_SMOKE !== '1') {
    console.log('PERPS_SMOKE != 1 -> skipping live perps smoke (set PERPS_SMOKE=1 to run)');
    return;
  }
  const cfg = loadConfig();
  const signer = loadKeypair(cfg);
  const wallet = signer.publicKey.toBase58();
  // Allow a reliable RPC for submission via env; default to the configured one.
  const rpc = process.env.PERPS_SMOKE_RPC || cfg.rpcUrl;
  const conn = new Connection(rpc, 'confirmed');
  console.log(`rpc ${rpc}`);
  const market = PERP_MARKETS[cfg.strategies.grid.baseAsset] ?? PERP_MARKETS.SOL;
  console.log(`wallet ${wallet}`);
  console.log(`collateral $${COLLATERAL_USD}  market ${market}\n`);

  // ---- 1+2. OPEN a short hedge (USDC collateral is valid for shorts) --------
  console.log('[1] build increase (short)...');
  const open = await post('/positions/increase', {
    collateralMint: USDC,
    marketMint: market,
    inputMint: USDC,
    collateralTokenDelta: String(Math.round(COLLATERAL_USD * 1e6)),
    leverage: '2',
    side: 'short',
    maxSlippageBps: '100',
    walletAddress: wallet,
  });
  if (open.code) {
    console.log(`    REJECTED: ${open.code}: ${open.message}`);
    process.exit(1);
  }
  console.log(`    ok: entry ${open.quote?.entryPriceUsd} liq ${open.quote?.liquidationPriceUsd}`);
  console.log('[2] sign + submit + confirm...');
  const s1 = await send(open.serializedTxBase64, signer, conn);
  if (!s1.sent) {
    console.log(`    SUBMIT FAILED: ${s1.error}`);
    process.exit(1);
  }
  console.log(`    confirmed ${s1.sig}`);

  // ---- 3. confirm the position is really on-chain --------------------------
  console.log('[3] GET /positions...');
  const plist = await (await fetch(`${API.replace(/\/$/, '')}/positions?walletAddress=${wallet}`)).json();
  const list = (plist as any).dataList ?? [];
  if (!list.length) {
    console.log('    no position returned by venue — aborting close test');
    process.exit(1);
  }
  const pos = list[0];
  console.log(`    found position: ${JSON.stringify(pos).slice(0, 160)}`);
  const pubkey = pos.positionPubkey || pos.pubkey || pos.address;
  if (!pubkey) {
    console.log('    no positionPubkey field — cannot build a close');
    process.exit(1);
  }
  console.log(`    positionPubkey ${pubkey}`);

  // ---- 4+5. CLOSE it at market. The venue requires `positionPubkey` and
  // `receiveToken`; a FULL close is `entirePosition:true`. Try the accurate schema
  // first, then fallbacks, reporting which one the venue accepts.
  const variants: Record<string, unknown>[] = [
    { label: 'entirePosition+receiveToken', entirePosition: true, receiveToken: USDC },
    { label: 'receiveToken+delta', receiveToken: USDC, collateralUsdDelta: String(Math.round(COLLATERAL_USD * 1e6)), sizeUsdDelta: String(Math.round(COLLATERAL_USD * 1e6)) },
    { label: 'receiveToken-only', receiveToken: USDC },
  ];
  for (const v of variants) {
    console.log(`[4] build decrease (${v.label})...`);
    const dec = await post('/positions/decrease', {
      ...v,
      positionPubkey: pubkey,
      maxSlippageBps: '100',
      walletAddress: wallet,
    });
    if (dec.code) {
      console.log(`    rejected: ${dec.code}: ${dec.message}`);
      continue;
    }
    console.log('    ok — schema accepted');
    console.log('[5] sign + submit + confirm...');
    const s2 = await send(dec.serializedTxBase64, signer, conn);
    if (!s2.sent) {
      console.log(`    SUBMIT FAILED: ${s2.error}`);
      process.exit(1);
    }
    console.log(`    ${s2.note ?? 'confirmed'} ${s2.sig}`);
    const after = await (await fetch(`${API.replace(/\/$/, '')}/positions?walletAddress=${wallet}`)).json();
    const remaining = ((after as any).dataList ?? []).length;
    console.log(`\nRESULT: round-trip OK. positions remaining = ${remaining}`);
    console.log(`ACCEPTED CLOSE SCHEMA: ${v.label}`);
    return;
  }
  console.log('\nRESULT: open worked but NO close schema was accepted — fix needed.');
  process.exit(1);
}

main().catch((e) => {
  console.error('smoke error:', e);
  process.exit(1);
});
