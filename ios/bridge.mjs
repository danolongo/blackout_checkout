import {Interface,Wallet, verifyTypedData, getAddress} from 'ethers';
import {verifyPaymentProof} from '../src/proof.mjs';
const chain = 5042002;
const receiveTypes = {Receive:[{name:'id',type:'bytes16'},{name:'vendor',type:'address'},{name:'amount',type:'uint256'},{name:'deadline',type:'uint64'}]};
const sendTypes = {Send:[{name:'id',type:'bytes16'},{name:'vendor',type:'address'},{name:'payer',type:'address'},{name:'amount',type:'uint256'},{name:'deadline',type:'uint64'}]};
const domain = contract => ({name:'Blackout Checkout',version:'2',chainId:chain,verifyingContract:getAddress(contract)});
function checkReceive(o,contract){
  if(o.v!==2||o.kind!=='receive'||o.chain!==chain||getAddress(o.contract)!==getAddress(contract)||!/^0x[0-9a-fA-F]{32}$/.test(o.id)||!/^\d+$/.test(o.amount)||BigInt(o.amount)<=0n||!Number.isSafeInteger(o.deadline)||o.deadline<=Math.floor(Date.now()/1000))throw Error('Invalid or expired invoice');
  const vendor=getAddress(o.vendor), value={id:o.id,vendor,amount:o.amount,deadline:o.deadline};
  if(verifyTypedData(domain(contract),receiveTypes,value,o.signature)!==vendor)throw Error('Merchant signature invalid');
  return {...o,vendor};
}
window.Blackout={
  validatorSnapshot:(raw,from,to)=>{
    const iface=new Interface(['function getActiveValidatorSet() view returns ((uint8 status,bytes publicKey,uint64 votingPower)[])']);
    const validators=iface.decodeFunctionResult('getActiveValidatorSet',raw)[0]
      .filter(v=>v.status===2n&&v.votingPower>0n)
      .map(v=>({key:v.publicKey.toLowerCase(),power:String(v.votingPower)}));
    return JSON.stringify({chain,from:Number(from),to:Number(to),validators});
  },
  verifyProof:async (proof,receive,send,snapshot)=>JSON.stringify(await verifyPaymentProof(JSON.parse(proof),JSON.parse(receive),JSON.parse(send),JSON.parse(snapshot))),
  address:key=>new Wallet(key).address,
  signDeposit:async (key,contract,amount,nonce,gasPrice)=>{
    const wallet=new Wallet(key);
    return await wallet.signTransaction({to:getAddress(contract),value:BigInt(amount),data:"0xd0e30db0",nonce:Number(BigInt(nonce)),gasLimit:100000n,gasPrice:BigInt(gasPrice),chainId:chain,type:0});
  },
  signWithdraw:async (key,contract,amount,nonce,gasPrice)=>{
    const data=new Interface(['function withdraw(uint256)']).encodeFunctionData('withdraw',[BigInt(amount)]);
    return await new Wallet(key).signTransaction({to:getAddress(contract),data,nonce:Number(BigInt(nonce)),gasLimit:120000n,gasPrice:BigInt(gasPrice),chainId:chain,type:0});
  },
  verifyReceive:async (json,contract)=>JSON.stringify(checkReceive(JSON.parse(json),contract)),
  sign:async(key,json,contract)=>{
    const receive=checkReceive(JSON.parse(json),contract),wallet=new Wallet(key);
    const base={v:2,kind:'send',chain,contract:getAddress(contract),id:receive.id,vendor:receive.vendor,payer:wallet.address,amount:receive.amount,deadline:receive.deadline};
    const value={id:base.id,vendor:base.vendor,payer:base.payer,amount:base.amount,deadline:base.deadline};
    const signature=await wallet.signTypedData(domain(contract),sendTypes,value);
    return JSON.stringify({...base,signature});
  }
};
