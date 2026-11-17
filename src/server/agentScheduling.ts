import {getDeckJob} from "./jobs.js";
import {mutateAgent,type AgentExecution} from "./agentClient.js";
import {HttpRequestError} from "./httpSecurity.js";
import {pageModelQueue,type PageModelIdentity} from "./pageModelQueue.js";
import type {AgentRun} from "../contracts/agent.js";

type Execution=Pick<AgentExecution,"deck_id"|"run_seq"|"runner_epoch"|"operation_id">;
type Job=NonNullable<Awaited<ReturnType<typeof getDeckJob>>> & {agent:AgentRun};
export async function currentExecution(context:Execution):Promise<Job> {
 const job=await getDeckJob(context.deck_id),run=job?.agent;
 if(!run||run.run_seq!==context.run_seq||run.runner_epoch!==context.runner_epoch||!["planning","generating","checking","revising"].includes(run.phase))throw new HttpRequestError(409,"原执行已失效，停止等待和新调用");
 if(Object.values(run.calls).some(call=>call.status==="unknown"))throw new HttpRequestError(503,"存在结果未知的模型调用，需要用户明确处理后继续","unknown_calls");
 if(run.budget.active_seconds>=run.budget.limit_seconds)throw new HttpRequestError(402,"有效执行时间预算不足","budget_exhausted");
 return job as Job;
}
export async function agentWork(context:Execution,state:"local"|"capacity"|"budget"|"engine"|"done") {
 try {await mutateAgent({action:"work_state",...context,work_state:state});}
 catch(error){if(!(state==="done"&&error instanceof HttpRequestError&&error.status===409))throw error;}
}

type Listener={update:(job:Job)=>void;error:(error:unknown)=>void};
type Watch={listeners:Set<Listener>;timer:ReturnType<typeof setInterval>;busy:boolean};
const watches=new Map<string,Watch>();
// At most one authority read per execution per tick, shared by its waiting pages.
function watchExecution(context:Execution,listener:Listener) {
 const key=JSON.stringify([context.deck_id,context.run_seq,context.runner_epoch]);
 let watch=watches.get(key);
 if(!watch){
  const tick=async()=>{
   if(watch!.busy)return;watch!.busy=true;
   try{const job=await currentExecution(context);for(const item of [...watch!.listeners])item.update(job)}
   catch(error){for(const item of [...watch!.listeners])item.error(error)}
   finally{watch!.busy=false}
  };
  watch={listeners:new Set(),timer:setInterval(()=>void tick(),250),busy:false};watches.set(key,watch);
  queueMicrotask(()=>void tick());
 }
 watch.listeners.add(listener);
 let stopped=false;
 return ()=>{if(stopped)return;stopped=true;watch!.listeners.delete(listener);if(!watch!.listeners.size){clearInterval(watch!.timer);if(watches.get(key)===watch)watches.delete(key)}};
}
export function awaitAgentOperation<T>(context:Execution,operation:Promise<T>):Promise<T> {
 return new Promise((resolve,reject)=>{
  const stop=watchExecution(context,{update:()=>{},error:error=>{stop();reject(error)}});
  operation.then(result=>{stop();resolve(result)},error=>{stop();reject(error)});
 });
}
export async function acquireAgentPageSlot(context:Execution,identity:PageModelIdentity) {
 await agentWork(context,"capacity");
 const controller=new AbortController(),stop=watchExecution(context,{update:()=>{},error:error=>controller.abort(error)});
 let release:(()=>void)|undefined;
 try{release=await pageModelQueue().acquire(identity,controller.signal);await currentExecution(context);await agentWork(context,"local");return release}
 catch(error){release?.();throw error}
 finally{stop()}
}
export async function waitAgentBudget(context:Execution,cost:number) {
 await agentWork(context,"budget");
 await new Promise<void>((resolve,reject)=>{
  const stop=watchExecution(context,{
   update:job=>{
    const {budget,calls}=job.agent;
    if(budget.spent_cny+cost>budget.limit_cny+0.0000001){stop();reject(new HttpRequestError(402,"任务预算不足，请明确追加预算后继续","budget_exhausted"));return}
    if(budget.spent_cny+budget.reserved_cny+cost<=budget.limit_cny+0.0000001){stop();resolve();return}
    if(!Object.values(calls).some(call=>call.status==="sent"||call.status==="reserved")){stop();reject(new HttpRequestError(409,"费用预留没有可推进的调用，请恢复执行状态"))}
   },error:error=>{stop();reject(error)},
  });
 });
 await agentWork(context,"local");
}
