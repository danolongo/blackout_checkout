import { CHAIN,check } from './proof.mjs';
import { orderTerms } from './payment.mjs';
import { readFinalPayment } from './settlement.mjs';

// Every field the relay signed, so any disagreement with Arc is visible to the cashier.
export const RECEIPT_FIELDS=['chain','contract','vendor','id','amount','payer','txHash','blockHash','height','time','logIndex'];
const same=(a,b)=>a!=null && b!=null && String(a).toLowerCase()===String(b).toLowerCase();
const CONNECTIVITY=new Set(['NETWORK_ERROR','TIMEOUT','SERVER_ERROR','UNKNOWN_ERROR','UNSUPPORTED_OPERATION']);
export function offline(error) {
  return error instanceof TypeError || CONNECTIVITY.has(error?.code);
}
export function discrepancies(order,accepted,onchain) {
  const issues=[], terms=orderTerms(order);
  for(const key of Object.keys(terms)) if(!same(terms[key],onchain[key])) issues.push(`Arc ${key} does not match the order`);
  for(const key of RECEIPT_FIELDS) if(!same(accepted?.[key],onchain[key])) issues.push(`Receipt ${key} differs from Arc`);
  return issues;
}
// Rechecks one accepted sale against Arc. Connectivity failures throw so the sale stays unchecked.
export async function reconcileSale(provider,sale,codeHash,now=Date.now()) {
  check(sale.chain===CHAIN && sale.status==='paid','Only accepted sales can be reconciled');
  const accepted=sale.bundle?.receipt, result=(state,issues=[])=>({state,issues,checkedAt:now});
  if(!accepted) return result('discrepancy',['No accepted receipt stored']);
  let onchain;
  try { onchain=await readFinalPayment(provider,sale.contract,accepted.txHash,codeHash); }
  catch(error) { if(offline(error)) throw error; return result('discrepancy',[error.shortMessage||error.message]); }
  if(!onchain) return result('pending');
  const issues=discrepancies(sale,accepted,onchain);
  return result(issues.length?'discrepancy':'confirmed',issues);
}
// A transaction can settle only one order, so a hash accepted twice is always a discrepancy.
export function reusedTransactions(sales) {
  const seen=new Map();
  for(const s of sales) {
    const hash=s.bundle?.receipt?.txHash?.toLowerCase();
    if(hash) seen.set(hash,[...(seen.get(hash)||[]),s.id]);
  }
  return new Set([...seen.values()].filter(ids=>ids.length>1).flat());
}
