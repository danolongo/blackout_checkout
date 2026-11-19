import './compile.mjs';
import { Wallet, ContractFactory, getCreateAddress,parseUnits } from 'ethers';
import { readFile,writeFile } from 'node:fs/promises';
import { arcProvider } from '../server/chain.mjs';
import { CHAIN } from '../src/proof.mjs';
const c=JSON.parse(await readFile('artifacts/contract.json'));
const provider=arcProvider(process.env.ARC_RPC);
if (process.argv.includes('--prepare')) {
  // Only this exact testnet contract creation can be broadcast. No key is stored.
  const w=Wallet.createRandom();
  const raw=await w.signTransaction({chainId:CHAIN,type:2,nonce:0,data:c.bytecode,gasLimit:500000n,
    maxFeePerGas:parseUnits('60','gwei'),maxPriorityFeePerGas:parseUnits('1','gwei'),value:0n});
  const item={network:CHAIN,fund:w.address,contract:getCreateAddress({from:w.address,nonce:0}),maximumGasUSDC:'0.03',raw};
  await writeFile('artifacts/deployment-request.json',JSON.stringify(item,null,2));
  console.log('Fund only with Arc TESTNET USDC:',w.address,'Target:',item.contract);
} else {
  if ((await provider.getNetwork()).chainId!==BigInt(CHAIN)) throw Error('Use Arc Testnet');
  if (!process.env.ARC_TESTNET_KEY) throw Error('Set a dedicated funded ARC_TESTNET_KEY or use --prepare');
  const signer=new Wallet(process.env.ARC_TESTNET_KEY,provider);
  const contract=await new ContractFactory(c.abi,c.bytecode,signer).deploy();
  await contract.waitForDeployment();
  console.log('Contract:',await contract.getAddress(),'Deployment:',contract.deploymentTransaction().hash);
}
