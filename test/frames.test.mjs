import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collector,makeFrames} from '../src/frames.mjs';
test('real fixture crosses multiple QR frames in reverse order with a duplicate',async()=>{
  const payload=JSON.parse(await readFile(new URL('./fixtures/arc.json',import.meta.url)));
  const frames=makeFrames(payload).reverse(),read=collector();assert.ok(frames.length>1);
  read(frames[0]);let result;for(const frame of frames)result=read(frame);
  assert.deepEqual(JSON.parse(result.value),payload);
});
