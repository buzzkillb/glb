/**
 * CLEAN ACCEPTANCE — the bot's real PerpBroker, open then fully close, with
 * index-lag waits so the venue's async request/keeper model is respected.
 *
 *   PERPS_SMOKE=1 npx tsx scripts/perpBrokerAcceptance.ts
 */
import { loadConfig } from '../src/config.js';
import { loadKeypair } from '../src/wallet.js';
import { PerpBroker } from '../src/perpBroker.js';

const API = 'https://perps-api.jup.ag/v1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function positions(wallet: string): Promise<any[]> {
  const r = await fetch(`${API}/positions?walletAddress=${wallet}`);
  const j = (await r.json()) as any;
  return j.dataList ?? [];
}

async function main() {
  if (process.env.PERPS_SMOKE !== '1') return console.log('skip (PERPS_SMOKE!=1)');
  const cfg = loadConfig();
  const signer = loadKeypair(cfg);
  const wallet = signer.publicKey.toBase58();
  const broker = new PerpBroker({
    apiUrl: cfg.strategies.perps.apiUrl ?? API,
    rpcUrl: process.env.PERPS_SMOKE_RPC || cfg.rpcUrl,
    slippageBps: 100,
    paper: false,
  });
  const USD = Number(process.env.PERPS_SMOKE_USD || 11);
  const SIDE = (process.env.PERPS_SMOKE_SIDE || 'short') as 'long' | 'short';
  console.log(`wallet ${wallet} | ${USD} ${SIDE} SOL | start positions=${(await positions(wallet)).length}`);

  console.log('[1] broker.open...');
  const o = await broker.open({ asset: 'SOL', side: SIDE, collateralUsd: USD, leverage: 2, walletAddress: wallet, signer });
  console.log('    ', JSON.stringify(o));
  if (!o.ok || !o.quote?.positionPubkey) { console.log('    OPEN FAILED'); process.exit(1); }
  const pub = o.quote.positionPubkey;
  console.log(`    positionPubkey ${pub}`);

  console.log('[2] waiting for venue to index the position...');
  let seen = 0;
  for (let i = 0; i < 30; i++) {
    seen = (await positions(wallet)).length;
    if (seen > 0) break;
    await sleep(2000);
  }
  console.log(`    venue positions=${seen}${seen ? '' : ' (index slow, closing by pubkey anyway)'}`);

  console.log('[3] broker.close (full exit)...');
  const c = await broker.close({
    asset: 'SOL', side: SIDE,
    collateralUsd: o.quote.collateralUsd ?? USD,
    notionalUsd: o.quote.notionalUsd ?? USD * 2,
    positionPubkey: pub, walletAddress: wallet, signer,
  });
  console.log('    ', JSON.stringify(c));

  console.log('[4] waiting for the venue to go flat...');
  let after = seen;
  for (let i = 0; i < 30; i++) {
    after = (await positions(wallet)).length;
    if (after === 0) break;
    await sleep(2000);
  }
  console.log(`    venue positions=${after}`);
  console.log(after === 0 ? '\nRESULT: FULL ROUND-TRIP OK — opened and closed, flat.' : '\nRESULT: still open — needs attention.');
  process.exit(after === 0 ? 0 : 1);
}

main().catch((e) => { console.error('acceptance error:', e?.message ?? e); process.exit(1); });
