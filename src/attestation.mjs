import { getAddress,isHexString } from 'ethers';
import { check } from './proof.mjs';
import { checkOrder,orderTerms } from './payment.mjs';
const encoder=new TextEncoder();
export function receiptBytes(r) {
  const o=orderTerms(r);
  check(r.version===1 && r.mode==='relay' && isHexString(r.txHash,32) && isHexString(r.blockHash,32),'Invalid receipt envelope');
  for(const n of [r.height,r.time,r.logIndex]) check(Number.isSafeInteger(n)&&n>=0,'Invalid receipt position');
  return encoder.encode(JSON.stringify(['blackout.receipt',1,'relay',o.chain,o.contract,o.vendor,o.id,o.amount,
    getAddress(r.payer),r.txHash.toLowerCase(),r.blockHash.toLowerCase(),r.height,r.time,r.logIndex]));
}
export async function verifyRelay(bundle,order,jwk) {
  const {receipt:r,signature}=bundle;
  checkOrder(r,order);
  check(r.time>=order.created-60 && r.time<=order.expires,'Receipt outside the order window');
  const key=await crypto.subtle.importKey('jwk',jwk,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  const bytes=Uint8Array.from(atob(signature),c=>c.charCodeAt(0));
  check(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,bytes,receiptBytes(r)),'Invalid relay signature');
  return r;
}
