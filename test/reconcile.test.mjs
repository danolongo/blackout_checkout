import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ganache from 'ganache';
import {BrowserProvider,ContractFactory,hexlify,keccak256,randomBytes} from 'ethers';
import '../scripts/compile.mjs';
import {arcProvider,readFinalPayment} from '../src/settlement.mjs';
import {MISSING_AFTER,discrepancies,reconcileSale} from '../src/reconcile.mjs';

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
    // A fresh provider skips ethers' short request cache after the test moves the chain forward.
    await fn({provider,sell,address,buyer,later:()=>new BrowserProvider(chain)});
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

test('a missing transaction stays pending until Arc is well past its claimed block',()=>arc(async({provider,sell,later})=>{
  const sale=await sell(), forged={...sale,bundle:{receipt:{...sale.bundle.receipt,txHash:'0x'+'33'.repeat(32)}}};
  assert.deepEqual((await reconcileSale(provider,forged,codeHash)).state,'pending');
  await provider.send('evm_increaseTime',[MISSING_AFTER+60]);await provider.send('evm_mine',[]);
  assert.deepEqual((await reconcileSale(later(),forged,codeHash)).issues,['Transaction not found on Arc']);
}));

test('unrelated and foreign contract transactions are discrepancies',()=>arc(async({provider,sell,buyer})=>{
  const sale=await sell(), receipt=sale.bundle.receipt;
  const transfer=await (await buyer.sendTransaction({to:sale.vendor,value:7n})).wait();
  const unrelated=await reconcileSale(provider,{...sale,bundle:{receipt:{...receipt,txHash:transfer.hash}}},codeHash);
  assert.deepEqual(unrelated.issues,['Expected one payment from the checkout contract']);
  const wrongCode=await reconcileSale(provider,sale,keccak256('0x00'));
  assert.deepEqual(wrongCode.issues,['Unrecognized checkout bytecode']);
  const empty=await reconcileSale(provider,{...sale,bundle:undefined},codeHash);
  assert.equal(empty.state,'discrepancy');
  await assert.rejects(()=>reconcileSale(provider,{...sale,status:'open'},codeHash));
  assert.throws(()=>discrepancies({chain:1},{},{}));
}));

test('a block that is not final yet still exposes mismatched receipts',()=>arc(async({provider,sell})=>{
  const sale=await sell();
  const lagging=new Proxy(provider,{get:(target,key)=>key==='getBlock'
    ?tag=>tag==='finalized'?target.getBlock(sale.bundle.receipt.height-1):target.getBlock(tag)
    :typeof target[key]==='function'?target[key].bind(target):target[key]});
  assert.equal((await reconcileSale(lagging,sale,codeHash)).state,'pending');
  const tampered={...sale,bundle:{receipt:{...sale.bundle.receipt,payer:'0x'+'11'.repeat(20)}}};
  assert.deepEqual((await reconcileSale(lagging,tampered,codeHash)).issues,['Receipt payer differs from Arc']);
}));

test('an unreachable or wrong RPC leaves sales unchecked instead of flagging them',async()=>{
  const sale={chain:5042002,status:'paid',contract:'0x'+'44'.repeat(20),bundle:{receipt:{txHash:'0x'+'55'.repeat(32),time:1}}};
  const refused=await reconcileSale(arcProvider('http://127.0.0.1:9',2000),sale,codeHash).catch(e=>e);
  assert.ok(refused instanceof Error && !refused.invalid,'connection refused must throw, not flag');
  const otherChain={send:async()=>'0x1'};
  await assert.rejects(()=>reconcileSale(otherChain,sale,codeHash),/Wrong RPC network/);
});
