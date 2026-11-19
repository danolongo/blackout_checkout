import './compile.mjs';
import ganache from 'ganache';
import {readFile} from 'node:fs/promises';
import {generateKeyPairSync} from 'node:crypto';
import {spawn} from 'node:child_process';
import {JsonRpcProvider,ContractFactory} from 'ethers';
const rpcPort=Number(process.env.REHEARSAL_RPC_PORT||8545);
const chain=ganache.server({chain:{chainId:5042002},wallet:{totalAccounts:3},logging:{quiet:true}});
await chain.listen(rpcPort,'127.0.0.1');
const rpc='http://127.0.0.1:'+rpcPort, provider=new JsonRpcProvider(rpc);
const deployer=await provider.getSigner(0);
const artifact=JSON.parse(await readFile('artifacts/contract.json'));
const checkout=await new ContractFactory(artifact.abi,artifact.bytecode,deployer).deploy();
await checkout.waitForDeployment();
const contract=await checkout.getAddress();
const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const web=spawn(process.execPath,['server/start.mjs'],{stdio:'inherit',env:{...process.env,
  ARC_RPC:rpc,PUBLIC_ARC_RPC:'/api/rehearsal/rpc',REHEARSAL_RPC:rpc,ARC_SNAPSHOT_FILE:'',
  CHECKOUT_ADDRESS:contract,RELAY_PRIVATE_JWK:JSON.stringify(privateKey.export({format:'jwk'}))}});
console.log('Local rehearsal, no real funds. Fund a generated customer wallet with the rehearsal button.');
const close=()=>web.kill();process.once('SIGTERM',close);process.once('SIGINT',close);
web.once('exit',async(code)=>{provider.destroy();await chain.close();process.exit(code||0);});
