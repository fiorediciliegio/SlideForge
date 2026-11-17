// 只读已保存的测评结果；不调用模型或浏览器，不改变评分规则。
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const currentDir=path.resolve(process.argv[2]);
const baselineDir=path.resolve('.eval-results/harness/v3-16000/20261114T171535058Z');
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const current=await json(path.join(currentDir,'metadata.json'));
if(current.status==='running')throw new Error('测评尚未结束');
const before=await json(path.join(baselineDir,'metadata.json'));
const currentCalls=(await json(path.join(currentDir,'model-ledger.json'))).calls;
const oldCalls=(await json(path.join(baselineDir,'model-ledger.json'))).calls;
const summary=await json(path.join(currentDir,'summary.json'));
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
const median=xs=>{if(!xs.length)return null;xs=[...xs].sort((a,b)=>a-b);return xs.length%2?xs[(xs.length-1)/2]:(xs[xs.length/2-1]+xs[xs.length/2])/2};
const round=x=>x==null?null:Math.round(x*100)/100;
function peak(calls){
 const points=calls.flatMap(c=>Number.isFinite(Date.parse(c.finished_at))?[[Date.parse(c.started_at),1],[Date.parse(c.finished_at),-1]]:[]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 let active=0,high=0;for(const[,delta]of points){active+=delta;high=Math.max(high,active)}return high;
}
function metrics(meta,calls){
 return meta.records.map(record=>{
  const pages=calls.filter(c=>c.trial===record.id&&c.kind==='page');
  const start=record.events.findIndex(e=>e.phase==='generating');
  const end=start<0?undefined:record.events.slice(start+1).find(e=>e.phase!=='generating');
  return {case_id:record.case_id,first_generating_phase_s:start>=0&&end?round((end.elapsed_ms-record.events[start].elapsed_ms)/1000):null,
   peak_page_requests:peak(pages),page_calls:pages.length,page_request_mean_s:round(mean(pages.filter(c=>c.elapsed_ms!=null).map(c=>c.elapsed_ms/1000))),
   page_completion_tokens:pages.reduce((n,c)=>n+(c.usage?.completion_tokens??0),0),
   provider_models:[...new Set(calls.filter(c=>c.trial===record.id&&c.model).map(c=>c.model))]};
 });
}
const oldMetrics=metrics(before,oldCalls),currentMetrics=metrics(current,currentCalls);
const samples=(await readFile(path.join(currentDir,'resource-samples.jsonl'),'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const pair=summary.comparisons.find(c=>c.baseline_id===summary.primary_baseline);
const both=summary.current.cases.filter(c=>c.delivered&&c.pptx_pass&&pair.export_paired_case_ids.includes(c.case_id));
const oldCases=(await json('tools/harness-eval/baselines/20261114-scope-16000.json')).cases.filter(c=>pair.export_paired_case_ids.includes(c.case_id));
const extra={baseline:summary.primary_baseline,scope:'单项目串行六例的历史回归比较',
 before:oldMetrics,after:currentMetrics,
 first_generating_phase_mean_s:{before:round(mean(oldMetrics.map(m=>m.first_generating_phase_s).filter(Number.isFinite))),after:round(mean(currentMetrics.map(m=>m.first_generating_phase_s).filter(Number.isFinite)))},
 paired_generation_export_median_s:{before:round(median(oldCases.map(c=>(c.generation_ms+c.export_ms)/1000))),after:round(median(both.map(c=>(c.generation_ms+c.export_ms)/1000)))},
 machine_memory:{samples:samples.length,total_gib:round(samples[0]?.machine_total_bytes/2**30),min_free_gib:round(Math.min(...samples.map(s=>s.machine_free_bytes))/2**30),
  sampling_start:samples[0]?.time,sampling_end:samples.at(-1)?.time,
  note:'全机可用物理内存采样，非本项目独占内存或进程RSS峰值；不终止用户其他程序'},
 note:'首次generating阶段包含页面模型、引擎校验和提交，按原阶段事件约1秒精度计算；单次页面请求均值含推理和传输，不等于全流程墙钟时间。'};
await writeFile(path.join(currentDir,'补充分析.json'),JSON.stringify(extra,null,2));
const lines=['# 页面并发3真实测评补充分析','',`主基线：${extra.baseline}；本轮：${path.basename(currentDir)}。`,'',
 '配置：整页并发2→3；总控8192、单页16000、引擎1和固定材料/模板/评分规则保持。本轮包含共享请求池、项目准入及预算等待改动，按综合版本解释。','',
 '本报告只读取原始日志；标准评分与全部尝试见[报告.md](报告.md)。不重跑历史代码或失败案例。','',
 '| 案例 | 初次生成阶段：旧/新秒 | 页面请求峰值：旧/新 | 页面请求均值：旧/新秒 | 页面调用：旧/新 | 页面输出token：旧/新 |',
 '|---|---:|---:|---:|---:|---:|'];
for(const now of currentMetrics){const old=oldMetrics.find(c=>c.case_id===now.case_id);lines.push(`| ${now.case_id} | ${old?.first_generating_phase_s??'未知'} / ${now.first_generating_phase_s??'未知'} | ${old?.peak_page_requests} / ${now.peak_page_requests} | ${old?.page_request_mean_s} / ${now.page_request_mean_s} | ${old?.page_calls} / ${now.page_calls} | ${old?.page_completion_tokens} / ${now.page_completion_tokens} |`)}
lines.push('',`成功导出配对案例的生成＋导出中位数：${extra.paired_generation_export_median_s.before} → ${extra.paired_generation_export_median_s.after}秒。`,
 '',`首次generating阶段平均秒数：${extra.first_generating_phase_mean_s.before} → ${extra.first_generating_phase_mean_s.after}。`,
 '',`资源：${extra.machine_memory.sampling_start}至${extra.machine_memory.sampling_end}，每10秒采样一次，共${samples.length}次；总物理内存${extra.machine_memory.total_gib}GiB，采样窗口最低可用${extra.machine_memory.min_free_gib}GiB。${extra.machine_memory.note}。`,
 '',extra.note,'',
 '限制：每类只有一次、跨日期历史比较；模型推理/输出量、检查与返工和当时机器负载均可能变化。观察到请求峰值3只能确认实际并行，不能单独证明因果提速。单项目串行不能证明共享12或多客户吞吐。',
 '', '供应商模型别名及价格已对照[DeepSeek官方文档](https://api-docs.deepseek.com/quick_start/pricing/)；统一比较仍使用既有2/8元每百万输入/输出、缓存输入0.04元，未修改冻结协议，也未核对实际账单。');
await writeFile(path.join(currentDir,'补充分析.md'),lines.join('\n')+'\n');
console.log(JSON.stringify(extra,null,2));
