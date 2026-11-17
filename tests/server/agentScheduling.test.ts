import assert from "node:assert/strict";
import test from "node:test";
import {acquireAgentPageSlot,waitAgentBudget,awaitAgentOperation} from "../../src/server/agentScheduling.ts";
import {pageModelQueue} from "../../src/server/pageModelQueue.ts";
import {internalPost} from "../../src/server/agentClient.ts";

test("queued Agent requests cancel before send and budget waits preserve typed reasons",async()=>{
 const env={SLIDEFORGE_JOB_API_URL:process.env.SLIDEFORGE_JOB_API_URL,SLIDEFORGE_BRAIN_API_URL:process.env.SLIDEFORGE_BRAIN_API_URL,GATEWAY_INTERNAL_TOKEN:process.env.GATEWAY_INTERNAL_TOKEN,PAGE_MODEL_CONCURRENCY:process.env.PAGE_MODEL_CONCURRENCY};
 Object.assign(process.env,{SLIDEFORGE_JOB_API_URL:"http://scheduling.test/jobs",SLIDEFORGE_BRAIN_API_URL:"http://scheduling.test/brain",GATEWAY_INTERNAL_TOKEN:"test",PAGE_MODEL_CONCURRENCY:"1"});
 const original=fetch,context={deck_id:"deck-queue",run_seq:1,runner_epoch:1,operation_id:"page:a",counter:0};
 const run:any={run_seq:1,runner_epoch:1,phase:"generating",calls:{},budget:{spent_cny:.5,reserved_cny:1.4,limit_cny:2,active_seconds:0,limit_seconds:600}};
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));
  if(body.action==="typed")return Response.json({error:"temporarily reserved",error_code:"budget_inflight"},{status:409});
  return Response.json({job:{id:context.deck_id,agent:run}});
 };
 let hold:(()=>void)|undefined;
 try{
  await assert.rejects(()=>internalPost("http://scheduling.test/jobs",{action:"typed"}),e=>(e as any).code==="budget_inflight");
  hold=await pageModelQueue().acquire({owner:"busy",project:"busy"});
  const queued=acquireAgentPageSlot(context,{owner:"a",project:context.deck_id});
  await new Promise(resolve=>setTimeout(resolve,20));run.runner_epoch=2;run.phase="cancelled";
  await assert.rejects(queued,/失效/);assert.equal(pageModelQueue().stats.pending,0);hold();hold=undefined;
  run.runner_epoch=1;run.phase="generating";run.calls={active:{status:"sent"}};
  let ended=false;const waiting=waitAgentBudget(context,.2).then(()=>ended=true);
  await new Promise(resolve=>setTimeout(resolve,25));assert.equal(ended,false);
  run.budget.reserved_cny=0;run.calls.active.status="completed";await waiting;assert.equal(ended,true);
  run.budget.spent_cny=1.9;await assert.rejects(()=>waitAgentBudget(context,.2),e=>(e as any).status===402);
  run.budget.spent_cny=.5;
  let finish!:(value:string)=>void;
  const delayed=new Promise<string>(resolve=>finish=resolve),observed=awaitAgentOperation(context,delayed);
  const cancelled=assert.rejects(observed,/失效/);run.phase="cancelled";run.runner_epoch=2;
  await cancelled;finish("late result");await new Promise(resolve=>setImmediate(resolve));
 }finally{
  hold?.();globalThis.fetch=original;for(const[k,v]of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v}
 }
});
