import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "node:http";
import {once} from "node:events";
import {mkdir,rm,unlink,writeFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import path from "node:path";
import {executeAgentTool,continueAgent,agentRoot} from "../../src/capabilities/agent.ts";
import {emptyProject,prepareRevision,writeArtifact} from "../../src/capabilities/project.ts";
import {agentOptionsSchema} from "../../src/contracts/agent.ts";
import {AsyncJobQueue} from "../../src/server/jobQueue.ts";
import {inputHash} from "../../src/server/agentClient.ts";

const html=(title:string)=>`<!doctype html><html><head><style>.slide{width:1920px;height:1080px;overflow:hidden}</style></head><body><main class="slide"><h1>${title}</h1></main></body></html>`;
async function fixture() {
 const id=`deck-recovery-${randomUUID()}`,root=agentRoot(id);await mkdir(root,{recursive:true});
 const outline={draft_revision:1,title:"计划",pages:[{page_id:"a",title:"A",bullets:[]},{page_id:"b",title:"B",bullets:[]}]};
 const project=emptyProject(id,"先确认大纲",{...outline,draft_revision:0,pages:[]});
 const context_ref=await writeArtifact(root,"contexts",{project,export_authorized:["pptx"]});
 const options=agentOptionsSchema.parse({version:1,generation_mode:"outline_first",page_policy:{mode:"fixed",count:2}});
 const job:any={id,status:"creating",events:[],overflowPages:[],agent:{version:1,run_seq:1,runner_epoch:1,checkpoint_seq:1,phase:"planning",context_ref,draft_revision:0,options,calls:{},operations:{},budget:{active_seconds:0,limit_seconds:600,spent_cny:0,reserved_cny:0,limit_cny:2}}};
 const commands:any[]=[];
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());commands.push(body);
  if(body.action==="begin_tool")job.agent.operations[body.operation_id]={status:"pending",input_hash:body.input_hash};
  if(body.action==="complete_tool"){
   job.agent.operations[body.operation_id]={status:"completed",input_hash:body.input_hash,result:body.result};
   if(body.project_ref)job.agent.project_ref=body.project_ref;
   if(body.draft_ref){job.agent.draft_ref=body.draft_ref;job.agent.draft_revision++;}
   job.agent.checkpoint_seq++;
  }
  if(body.action==="settle_call"){job.agent.calls[body.call_id]={...job.agent.calls[body.call_id],status:"completed",cost:body.cost,response_ref:body.response_ref};job.agent.budget.spent_cny+=body.cost;job.agent.budget.reserved_cny=0;}
  if(body.action==="continue"){
   if(Object.values(job.agent.calls).some((call:any)=>call.status==="unknown")){res.writeHead(409,{"content-type":"application/json"});res.end('{"error":"unknown call"}');return;}
   job.agent.phase="queued";
  }
  res.setHeader("content-type","application/json");res.end(JSON.stringify({job,accepted:true}));
 });
 server.listen(0,"127.0.0.1");await once(server,"listening");const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const values={SLIDEFORGE_JOB_API_URL:base+"/internal/jobs",SLIDEFORGE_BRAIN_API_URL:base+"/internal/brain",GATEWAY_INTERNAL_TOKEN:"recovery-test"};
 const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);
 return {id,root,outline,project,job,commands,async close(){for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}server.close();await once(server,"close");if(path.dirname(root)!==path.resolve("artifacts/decks"))throw new Error("unsafe fixture cleanup");await rm(root,{recursive:true,force:true});}};
}

test("a prepared plan restores the same draft and confirmation pause",async()=>{
 const f=await fixture();
 try {
  const prepared=await prepareRevision(f.root,f.project,{instruction:"规划",outline:f.outline,operation_id:"run-1:plan-turn"});
  const result=await executeAgentTool({deck_id:f.id,run_seq:1,runner_epoch:1,operation_id:"plan-turn",name:"save_plan",args:{title:"计划",pages:f.outline.pages,scenario:{category:"企业",subtype:"介绍",reason:"test"}}},new AsyncJobQueue(1,5));
  assert.equal(result.pause,"waiting_outline");assert.deepEqual(result.outline,prepared.project.outline);
  assert.ok(f.job.agent.draft_ref);assert.equal(f.job.agent.project_ref.revision_id,prepared.ref.revision_id);
  await assert.rejects(()=>executeAgentTool({deck_id:f.id,run_seq:1,runner_epoch:1,operation_id:"premature-generate",name:"generate_pages",args:{page_ids:["a","b"]}},new AsyncJobQueue(1,5)),/确认大纲/);
 } finally {await f.close();}
});

test("a cancelled queued export never enters artifact export",async()=>{
 const f=await fixture();
 try {
  const prepared=await prepareRevision(f.root,f.project,{instruction:"生成",outline:f.outline,page_html:{a:html("A"),b:html("B")}});
  f.job.agent.project_ref=prepared.ref;
  const fingerprint={page_revisions:Object.fromEntries(prepared.project.pages.map(page=>[page.page_id,inputHash([page.page_revision,[]])])),constraints_hash:inputHash([prepared.project.constraints,prepared.project.outline.pages,prepared.project.sources]),template_hash:inputHash({})};
  for(const kind of ["layout","content","visual"])await writeArtifact(f.root,"checks",{...fingerprint,kind,page_ids:["a","b"],revision_id:prepared.ref.revision_id,global_summary:kind==="content",issues:[]},kind);
  const queue={submit:async(action:()=>Promise<unknown>)=>{f.job.agent.phase="cancelled";f.job.agent.runner_epoch++;await unlink(path.join(prepared.runDir,"deck.html"));return action();}} as AsyncJobQueue;
  await assert.rejects(()=>executeAgentTool({deck_id:f.id,run_seq:1,runner_epoch:1,operation_id:"export-turn",name:"export_deck",args:{format:"pptx",revision_id:prepared.ref.revision_id}},queue),/原执行|失效/);
 } finally {await f.close();}
});

test("a fully saved response is settled before asking to retry an unknown call",async()=>{
 const f=await fixture();
 try {
  f.job.agent.phase="interrupted";f.job.agent.pricing={input_cny_per_million:2,output_cny_per_million:8};
  f.job.agent.calls["turn-0"]={status:"unknown",input_hash:"input",cost:0.1};f.job.agent.budget.reserved_cny=0.1;
  const ref=await writeArtifact(f.root,"responses",{choices:[{message:{role:"assistant",content:"saved"}}],usage:{prompt_tokens:100,completion_tokens:10}},inputHash([1,"turn-0"]));
  await continueAgent(f.id,{expected_checkpoint:1});
  assert.equal(f.job.agent.calls["turn-0"].status,"completed");assert.equal(f.job.agent.calls["turn-0"].response_ref,ref);
  assert.ok(Math.abs(f.job.agent.budget.spent_cny-0.00028)<1e-9);assert.equal(f.job.agent.budget.reserved_cny,0);
  assert.ok(!f.commands.some(command=>command.action==="reserve_call"));
 } finally {await f.close();}
});

for(const start of [0,-1])test(`source read error at offset ${start} has a replayable receipt`,async()=>{
 const f=await fixture();
 try {
  const input={deck_id:f.id,run_seq:1,runner_epoch:1,operation_id:"source-error",name:"read_project",args:{section:"sources",source_id:"source-a",start}};
  const result=await executeAgentTool(input,new AsyncJobQueue(1,5));
  assert.equal(typeof result.error,"string");
  assert.equal(f.job.agent.operations["run-1:source-error"].status,"completed");
  await writeFile(path.join(f.root,"project/later.txt"),"later text");
  f.project.sources.push({source_id:"source-a",name:"later source",chars:10,kind:"user",text_ref:"project/later.txt"});
  f.job.agent.context_ref=await writeArtifact(f.root,"contexts",{project:f.project,export_authorized:[]});
  assert.deepEqual(await executeAgentTool(input,new AsyncJobQueue(1,5)),result);
  assert.equal(f.commands.filter(c=>c.action==="begin_tool").length,1);
  await assert.rejects(()=>executeAgentTool({...input,args:{...input.args,start:8}},new AsyncJobQueue(1,5)),/指纹/);
 } finally {await f.close();}
});
