// 运行：SLIDEFORGE_GO_BINARY=... node --import tsx/esm 此脚本。
// 真 Chrome、固定 HTML、独立业务与引擎目录；不调用真实模型。
import {writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {engineHarness,fixedWorkspace,testOwner} from '../../tests/helpers/engineHarness.ts';
import {snapshotWorkspace,submitEngineSnapshot,waitEngineJob} from '../../src/server/engineClient.ts';
import {engineTransport} from '../../src/server/engineTransport.ts';
const run=promisify(execFile),h=await engineHarness(Number(process.env.BENCH_CONCURRENCY??1)),metrics=[];
const rpc={get:[],submit:[]};
for(const name of ['get','submit']){const original=engineTransport[name];engineTransport[name]=async(...args)=>{const start=performance.now();try{return await original(...args)}finally{rpc[name].push(performance.now()-start)}}}
const quantile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??0};
let peakTree=0,peakBusiness=0,minFree=os.freemem(),sampling=false;
const timer=setInterval(async()=>{
 peakBusiness=Math.max(peakBusiness,process.memoryUsage().rss);minFree=Math.min(minFree,os.freemem());
 if(sampling||process.platform!=='win32')return;sampling=true;
 try {
  const {stdout}=await run('powershell.exe',['-NoProfile','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress'],{windowsHide:true,maxBuffer:2*1024*1024});
  const rows=JSON.parse(stdout),ids=new Set([process.pid,h.gateway.pid,h.engine.pid]);let changed=true;
  while(changed){changed=false;for(const row of rows)if(ids.has(row.ParentProcessId)&&!ids.has(row.ProcessId)){ids.add(row.ProcessId);changed=true}}
  peakTree=Math.max(peakTree,rows.filter(row=>ids.has(row.ProcessId)).reduce((sum,row)=>sum+Number(row.WorkingSetSize),0));
 }catch(error){console.error('memory sample failed:',error.message)}finally{sampling=false}
},2000);
async function save(){await writeFile(new URL('./service-metrics.json',import.meta.url),JSON.stringify({metrics,rpc:Object.fromEntries(Object.entries(rpc).map(([name,values])=>[name,{samples:values.length,p50_ms:quantile(values,.5),p95_ms:quantile(values,.95)}])),concurrency:Number(process.env.BENCH_CONCURRENCY??1),peak_process_tree_rss:peakTree,peak_business_rss:peakBusiness,min_system_free:minFree,hardware:{cpus:os.cpus().length,total_memory:os.totalmem()},provider:'fixed-html-no-model'},null,2))}
async function measure(snapshot,kind,owner,group,round) {
 const input={...snapshot,revision_id:`bench-${group}-${kind}-${round}-${owner.slice(0,6)}`};
 const params=kind==='validate'?{pages:[1],layout:true}:kind==='preview'?{pages:[1,2,3,4],layout:false,visual:true}:{format:kind};
 const start=performance.now();
 const job=await submitEngineSnapshot(input,kind==='preview'?'inspect':kind==='validate'?'validate':'export',params,{ownerKeyHash:owner});
 const submit=performance.now()-start;
 const result=await waitEngineJob(job),done=await engineTransport.get(job.job_id,owner);
 // Include file transfer to the business process, as in the old export path.
 if(result.file_ref)await engineTransport.read(result.file_ref,owner);
 const metric={group,pages:snapshot.pages.length,kind,round,submit_ms:submit,queue_ms:Date.parse(done.started_at)-Date.parse(done.queued_at),execution_ms:result.timings_ms.execution,total_ms:performance.now()-start};
 metrics.push(metric);await save();return metric;
}
try {
 const inputs={};for(const count of [6,20])inputs[count]=await snapshotWorkspace(await fixedWorkspace(h.business,count));
 for(const count of [6,20])for(const kind of (process.env.BENCH_KINDS?.split(',')??['validate','preview','pptx','pdf'])){
  await measure(inputs[count],kind,testOwner(h.keys[0]),'warm',-1);
  for(let round=0;round<5;round++)await measure(inputs[count],kind,testOwner(h.keys[0]),'single',round);
  console.log('single',count,kind,'done');
 }
 const mixed=['validate','preview','pptx','pdf','validate'];
 await Promise.all(mixed.map((kind,index)=>measure(inputs[index%2?20:6],kind,testOwner(h.keys[index]),'mixed5',index)));
 console.log('mixed5 done');
 await Promise.all(Array.from({length:10},(_,index)=>measure(inputs[index%2?20:6],mixed[index%mixed.length],testOwner(h.keys[index]),'burst10',index)));
 console.log('burst10 done');
 await save();
}catch(error){console.error(h.logs.slice(-20).join('\n'));throw error}finally{clearInterval(timer);await h.close()}
