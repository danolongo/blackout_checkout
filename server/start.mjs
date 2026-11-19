import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {getAddress,keccak256} from 'ethers';
import {RPC,arcProvider,readFinalPayment} from '../src/settlement.mjs';
import {receiptBytes} from '../src/attestation.mjs';
import {CHAIN,check} from '../src/proof.mjs';

const port=Number(process.env.PORT||4173), rpc=process.env.ARC_RPC||RPC;
const contract=getAddress(process.env.CHECKOUT_ADDRESS);
const jwk=JSON.parse(process.env.RELAY_PRIVATE_JWK||await readFile('.env.relay','utf8'));
const signingKey=await webcrypto.subtle.importKey('jwk',jwk,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
const pub={kty:jwk.kty,crv:jwk.crv,x:jwk.x,y:jwk.y};
const provider=arcProvider(rpc);
const codeHash=keccak256(JSON.parse(await readFile('artifacts/contract.json')).runtime);
const assets={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/sw.js':['sw.js','text/javascript'],'/style.css':['style.css','text/css']};
function json(res,status,value) {
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));
}
createServer(async(req,res)=>{
  try{
    const path=new URL(req.url,'http://localhost').pathname;
    if(req.method!=='GET')return json(res,405,{error:'Use GET'});
    if(path==='/api/config')return json(res,200,{chain:CHAIN,contract,relayKey:pub,mode:'relay',codeHash,rpc:process.env.PUBLIC_ARC_RPC||RPC});
    if(/^\/api\/receipt\/0x[\da-fA-F]{64}$/.test(path)){
      const receipt=await readFinalPayment(provider,contract,path.split('/').pop(),codeHash);
      check(receipt,'Awaiting finality');
      const signature=await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},signingKey,receiptBytes(receipt));
      return json(res,200,{receipt,signature:Buffer.from(signature).toString('base64')});
    }
    const asset=Object.hasOwn(assets,path)&&assets[path];
    if(!asset)return json(res,404,{error:'Unknown route'});
    const bytes=await readFile('dist/'+asset[0]);
    res.writeHead(200,{'content-type':asset[1],'cache-control':'no-cache','x-content-type-options':'nosniff',
      'referrer-policy':'no-referrer'});res.end(bytes);
  }catch(error){json(res,422,{error:error.shortMessage||error.message});}
}).listen(port,()=>console.log('Blackout Checkout listening on '+port));
