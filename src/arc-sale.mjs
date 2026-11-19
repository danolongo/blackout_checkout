import {verifyInclusion,check} from './proof.mjs';
import {checkOrder,findPayment} from './payment.mjs';
export async function verifyArcSale(bundle,order,snapshot){
  const {logs,height,timestamp,blockHash}=await verifyInclusion(bundle.proof,bundle.cert,snapshot);
  const payment=findPayment(logs.map(([address,topics,data])=>({address,topics,data})),order.contract);
  checkOrder(payment,order);
  check(timestamp>=order.created-60 && timestamp<=order.expires,'Receipt outside order window');
  return {...payment,height:Number(height),time:timestamp,blockHash,mode:'arc'};
}
