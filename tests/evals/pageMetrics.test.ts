import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {rm} from 'node:fs/promises';
import path from 'node:path';
import {agentRoot} from '../../src/capabilities/agent.ts';
import {writeArtifact} from '../../src/capabilities/project.ts';
import {collectPageMetrics,summarizePageMetrics} from '../../tools/harness-eval/page-metrics.mjs';

const html='<!doctype html><html><head><style>.slide{width:1920px;height:1080px;overflow:hidden}</style></head><body><main class="slide"><h1>Test</h1></main></body></html>';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(ids=['a','b']){
 const deck_id='deck-metrics-'+randomUUID(),root=agentRoot(deck_id),record:any={id:'case-current',deck_id,raw_job:{agent:{calls:{},operations:{}}}},project={outline:{pages:ids.map(page_id=>({page_id}))}};
 const response=async(page:string,turn:number,content=html,issues:any[]=[])=>{
  const operation=`run-1:turn-${turn}:tool:page:${page}`,ref=await writeArtifact(root,'responses',{choices:[{message:{content}}]});
  record.raw_job.agent.calls[operation+':llm:0']={status:'completed',response_ref:ref};
  record.raw_job.agent.operations[operation]={status:'completed',result:{issues,project_ref:{revision_id:'r'}}};
 };
 const check=async(kind:string,issues:any[]=[])=>writeArtifact(root,'checks',{kind,created_at:'2026-11-14T00:00:00Z',page_ids:ids,page_revisions:Object.fromEntries(ids.map(id=>[id,hash(JSON.stringify([hash(html),[]]))])),issues});
 return {root,record,project,response,check,collect:(calls:any[]=[])=>collectPageMetrics(record,project,calls),async close(){if(path.dirname(root)!==path.resolve('artifacts/decks'))throw new Error('unsafe fixture cleanup');await rm(root,{recursive:true,force:true})}};
}
test('首次程序通过与首轮无阻断分开统计，未生成页不伪装成功',async()=>{
 const f=await fixture();try{await f.response('a',1);await f.check('content');await f.check('visual',[{severity:'improvement',page_ids:['a']}]);const m=await f.collect();assert.equal(m.pages[0].first_program,'passed');assert.equal(m.pages[0].first_no_blocker,'passed');assert.equal(m.pages[1].first_program,'not_attempted');assert.equal(summarizePageMetrics([m]).planned_pages,2)}finally{await f.close()}
});
test('截断后再成功不能补算首次成功，turn按数字而非字符串排列',async()=>{
 const f=await fixture();try{await f.response('a',10);await f.response('a',2,html.replace('</html>',''));await f.response('b',3,html,[{code:'overflow'}]);const m=await f.collect([{trial:'case-current',kind:'page',status:'completed',finish_reason:'length'},{trial:'case-current',kind:'page',status:'completed',finish_reason:'stop'}]);assert.equal(m.pages[0].first_program,'failed');assert.equal(m.pages[1].first_program,'failed');assert.equal(m.truncated_responses,1);assert.equal(m.page_responses,2)}finally{await f.close()}
});
test('首次内容阻断就判需返工，缺少视觉评审不能默认为通过',async()=>{
 const f=await fixture();try{await f.response('a',1);await f.response('b',2);await f.check('content',[{severity:'blocker',page_ids:['a']}]);const m=await f.collect();assert.equal(m.pages[0].first_program,'passed');assert.equal(m.pages[0].first_no_blocker,'failed');assert.equal(m.pages[1].first_no_blocker,'unknown')}finally{await f.close()}
});
