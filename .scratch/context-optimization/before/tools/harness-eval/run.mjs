import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createWriteStream,existsSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import os from 'node:os';
import {here,root,hash,validateSuite,loadBaselines,writeComparison} from './benchmark.mjs';
import {score} from './score.mjs';
import {collectPageMetrics} from './page-metrics.mjs';

const args=process.argv.slice(2);
const comparisonDir=args.includes('--compare')?path.resolve(args[args.indexOf('--compare')+1]):undefined;
const savedProfile=comparisonDir?JSON.parse(await readFile(path.join(comparisonDir,'metadata.json'),'utf8')).profile:undefined;
const profileName=args.includes('--profile')?args[args.indexOf('--profile')+1]:savedProfile??'v1';
const suite=await validateSuite(profileName);
await loadBaselines(suite);
if(args.includes('--compare')){
  const out=path.resolve(args[args.indexOf('--compare')+1]);
  const result=await writeComparison(out,suite);
  console.log(JSON.stringify({out,status:result.status,comparison_type:result.comparison_type}));process.exit(0);
}
const preflight=args.includes('--preflight'),run=args.includes('--run');
if(!run&&!preflight){
  console.log(JSON.stringify({protocol:suite.protocol.id,planned_trials:6,arms:['current'],primary_baseline:suite.protocol.primary_baseline,
    baseline_ids:suite.protocol.baseline_ids,template_id:suite.protocol.template_id,controller_max_tokens:suite.protocol.controller_max_tokens,page_max_tokens:suite.protocol.page_max_tokens,page_concurrency:suite.protocol.page_concurrency,provider_requests:0,
    run_command:'npm.cmd run eval:harness -- --profile '+profileName+' --run --budget-cny 15'},null,2));process.exit(0);
}
const limit=preflight?0:Number(args.includes('--budget-cny')?args[args.indexOf('--budget-cny')+1]:NaN);
if(run&&(!Number.isFinite(limit)||limit<=0))throw new Error('真实运行必须明确提供 --budget-cny 正数，本次未发起模型请求');
const stamp=new Date().toISOString().replaceAll(/[-:.]/g,'');
const out=path.join(root,'.eval-results/harness',suite.profile?.result_family??(suite.profile?'v2-8192':'v1'),stamp+(preflight?'-preflight':''));
await mkdir(path.dirname(out),{recursive:true});await mkdir(out);
const projectEnv=parseEnv(await readFile(path.join(root,'.env'),'utf8'));
if(run&&!projectEnv.OPENAI_API_KEY)throw new Error('项目.env缺少模型凭据');
const port=48420,base='http://127.0.0.1:'+port,token='harness-eval-internal',admin='harness-eval-admin';
const {startProxy}=await import(pathToFileURL(path.join(here,suite.profile?.proxy_file??'proxy.mjs')).href);
const proxy=await startProxy({out,key:preflight?'no-provider-key':projectEnv.OPENAI_API_KEY,port:port+4,limitCny:limit});
const metadata={status:'running',preflight,started_at:new Date().toISOString(),profile:profileName,page_concurrency:suite.protocol.page_concurrency,controller_max_tokens:suite.protocol.controller_max_tokens,page_max_tokens:suite.protocol.page_max_tokens,protocol_id:suite.protocol.id,protocol_hash:suite.protocol_hash,
  model:suite.protocol.model,planned_trials:preflight?0:6,limit_cny:limit,comparison_type:'historical-reference',
  service_lifecycle:'isolated-cluster-per-case',git_head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  hardware:{cpu:os.cpus()[0].model,cpus:os.cpus().length,memory_bytes:os.totalmem(),node:process.version},records:[]};
const save=()=>writeFile(path.join(out,'metadata.json'),JSON.stringify(metadata,null,2));
await writeFile(path.join(out,'protocol.json'),JSON.stringify({profile:profileName,protocol_hash:suite.protocol_hash,reference_protocol_hash:suite.reference_protocol_hash,protocol:suite.protocol},null,2));
const sourceManifest=[];
async function snapshot(folder){
  for(const entry of await readdir(path.join(root,folder),{withFileTypes:true})){
    if(['node_modules','dist','__pycache__','.git','artifacts'].includes(entry.name))continue;
    const relative=path.join(folder,entry.name);
    if(entry.isDirectory())await snapshot(relative);
    else if(/\.(ts|js|mjs|cjs|go|py|json|html|css|yaml|toml|lock)$/.test(entry.name))sourceManifest.push({file:relative.replaceAll('\\','/'),sha256:hash(await readFile(path.join(root,relative)))});
  }
}
for(const folder of ['src','scripts','services/brain/brain','services/gateway','executas/ppt-engine/src','third_party/dom-to-pptx'])await snapshot(folder);
await writeFile(path.join(out,'source-manifest.json'),JSON.stringify(sourceManifest,null,2));await save();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child,log,key='';
async function api(route,body,mode='user'){
  const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',
    ...(mode==='internal'?{'x-internal-token':token}:mode==='admin'?{'x-admin-token':admin}:{'x-api-key':key})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(65000)});
  const result=await response.json();
  if(!response.ok)throw new Error('HTTP '+response.status+': '+JSON.stringify(result).slice(0,400));
  return result;
}
async function stop(){
  if(child?.exitCode===null){
    const killer=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
    await once(killer,'exit');await Promise.race([once(child,'exit'),pause(3000)]);
  }
  if(log)await new Promise(resolve=>log.end(resolve));child=undefined;log=undefined;
}
async function launch(dir){
  const env={...projectEnv,...process.env,NODE_ENV:'development',OPENAI_API_KEY:'evaluation-proxy-placeholder',
    OPENAI_MODEL:suite.protocol.model,OPENAI_BASE_URL:suite.protocol.base_url,
    OPENAI_FALLBACK_API_KEY:'',OPENAI_FALLBACK_BASE_URL:'',OPENAI_FALLBACK_MODEL:'',
    SF_EVAL_PROXY:'http://127.0.0.1:'+(port+4),NODE_OPTIONS:'--import='+pathToFileURL(path.join(here,'redirect.mjs')).href,
    PYTHONPATH:[here,path.join(root,'services/brain')].join(path.delimiter),PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',
    GATEWAY_PORT:String(port),PORT:String(port+1),ENGINE_PORT:String(port+2),BRAIN_PORT:String(port+3),
    SLIDEFORGE_DATA_DIR:path.join(dir,'data'),GATEWAY_INTERNAL_TOKEN:token,SLIDEFORGE_ADMIN_TOKEN:admin,
    AGENT_INPUT_CNY_PER_MILLION:'2',AGENT_OUTPUT_CNY_PER_MILLION:'8',AGENT_PRICING_VERSION:'harness-eval-v1-fixed-2-8',DECK_CONCURRENCY:'2',
    AGENT_PAGE_CONCURRENCY:String(suite.protocol.page_concurrency),PAGE_MODEL_CONCURRENCY:String(suite.profile?.page_model_concurrency??12),
    AGENT_PROJECT_CONCURRENCY:String(suite.profile?.project_concurrency??5),AGENT_OWNER_PROJECT_CONCURRENCY:String(suite.profile?.owner_project_concurrency??2),ENGINE_CONCURRENCY:String(suite.profile?.engine_concurrency??1),
    ENGINE_UPSTREAM_URL:'http://127.0.0.1:'+(port+1),NODE_ENGINE_URL:'http://127.0.0.1:'+(port+2),BRAIN_URL:'http://127.0.0.1:'+(port+3),
    SLIDEFORGE_BILLING_API_URL:base+'/internal',SLIDEFORGE_JOB_API_URL:base+'/internal/jobs',SLIDEFORGE_FILE_API_URL:base+'/internal/files',
    SLIDEFORGE_ENGINE_API_URL:base+'/internal/engine',SLIDEFORGE_BRAIN_API_URL:'http://127.0.0.1:'+(port+3)+'/internal/brain',
    HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'*'};
  for(const name of ['DATABASE_URL','JOBS_DATABASE_URL','FILES_DATABASE_URL','S3_ENDPOINT','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'])env[name]='';
  log=createWriteStream(path.join(dir,'services.log'));
  child=spawn(process.execPath,['scripts/dev-services.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  let ready=false;
  for(let i=0;i<500;i++){
    try{if((await fetch(base+'/readyz')).ok){ready=true;break}}catch(error){if(error.cause?.code!=='ECONNREFUSED')throw error}
    if(child.exitCode!==null)break;await pause(100);
  }
  if(!ready)throw new Error('隔离服务未就绪：'+dir);
  key=(await api('/admin/keys',{name:'harness-eval-synthetic',points:1000},'admin')).key;
}
async function drain(){
  const began=Date.now();
  while(proxy.calls.some(c=>c.status==='inflight')){
    if(Date.now()-began>250000)throw new Error('供应商请求仍未结算');await pause(500);
  }
  if(proxy.fatal)throw new Error(proxy.fatal);
}
async function exported(record,dir){
  const began=performance.now();
  let result=await api('/decks/'+record.deck_id+'/export',{format:'pptx',idempotency_key:'harness-eval-'+record.id});
  if(result.status_url){
    const route=result.status_url;
    for(let i=0;i<240;i++){result=await api(route);if(['completed','failed','cancelled'].includes(result.state))break;await pause(1000)}
    if(result.state!=='completed')throw new Error('导出未完成：'+JSON.stringify(result));result=result.result;
  }
  const downloaded=await fetch(base+result.download_url,{headers:{'x-api-key':key}});
  if(!downloaded.ok)throw new Error('下载HTTP '+downloaded.status);
  const file=path.join(dir,'deck.pptx');await writeFile(file,Buffer.from(await downloaded.arrayBuffer()));
  const check=JSON.parse(execFileSync(path.join(root,'.tooling/brain-venv/Scripts/python.exe'),['-X','utf8',path.join(here,'pptx-check.py'),file],{encoding:'utf8',windowsHide:true}));
  record.export={elapsed_ms:performance.now()-began,...check,file};
  await writeFile(path.join(dir,'pptx-check.json'),JSON.stringify(check,null,2));
}
async function trial(fixture){
  const id=fixture.id+'-current',dir=path.join(out,id);
  await mkdir(dir);proxy.setTrial(id,suite.protocol.per_trial_cny);
  const record={id,case_id:fixture.id,arm:'current',status:'running',expected_scene:fixture.scene,started_at:new Date().toISOString(),events:[]};
  metadata.records.push(record);await save();console.log('[eval] '+id+' starting');
  try{
    await launch(dir);
    const body={brief:fixture.brief,page_count:6,template_id:suite.protocol.template_id,
      agent_options:{version:1,generation_mode:'direct',page_policy:{mode:'fixed',count:6},research_allowed:false,
        budget:{active_seconds:suite.protocol.active_seconds,estimated_cost_cny:suite.protocol.per_trial_cny}}};
    if(fixture.attachment){
      body.filename=path.basename(fixture.attachment);
      body.attachment_base64=(await readFile(path.join(here,'fixtures/v1',fixture.attachment))).toString('base64');
    }else body.source_text=fixture.source;
    const started=performance.now(),created=await api('/decks',body);record.deck_id=created.deck_id;let last;
    while(performance.now()-started<suite.protocol.wall_timeout_seconds*1000){
      const job=await api('/decks/'+record.deck_id),phase=job.agent.phase;record.job=job;
      if(phase!==last){last=phase;record.events.push({phase,elapsed_ms:performance.now()-started});await save();console.log('[eval] '+id+': '+phase)}
      if(['completed','failed','cancelled','interrupted','paused_budget','waiting_user','waiting_outline'].includes(phase)){record.phase=phase;break}
      if(proxy.fatal)throw new Error(proxy.fatal);await pause(1000);
    }
    record.generation_ms=performance.now()-started;proxy.block();
    if(!record.phase){record.phase='wall_timeout';await api('/decks/'+record.deck_id+'/cancel',{})}
    await drain();
    const raw=(await api('/internal/jobs',{action:'get',deck_id:record.deck_id},'internal')).job;record.raw_job=raw;
    const project=await api('/decks/'+record.deck_id+'/project');record.scene=project.project.scenario;
    await writeFile(path.join(dir,'project.json'),JSON.stringify(project,null,2));await writeFile(path.join(dir,'raw-job.json'),JSON.stringify(raw,null,2));
    if(suite.metric_baselines){record.page_metrics=await collectPageMetrics(record,project.project,proxy.calls);await writeFile(path.join(dir,'page-metrics.json'),JSON.stringify(record.page_metrics,null,2))}
    record.delivery_success=record.phase==='completed';
    Object.assign(process.env,{SLIDEFORGE_ENGINE_API_URL:base+'/internal/engine',GATEWAY_INTERNAL_TOKEN:token,NODE_ENGINE_URL:'http://127.0.0.1:'+(port+2)});
    if(raw.runDir&&project.project.pages.length)await score(record,fixture,dir,raw);
    if(record.delivery_success)await exported(record,dir);
    record.status='recorded';
  }catch(error){record.error=String(error);record.status='error';console.error('[eval] '+id+': '+error)}
  finally{
    proxy.block();try{await drain()}catch(error){record.drain_error=String(error);record.status='error'}
    record.finished_at=new Date().toISOString();record.calls=proxy.calls.filter(c=>c.trial===id);
    await save();await writeFile(path.join(dir,'record.json'),JSON.stringify(record,null,2));await stop();
  }
}
try{
  if(preflight){
    proxy.setTrial('preflight',0);const dir=path.join(out,'preflight');await mkdir(dir);await launch(dir);
    console.log('[preflight] four services ready; provider requests '+proxy.calls.length);
  }else{
    for(const fixture of suite.fixtures.cases){if(proxy.fatal)throw new Error(proxy.fatal);await trial(fixture)}
  }
  metadata.status='finished';
}catch(error){metadata.status='stopped';metadata.error=String(error);process.exitCode=1}
finally{
  proxy.block();await stop();metadata.finished_at=new Date().toISOString();metadata.cost_peak_cny=proxy.spent();await save();
  await new Promise(resolve=>proxy.server.close(resolve));
  if(!preflight)await writeComparison(out,suite);
  console.log(JSON.stringify({status:metadata.status,out,provider_requests:proxy.calls.length,cost_peak_cny:proxy.spent()}));
}
