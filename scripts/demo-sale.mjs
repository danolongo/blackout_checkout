import './compile.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Transaction, getCreateAddress, parseEther, parseUnits, formatEther } from 'ethers';
import { checkout, checkOrder } from '../src/payment.mjs';
import { CHAIN } from '../src/proof.mjs';
import { arcProvider, readFinalPayment } from '../server/chain.mjs';

const artifact = JSON.parse(await readFile('artifacts/contract.json'));
const orderId = '0x424c41434b4f5554434845434b4f5554';
const vendor = '0xC23bA7c7083A41a7389f40AA1eAe41083b32B3d6';
const amount = parseEther('0.01');
const fees = { chainId: CHAIN, type: 2, maxFeePerGas: parseUnits('100','gwei'), maxPriorityFeePerGas: parseUnits('1','gwei') };
const payData = checkout.encodeFunctionData('pay', [vendor, orderId]);

async function execute(provider, packet) {
  assert.equal((await provider.getNetwork()).chainId, BigInt(CHAIN));
  const deploy = Transaction.from(packet.deployment), pay = Transaction.from(packet.purchase);
  const target = getCreateAddress({from: deploy.from, nonce: 0});
  assert.equal(target, packet.contract);
  assert.equal(deploy.from, packet.fund);
  assert.equal(pay.from, deploy.from);
  for (const tx of [deploy,pay]) {
    assert.equal(tx.chainId, BigInt(CHAIN));
    assert.equal(tx.type, 2);
    assert.equal(tx.maxFeePerGas, fees.maxFeePerGas);
    assert.equal(tx.maxPriorityFeePerGas, fees.maxPriorityFeePerGas);
  }
  assert.equal(deploy.to, null);
  assert.equal(deploy.data, artifact.bytecode);
  assert.equal(deploy.nonce, 0);
  assert.equal(deploy.value, 0n);
  assert.equal(deploy.gasLimit, 500000n);
  assert.equal(pay.nonce, 1);
  assert.equal(pay.to, target);
  assert.equal(pay.data, payData);
  assert.equal(pay.value, amount);
  assert.equal(pay.gasLimit, 120000n);

  for (const tx of [deploy, pay]) {
    let receipt = await provider.getTransactionReceipt(tx.hash);
    if (!receipt) {
      if (!await provider.getTransaction(tx.hash)) {
        const required = tx.value + tx.gasLimit * tx.maxFeePerGas;
        const balance = await provider.getBalance(packet.fund);
        if (balance < required) return {status:'awaiting funding', fund:packet.fund, balance:formatEther(balance), budgetUSDC:'0.072'};
        try {
          await provider.broadcastTransaction(tx.serialized);
        } catch (error) {
          if (!await provider.getTransaction(tx.hash)) throw error;
        }
      }
      receipt = await provider.waitForTransaction(tx.hash, 1, 60000);
    }
    assert.equal(receipt?.status, 1, 'Transaction failed or timed out');
  }
  for (let attempt=0; attempt<20; attempt++) {
    try {
      const receipt = await readFinalPayment(provider,target,pay.hash,artifact.runtime);
      checkOrder(receipt,{chain:CHAIN,id:orderId,contract:target,vendor,amount:String(amount)});
      assert.equal(receipt.payer,packet.fund);
      return {status:'verified',contract:target,deployment:deploy.hash,purchase:pay.hash,receipt};
    } catch(error) {
      if (error.message !== 'Awaiting finality' || attempt===19) throw error;
      await delay(1000);
    }
  }
}

{
  const packet = JSON.parse(await readFile('fixtures/demo-sale.json'));
  let server;
  let provider;
  try {
    if (process.argv.includes('--rehearse')) {
      const ganache = (await import('ganache')).default;
      server = ganache.server({chain:{chainId:CHAIN},logging:{quiet:true}});
      await server.listen(0,'127.0.0.1');
      provider = arcProvider('http://127.0.0.1:'+server.address().port);
      provider.pollingInterval = 150;
      assert.equal((await execute(provider, packet)).status, 'awaiting funding');
      await (await (await provider.getSigner()).sendTransaction({to:packet.fund,value:parseEther('0.072')})).wait();
      await delay(400);
      const first = await execute(provider,packet);
      assert.equal(first.status,'verified');
      assert.deepEqual(await execute(provider,packet),first);
      console.log('Rehearsal passed: unfunded wallet, deployment, purchase, final receipt and idempotent retry');
    } else {
      provider = arcProvider(process.env.ARC_RPC);
      const result = await execute(provider,packet);
      await writeFile('artifacts/live-sale.json',JSON.stringify(result,null,2));
      console.log('ARC_DEMO_RESULT',JSON.stringify(result));
    }
  } finally {
    provider?.destroy();
    if (server) await server.close();
  }
}
