import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ganache from 'ganache';
import {BrowserProvider,ContractFactory,hexlify,keccak256,randomBytes} from 'ethers';
import '../scripts/compile.mjs';
import {readFinalPayment} from '../src/settlement.mjs';
import {discrepancies,offline,reconcileSale,reusedTransactions} from '../src/reconcile.mjs';

const c=JSON.parse(await readFile('artifacts/contract.json'));
const codeHash=keccak256(c.runtime);
async function arc(fn) {
  const chain=ganache.provider({logging:{quiet:true},chain:{chainId:5042002}});
  try {
    const provider=new BrowserProvider(chain); provider.pollingInterval=30;
    const buyer=await provider.getSigner(0), vendor=await (await provider.getSigner(1)).getAddress();
    const contract=await new ContractFactory(c.abi,c.bytecode,buyer).deploy(); await contract.waitForDeployment();
    const address=await contract.getAddress();
    async function sell(amount='7') {
      const id=hexlify(randomBytes(16));
      const tx=await (await contract.pay(vendor,id,{value:BigInt(amount)})).wait();
      const receipt=await readFinalPayment(provider,address,tx.hash,codeHash);
      const order={chain:5042002,contract:address,vendor,id,amount,created:0,expires:2**40};
      return {...order,status:'paid',bundle:{receipt,signature:''}};
    }
    await fn({provider,sell,address,buyer});
  } finally { await chain.disconnect(); }
}

test('an accepted sale that matches Arc is confirmed',()=>arc(async({provider,sell})=>{
  const sale=await sell();
  const result=await reconcileSale(provider,sale,codeHash,1234);
  assert.deepEqual(result,{state:'confirmed',issues:[],checkedAt:1234});
}));

test('every signed field that disagrees with Arc is flagged',()=>arc(async({provider,sell})=>{
  const sale=await sell();
  for(const [key,value] of [['amount','8'],['payer','0x'+'11'.repeat(20)],['blockHash','0x'+'22'.repeat(32)],
    ['height',sale.bundle.receipt.height+1],['time',sale.bundle.receipt.time+1],['logIndex',9]]) {
    const tampered={...sale,bundle:{...sale.bundle,receipt:{...sale.bundle.receipt,[key]:value}}};
    const result=await reconcileSale(provider,tampered,codeHash);
    assert.equal(result.state,'discrepancy',key);
    assert.deepEqual(result.issues,[`Receipt ${key} differs from Arc`]);
  }
  const otherOrder=await reconcileSale(provider,{...sale,amount:'9'},codeHash);
  assert.deepEqual(otherOrder.issues,['Arc amount does not match the order']);
}));

test('missing, unrelated and foreign contract transactions are discrepancies',()=>arc(async({provider,sell,buyer})=>{
  const sale=await sell(), receipt=sale.bundle.receipt;
  const missing=await reconcileSale(provider,{...sale,bundle:{receipt:{...receipt,txHash:'0x'+'33'.repeat(32)}}},codeHash);
  assert.deepEqual(missing.issues,['Transaction not found on Arc']);
  const transfer=await (await buyer.sendTransaction({to:sale.vendor,value:7n})).wait();
  const unrelated=await reconcileSale(provider,{...sale,bundle:{receipt:{...receipt,txHash:transfer.hash}}},codeHash);
  assert.deepEqual(unrelated.issues,['Expected one payment from the checkout contract']);
  const wrongCode=await reconcileSale(provider,sale,keccak256('0x00'));
  assert.deepEqual(wrongCode.issues,['Unrecognized checkout bytecode']);
  const empty=await reconcileSale(provider,{...sale,bundle:undefined},codeHash);
  assert.equal(empty.state,'discrepancy');
  await assert.rejects(()=>reconcileSale(provider,{...sale,status:'open'},codeHash));
}));

test('a payment that is not final yet stays pending',()=>arc(async({provider,sell})=>{
  const sale=await sell();
  const lagging=new Proxy(provider,{get:(target,key)=>key==='getBlock'
    ?tag=>tag==='finalized'?target.getBlock(sale.bundle.receipt.height-1):target.getBlock(tag)
    :typeof target[key]==='function'?target[key].bind(target):target[key]});
  assert.equal((await reconcileSale(lagging,sale,codeHash)).state,'pending');
}));

test('losing the connection leaves sales unchecked instead of flagging them',async()=>{
  const down={send:async()=>{throw Object.assign(Error('connect ECONNREFUSED'),{code:'NETWORK_ERROR'});}};
  const sale={chain:5042002,status:'paid',contract:'0x'+'44'.repeat(20),bundle:{receipt:{txHash:'0x'+'55'.repeat(32)}}};
  await assert.rejects(()=>reconcileSale(down,sale,codeHash),{code:'NETWORK_ERROR'});
  assert.ok(offline(new TypeError('Failed to fetch')));
  assert.ok(!offline(Error('Transaction not found on Arc')));
});

test('one transaction accepted for two orders is flagged on both',()=>{
  const sale=(id,txHash)=>({id,bundle:{receipt:{txHash}}});
  const reused=reusedTransactions([sale('a','0xAB'),sale('b','0xab'),sale('c','0xcd'),{id:'d'}]);
  assert.deepEqual([...reused].sort(),['a','b']);
  assert.throws(()=>discrepancies({chain:1},{}, {}));
});
