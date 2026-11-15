import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {resolveDeckRunDir} from '../../src/capabilities/workspace.ts';
import {projectPath} from '../../src/capabilities/project.ts';
import {extractHtmlDocument} from '../../scripts/m0/deck.ts';
import {validateHtmlDialect} from '../../scripts/m0/dialect.ts';

const root=path.resolve(import.meta.dirname,'../..');
const hash=value=>createHash('sha256').update(value).digest('hex');
async function json(file){try{return JSON.parse(await readFile(file,'utf8'))}catch(error){if(error.code==='ENOENT')return undefined;throw error}}

// Fixed first-generation cases have no user page constraints. No models or renderers are called.
export async function collectPageMetrics(record,project,providerCalls){
 const workspace=resolveDeckRunDir(path.join(root,'artifacts/decks'),record.deck_id),agent=record.raw_job?.agent;
 const calls=Object.entries(agent?.calls??{}).filter(([id])=>id.includes(':page:')).map(([id,call])=>({id,...call,turn:Number(id.match(/:turn-(\d+):/)?.[1]??Infinity),retry:Number(id.match(/:retry:(\d+)$/)?.[1]??0)}))
  .sort((a,b)=>a.turn-b.turn||a.retry-b.retry);
 let files;try{files=await readdir(projectPath(workspace,'project/checks'))}catch(error){if(error.code!=='ENOENT')throw error;files=[]}
 const checks=(await Promise.all(files.filter(f=>f.endsWith('.json')).map(f=>json(projectPath(workspace,'project/checks/'+f))))).filter(Boolean).sort((a,b)=>(a.created_at??'').localeCompare(b.created_at??''));
 const pages=[];
 for(const page of project.outline.pages){
  const first=calls.find(c=>c.id.slice(c.id.lastIndexOf(':page:')+6).split(':')[0]===page.page_id);
  const result={page_id:page.page_id,first_call_id:first?.id,first_program:'not_attempted',first_no_blocker:'not_attempted'};
  if(!first){pages.push(result);continue}
  result.first_program='unknown';result.first_no_blocker='unknown';
  if(first.status==='rejected'){result.first_program='failed';result.first_no_blocker='failed';pages.push(result);continue}
  if(first.status!=='completed'||!first.response_ref){pages.push(result);continue}
  const response=await json(projectPath(workspace,first.response_ref));
  if(!response){result.missing_response=true;pages.push(result);continue}
  let html;
  try{html=extractHtmlDocument(response.choices?.[0]?.message?.content??'')}catch(error){result.first_program='failed';result.first_no_blocker='failed';result.reason='incomplete_html';pages.push(result);continue}
  if(!/<\/html\s*>/i.test(html)||!validateHtmlDialect(html).ok){result.first_program='failed';result.first_no_blocker='failed';result.reason='invalid_html';pages.push(result);continue}
  const operation=first.id.slice(0,first.id.lastIndexOf(':llm:')),receipt=agent.operations?.[operation];
  if(!Array.isArray(receipt?.result?.issues)){pages.push(result);continue}
  if(receipt.result.issues.length){result.first_program='failed';result.first_no_blocker='failed';result.reason='layout';pages.push(result);continue}
  if(receipt.status!=='completed'||!receipt.result.project_ref){pages.push(result);continue}
  result.first_program='passed';
  const fingerprint=hash(JSON.stringify([hash(html),[]]));
  const firstChecks=['content','visual'].map(kind=>checks.find(c=>c.kind===kind&&c.page_revisions?.[page.page_id]===fingerprint));
  const blocker=firstChecks.some(c=>c?.issues?.some(i=>i.severity==='blocker'&&(i.page_ids??c.page_ids).includes(page.page_id)));
  result.first_no_blocker=blocker?'failed':firstChecks.every(Boolean)?'passed':'unknown';
  pages.push(result);
 }
 const providers=providerCalls.filter(c=>c.trial===record.id&&c.kind==='page');
 return {planned_pages:project.outline.pages.length,pages,truncated_responses:providers.filter(c=>c.finish_reason==='length').length,
  page_responses:providers.filter(c=>c.status==='completed').length,unknown_page_calls:providers.filter(c=>c.status==='unknown').length};
}

export function summarizePageMetrics(metrics){
 const rows=metrics.filter(Boolean),pages=rows.flatMap(r=>r.pages),sum=key=>rows.reduce((n,r)=>n+r[key],0);
 return {planned_pages:sum('planned_pages'),truncated_responses:sum('truncated_responses'),page_responses:sum('page_responses'),unknown_page_calls:sum('unknown_page_calls'),
  first_program:Object.fromEntries(['passed','failed','unknown','not_attempted'].map(s=>[s,pages.filter(p=>p.first_program===s).length])),
  first_no_blocker:Object.fromEntries(['passed','failed','unknown','not_attempted'].map(s=>[s,pages.filter(p=>p.first_no_blocker===s).length]))};
}

export async function collectRunPageMetrics(out){
 const meta=await json(path.join(out,'metadata.json')),ledger=await json(path.join(out,'model-ledger.json')),cases=[];
 for(const record of meta.records){
  const saved=await json(path.join(out,record.id,'project.json'));
  if(!saved)throw new Error('缺少历史项目记录：'+record.id);
  cases.push({case_id:record.case_id,...await collectPageMetrics(record,saved.project,ledger.calls)});
 }
 return {cases,summary:summarizePageMetrics(cases)};
}
