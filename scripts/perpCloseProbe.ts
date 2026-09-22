import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { loadConfig } from '../src/config.js'; import { loadKeypair } from '../src/wallet.js';
const API='https://perps-api.jup.ag/v1'; const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const cfg=loadConfig(); const signer:Keypair=loadKeypair(cfg); const W=signer.publicKey.toBase58();
const conn=new Connection(process.env.PERPS_SMOKE_RPC||cfg.rpcUrl,'confirmed');
const post=async(p:string,b:any)=>(await (await fetch(API+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)})).json());
const g=await (await fetch(`${API}/positions?walletAddress=${W}`)).json() as any;
const pos=g.dataList[0]; console.log('closing',pos.positionPubkey,'collateral',pos.collateralUsd,'size',pos.sizeUsdDelta);
const dec=await post('/positions/decrease',{positionPubkey:pos.positionPubkey,collateralUsdDelta:String(pos.collateralUsd),sizeUsdDelta:String(pos.sizeUsdDelta),desiredMint:USDC,entirePosition:true,maxSlippageBps:'100'});
if(dec.code) { console.log('REJECTED',dec.code,dec.message); process.exit(1); }
const tx=VersionedTransaction.deserialize(Buffer.from(dec.serializedTxBase64,'base64')); tx.sign([signer]);
const exec=await post('/transaction/execute',{action:'decrease-position',serializedTxBase64:Buffer.from(tx.serialize()).toString('base64')});
console.log('execute:',JSON.stringify(exec));
const txid=exec.txid||exec.signature;
for(let i=0;i<40;i++){const s=(await conn.getSignatureStatuses([txid],{searchTransactionHistory:true})).value[0];
 if(s&&(s.confirmationStatus==='confirmed'||s.confirmationStatus==='finalized')){console.log('LANDED err=',s.err,txid);break;} await new Promise(r=>setTimeout(r,1500));}
const after=await (await fetch(`${API}/positions?walletAddress=${W}`)).json() as any;
console.log('REMAINING POSITIONS:',(after.dataList||[]).length);
