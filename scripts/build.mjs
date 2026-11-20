import {build} from 'esbuild';
import {mkdir,writeFile,copyFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {keccak256} from 'ethers';
import {RPC} from '../src/settlement.mjs';
import './compile.mjs';
await mkdir('dist',{recursive:true});
// Pinned into the register so reconciliation never trusts an RPC or bytecode the relay hands out.
const arc={rpc:process.env.PUBLIC_ARC_RPC||RPC,codeHash:keccak256(JSON.parse(await readFile('artifacts/contract.json')).runtime)};
await build({entryPoints:['web/app.mjs'],outfile:'dist/app.js',bundle:true,inject:['web/shim.mjs'],define:{'process.browser':'true','process.env.NODE_ENV':'"production"','__ARC__':JSON.stringify(arc)},minify:true,format:'esm',platform:'browser',target:['safari16']});
const assets=['/','/app.js','/style.css'];
await Promise.all(['index.html','style.css'].map(f=>copyFile('web/'+f,'dist/'+f)));
const hash=createHash('sha256');
for(const file of ['index.html','app.js','style.css']) hash.update(await readFile('dist/'+file));
const cache='blackout-'+hash.digest('hex').slice(0,16);
await writeFile('dist/sw.js',`
const cacheName=${JSON.stringify(cache)};
self.addEventListener('install',e=>e.waitUntil(caches.open(cacheName).then(c=>c.addAll(${JSON.stringify(assets)})).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('blackout-')&&k!==cacheName).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==self.location.origin||u.pathname.startsWith('/api/'))return;
  if(e.request.mode==='navigate')e.respondWith(caches.open(cacheName).then(c=>c.match('/')).then(r=>r||fetch(e.request)));
  else e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
});`);
