// 只读取正式测评；新增独立基线、指标和配置，不覆盖已有文件。
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {here,root,hash,normalizeRun,summarizeCases} from '../../tools/harness-eval/benchmark.mjs';
import {summarizePageMetrics} from '../../tools/harness-eval/page-metrics.mjs';
const run='.eval-results/harness/v4-concurrency-3/20261115T140047040Z';
const metaBytes=await readFile(path.join(root,run,'metadata.json')),ledgerBytes=await readFile(path.join(root,run,'model-ledger.json'));
const meta=JSON.parse(metaBytes),ledger=JSON.parse(ledgerBytes),id='20261115-page-concurrency-3';
const origin={run,metadata_sha256:hash(metaBytes),ledger_sha256:hash(ledgerBytes)};
const baseline={...normalizeRun(meta,ledger.calls,'current',id,meta.protocol_hash),page_concurrency:3,source:origin};
const bytes=Buffer.from(JSON.stringify(baseline,null,2)+'\n');
await writeFile(path.join(here,'baselines',id+'.json'),bytes,{flag:'wx'});
const metrics=JSON.parse(await readFile(path.join(here,'metrics-baselines-concurrency-3.json'),'utf8'));
metrics[id]={...origin,cases:meta.records.map(r=>({case_id:r.case_id,...r.page_metrics})),summary:summarizePageMetrics(meta.records.map(r=>r.page_metrics))};
const metricBytes=Buffer.from(JSON.stringify(metrics,null,2)+'\n');
await writeFile(path.join(here,'metrics-baselines-context-status.json'),metricBytes,{flag:'wx'});
const prior=JSON.parse(await readFile(path.join(here,'profiles/page-concurrency-3.json'),'utf8'));
const profile={...prior,id:'harness-six-scenes-v5-context-status',context_version:2,primary_baseline:id,baseline_sha256:hash(bytes),baseline_protocol_hash:meta.protocol_hash,
  result_family:'v5-context-status',metrics_file:'metrics-baselines-context-status.json',metrics_sha256:hash(metricBytes),
  additional_baselines:[{id:prior.primary_baseline,sha256:prior.baseline_sha256,protocol_hash:prior.baseline_protocol_hash},...prior.additional_baselines]};
await writeFile(path.join(here,'profiles/context-status-v1.json'),JSON.stringify(profile,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({baseline:id,cache:summarizeCases(baseline.cases).cache},null,2));
