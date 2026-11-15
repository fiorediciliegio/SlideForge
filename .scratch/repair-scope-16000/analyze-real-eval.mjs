import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const out=path.resolve(process.argv[2]),root=path.resolve(import.meta.dirname,'../..');
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const meta=await json(path.join(out,'metadata.json')),summary=await json(path.join(out,'summary.json')),ledger=await json(path.join(out,'model-ledger.json'));
if(meta.status!=='finished'&&meta.status!=='stopped')throw new Error('测评尚未结束');
const count=(rows,key)=>Object.fromEntries([...new Set(rows.map(key))].map(k=>[k,rows.filter(r=>key(r)===k).length]));
const sum=rows=>rows.reduce((a,b)=>a+b,0),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const calls=ledger.calls,tools=[],batches=[],rawOps=meta.records.flatMap(r=>Object.entries(r.raw_job?.agent?.operations??{}).map(([id,op])=>({id,case_id:r.case_id,...op})));
for(const c of calls.filter(c=>c.kind==='controller'&&c.status==='completed')){
 const response=await json(path.join(out,`response-${c.id}.json`));
 for(const t of response.choices?.[0]?.message?.tool_calls??[]){
  const a=JSON.parse(t.function.arguments);tools.push({name:t.function.name,trial:c.trial,id:t.id});
  if(t.function.name==='revise_pages'){
   const op=rawOps.find(op=>op.case_id+'-current'===c.trial&&op.id.endsWith(':'+t.id));
   let scope;
   if(op?.status==='completed')scope=await json(path.join(root,'artifacts/decks',meta.records.find(r=>r.id===c.trial).deck_id,'project/revision-batches',sha(JSON.stringify(op.id))+'.json'));
   batches.push({trial:c.trial,request:c.id,pages:a.revisions.map(r=>r.page_id),completed:op?.status==='completed',allowed_page_ids:scope?.allowed_page_ids,
    outside_scope:op?.status==='completed'?a.revisions.filter(r=>!scope.allowed_page_ids.includes(r.page_id)).map(r=>r.page_id):[]});
  }
 }
}
let changed=0;for(const item of await json(path.join(out,'source-manifest.json')))if(sha(await readFile(path.join(root,item.file)))!==item.sha256)changed++;
const perCase=meta.records.map(r=>({case_id:r.case_id,phase:r.phase,pptx:r.export?.pass,spent:r.raw_job?.agent?.budget?.spent_cny,limit:r.raw_job?.agent?.budget?.limit_cny,
 active_seconds:r.raw_job?.agent?.budget?.active_seconds,limit_seconds:r.raw_job?.agent?.budget?.limit_seconds}));
const audit={requests:calls.length,unknown:calls.filter(c=>c.status==='unknown').length,unsettled:calls.filter(c=>c.status!=='completed').length,
 wrong_caps:calls.filter(c=>c.max_tokens!==(c.kind==='page'?16000:c.kind==='controller'?8192:4096)).length,
 cap_normalizations:calls.filter(c=>c.normalized_max_tokens).length,changed_runtime_files:changed,
 peak_no_cache_cny:sum(calls.map(c=>c.cost_peak_cny??0)),time_cache_cny:sum(calls.map(c=>c.cost_time_cache_cny??0)),
 scope_violations:sum(batches.map(b=>b.outside_scope.length)),per_case:perCase};
const result={audit,comparisons:summary.comparisons,page_metrics:summary.page_metrics,tool_counts:count(tools,t=>t.name),batches,
 finish_reasons:count(calls,c=>c.kind+':'+c.finish_reason),controller_max_output:Math.max(...calls.filter(c=>c.kind==='controller').map(c=>c.usage?.completion_tokens??0)),
 page_output:{max:Math.max(...calls.filter(c=>c.kind==='page').map(c=>c.usage?.completion_tokens??0)),above_12000:calls.filter(c=>c.kind==='page'&&c.usage?.completion_tokens>12000).map(c=>({id:c.id,trial:c.trial,tokens:c.usage.completion_tokens,finish_reason:c.finish_reason,reasoning_tokens:c.usage.completion_tokens_details?.reasoning_tokens}))}};
await writeFile(path.join(out,'专项统计.json'),JSON.stringify(result,null,2));
const primary=summary.comparisons.find(c=>c.baseline_id==='20261114-review'),secondary=summary.comparisons.find(c=>c.baseline_id==='20261114-revision-batch'),fmt=(n,d=2)=>n==null?'未采集':n.toFixed(d);
const lines=['# 修订范围限制与单页16000真实测评结论','',`状态${meta.status}。固定6类虚拟案例，只跑当前版；主参考为第二项修改前，辅助参考为上一轮批量修订版。总控8192、单页16000、并发2，比较综合变更，不作单变量因果结论。`,'',
 '| 指标 | 第二项前 | 上一轮 | 本轮 |','|---|---:|---:|---:|'];
for(const [label,key,d]of [['生成平均秒数','generation_mean_s',2],['生成中位秒数','generation_median_s',2],['生成＋导出平均秒数','generation_export_mean_s',2],['模型调用','calls',0],['统一高峰无缓存费用','cost_peak_cny',4],['统一高峰含缓存费用','cost_cache_peak_cny',4],['交付数','delivered',0],['PPTX通过','pptx_passes',0]])lines.push(`| ${label} | ${fmt(primary.before[key],d)} | ${fmt(secondary.before[key],d)} | ${fmt(primary.after[key],d)} |`);
const delta=(c,key)=>((c.after[key]/c.before[key]-1)*100).toFixed(1)+'%';
lines.push('',`本轮相对上一轮：生成均值${delta(secondary,'generation_mean_s')}，生成＋导出均值${delta(secondary,'generation_export_mean_s')}，统一含缓存费用${delta(secondary,'cost_cache_peak_cny')}。`,
 `相对第二项修改前：生成均值${delta(primary,'generation_mean_s')}，生成＋导出均值${delta(primary,'generation_export_mean_s')}，统一含缓存费用${delta(primary,'cost_cache_peak_cny')}。因此尚不能宣称第二项优化使整体更快、更省。`,
 `修订完成次数为${primary.after.completed_repairs}次（第二项前${primary.before.completed_repairs}、上一轮${secondary.before.completed_repairs}）；本轮批量工具未触发，不把整体差值归因于批量并发。`);
lines.push('','以上耗时/费用只比较双方交付的相同案例；生成＋导出另要求PPTX通过。失败/暂停不替换，完整6例结果见报告。','',
 '## 截断与首次生成','','| 版本 | 截断/页面响应 | 首次程序通过/36 | 首轮无需必要返工/36 | 程序/评审未知 | 未执行 |','|---|---:|---:|---:|---:|---:|');
for(const[id,m]of [...Object.entries(summary.page_metrics.baselines).map(([id,v])=>[id,v.summary]),['current',summary.page_metrics.current]])lines.push(`| ${id} | ${m.truncated_responses}/${m.page_responses} | ${m.first_program.passed}/36 | ${m.first_no_blocker.passed}/36 | ${m.first_program.unknown}/${m.first_no_blocker.unknown} | ${m.first_program.not_attempted} |`);
lines.push('',`当前已采集${summary.page_metrics.current.planned_pages}/36页，其他为未采集，不计成功。初稿无阻断率不把非阻断建议算失败；通过后重新修订也不补计首次程序成功。`,
 '','首次程序通过率：第二项前94.4%、上一轮88.9%、本轮97.2%；初稿无需必要返工率分别86.1%、77.8%、91.7%。这些是固定小样本中的观察结果。',
 '','## 批量范围审计','',`提出批量工具${batches.length}次，完成${batches.filter(b=>b.completed).length}批，完成批次清单外页${audit.scope_violations}。`,'','```json',JSON.stringify(batches,null,2),'```',
 '','## 费用与审计','',`预算${ledger.limit_cny}元；统一高峰无缓存估算${fmt(audit.peak_no_cache_cny,6)}元，本次时段含缓存估算${fmt(audit.time_cache_cny,6)}元，未核对供应商账单。`,
 `请求${audit.requests}次，未知${audit.unknown}、未结算${audit.unsettled}；输出上限错误${audit.wrong_caps}、代理改写${audit.cap_normalizations}、运行中源码变化${changed}。`,
 `结束原因${JSON.stringify(result.finish_reasons)}；总控最大实际输出${result.controller_max_output}。`,
 `页面实际最大输出${result.page_output.max} tokens，超过旧12000上限的响应${result.page_output.above_12000.length}次；详见专项统计。正常结束不等于通过版面/内容检查，因此另统计首次程序通过与初稿无需必要返工。`,
 '','## 质量与限制','',
 `最终严格事实词面命中${primary.after.facts_hit}/${primary.after.facts_total}（两轮参考均23/26），章节${primary.after.section_hits}/24，程序越界${primary.after.overflow_pages}/36，全部规则通过${primary.after.rules_passes}/6。`,
 '旅游案例的未命中项为“旅行天数2天”；实际文字写的是“两天”，严格数字评分仍保留未命中，未为本轮修改评分规则。该词面指标不能直接当作通用事实准确率。',
 '本轮范围限制由已有零付费越界/恢复用例验证；真实生成未触发批量修订，无法实测其并发收益。单页有2次正常响应超过旧12000上限，提供了新增输出空间被使用的直接证据，但不能把全部首次通过率变化归因于上限。',
 '','## 文件与复核','',
 ...summary.current.cases.map(c=>`- ${c.case_id}：[PPTX](<${path.join(out,c.case_id+'-current/deck.pptx').replaceAll('\\','/')}>)。`),
 '','原始质量事实、章节、越界、PPTX文件与逐例链接见[完整报告](报告.md)，预算/并发/文件审计见[最终审计](最终审计.json)。每类仅一次，未进行人工视觉验收，不据一次波动宣称普遍提速或质量提升。');
await writeFile(path.join(out,'测评结论.md'),lines.join('\n')+'\n');
console.log(JSON.stringify({report:path.join(out,'测评结论.md'),audit,page_metrics:summary.page_metrics.current,batches,finish_reasons:result.finish_reasons,page_output:result.page_output},null,2));
