import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyInclusion} from '../src/proof.mjs';
const data=JSON.parse(await readFile(new URL('./fixtures/arc.json',import.meta.url)));
test('offline replay of a real Arc testnet receipt and rejection of corruption',async()=>{
  const {proof,snapshot,cert}=data;
  const r=await verifyInclusion(proof,cert,snapshot);
  assert.equal(Number(r.height),73090654);
  await assert.rejects(()=>verifyInclusion({...proof,index:proof.index+1},cert,snapshot));
  await assert.rejects(()=>verifyInclusion({...proof,header:proof.header+'00'},cert,snapshot));
});
