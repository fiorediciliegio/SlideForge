import path from "node:path";
import { createHash,randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile,realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { engineSnapshotSchema,type EngineSnapshot,type EngineJob,type EngineParams,type EngineResult } from "../contracts/engine.js";
import { engineTransport,requireEngineWorker } from "./engineTransport.js";
import { HttpRequestError } from "./httpSecurity.js";
import { currentBillingOwner } from "../billing/index.js";
import { getDeckJob } from "./jobs.js";
import { mutateAgent,currentAgentCall } from "./agentClient.js";

export interface EngineContext {ownerKeyHash?:string;operationId?:string;agent?:{deck_id:string;run_seq:number;runner_epoch:number}}
const ownerContext=new AsyncLocalStorage<string|undefined>();
export const runWithEngineOwner=<T>(owner:string|undefined,action:()=>T)=>ownerContext.run(owner,action);
const ownerOf=(context:EngineContext)=>context.ownerKeyHash??ownerContext.getStore()??currentBillingOwner()??"local";

async function embedAssets(html:string,root:string):Promise<string> {
  const references=new Set<string>();
  const hyperlink=/<a\b[^>]*\bhref\s*=\s*["']https?:\/\/[^"']+["'][^>]*>/gi;
  const links:string[]=[];
  // Hyperlinks are text/navigation, not resources to download on the worker.
  html=html.replace(hyperlink,tag=>{links.push(tag);return `<!--slideforge-link-${links.length-1}-->`});
  const resource=/\b(?:src|href)=["']([^"']+)["']|url\(\s*["']?([^)"']+)/gi;
  const embedded=new Map<string,string>();
  for(const match of html.matchAll(resource)){
    const value=(match[1]??match[2]).trim();if(!value.startsWith("data:")&&!value.startsWith("#"))references.add(value);
  }
  for(const reference of references) {
    if(/^[a-z][a-z0-9+.-]*:|^[/\\]/i.test(reference))throw new Error("渲染输入资源必须位于当前作品内并内嵌");
    const target=await realpath(path.resolve(root,reference)),safeRoot=await realpath(root);
    if(!target.startsWith(safeRoot+path.sep))throw new Error("渲染资源越过当前作品边界");
    const extension=path.extname(target).toLowerCase(),types:Record<string,string>={".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".svg":"image/svg+xml",".woff2":"font/woff2",".woff":"font/woff",".ttf":"font/ttf",".otf":"font/otf"};
    if(!types[extension])throw new Error("不支持的渲染资源类型");
    const data=`data:${types[extension]};base64,${(await readFile(target)).toString("base64")}`;
    embedded.set(reference,data);
  }
  html=html.replace(resource,(match,attribute:string,css:string)=>{const reference=(attribute??css).trim();return embedded.has(reference)?match.replace(reference,embedded.get(reference)!):match});
  return html.replace(/<!--slideforge-link-(\d+)-->/g,(_match,index)=>links[Number(index)]);
}

export async function snapshotWorkspace(runDir:string):Promise<EngineSnapshot> {
  const root=path.resolve(runDir),outline=JSON.parse(await readFile(path.join(root,"outline.json"),"utf8"));
  let project:{deck_id:string;revision_id:string;pages:Array<{page_id:string;html_ref:string}>}|undefined;
  try{project=JSON.parse(await readFile(path.join(root,"project.json"),"utf8"))}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error}
  const deckId=project?.deck_id??root.split(path.sep).reverse().find(part=>part.startsWith("deck-"))??`deck-${createHash("sha256").update(root).digest("hex").slice(0,12)}`;
  const pages=[];
  for(let index=0;index<(project?.pages.length??outline.pages.length);index++){
    const item=project?.pages[index],file=path.resolve(root,item?.html_ref??`page-${index+1}.html`);
    if(!file.startsWith(root+path.sep))throw new Error("页面文件越界");
    pages.push({page_id:item?.page_id??`page-${index+1}`,html:await embedAssets(await readFile(file,"utf8"),root)});
  }
  return engineSnapshotSchema.parse({schema_version:1,deck_id:deckId,revision_id:project?.revision_id,title:outline.title,pages,deck_html:await embedAssets(await readFile(path.join(root,"deck.html"),"utf8"),root)});
}
export async function submitEngineSnapshot(snapshot:EngineSnapshot,kind:EngineJob["kind"],params:EngineParams,context:EngineContext={}):Promise<EngineJob> {
  const bytes=Buffer.from(JSON.stringify(engineSnapshotSchema.parse(snapshot)));
  if(bytes.length>64*1024*1024)throw new HttpRequestError(413,"引擎输入超过64 MiB");
  const owner=ownerOf(context),artifact=await engineTransport.put(owner,snapshot.deck_id,bytes);
  const job=await engineTransport.submit({owner_key_hash:owner,deck_id:snapshot.deck_id,snapshot_id:artifact.artifact_id,source_hash:artifact.sha256,kind,params,operation_id:context.operationId??randomUUID(),profile_version:"html-v1-engine-1",...(context.agent?{agent_run_seq:context.agent.run_seq,agent_epoch:context.agent.runner_epoch}:{})});
  if(job.state==="queued")await requireEngineWorker();
  return job;
}
export async function waitEngineJob(initial:EngineJob,context:EngineContext={}):Promise<EngineResult> {
  let job=initial;
  let registered=false,lastState="";
  const assertCurrent=async()=>{
    if(context.agent) {
      const current=(await getDeckJob(context.agent.deck_id))?.agent;
      if(!current||current.run_seq!==context.agent.run_seq||current.runner_epoch!==context.agent.runner_epoch||!["planning","generating","checking","revising"].includes(current.phase)) {
        if(job.state==="queued"||job.state==="running")await engineTransport.cancel(job.job_id,job.owner_key_hash);
        throw new HttpRequestError(409,"原 Agent 执行已失效，拒绝使用引擎结果");
      }
    }
  };
  try {
  while(job.state==="queued"||job.state==="running") {
    await assertCurrent();
    if(context.agent) {
      if(lastState!==job.state){await mutateAgent({action:"engine_wait",...context.agent,operation_id:job.job_id,engine_state:job.state});registered=true;lastState=job.state}
    }
    await delay(150);job=await engineTransport.get(job.job_id,job.owner_key_hash);
  }
  if(job.state!=="completed")throw new HttpRequestError(job.state==="cancelled"?409:422,job.error??"引擎任务已取消");
  await assertCurrent();
  return JSON.parse((await engineTransport.read(job.result_ref!,job.owner_key_hash)).toString("utf8"));
  } finally {
    if(registered&&context.agent)try{await mutateAgent({action:"engine_wait",...context.agent,operation_id:job.job_id,engine_state:"done"})}catch(error){if(!(error instanceof HttpRequestError&&error.status===409))throw error}
  }
}
export async function validateEngineHTML(html:string,context:EngineContext & {deckId?:string;runDir?:string}={}) {
  const active=currentAgentCall();if(!context.agent&&active)context={...context,agent:active};
  const id=context.runDir?.split(path.sep).reverse().find(part=>part.startsWith("deck-"));
  const snapshot:EngineSnapshot={schema_version:1,deck_id:context.deckId??context.agent?.deck_id??id??"deck-validation",title:"页面校验",pages:[{page_id:"page-1",html}]};
  const job=await submitEngineSnapshot(snapshot,"validate",{layout:true},context),result=await waitEngineJob(job,context);
  return result.pages![0].report!;
}
export async function inspectEngineWorkspace(runDir:string,params:EngineParams,context:EngineContext={}) {
  const snapshot=await snapshotWorkspace(runDir);
  const selected={...params,...(params.pages?{pages:params.pages.filter(page=>Number.isInteger(page)&&page>=1&&page<=snapshot.pages.length)}:{})};
  const job=await submitEngineSnapshot(snapshot,"inspect",selected,context);
  return waitEngineJob(job,context);
}
export async function startWorkspaceExport(runDir:string,format:"pptx"|"pdf",context:EngineContext={}) {
  const snapshot=await snapshotWorkspace(runDir);
  if(snapshot.pages.length<2)throw new HttpRequestError(409,"页面尚未完整生成");
  return submitEngineSnapshot(snapshot,"export",{format},context);
}
