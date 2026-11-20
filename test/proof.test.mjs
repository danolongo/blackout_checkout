import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';
import { hexlify,keccak256 } from 'ethers';
import { CHAIN,verifyCertificate,voteBytes } from '../src/proof.mjs';
test('only distinct precommits strictly above two thirds can certify a pinned height',()=>{
  const cert={height:123,round:0,block_hash:'0x'+'ab'.repeat(32),signatures:[]};
  const snapshot={chain:CHAIN,from:123,to:123,validators:[]};
  for(let n=1;n<=3;n++){
    const key=new Uint8Array(32).fill(n), pub=ed25519.getPublicKey(key), address=keccak256(pub).slice(0,42);
    snapshot.validators.push({key:hexlify(pub),power:'1'});
    cert.signatures.push({address,signature:Buffer.from(ed25519.sign(voteBytes(cert,address),key)).toString('base64')});
  }
  verifyCertificate(cert,snapshot);
  assert.throws(()=>verifyCertificate({...cert,signatures:cert.signatures.slice(1)},snapshot));
  assert.throws(()=>verifyCertificate({...cert,signatures:[...cert.signatures,cert.signatures[0]]},snapshot));
  assert.throws(()=>verifyCertificate({...cert,round:1},snapshot));
  assert.throws(()=>verifyCertificate({...cert,height:124},snapshot));
});
