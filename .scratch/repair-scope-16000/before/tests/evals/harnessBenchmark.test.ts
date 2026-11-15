import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

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
