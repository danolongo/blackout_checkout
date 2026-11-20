import { CHAIN,check } from './proof.mjs';
import { orderTerms } from './payment.mjs';
import { readPayment } from './settlement.mjs';

// Every field the relay signed, so any disagreement with Arc is visible to the cashier.
export const RECEIPT_FIELDS=['chain','contract','vendor','id','amount','payer','txHash','blockHash','height','time','logIndex'];
const same=(a,b)=>a!=null && b!=null && String(a).toLowerCase()===String(b).toLowerCase();
export function discrepancies(order,accepted,onchain) {
  const issues=[], terms=orderTerms(order);
  for(const key of Object.keys(terms)) if(!same(terms[key],onchain[key])) issues.push(`Arc ${key} does not match the order`);
  for(const key of RECEIPT_FIELDS) if(!same(accepted?.[key],onchain[key])) issues.push(`Receipt ${key} differs from Arc`);
  return issues;
}
// Arc finalizes in under a second, so a transaction still missing this long after its claimed block was never paid.
export const MISSING_AFTER=120;
// Rechecks one accepted sale against Arc. A sale is flagged only when Arc proves it wrong; when the RPC
// cannot answer reliably this throws and the sale stays unchecked.
export async function reconcileSale(provider,sale,codeHash,now=Date.now()) {
  check(sale.chain===CHAIN && sale.status==='paid','Only accepted sales can be reconciled');
  const accepted=sale.bundle?.receipt, result=(state,issues=[])=>({state,issues,checkedAt:now});
  if(!accepted) return result('discrepancy',['No accepted receipt stored']);
  let read;
  try { read=await readPayment(provider,sale.contract,accepted.txHash,codeHash); }
  catch(error) { if(error.invalid) return result('discrepancy',[error.message]); throw error; }
  if(!read) {
    const head=await provider.getBlock('finalized');
    check(head && Number.isSafeInteger(accepted.time),'Arc RPC returned no finalized block');
    return head.timestamp>accepted.time+MISSING_AFTER ? result('discrepancy',['Transaction not found on Arc'])
      : result('pending',['Arc has not returned this transaction yet']);
  }
  const issues=discrepancies(sale,accepted,read.payment);
  if(issues.length) return result('discrepancy',issues);
  return read.final ? result('confirmed') : result('pending',['Payment matches but its block is not final yet']);
}
