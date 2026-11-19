import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ganache from 'ganache';
import {BrowserProvider,ContractFactory,hexlify,randomBytes} from 'ethers';
import '../scripts/compile.mjs';
import {findPayment,checkOrder} from '../src/payment.mjs';

test('a sale forwards exactly once and a different amount cannot reserve its terms',async()=>{
  const chain=ganache.provider({logging:{quiet:true}});
  try {
    const p=new BrowserProvider(chain); p.pollingInterval=30;
    const buyer=await p.getSigner(0),vendor=await (await p.getSigner(1)).getAddress();
    const c=JSON.parse(await readFile('artifacts/contract.json'));
    const contract=await new ContractFactory(c.abi,c.bytecode,buyer).deploy();await contract.waitForDeployment();
    const id=hexlify(randomBytes(16)),addr=await contract.getAddress();
    const balance=async()=>BigInt(await chain.request({method:'eth_getBalance',params:[vendor,'latest']}));
    const before=await balance();
    await (await contract.pay(vendor,id,{value:1n})).wait();
    const receipt=await (await contract.pay(vendor,id,{value:5n})).wait();
    const payment=findPayment(receipt.logs,addr);
    checkOrder(payment,{id,vendor,contract:addr,chain:5042002,amount:'5'});
    assert.throws(()=>checkOrder(payment,{...payment,id:hexlify(randomBytes(16))}));
    await assert.rejects(async()=>{await (await contract.pay(vendor,id,{value:5n,gasLimit:120000})).wait()});
    assert.equal(await balance(),before+6n);
  } finally {await chain.disconnect();}
});
