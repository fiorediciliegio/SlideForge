import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createWriteStream,existsSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import os from 'node:os';
import {startProxy} from '../harness-real-eval/proxy.mjs';
import {score} from '../harness-real-eval/score.mjs';

const here=import.meta.dirname,root=path.resolve(here,'../..'),preflight=process.argv.includes('--preflight');
const out=path.join(here,'20261113',preflight?'service-preflight-2':'results');
if(existsSync(out))throw new Error('Choose a new reviewed run; no automatic paid replay');
await mkdir(out,{recursive:true});
const projectEnv=parseEnv(await readFile(path.join(root,'.env'),'utf8'));
if(!preflight&&!projectEnv.OPENAI_API_KEY)throw new Error('Missing project DeepSeek credential');
const fixturesRoot=path.join(root,'.scratch/harness-real-eval/20261112-172000');
const fixtures=JSON.parse(await readFile(path.join(fixturesRoot,'fixtures.json'),'utf8'));
if(!fixtures.all_materials_synthetic)throw new Error('Only synthetic fixtures authorized');
const port=48420,base=`http://127.0.0.1:${port}`,token='batch-ab-internal',admin='batch-ab-admin';
const proxy=await startProxy({out,key:preflight?'no-provider-key':projectEnv.OPENAI_API_KEY,port:port+4,limitCny:preflight?0:30});
const metadata={status:'running',preflight,started_at:new Date().toISOString(),model:'deepseek-flash',limit_cny:preflight?0:30,planned_trials:preflight?0:12,baseline_audit:JSON.parse(await readFile(path.join(here,'20261113/baseline-audit.json'),'utf8')),hardware:{cpu:os.cpus()[0].model,cpus:os.cpus().length,memory_bytes:os.totalmem(),node:process.version},records:[]};
const save=()=>writeFile(path.join(out,'metadata.json'),JSON.stringify(metadata,null,2));await save();
const pause=ms=>new Promise(r=>setTimeout(r,ms));let child,log,key='';
async function api(route,body,mode='user'){
 const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(mode==='internal'?{'x-internal-token':token}:mode==='admin'?{'x-admin-token':admin}:{'x-api-key':key})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(65000)});
 const result=await response.json();if(!response.ok)throw new Error(`HTTP ${response.status}: ${JSON.stringify(result).slice(0,400)}`);return result;
}
async function stop(){
 if(child?.exitCode===null){const killer=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});await once(killer,'exit');await Promise.race([once(child,'exit'),pause(3000)]);}
 if(log)await new Promise(resolve=>log.end(resolve));child=undefined;log=undefined;
}
async function launch(arm,dir){
 const env={...projectEnv,...process.env,NODE_ENV:'development',OPENAI_API_KEY:'evaluation-proxy-placeholder',OPENAI_MODEL:'deepseek-flash',OPENAI_BASE_URL:'https://api.deepseek.com',OPENAI_FALLBACK_API_KEY:'',OPENAI_FALLBACK_BASE_URL:'',OPENAI_FALLBACK_MODEL:'',SF_EVAL_PROXY:`http://127.0.0.1:${port+4}`,SF_AB_ARM:arm,SF_AB_TRACE:path.join(dir,'runtime-load.jsonl'),NODE_OPTIONS:`--import=${pathToFileURL(path.join(here,'runtime.mjs')).href}`,PYTHONPATH:[here,path.join(root,'services/brain')].join(path.delimiter),PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',GATEWAY_PORT:String(port),PORT:String(port+1),ENGINE_PORT:String(port+2),BRAIN_PORT:String(port+3),SLIDEFORGE_DATA_DIR:path.join(dir,'data'),GATEWAY_INTERNAL_TOKEN:token,SLIDEFORGE_ADMIN_TOKEN:admin,AGENT_INPUT_CNY_PER_MILLION:'2',AGENT_OUTPUT_CNY_PER_MILLION:'8',AGENT_PRICING_VERSION:'batch-ab-peak-cache-miss-2026-11-13',ENGINE_UPSTREAM_URL:`http://127.0.0.1:${port+1}`,NODE_ENGINE_URL:`http://127.0.0.1:${port+2}`,BRAIN_URL:`http://127.0.0.1:${port+3}`,SLIDEFORGE_BILLING_API_URL:base+'/internal',SLIDEFORGE_JOB_API_URL:base+'/internal/jobs',SLIDEFORGE_FILE_API_URL:base+'/internal/files',SLIDEFORGE_ENGINE_API_URL:base+'/internal/engine',SLIDEFORGE_BRAIN_API_URL:`http://127.0.0.1:${port+3}/internal/brain`,HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'*'};
 for(const k of ['DATABASE_URL','JOBS_DATABASE_URL','FILES_DATABASE_URL','S3_ENDPOINT','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'])env[k]='';
 log=createWriteStream(path.join(dir,'services.log'));
 child=spawn(process.execPath,['scripts/dev-services.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 let ready=false;for(let i=0;i<500;i++){try{if((await fetch(base+'/readyz')).ok){ready=true;break}}catch{}if(child.exitCode!==null)break;await pause(100);}if(!ready)throw new Error('Isolated services not ready: '+dir);
 key=(await api('/admin/keys',{name:'batch-ab-synthetic',points:1000},'admin')).key;
}
async function drain(){
 const began=Date.now();while(proxy.calls.some(c=>c.status==='inflight')){if(Date.now()-began>250000)throw new Error('Provider requests remain unresolved');await pause(500);}
 if(proxy.fatal)throw new Error(proxy.fatal);
}
async function exported(record,dir){
 const began=performance.now();let result=await api(`/decks/${record.deck_id}/export`,{format:'pptx',idempotency_key:`batch-ab-${record.id}`});
 if(result.status_url){const route=result.status_url;for(let i=0;i<240;i++){result=await api(route);if(['completed','failed','cancelled'].includes(result.state))break;await pause(1000);}if(result.state!=='completed')throw new Error('Export did not complete: '+JSON.stringify(result));result=result.result;}
 const downloaded=await fetch(base+result.download_url,{headers:{'x-api-key':key}});if(!downloaded.ok)throw new Error('Download HTTP '+downloaded.status);
 const file=path.join(dir,'deck.pptx');await writeFile(file,Buffer.from(await downloaded.arrayBuffer()));
 const check=JSON.parse(execFileSync(path.join(root,'.tooling/brain-venv/Scripts/python.exe'),['-X','utf8',path.join(root,'.scratch/harness-real-eval/pptx-check.py'),file],{encoding:'utf8',windowsHide:true}));
 record.export={elapsed_ms:performance.now()-began,...check,file};await writeFile(path.join(dir,'pptx-check.json'),JSON.stringify(check,null,2));
}
async function trial(fixture,arm){
 const id=`${fixture.id}-${arm}`,dir=path.join(out,id);await mkdir(dir,{recursive:true});proxy.setTrial(id,2);
 const record={id,case_id:fixture.id,arm,status:'running',expected_scene:fixture.scene,started_at:new Date().toISOString(),events:[]};metadata.records.push(record);await save();console.log(`[batch-ab] ${id} starting`);
 try{
  await launch(arm,dir);
  const body={brief:fixture.brief,page_count:6,template_id:fixtures.template_id,agent_options:{version:1,generation_mode:'direct',page_policy:{mode:'fixed',count:6},research_allowed:false,budget:{active_seconds:600,estimated_cost_cny:2}}};
  if(fixture.attachment){body.filename=path.basename(fixture.attachment);body.attachment_base64=(await readFile(path.join(fixturesRoot,fixture.attachment))).toString('base64');}else body.source_text=fixture.source;
  const started=performance.now(),created=await api('/decks',body);record.deck_id=created.deck_id;let last;
  while(performance.now()-started<900000){
   const job=await api('/decks/'+record.deck_id),phase=job.agent.phase;record.job=job;
   if(phase!==last){last=phase;record.events.push({phase,elapsed_ms:performance.now()-started});console.log(`[batch-ab] ${id}: ${phase}`);await save();}
   if(['completed','failed','cancelled','interrupted','paused_budget','waiting_user','waiting_outline'].includes(phase)){record.phase=phase;break;}
   if(proxy.fatal)throw new Error(proxy.fatal);await pause(1000);
  }
  record.generation_ms=performance.now()-started;proxy.block();
  if(!record.phase){record.phase='wall_timeout';await api(`/decks/${record.deck_id}/cancel`,{});}
  await drain();
  const raw=(await api('/internal/jobs',{action:'get',deck_id:record.deck_id},'internal')).job;record.raw_job=raw;
  const project=await api(`/decks/${record.deck_id}/project`);record.scene=project.project.scenario;
  await writeFile(path.join(dir,'project.json'),JSON.stringify(project,null,2));await writeFile(path.join(dir,'raw-job.json'),JSON.stringify(raw,null,2));
  record.delivery_success=record.phase==='completed';
  Object.assign(process.env,{SLIDEFORGE_ENGINE_API_URL:base+'/internal/engine',GATEWAY_INTERNAL_TOKEN:token,NODE_ENGINE_URL:`http://127.0.0.1:${port+2}`});
  if(raw.runDir&&project.project.pages.length)await score(record,fixture,dir,raw);
  if(record.delivery_success)await exported(record,dir);
  const trace=(await readFile(path.join(dir,'runtime-load.jsonl'),'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
  record.loaded_files=[...new Set(trace.map(x=>x.file))];
  if(!metadata.baseline_audit.runtime_files.every(f=>trace.some(t=>t.arm===arm&&t.file===f.file&&t.sha256===f[arm+'_sha256'])))throw new Error('Frozen code load trace incomplete');
  record.status='recorded';
 }catch(error){record.error=String(error);record.status='error';console.error(`[batch-ab] ${id}: ${error}`);}
 finally{
  proxy.block();try{await drain()}catch(error){record.drain_error=String(error);record.status='error';}
  record.finished_at=new Date().toISOString();record.calls=proxy.calls.filter(c=>c.trial===id);record.cost_peak_cny=record.calls.reduce((s,c)=>s+(c.cost_peak_cny??c.reserved_cny??0),0);
  await save();await writeFile(path.join(dir,'record.json'),JSON.stringify(record,null,2));await stop();console.log(`[batch-ab] ${id} end ${record.phase??'error'} ${record.cost_peak_cny.toFixed(4)} CNY`);
 }
}
try{
 if(preflight){
  proxy.setTrial('preflight',0);
  for(const arm of ['before','after']){
   const dir=path.join(out,arm);await mkdir(dir,{recursive:true});await launch(arm,dir);
   const response=await fetch('http://127.0.0.1:'+(port+1)+'/internal/agent/tools',{method:'POST',headers:{'content-type':'application/json','x-internal-token':token},body:JSON.stringify({deck_id:'preflight-missing',run_seq:1,runner_epoch:0,operation_id:'preflight',name:'_describe',args:{}})});
   if(response.ok)throw new Error('Expected missing-deck response');
   const trace=(await readFile(path.join(dir,'runtime-load.jsonl'),'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
   if(!metadata.baseline_audit.runtime_files.every(f=>trace.some(t=>t.arm===arm&&t.file===f.file&&t.sha256===f[arm+'_sha256'])))throw new Error('Preflight frozen code load trace incomplete');
   await stop();console.log('[preflight] '+arm+' four services ready, all four frozen files verified');
  }
 }else{
  for(let i=0;i<fixtures.cases.length;i++)for(const arm of i%2===0?['before','after']:['after','before']){if(proxy.fatal)throw new Error(proxy.fatal);await trial(fixtures.cases[i],arm);}
 }
 metadata.status='finished';
}catch(error){metadata.status='stopped';metadata.error=String(error);process.exitCode=1;console.error(metadata.error);}
finally{
 proxy.block();await stop();metadata.finished_at=new Date().toISOString();metadata.cost_peak_cny=proxy.spent();await save();
 await new Promise(resolve=>proxy.server.close(resolve));console.log(`[batch-ab] ${metadata.status} ${metadata.cost_peak_cny.toFixed(4)} CNY`);
}
