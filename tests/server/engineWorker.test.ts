import test from "node:test";
import assert from "node:assert/strict";
import { executeClaimedJob } from "../../src/engine/worker.js";
import type { EngineJob } from "../../src/contracts/engine.js";

test("worker uploads output before completion and binds the original lease",async()=>{
 const events:string[]=[];
 const job={job_id:"engine-one",deck_id:"deck-one",owner_key_hash:"a",snapshot_id:"input",source_hash:"sha",lease_token:"lease-1",kind:"validate",params:{}} as EngineJob;
 const api={read:async()=>Buffer.from(JSON.stringify({schema_version:1,deck_id:"deck-one",title:"Test",pages:[{page_id:"p1",html:"html"}]})),put:async()=>{events.push("upload");return {artifact_id:"result",sha256:"",size_bytes:1}},update:async(_id:string,token:string,action:string)=>{assert.equal(token,"lease-1");events.push(action);return job}};
 await executeClaimedJob(job,api,async()=>({pages:[]}),new AbortController().signal,10000);
 assert.deepEqual(events,["upload","complete"]);
});
test("a cancelled worker never completes a result",async()=>{
 const controller=new AbortController();let completed=false;
 const job={job_id:"engine-one",deck_id:"deck-one",owner_key_hash:"a",snapshot_id:"input",lease_token:"lease-1",kind:"validate",params:{}} as EngineJob;
 const api={read:async()=>Buffer.from("{}"),put:async()=>({artifact_id:"result",sha256:"",size_bytes:1}),update:async(_id:string,_token:string,action:string)=>{if(action==="complete")completed=true;return job}};
 await executeClaimedJob(job,api,async()=>{controller.abort();return {}},controller.signal,10000);
 assert.equal(completed,false);
});
