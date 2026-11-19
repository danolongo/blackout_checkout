import { JsonRpcProvider,getAddress,isHexString,keccak256 } from 'ethers';
import { CHAIN,check } from '../src/proof.mjs';
import { findPayment,paymentFromLog } from '../src/payment.mjs';

export function arcProvider(url) {
  return new JsonRpcProvider(url||'https://rpc.testnet.arc.io',undefined,{batchMaxCount:1});
}
export async function readFinalPayment(provider,contract,txHash,expectedRuntime) {
  check(isHexString(txHash,32),'Invalid transaction hash');
  const network=await provider.getNetwork();
  check(network.chainId===BigInt(CHAIN),'Wrong RPC network');
  const receipt=await provider.getTransactionReceipt(txHash);
  check(receipt && receipt.status===1,'Transaction missing or failed');
  const [block,finalized,code]=await Promise.all([provider.getBlock(receipt.blockNumber),
    provider.getBlock('finalized'),provider.getCode(contract,receipt.blockNumber)]);
  check(block && finalized && block.hash===receipt.blockHash && finalized.number>=block.number,'Awaiting finality');
  check(code!=='0x' && keccak256(code)===keccak256(expectedRuntime),'Unrecognized checkout bytecode');
  const payment=findPayment(receipt.logs,contract);
  const log=receipt.logs.find(l=>paymentFromLog(l,contract));
  return {...payment,version:1,mode:'relay',txHash:receipt.hash,blockHash:block.hash,height:block.number,
    time:block.timestamp,logIndex:log.index};
}
