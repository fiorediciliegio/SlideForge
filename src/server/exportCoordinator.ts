import path from "node:path";
import { createHash,randomUUID } from "node:crypto";
import { mkdir, writeFile,readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ExportDeckResult } from "../capabilities/deck.js";
import type { EngineJob } from "../contracts/engine.js";
import { apiKeyHash } from "../billing/index.js";
import { snapshotWorkspace,submitEngineSnapshot,waitEngineJob,type EngineContext } from "./engineClient.js";
import { enginePost,engineTransport } from "./engineTransport.js";
import { HttpRequestError } from "./httpSecurity.js";

export interface IdempotentExportInput {
 apiKey?:string;ownerKeyHash?:string;deckId:string;runDir:string;format:"pptx"|"pdf";
 outPath:string;idempotencyKey?:string;revisionId?:string;agent?:EngineContext["agent"];
}
export interface IdempotentExportResult extends ExportDeckResult {
 billing:{points:number;balance?:number};export_id:string;idempotent:boolean;file_id?:string;download_url?:string;
}
export async function previousExportReceipt(input:IdempotentExportInput):Promise<IdempotentExportResult|undefined>{
 const file=path.join(process.env.SLIDEFORGE_DATA_DIR??path.resolve(import.meta.dirname,"../../data"),"export-receipts.json");
 let receipts:Record<string,any>;
 try{receipts=JSON.parse(await readFile(file,"utf8"))}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error}
 const fingerprint=createHash("sha256").update(input.format).update("\0").update(await readFile(path.join(input.runDir,"deck.html"))).digest("hex");
 const identify=(key?:string)=>createHash("sha256").update([input.ownerKeyHash??apiKeyHash(input.apiKey)??"local",input.deckId,input.format,...(input.revisionId?[`revision:${input.revisionId}`]:[]),key?`key:${key.trim()}`:`content:${fingerprint}`].join("\0")).digest("hex");
 const explicit=identify(input.idempotencyKey),implicit=identify();
 const id=receipts[explicit]?explicit:implicit;const receipt=receipts[id];if(!receipt)return;
 if(receipt.fingerprint!==fingerprint)throw new HttpRequestError(409,"同一 Idempotency-Key 不能用于不同内容");
 if(!receipt.result.download_url&&!existsSync(receipt.result.outPath))throw new HttpRequestError(409,"原付费文件已不存在，请恢复文件后重试");
 return {...receipt.result,billing:receipt.charge,export_id:id,idempotent:true};
}
export async function beginEngineExport(input:IdempotentExportInput):Promise<EngineJob> {
 const key=input.idempotencyKey?.trim();
 if(key&&(key.length>128||!/^[\w:.-]+$/.test(key)))throw new HttpRequestError(400,"Idempotency-Key 最长128字符，只允许字母、数字、下划线、点、冒号和连字符");
 const snapshot=await snapshotWorkspace(input.runDir),owner=input.ownerKeyHash??apiKeyHash(input.apiKey)??"local";
 if(snapshot.deck_id!==input.deckId)throw new HttpRequestError(409,"作品与导出输入不符");
 const outline=JSON.parse(await readFile(path.join(input.runDir,"outline.json"),"utf8"));
 if(snapshot.pages.length<2||snapshot.pages.length!==outline.pages.length)throw new HttpRequestError(409,"页面尚未完整生成");
 const operationId=createHash("sha256").update([owner,input.deckId,input.format,input.revisionId??"",key?`key:${key}`:`request:${randomUUID()}`].join("\0")).digest("hex");
 return submitEngineSnapshot(snapshot,"export",{format:input.format},{ownerKeyHash:owner,operationId,agent:input.agent});
}
export async function engineExportStatus(deckId:string,owner:string,id:string):Promise<{state:EngineJob["state"];engine_job_id:string;error?:string;result?:IdempotentExportResult}> {
 const job=await engineTransport.get(id,owner);
 if(job.deck_id!==deckId||job.kind!=="export")throw new HttpRequestError(404,"导出任务不存在");
 if(job.state!=="completed")return {state:job.state,engine_job_id:id,...(job.error?{error:job.error}:{})};
 const result=await enginePost<IdempotentExportResult>("jobs",{action:"deliver",job_id:id,owner_key_hash:owner});
 return {state:"completed",engine_job_id:id,result};
}
export async function runIdempotentExport(input:IdempotentExportInput):Promise<IdempotentExportResult> {
 const previous=await previousExportReceipt(input);if(previous)return previous;
 const job=await beginEngineExport(input);
 const result=await waitEngineJob(job,{agent:input.agent});
 // Local stdio/CLI is a trusted local tool. Customer exports always require the
 // Go delivery receipt; only that receipt opens a public authenticated download.
 if(input.ownerKeyHash||input.apiKey) {
  const receipt=(await engineExportStatus(input.deckId,job.owner_key_hash,job.job_id)).result!;
  return {...receipt,outPath:input.outPath};
 }
 await mkdir(path.dirname(input.outPath),{recursive:true});
 const bytes=await engineTransport.read(result.file_ref!,job.owner_key_hash);await writeFile(input.outPath,bytes);
 return {outPath:input.outPath,sizeBytes:bytes.length,slideCount:result.slide_count!,warnings:result.warnings??[],billing:{points:0},export_id:job.job_id,idempotent:job.state==="completed"};
}
