/**
 * RAW LONG PROBE — full transparency: build, txid, on-chain status, venue index.
 * No assertions, just facts, so we can see why a long doesn't appear.
 */
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { loadConfig } from '../src/config.js';
import { loadKeypair } from '../src/wallet.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const API = 'https://perps-api.jup.ag/v1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const post = async (p: string, b: unknown) =>
  (await (await fetch(API + p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b), signal: AbortSignal.timeout(25_000),
  })).json()) as any;

const positions = async (w: string) => {
  const j = (await (await fetch(`${API}/positions?walletAddress=${w}&includeClosedPositions=true`)).json()) as any;
  return j.dataList ?? [];
};

async function main() {
  const cfg = loadConfig();
  const signer: Keypair = loadKeypair(cfg);
  const w = signer.publicKey.toBase58();
  const conn = new Connection(process.env.PERPS_SMOKE_RPC || cfg.rpcUrl, 'confirmed');
  console.log('wallet', w);

  // mark price for sizing
  const ms = (await (await fetch(`${API}/market-stats?mint=${SOL}`)).json()) as any;
  const price = Number(ms.price);
  console.log('SOL mark', price);
  const collateralUsd = 11;
  const collateralSolRaw = String(Math.round((collateralUsd / price) * 1e9));
  console.log('collateral SOL raw', collateralSolRaw, '(~', (Number(collateralSolRaw) / 1e9).toFixed(4), 'SOL)');

  console.log('\n[build] increase long with SOL collateral...');
  const inc = await post('/positions/increase', {
    collateralMint: SOL, marketMint: SOL, inputMint: SOL,
    collateralTokenDelta: collateralSolRaw,
    leverage: '2', side: 'long', maxSlippageBps: '100', walletAddress: w,
  });
  console.log('   code:', inc.code, 'msg:', inc.message);
  console.log('   positionPubkey:', inc.positionPubkey);
  console.log('   requireKeeperSignature:', inc.requireKeeperSignature);
  console.log('   quote:', JSON.stringify(inc.quote));
  if (!inc.serializedTxBase64) return console.log('   NO TX BUILD');

  console.log('\n[sign+execute]...');
  const tx = VersionedTransaction.deserialize(Buffer.from(inc.serializedTxBase64, 'base64'));
  tx.sign([signer]);
  const exec = await post('/transaction/execute', {
    action: 'increase-position',
    serializedTxBase64: Buffer.from(tx.serialize()).toString('base64'),
  });
  console.log('   execute reply:', JSON.stringify(exec).slice(0, 400));
  const txid = exec.txid || exec.signature;
  console.log('   txid:', txid);

  if (txid) {
    for (let i = 0; i < 25; i++) {
      const s = (await conn.getSignatureStatuses([txid], { searchTransactionHistory: true })).value[0];
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
        console.log('   ON-CHAIN err:', JSON.stringify(s.err), 'slot', s.slot);
        const t = await conn.getTransaction(txid, { maxSupportedTransactionVersion: 0 });
        const logs = t?.meta?.logMessages ?? [];
        console.log('   logs containing Position/perps:');
        for (const l of logs) if (/position|perps|Perpetuals/i.test(l)) console.log('     ', l);
        break;
      }
      await sleep(2000);
    }
  }

  console.log('\n[venue index] waiting up to 90s for the position to appear...');
  for (let i = 0; i < 45; i++) {
    const ps = await positions(w);
    const open = ps.filter((p: any) => (Number(p.collateralUsd) || 0) > 0);
    if (open.length) {
      console.log('   APPEARED:', JSON.stringify(open));
      return;
    }
    await sleep(2000);
  }
  console.log('   venue list (empty=bad):', JSON.stringify(await positions(w)));
}

main().catch((e) => { console.error('probe error:', e?.message ?? e); process.exit(1); });
