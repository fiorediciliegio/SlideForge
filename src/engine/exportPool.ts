import { spawn,type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { ExportTask } from "./exportTask.js";

type Result={outPath:string;warnings:string[]};
type Slot={child:ChildProcess;busy:boolean;stderr:string;pending?:{id:string;resolve:(result:Result)=>void;reject:(error:Error)=>void};stopping?:Promise<void>};
const slots=new Set<Slot>();
function stop(slot:Slot) {
 if(slot.stopping)return slot.stopping;
 slot.busy=true;
 slot.stopping=new Promise<void>(resolve=>{
  if(!slot.child.pid||slot.child.exitCode!==null){resolve();return}
  if(process.platform==="win32"){
   const killer=spawn("taskkill",["/pid",String(slot.child.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});killer.once("exit",()=>resolve());
  }else{slot.child.once("exit",()=>resolve());process.kill(-slot.child.pid,"SIGKILL")}
 });return slot.stopping;
}
function createSlot():Slot {
 const child=spawn(process.execPath,["--import","tsx/esm",fileURLToPath(new URL("./exportWorkerChild.ts",import.meta.url))],{stdio:["ignore","pipe","pipe","ipc"],windowsHide:true,detached:process.platform!=="win32",env:process.env});
 const slot:Slot={child,busy:false,stderr:""};slots.add(slot);
 child.stderr?.on("data",data=>{slot.stderr=(slot.stderr+data).slice(-8000)});
 child.on("message",(message:any)=>{
  const pending=slot.pending;if(!pending||message.id!==pending.id||slot.stopping)return;
  slot.pending=undefined;slot.busy=false;
  if(message.error)pending.reject(new Error(message.error));else pending.resolve(message.result);
 });
 child.once("error",error=>{slot.pending?.reject(error);slot.pending=undefined;slots.delete(slot)});
 child.once("exit",()=>{
  slots.delete(slot);const pending=slot.pending;slot.pending=undefined;
  void (slot.stopping??Promise.resolve()).then(()=>pending?.reject(new Error(slot.stderr||"引擎导出 worker 已退出")));
 });return slot;
}
// One request per child. The engine's heavy-job slots bound this pool; retaining
// an idle Node worker avoids loading the converter on every PDF/PPTX export.
export async function executeExport(task:ExportTask,signal:AbortSignal):Promise<Result> {
 signal.throwIfAborted();const slot=[...slots].find(item=>!item.busy)??createSlot();slot.busy=true;
 const abort=()=>{void stop(slot)};signal.addEventListener("abort",abort,{once:true});
 try{return await new Promise<Result>((resolve,reject)=>{const id=randomUUID();slot.pending={id,resolve,reject};slot.child.send({...task,id})})}
 finally{signal.removeEventListener("abort",abort);signal.throwIfAborted()}
}
export async function closeExportPool(){await Promise.all([...slots].map(stop))}
