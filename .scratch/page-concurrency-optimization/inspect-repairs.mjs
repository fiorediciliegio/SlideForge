import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
const roots={before:'.eval-results/harness/v3-16000/20261114T171535058Z',after:'.eval-results/harness/v4-concurrency-3/20261115T140047040Z'};
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const evidence={};
for(const [version,dir] of Object.entries(roots)){
 const meta=await json(path.join(dir,'metadata.json')),ledger=await json(path.join(dir,'model-ledger.json'));
 evidence[version]=[];
 for(const record of meta.records){
  const job=await json(path.join(dir,record.id,'raw-job.json'));
  const workspace=path.resolve(job.runDir,'../../..');
  const checks=[];
  for(const name of await readdir(path.join(workspace,'project/checks'))){
   if(!name.endsWith('.json'))continue;
   const check=await json(path.join(workspace,'project/checks',name));
   checks.push({file:path.join(workspace,'project/checks',name),...check});
  }
  checks.sort((a,b)=>(a.created_at??'').localeCompare(b.created_at??''));
  const decisions=[];
  for(const call of ledger.calls.filter(c=>c.trial===record.id&&c.kind==='controller'&&c.status==='completed')){
   const result=await json(path.join(dir,`response-${call.id}.json`));
   for(const tool of result.choices?.[0]?.message?.tool_calls??[]){
    const args=JSON.parse(tool.function.arguments);
    if(['revise_page','revise_pages','record_assessment'].includes(tool.function.name))decisions.push({call:call.id,tool_id:tool.id,name:tool.function.name,args,response:path.join(dir,`response-${call.id}.json`)});
   }
  }
  const repairs=Object.entries(job.agent.operations).filter(([,op])=>op.status==='completed'&&op.result?.repair&&op.result?.page_id).map(([id,op])=>({id,...op.result}));
  evidence[version].push({case_id:record.case_id,workspace,repairs,decisions,checks});
 }
}
await writeFile('.scratch/page-concurrency-optimization/repair-evidence.json',JSON.stringify(evidence,null,2));
const imageDir='.scratch/page-concurrency-optimization/repair-images';await mkdir(imageDir,{recursive:true});
for(const row of evidence.after)for(const check of row.checks.filter(c=>c.kind==='visual'&&c.issues?.some(i=>i.severity==='blocker'))){
 const pages=new Set(check.issues.filter(i=>i.severity==='blocker').flatMap(i=>i.page_ids));
 for(const id of check.evidence_ids){
  const observation=await json(path.join(row.workspace,'project/observations',id+'.json'));
  for(const image of observation.images??[]){
   if(!pages.has(image.page_id))continue;
   await writeFile(path.join(imageDir,`${row.case_id}-${image.page_id}.jpg`),Buffer.from(image.image_url.split(',')[1],'base64'));
  }
 }
}
for(const [version,cases]of Object.entries(evidence))for(const row of cases){
 console.log(JSON.stringify({version,case_id:row.case_id,repairs:row.repairs.map(r=>({page:r.page_id,issues:r.issues})),
  revisions:row.decisions.filter(d=>d.name.startsWith('revise')),check_issues:row.checks.filter(c=>c.issues?.length).map(c=>({kind:c.kind,pages:c.page_ids,created:c.created_at,issues:c.issues}))}));
}
