import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

export const here=import.meta.dirname;
export const root=path.resolve(here,'../..');
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const sum=(rows,key)=>rows.reduce((s,r)=>s+(r[key]??0),0);
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const median=values=>{if(!values.length)return null;const a=[...values].sort((a,b)=>a-b),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2};
const fmt=(n,d=2)=>n==null?'未采集':n.toFixed(d);
const change=(a,b)=>a&&b!=null?((b/a-1)*100).toFixed(1)+'%':'不适用';

export async function validateSuite(profileName='v1'){
  const bytes=await readFile(path.join(here,'suite-v1.json')),protocol=JSON.parse(bytes);
  for(const item of protocol.files){
    if(hash(await readFile(path.join(here,item.file)))!==item.sha256)throw new Error('固定测评文件已变化，需新建基准版本：'+item.file);
  }
  const {getTemplateReference}=await import('../../src/templates/library.ts');
  if(hash(Buffer.from(await getTemplateReference(protocol.template_id)))!==protocol.template_reference_sha256)throw new Error('当前PPT模板与固定基准不一致，请恢复模板或新建基准版本');
  const fixtures=await json(path.join(here,'fixtures/v1/fixtures.json'));
  if(profileName==='v1')return {protocol:{...protocol,page_concurrency:2},protocol_hash:hash(bytes),fixtures};
  if(!['revision-batch-8192','repair-scope-16000','page-concurrency-3','context-status-v1'].includes(profileName))throw new Error('未知测评配置：'+profileName);
  const profileBytes=await readFile(path.join(here,'profiles',profileName+'.json')),profile=JSON.parse(profileBytes);
  if(profile.parent_protocol_hash!==hash(bytes))throw new Error('8192配置引用的v1协议已变化');
  if(hash(await readFile(path.join(here,profile.proxy_file)))!==profile.proxy_sha256)throw new Error('8192代理与已登记配置不一致');
  let metric_baselines;
  if(profile.metrics_file){
    const metrics=await readFile(path.join(here,profile.metrics_file));
    if(hash(metrics)!==profile.metrics_sha256||hash(await readFile(path.join(here,'page-metrics.mjs')))!==profile.metrics_collector_sha256)throw new Error('页面指标口径或历史指标已变化');
    metric_baselines=JSON.parse(metrics);
  }
  return {protocol:{...protocol,id:profile.id,context_version:profile.context_version,page_concurrency:profile.page_concurrency??2,controller_max_tokens:profile.controller_max_tokens,page_max_tokens:profile.page_max_tokens??protocol.page_max_tokens,primary_baseline:profile.primary_baseline,
    baseline_ids:[profile.primary_baseline,...(profile.additional_baselines??[]).map(b=>b.id),...protocol.baseline_ids]},protocol_hash:hash(profileBytes),reference_protocol_hash:hash(bytes),profile,fixtures,metric_baselines};
}

export async function loadBaselines(suite){
  const baselines=[],index=await json(path.join(here,'baselines/index.json'));
  if(hash(await readFile(path.join(here,'baselines/original-source-manifest.json')))!==index.original_source_manifest_sha256)throw new Error('历史源码清单已变化');
  for(const id of suite.protocol.baseline_ids){
    const bytes=await readFile(path.join(here,'baselines',id+'.json'));
    const extra=suite.profile?.additional_baselines?.find(b=>b.id===id);
    const expected=extra?.sha256??(id===suite.profile?.primary_baseline?suite.profile.baseline_sha256:index.baselines[id].sha256);
    if(hash(bytes)!==expected)throw new Error('冻结历史基线已变化：'+id);
    const baseline=JSON.parse(bytes);
    if(baseline.protocol_hash!==(extra?.protocol_hash??(id===suite.profile?.primary_baseline?suite.profile.baseline_protocol_hash:undefined)??suite.reference_protocol_hash??suite.protocol_hash))throw new Error('历史基线与测评协议不一致：'+id);
    baselines.push(baseline);
  }
  return baselines;
}

function callCache(calls){
  return Object.fromEntries(['total','controller','page','outline'].map(kind=>{
    const rows=kind==='total'?calls:calls.filter(c=>c.kind===kind);
    const known=c=>c.status==='completed'&&Number.isFinite(c.usage?.prompt_tokens)&&Number.isFinite(c.usage?.prompt_cache_hit_tokens)&&c.usage.prompt_cache_hit_tokens>=0&&c.usage.prompt_cache_hit_tokens<=c.usage.prompt_tokens;
    const unknown_calls=rows.filter(c=>!known(c)).length;
    const input_tokens=rows.reduce((s,c)=>s+(Number.isFinite(c.usage?.prompt_tokens)?c.usage.prompt_tokens:0),0);
    const hit_tokens=unknown_calls?null:rows.reduce((s,c)=>s+c.usage.prompt_cache_hit_tokens,0);
    return [kind,{input_tokens,hit_tokens,miss_tokens:hit_tokens==null?null:input_tokens-hit_tokens,
      hit_ratio:hit_tokens!=null&&input_tokens>0?hit_tokens/input_tokens:null,unknown_calls,uncollected_cases:0}];
  }));
}

function summarizeCache(cases){
  return Object.fromEntries(['total','controller','page','outline'].map(kind=>{
    const parts=cases.map(c=>c.cache?.[kind]),uncollected_cases=parts.filter(p=>!p).length;
    if(uncollected_cases)return [kind,{input_tokens:kind==='total'?sum(cases,'prompt_tokens'):null,hit_tokens:null,miss_tokens:null,hit_ratio:null,unknown_calls:null,uncollected_cases}];
    const input_tokens=sum(parts,'input_tokens'),unknown_calls=sum(parts,'unknown_calls');
    const hit_tokens=unknown_calls?null:sum(parts,'hit_tokens');
    return [kind,{input_tokens,hit_tokens,miss_tokens:hit_tokens==null?null:input_tokens-hit_tokens,
      hit_ratio:hit_tokens!=null&&input_tokens>0?hit_tokens/input_tokens:null,unknown_calls,uncollected_cases:0}];
  }));
}

export function normalizeRun(meta,calls,arm,id,protocolHash){
  return {id,protocol_hash:protocolHash,started_at:meta.started_at,finished_at:meta.finished_at,model:meta.model,
    git_head:meta.git_head,hardware:meta.hardware,service_lifecycle:meta.service_lifecycle,
    cases:meta.records.filter(r=>r.arm===arm).map(r=>{
      const model=calls.filter(c=>c.trial===r.id),settled=model.filter(c=>c.status==='completed');
      return {case_id:r.case_id,phase:r.phase??'error',delivered:!!r.delivery_success,generation_ms:r.generation_ms??null,
        export_ms:r.export?.elapsed_ms??null,pptx_pass:!!r.export?.pass,score:r.score,scene:r.scene,page_metrics:r.page_metrics,
        error:r.error??r.raw_job?.agent?.error,request:r.raw_job?.agent?.request,
        calls:model.length,calls_by_kind:Object.fromEntries(['controller','page','outline'].map(k=>[k,model.filter(c=>c.kind===k).length])),cache:callCache(model),
        prompt_tokens:settled.reduce((s,c)=>s+c.usage.prompt_tokens,0),
        completion_tokens:settled.reduce((s,c)=>s+c.usage.completion_tokens,0),
        reasoning_tokens:settled.reduce((s,c)=>s+(c.usage.completion_tokens_details?.reasoning_tokens??0),0),
        cache_hit_tokens:settled.reduce((s,c)=>s+(c.usage.prompt_cache_hit_tokens??0),0),
        cost_time_cache_cny:sum(settled,'cost_time_cache_cny'),
        supplier_unknown:model.filter(c=>c.status==='unknown').length,
        supplier_unsettled_reserve_cny:model.filter(c=>c.status!=='completed').reduce((s,c)=>s+(c.reserved_cny??0),0),
        native_unknown:r.raw_job?.agent?Object.values(r.raw_job.agent.calls??{}).filter(c=>c.status==='unknown').length:null,
        native_reserved_cny:r.raw_job?.agent?.budget?.reserved_cny??0,
        completed_repairs:Object.values(r.raw_job?.agent?.operations??{}).filter(op=>op.status==='completed'&&op.result?.repair&&op.result?.page_id).length,
        fingerprints:[...new Set(settled.map(c=>c.system_fingerprint).filter(Boolean))],
      };
    })};
}

export function summarizeCases(cases){
  const success=cases.filter(c=>c.delivered),scored=cases.filter(c=>c.score);
  const prompt=sum(cases,'prompt_tokens'),completion=sum(cases,'completion_tokens'),hit=sum(cases,'cache_hit_tokens');
  return {attempted:cases.length,delivered:success.length,pptx_passes:cases.filter(c=>c.pptx_pass).length,
    generation_mean_s:mean(success.filter(c=>c.generation_ms!=null).map(c=>c.generation_ms/1000)),
    generation_median_s:median(success.filter(c=>c.generation_ms!=null).map(c=>c.generation_ms/1000)),
    calls:sum(cases,'calls'),prompt_tokens:prompt,completion_tokens:completion,reasoning_tokens:sum(cases,'reasoning_tokens'),cache:summarizeCache(cases),
    cost_peak_cny:(prompt*2+completion*8)/1e6,
    cost_cache_peak_cny:((prompt-hit)*2+hit*.04+completion*8)/1e6,
    cost_time_cache_cny:sum(cases,'cost_time_cache_cny'),
    supplier_unknown:sum(cases,'supplier_unknown'),native_unknown:sum(cases,'native_unknown'),
    native_unknown_uncollected:cases.filter(c=>c.native_unknown==null).length,
    native_reserved_cny:sum(cases,'native_reserved_cny'),supplier_unsettled_reserve_cny:sum(cases,'supplier_unsettled_reserve_cny'),
    facts_hit:scored.reduce((s,c)=>s+c.score.facts_hit,0),facts_total:scored.reduce((s,c)=>s+c.score.facts_total,0),
    value_hits:scored.reduce((s,c)=>s+c.score.facts.filter(f=>f.value_present).length,0),
    section_hits:scored.reduce((s,c)=>s+c.score.section_hits,0),
    overflow_pages:scored.reduce((s,c)=>s+c.score.overflow_pages.length,0),
    rules_passes:success.filter(c=>c.score?.rules_pass).length,completed_repairs:sum(cases,'completed_repairs')};
}

export function compareRuns(baseline,current){
  const paired=baseline.cases.filter(a=>a.delivered&&current.cases.some(b=>b.case_id===a.case_id&&b.delivered));
  const newer=paired.map(a=>current.cases.find(b=>b.case_id===a.case_id));
  const exportIds=paired.filter(a=>a.pptx_pass&&newer.find(b=>b.case_id===a.case_id).pptx_pass).map(a=>a.case_id);
  const totals=cases=>{
    const exported=cases.filter(c=>exportIds.includes(c.case_id));
    return {...summarizeCases(cases),export_mean_s:mean(exported.map(c=>c.export_ms/1000)),
      generation_export_mean_s:mean(exported.map(c=>(c.generation_ms+c.export_ms)/1000))};
  };
  return {baseline_id:baseline.id,paired_case_ids:paired.map(c=>c.case_id),export_paired_case_ids:exportIds,before:totals(paired),after:totals(newer)};
}

export async function writeComparison(out,suite){
  const meta=await json(path.join(out,'metadata.json')),ledger=await json(path.join(out,'model-ledger.json'));
  if(meta.protocol_hash!==suite.protocol_hash)throw new Error('运行记录与固定测评协议不一致');
  const current=normalizeRun(meta,ledger.calls,'current','current',suite.protocol_hash);
  const baselines=await loadBaselines(suite),comparisons=baselines.map(b=>compareRuns(b,current));
  const currentPageMetrics=suite.metric_baselines?(await import('./page-metrics.mjs')).summarizePageMetrics(meta.records.map(r=>r.page_metrics)):undefined;
  const summary={comparison_type:'historical-reference',protocol_id:suite.protocol.id,controller_max_tokens:suite.protocol.controller_max_tokens,primary_baseline:suite.protocol.primary_baseline,
    status:meta.status,current,stats:summarizeCases(current.cases),comparisons,page_metrics:currentPageMetrics?{current:currentPageMetrics,baselines:suite.metric_baselines}:undefined};
  await writeFile(path.join(out,'summary.json'),JSON.stringify(summary,null,2));
  const primary=comparisons.find(c=>c.baseline_id===suite.protocol.primary_baseline),a=primary.before,b=primary.after;
  const lines=['# Harness 固定案例历史基线对比','','状态：'+meta.status+'。仅运行当前代码'+current.cases.length+'/6次；旧版结果直接读取冻结数据，未重跑旧版。','',
    '## 与主基线 '+primary.baseline_id+' 比较','','成功生成配对案例：'+(primary.paired_case_ids.join('、')||'无')+'；成功生成与导出配对：'+(primary.export_paired_case_ids.join('、')||'无')+'。','',
    '| 指标 | 历史基线 | 当前代码 | 变化 |','|---|---:|---:|---:|'];
  if(suite.profile)lines.splice(4,0,`本轮总控上限${suite.protocol.controller_max_tokens}、单页${suite.protocol.page_max_tokens}，各历史版本配置保持原记录；以下为综合变更的历史比较，不能作单变量因果结论。`,'');
  for(const [label,key,digits] of [['生成平均秒数（含检查修订）','generation_mean_s',2],['生成中位数（秒）','generation_median_s',2],
    ['导出平均秒数','export_mean_s',2],['生成＋导出平均秒数','generation_export_mean_s',2],['模型调用','calls',0],
    ['统一高峰无缓存费用（元）','cost_peak_cny',4],['统一高峰含缓存费用（元）','cost_cache_peak_cny',4]]){
    lines.push('| '+label+' | '+fmt(a[key],digits)+' | '+fmt(b[key],digits)+' | '+change(a[key],b[key])+' |');
  }
  const primaryRun=baselines.find(c=>c.id===suite.protocol.primary_baseline);
  const cacheRate=c=>c.hit_ratio!=null?(c.hit_ratio*100).toFixed(2)+'%':c.uncollected_cases||c.unknown_calls?'未采集完整':c.input_tokens===0?'无请求':'未采集';
  for(const [label,before,after]of [['全部尝试',summarizeCases(primaryRun.cases),summary.stats],['共同成功案例',a,b]]){
    lines.push('','## 缓存命中率：'+label,'','| 用途 | 历史输入/命中/未命中token | 当前输入/命中/未命中token | 历史命中率 | 当前命中率 | 变化（百分点） | 历史/当前未知调用 | 历史/当前未采集案例 |','|---|---:|---:|---:|---:|---:|---:|---:|');
    for(const [kind,name]of [['controller','总控'],['page','页面生成'],['total','整体']]){
      const x=before.cache[kind],y=after.cache[kind],tokens=c=>[c.input_tokens,c.hit_tokens,c.miss_tokens].map(n=>n??'未知').join('/');
      lines.push(`| ${name} | ${tokens(x)} | ${tokens(y)} | ${cacheRate(x)} | ${cacheRate(y)} | ${x.hit_ratio==null||y.hit_ratio==null?'不适用':((y.hit_ratio-x.hit_ratio)*100).toFixed(2)} | ${x.unknown_calls??'未知'}/${y.unknown_calls??'未知'} | ${x.uncollected_cases}/${y.uncollected_cases} |`);
    }
  }
  lines.push('','命中率按供应商返回的命中token总和÷输入token总和计算，不平均单次百分比。缺失usage、缺失缓存字段或未结算调用会使对应命中率标为未知；表中已采集输入可能只是小计。未修改历史记录或重新请求模型。缓存受供应商前缀复用及运行时段影响，差值不等于上下文优化的因果效果。');
  if(currentPageMetrics){
    const goal=suite.protocol.page_count*suite.fixtures.cases.length;
    lines.push('','## 首次生成与截断（同口径补算）','','| 版本 | 页面截断/有响应调用 | 首次程序通过/目标页 | 初稿无需必要返工/目标页 | 程序/评审未知 | 未执行 |','|---|---:|---:|---:|---:|---:|');
    for(const[id,s]of [...Object.entries(suite.metric_baselines).map(([id,v])=>[id,v.summary]),['current',currentPageMetrics]])lines.push(`| ${id} | ${s.truncated_responses}/${s.page_responses} | ${s.first_program.passed}/${goal} | ${s.first_no_blocker.passed}/${goal} | ${s.first_program.unknown}/${s.first_no_blocker.unknown} | ${s.first_program.not_attempted} |`);
    lines.push('',`本轮已采集${currentPageMetrics.planned_pages}/${goal}目标页；未采集${goal-currentPageMetrics.planned_pages}页，不能视为成功。首次通过要求完整HTML及程序版面通过；初稿无需必要返工另要求首轮内容/视觉无阻断。非阻断建议不算失败，返工后通过不补计首次成功。历史只读补算，未重跑模型。`);
  }
  lines.push('','## 全部尝试与历史记录','','| 版本 | 交付 | PPTX通过 | 调用 | 统一无缓存费用 | 统一含缓存费用 |','|---|---:|---:|---:|---:|---:|');
  for(const run of [...baselines,current]){
    const s=summarizeCases(run.cases);
    lines.push('| '+run.id+' | '+s.delivered+'/'+s.attempted+' | '+s.pptx_passes+' | '+s.calls+' | '+fmt(s.cost_peak_cny,4)+' | '+fmt(s.cost_cache_peak_cny,4)+' |');
  }
  lines.push('','## 逐案例记录','','| 案例 | 主基线终态 | 当前终态 | 历史生成秒数 | 当前生成秒数 | 当前PPTX |','|---|---|---|---:|---:|---|');
  const base=baselines.find(x=>x.id===suite.protocol.primary_baseline);
  for(const fixture of suite.fixtures.cases){
    const old=base.cases.find(c=>c.case_id===fixture.id),now=current.cases.find(c=>c.case_id===fixture.id);
    const link=now?.pptx_pass?'[打开](<'+path.join(out,fixture.id+'-current/deck.pptx').replaceAll('\\','/')+'>)':'未完成/未通过';
    lines.push('| '+fixture.id+' | '+old.phase+' | '+(now?.phase??'未运行')+' | '+fmt(old.generation_ms/1000)+' | '+fmt(now?.generation_ms==null?null:now.generation_ms/1000)+' | '+link+' |');
  }
  lines.push('','## 解释边界','',
    '- 本报告为历史基线回归比较，不是同轮随机A/B。不同时间的模型服务、缓存、硬件负载和自主修订路径会变化，不能把全部差值归因于本次代码改动。',
    '- 本报告主基线为'+suite.protocol.primary_baseline+'；其他历史基线继续保留，失败及暂停结果不替换。',
    '- 速度和费用配对只采用相同案例双方成功的子集；生成＋导出另要求双方PPTX检查通过。未交付案例仍保留在全部尝试中，暂停耗时不当作交付耗时。',
    '- 模型费用以固定2/8元每百万输入/输出、缓存输入0.04元统一重算，避免高峰/非高峰报价差异冒充性能收益；当时段费用另见summary.json。估算未与供应商账单核对，不含机器部署成本。',
    '- 本基准只测首次生成；模型不一定选择页面/历史读取，未触发的功能不宣称收益。严格事实词面命中不等于通用准确率，程序越界和PPTX检查不能代替视觉验收。',
    '- 每类一次，仅作趋势参考；模型/fingerprint、机器配置、代码哈希和原始调用见metadata.json、source-manifest.json及model-ledger.json。',
    '- 保持固定案例、6页、模板参考快照、评分器、预算和输出上限；协议文件校验失败时停止，需新建基准版本，不能悄悄换材料或评分规则。',
    '','当前产品记录未知调用：'+summary.stats.native_unknown+'（'+summary.stats.native_unknown_uncollected+'例未采集）；供应商未知请求：'+summary.stats.supplier_unknown+'；产品保留预留费用：¥'+fmt(summary.stats.native_reserved_cny,6)+'。');
  await writeFile(path.join(out,'报告.md'),lines.join('\n')+'\n');
  return summary;
}
