import { mkdir, writeFile } from 'node:fs/promises';
import { Interface } from 'ethers';
import { CHAIN, buildInclusion, verifyInclusion } from '../src/proof.mjs';

const url = process.env.ARC_RPC || 'https://rpc.testnet.arc.io';
async function rpc(method,params) {
  const r = await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(12000)});
  if (!r.ok) throw new Error(method+' HTTP '+r.status);
  const data = await r.json();
  if (data.error || data.result == null) throw new Error(method+': '+JSON.stringify(data.error || 'unavailable'));
  return data.result;
}
await mkdir('artifacts',{recursive:true});
const report = {chain:CHAIN,observedAt:new Date().toISOString(),passed:false};
try {
  if (BigInt(await rpc('eth_chainId',[])) !== BigInt(CHAIN)) throw Error('Wrong test network');
  const head = await rpc('eth_getBlockByNumber',['finalized',false]);
  let block = head;
  for (let i=0; i<80; i++) {
    if (block.transactions.length) break;
    block = await rpc('eth_getBlockByHash',[block.parentHash,false]);
  }
  if (!block.transactions.length) throw Error('No recent payment candidates');
  report.block = block.hash;
  report.height = Number(BigInt(block.number));
  const cert = await rpc('arc_getCertificate',[block.number]);
  let receipts;
  try { receipts = await rpc('eth_getBlockReceipts',[block.number]); }
  catch { receipts = await Promise.all(block.transactions.map(tx=>rpc('eth_getTransactionReceipt',[tx]))); }
  const success = receipts.find(r=>BigInt(r.status)===1n);
  if (!success) throw Error('No successful receipt in block');
  const proof = await buildInclusion(block,receipts,Number(BigInt(success.transactionIndex)));
  const registry = new Interface(['function getActiveValidatorSet() view returns ((uint8 status,bytes publicKey,uint64 votingPower)[])']);
  const data = registry.encodeFunctionData('getActiveValidatorSet');
  const result = await rpc('eth_call',[{to:'0x3600000000000000000000000000000000000002',data},
    '0x'+(BigInt(block.number)-1n).toString(16)]);
  const validators = registry.decodeFunctionResult('getActiveValidatorSet',result)[0]
    .filter(v=>v.votingPower>0n).map(v=>({key:v.publicKey,power:String(v.votingPower)}));
  const snapshot = {chain:CHAIN,from:report.height,to:report.height,validators};
  await verifyInclusion(proof,cert,snapshot);
  const fixture = JSON.stringify({proof,cert,snapshot,transaction:success.transactionHash});
  await writeFile('artifacts/arc-fixture.json',fixture);
  Object.assign(report,{passed:true,size:Buffer.byteLength(fixture),transaction:success.transactionHash,
    trust:'RPC sourced historical set for this spike; provision production checkpoints separately'});
} catch(e) {report.error=e.message;process.exitCode=1;}
await writeFile('artifacts/arc-status.json',JSON.stringify(report,null,2));
console.log(report);
