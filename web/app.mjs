import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {Wallet,Contract,parseUnits,formatUnits,randomBytes,hexlify,getAddress} from 'ethers';
import {checkout,orderTerms} from '../src/payment.mjs';
import {verifyRelay} from '../src/attestation.mjs';
import {arcProvider,assertArc,txUrl} from '../src/settlement.mjs';
import {offline,reconcileSale,reusedTransactions} from '../src/reconcile.mjs';
import {get,save,consume,reconciled,allOrders} from './store.mjs';

const $=id=>document.getElementById(id), box=$('content'), qr=$('qr');
let config,order,stream,mode='merchant',scanner=0,busy=false,cacheReady=false,syncing=null;
function notice(t,error=false){$('status').textContent=t;$('status').dataset.error=String(error);}
function el(tag,text){const n=document.createElement(tag);n.textContent=text;return n;}
function line(text){box.append(el('p',text));}
function input(label,value='',type='text'){const id='input'+box.children.length,l=el('label',label);
  l.htmlFor=id;const n=el('input','');n.id=id;n.type=type;n.value=value;box.append(l,n);return n;}
function button(label,fn){const b=el('button',label);b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){notice(e.shortMessage||e.message,true);}finally{b.disabled=false;}};box.append(b);return b;}
function stop(){scanner++;if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;$('camera').hidden=true;$('stop').hidden=true;}
function view(title,next){stop();mode=next;$('title').textContent=title;box.replaceChildren();qr.hidden=true;notice('');
  for(const n of ['merchant','customer','sales'])$(n).setAttribute('aria-current',String(n===mode));}
async function draw(s){await QRCode.toCanvas(qr,s,{width:420,margin:4,errorCorrectionLevel:'L'});qr.hidden=false;}
async function scan(fn){
  stop();const generation=scanner,started=performance.now();const video=$('camera'),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
  const media=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
  if(generation!==scanner){media.getTracks().forEach(t=>t.stop());return;}
  stream=media;video.srcObject=media;video.hidden=false;$('stop').hidden=false;await video.play();
  const frame=async()=>{if(generation!==scanner)return;
    if(video.readyState>=2){canvas.width=Math.min(800,video.videoWidth);canvas.height=canvas.width*video.videoHeight/video.videoWidth;
      ctx.drawImage(video,0,0,canvas.width,canvas.height);const px=ctx.getImageData(0,0,canvas.width,canvas.height);
      const code=jsQR(px.data,px.width,px.height);
      if(code){stop();try{await fn(code.data,Math.round(performance.now()-started));}catch(e){notice(e.message,true);}return;}}
    requestAnimationFrame(frame);};frame();
}
async function api(path){const response=await fetch(path,{cache:'no-store',signal:AbortSignal.timeout(20000)});const json=await response.json();
  if(!response.ok)throw Error(json.error||'Server unavailable');return json;}
function matchConfig(o){orderTerms(o);if(!config||getAddress(o.contract)!==getAddress(config.contract))throw Error('Unknown checkout contract');}
function parseOrder(text){const url=new URL(text);if(url.origin!==location.origin||!url.hash.startsWith('#order='))throw Error('Unknown order link');
  const o=JSON.parse(decodeURIComponent(url.hash.slice(7)));matchConfig(o);return o;}
const MODES={relay:'Relay confirmed'};
const seconds=ms=>(ms/1000).toFixed(1)+' s';
async function takeProof(text,scanMs){
  const started=performance.now(),bundle=JSON.parse(text),target=await get('orders',bundle.receipt.id);
  if(!target)throw Error('This register did not create that order');
  if(target.status!=='open')throw Error('Already used');
  await verifyRelay(bundle,target,target.relayKey);
  const verifyMs=Math.round(performance.now()-started);
  await consume(target,bundle,{acceptedAt:Date.now(),scanMs,verifyMs});
  view('Payment accepted','merchant');line(formatUnits(target.amount,18)+' test USDC');
  notice(MODES[bundle.receipt.mode]+' · verified on this register\nScan '+seconds(scanMs)+' · check '+verifyMs+' ms');
  button('New sale',merchant);button('View sale',()=>sale(target.id));
  if(navigator.onLine)reconcileAll().catch(()=>{});
}
async function merchant(){
  view('Open register','merchant');const addr=input('Vendor wallet',await get('settings','vendor')||'');
  const amount=input('Amount in test USDC','','text');amount.inputMode='decimal';
  line('Receipt mode: relay confirmed.');
  button('Create order',async()=>{
    if(!config||!cacheReady)throw Error('Open this register online once to prepare offline checkout');
    const now=Math.floor(Date.now()/1000),vendor=getAddress(addr.value.trim());
    const o={chain:config.chain,contract:config.contract,vendor,id:hexlify(randomBytes(16)),amount:String(parseUnits(amount.value.trim(),18))};
    matchConfig(o);await save('settings','vendor',vendor);await save('orders',o.id,{...o,created:now,expires:now+900,status:'open',relayKey:config.relayKey});
    view('Scan to pay','merchant');line(formatUnits(o.amount,18)+' test USDC');
    await draw(location.origin+'/#order='+encodeURIComponent(JSON.stringify(o)));
    button('Scan payment receipt',()=>scan(takeProof));
  });
  button('Scan existing receipt',()=>scan(takeProof));
}
async function customer(o){
  view(o?'Review order':'Customer wallet','customer');order=o;
  if(!config)throw Error('Reconnect to prepare the customer wallet');
  let key=await get('settings','testKey');if(!key){key=Wallet.createRandom().privateKey;await save('settings','testKey',key);}
  const provider=arcProvider(config.rpc), wallet=new Wallet(key,provider);
  const address=el('code',wallet.address);box.append(el('small','Your testnet wallet'),address);
  const faucet=el('a','Fund with test USDC');faucet.href='https://faucet.circle.com';faucet.target='_blank';faucet.rel='noopener';box.append(el('p',''),faucet);
  if(!o){button('Scan order',()=>scan(t=>customer(parseOrder(t))));return;}
  matchConfig(o);line('Pay '+formatUnits(o.amount,18)+' test USDC to '+o.vendor);
  const pending='sale:'+o.contract+':'+o.id+':'+o.amount;
  button('Pay or retrieve receipt',async()=>{
    if(busy)return;busy=true;
    try{
      let hash=await get('settings',pending);
      if(!hash){
        await assertArc(provider);
        const contract=new Contract(o.contract,checkout,wallet);
        notice('Sending test USDC…');const tx=await contract.pay(o.vendor,o.id,{value:BigInt(o.amount)});
        hash=tx.hash;await save('settings',pending,hash);
      }
      notice('Waiting for payment and relay confirmation…');
      const receipt=await provider.waitForTransaction(hash,1,45000);
      if(!receipt)throw Error('Still confirming. Tap again to retrieve the same payment.');
      if(receipt.status!==1){await save('settings',pending,null);throw Error('Payment failed on chain');}
      const signed=await api('/api/receipt/'+hash);await verifyRelay(signed,{...o,created:0,expires:Number.MAX_SAFE_INTEGER},config.relayKey);
      const saved=JSON.stringify(signed);await save('settings','lastProof',saved);
      view('Show your receipt','customer');line('The merchant can scan this without internet.');await draw(saved);
    }finally{busy=false;}
  });
}
const STATES={unchecked:'Not yet checked against Arc',pending:'Awaiting Arc finality',confirmed:'Confirmed on Arc',
  discrepancy:'Discrepancy: do not rely on this sale',open:'Open, awaiting payment',expired:'Expired unpaid'};
const stateOf=o=>o.status==='paid'?o.reconciliation?.state||'unchecked':o.expires*1000<Date.now()?'expired':o.status;
const when=t=>new Date(t).toLocaleString();
function field(list,name,value){if(value==null)return;const row=el('div','');row.append(el('dt',name));
  const d=el('dd','');d.append(value instanceof Node?value:document.createTextNode(String(value)));row.append(d);list.append(row);}
// The cached checkout config predates the code hash; accept it from the relay only for the same pinned trust root.
async function checkoutCode(){
  if(config.codeHash)return config.codeHash;
  const fresh=await api('/api/config');
  if(fresh.chain!==config.chain||getAddress(fresh.contract)!==getAddress(config.contract)||
    fresh.relayKey.x!==config.relayKey.x||fresh.relayKey.y!==config.relayKey.y)throw Error('Relay configuration changed. Set up this register again.');
  config={...config,codeHash:fresh.codeHash};await save('settings','config',config);return config.codeHash;
}
// Rechecks every accepted sale against Arc directly, independent of the relay that signed the receipts.
function reconcileAll(only){
  syncing??=(async()=>{
    const all=await allOrders(),paid=all.filter(o=>o.status==='paid'&&(!only||o.id===only)),reused=reusedTransactions(all);
    if(!paid.length)return 0;
    const provider=arcProvider(config.rpc,15000),code=await checkoutCode();
    for(const o of paid){
      const result=await reconcileSale(provider,o,code);
      if(reused.has(o.id)){result.state='discrepancy';result.issues.push('Transaction also accepted for another order');}
      await reconciled(o.id,result);
    }
    return paid.length;
  })().finally(()=>{syncing=null;});
  return syncing;
}
function reconcileButton(label,id,after){
  button(label,async()=>{
    if(!navigator.onLine)throw Error('Reconnect this register to check sales against Arc');
    notice('Checking against Arc…');
    try{await reconcileAll(id);}
    catch(e){if(offline(e))throw Error('Arc is unreachable. Sales stay unchecked until the register reconnects.');throw e;}
    await after();
  });
}
async function sales(){
  view('Register sales','sales');const orders=(await allOrders()).sort((a,b)=>b.created-a.created);
  if(!orders.length)return line('No sales yet.');
  const count=state=>orders.filter(o=>stateOf(o)===state).length,plural=(n,one,many)=>n+' '+(n>1?many:one);
  const flagged=count('discrepancy'),unchecked=count('unchecked')+count('pending'),confirmed=count('confirmed');
  const [overall,summary]=flagged?['discrepancy',plural(flagged,'sale needs','sales need')+' attention']
    :unchecked?['unchecked',plural(unchecked,'sale is','sales are')+' not yet confirmed on Arc']
    :confirmed?['confirmed',plural(confirmed,'accepted sale','accepted sales')+' confirmed on Arc']:[];
  if(summary){const badge=el('p',summary);badge.className='badge';badge.dataset.state=overall;box.append(badge);
    reconcileButton('Check all sales against Arc',null,sales);}
  for(const o of orders){
    const state=stateOf(o),item=el('button','');item.className='sale';item.dataset.state=state;
    item.append(el('strong',formatUnits(o.amount,18)+' test USDC'),el('span',STATES[state]),
      el('small',(o.acceptedAt?when(o.acceptedAt):when(o.created*1000))+' · '+o.id.slice(0,10)+'…'));
    item.onclick=route(()=>sale(o.id));box.append(item);
  }
}
async function sale(id){
  const o=await get('orders',id);if(!o)throw Error('Unknown sale');
  view('Sale '+formatUnits(o.amount,18)+' USDC','sales');const state=stateOf(o),r=o.bundle?.receipt,list=el('dl','');
  const badge=el('p',STATES[state]);badge.className='badge';badge.dataset.state=state;box.append(badge);
  if(o.reconciliation?.issues?.length){const issues=el('ul','');for(const i of o.reconciliation.issues)issues.append(el('li',i));box.append(issues);}
  field(list,'Order',o.id);field(list,'Vendor',o.vendor);field(list,'Created',when(o.created*1000));
  if(r){
    const link=el('a',r.txHash);link.href=txUrl(r.txHash);link.target='_blank';link.rel='noopener';
    field(list,'Transaction',link);field(list,'Payer',r.payer);field(list,'Block',r.height+' · '+when(r.time*1000));
    field(list,'Verified as',MODES[r.mode]||r.mode);field(list,'Accepted',o.acceptedAt&&when(o.acceptedAt));
    field(list,'Scan time',o.scanMs!=null?seconds(o.scanMs):null);field(list,'Check time',o.verifyMs!=null?o.verifyMs+' ms':null);
    field(list,'Last Arc check',o.reconciliation&&when(o.reconciliation.checkedAt));
  }
  box.append(list);
  if(o.status==='paid')reconcileButton('Check against Arc',id,async()=>{await sale(id);notice('Checked against Arc at '+when(Date.now()));});
  button('All sales',sales);
}
function route(fn){return ()=>fn().catch(e=>notice(e.message,true));}
$('merchant').onclick=route(merchant);$('customer').onclick=route(()=>customer());$('sales').onclick=route(sales);$('stop').onclick=stop;
// Reconnecting the register reconciles accepted sales without the cashier asking.
addEventListener('online',()=>{if(config)reconcileAll().then(n=>{if(n&&mode==='sales')return sales();}).catch(()=>{});});
async function init(){
  config=await get('settings','config');
  if(!config){try{config=await api('/api/config');await save('settings','config',config);}catch{notice('Connect once to set up this register',true);return;}}
  if('serviceWorker' in navigator){await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;cacheReady=true;}
  if(location.hash.startsWith('#order='))return customer(parseOrder(location.href));
  await merchant();
  if(navigator.onLine)reconcileAll().catch(()=>{});
}
init().catch(e=>notice(e.message,true));
