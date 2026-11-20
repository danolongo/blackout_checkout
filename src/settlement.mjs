import { FetchRequest,JsonRpcProvider,Network,isHexString,keccak256 } from 'ethers';
import { CHAIN,check } from './proof.mjs';
import { paymentFromLog } from './payment.mjs';

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
// Marks a fault Arc has proven in the payment itself, as opposed to an RPC that could not answer.
export function invalid(value,message) {
  if(!value) throw Object.assign(new Error(message),{invalid:true});
}
// Reads a checkout payment from Arc and whether its block is final. Resolves null if the RPC has no such
// transaction. Errors marked invalid mean the transaction can never settle this checkout; any other error
// means Arc could not be read reliably.
export async function readPayment(provider,contract,txHash,codeHash) {
  invalid(isHexString(txHash,32),'Invalid transaction hash');
  await assertArc(provider);
  const receipt=await provider.getTransactionReceipt(txHash);
  if(!receipt) return null;
  invalid(receipt.status===1,'Transaction failed on Arc');
  const [block,finalized,code]=await Promise.all([provider.getBlock(receipt.blockNumber),
    provider.getBlock('finalized'),provider.getCode(contract,receipt.blockNumber)]);
  check(block && block.hash===receipt.blockHash,'Arc RPC returned inconsistent block data');
  invalid(code!=='0x' && keccak256(code)===codeHash,'Unrecognized checkout bytecode');
  const events=receipt.logs.map(log=>[log,paymentFromLog(log,contract)]).filter(([,payment])=>payment);
  invalid(events.length===1,'Expected one payment from the checkout contract');
  const [log,payment]=events[0];
  return {final:Boolean(finalized) && finalized.number>=block.number,
    payment:{...payment,version:1,mode:'relay',txHash:receipt.hash,blockHash:block.hash,height:block.number,
      time:block.timestamp,logIndex:log.index}};
}
// Resolves null while the payment is not yet final; throws when it is missing or can never be a valid sale.
export async function readFinalPayment(provider,contract,txHash,codeHash) {
  const read=await readPayment(provider,contract,txHash,codeHash);
  check(read,'Transaction not found on Arc');
  return read.final?read.payment:null;
}
export const txUrl=hash=>EXPLORER+'/tx/'+hash;
