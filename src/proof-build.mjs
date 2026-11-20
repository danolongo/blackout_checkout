import {Trie} from '@ethereumjs/trie';
import {encodeRlp,getBytes,hexlify} from 'ethers';
import {check,encodeHeader,encodeReceipt,quantity} from './proof.mjs';

export async function buildInclusion(block,receipts,index){
  check(Number.isSafeInteger(index)&&index>=0&&index<receipts.length,'Invalid receipt index');
  const trie=new Trie({useKeyHashing:false});
  for(const receipt of receipts){
    check(receipt.blockHash===block.hash,'Receipt from another block');
    await trie.put(getBytes(encodeRlp(quantity(receipt.transactionIndex))),getBytes(encodeReceipt(receipt)));
  }
  check(hexlify(trie.root())===block.receiptsRoot,'Receipt root mismatch');
  const nodes=await trie.createProof(getBytes(encodeRlp(quantity(index))));
  return {header:encodeHeader(block),index,nodes:nodes.map(hexlify)};
}

export async function createSettlementProof(provider,receipt,receive){
  check(receipt?.status===1||receipt?.status==='0x1','Payment has not succeeded');
  const block=await provider.send('eth_getBlockByHash',[receipt.blockHash,false]);
  const receipts=await provider.send('eth_getBlockReceipts',[receipt.blockHash]);
  const certificate=await provider.send('arc_getCertificate',[block.number]);
  check(certificate?.block_hash?.toLowerCase()===receipt.blockHash.toLowerCase(),'Certificate does not finalize payment block');
  const index=Number(receipt.index??receipt.transactionIndex);
  const inclusion=await buildInclusion(block,receipts,index);
  return {v:1,kind:'settlement-proof',vendor:receive.vendor,id:receive.id,txHash:receipt.hash,certificate,inclusion};
}
