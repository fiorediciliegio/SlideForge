import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '../..');

test('缓存按输入token加权，缺字段不当零，区分模型用途',async()=>{
 const {normalizeRun,summarizeCases}=await import('../../tools/harness-eval/benchmark.mjs');
 const meta={records:[{id:'a',case_id:'product',arm:'current',delivery_success:true}]};
 const call=(kind:string,usage:any)=>({trial:'a',kind,status:'completed',usage});
 const run=normalizeRun(meta,[call('controller',{prompt_tokens:100,completion_tokens:1,prompt_cache_hit_tokens:100}),call('controller',{prompt_tokens:900,completion_tokens:1,prompt_cache_hit_tokens:0}),call('page',{prompt_tokens:1000,completion_tokens:1,prompt_cache_hit_tokens:500})],'current','test','h');
 const cache=summarizeCases(run.cases).cache;
 assert.equal(cache.controller.hit_ratio,.1);assert.equal(cache.page.hit_ratio,.5);assert.equal(cache.total.hit_ratio,.3);
 assert.equal(cache.total.input_tokens,2000);assert.equal(cache.total.hit_tokens,600);assert.equal(cache.total.miss_tokens,1400);
 const missing=normalizeRun(meta,[call('controller',{prompt_tokens:100,completion_tokens:1})],'current','test','h');
 assert.equal(summarizeCases(missing.cases).cache.controller.hit_ratio,null);assert.equal(summarizeCases(missing.cases).cache.controller.unknown_calls,1);
 const historical=summarizeCases([{calls:2,prompt_tokens:1000}]);assert.equal(historical.cache.total.hit_ratio,null);
 const unknown=normalizeRun(meta,[{trial:'a',kind:'controller',status:'unknown'}],'current','test','h');
 assert.equal(summarizeCases(unknown.cases).cache.total.hit_ratio,null);assert.equal(summarizeCases(unknown.cases).cache.total.unknown_calls,1);
});

test('状态上下文配置固定上轮并发3结果和缓存基线',async()=>{
 const {validateSuite,loadBaselines}=await import('../../tools/harness-eval/benchmark.mjs');
 const suite=await validateSuite('context-status-v1'),baseline=(await loadBaselines(suite)).find(b=>b.id===suite.protocol.primary_baseline);
 assert.equal(suite.protocol.primary_baseline,'20261115-page-concurrency-3');assert.equal(suite.protocol.page_concurrency,3);
 assert.equal(suite.protocol.context_version,2);assert.equal(baseline.cases.length,6);
 const controller=baseline.cases.reduce((n,c)=>n+c.cache.controller.input_tokens,0),hit=baseline.cases.reduce((n,c)=>n+c.cache.controller.hit_tokens,0);
 assert.equal(controller,722366);assert.equal(hit,492032);
});

test('状态配置免费计划显示格式版本且不调用供应商',()=>{
 const result=spawnSync(process.execPath,['--import','tsx/esm','tools/harness-eval/run.mjs','--profile','context-status-v1','--check'],{cwd:root,encoding:'utf8',env:{...process.env,OPENAI_API_KEY:''}});
 assert.equal(result.status,0,result.stderr);const plan=JSON.parse(result.stdout);
 assert.equal(plan.context_version,2);assert.equal(plan.provider_requests,0);assert.equal(plan.primary_baseline,'20261115-page-concurrency-3');
});

test('缓存报告同时保留全部尝试和成功配对，失败调用仍计入全量',async()=>{
 const {validateSuite,writeComparison}=await import('../../tools/harness-eval/benchmark.mjs');
 const suite=await validateSuite('context-status-v1'),out=await mkdtemp(path.join(os.tmpdir(),'sf-cache-report-'));
 try{
  await writeFile(path.join(out,'metadata.json'),JSON.stringify({protocol_hash:suite.protocol_hash,status:'test',records:[
   {id:'ok',case_id:'product',arm:'current',phase:'completed',delivery_success:true},
   {id:'failed',case_id:'brand',arm:'current',phase:'interrupted',delivery_success:false}]}));
  await writeFile(path.join(out,'model-ledger.json'),JSON.stringify({calls:[
   {trial:'ok',kind:'controller',status:'completed',usage:{prompt_tokens:100,completion_tokens:1,prompt_cache_hit_tokens:50}},
   {trial:'failed',kind:'page',status:'unknown'}]}));
  const report=await writeComparison(out,suite),comparison=report.comparisons.find(c=>c.baseline_id===suite.protocol.primary_baseline);
  assert.equal(report.stats.cache.total.unknown_calls,1);assert.equal(report.stats.cache.total.hit_ratio,null);
  assert.deepEqual(comparison.paired_case_ids,['product']);assert.equal(comparison.after.cache.total.hit_ratio,.5);
  const md=await readFile(path.join(out,'报告.md'),'utf8');assert.match(md,/缓存命中率：全部尝试/);assert.match(md,/缓存命中率：共同成功案例/);assert.match(md,/未采集完整/);
 }finally{await rm(out,{recursive:true,force:true})}
});

test('并发3配置显式引用16000历史协议而不覆盖旧配置',async()=>{
  const {validateSuite,loadBaselines}=await import('../../tools/harness-eval/benchmark.mjs');
  const suite=await validateSuite('page-concurrency-3');
  assert.equal(suite.protocol.page_concurrency,3);assert.equal(suite.protocol.page_max_tokens,16000);
  assert.equal(suite.protocol.primary_baseline,'20261114-scope-16000');
  const baseline=(await loadBaselines(suite)).find(b=>b.id===suite.protocol.primary_baseline);
  assert.equal(baseline.cases.length,6);assert.equal(baseline.page_concurrency,2);
  assert.equal(suite.metric_baselines['20261114-scope-16000'].summary.first_program.passed,35);
  const old=await validateSuite('repair-scope-16000');assert.equal(old.protocol.page_concurrency,2);
});

test('16000配置保留两轮历史基线和可复核的首次生成指标',async()=>{
  const {validateSuite,loadBaselines}=await import('../../tools/harness-eval/benchmark.mjs');
  const suite=await validateSuite('repair-scope-16000');
  assert.equal(suite.protocol.controller_max_tokens,8192);assert.equal(suite.protocol.page_max_tokens,16000);
  assert.equal(suite.protocol.primary_baseline,'20261114-review');
  assert.ok((await loadBaselines(suite)).some(b=>b.id==='20261114-revision-batch'));
  assert.equal(suite.metric_baselines['20261114-review'].summary.first_program.passed,34);
  assert.equal(suite.metric_baselines['20261114-revision-batch'].summary.first_program.passed,32);
});

test('8192配置显式保留v1规则并以上一轮检查优化结果为主参考', async () => {
  const {validateSuite,loadBaselines}=await import('../../tools/harness-eval/benchmark.mjs');
  const old=await validateSuite(),current=await validateSuite('revision-batch-8192');
  assert.equal(old.protocol.controller_max_tokens,4096);
  assert.equal(current.protocol.controller_max_tokens,8192);
  assert.equal(current.protocol.page_max_tokens,12000);
  assert.equal(current.reference_protocol_hash,old.protocol_hash);
  assert.notEqual(current.protocol_hash,old.protocol_hash);
  assert.equal(current.protocol.primary_baseline,'20261114-review');
  assert.deepEqual(current.fixtures,old.fixtures);
  const baselines=await loadBaselines(current),primary=baselines.find(b=>b.id==='20261114-review');
  assert.equal(primary.cases.length,6);assert.equal(primary.cases.filter(c=>c.delivered&&c.pptx_pass).length,6);
});

test('8192免费计划明确显示输出上限与零供应商请求',()=>{
  const result=spawnSync(process.execPath,['--import','tsx/esm','tools/harness-eval/run.mjs','--profile','revision-batch-8192','--check'],{cwd:root,encoding:'utf8',env:{...process.env,OPENAI_API_KEY:''}});
  assert.equal(result.status,0,result.stderr);const plan=JSON.parse(result.stdout);
  assert.equal(plan.controller_max_tokens,8192);assert.equal(plan.primary_baseline,'20261114-review');assert.equal(plan.provider_requests,0);
});

test('免费校验仅计划六次当前版运行，不调用供应商', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', 'tools/harness-eval/run.mjs', '--check'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.planned_trials, 6);
  assert.deepEqual(plan.arms, ['current']);
  assert.equal(plan.provider_requests, 0);
  assert.equal(plan.primary_baseline, '20261113-after');
});

test('全流程速度与费用只比较双方已交付的相同案例', async () => {
  const { compareRuns } = await import('../../tools/harness-eval/benchmark.mjs');
  const baseline = { cases: [
    { case_id: 'product', delivered: true, pptx_pass: true, generation_ms: 100000, export_ms: 10000, calls: 4, prompt_tokens: 100, completion_tokens: 100, cache_hit_tokens: 0 },
    { case_id: 'brand', delivered: false, generation_ms: 1000, export_ms: null, calls: 1, prompt_tokens: 100, completion_tokens: 100, cache_hit_tokens: 0 },
  ] };
  const current = { cases: [
    { case_id: 'product', delivered: true, pptx_pass: true, generation_ms: 80000, export_ms: 5000, calls: 2, prompt_tokens: 50, completion_tokens: 50, cache_hit_tokens: 0 },
    { case_id: 'brand', delivered: true, generation_ms: 300000, export_ms: 5000, calls: 8, prompt_tokens: 400, completion_tokens: 400, cache_hit_tokens: 0 },
  ] };
  const result = compareRuns(baseline, current);
  assert.deepEqual(result.paired_case_ids, ['product']);
  assert.equal(result.before.generation_mean_s, 100);
  assert.equal(result.after.generation_mean_s, 80);
  assert.equal(result.before.generation_export_mean_s, 110);
  assert.equal(result.after.generation_export_mean_s, 85);
  assert.equal(result.before.cost_peak_cny, 0.001);
  assert.equal(result.after.cost_peak_cny, 0.0005);
  assert.equal(result.before.calls, 4);
  assert.equal(result.after.calls, 2);
});

test('真实运行未明确预算时拒绝启动', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', 'tools/harness-eval/run.mjs', '--run'], {
    cwd: root, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /真实运行必须明确提供 --budget-cny/);
});

test('生成加导出的比较排除只有一方导出成功的案例', async () => {
  const { compareRuns } = await import('../../tools/harness-eval/benchmark.mjs');
  const baseline = {cases:[
    {case_id:'product',delivered:true,pptx_pass:true,generation_ms:100000,export_ms:10000},
    {case_id:'brand',delivered:true,pptx_pass:false,generation_ms:200000,export_ms:null},
  ]};
  const current = {cases:[
    {case_id:'product',delivered:true,pptx_pass:true,generation_ms:80000,export_ms:5000},
    {case_id:'brand',delivered:true,pptx_pass:true,generation_ms:400000,export_ms:100000},
  ]};
  const result=compareRuns(baseline,current);
  assert.deepEqual(result.paired_case_ids,['product','brand']);
  assert.deepEqual(result.export_paired_case_ids,['product']);
  assert.equal(result.before.generation_export_mean_s,110);
  assert.equal(result.after.generation_export_mean_s,85);
});
