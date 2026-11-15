import type { EngineArtifact, EngineJob, EngineRequest } from "../contracts/engine.js";
import { HttpRequestError } from "./httpSecurity.js";

export function engineAPIURL() {
  const configured=process.env.SLIDEFORGE_ENGINE_API_URL;
  if(configured)return configured.replace(/\/$/,"");
  const jobs=process.env.SLIDEFORGE_JOB_API_URL;
  if(jobs)return jobs.replace(/\/jobs\/?$/, "/engine");
  return "http://127.0.0.1:8080/internal/engine";
}
export async function enginePost<T>(route:string,body:unknown):Promise<T> {
  const response=await fetch(`${engineAPIURL()}/${route}`,{method:"POST",headers:{"content-type":"application/json","x-internal-token":process.env.GATEWAY_INTERNAL_TOKEN??(process.env.NODE_ENV==="production"?"":"development-internal-token")},body:JSON.stringify(body),signal:AbortSignal.timeout(60_000)});
  const payload=await response.json() as T & {error?:string};
  if(!response.ok)throw new HttpRequestError(response.status,payload.error??`引擎任务服务 HTTP ${response.status}`);
  lastEngineContact=Date.now();
  return payload;
}
let lastEngineContact=0;
export const engineQueueConnected=()=>Date.now()-lastEngineContact<30_000;
export async function requireEngineWorker(){
 try{const response=await fetch(`${process.env.NODE_ENGINE_URL??"http://127.0.0.1:3211"}/healthz`,{signal:AbortSignal.timeout(3000)});if(response.ok)return}catch(error){throw new HttpRequestError(503,`独立引擎未就绪：${error instanceof Error?error.message:String(error)}`)}
 throw new HttpRequestError(503,"独立引擎无法领取任务，请检查引擎与网关的连接和内部令牌");
}
export const engineTransport={
  async put(owner:string,deck:string,bytes:Buffer,media="application/json") {return (await enginePost<{artifact:EngineArtifact}>("artifacts",{action:"put",owner_key_hash:owner,deck_id:deck,media_type:media,content_base64:bytes.toString("base64")})).artifact},
  async read(id:string,owner:string) {return Buffer.from((await enginePost<{content_base64:string}>("artifacts",{action:"read",artifact_id:id,owner_key_hash:owner})).content_base64,"base64")},
  async submit(request:EngineRequest) {return (await enginePost<{job:EngineJob}>("jobs",{action:"submit",request})).job},
  async get(id:string,owner:string) {return (await enginePost<{job:EngineJob}>("jobs",{action:"get",job_id:id,owner_key_hash:owner})).job},
  async claim(worker:string) {return (await enginePost<{job:EngineJob|null}>("claim",{worker_id:worker})).job},
  async update(id:string,token:string,action:string,result_ref?:string,error?:string) {return (await enginePost<{job:EngineJob}>("jobs",{action,job_id:id,lease_token:token,result_ref,error})).job},
  async cancel(id:string,owner:string) {return (await enginePost<{job:EngineJob}>("jobs",{action:"cancel",job_id:id,owner_key_hash:owner})).job},
};
