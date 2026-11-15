import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createWriteStream,existsSync} from 'node:fs';
import path from 'node:path';
import {parseEnv} from 'node:util';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {startProxy} from '../harness-real-eval/proxy.mjs';
import {newDeckId} from '../../src/contracts/ids.ts';
import {agentRoot} from '../../src/capabilities/agent.ts';
import {emptyProject,prepareRevision,saveSource,writeArtifact} from '../../src/capabilities/project.ts';
import {agentOptionsSchema} from '../../src/contracts/agent.ts';

const root=path.resolve(import.meta.dirname,'../..'),out=path.join(import.meta.dirname,'20261112-readonly');
if(existsSync(out))throw new Error('Never automatically repeat real acceptance cases');await mkdir(out,{recursive:true});
const local=parseEnv(await readFile(path.join(root,'.env'),'utf8'));if(!local.OPENAI_API_KEY)throw new Error('Missing project credential');
const port=48320,base=`http://127.0.0.1:${port}`,token='readonly-eval-internal';
const proxy=await startProxy({out,key:local.OPENAI_API_KEY,port:port+4,limitCny:1});
const env={...process.env,NODE_ENV:'development',OPENAI_API_KEY:'evaluation-proxy-placeholder',OPENAI_MODEL:'deepseek-flash',OPENAI_BASE_URL:'https://api.deepseek.com',OPENAI_FALLBACK_API_KEY:'',OPENAI_FALLBACK_BASE_URL:'',OPENAI_FALLBACK_MODEL:'',SF_EVAL_PROXY:`http://127.0.0.1:${port+4}`,SF_READONLY_TRACE:path.join(out,'readonly-tools.jsonl'),NODE_OPTIONS:`--import=${pathToFileURL(path.join(root,'.scratch/harness-real-eval/redirect.mjs')).href}`,PYTHONPATH:[import.meta.dirname,path.join(root,'services/brain')].join(path.delimiter),PYTHONIOENCODING:'utf-8',GATEWAY_PORT:String(port),PORT:String(port+1),ENGINE_PORT:String(port+2),BRAIN_PORT:String(port+3),SLIDEFORGE_DATA_DIR:path.join(out,'data'),GATEWAY_INTERNAL_TOKEN:token,AGENT_INPUT_CNY_PER_MILLION:'2',AGENT_OUTPUT_CNY_PER_MILLION:'8',AGENT_PRICING_VERSION:'readonly-eval-2026-11-12',ENGINE_UPSTREAM_URL:`http://127.0.0.1:${port+1}`,NODE_ENGINE_URL:`http://127.0.0.1:${port+2}`,BRAIN_URL:`http://127.0.0.1:${port+3}`,SLIDEFORGE_BILLING_API_URL:base+'/internal',SLIDEFORGE_JOB_API_URL:base+'/internal/jobs',SLIDEFORGE_FILE_API_URL:base+'/internal/files',SLIDEFORGE_ENGINE_API_URL:base+'/internal/engine',SLIDEFORGE_BRAIN_API_URL:`http://127.0.0.1:${port+3}/internal/brain`,HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'*'};
for(const k of ['DATABASE_URL','JOBS_DATABASE_URL','FILES_DATABASE_URL','S3_ENDPOINT','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'])env[k]='';
const previous=JSON.parse(await readFile(path.join(root,'.scratch/harness-real-eval/20261112-real-1/product-harness/record.json'),'utf8'));
const previousProject=JSON.parse(await readFile(path.join(previous.raw_job.runDir,'project.json'),'utf8'));
const originals=await Promise.all(previousProject.pages.slice(2,4).map(p=>readFile(path.join(previous.raw_job.runDir,p.html_ref),'utf8')));
const fixtures=JSON.parse(await readFile(path.join(root,'.scratch/harness-real-eval/20261112-172000/fixtures.json'),'utf8'));
const source=fixtures.cases.find(c=>c.id==='product').source;
const cases=[
 {id:'cross-page',required:['pages'],instruction:'读取当前a、b两页，分别概括主题，并列出b页四项试点数据的数值和单位。'},
 {id:'page-history',required:['pages','history'],instruction:'读取当前a、b两页及其历史记录，说明两页主题、b页四项试点数据，并原文引用b页最近一条修改记录。独立读取请同回合提出。'},
 {id:'mixed-source-page-history',required:['sources','pages','history'],instruction:'读取用户原始资料、当前a、b两页与对应历史。核对b页四项试点数据是否与资料一致，并原文引用b页最近的修改记录。独立读取请同回合提出。'},
];
const meta={status:'running',model:'deepseek-flash',budget_limit_cny:1,started_at:new Date().toISOString(),cases:[]};
const save=()=>writeFile(path.join(out,'metadata.json'),JSON.stringify(meta,null,2));await save();
const delay=ms=>new Promise(r=>setTimeout(r,ms));let child;
async function api(route,body,url=base){const response=await fetch(url+route,{method:'POST',headers:{'content-type':'application/json','x-internal-token':token},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const data=await response.json();if(!response.ok)throw new Error(`HTTP ${response.status}: ${JSON.stringify(data).slice(0,250)}`);return data;}
try {
 const log=createWriteStream(path.join(out,'services.log'));child=spawn(process.execPath,['scripts/dev-services.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 let ready=false;for(let i=0;i<400;i++){try{if((await fetch(base+'/readyz')).ok){ready=true;break}}catch{}if(child.exitCode!==null)break;await delay(100);}if(!ready)throw new Error('Isolated services not ready');
 for(const fixture of cases){
  if(proxy.fatal)throw new Error(proxy.fatal);proxy.setTrial(fixture.id,1);
  const id=newDeckId(),workspace=agentRoot(id);await mkdir(workspace,{recursive:true});
  const brief=fixture.instruction+' 本项目只做虚拟产物的只读核验，不保存大纲、不生成/修改页面、不导出、不联网。所需资料已提供，不必再次确认读取权限。完成后调用request_user，reason_code为clarification，在question中直接写核验摘要（含对应页面ID），等待用户查看即可。';
  const outline={draft_revision:1,title:'只读验收虚拟作品',pages:[{page_id:'a',title:'产品能力',bullets:[]},{page_id:'b',title:'试点数据',bullets:[]}]};
  const project=emptyProject(id,brief,outline);project.sources=[await saveSource(workspace,'虚构产品资料',source)];project.constraints=[{text:brief,source:'user',confirmed_at:new Date().toISOString()}];project.constraints_revision=1;
  const initial=await prepareRevision(workspace,project,{instruction:'虚构作品基线',page_html:{a:originals[0],b:originals[1]}});
  const current=await prepareRevision(workspace,initial.project,{instruction:'核验口径已确认（虚构测评记录）',page_html:{b:originals[1]}});
  const contextRef=await writeArtifact(workspace,'contexts',{project:current.project,export_authorized:[]});
  const options=agentOptionsSchema.parse({version:1,generation_mode:'direct',page_policy:{mode:'fixed',count:2},research_allowed:false,budget:{active_seconds:600,estimated_cost_cny:1}});
  const run={version:1,run_seq:1,runner_epoch:0,checkpoint_seq:0,phase:'queued',options,context_ref:contextRef,project_ref:current.ref,draft_revision:1,calls:{},operations:{},budget:{active_seconds:0,limit_seconds:600,spent_cny:0,reserved_cny:0,limit_cny:1}};
  const record={id:fixture.id,deck_id:id,required_sections:fixture.required,status:'running',revision_id:current.project.revision_id,initial_page_hashes:current.project.pages.map(p=>p.page_revision)};meta.cases.push(record);await save();
  await api('/internal/jobs',{action:'create',job:{id,title:outline.title,status:'creating',runDir:current.runDir,ownerKeyHash:'readonly-eval-owner',events:[],overflowPages:[],createdAt:new Date().toISOString(),agent:run}});
  const began=performance.now();await api('/internal/brain/agent-runs/enqueue',{deck_id:id,run_seq:1},`http://127.0.0.1:${port+3}`);
  let job;while(performance.now()-began<300000){job=(await api('/internal/jobs',{action:'get',deck_id:id})).job;if(['waiting_user','interrupted','failed','paused_budget','completed','cancelled'].includes(job.agent.phase))break;if(proxy.fatal)throw new Error(proxy.fatal);await delay(500);}
  record.elapsed_seconds=(performance.now()-began)/1000;record.job=job;record.phase=job.agent.phase;
  const operations=Object.values(job.agent.operations),reads=operations.filter(o=>o.status==='completed'&&o.result?.revision_id!==undefined);
  record.read_results=reads.map(o=>o.result);record.summary=job.agent.request?.question??'';
  record.covered_sections=[...new Set(reads.flatMap(o=>['pages','history','sources'].filter(k=>k==='sources'?o.result.source_id:!!o.result[k])))];
  const norm=s=>s.normalize('NFKC').replace(/\s+/g,'');
  record.values_present=['17支','426张','19分钟','3小时'].map(value=>({value,present:norm(record.summary).includes(value)}));
  record.summary_history_hit=!fixture.required.includes('history')||record.summary.includes('核验口径已确认');
  record.read_page_ids=[...new Set(reads.flatMap(o=>o.result.pages?.map(p=>p.page_id)??[]))];
  record.project_unchanged=job.agent.project_ref.revision_id===current.project.revision_id;
  record.html_unchanged=(await Promise.all(current.project.pages.map(async p=>createHash('sha256').update(await readFile(path.join(current.runDir,p.html_ref))).digest('hex')))).every((hash,i)=>hash===record.initial_page_hashes[i]);
  record.calls=proxy.calls.filter(c=>c.trial===fixture.id);record.multi_tool_turns=record.calls.filter(c=>c.tool_names.length>1).length;
  record.current_read_versions=reads.every(o=>o.result.revision_id===current.project.revision_id);
  record.status=record.phase==='waiting_user'&&record.project_unchanged&&record.html_unchanged&&record.current_read_versions&&fixture.required.every(s=>record.covered_sections.includes(s))&&['a','b'].every(id=>record.read_page_ids.includes(id))&&record.values_present.every(f=>f.present)&&record.summary_history_hit?'pass':'fail';
  await save();console.log(`[read-only] ${record.id}: ${record.status}, ${record.calls.length} model calls, ${record.elapsed_seconds.toFixed(2)}s`);
 }
 meta.status=meta.cases.every(c=>c.status==='pass')?'pass':'fail';
}catch(error){meta.status='stopped';meta.error=String(error);process.exitCode=1;console.error(meta.error);}
finally{
 proxy.block();meta.finished_at=new Date().toISOString();meta.cost_peak_cny=proxy.spent();await save();
 if(child?.exitCode===null){const killer=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});await once(killer,'exit');}
 await new Promise(resolve=>proxy.server.close(resolve));console.log(`[read-only] ${meta.status}; conservative ${meta.cost_peak_cny.toFixed(5)}/1 CNY`);
}
