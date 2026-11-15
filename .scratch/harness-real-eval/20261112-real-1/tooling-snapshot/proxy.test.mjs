import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startProxy} from './proxy.mjs';
test('budget preflight, common output cap, unknown blocking without redispatch',async()=>{
 let dispatches=0,fail=false,payload;
 const proxy=await startProxy({out:await mkdtemp(path.join(os.tmpdir(),'sf-real-eval-gate-')),key:'local-test',port:0,upstreamFetch:async(_url,init)=>{dispatches++;payload=JSON.parse(init.body);if(fail)throw new Error('synthetic disconnect');return new Response(JSON.stringify({model:'local-test',usage:{prompt_tokens:10,completion_tokens:10},choices:[{message:{content:'ok'},finish_reason:'stop'}]}));}});
 const url=`http://127.0.0.1:${proxy.server.address().port}/chat/completions`;
 const call=()=>fetch(url,{method:'POST',body:JSON.stringify({messages:[{role:'user',content:'synthetic'}]})});
 try {
  proxy.setTrial('no-budget',0);assert.equal((await call()).status,409);assert.equal(dispatches,0);
  proxy.setTrial('success');assert.equal((await call()).status,200);assert.equal(payload.max_tokens,12000);assert.equal(dispatches,1);
  proxy.setTrial('unknown');fail=true;assert.equal((await call()).status,502);assert.equal(dispatches,2);assert.equal(proxy.calls.at(-1).status,'unknown');assert.ok(proxy.calls.at(-1).reserved_cny>0);
  assert.equal((await call()).status,409);assert.equal(dispatches,2);
 }finally{await new Promise(resolve=>proxy.server.close(resolve));}
});
