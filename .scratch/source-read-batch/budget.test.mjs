import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startProxy} from '../harness-real-eval/proxy.mjs';
test('before and after share the same two-yuan reservation gate',async()=>{
 let dispatched=0;
 const proxy=await startProxy({out:await mkdtemp(path.join(os.tmpdir(),'sf-batch-budget-')),key:'fake',port:0,limitCny:2,initialCalls:[{id:1,trial:'before',status:'completed',cost_peak_cny:1.99}],upstreamFetch:async()=>{dispatched++;throw new Error('Must not dispatch');}});
 try{
  proxy.setTrial('after');const response=await fetch(`http://127.0.0.1:${proxy.server.address().port}/chat/completions`,{method:'POST',body:JSON.stringify({messages:[{role:'user',content:'virtual fixture'}]})});
  assert.equal(response.status,409);assert.equal(dispatched,0);assert.equal(proxy.spent(),1.99);
 }finally{await new Promise(resolve=>proxy.server.close(resolve));}
});
