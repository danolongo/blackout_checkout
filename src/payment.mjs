import { Interface, getAddress, isHexString, ZeroAddress } from 'ethers';
import { CHAIN,check } from './proof.mjs';
export const checkout = new Interface([
  'function pay(address vendor,bytes16 orderId) payable',
  'event OrderPaid(bytes16 indexed orderId,address indexed vendor,address indexed payer,uint256 amount)'
]);
export function orderTerms(o) {
  check(o.chain===CHAIN && isHexString(o.id,16) && BigInt(o.id)>0n,'Invalid order');
  const vendor=getAddress(o.vendor), contract=getAddress(o.contract);
  check(vendor!==ZeroAddress && contract!==ZeroAddress,'Invalid recipient');
  check(typeof o.amount==='string' && /^[1-9][0-9]{0,77}$/.test(o.amount) && BigInt(o.amount)<2n**256n,'Invalid amount');
  return {chain:CHAIN,contract,vendor,id:o.id.toLowerCase(),amount:o.amount};
}
export function paymentFromLog(log, contract) {
  if(getAddress(log.address)!==getAddress(contract) || log.topics[0]!==checkout.getEvent('OrderPaid').topicHash) return null;
  const {orderId,vendor,payer,amount}=checkout.parseLog(log).args;
  return {chain:CHAIN,contract:getAddress(contract),vendor,id:orderId.toLowerCase(),payer,amount:String(amount)};
}
export function checkOrder(payment,order) {
  const expected=orderTerms(order), actual=orderTerms(payment);
  for(const key of Object.keys(expected)) check(actual[key]===expected[key],'Receipt does not match this order');
  return actual;
}
export function findPayment(logs,contract) {
  const matches=logs.map(l=>paymentFromLog(l,contract)).filter(Boolean);
  check(matches.length===1,'Expected one payment from the checkout contract');
  return matches[0];
}
