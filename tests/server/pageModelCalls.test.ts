import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {rm} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {llmComplete} from "../../scripts/m0/llmClient.ts";
import {runWithAgent} from "../../src/server/agentClient.ts";
import {pageModelQueue} from "../../src/server/pageModelQueue.ts";
import {agentRoot} from "../../src/capabilities/agent.ts";

test("fixed-flow and Harness pages share capacity, outlines bypass it, and replay needs no slot",async()=>{
 const deck=`deck-model-calls-${randomUUID()}`,root=agentRoot(deck);
 const values={OPENAI_API_KEY:"test-only",OPENAI_BASE_URL:"http://calls.test/model",OPENAI_MODEL:"test-model",OPENAI_FALLBACK_API_KEY:"",PAGE_MODEL_CONCURRENCY:"2",SLIDEFORGE_JOB_API_URL:"http://calls.test/jobs",SLIDEFORGE_BRAIN_API_URL:"http://calls.test/brain",GATEWAY_INTERNAL_TOKEN:"test"};
 const prior=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));Object.assign(process.env,values);
 const run:any={run_seq:1,runner_epoch:1,phase:"generating",calls:{},budget:{active_seconds:0,limit_seconds:600,spent_cny:0,reserved_cny:0,limit_cny:2},pricing:{input_cny_per_million:2,output_cny_per_million:8}};
 let pages=0,peak=0,models=0;const original=fetch;
 globalThis.fetch=async(url,init)=>{
  const body=JSON.parse(String(init?.body));
  if(String(url).endsWith("/chat/completions")){
   const isPage=body.messages[0].content!=="outline";models++;
   if(isPage){pages++;peak=Math.max(peak,pages)}
   try{await new Promise(resolve=>setTimeout(resolve,15));return Response.json({choices:[{message:{content:"saved HTML"}}],usage:{prompt_tokens:10,completion_tokens:20}})}
   finally{if(isPage)pages--}
  }
  if(body.action==="reserve_call")run.calls[body.call_id]={status:"reserved",cost:body.cost,input_hash:body.input_hash};
  if(body.action==="send_call")run.calls[body.call_id].status="sent";
  if(body.action==="settle_call")run.calls[body.call_id]={...run.calls[body.call_id],status:"completed",response_ref:body.response_ref,cost:body.cost};
  return Response.json({job:{id:deck,agent:run}});
 };
 const agent=(id:string)=>runWithAgent({deck_id:deck,run_seq:1,runner_epoch:1,operation_id:id,counter:0},()=>llmComplete([{role:"user",content:id}],{pageModel:{owner:"agent",project:deck}}));
 try{
  await Promise.all([agent("a"),agent("b"),...Array.from({length:6},(_,i)=>llmComplete([{role:"user",content:`old-${i}`}],{maxRetries:0,pageModel:{owner:"old",project:`old-${i%2}`}}))]);
  assert.equal(models,8);assert.equal(peak,2);
  const a=await pageModelQueue().acquire({owner:"busy",project:"1"}),b=await pageModelQueue().acquire({owner:"busy",project:"2"});
  try{
   const before=models;const outline=await llmComplete([{role:"user",content:"outline"}],{maxRetries:0});assert.equal(outline.text,"saved HTML");
   const replay=await agent("a");assert.equal(replay.text,"saved HTML");assert.equal(models,before+1);assert.equal(pageModelQueue().stats.pending,0);
  }finally{a();b()}
 }finally{
  globalThis.fetch=original;for(const[k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v}
  assert.equal(path.dirname(root),path.resolve("artifacts/decks"));await rm(root,{recursive:true,force:true});
 }
});
