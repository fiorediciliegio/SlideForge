import assert from "node:assert/strict";
import test from "node:test";
import {PageModelQueue} from "../../src/server/pageModelQueue.ts";
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test("page capacity rotates owners and projects without reserving idle shares",async()=>{
 const q=new PageModelQueue(2),identity={owner:"a",project:"p1"};
 const first=await q.acquire(identity),second=await q.acquire(identity),order:string[]=[],releases:Array<()=>void>=[];
 const take=(owner:string,project:string,name:string)=>q.acquire({owner,project}).then(release=>{order.push(name);releases.push(release)});
 const pending=[take("a","p1","a1"),take("a","p2","a2"),take("b","p3","b")];
 first();await tick();assert.deepEqual(order,["a1"]);
 second();await tick();assert.deepEqual(order,["a1","b"]);
 releases[0]();await tick();assert.deepEqual(order,["a1","b","a2"]);
 releases[1]();releases[2]();await Promise.all(pending);assert.equal(q.stats.active,0);
});

test("cancelled queued work never receives a slot and release is idempotent",async()=>{
 const q=new PageModelQueue(1),hold=await q.acquire({owner:"a",project:"a"}),controller=new AbortController();
 const cancelled=q.acquire({owner:"a",project:"later"},controller.signal);
 const rejected=assert.rejects(cancelled,/cancelled/);controller.abort(new Error("cancelled"));await rejected;
 const next=q.acquire({owner:"b",project:"b"});hold();hold();const release=await next;
 assert.equal(q.stats.active,1);assert.equal(q.stats.pending,0);release();assert.equal(q.stats.active,0);
});

for(const [name,projects,owners] of [["solo",1,1],["mixed5",5,5],["burst10",10,5]] as const)test(`${name} completes within global twelve with no hidden quota`,async t=>{
 const q=new PageModelQueue(12);let active=0,peak=0,completed=0;
 const waits:number[]=[],totals:number[]=[];
 await Promise.all(Array.from({length:projects*3},async(_,index)=>{
  const start=performance.now();
  const release=await q.acquire({owner:`owner-${Math.floor(index/3)%owners}`,project:`project-${Math.floor(index/3)}`});
  waits.push(performance.now()-start);
  active++;peak=Math.max(peak,active);
  try{await new Promise(resolve=>setTimeout(resolve,5));completed++}finally{totals.push(performance.now()-start);active--;release()}
 }));
 assert.equal(peak,Math.min(projects*3,12));assert.equal(completed,projects*3);assert.deepEqual(q.stats,{active:0,pending:0,capacity:12});
 const percentile=(values:number[],p:number)=>Number([...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1].toFixed(2));
 t.diagnostic(JSON.stringify({scenario:name,projects,owners,completed,peak,queue_p50_ms:percentile(waits,.5),queue_p95_ms:percentile(waits,.95),completion_p95_ms:percentile(totals,.95),real_provider_requests:0}));
});
