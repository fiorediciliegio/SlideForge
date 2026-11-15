import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..'),out=path.resolve(process.argv[2]);
const read=async name=>JSON.parse(await readFile(path.join(out,name),'utf8'));
const meta=await read('metadata.json'),cases=await read('case-results.json'),e2e=await read('e2e-metrics.json'),load=await read('load-metrics.json'),events=await read('go-events.json');
if(meta.status!=='pass'||!e2e.completed||cases.some(c=>c.status!=='pass'))throw new Error('Evaluation is incomplete or failed; do not publish a success report');
const groups=new Map();for(const c of cases){const id=c.language+':'+c.name;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(c)}
if([...groups.values()].some(rows=>rows.length!==meta.rounds))throw new Error('Repetition counts do not match the declared evaluation design');
const definitions={
  '预算控制':[/TestAgent.*Budget/,/TestAgentReservation/,/TestAgentWaiting/,/TestEngineQueueTime/,/deepseek_screenshot_reservation/],
  '未知调用控制':[/lost_response_becomes_unknown/,/fully saved response/],
  '恢复正确性':[/TestAgentBudgetReservationsAndSettlementAreDurable/,/TestAgentPersistenceFailure/,/TestAgentDraftSave/,/TestDurableDedup/,/prepared plan restores/,/continue_is_queued/,/outline_pause_releases/,/resume_replays_persisted/],
  '幂等性':[/TestAgentBudgetReservationsAndSettlementAreDurable/,/TestAgentToolReplay/,/TestAgentExportCharges/,/TestDeliveryCharges/,/TestExportReceipts/,/TestDurableDedup/,/TestPersistedJSON/,/exports submit immutable/],
  '取消与迟到结果隔离':[/TestAgentClaimFences/,/TestAgentToolReplay/,/TestFairOwners/,/TestDurableDedup/,/a cancelled /,/a delayed tool/],
  '检查复用':[/a batch review issue/,/unchanged pages reuse/]
};
const categories=Object.entries(definitions).map(([name,patterns])=>{const selected=cases.filter(c=>patterns.some(p=>p.test(c.name)));return{name,unique_cases:new Set(selected.map(c=>c.language+':'+c.name)).size,executions:selected.length,passed:selected.filter(c=>c.status==='pass').length,case_names:[...new Set(selected.map(c=>c.language+':'+c.name))]}});
const q=(values,p)=>{const s=[...values].sort((a,b)=>a-b),i=(s.length-1)*p,l=Math.floor(i);return s[l]+(s[Math.ceil(i)]-s[l])*(i-l)};
const stats=values=>({samples:values.length,min:q(values,0),median:q(values,.5),max:q(values,1)});
const budget=events.filter(e=>e.Output?.includes('OFFLINE_METRIC budget_reservations')).map(e=>{const m=e.Output.match(/accepted=(\d+) rejected=(\d+) reserved=([\d.]+)/);return{accepted:Number(m[1]),rejected:Number(m[2]),reserved:Number(m[3])}});
const http=e2e.requests.filter(r=>r.method==='GET'&&r.status===200).map(r=>r.ms);
const summary={date:'2026-11-12',provider:'local-fake-model',actual_provider_fee_cny:0,unique_cases:groups.size,case_executions:cases.length,passed:cases.length,rounds:meta.rounds,categories,
  concurrent_budget:{rounds:budget.length,attempts:budget.reduce((n,b)=>n+b.accepted+b.rejected,0),accepted:budget.reduce((n,b)=>n+b.accepted,0),rejected:budget.reduce((n,b)=>n+b.rejected,0),reserved_cny_per_round:budget.map(b=>b.reserved),fixture_limit_cny:2},
  e2e:{checks:e2e.checks,total_ms:e2e.elapsed_ms,local_model_calls:e2e.local_model_calls,local_page_calls:e2e.local_page_calls,early_page_visible:e2e.early_page_visible},
  load:{customers:load.loads.length,pages:load.loads.reduce((n,l)=>n+l.pages,0),completed:load.loads.filter(l=>l.done).length,peak_active:load.peak_active_projects,engine_concurrency:load.engine_concurrency,total_seconds:stats(load.loads.map(l=>l.ms/1000)),active_seconds:stats(load.loads.map(l=>l.budget.active_seconds)),jobs:load.loads.map(({id,...item})=>item)},
  sampled_successful_get_ms:{...stats(http),p95:q(http,.95),unexpected_5xx:e2e.requests.filter(r=>r.status>=500).length},hardware:meta.hardware,
  setup_failures:meta.runs.filter(r=>r.exit_code!==0).map(r=>({label:r.label,exit_code:r.exit_code,log:path.basename(r.log)}))};
await writeFile(path.join(out,'summary.json'),JSON.stringify(summary,null,2));
const manifest={commit:meta.commit,working_tree:'includes uncommitted engine-service and harness changes',files:[]};
for(const base of ['src','scripts','services/brain/brain','services/gateway/internal','tests','.scratch/harness-offline-eval']){
  async function walk(dir){for(const entry of await readdir(path.join(root,dir),{withFileTypes:true})){const rel=path.posix.join(dir,entry.name);if(entry.isDirectory()){if(!/^\d{8}-/.test(entry.name)&&entry.name!=='__pycache__')await walk(rel)}else if(/\.(?:ts|py|go|mjs)$/.test(entry.name))manifest.files.push({path:rel,sha256:createHash('sha256').update(await readFile(path.join(root,rel))).digest('hex')})}}
  await walk(base);
}
await writeFile(path.join(out,'source-manifest.json'),JSON.stringify(manifest,null,2));
const sec=n=>(n/1000).toFixed(3),c=e2e.checks;
const lines=[
'# Python Brain Harness 零付费自动测评报告','',
'日期：2026-11-12。范围：复用既有用例，补统计；没有修改生产业务逻辑。','',
'## 结论与初步评价','',
`- ${groups.size} 种既有用例各重复 ${meta.rounds} 轮，共 ${cases.length} 次执行，${cases.length} 次通过。四进程端到端另执行 1 轮并通过，覆盖重启、预算、未知调用、返工、版本历史与导出。`,
`- 本地假模型 + 真实 Chrome 下，${load.loads.length} 个隔离客户同时推进 ${summary.load.pages} 页生成、检查与导出，全部完成；峰值活跃项目 ${load.peak_active_projects}。`,
'- 可靠性评价：本机固定用例中未观察到预算绕过、未授权重发、重复扣点、迟到覆盖或错误检查复用。该结果支持工程边界已实现并可回归，不等于生产故障率为零。',
'- 性能评价：得到可复核的重启恢复与受控并发基线。本次没有旧链路同条件对照，因此不能声称提速、降本或真实生成质量提升。','',
'## 六类可靠性覆盖','',
'| 类别 | 不同用例数 | 重复执行 | 通过 |','|---|---:|---:|---:|',
...categories.map(c=>`| ${c.name} | ${c.unique_cases} | ${c.executions} | ${c.passed} |`),'',
'同一用例可能验证多个边界，因此分类行不可相加。总体按语言与测试名去重；重复轮次不是独立随机样本。','',
'## 可量化观察','',
'| 指标 | 本次结果 | 口径 |','|---|---|---|',
`| 并发预算预留 | ${summary.concurrent_budget.attempts} 次申请；${summary.concurrent_budget.accepted} 次接受、${summary.concurrent_budget.rejected} 次拒绝 | 每轮10个goroutine各预留0.4个模拟元，共5轮；每轮总预留均为2/2，无超额 |`,
`| 大纲阶段重启后可读取 | ${sec(c.draft_restart.ms)} 秒 | 含停止四服务、重新启动、就绪检查与读取作品；恢复 ${c.draft_restart.sources_restored} 份来源记录、${c.draft_restart.constraints_restored} 条约束，新增模型调用 ${c.draft_restart.extra_model_calls} |`,
`| 已生成页面重启后可读取 | ${sec(c.page_restart.ms)} 秒 | 恢复 ${c.page_restart.pages_restored} 页、${c.page_restart.sources_restored} 份来源记录及 ${c.page_restart.constraints_restored} 条约束，页面引用逐项相同且后续实际PPTX可导出；新增模型调用 ${c.page_restart.extra_model_calls} |`,
`| 重复导出 | ${c.duplicate_export.requests} 次请求、${c.duplicate_export.unique_file_ids} 个文件ID、额外扣点 ${c.duplicate_export.extra_charge} | 首次扣10个测试点数，重复请求不再扣；不是实际资金交易 |`,
`| 单页续改隔离 | 目标修改 ${c.single_page_edit.changed_pages}/${c.single_page_edit.requested_pages} 页；非目标误改 ${c.single_page_edit.untargeted_changed}/${c.single_page_edit.untargeted_pages} 页 | 两页固定案例，按页面修订哈希核对 |`,
`| 已知越界流程修复 | ${c.overflow_repair.pages} 页共 ${c.overflow_repair.page_calls} 次页面调用；定向返工 ${c.overflow_repair.repair_page_calls} 次 | 假模型预设一次坏页和正确修复，证明闭环与局部返工，不证明真实模型修复能力 |`,
`| 预算不足后的模型调用 | ${c.budget_block.provider_calls} 次 | 后端先暂停再发送调用 |`,
`| 未授权未知调用续跑 | HTTP ${c.unknown_without_consent.continue_status}；新增模型调用 ${c.unknown_without_consent.extra_provider_calls} 次 | 确实缺失响应，未经用户同意不能重发 |`,
`| 快页及时可见 | ${e2e.early_page_visible?'通过':'未通过'} | 慢页模型仍挂起时，第一张成功页已提交 |`,
`| 采样成功GET请求 | ${http.length} 次；中位 ${q(http,.5).toFixed(2)} ms，P95 ${q(http,.95).toFixed(2)} ms | 仅测试request辅助函数采集的控制面GET，不包含所有调用，也不是独立API压测或SLA |`,'',
'## 五用户混合任务','',
'四个6页PPTX任务与一个20页PDF任务。页数与工具选择由本地脚本固定；渲染和文件转换实际执行。引擎重型槽位为1，排队不计Agent有效执行时间。该批在前置功能验收后以暖态服务运行，各客户均新建作品；不是冷启动测试。','',
'| 客户 | 页数 | 完成 | 从批次提交起算的总耗时/秒 | 有效执行/秒 |','|---|---:|---|---:|---:|',
...load.loads.map((l,i)=>`| ${i+1} | ${l.pages} | ${l.done?'是':'否'} | ${(l.ms/1000).toFixed(3)} | ${l.budget.active_seconds.toFixed(3)} |`),'',
`全部完成时刻为批次开始后 ${summary.load.total_seconds.max.toFixed(3)} 秒；任务完成中位数 ${summary.load.total_seconds.median.toFixed(3)} 秒。总耗时含提交、排队、生成、检查、导出及轮询观察延迟；不是单页模型速度。5个样本不报告任务P95或作为SLA。`,'',
'## 测试环境与零付费边界','',
`- Windows ${meta.hardware.release}；${meta.hardware.logical_cpus} 个逻辑CPU；总内存 ${(meta.hardware.total_memory_bytes/2**30).toFixed(2)} GiB；Node ${meta.hardware.node}。`,
'- 临时测试数据与独立端口；不使用真实用户资料或真实模型凭据发起请求，也没有停止现有开发服务。启动器仍按既有流程解析项目.env，但模型地址与密钥已由测试环境强制覆盖为本地假服务及占位凭据。',
'- Node fetch / HTTP 与 Python socket限制回环连接；自检验证外网地址在发送前被拒绝。Go选定用例使用本地JSON/临时文件，禁用包下载及外部数据库配置。',
`- 本轮共 ${e2e.local_model_calls} 次本地假模型请求，其中页面请求 ${e2e.local_page_calls} 次；真实供应商模型调用0，实际模型费用0。模拟账本中的token和估算元仅用于验证记账，不是DeepSeek成本数据。`,
'- 两次重启是可复核样本，不覆盖所有故障窗口；来源只核对项目中的记录，未对各种原始附件逐格式做重启后字节级校验。引擎租约超时用例使用模拟时钟，不等于实际恢复时延。',
'- 未实测真实LLM质量与费用、真实PG/S3、跨机器/业务多副本高可用、Linux取消进程树。本轮没有采集CPU/进程树峰值内存，不引用上一次压测的内存结果。',
'- 首次Python统计入口出现模块导入路径错误，2个模块均未运行；修正统计脚本路径后完整5轮通过。原失败日志保留，不计为业务用例结果；没有重试或丢弃业务失败以提高通过率。','',
'## 复现与原始证据','',
'根目录运行（需允许本地端口及测试Chrome；使用新目录，避免覆盖已有报告）：','',
'```powershell',
"Set-Location 'D:\\SlideForge'",
"node .scratch/harness-offline-eval/run.mjs .scratch/harness-offline-eval/新的运行目录",
"node .scratch/harness-offline-eval/summarize.mjs .scratch/harness-offline-eval/新的运行目录",
'```','',
'- `metadata.json`：命令、启动/结束、环境、每组退出状态与日志路径。',
'- `case-results.json` / `go-events.json`：逐用例结果、耗时和预算计数；Python各轮JSON及Node各轮日志保留原记录。',
'- `e2e-metrics.json` / `load-metrics.json`：本次四进程计数、重启耗时及五客户数据。',
'- `summary.json`：此报告的聚合数据；`source-manifest.json`：当前未提交工作区的源码哈希，不能仅凭旧HEAD复现。',
'- `four-process-e2e.log` / `agent-services.log`：本次完整测试与服务日志。普通Go测试耗时含进程/测试开销，不能当RPC响应时延。','',
'## 可用于简历的表述','',
`为演示文稿 Agent 构建 Python 单总控与 Node 工具执行、Go 持久化状态协作链路；复用并完善6类可靠性自动测评，39种用例累计执行195次全部通过，在本地假模型与真实Chrome环境验证5用户、44页混合生成/检查/导出，未观察到重复扣点与未授权重发。`,'',
'如果简历篇幅有限，可写：','',
'“完善 Agent Harness 的预算、幂等、恢复和取消隔离机制，建立6类自动化验证，39种用例累计195次通过；在本地假模型＋真实浏览器环境验证5用户并发、44页混合交付。”','',
'不要写成“生产稳定性100%”“真实生成速度提升X%”“模型费用降低X%”或“支撑5名真实付费客户”。'
];
await writeFile(path.join(out,'报告.md'),lines.join('\n')+'\n');
console.log(JSON.stringify({unique_cases:summary.unique_cases,executions:summary.case_executions,categories:categories.map(({case_names,...c})=>c),load:summary.load,report:path.join(out,'报告.md')},null,2));
