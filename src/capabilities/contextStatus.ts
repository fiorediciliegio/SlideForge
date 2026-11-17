import type {AgentRun} from "../contracts/agent.js";
import type {ProjectSnapshot} from "./project.js";

/** Runtime observations only. Source material and the message history stay intact. */
export function buildContextStatus(run:AgentRun,project:ProjectSnapshot,
 context:{export_authorized?:string[];instruction?:string;page_ids?:string[];user_response?:string},
 review:Record<string,any>) {
 const results=Object.values(run.operations).filter(op=>op.status==="completed").map(op=>op.result as any).filter(Boolean);
 const source_coverage=project.sources.map(source=>{
  const ranges=results.filter(r=>!r.error&&r.source_id===source.source_id&&typeof r.text==="string"&&Number.isInteger(r.start)&&Number.isInteger(r.end)&&r.end>r.start)
   .map(r=>[Math.max(0,r.start),Math.min(source.chars,r.end)] as [number,number]).filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]);
  const read_ranges:Array<[number,number]>=[];
  for(const range of ranges){const last=read_ranges.at(-1);if(last&&range[0]<=last[1])last[1]=Math.max(last[1],range[1]);else read_ranges.push([...range])}
  const unread_ranges:Array<[number,number]>=[];let cursor=0;
  for(const[start,end]of read_ranges){if(cursor<start)unread_ranges.push([cursor,start]);cursor=end}
  if(cursor<source.chars)unread_ranges.push([cursor,source.chars]);
  return {source_id:source.source_id,name:source.name,total_chars:source.chars,read_chars:read_ranges.reduce((n,[a,b])=>n+b-a,0),read_ranges,unread_ranges};
 });
 const repair_counts=Object.fromEntries(project.outline.pages.map(page=>[page.page_id,results.filter(r=>r.repair&&r.page_id===page.page_id).length]));
 const {budget}=run;
 return {
  snapshot:{outline:project.outline,confirmed_outline_revision:project.confirmed_outline_revision??null,constraints:project.constraints,
   page_constraints:project.page_constraints??{},instruction:context.instruction??null,user_response:context.user_response??null,page_ids:context.page_ids??null},
  state:{source:"harness_runtime",version:1,run_seq:run.run_seq,runner_epoch:run.runner_epoch,project_revision:project.revision_id,
   outline_revision:project.outline.draft_revision,constraints_revision:project.constraints_revision,
   phase:run.phase,stage:review.action==="assess"?`${review.kind}_review`:review.action,
   scenario:{category:project.scenario.category,subtype:project.scenario.subtype,user_confirmed:!!project.scenario.user_confirmed},
   page_policy:run.options.page_policy,generated_pages:project.pages.length,total_pages:project.outline.pages.length,
   pending_page_ids:project.outline.pages.filter(p=>!project.pages.some(done=>done.page_id===p.page_id)).map(p=>p.page_id),
   quality_checked:run.quality_revision===project.revision_id,
   pending_issues:(review.issues??[]).map((issue:any)=>({kind:issue.kind,code:issue.code,page_ids:issue.page_ids})),
   issue_scope:"当前已识别问题；未评审不代表通过",repair_counts,source_coverage,read_semantics:"成功获取，不代表已核验或已写入PPT",
   budget:{...budget,active_seconds:Math.floor(budget.active_seconds),available_cny:Math.round((budget.limit_cny-budget.spent_cny-budget.reserved_cny)*1e6)/1e6},
   permissions:{research_allowed:run.options.research_allowed,export_formats:context.export_authorized??[]},
   unknown_call_ids:Object.entries(run.calls).filter(([,call])=>call.status==="unknown").map(([id])=>id),
  },
 };
}
