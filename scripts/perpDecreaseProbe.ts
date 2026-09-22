import { loadConfig } from '../src/config.js'; import { loadKeypair } from '../src/wallet.js';
const API='https://perps-api.jup.ag/v1'; const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const W=loadKeypair(loadConfig()).publicKey.toBase58();
const post=async(p:any,b:any)=>(await (await fetch(API+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)})).json());
const g=await (await fetch(`${API}/positions?walletAddress=${W}`)).json();
const pos=g.dataList[0]; console.log('pos',pos.positionPubkey,'collateralRaw',pos.collateralUsd);
const variants=[
 {label:'required-trio+entire', collateralUsdDelta:String(pos.collateralUsd), desiredMint:USDC, sizeUsdDelta:String(pos.collateralUsd), positionPubkey:pos.positionPubkey, entirePosition:true, receiveToken:USDC},
 {label:'trio-only', collateralUsdDelta:String(pos.collateralUsd), desiredMint:USDC, sizeUsdDelta:String(pos.collateralUsd), positionPubkey:pos.positionPubkey},
];
for(const v of variants){
  const {label,...body}=v as any;
  const r=await post('/positions/decrease',body);
  console.log(label,'->', r.code? `${r.code}: ${r.message}` : 'ACCEPTED, tx len '+String(r.serializedTxBase64||'').length);
}
