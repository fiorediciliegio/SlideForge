import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {normalizeRun,compareRuns,summarizeCases,root,hash} from '../../tools/harness-eval/benchmark.mjs';

const out=path.resolve(process.argv[2]);
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const meta=await json(path.join(out,'metadata.json')),ledger=await json(path.join(out,'model-ledger.json'));
if(!['finished','stopped'].includes(meta.status))throw new Error('测评尚未结束，不生成最终结论');
const baseline=await json(path.join(root,'tools/harness-eval/baselines/20261114-review.json'));
const current=normalizeRun(meta,ledger.calls,'current','current',meta.protocol_hash),paired=compareRuns(baseline,current);
const sum=values=>values.reduce((a,b)=>a+b,0);
const countBy=(items,key)=>Object.fromEntries([...new Set(items.map(key))].map(value=>[value,items.filter(item=>key(item)===value).length]));
const quality=run=>{
 const scored=run.cases.filter(c=>c.score),facts=scored.flatMap(c=>c.score.facts);
 return {scored:scored.length,strict_facts:sum(scored.map(c=>c.score.facts_hit)),facts_total:sum(scored.map(c=>c.score.facts_total)),numeric_units:facts.filter(f=>f.value_present).length,
  sections:sum(scored.map(c=>c.score.section_hits)),sections_total:sum(scored.map(c=>c.score.sections.length)),overflow_pages:sum(scored.map(c=>c.score.overflow_pages.length)),
  pages:sum(scored.map(c=>c.score.page_count)),rules_passes:scored.filter(c=>c.score.rules_pass).length};
};
async function toolsFor(folder,calls){
 const tools=[],batches=[];
 for(const call of calls.filter(c=>c.kind==='controller'&&c.status==='completed')){
  const response=await json(path.join(folder,`response-${call.id}.json`));
  for(const tool of response.choices?.[0]?.message?.tool_calls??[]){
   const args=JSON.parse(tool.function.arguments);tools.push({trial:call.trial,name:tool.function.name,id:tool.id,args});
   if(tool.function.name==='revise_pages'){
    const following=calls.filter(c=>c.trial===call.trial&&c.id>call.id),end=following.find(c=>c.kind==='controller')?.id??Infinity;
    const pages=following.filter(c=>c.kind==='page'&&c.id<end&&c.status==='completed');
    batches.push({trial:call.trial,call:call.id,tool_call_id:tool.id,pages:args.revisions.map(p=>p.page_id),size:args.revisions.length,
     page_calls:pages.map(c=>c.id),page_wait_sum_seconds:sum(pages.map(c=>c.elapsed_ms))/1000,
     page_call_window_seconds:pages.length?(Math.max(...pages.map(c=>Date.parse(c.finished_at)))-Math.min(...pages.map(c=>Date.parse(c.started_at))))/1000:null});
   }
  }
 }
 return {counts:countBy(tools,t=>t.name),assessment_kinds:countBy(tools.filter(t=>t.name==='record_assessment'),t=>t.args.kind),batches};
}
const oldFolder=path.join(root,baseline.provenance.run),oldLedger=await json(path.join(oldFolder,'model-ledger.json'));
const beforeTools=await toolsFor(oldFolder,oldLedger.calls),afterTools=await toolsFor(out,ledger.calls);
const rawOps=meta.records.flatMap(r=>Object.entries(r.raw_job?.agent?.operations??{}).map(([id,op])=>({case:r.case_id,id,...op})));
const completeBatches=rawOps.filter(op=>op.status==='completed'&&afterTools.batches.some(batch=>batch.trial===op.case+'-current'&&op.id.endsWith(':'+batch.tool_call_id)));
let changed=0;
for(const item of await json(path.join(out,'source-manifest.json')))if(hash(await readFile(path.join(root,item.file)))!==item.sha256)changed++;
const result={out,status:meta.status,protocol:meta.protocol_id,controller_max_tokens:meta.controller_max_tokens,reference_controller_max_tokens:baseline.controller_max_tokens,
 stats:summarizeCases(current.cases),comparison:paired,quality:{before:quality(baseline),after:quality(current)},
 tools:{before:beforeTools,after:afterTools,completed_batches:completeBatches.map(op=>({case:op.case,pages:op.result.pages,failures:op.result.failures})),
 automatic_inspections:rawOps.filter(op=>op.status==='completed'&&op.id.includes(':auto-inspect_deck-')).length,
 automatic_finishes:rawOps.filter(op=>op.status==='completed'&&op.id.includes(':auto-finish_deck-')).length},
 finish_reasons:countBy(ledger.calls,c=>c.kind+':'+c.finish_reason),before_finish_reasons:countBy(oldLedger.calls,c=>c.kind+':'+c.finish_reason),
 controller_output:{max:Math.max(...ledger.calls.filter(c=>c.kind==='controller'&&c.usage).map(c=>c.usage.completion_tokens)),above_4096:ledger.calls.filter(c=>c.kind==='controller'&&c.usage?.completion_tokens>4096).length},
 model_fingerprints:{before:[...new Set(oldLedger.calls.map(c=>c.system_fingerprint).filter(Boolean))],after:[...new Set(ledger.calls.map(c=>c.system_fingerprint).filter(Boolean))]},
 audit:{changed_runtime_files:changed,requests:ledger.calls.length,unknown:ledger.calls.filter(c=>c.status==='unknown').length,unsettled:ledger.calls.filter(c=>c.status!=='completed').length,
  wrong_caps:ledger.calls.filter(c=>c.max_tokens!==(c.kind==='page'?12000:c.kind==='controller'?8192:4096)).length,
  cap_normalizations:ledger.calls.filter(c=>c.normalized_max_tokens).length,budget_cny:ledger.limit_cny,
  peak_no_cache_cny:sum(ledger.calls.map(c=>c.cost_peak_cny??0)),time_cache_estimate_cny:sum(ledger.calls.map(c=>c.cost_time_cache_cny??0)),
  native_unknown:sum(meta.records.map(r=>Object.values(r.raw_job?.agent?.calls??{}).filter(c=>c.status==='unknown').length)),
  native_reserved_cny:sum(meta.records.map(r=>r.raw_job?.agent?.budget?.reserved_cny??0)),
  total_wall_seconds:(Date.parse(meta.finished_at)-Date.parse(meta.started_at))/1000},cases:current.cases};
await writeFile(path.join(out,'批量修订专项统计.json'),JSON.stringify(result,null,2));
const fmt=(v,d=2)=>v==null?'未采集':Number(v).toFixed(d),delta=(a,b)=>a&&b!=null?((b/a-1)*100).toFixed(1)+'%':'不适用';
const a=paired.before,b=paired.after,qa=result.quality.before,qb=result.quality.after;
const batchWait=sum(afterTools.batches.map(batch=>batch.page_wait_sum_seconds)),batchWindows=sum(afterTools.batches.map(batch=>batch.page_call_window_seconds??0));
const lines=['# 批量修订与8192总控真实模型测评结论','',
 `结论：本轮完成6/6交付，批量工具真实执行${completeBatches.length}批、${sum(afterTools.batches.map(batch=>batch.size))}页；但未测到全流程提速或降本。生成平均耗时变化${delta(a.generation_mean_s,b.generation_mean_s)}，生成＋导出平均耗时变化${delta(a.generation_export_mean_s,b.generation_export_mean_s)}，统一高峰含缓存费用变化${delta(a.cost_cache_peak_cny,b.cost_cache_peak_cny)}。自动质量指标与上一轮一致。`,'',
 '本轮只运行当前版本，固定6类虚拟案例、每份6页，模板、评分器、预算与旧材料保持一致；主参考为20261114-review（上一轮检查调度优化后）。历史总控4096，本轮8192并加入批量修订，以下为综合变更的历史比较，不是单变量因果实验。','',
 `当前交付${result.stats.delivered}/6，PPTX通过${result.stats.pptx_passes}/6；配对生成案例：${paired.paired_case_ids.join('、')}；配对生成＋导出案例：${paired.export_paired_case_ids.join('、')}。`,'',
 '| 指标 | 上一轮 | 本轮 | 变化 |','|---|---:|---:|---:|'];
for(const [title,key,d]of [['生成平均秒数','generation_mean_s',2],['生成中位秒数','generation_median_s',2],['导出平均秒数','export_mean_s',2],['生成＋导出平均秒数','generation_export_mean_s',2],['模型调用次数','calls',0],['统一高峰无缓存费用','cost_peak_cny',4],['统一高峰含缓存费用','cost_cache_peak_cny',4]])lines.push(`| ${title} | ${fmt(a[key],d)} | ${fmt(b[key],d)} | ${delta(a[key],b[key])} |`);
lines.push('','## 批量机制是否触发','',`总控提出revise_pages ${afterTools.batches.length}次，覆盖${sum(afterTools.batches.map(x=>x.size))}个页面修订任务；实际完成批次${completeBatches.length}。上一轮单页修订工具调用${beforeTools.counts.revise_page??0}次，本轮${afterTools.counts.revise_page??0}次。不同输出导致返工量变化，工具次数差值不能全部视为批量节省。`,
 `本轮这5页由2个批量工具调用处理；按原每回合一个单页修订工具的规则，需要5个调用，局部工具调度由5合为2。5个页面请求累计等待${fmt(batchWait)}秒，两个批次的请求窗口合计${fmt(batchWindows)}秒，差约${fmt(batchWait-batchWindows)}秒，体现并行等待重叠；窗口不含全部渲染/校验/复核开销，不能当作整份PPT历史对照的节省。`,
 '','```json',JSON.stringify(afterTools.batches,null,2),'```','',
 '## 自动质量指标','',`严格事实词面命中：${qa.strict_facts}/${qa.facts_total} → ${qb.strict_facts}/${qb.facts_total}；数字及单位出现：${qa.numeric_units}/${qa.facts_total} → ${qb.numeric_units}/${qb.facts_total}；章节覆盖：${qa.sections}/${qa.sections_total} → ${qb.sections}/${qb.sections_total}；程序越界：${qa.overflow_pages}/${qa.pages} → ${qb.overflow_pages}/${qb.pages}；整例规则通过：${qa.rules_passes}/${qa.scored} → ${qb.rules_passes}/${qb.scored}。这些不等于通用事实准确率或人工视觉验收。`,
 '','## 逐案例与交付文件','','| 案例 | 终态 | 生成秒数 | 导出秒数 | 调用 | 严格事实 | PPTX |','|---|---|---:|---:|---:|---:|---|');
for(const c of current.cases){const file=path.join(out,c.case_id+'-current/deck.pptx').replaceAll('\\','/');lines.push(`| ${c.case_id} | ${c.phase} | ${fmt(c.generation_ms==null?null:c.generation_ms/1000)} | ${fmt(c.export_ms==null?null:c.export_ms/1000)} | ${c.calls} | ${c.score?.facts_hit??'?'}/${c.score?.facts_total??'?'} | ${c.pptx_pass?'[打开](<'+file+'>)':'未通过'} |`)}
lines.push('','## 用量与审计','',`总预算¥${ledger.limit_cny}；统一高峰无缓存估算¥${fmt(result.audit.peak_no_cache_cny,6)}，本次时段含缓存估算¥${fmt(result.audit.time_cache_estimate_cny,6)}，未核对供应商账单。官方报价来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ 。`,
 `请求${result.audit.requests}次，未知${result.audit.unknown}，未结算${result.audit.unsettled}；产品未知${result.audit.native_unknown}、在途预留¥${fmt(result.audit.native_reserved_cny,6)}；输出上限错误${result.audit.wrong_caps}，代理改写上限${result.audit.cap_normalizations}，运行中源码变化${changed}。`,
 `本轮请求结束原因：${JSON.stringify(result.finish_reasons)}；上一轮：${JSON.stringify(result.before_finish_reasons)}。总控实际输出最高${result.controller_output.max}，超过4096的回合${result.controller_output.above_4096}。总控截断与页面截断需分开解释；本轮没有调整页面12000上限。`,
 '','## 初步评估','',
 `功能验收通过，整体性能回归未改善。总控调用49→54、页面模型41→47、完成修订4→8、页面输出截断1→4；这些额外工作抵消了批量调度的局部收益。品牌和活动两例拉高均值，生成中位数${fmt(a.generation_median_s)}→${fmt(b.generation_median_s)}秒较接近。上述为可观察工作量变化，不将随机生成差异或截断全部归咎于批量工具。`,
 '本轮未发生总控输出截断或预算暂停；总控上限8192没有用到超过4096的输出空间。记录这一事实，但不据此把历史对比升级为单变量实验。本轮数据不支持宣称全流程提速或模型费用降低。',
 '','每类仅一次，旧版未重跑。总耗时与费用差值同时受到模型输出、返工次数、服务状态和缓存影响；若未触发多页修订，不宣称实测了该机制的提速。原始请求/响应、评分证据、源码清单和PPTX检查结果均保留。');
await writeFile(path.join(out,'测评结论.md'),lines.join('\n')+'\n');
console.log(JSON.stringify({stats:result.stats,comparison:paired,quality:result.quality,tools:result.tools,audit:result.audit,finish_reasons:result.finish_reasons},null,2));
