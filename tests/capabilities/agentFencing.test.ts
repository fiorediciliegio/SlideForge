import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "node:http";
import {once} from "node:events";
import {mkdir,rm} from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {executeAgentTool,agentRoot} from "../../src/capabilities/agent.ts";
import {emptyProject,writeArtifact} from "../../src/capabilities/project.ts";
import {AsyncJobQueue} from "../../src/server/jobQueue.ts";
import {agentOptionsSchema} from "../../src/contracts/agent.ts";

for(const change of ["epoch","revision"] as const)test(`a delayed tool cannot adopt a newer ${change} to publish stale output`,async()=>{
 const id=`deck-fence-${randomUUID()}`,root=agentRoot(id);await mkdir(root,{recursive:true});
 const project=emptyProject(id,"test",{draft_revision:0,title:"test",pages:[]});
 const context_ref=await writeArtifact(root,"contexts",{project,export_authorized:[]});
 const options=agentOptionsSchema.parse({version:1,page_policy:{mode:"fixed",count:2}});
 const job:any={id,status:"creating",events:[],overflowPages:[],agent:{version:1,run_seq:1,runner_epoch:1,checkpoint_seq:1,phase:"planning",context_ref,draft_revision:0,options,calls:{},operations:{},budget:{active_seconds:0,limit_seconds:600,spent_cny:0,reserved_cny:0,limit_cny:2}}};
 let published=false;
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());
  if(body.action==="begin_tool"){
   job.agent.operations[body.operation_id]={status:"pending",input_hash:body.input_hash};
   if(change==="epoch")job.agent.runner_epoch=2;
   else job.agent.project_ref={revision_id:"user-new",artifact_ref:"project/revisions/user-new",outline_revision:1,constraints_revision:1};
  }
  if(body.action==="complete_tool"){
   if(body.runner_epoch!==job.agent.runner_epoch){res.writeHead(409,{"content-type":"application/json"});res.end('{"error":"stale epoch"}');return;}
   published=true;
  }
  res.setHeader("content-type","application/json");res.end(JSON.stringify({job}));
 });
 server.listen(0,"127.0.0.1");await once(server,"listening");const port=(server.address() as any).port;
 const previous=[process.env.SLIDEFORGE_JOB_API_URL,process.env.SLIDEFORGE_BRAIN_API_URL,process.env.GATEWAY_INTERNAL_TOKEN];
 process.env.SLIDEFORGE_JOB_API_URL=`http://127.0.0.1:${port}/internal/jobs`;process.env.SLIDEFORGE_BRAIN_API_URL="http://127.0.0.1:1/internal/brain";process.env.GATEWAY_INTERNAL_TOKEN="fence-test";
 try {
  const args=change==="epoch"?{section:"context"}:{scenario:{category:"企业",subtype:"产品介绍",reason:"test"},title:"old plan",pages:[{title:"A",bullets:[]},{title:"B",bullets:[]}]};
  await assert.rejects(()=>executeAgentTool({deck_id:id,run_seq:1,runner_epoch:1,operation_id:"selected",name:change==="epoch"?"read_project":"save_plan",args},new AsyncJobQueue(1,10)),/执行|版本|修订/);
  assert.equal(published,false);
 } finally {
  ["SLIDEFORGE_JOB_API_URL","SLIDEFORGE_BRAIN_API_URL","GATEWAY_INTERNAL_TOKEN"].forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index]});
  server.close();await once(server,"close");
  if(path.dirname(root)!==path.resolve("artifacts/decks"))throw new Error("unsafe fixture cleanup");await rm(root,{recursive:true,force:true});
 }
});
