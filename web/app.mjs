import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {Contract,JsonRpcProvider,Wallet,formatUnits,hexlify,parseUnits,randomBytes} from 'ethers';
import {CHAIN,domain,escrowAbi,match,receiveTypes,receiveValue,sendTypes,sendValue,verifyReceive,verifySend} from '../src/intents.mjs';
import {allOrders,get,save} from './store.mjs';

const $=id=>document.getElementById(id),box=$('content'),qr=$('qr');
let config,stream,scanGeneration=0,current='merchant',syncing=false,cacheReady=false;
function notice(text,error=false){$('status').textContent=text;$('status').dataset.error=String(error);}
function el(tag,text){const n=document.createElement(tag);n.textContent=text;return n;}
function line(text){box.append(el('p',text));}
function input(label,value='',type='text'){
  const id='input'+box.children.length,l=el('label',label),n=el('input','');l.htmlFor=id;n.id=id;n.type=type;n.value=value;
  box.append(l,n);return n;
}
function button(label,fn){const b=el('button',label);b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){notice(e.shortMessage||e.message,true);}finally{b.disabled=false;}};box.append(b);return b;}
function stop(){
  scanGeneration++;const video=$('camera');video.pause();video.srcObject=null;
  if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;video.hidden=true;$('stop').hidden=true;
}
function view(title,section){stop();current=section;$('title').textContent=title;box.replaceChildren();qr.hidden=true;notice('');
  for(const n of ['merchant','customer','sales'])$(n).setAttribute('aria-current',String(n===section));}
async function draw(value){await QRCode.toCanvas(qr,JSON.stringify(value),{width:420,margin:4,errorCorrectionLevel:'L'});qr.hidden=false;}
async function scan(done){
  stop();const generation=scanGeneration,video=$('camera'),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
  const media=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
  if(generation!==scanGeneration){media.getTracks().forEach(t=>t.stop());return;}
  stream=media;video.srcObject=media;video.hidden=false;$('stop').hidden=false;await video.play();
  const frame=async()=>{
    if(generation!==scanGeneration)return;
    if(video.readyState>=2){canvas.width=Math.min(800,video.videoWidth);canvas.height=canvas.width*video.videoHeight/video.videoWidth;
      ctx.drawImage(video,0,0,canvas.width,canvas.height);
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),code=jsQR(pixels.data,pixels.width,pixels.height);
      if(code){stop();try{await done(JSON.parse(code.data));}catch(e){notice(e.message,true);}return;}
    }
    requestAnimationFrame(frame);
  };frame();
}
async function api(path,body){
  const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,
    cache:'no-store',signal:AbortSignal.timeout(20000)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'Server unavailable');return result;
}
async function wallet(){
  let key=await get('settings','walletKey');
  if(!key){key=Wallet.createRandom().privateKey;await save('settings','walletKey',key);}
  return new Wallet(key);
}
function provider(){return new JsonRpcProvider(new URL(config.rpc,location.origin).href,CHAIN,{batchMaxCount:1});}
async function balance(){
  const w=await wallet(),r=await api('/api/balance/'+w.address);
  await save('settings','escrowBalance',r.balance);return BigInt(r.balance);
}
async function reserved(){
  const orders=await allOrders();return orders.filter(o=>o.role==='customer'&&o.status!=='settled'&&o.status!=='expired')
    .reduce((n,o)=>n+BigInt(o.send.amount),0n);
}
async function sync(){
  if(syncing||!config||!navigator.onLine)return;syncing=true;
  try{
    for(const order of await allOrders()){
      const intent=order.role==='merchant'?order.receive:order.send;
      if(!intent)continue;
      if(!order.uploaded&&Math.floor(Date.now()/1000)>intent.deadline){
        order.status='expired';order.error='Intent expired before upload';await save('orders',intent.id,order);continue;
      }
      let state;
      try{
        if(!order.uploaded){state=await api('/api/intents',intent);order.uploaded=true;}
        else state=await api('/api/status/'+intent.vendor+'/'+intent.id);
        order.status=state.status;order.txHash=state.txHash;order.error=state.error;
        await save('orders',intent.id,order);
      }catch(e){order.error=e.message;await save('orders',intent.id,order);}
    }
    try{await balance();}catch{}
    if(current==='sales')await sales();
  }finally{syncing=false;}
}
function requireReady(){if(!config||config.mode!=='delayed-escrow'||!cacheReady)throw Error('Open this app online once before using it offline');}
async function merchant(){
  view('Receive offline','merchant');const w=await wallet();line('Merchant wallet');box.append(el('code',w.address));
  line('Create a receive request. The buyer will scan it, sign a matching send intent, then show it back to you. Both phones can be offline.');
  const amount=input('Amount in test USDC');amount.inputMode='decimal';
  button('Create receive QR',async()=>{
    requireReady();const value=String(parseUnits(amount.value.trim(),18));if(BigInt(value)<=0n)throw Error('Enter an amount');
    const base={v:2,kind:'receive',chain:CHAIN,contract:config.contract,id:hexlify(randomBytes(16)),vendor:w.address,
      amount:value,deadline:Math.floor(Date.now()/1000)+86400};
    const signature=await w.signTypedData(domain(config.contract),receiveTypes,receiveValue(base));
    const receive=verifyReceive({...base,signature},config.contract);
    await save('orders',receive.id,{role:'merchant',receive,status:'local',uploaded:false,created:Date.now()});
    await merchantOrder(receive.id);
  });
  button('Scan customer send QR',()=>scan(acceptSend));
  button('Sync queued receives',sync);
}
async function merchantOrder(id){
  const order=await get('orders',id);view('Show receive QR','merchant');
  line(formatUnits(order.receive.amount,18)+' test USDC · expires '+new Date(order.receive.deadline*1000).toLocaleString());
  await draw(order.receive);
  button('Scan customer send QR',()=>scan(acceptSend));
  line(order.send?'Customer signature verified locally. Settlement remains pending until both phones reconnect.':'Ask the customer to scan this request and show their signed send QR.');
  button('View queue',sales);
}
async function acceptSend(raw){
  requireReady();const send=verifySend(raw,config.contract),order=await get('orders',send.id);
  if(!order||order.role!=='merchant'||!match(order.receive,send))throw Error('Send does not match this receive request');
  if(Math.floor(Date.now()/1000)>send.deadline)throw Error('Request expired');
  if(order.send&&order.send.signature!==send.signature)throw Error('Different customer already signed this order');
  order.send=send;order.status='local_match';await save('orders',send.id,order);
  view('Matched locally','merchant');line(formatUnits(send.amount,18)+' test USDC from '+send.payer);
  line('Both signatures match. Payment is pending until the two intents reach the matcher and Arc settles it.');
  button('View queue',sales);
}
async function customer(){
  view('Send offline','customer');const w=await wallet();line('Customer wallet');box.append(el('code',w.address));
  const cached=await get('settings','escrowBalance');line('Prepaid on Arc: '+formatUnits(BigInt(cached||0),18)+' test USDC (last sync)');
  button('Scan merchant receive QR',()=>scan(reviewReceive));
  line('Prepay while online. The signed send QR works offline after that.');
  const faucet=el('a','Get Arc Testnet USDC');faucet.href='https://faucet.circle.com';faucet.target='_blank';faucet.rel='noopener';box.append(faucet);
  const amount=input('Prepay test USDC','','text');amount.inputMode='decimal';
  button('Deposit to Arc escrow',async()=>{
    requireReady();const value=parseUnits(amount.value.trim(),18);if(value<=0n)throw Error('Enter an amount');
    const contract=new Contract(config.contract,escrowAbi,(await wallet()).connect(provider()));
    notice('Depositing on Arc…');await(await contract.deposit({value})).wait();
    notice('Prepaid balance: '+formatUnits(await balance(),18)+' test USDC');
  });
  button('Withdraw unused balance',async()=>{
    requireReady();const value=parseUnits(amount.value.trim(),18);if(value<=0n)throw Error('Enter an amount');
    if(value>await balance()-await reserved())throw Error('Keep enough prepaid funds for pending sends');
    const contract=new Contract(config.contract,escrowAbi,(await wallet()).connect(provider()));
    notice('Withdrawing from Arc…');await(await contract.withdraw(value)).wait();
    notice('Prepaid balance: '+formatUnits(await balance(),18)+' test USDC');
  });
  button('Refresh prepaid balance',async()=>{notice('Prepaid balance: '+formatUnits(await balance(),18)+' test USDC');});
  button('Sync queued sends',sync);
  const recovery=el('details',''),summary=el('summary','Wallet recovery');recovery.append(summary);
  const hint=el('p','Testnet only. Back up this key before storing funds; clearing browser data can remove it.');recovery.append(hint);
  const reveal=el('button','Show recovery key');reveal.onclick=async()=>{reveal.after(el('code',(await wallet()).privateKey));reveal.remove();};recovery.append(reveal);
  const restore=el('input','');restore.type='password';restore.placeholder='Paste a testnet recovery key';restore.setAttribute('aria-label','Testnet recovery key');recovery.append(restore);
  const importButton=el('button','Import key');importButton.onclick=async()=>{
    try{if((await allOrders()).some(o=>o.receive||o.send))throw Error('Use a fresh browser profile to import a different wallet');
      const imported=new Wallet(restore.value.trim());await save('settings','walletKey',imported.privateKey);
      await save('settings','escrowBalance',undefined);await customer();}catch(e){notice(e.message,true);}
  };recovery.append(importButton);box.append(recovery);
}
async function reviewReceive(raw){
  requireReady();const receive=verifyReceive(raw,config.contract);
  if(Math.floor(Date.now()/1000)>receive.deadline)throw Error('Request expired');
  if(await get('orders',receive.id))throw Error('This order is already in this wallet');
  view('Review send','customer');line(formatUnits(receive.amount,18)+' test USDC to '+receive.vendor);
  line('This creates a signed pending payment. Arc moves the prepaid funds only after both phones upload matching intents.');
  button('Authorize offline send',async()=>{
    const cached=await get('settings','escrowBalance');
    if(cached===undefined)throw Error('Prepay and sync your Arc balance before going offline');
    if(BigInt(cached)-await reserved()<BigInt(receive.amount))throw Error('Not enough prepaid balance after local pending sends');
    const w=await wallet(),base={...receive,kind:'send',payer:w.address};delete base.signature;
    const signature=await w.signTypedData(domain(config.contract),sendTypes,sendValue(base));
    const send=verifySend({...base,signature},config.contract);
    await save('orders',send.id,{role:'customer',send,status:'local',uploaded:false,created:Date.now()});
    await customerOrder(send.id);
  });
}
async function customerOrder(id){
  const order=await get('orders',id);view('Show send QR','customer');
  line(formatUnits(order.send.amount,18)+' test USDC to '+order.send.vendor);
  await draw(order.send);line('Show this QR to the merchant. This is a signed intent, not a settled payment.');
  button('View queue',sales);
}
async function sales(){
  view('Queued orders','sales');const orders=(await allOrders()).filter(o=>o.receive||o.send).sort((a,b)=>b.created-a.created);
  if(!orders.length)line('No queued orders yet.');
  for(const order of orders){
    const intent=order.receive||order.send,item=el('article','');
    const labels={local:order.role==='merchant'?'Waiting for customer QR':'Send QR ready',
      local_match:'Customer signed locally · pending settlement',
      waiting:order.role==='merchant'?(order.send?'Customer signed locally · waiting for their upload':'Receive uploaded · waiting for customer'):'Send uploaded · waiting for merchant',
      matched:'Both uploads matched · settlement queued',submitted:'Submitted to Arc',settled:'Paid on Arc',
      awaiting_funds:'Waiting for customer prepaid funds',retrying:'Matcher retrying',failed:'Settlement failed',
      expired:'Expired',external_settlement:'Already settled elsewhere — check Arc'};
    item.append(el('strong',formatUnits(intent.amount,18)+' test USDC · '+order.role),
      el('small',labels[order.status]||'Pending settlement'),el('small',intent.id));
    if(order.error)item.append(el('small',order.error));
    if(order.txHash){const link=el('a','View on Arc');link.href='https://explorer.testnet.arc.io/tx/'+order.txHash;link.target='_blank';link.rel='noopener';item.append(link);}
    box.append(item);
    button('Show '+(order.role==='merchant'?'receive':'send')+' QR',()=>order.role==='merchant'?merchantOrder(intent.id):customerOrder(intent.id));
  }
  button('Sync queue now',async()=>{await sync();notice('Queue checked');});
}
function route(fn){return ()=>fn().catch(e=>notice(e.message,true));}
$('merchant').onclick=route(merchant);$('customer').onclick=route(customer);$('sales').onclick=route(sales);$('stop').onclick=stop;
async function init(){
  const saved=await get('settings','config');config=saved?.mode==='delayed-escrow'?saved:null;
  try{const latest=await api('/api/config');if(latest.mode!=='delayed-escrow')throw Error('Wrong checkout version');
    config=latest;await save('settings','config',config);}catch{if(!config){notice('Open this app online once before offline checkout',true);return;}}
  if('serviceWorker' in navigator){if(!await navigator.serviceWorker.getRegistration())await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;cacheReady=true;}
  await merchant();sync().catch(()=>{});
}
window.addEventListener('online',()=>sync().catch(()=>{}));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync().catch(()=>{});});
setInterval(()=>{if(!document.hidden)sync().catch(()=>{});},15000);
init().catch(e=>notice(e.message,true));
