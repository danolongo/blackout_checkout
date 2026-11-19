import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium, webkit} from 'playwright';
import assert from 'node:assert/strict';
const child=spawn(process.execPath,['scripts/rehearse.mjs'],{stdio:'inherit',detached:true});
let browser;
let disconnected = false;
const gateway = http.createServer((request, response) => {
  if (disconnected && request.headers.cookie?.includes('registerDevice=merchant')) {
    request.socket.destroy();
    return;
  }
  const upstream = http.request({hostname:'127.0.0.1',port:4173,path:request.url,
    method:request.method,headers:request.headers}, incoming => {
    response.writeHead(incoming.statusCode,incoming.headers);
    incoming.pipe(response);
  });
  upstream.on('error', () => response.destroy());
  request.pipe(upstream);
});
await new Promise(resolve => gateway.listen(0,'127.0.0.1',resolve));
try{
  const origin='http://127.0.0.1:'+gateway.address().port;let ready=false;
  for(let i=0;i<90;i++){try{const r=await fetch(origin+'/api/config');if(r.ok){ready=true;break;}}catch{}await sleep(300);}
  assert.ok(ready,'Rehearsal server starts');
  const engine = process.env.BROWSER === 'webkit' ? webkit : chromium;
  browser=await engine.launch();const merchant=await browser.newContext(),buyer=await browser.newContext();
  await merchant.addCookies([{name:'registerDevice',value:'merchant',url:origin}]);
  const setDisconnected = async value => {
    disconnected = value;
    if (engine === chromium) await merchant.setOffline(value);
  };
  let m=await merchant.newPage();
  const b=await buyer.newPage();
  m.on('pageerror', error => console.error('Merchant page:', error.message));
  b.on('pageerror', error => console.error('Buyer page:', error.message));
  await m.goto(origin);
  await m.evaluate(() => navigator.serviceWorker.ready);
  await m.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await setDisconnected(true);
  await m.close(); m=await merchant.newPage(); await m.goto(origin);
  assert.equal(await m.evaluate(async()=>{try{await fetch('/api/config',{cache:'no-store'});return true;}catch{return false;}}),false,'Merchant cannot reach the server');
  const verifier = await build({
    entryPoints:['src/proof.mjs'], write:false, bundle:true, inject:['web/shim.mjs'],
    define:{'process.browser':'true','process.env.NODE_ENV':'"production"'},
    format:'iife', globalName:'offlineProof', platform:'browser', target:'safari16'
  });
  await m.addScriptTag({content:verifier.outputFiles[0].text});
  const fixture = JSON.parse(await readFile('test/fixtures/arc.json','utf8'));
  const height = await m.evaluate(async ({proof,cert,snapshot}) => {
    const verified = await window.offlineProof.verifyInclusion(proof,cert,snapshot);
    return Number(verified.height);
  },fixture);
  assert.equal(height,73090654);
  console.log('Offline browser verified the real historical Arc receipt at height',height);
  await m.getByLabel('Vendor wallet').fill('0x0000000000000000000000000000000000000011');
  await m.getByLabel('Amount in test USDC').fill('1');await m.getByRole('button',{name:'Create order'}).click();
  await m.locator('#qr:not([hidden])').waitFor();
  // Read the displayed QR pixels, as opposed to copying a wallet request from browser storage.
  const readQR=async page=>{
    const {default:jsQR}=await import('jsqr');
    const image=await page.locator('#qr').evaluate(c=>({w:c.width,h:c.height,data:Array.from(c.getContext('2d').getImageData(0,0,c.width,c.height).data)}));
    return jsQR(new Uint8ClampedArray(image.data),image.w,image.h).data;
  };
  const order=await readQR(m);await b.goto(order);
  await b.getByRole('button',{name:'Fund rehearsal wallet'}).click();await b.getByText('Rehearsal funds ready',{exact:true}).waitFor();
  await b.getByRole('button',{name:'Pay or retrieve receipt'}).click();
  await b.getByText('Show your receipt',{exact:true}).waitFor({timeout:65000});
  await b.locator('#qr:not([hidden])').waitFor();const signed=await readQR(b);
  await setDisconnected(true);await m.close(); m=await merchant.newPage(); await m.goto(origin);await m.getByRole('button',{name:'Scan existing receipt'}).waitFor();
  // Inject a camera stream from the buyer's actual QR image; both contexts remain isolated.
  const png=await b.locator('#qr').evaluate(c=>c.toDataURL());
  await m.evaluate(async url=>{
    const img=new Image();img.src=url;await img.decode();
    navigator.mediaDevices.getUserMedia=async()=>{
      const c=document.createElement('canvas');c.width=512;c.height=512;const ctx=c.getContext('2d');
      const draw=()=>{ctx.fillStyle='white';ctx.fillRect(0,0,512,512);ctx.drawImage(img,28,28,456,456);};
      draw();const stream=c.captureStream(12);setInterval(draw,80);return stream;
    };
  },png);
  await m.getByRole('button',{name:'Scan existing receipt'}).click();await m.getByText('Payment accepted',{exact:true}).waitFor({timeout:25000});
  await m.getByRole('button',{name:'New sale'}).click();await m.getByRole('button',{name:'Scan existing receipt'}).click();
  await m.getByText('Already used',{exact:true}).waitFor({timeout:25000});
  await setDisconnected(false);await m.getByRole('button',{name:'Sales',exact:true}).click();
  await m.getByRole('button',{name:'Check against Arc'}).click();await m.getByText('confirmed',{exact:true}).waitFor();
  assert.ok(JSON.parse(signed).signature);console.log('Passed: actual QR pixels, payment, offline restart, camera handoff, replay refusal, and reconciliation');
}finally{await browser?.close();gateway.closeAllConnections();gateway.close();try{process.kill(-child.pid,'SIGTERM');}catch{}}
