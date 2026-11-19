import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {Wallet,JsonRpcProvider,Contract,parseUnits,formatUnits,randomBytes,hexlify,getAddress} from 'ethers';
import {checkout,orderTerms} from '../src/payment.mjs';
import {verifyRelay} from '../src/attestation.mjs';
import {get,save,consume,allOrders} from './store.mjs';

const $=id=>document.getElementById(id), box=$('content'), qr=$('qr');
let config,order,stream,mode='merchant',scanner=0,busy=false,cacheReady=false;
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
  stop();const generation=scanner;const video=$('camera'),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
  const media=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
  if(generation!==scanner){media.getTracks().forEach(t=>t.stop());return;}
  stream=media;video.srcObject=media;video.hidden=false;$('stop').hidden=false;await video.play();
  const frame=async()=>{if(generation!==scanner)return;
    if(video.readyState>=2){canvas.width=Math.min(800,video.videoWidth);canvas.height=canvas.width*video.videoHeight/video.videoWidth;
      ctx.drawImage(video,0,0,canvas.width,canvas.height);const px=ctx.getImageData(0,0,canvas.width,canvas.height);
      const code=jsQR(px.data,px.width,px.height);if(code){stop();try{await fn(code.data);}catch(e){notice(e.message,true);}return;}}
    requestAnimationFrame(frame);};frame();
}
async function api(path){const response=await fetch(path,{cache:'no-store',signal:AbortSignal.timeout(20000)});const json=await response.json();
  if(!response.ok)throw Error(json.error||'Server unavailable');return json;}
function matchConfig(o){orderTerms(o);if(!config||getAddress(o.contract)!==getAddress(config.contract))throw Error('Unknown checkout contract');}
function parseOrder(text){const url=new URL(text);if(url.origin!==location.origin||!url.hash.startsWith('#order='))throw Error('Unknown order link');
  const o=JSON.parse(decodeURIComponent(url.hash.slice(7)));matchConfig(o);return o;}
async function takeProof(text){
  const bundle=JSON.parse(text),target=await get('orders',bundle.receipt.id);
  if(!target)throw Error('This register did not create that order');
  if(target.status!=='open')throw Error('Already used');
  await verifyRelay(bundle,target,target.relayKey);
  await consume(target,bundle);view('Payment accepted','merchant');line(formatUnits(target.amount,18)+' test USDC');
  notice('Relay confirmed · verified on this register');button('New sale',merchant);
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
  const provider=new JsonRpcProvider(config.rpc,undefined,{batchMaxCount:1}), wallet=new Wallet(key,provider);
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
        if((await provider.getNetwork()).chainId!==BigInt(config.chain))throw Error('Wrong payment network');
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
async function sales(){view('Register sales','sales');const orders=await allOrders();if(!orders.length)line('No sales yet.');
  for(const o of orders.reverse()){const item=el('article',formatUnits(o.amount,18)+' USDC · '+o.status);
    item.append(el('small',o.id));box.append(item);}}
function route(fn){return ()=>fn().catch(e=>notice(e.message,true));}
$('merchant').onclick=route(merchant);$('customer').onclick=route(()=>customer());$('sales').onclick=route(sales);$('stop').onclick=stop;
async function init(){
  config=await get('settings','config');
  if(!config){try{config=await api('/api/config');await save('settings','config',config);}catch{notice('Connect once to set up this register',true);return;}}
  if('serviceWorker' in navigator){await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;cacheReady=true;}
  if(location.hash.startsWith('#order='))return customer(parseOrder(location.href));
  await merchant();
}
init().catch(e=>notice(e.message,true));
