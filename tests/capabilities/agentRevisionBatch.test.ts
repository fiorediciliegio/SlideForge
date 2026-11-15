import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {rm} from "node:fs/promises";
import path from "node:path";
import {executeAgentTool,agentRoot,agentToolDefinitions} from "../../src/capabilities/agent.ts";
import {emptyProject,prepareRevision,pageHTML,readProjectRevision,writeArtifact,readJSON} from "../../src/capabilities/project.ts";
import {agentOptionsSchema} from "../../src/contracts/agent.ts";
import {engineTransport} from "../../src/server/engineTransport.ts";
import {AsyncJobQueue} from "../../src/server/jobQueue.ts";
import {inputHash} from "../../src/server/agentClient.ts";

const html=(text:string)=>`<!doctype html><html><head><style>.slide{width:1920px;height:1080px;overflow:hidden}</style></head><body><main class="slide"><h1>${text}</h1></main></body></html>`;
async function fixture(){
 const id=`deck-batch-${randomUUID()}`,root=agentRoot(id),ids=Array.from({length:6},(_,i)=>`p${i+1}`);
 const outline={title:"test",draft_revision:1,pages:ids.map(page_id=>({page_id,title:page_id,bullets:[]}))};
 const base=emptyProject(id,"test",outline),prepared=await prepareRevision(root,base,{instruction:"initial",page_html:Object.fromEntries(ids.map(id=>[id,html("old-"+id)]))});
 const context_ref=await writeArtifact(root,"contexts",{project:prepared.project,export_authorized:[]});
 const job:any={id,status:"creating",events:[],agent:{run_seq:1,runner_epoch:1,checkpoint_seq:1,phase:"revising",context_ref,project_ref:prepared.ref,
  options:agentOptionsSchema.parse({version:1,page_policy:{mode:"fixed",count:6}}),calls:{},operations:{},pricing:{input_cny_per_million:2,output_cny_per_million:8},budget:{active_seconds:0,limit_seconds:600,spent_cny:0,reserved_cny:0,limit_cny:2}}};
 const setScope=async(allowed=ids)=>writeArtifact(root,"checks",{kind:"layout",created_at:new Date().toISOString(),revision_id:prepared.ref.revision_id,page_ids:ids,
  page_revisions:Object.fromEntries(prepared.project.pages.map(p=>[p.page_id,inputHash([p.page_revision,[]])])),constraints_hash:inputHash([prepared.project.constraints,prepared.project.outline.pages,prepared.project.sources]),template_hash:inputHash(prepared.project.visual??{}),
  issues:allowed.map(page_id=>({severity:"blocker",code:"overlap",detail:"test overlap",page_ids:[page_id]}))},"scope-layout");
 await setScope();
 const values={SLIDEFORGE_JOB_API_URL:"http://batch.test/jobs",SLIDEFORGE_BRAIN_API_URL:"http://batch.test/brain",GATEWAY_INTERNAL_TOKEN:"batch-test",OPENAI_API_KEY:"test-only",OPENAI_BASE_URL:"http://batch.test/model",DECK_CONCURRENCY:"2"};
 const previous=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));Object.assign(process.env,values);
 const originalFetch=globalThis.fetch,originalEngine={...engineTransport},requests:any[]=[],commands:any[]=[];
 let active=0,peak=0;
 const controls:{beforeModel?:(id:string)=>Promise<void>;beforeReserve?:()=>boolean;beforeGet?:()=>Promise<void>;afterModel?:(id:string)=>Promise<void>;invalid?:string}={};
 const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
 globalThis.fetch=async(url,init)=>{
  const address=String(url),body=JSON.parse(String(init?.body));
  if(address.endsWith("/page-prompt"))return json({messages:[{role:"system",content:body.page_title}]});
  if(address.endsWith("/chat/completions")){
   const page=body.messages[0].content;requests.push(body);active++;peak=Math.max(peak,active);
   try{await controls.beforeModel?.(page);await new Promise(resolve=>setTimeout(resolve,15));await controls.afterModel?.(page);
    return json({choices:[{message:{content:page===controls.invalid?"<!doctype html><html><body>invalid</body></html>":html("new-"+page)}}],usage:{prompt_tokens:10,completion_tokens:20}});
   }finally{active--}
  }
  if(address!=="http://batch.test/jobs"&&address!=="http://batch.test/jobs/agent")throw new Error("unexpected network: "+address);
  if(body.action==="get")await controls.beforeGet?.();
  commands.push(body);const run=job.agent;
  if(body.action==="begin_tool"){
   const previous=run.operations[body.operation_id];if(previous&&previous.input_hash!==body.input_hash)return json({error:"fingerprint conflict"},409);
   run.operations[body.operation_id]??={status:"pending",input_hash:body.input_hash};
  }
  if(body.action==="complete_tool"){
   if(body.runner_epoch!==run.runner_epoch||run.phase==="cancelled")return json({error:"stale execution"},409);
   if(body.project_ref&&body.parent_revision!==run.project_ref.revision_id)return json({error:"stale parent"},409);
   run.operations[body.operation_id]={status:"completed",input_hash:body.input_hash,result:body.result};if(body.project_ref)run.project_ref=body.project_ref;run.checkpoint_seq++;
  }
  if(body.action==="reserve_call"){
   if(controls.beforeReserve?.()===false)return json({error:"budget exhausted"},402);
   run.calls[body.call_id]={status:"reserved",cost:body.cost,input_hash:body.input_hash};
  }
  if(body.action==="send_call")run.calls[body.call_id].status="sent";
  if(body.action==="settle_call")run.calls[body.call_id]={...run.calls[body.call_id],status:"completed",response_ref:body.response_ref,cost:body.cost};
  if(body.action==="mark_unknown"&&run.calls[body.call_id]?.status==="sent")run.calls[body.call_id].status="unknown";
  return json({job});
 };
 engineTransport.put=async()=>({artifact_id:randomUUID(),sha256:"test"} as any);
 engineTransport.submit=async request=>({job_id:randomUUID(),state:"completed",owner_key_hash:"local",result_ref:request.snapshot_id} as any);
 engineTransport.read=async()=>Buffer.from(JSON.stringify({pages:[{report:{ok:true,issues:[]}}]}));
 const execute=(revisions:any[],operation_id="batch")=>executeAgentTool({deck_id:id,run_seq:1,runner_epoch:1,operation_id,name:"revise_pages",args:{revisions}},new AsyncJobQueue(1,5));
 const run=(idsToRevise=ids,operation_id="batch")=>execute(idsToRevise.map(page_id=>({page_id,instruction:"fix-"+page_id,issue_ids:["overlap"]})),operation_id);
 const single=(page_id:string,operation_id="single")=>executeAgentTool({deck_id:id,run_seq:1,runner_epoch:1,operation_id,name:"revise_page",args:{page_id,instruction:"fix-"+page_id}},new AsyncJobQueue(1,5));
 return {id,root,ids,job,prepared,requests,commands,controls,run,execute,single,setScope,get peak(){return peak},current:()=>readProjectRevision(root,job.agent.project_ref),async close(){globalThis.fetch=originalFetch;Object.assign(engineTransport,originalEngine);for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v}if(path.dirname(root)!==path.resolve("artifacts/decks"))throw new Error("unsafe fixture cleanup");await rm(root,{recursive:true,force:true});}};
}

test("six independent repairs keep per-page instructions, concurrency two and replay without extra calls",async()=>{
 const f=await fixture();try{
  const result:any=await f.run();assert.equal(result.pages.length,6);assert.deepEqual(result.failures,[]);assert.equal(f.peak,2);
  for(const id of f.ids){assert.match(await pageHTML(f.root,await f.current(),id),new RegExp("new-"+id));const request=f.requests.find(r=>r.messages[0].content===id);assert.ok(request.messages.at(-1).content.endsWith("fix-"+id));assert.match(request.messages.at(-1).content,new RegExp("old-"+id))}
  assert.deepEqual(await f.run(),result);assert.equal(f.requests.length,6);
 }finally{await f.close()}
});
test("an invalid candidate preserves that page while independent pages commit",async()=>{
 const f=await fixture();try{f.controls.invalid="p2";const r:any=await f.run(["p1","p2","p3"]);assert.equal(r.pages.length,3);assert.ok(r.pages.find((p:any)=>p.page_id==="p2").issues.length);const current=await f.current();assert.match(await pageHTML(f.root,current,"p1"),/new-p1/);assert.match(await pageHTML(f.root,current,"p2"),/old-p2/);assert.match(await pageHTML(f.root,current,"p3"),/new-p3/)}finally{await f.close()}
});
test("duplicate pages and batches over six are rejected before any model call",async()=>{
 const f=await fixture();try{for(const ids of [["p1","p1"],[...f.ids,"p7"]])await assert.rejects(()=>f.run(ids));assert.equal(f.requests.length,0)}finally{await f.close()}
});
test("a changed target page cannot be overwritten by a candidate based on the old page",async()=>{
 const f=await fixture();try{f.controls.afterModel=async id=>{if(id==="p1"){const current=await f.current(),newer=await prepareRevision(f.root,current,{instruction:"new user edit",page_html:{p1:html("user-edit")}});f.job.agent.project_ref=newer.ref}};
  const r:any=await f.run(["p1","p2"]);assert.ok(r.failures.some((p:any)=>p.page_id==="p1"&&p.status===409));assert.match(await pageHTML(f.root,await f.current(),"p1"),/user-edit/);
 }finally{await f.close()}
});
for(const kind of ["budget","unknown","cancel"] as const)test(`${kind} stops dispatch of remaining pages`,async()=>{
 const f=await fixture();try{
  if(kind==="budget"){let count=0;f.controls.beforeReserve=()=>++count===1}
  if(kind==="unknown")f.controls.beforeModel=async id=>{if(id==="p1")throw new Error("lost response")};
  if(kind==="cancel")f.controls.afterModel=async()=>{f.job.agent.phase="cancelled";f.job.agent.runner_epoch++};
  await assert.rejects(()=>f.run());assert.ok(f.requests.length<=2);assert.equal(f.job.agent.operations["run-1:batch"].status,"pending");
  if(kind==="cancel")assert.equal((await f.current()).revision_id,f.prepared.ref.revision_id);
 }finally{await f.close()}
});
test("resuming a partial batch reuses completed pages and the original inputs for saved model responses",async()=>{
 const f=await fixture();try{
  let count=0;f.controls.beforeReserve=()=>++count<=2;
  await assert.rejects(()=>f.run());const finished=Object.values(f.job.agent.operations).filter((op:any)=>op.status==="completed"&&op.result?.repair).length;assert.ok(finished>=1);
  const before=f.requests.length;f.controls.beforeReserve=undefined;
  const r:any=await f.run();assert.equal(r.pages.length,6);assert.equal(f.requests.length,6);assert.ok(before>=1);
  for(const request of f.requests)assert.match(request.messages.at(-1).content,new RegExp("old-"+request.messages[0].content));
 }finally{await f.close()}
});
test("batch repair tool has explicit two-to-six page bounds",()=>{
 const tool:any=agentToolDefinitions(false).find(t=>t.function.name==="revise_pages");assert.ok(tool);assert.equal(tool.function.parameters.properties.revisions.minItems,2);assert.equal(tool.function.parameters.properties.revisions.maxItems,6);
});
test("ordinary candidate errors do not stop independent repairs or trigger automatic retries",async()=>{
 const f=await fixture();try{
  await writeArtifact(f.root,"candidates",{page_id:"p2",html:html("wrong-page")},"wrong");
  const r:any=await f.execute([{page_id:"p1",instruction:"fix p1",candidate_id:"wrong"},{page_id:"p2",instruction:"fix p2"},{page_id:"p3",instruction:"fix p3"}]);
  assert.equal(r.failures.length,1);assert.equal(r.failures[0].page_id,"p1");assert.equal(f.requests.length,2);assert.match(await pageHTML(f.root,await f.current(),"p1"),/old-p1/);
  assert.deepEqual(await f.execute([{page_id:"p1",instruction:"fix p1",candidate_id:"wrong"},{page_id:"p2",instruction:"fix p2"},{page_id:"p3",instruction:"fix p3"}]),r);assert.equal(f.requests.length,2);
 }finally{await f.close()}
});
test("each page can use its own failed candidate without mixing inputs",async()=>{
 const f=await fixture();try{
  for(const id of ["p1","p2"])await writeArtifact(f.root,"candidates",{page_id:id,html:html("candidate-"+id)},"candidate-"+id);
  await f.execute(["p1","p2"].map(id=>({page_id:id,instruction:"fix-"+id,candidate_id:"candidate-"+id})));
  for(const request of f.requests)assert.match(request.messages.at(-1).content,new RegExp("candidate-"+request.messages[0].content));
 }finally{await f.close()}
});
test("shared constraint changes reject stale candidates even when page HTML has not changed",async()=>{
 const f=await fixture();try{
  let changed=false;f.controls.afterModel=async()=>{if(changed)return;changed=true;const current=await f.current(),newer=await prepareRevision(f.root,current,{instruction:"new constraint",context:{constraints:[{text:"new fact",source:"user",confirmed_at:"now"}]}});f.job.agent.project_ref=newer.ref};
  const r:any=await f.run(["p1","p2"]);assert.equal(r.pages.length,0);assert.equal(r.failures.length,2);
  for(const id of ["p1","p2"])assert.match(await pageHTML(f.root,await f.current(),id),new RegExp("old-"+id));
 }finally{await f.close()}
});
test("two-repair limit remains per page and successful sibling repairs are preserved",async()=>{
 const f=await fixture();try{
  for(let i=0;i<2;i++)f.job.agent.operations["prior-"+i]={status:"completed",result:{repair:true,page_id:"p1"}};
  const r:any=await f.run(["p1","p2"]);assert.equal(r.failures[0].page_id,"p1");assert.equal(f.requests.length,1);assert.match(await pageHTML(f.root,await f.current(),"p2"),/new-p2/);
 }finally{await f.close()}
});
test("known budget exhaustion stops dispatch before a slow status refresh even after sibling settlement",async()=>{
 const f=await fixture();try{
  let reserves=0,denied=false,held=false;
  f.controls.beforeReserve=()=>{if(++reserves===2){denied=true;return false}return true};
  f.controls.beforeGet=async()=>{if(denied&&!held){held=true;await new Promise(resolve=>setTimeout(resolve,350))}};
  await assert.rejects(()=>f.run());assert.equal(f.requests.length,1,"the completed sibling must not start another page while the budget error is being refreshed");
 }finally{await f.close()}
});
test("one blocker cannot be padded with improvement pages in either repair tool",async()=>{
 const f=await fixture();try{
  await f.setScope(["p1"]);await assert.rejects(()=>f.run(["p1","p2","p3"]),/阻断|清单/);assert.equal(f.requests.length,0);
  await assert.rejects(()=>f.single("p2"),/阻断|清单/);assert.equal(f.requests.length,0);
  await f.single("p1","allowed-single");assert.equal(f.requests.length,1);
 }finally{await f.close()}
});
test("a batch mixing an allowed blocker with an extra page is entirely rejected before generation",async()=>{
 const f=await fixture();try{await f.setScope(["p1","p2"]);await assert.rejects(()=>f.run(["p1","p3"]),/阻断|清单/);assert.equal(f.requests.length,0);await f.run(["p1","p2"],"valid");assert.equal(f.requests.length,2)}finally{await f.close()}
});
test("explicit user single-page editing keeps its existing scope and batch editing stays unavailable",async()=>{
 const f=await fixture();try{
  await f.setScope([]);f.job.agent.context_ref=await writeArtifact(f.root,"contexts",{project:f.prepared.project,export_authorized:[],instruction:"用户主动修改",page_ids:["p3"]});
  await f.single("p3");assert.equal(f.requests.length,1);await assert.rejects(()=>f.run(["p1","p2"]));assert.equal(f.requests.length,1);
 }finally{await f.close()}
});
test("single-page output and reservation both use 16000 tokens",async()=>{
 const f=await fixture();try{await f.run(["p1","p2"]);for(const request of f.requests)assert.equal(request.max_tokens,16000);
  const reserve=f.commands.find(c=>c.action==="reserve_call"),request=f.requests[0];assert.ok(Math.abs(reserve.cost-(Buffer.byteLength(JSON.stringify(request))*2+16000*8)/1e6)<1e-9);
 }finally{await f.close()}
});
test("a completed single-page child can restore the parent after its blocker disappeared",async()=>{
 const f=await fixture();try{await f.setScope(["p1"]);const result:any=await f.single("p1");f.job.agent.operations["run-1:single"].status="pending";await f.setScope([]);const replay:any=await f.single("p1");assert.deepEqual(replay.project_ref,result.project_ref);assert.equal(replay.pages[0].candidate_id,result.pages[0].candidate_id);assert.deepEqual(replay.failures,[]);assert.equal(f.requests.length,1)}finally{await f.close()}
});
for(const valid of [true,false])test(`old partial batches restore only the original blocking scope (${valid})`,async()=>{
 const f=await fixture();try{
  let count=0;f.controls.beforeReserve=()=>++count===1;await assert.rejects(()=>f.run());
  const batchId=inputHash("run-1:batch"),saved:any=await readJSON(path.join(f.root,"project/revision-batches",batchId+".json"));delete saved.allowed_page_ids;await writeArtifact(f.root,"revision-batches",saved,batchId);
  f.controls.beforeReserve=undefined;const before=f.requests.length;
  if(valid){const r:any=await f.run();assert.equal(r.pages.length,6);assert.equal(f.requests.length,6)}
  else{await f.setScope(["p1"]);await assert.rejects(()=>f.run(),/阻断|清单/);assert.equal(f.requests.length,before)}
 }finally{await f.close()}
});
