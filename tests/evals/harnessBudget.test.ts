import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startProxy} from '../../tools/harness-eval/proxy.mjs';
import {startProxy as start8192Proxy} from '../../tools/harness-eval/proxy-8192.mjs';
import {startProxy as start16000Proxy} from '../../tools/harness-eval/proxy-16000.mjs';

for(const [start,pageMax]of [[start8192Proxy,12000],[start16000Proxy,16000]] as const)test(`代理实际发送总控8192和页面${pageMax}，保留预算拒绝与未知调用保护`,async()=>{
  const seen=[];let fail=false;
  const proxy=await start({out:await mkdtemp(path.join(os.tmpdir(),'sf-8192-eval-')),key:'local-test',port:0,upstreamFetch:async(_url,init)=>{
    seen.push(JSON.parse(init.body));if(fail)throw new Error('synthetic disconnect');
    return new Response(JSON.stringify({model:'local-test',usage:{prompt_tokens:10,completion_tokens:10},choices:[{message:{content:'ok'},finish_reason:'stop'}]}));
  }});
  const url='http://127.0.0.1:'+proxy.server.address().port+'/chat/completions';
  const call=(controller=true)=>fetch(url,{method:'POST',body:JSON.stringify({messages:[{role:'user',content:'synthetic'}],max_tokens:controller?8192:pageMax,...(controller?{tools:[{type:'function',function:{name:'revise_pages'}}]}:{})})});
  try{
    proxy.setTrial('denied',0);assert.equal((await call()).status,409);assert.equal(seen.length,0);
    proxy.setTrial('known');assert.equal((await call()).status,200);assert.equal(seen[0].max_tokens,8192);assert.equal(proxy.calls[0].max_tokens,8192);assert.equal(proxy.calls[0].normalized_max_tokens,false);
    assert.equal((await call(false)).status,200);assert.equal(seen[1].max_tokens,pageMax);assert.equal(proxy.calls[1].normalized_max_tokens,false);
    proxy.setTrial('unknown');fail=true;assert.equal((await call()).status,502);assert.equal(proxy.calls.at(-1).status,'unknown');
    assert.ok(proxy.calls.at(-1).reserved_cny>=8192*8/1e6);assert.equal((await call()).status,409);assert.equal(seen.length,3);
  }finally{await new Promise(resolve=>proxy.server.close(resolve))}
});

test('预算未许可不外发，未知请求保留预留且不重发',async()=>{
  let dispatches=0,fail=false;
  const proxy=await startProxy({out:await mkdtemp(path.join(os.tmpdir(),'sf-fixed-eval-')),key:'local-test',port:0,
    upstreamFetch:async()=>{
      dispatches++;
      if(fail)throw new Error('synthetic disconnect');
      return new Response(JSON.stringify({model:'local-test',usage:{prompt_tokens:10,completion_tokens:10},choices:[{message:{content:'ok'},finish_reason:'stop'}]}));
    }});
  const url='http://127.0.0.1:'+proxy.server.address().port+'/chat/completions';
  const call=()=>fetch(url,{method:'POST',body:JSON.stringify({messages:[{role:'user',content:'synthetic'}]})});
  try{
    proxy.setTrial('no-budget',0);assert.equal((await call()).status,409);assert.equal(dispatches,0);
    proxy.setTrial('known');assert.equal((await call()).status,200);assert.equal(dispatches,1);
    proxy.setTrial('unknown');fail=true;assert.equal((await call()).status,502);
    assert.equal(proxy.calls.at(-1).status,'unknown');assert.ok(proxy.calls.at(-1).reserved_cny>0);
    assert.equal((await call()).status,409);assert.equal(dispatches,2);
  }finally{await new Promise(resolve=>proxy.server.close(resolve))}
});
