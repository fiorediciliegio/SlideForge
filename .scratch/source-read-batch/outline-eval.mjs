import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createWriteStream,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {parseEnv} from 'node:util';
import {pathToFileURL} from 'node:url';
import {startProxy} from '../harness-real-eval/proxy.mjs';
const root=path.resolve(import.meta.dirname,'../..'),out=path.join(import.meta.dirname,'20261112-outline-ab'),arm=process.argv[2];
if(!['before','after'].includes(arm))throw new Error('Specify before or after');
const dir=path.join(out,arm);if(existsSync(dir))throw new Error('Do not automatically repeat a paid trial');await mkdir(dir,{recursive:true});
for(const name of ['harness.py','agent_tools.py'])await copyFile(path.join(root,'services/brain/brain',name),path.join(dir,name));
let initialCalls=[];if(existsSync(path.join(out,'model-ledger.json'))){const prior=JSON.parse(await readFile(path.join(out,'model-ledger.json'),'utf8'));if(prior.fatal||prior.calls.some(c=>c.status!=='completed'))throw new Error('Unresolved prior provider outcome');initialCalls=prior.calls;}
const local=parseEnv(await readFile(path.join(root,'.env'),'utf8'));if(!local.OPENAI_API_KEY)throw new Error('Missing project credential');
const port=48230,base=`http://127.0.0.1:${port}`,token='source-read-eval-internal',admin='source-read-eval-admin';
const proxy=await startProxy({out,key:local.OPENAI_API_KEY,port:port+4,limitCny:2,initialCalls});proxy.setTrial(arm,2);
const env={...process.env,NODE_ENV:'development',OPENAI_API_KEY:'evaluation-proxy-placeholder',OPENAI_MODEL:'deepseek-flash',OPENAI_BASE_URL:'https://api.deepseek.com',OPENAI_FALLBACK_API_KEY:'',OPENAI_FALLBACK_BASE_URL:'',OPENAI_FALLBACK_MODEL:'',SF_EVAL_PROXY:`http://127.0.0.1:${port+4}`,NODE_OPTIONS:`--import=${pathToFileURL(path.join(root,'.scratch/harness-real-eval/redirect.mjs')).href}`,PYTHONPATH:path.join(root,'.scratch/harness-real-eval'),PYTHONIOENCODING:'utf-8',GATEWAY_PORT:String(port),PORT:String(port+1),ENGINE_PORT:String(port+2),BRAIN_PORT:String(port+3),SLIDEFORGE_DATA_DIR:path.join(dir,'data'),GATEWAY_INTERNAL_TOKEN:token,SLIDEFORGE_ADMIN_TOKEN:admin,AGENT_INPUT_CNY_PER_MILLION:'2',AGENT_OUTPUT_CNY_PER_MILLION:'8',AGENT_PRICING_VERSION:'source-read-eval-2026-11-12',ENGINE_UPSTREAM_URL:`http://127.0.0.1:${port+1}`,NODE_ENGINE_URL:`http://127.0.0.1:${port+2}`,BRAIN_URL:`http://127.0.0.1:${port+3}`,SLIDEFORGE_BILLING_API_URL:base+'/internal',SLIDEFORGE_JOB_API_URL:base+'/internal/jobs',SLIDEFORGE_FILE_API_URL:base+'/internal/files',SLIDEFORGE_ENGINE_API_URL:base+'/internal/engine',SLIDEFORGE_BRAIN_API_URL:`http://127.0.0.1:${port+3}/internal/brain`,HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'*'};
for(const k of ['DATABASE_URL','JOBS_DATABASE_URL','FILES_DATABASE_URL','S3_ENDPOINT','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'])env[k]='';
let key='',child;const delay=ms=>new Promise(r=>setTimeout(r,ms)),record={arm,status:'running',started_at:new Date().toISOString(),events:[]};
const save=()=>writeFile(path.join(dir,'record.json'),JSON.stringify(record,null,2));await save();
async function api(route,body,mode='user'){const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(mode==='internal'?{'x-internal-token':token}:mode==='admin'?{'x-admin-token':admin}:{'x-api-key':key})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});const data=await response.json();if(!response.ok)throw new Error(`HTTP ${response.status}: ${JSON.stringify(data).slice(0,300)}`);return data;}
try {
 const log=createWriteStream(path.join(dir,'services.log'));child=spawn(process.execPath,['scripts/dev-services.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 let ready=false;for(let i=0;i<400;i++){try{if((await fetch(base+'/readyz')).ok){ready=true;break}}catch{}if(child.exitCode!==null)break;await delay(100);}if(!ready)throw new Error('Isolated services not ready');
 key=(await api('/admin/keys',{name:'source-read-batch-eval',points:100},'admin')).key;
 const fixtures=JSON.parse(await readFile(path.join(root,'.scratch/harness-real-eval/20261112-172000/fixtures.json'),'utf8')),fixture=fixtures.cases.find(c=>c.id==='long-document');
 const began=performance.now();const created=await api('/decks',{brief:fixture.brief.replace('直接生成预览','先规划大纲，等待确认'),filename:'long-document.txt',attachment_base64:Buffer.from(fixture.source).toString('base64'),template_id:fixtures.template_id,agent_options:{version:1,generation_mode:'outline_first',page_policy:{mode:'fixed',count:6},research_allowed:false,budget:{active_seconds:600,estimated_cost_cny:2}}});record.deck_id=created.deck_id;
 let last;while(performance.now()-began<600000){const job=await api('/decks/'+record.deck_id),phase=job.agent?.phase;if(phase!==last){last=phase;record.events.push({phase,elapsed_ms:performance.now()-began});console.log(`[outline-eval] ${arm}: ${phase}`);await save();}if(['waiting_outline','waiting_user','interrupted','failed','paused_budget','completed','cancelled'].includes(phase)){record.phase=phase;record.job=job;break;}if(proxy.fatal)throw new Error(proxy.fatal);await delay(500);}
 record.elapsed_ms=performance.now()-began;
 record.raw_job=(await api('/internal/jobs',{action:'get',deck_id:record.deck_id},'internal')).job;
 record.project=(await api('/decks/'+record.deck_id+'/project')).project;
 if(record.phase!=='waiting_outline')throw new Error('Did not stop at outline confirmation');
 const operations=Object.values(record.raw_job.agent.operations);record.reads=operations.filter(o=>o.status==='completed'&&o.result?.source_id&&Number.isFinite(o.result?.start)).map(o=>o.result);
 const text=record.reads.sort((a,b)=>a.start-b.start).map(r=>r.text).join('');record.full_source_equal=text===fixture.source.trim();
 const outline=JSON.stringify(record.project.outline),norm=s=>s.replace(/\s+/g,'');record.outline_facts=fixture.facts.map(f=>({...f,value_unit_present:norm(outline).includes(norm(f.value+f.unit))}));
 record.status='pass';
}catch(error){record.status='fail';record.error=String(error);process.exitCode=1;console.error(record.error);}
finally{
 proxy.block();record.calls=proxy.calls.filter(c=>c.trial===arm);record.cost_peak_cny=record.calls.reduce((s,c)=>s+(c.cost_peak_cny??c.reserved_cny??0),0);record.finished_at=new Date().toISOString();await save();
 if(child?.exitCode===null){const killer=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});await once(killer,'exit');}
 await new Promise(resolve=>proxy.server.close(resolve));console.log(`[outline-eval] ${arm}: ${record.status}, ${record.calls.length} calls, ${record.cost_peak_cny.toFixed(4)} CNY`);
}
