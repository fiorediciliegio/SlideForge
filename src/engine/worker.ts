import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { EngineJob, EngineResult, EngineArtifact } from "../contracts/engine.js";
import { engineTransport } from "../server/engineTransport.js";

interface WorkerAPI {
  read(id:string,owner:string):Promise<Buffer>;
  put(owner:string,deck:string,data:Buffer,media?:string):Promise<EngineArtifact>;
  update(id:string,token:string,action:string,result_ref?:string,error?:string):Promise<EngineJob>;
}
type Execution=(input:Buffer,job:EngineJob,signal:AbortSignal)=>Promise<EngineResult & { file?:Buffer }>;
export async function executeClaimedJob(job:EngineJob,api:WorkerAPI,execute:Execution,parent:AbortSignal,heartbeatMs=10_000) {
  const controller=new AbortController();
  const abort=()=>controller.abort(parent.reason);parent.addEventListener("abort",abort,{once:true});if(parent.aborted)abort();
  let pulsing=false;
  let leaseLost=false;
  const heartbeat=setInterval(()=>{
    if(pulsing)return;pulsing=true;
    void api.update(job.job_id,job.lease_token!,"heartbeat").catch(error=>{leaseLost=true;controller.abort(error)}).finally(()=>{pulsing=false});
  },heartbeatMs);
  const timeout=setTimeout(()=>controller.abort(new Error("引擎作业执行超时")),job.kind==="export"?600_000:120_000);
  try {
    const input=await api.read(job.snapshot_id,job.owner_key_hash);
    controller.signal.throwIfAborted();
    const {file,...result}=await execute(input,job,controller.signal);
    controller.signal.throwIfAborted();
    if(file)result.file_ref=(await api.put(job.owner_key_hash,job.deck_id,file,result.media_type)).artifact_id;
    const artifact=await api.put(job.owner_key_hash,job.deck_id,Buffer.from(JSON.stringify(result)));
    controller.signal.throwIfAborted();
    await api.update(job.job_id,job.lease_token!,"complete",artifact.artifact_id);
  } catch(error) {
    // A worker shutdown leaves the lease to expire. Cancellation/lease loss is
    // already authoritative in Go, so this worker cannot publish a new state.
    if(!parent.aborted&&!leaseLost) {
      try {await api.update(job.job_id,job.lease_token!,"fail",undefined,error instanceof Error?error.message:String(error))}
      catch(updateError) {if(!(updateError instanceof Error&&"status" in updateError&&updateError.status===409))console.error("[engine] result acknowledgement failed",updateError instanceof Error?updateError.message:String(updateError))}
    }
  } finally {clearInterval(heartbeat);clearTimeout(timeout);parent.removeEventListener("abort",abort)}
}

export async function runEngineWorker(signal:AbortSignal,concurrency:number,execute:Execution) {
  const worker=`${process.pid}-${randomUUID()}`;
  async function slot(index:number) {
    while(!signal.aborted) {
      try {
        const job=await engineTransport.claim(`${worker}-${index}`);
        if(job) {await executeClaimedJob(job,engineTransport,execute,signal);continue}
      }catch(error){if(!signal.aborted)console.error("[engine] claim failed:",error instanceof Error?error.message:String(error))}
      await delay(200,undefined,{signal}).catch(()=>undefined);
    }
  }
  await Promise.all(Array.from({length:concurrency},(_,index)=>slot(index)));
}
