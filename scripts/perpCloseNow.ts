/** Close whatever position is currently open, reporting the accepted schema. */
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { loadConfig } from '../src/config.js';
import { loadKeypair } from '../src/wallet.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const API = 'https://perps-api.jup.ag/v1';
const post = async (p: string, b: unknown) =>
  (await (await fetch(API + p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b), signal: AbortSignal.timeout(25_000),
  })).json()) as any;

async function main() {
  const cfg = loadConfig();
  const signer: Keypair = loadKeypair(cfg);
  const w = signer.publicKey.toBase58();
  const conn = new Connection(process.env.PERPS_SMOKE_RPC || cfg.rpcUrl, 'confirmed');
  const j = (await (await fetch(`${API}/positions?walletAddress=${w}&includeClosedPositions=true`)).json()) as any;
  const pos = (j.dataList ?? []).find((p: any) => Number(p.collateralUsd) > 0);
  if (!pos) return console.log('no open position');
  console.log('open:', pos.positionPubkey, pos.side, 'collatUsd', pos.collateralUsd, 'sizeUsdDelta', pos.sizeUsdDelta);

  const variants = [
    { label: 'raw-deltas+entire', collateralUsdDelta: String(pos.collateralUsd), sizeUsdDelta: String(pos.sizeUsdDelta), desiredMint: USDC, entirePosition: true },
    { label: 'raw-deltas', collateralUsdDelta: String(pos.collateralUsd), sizeUsdDelta: String(pos.sizeUsdDelta), desiredMint: USDC },
    { label: 'entire-only', entirePosition: true },
    { label: 'usd-deltas', collateralUsdDelta: String(Number(pos.collateralUsd) / 1e6), sizeUsdDelta: String(Number(pos.sizeUsdDelta) / 1e6), desiredMint: USDC, entirePosition: true },
  ];
  for (const v of variants) {
    const { label, ...body } = v as any;
    const r = await post('/positions/decrease', { positionPubkey: pos.positionPubkey, maxSlippageBps: '100', ...body });
    if (r.code) { console.log(`  [${label}] REJECTED ${r.code}: ${r.message}`); continue; }
    console.log(`  [${label}] ACCEPTED`);
    const tx = VersionedTransaction.deserialize(Buffer.from(r.serializedTxBase64, 'base64'));
    tx.sign([signer]);
    const exec = await post('/transaction/execute', { action: 'decrease-position', serializedTxBase64: Buffer.from(tx.serialize()).toString('base64') });
    const txid = exec.txid || exec.signature;
    console.log('  txid', txid);
    if (txid) {
      for (let i = 0; i < 40; i++) {
        const s = (await conn.getSignatureStatuses([txid], { searchTransactionHistory: true })).value[0];
        if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) { console.log('  ON-CHAIN err:', JSON.stringify(s.err)); break; }
        await new Promise((x) => setTimeout(x, 1500));
      }
    }
    // wait for venue to reflect flat
    for (let i = 0; i < 45; i++) {
      const jj = (await (await fetch(`${API}/positions?walletAddress=${w}&includeClosedPositions=true`)).json()) as any;
      const open = (jj.dataList ?? []).filter((p: any) => Number(p.collateralUsd) > 0);
      if (!open.length) { console.log('\nRESULT: flat — closed with schema:', label); return; }
      await new Promise((x) => setTimeout(x, 2000));
    }
    console.log('\nRESULT: still shows open after close attempt');
    return;
  }
  console.log('\nRESULT: no decrease schema accepted');
}

main().catch((e) => { console.error('close error:', e?.message ?? e); process.exit(1); });
