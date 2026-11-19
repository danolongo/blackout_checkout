import { FetchRequest,JsonRpcProvider,Network,isHexString,keccak256 } from 'ethers';
import { CHAIN,check } from './proof.mjs';
import { findPayment,paymentFromLog } from './payment.mjs';

export const RPC='https://rpc.testnet.arc.io';
export const EXPLORER='https://explorer.testnet.arc.io';
// Static network so an offline register fails fast instead of retrying network detection forever.
export function arcProvider(url,timeout=20000) {
  const request=new FetchRequest(url||RPC);request.timeout=timeout;
  return new JsonRpcProvider(request,Network.from(CHAIN),{staticNetwork:true,batchMaxCount:1});
}
export async function assertArc(provider) {
  check(BigInt(await provider.send('eth_chainId',[]))===BigInt(CHAIN),'Wrong RPC network');
}
// Resolves null while the payment is not yet final; throws when it can never become a valid sale.
export async function readFinalPayment(provider,contract,txHash,codeHash) {
  check(isHexString(txHash,32),'Invalid transaction hash');
  await assertArc(provider);
  const receipt=await provider.getTransactionReceipt(txHash);
  check(receipt,'Transaction not found on Arc');
  check(receipt.status===1,'Transaction failed on Arc');
  const [block,finalized,code]=await Promise.all([provider.getBlock(receipt.blockNumber),
    provider.getBlock('finalized'),provider.getCode(contract,receipt.blockNumber)]);
  check(block && block.hash===receipt.blockHash,'Transaction block changed');
  check(code!=='0x' && keccak256(code)===codeHash,'Unrecognized checkout bytecode');
  const payment=findPayment(receipt.logs,contract);
  const log=receipt.logs.find(l=>paymentFromLog(l,contract));
  if(!finalized || finalized.number<block.number) return null;
  return {...payment,version:1,mode:'relay',txHash:receipt.hash,blockHash:block.hash,height:block.number,
    time:block.timestamp,logIndex:log.index};
}
export const txUrl=hash=>EXPLORER+'/tx/'+hash;
