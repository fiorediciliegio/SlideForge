import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createWriteStream,existsSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {parseEnv} from 'node:util';
import {startProxy} from './proxy.mjs';

const here=import.meta.dirname,root=path.resolve(here,'../..'),fixturesRoot=path.join(here,'20261112-172000');
const out=path.resolve(process.argv[2]??path.join(here,'20261112-run-1'));
if(existsSync(path.join(out,'metadata.json')))throw new Error('Use a fresh output directory; paid trials are never silently repeated');
await mkdir(out,{recursive:true});await mkdir(path.join(out,'data'),{recursive:true});
const projectEnv=parseEnv(await readFile(path.join(root,'.env'),'utf8'));
const providerKey=projectEnv.OPENAI_API_KEY;if(!providerKey)throw new Error('Missing local DeepSeek credential');
const fixtures=JSON.parse(await readFile(path.join(fixturesRoot,'fixtures.json'),'utf8'));
if(!fixtures.all_materials_synthetic)throw new Error('Only synthetic fixtures authorized');
const port=48170,base=`http://127.0.0.1:${port}`,token='real-eval-internal',admin='real-eval-admin';
const pause=ms=>new Promise(r=>setTimeout(r,ms));let key='',child;
const proxy=await startProxy({out,key:providerKey,port:port+4});
const env={...process.env,NODE_ENV:'development',OPENAI_API_KEY:'evaluation-proxy-placeholder',OPENAI_MODEL:'deepseek-flash',OPENAI_BASE_URL:'https://api.deepseek.com',OPENAI_FALLBACK_API_KEY:'',OPENAI_FALLBACK_BASE_URL:'',OPENAI_FALLBACK_MODEL:'',SF_EVAL_PROXY:`http://127.0.0.1:${port+4}`,NODE_OPTIONS:`--import=${pathToFileURL(path.join(here,'redirect.mjs')).href}`,PYTHONPATH:here,PYTHONIOENCODING:'utf-8',GATEWAY_PORT:String(port),PORT:String(port+1),ENGINE_PORT:String(port+2),BRAIN_PORT:String(port+3),SLIDEFORGE_DATA_DIR:path.join(out,'data'),GATEWAY_INTERNAL_TOKEN:token,SLIDEFORGE_ADMIN_TOKEN:admin,AGENT_INPUT_CNY_PER_MILLION:'2',AGENT_OUTPUT_CNY_PER_MILLION:'8',AGENT_PRICING_VERSION:'eval-flash-peak-cache-miss-2026-11-12',ENGINE_UPSTREAM_URL:`http://127.0.0.1:${port+1}`,NODE_ENGINE_URL:`http://127.0.0.1:${port+2}`,BRAIN_URL:`http://127.0.0.1:${port+3}`,SLIDEFORGE_BILLING_API_URL:base+'/internal',SLIDEFORGE_JOB_API_URL:base+'/internal/jobs',SLIDEFORGE_FILE_API_URL:base+'/internal/files',SLIDEFORGE_ENGINE_API_URL:base+'/internal/engine',SLIDEFORGE_BRAIN_API_URL:`http://127.0.0.1:${port+3}/internal/brain`,HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'*'};
for(const k of ['DATABASE_URL','JOBS_DATABASE_URL','FILES_DATABASE_URL','S3_ENDPOINT','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'])env[k]='';
Object.assign(process.env,{SLIDEFORGE_ENGINE_API_URL:env.SLIDEFORGE_ENGINE_API_URL,GATEWAY_INTERNAL_TOKEN:token,NODE_ENGINE_URL:env.NODE_ENGINE_URL});
const meta={status:'running',started_at:new Date().toISOString(),model:'deepseek-flash',estimated_total_limit_cny:30,all_materials_synthetic:true,git_head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),hardware:{cpus:os.cpus().length,cpu:os.cpus()[0].model,memory_bytes:os.totalmem(),node:process.version},records:[]};
const save=()=>writeFile(path.join(out,'metadata.json'),JSON.stringify(meta,null,2));await save();
const tracked=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8',maxBuffer:10*1024*1024}).trim().split(/\r?\n/).filter(n=>/\.(ts|py|go|json|mjs)$/.test(n)&&!n.includes('lock')&&!n.startsWith('src/features/templates/')&&!n.startsWith('.archify/')&&!n.startsWith('.scratch/'));
const manifest=[];for(const f of tracked){try{manifest.push({file:f,sha256:createHash('sha256').update(await readFile(path.join(root,f))).digest('hex')})}catch(e){if(e.code!=='ENOENT')throw e;}}
await writeFile(path.join(out,'source-manifest.json'),JSON.stringify(manifest,null,2));
async function api(route,body,internal=false,adminMode=false){const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(internal?{'x-internal-token':token}:adminMode?{'x-admin-token':admin}:{'x-api-key':key})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(65000)});const value=await response.json();if(!response.ok)throw new Error(`HTTP ${response.status}: ${JSON.stringify(value).slice(0,500)}`);return value;}
async function rawJob(id){return (await api('/internal/jobs',{action:'get',deck_id:id},true)).job;}
async function exportPPTX(record,dir){const started=performance.now(),result=await api(`/decks/${record.deck_id}/export`,{format:'pptx',idempotency_key:`eval-${record.id}`});let data=result;
  if(result.status_url){for(let i=0;i<240;i++){data=await api(result.status_url);if(data.state==='completed')break;if(['failed','cancelled'].includes(data.state))throw new Error(JSON.stringify(data));await pause(1000);}if(data.state!=='completed')throw new Error('Export timeout');data=data.result;}
  const response=await fetch(base+data.download_url,{headers:{'x-api-key':key}});if(!response.ok)throw new Error('Download HTTP '+response.status);
  const file=path.join(dir,'deck.pptx');await writeFile(file,Buffer.from(await response.arrayBuffer()));
  const check=JSON.parse(execFileSync(path.join(root,'.tooling/brain-venv/Scripts/python.exe'),['-X','utf8',path.join(here,'pptx-check.py'),file],{encoding:'utf8',windowsHide:true}));
  record.export={elapsed_ms:performance.now()-started,file,...check};await writeFile(path.join(dir,'pptx-check.json'),JSON.stringify(check,null,2));
}
async function runTrial(fixture,arm){
 const id=`${fixture.id}-${arm}`,dir=path.join(out,id);await mkdir(dir,{recursive:true});proxy.setTrial(id);
 const record={id,case_id:fixture.id,arm,started_at:new Date().toISOString(),expected_scene:fixture.scene,events:[]};meta.records.push(record);await save();console.log(`[trial] ${id} started`);
 const started=performance.now();
 try {
  const body={brief:fixture.brief,page_count:6,template_id:fixtures.template_id};
  if(fixture.attachment){body.filename=path.basename(fixture.attachment);body.attachment_base64=(await readFile(path.join(fixturesRoot,fixture.attachment))).toString('base64');}else body.source_text=fixture.source;
  if(arm==='harness')body.agent_options={version:1,generation_mode:'direct',page_policy:{mode:'fixed',count:6},research_allowed:false,budget:{active_seconds:600,estimated_cost_cny:2}};
  const created=await api('/decks',body);record.deck_id=created.deck_id;let last;
  while(performance.now()-started<900000){
    const job=await api(`/decks/${record.deck_id}`),phase=job.agent?.phase??job.status;record.job=job;
    if(phase!==last){last=phase;record.events.push({phase,elapsed_ms:performance.now()-started});console.log(`[trial] ${id} ${phase}`);await save();}
    if(['completed','failed','cancelled','interrupted','paused_budget','waiting_user','waiting_outline','ready','error'].includes(phase)){record.phase=phase;break;}
    if(proxy.fatal)throw new Error(proxy.fatal);await pause(1000);
  }
  record.generation_ms=performance.now()-started;
  if(!record.phase){record.phase='wall_timeout';proxy.block();await api(`/decks/${record.deck_id}/cancel`,{});}
  const raw=await rawJob(record.deck_id);record.raw_job=raw;
  await writeFile(path.join(dir,'raw-job.json'),JSON.stringify(raw,null,2));
  if(arm==='harness'){const project=await api(`/decks/${record.deck_id}/project`);record.scene=project.project?.scenario;await writeFile(path.join(dir,'project.json'),JSON.stringify(project,null,2));}
  record.delivery_success=['completed','ready'].includes(record.phase);
  if(raw.runDir){const {score}=await import('./score.mjs');await score(record,fixture,dir,raw);}
  if(record.delivery_success)await exportPPTX(record,dir);
 }catch(error){record.error=String(error);console.error(`[trial] ${id}: ${error}`);}
 finally {record.total_ms=performance.now()-started;record.finished_at=new Date().toISOString();record.model_calls=proxy.calls.filter(c=>c.trial===id).length;record.cost_peak_cny=proxy.calls.filter(c=>c.trial===id).reduce((s,c)=>s+(c.cost_peak_cny??c.reserved_cny),0);await save();await writeFile(path.join(dir,'record.json'),JSON.stringify(record,null,2));console.log(`[trial] ${id} end ${record.phase??'error'} ${record.cost_peak_cny.toFixed(4)} CNY`);}
}
try {
 const log=createWriteStream(path.join(out,'services.log'));child=spawn(process.execPath,['scripts/dev-services.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 let ready=false;for(let i=0;i<400;i++){try{if((await fetch(base+'/readyz')).ok){ready=true;break}}catch{}if(child.exitCode!==null)break;await pause(100);}if(!ready)throw new Error('Isolated services failed to start: inspect services.log');
 key=(await api('/admin/keys',{name:'synthetic-real-eval',points:1000},false,true)).key;
 proxy.setTrial('capability-probe',.2);
 // The blue square is generated locally, with no user image content.
 const image=execFileSync(path.join(root,'.tooling/brain-venv/Scripts/python.exe'),['-c',"from PIL import Image; import io,base64; b=io.BytesIO();Image.new('RGB',(32,32),(0,0,255)).save(b,format='PNG');print(base64.b64encode(b.getvalue()).decode())"],{encoding:'utf8',windowsHide:true}).trim();
 const probe=await fetch(env.SF_EVAL_PROXY+'/chat/completions',{method:'POST',body:JSON.stringify({messages:[{role:'user',content:[{type:'text',text:'观察方块的颜色，并且只调用report_color工具提交blue、red或green。'},{type:'image_url',image_url:{url:'data:image/png;base64,'+image}}]}],tools:[{type:'function',function:{name:'report_color',parameters:{type:'object',properties:{color:{type:'string',enum:['blue','red','green']}},required:['color']}}}],temperature:.4})});
 const probed=await probe.json();meta.probe={status:probe.status,message:probed.choices?.[0]?.message};await save();
 if(!probe.ok||!meta.probe.message?.tool_calls?.some(t=>t.function.name==='report_color'&&JSON.parse(t.function.arguments).color==='blue'))throw new Error('Tool/image capability probe failed; inspect recorded response');
 for(let i=0;i<fixtures.cases.length;i++)for(const arm of i%2===0?['legacy','harness']:['harness','legacy']){if(proxy.fatal)throw new Error(proxy.fatal);await runTrial(fixtures.cases[i],arm);}
 meta.status='finished';
}catch(error){meta.status='stopped';meta.error=String(error);console.error(meta.error);process.exitCode=1;}
finally {
 proxy.block();meta.finished_at=new Date().toISOString();meta.cost_peak_cny=proxy.spent();await save();
 if(child?.exitCode===null){const killer=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});await once(killer,'exit');}
 proxy.server.close();console.log(`[evaluation] ${meta.status}; conservative estimate ${meta.cost_peak_cny.toFixed(4)} / 30 CNY`);
}
