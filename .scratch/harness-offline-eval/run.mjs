import {spawn,execFileSync} from 'node:child_process';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');
const out=path.resolve(process.argv[2]);await mkdir(out,{recursive:true});
const env={...process.env,NODE_ENV:'development',OPENAI_API_KEY:'offline-eval-placeholder',OPENAI_BASE_URL:'http://127.0.0.1:9',OPENAI_MODEL:'offline-fixture',OPENAI_FALLBACK_API_KEY:'',OPENAI_FALLBACK_BASE_URL:'http://127.0.0.1:9',OPENAI_FALLBACK_MODEL:'offline-fixture',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'*',GOPROXY:'off',GOSUMDB:'off',PYTHONIOENCODING:'utf-8',PYTHONPATH:here,PYTHON:path.join(root,'.tooling/brain-venv/Scripts/python.exe'),GO_BINARY:path.join(root,'.tooling/go/bin/go.exe'),NODE_OPTIONS:`--import=${pathToFileURL(path.join(here,'guard.mjs')).href}`,SLIDEFORGE_EVAL_REPORT_DIR:out};
for(const key of ['DATABASE_URL','JOBS_DATABASE_URL','FILES_DATABASE_URL','S3_ENDPOINT','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'])env[key]='';
for(const key of ['SLIDEFORGE_BILLING_API_URL','SLIDEFORGE_JOB_API_URL','SLIDEFORGE_FILE_API_URL','SLIDEFORGE_ENGINE_API_URL','SLIDEFORGE_BRAIN_API_URL','ENGINE_UPSTREAM_URL','NODE_ENGINE_URL','BRAIN_URL','GATEWAY_PORT','PORT','ENGINE_PORT','BRAIN_PORT','SLIDEFORGE_DATA_DIR'])delete env[key];
const summary={started_at:new Date().toISOString(),provider:'local-fake-model',actual_provider_fee_cny:0,rounds:5,commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),hardware:{logical_cpus:os.cpus().length,cpu:os.cpus()[0].model,total_memory_bytes:os.totalmem(),platform:os.platform(),release:os.release(),node:process.version},runs:[],cases:[],status:'running'};
try{const prior=JSON.parse(await readFile(path.join(out,'metadata.json'),'utf8'));if(prior.status==='pass')throw new Error('This report is complete; choose a new output directory for another evaluation');Object.assign(summary,{started_at:prior.started_at,runs:prior.runs,previous_error:prior.error});}catch(error){if(error.code!=='ENOENT'&&!String(error).includes('This report'))throw error;if(String(error).includes('This report'))throw error}
await writeFile(path.join(out,'metadata.json'),JSON.stringify(summary,null,2));
async function run(label,binary,args,cwd=root,extra={}){
  const completed=summary.runs.find(run=>run.label===label&&run.exit_code===0);
  if(completed){console.log(`[offline-eval] reuse completed ${label}`);return await readFile(completed.log,'utf8')}
  console.log(`[offline-eval] ${label}`);
  const attempt=summary.runs.filter(run=>run.label===label).length+1;
  const start=performance.now(),log=path.join(out,label+(attempt>1?`.attempt-${attempt}`:'')+'.log'),stream=createWriteStream(log);
  const child=spawn(binary,args,{cwd,env:{...env,...extra},windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  await new Promise(resolve=>stream.end(resolve));summary.runs.push({label,command:[binary,...args],exit_code:code,wall_ms:performance.now()-start,log});
  await writeFile(path.join(out,'metadata.json'),JSON.stringify(summary,null,2));
  if(code!==0)throw new Error(`${label} failed: inspect ${log}`);
  return await readFile(log,'utf8');
}
const parse=raw=>raw.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
try{
  await run('check',process.execPath,['node_modules/typescript/bin/tsc','--noEmit']);
  const go=await run('go-reliability',env.GO_BINARY,['test','-json','-count=5','-run','^(TestAgent|TestEngineQueue|TestExportReceipts|TestDeliveryCharges|TestDurableDedup|TestFairOwners|TestMixedOwners|TestPersistedJSON)','./internal/jobs','./internal/billing','./internal/enginejobs'],path.join(root,'services/gateway'));
  const goEvents=parse(go);await writeFile(path.join(out,'go-events.json'),JSON.stringify(goEvents,null,2));
  summary.cases.push(...goEvents.filter(v=>v.Test&&['pass','fail'].includes(v.Action)).map(v=>({language:'Go',name:v.Test,status:v.Action,ms:v.Elapsed*1000})));
  const files=['tests/capabilities/agentFencing.test.ts','tests/capabilities/agentRecoveryBoundaries.test.ts','tests/capabilities/agentTools.test.ts','tests/server/engineWorker.test.ts','tests/server/engineClient.test.ts','tests/server/exportCoordinator.test.ts'];
  for(let round=1;round<=5;round++){
    const raw=await run(`node-round-${round}`,process.execPath,['--import','tsx/esm','--test',`--test-reporter=${pathToFileURL(path.join(here,'reporter.mjs')).href}`,...files]);
    summary.cases.push(...parse(raw).filter(v=>['test:pass','test:fail'].includes(v.type)).map(v=>({language:'Node',round,name:v.name,status:v.type==='test:pass'?'pass':'fail',ms:v.ms})));
    const target=path.join(out,`python-round-${round}.json`);
    await run(`python-round-${round}`,env.PYTHON,[path.join(here,'python_runner.py'),target],path.join(root,'services/brain'));
    summary.cases.push(...JSON.parse(await readFile(target,'utf8')).map(v=>({language:'Python',round,name:v.name,status:v.type==='test:pass'?'pass':'fail',ms:v.ms})));
  }
  await writeFile(path.join(out,'case-results.json'),JSON.stringify(summary.cases,null,2));
  await run('four-process-e2e',process.execPath,['--import','tsx/esm','--test','tests/server/agentRecovery.test.ts'],root,{SLIDEFORGE_AGENT_INTEGRATION:'1',SLIDEFORGE_ENGINE_LOAD:'1'});
  summary.status='pass';
}catch(error){summary.status='fail';summary.error=String(error);process.exitCode=1;console.error(error.message)}
finally{summary.finished_at=new Date().toISOString();await writeFile(path.join(out,'metadata.json'),JSON.stringify(summary,null,2));console.log(`[offline-eval] ${summary.status}`)}
