import test from 'node:test';
import assert from 'node:assert/strict';
import {ProofFrameCollector,proofFrames} from '../src/qr-frames.mjs';

test('animated settlement QR reconstructs the same proof in any frame order',()=>{
  const proof={v:1,kind:'settlement-proof',id:'0x'+'ab'.repeat(16),certificate:{signatures:'x'.repeat(3000)}};
  const frames=proofFrames(proof,400);
  const collector=new ProofFrameCollector();
  let result;
  for(const frame of frames.toReversed())result=collector.add(frame);
  assert.deepEqual(result.proof,proof);
  assert.throws(()=>collector.add({...JSON.parse(frames[0]),total:101}),/Invalid proof QR frame/);
});
