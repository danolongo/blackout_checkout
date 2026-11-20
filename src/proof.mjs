import { ed25519 } from '@noble/curves/ed25519';
import { concat, decodeRlp, encodeRlp, getAddress, getBytes, hexlify, id, keccak256, toBeHex, zeroPadValue } from 'ethers';
import {match,verifyReceive,verifySend} from './intents.mjs';

export const CHAIN = 5042002;
export function check(value, message) {
  if (!value) throw new Error(message);
}
export function quantity(value) {
  const n = BigInt(value);
  return n === 0n ? '0x' : toBeHex(n);
}
function fixedHex(value, bytes) {
  check(typeof value === 'string' && getBytes(value).length === bytes, 'Invalid field length');
  return getBytes(value);
}
function little(value, size) {
  const n = BigInt(value);
  check(n >= 0n && n < 1n << BigInt(size * 8), 'Vote field out of range');
  return Uint8Array.from({length:size}, (_, i) => Number((n >> BigInt(i * 8)) & 255n));
}
// Circle arc-node Vote::to_sign_bytes, SSZ v1. Only the Precommit variant is final.
export function voteBytes(cert, address) {
  return getBytes(concat([Uint8Array.of(1),little(cert.height,8),little(37,4),little(42,4),
    fixedHex(address,20),Uint8Array.of(1),little(cert.round,4),Uint8Array.of(1),fixedHex(cert.block_hash,32)]));
}
export function verifyCertificate(cert, snapshot) {
  const height = BigInt(cert.height);
  check(snapshot.chain === CHAIN && height >= BigInt(snapshot.from) && height <= BigInt(snapshot.to), 'Untrusted height');
  const keys = new Map();
  let total = 0n, signed = 0n;
  for (const v of snapshot.validators) {
    const key = fixedHex(v.key,32);
    const address = keccak256(key).slice(0,42);
    const power = BigInt(v.power);
    check(power > 0n && !keys.has(address), 'Invalid validator set');
    keys.set(address,{key,power});
    total += power;
  }
  const seen = new Set();
  for (const s of cert.signatures) {
    const address = s.address.toLowerCase();
    const validator = keys.get(address);
    check(validator && !seen.has(address), 'Unknown or repeated signer');
    seen.add(address);
    const sig = Uint8Array.from(atob(s.signature), c => c.charCodeAt(0));
    check(ed25519.verify(sig,voteBytes(cert,address),validator.key,{zip215:false}), 'Invalid precommit');
    signed += validator.power;
  }
  check(signed * 3n > total * 2n, 'Insufficient voting power');
}
export function encodeHeader(b) {
  const fields = [b.parentHash,b.sha3Uncles,b.miner,b.stateRoot,b.transactionsRoot,b.receiptsRoot,b.logsBloom,
    quantity(b.difficulty),quantity(b.number),quantity(b.gasLimit),quantity(b.gasUsed),quantity(b.timestamp),
    b.extraData,b.mixHash,b.nonce];
  for (const [key,number] of [['baseFeePerGas',true],['withdrawalsRoot',false],['blobGasUsed',true],
    ['excessBlobGas',true],['parentBeaconBlockRoot',false],['requestsHash',false]]) {
    if (b[key] != null) fields.push(number ? quantity(b[key]) : b[key]);
  }
  const header = encodeRlp(fields);
  check(keccak256(header) === b.hash, 'Header fields do not reconstruct the RPC block hash');
  return header;
}
export function encodeReceipt(r) {
  const body = encodeRlp([quantity(r.status),quantity(r.cumulativeGasUsed),r.logsBloom,
    r.logs.map(l => [l.address,l.topics,l.data])]);
  return BigInt(r.type ?? 0) === 0n ? body : concat([quantity(r.type),body]);
}
function nibbles(bytes){return Array.from(bytes).flatMap(byte=>[byte>>4,byte&15]);}
function mptValue(root,index,nodes){
  let path=nibbles(getBytes(encodeRlp(quantity(index))));
  let expected=getBytes(root);
  check(Array.isArray(nodes)&&nodes.length>0&&nodes.length<128,'Invalid receipt proof');
  for(let position=0;position<nodes.length;position++){
    const encoded=getBytes(nodes[position]);
    check(expected.length===32?keccak256(encoded)===hexlify(expected):hexlify(encoded)===hexlify(expected),'Broken receipt proof link');
    const node=decodeRlp(encoded);
    check(Array.isArray(node),'Invalid trie node');
    let child;
    if(node.length===17){
      if(!path.length){check(position===nodes.length-1,'Extra proof nodes');return getBytes(node[16]);}
      child=node[path.shift()];
    }else if(node.length===2){
      const encodedPath=nibbles(getBytes(node[0])),flag=encodedPath[0];
      check(flag<=3,'Invalid trie path');
      const segment=encodedPath.slice(flag&1?1:2);
      check(segment.every((digit,i)=>path[i]===digit),'Wrong receipt index');
      path=path.slice(segment.length);
      if(flag&2){check(path.length===0&&position===nodes.length-1,'Wrong receipt leaf');return getBytes(node[1]);}
      child=node[1];
    }else throw Error('Invalid trie node arity');
    check(child&&child!=='0x','Missing receipt');
    expected=Array.isArray(child)?getBytes(encodeRlp(child)):getBytes(child);
  }
  throw Error('Incomplete receipt proof');
}
export async function verifyInclusion(proof, cert, snapshot) {
  verifyCertificate(cert,snapshot);
  check(keccak256(proof.header) === cert.block_hash, 'Header does not match commit');
  const h = decodeRlp(proof.header);
  check(BigInt(h[8] === '0x' ? 0 : h[8]) === BigInt(cert.height), 'Wrong block height');
  check(Number.isSafeInteger(proof.index) && proof.index >= 0, 'Invalid receipt index');
  const raw = mptValue(h[5],proof.index,proof.nodes);
  check(raw && raw.length, 'Missing receipt');
  const [status,,,logs] = decodeRlp(raw[0]<128 ? raw.slice(1) : raw);
  check(status === '0x01', 'Payment failed');
  return {logs,height:BigInt(cert.height),timestamp:Number(BigInt(h[11])),blockHash:cert.block_hash};
}
export async function verifyPaymentProof(bundle,receiveRaw,sendRaw,snapshot) {
  check(bundle?.v===1&&bundle.kind==='settlement-proof', 'Not a settlement proof');
  const receive=verifyReceive(receiveRaw),send=verifySend(sendRaw,receive.contract);
  check(match(receive,send), 'Local payment signatures differ');
  check(bundle.id===receive.id&&getAddress(bundle.vendor)===receive.vendor, 'Proof is for another invoice');
  const result=await verifyInclusion(bundle.inclusion,bundle.certificate,snapshot);
  const topic=id('OrderPaid(bytes16,address,address,uint256)');
  const vendor=zeroPadValue(receive.vendor,32).toLowerCase();
  const payer=zeroPadValue(send.payer,32).toLowerCase();
  const found=result.logs.some(([address,topics,data])=>
    getAddress(address)===receive.contract&&topics.length===4&&
    topics[0]===topic&&topics[1].slice(0,34).toLowerCase()===receive.id.toLowerCase()&&
    topics[2].toLowerCase()===vendor&&topics[3].toLowerCase()===payer&&BigInt(data)===BigInt(receive.amount));
  check(found,'Receipt does not pay this exact invoice');
  return {height:result.height.toString(),blockHash:result.blockHash};
}
