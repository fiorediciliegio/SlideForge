import hashlib
import json
import shutil
from pathlib import Path

root=Path(__file__).resolve().parents[2]
out=Path(__file__).resolve().parent/'20261112-outline-ab'
records={arm:json.loads((out/arm/'record.json').read_text(encoding='utf-8')) for arm in ['before','after']}
ledger=json.loads((out/'model-ledger.json').read_text(encoding='utf-8'))
summary={}
for arm,r in records.items():
    assert r['status']=='pass' and r['phase']=='waiting_outline' and r['full_source_equal']
    assert len(r['reads'])==4 and len(r['project']['outline']['pages'])==6
    assert all(f['value_unit_present'] for f in r['outline_facts'])
    calls=r['calls'];source_decisions=0
    for call in calls:
        response=json.loads((out/f"response-{call['id']}.json").read_text(encoding='utf-8'))
        selected=response['choices'][0]['message'].get('tool_calls',[])
        if any(t['function']['name']=='read_project' and json.loads(t['function']['arguments']).get('section')=='sources' and json.loads(t['function']['arguments']).get('source_id') for t in selected):source_decisions+=1
    assert abs(r['cost_peak_cny']-r['raw_job']['agent']['budget']['spent_cny'])<1e-8
    summary[arm]={'source_decisions':source_decisions,'model_calls':len(calls),'read_results':len(r['reads']),'source_chars':sum(len(p['text']) for p in r['reads']),'full_source_equal':r['full_source_equal'],'outline_value_unit_hits':sum(f['value_unit_present'] for f in r['outline_facts']),'elapsed_seconds':r['elapsed_ms']/1000,'input_tokens':sum(c['usage']['prompt_tokens'] for c in calls),'output_tokens':sum(c['usage']['completion_tokens'] for c in calls),'cost_peak_cny':r['cost_peak_cny'],'cost_time_cache_cny':sum(c['cost_time_cache_cny'] for c in calls)}
assert [r['text'] for r in records['before']['reads']]==[r['text'] for r in records['after']['reads']]
assert len(ledger['calls'])==8 and all(c['status']=='completed' for c in ledger['calls'])
assert ledger['limit_cny']==2 and sum(c['cost_peak_cny'] for c in ledger['calls'])<2
summary['total_cost_peak_cny']=sum(c['cost_peak_cny'] for c in ledger['calls'])
summary['total_cost_time_cache_cny']=sum(c['cost_time_cache_cny'] for c in ledger['calls'])
summary['paid_trials']=2;summary['actual_provider_requests']=8;summary['unknown_requests']=0
a,b=summary['before'],summary['after']
summary['reductions_percent']={k:(a[k]-b[k])/a[k]*100 for k in ['source_decisions','model_calls','elapsed_seconds','input_tokens','cost_peak_cny','cost_time_cache_cny']}
(out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
snapshot=out/'implementation-snapshot';snapshot.mkdir(exist_ok=True)
files=['services/brain/brain/harness.py','services/brain/brain/agent_tools.py','src/capabilities/agent.ts','services/brain/tests/test_harness.py','tests/capabilities/agentRecoveryBoundaries.test.ts','CHANGELOG.md']
manifest=[]
for name in files:
    data=(root/name).read_bytes();dest=snapshot/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
    manifest.append({'file':name,'sha256':hashlib.sha256(data).hexdigest()})
(out/'implementation-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
report=f'''# 资料分块批量读取：实现与定向对照

## 本轮修改

- Python Harness仅允许全部为明确来源的正文读取组成批次，每批最多4项，单项4000字符上限不变；本地顺序执行，不增加线程或浏览器并发。超限整批报错，混合调用沿用原单工具规则。
- 逐项保存工具消息；恢复识别半批次，并保持原call ID。已有成功/明确失败结果跳过；服务故障、取消、预算暂停和epoch失效停止剩余读取。
- Node沿用原begin_tool/complete_tool及指纹边界，保存普通参数错误和资料不存在的错误回执，封闭“错误已返回、消息检查点未提交”的恢复窗口。文件存储及服务异常继续抛出。
- 同步提示词、窄测试与CHANGELOG。页面/历史、生成、视觉检查和导出未扩展到多工具回合，没有更改.env。

## 验证

- 原实现下新增批次测试6项按预期失败；错误回执窄测试2项也先复现后修复。
- Python：`python -X utf8 -m unittest discover -s tests -v`，33项通过，其中Harness15项（含11个新增批次/恢复用例）。
- Node：`npm.cmd run check`通过；`npm.cmd run test:core`，65通过、6按原条件跳过、0失败。错误回执及隔离定向测试7通过。
- 离线回放已保存的response-190：四块读取由4次决策合并为1次，15409字符逐块相同、原工具ID保留、外部模型请求0次。详见replay.json。
- 预算代理2项本地检查通过：跨两次运行共享2元、预留不足不发请求、未知请求不自动重发。
- 独立代码审查发现并复核修复了错误回执窗口，最终无阻塞意见。没有执行Git提交或修改其他历史WIP。

## 真实模型单次对照

使用同一份虚拟长资料、同一模板、deepseek-flash、固定6页与先确认大纲模式。改前在改动业务代码前执行，改后在代码审查通过后执行；仅各1次，不生成页面或PPTX。计时从创建请求至观察到waiting_outline（约0.5秒轮询），不含服务启动。

| 指标 | 改前单工具 | 改后资料批次 |
|---|---:|---:|
| 资料读取决策次数 | {a['source_decisions']} | {b['source_decisions']} |
| 读取至大纲总模型调用 | {a['model_calls']} | {b['model_calls']} |
| 实际资料块读取回执 | {a['read_results']} | {b['read_results']} |
| 已读取字符及正文一致性 | {a['source_chars']}，相同 | {b['source_chars']}，相同 |
| 大纲核验数值及单位出现 | {a['outline_value_unit_hits']}/6 | {b['outline_value_unit_hits']}/6 |
| 耗时（秒） | {a['elapsed_seconds']:.2f} | {b['elapsed_seconds']:.2f} |
| 输入token | {a['input_tokens']} | {b['input_tokens']} |
| 输出token | {a['output_tokens']} | {b['output_tokens']} |
| 保守高峰未命中估算（元） | {a['cost_peak_cny']:.6f} | {b['cost_peak_cny']:.6f} |
| 按时段及缓存估算（元） | {a['cost_time_cache_cny']:.6f} | {b['cost_time_cache_cny']:.6f} |

两次合计保守估算{summary['total_cost_peak_cny']:.6f}/2元，按时段与缓存约{summary['total_cost_time_cache_cny']:.6f}元；实际供应商账单未核对。8个真实请求全部有usage结算，没有未知结果、额外重试或预算追加。

## 初步结论和边界

- 本次读取决策减少75%，读取至大纲总调用减少66.7%，耗时下降{summary['reductions_percent']['elapsed_seconds']:.1f}%，输入token下降{summary['reductions_percent']['input_tokens']:.1f}%。
- 按时段及缓存估算费用下降{summary['reductions_percent']['cost_time_cache_cny']:.1f}%；统一高峰未命中口径下降{summary['reductions_percent']['cost_peak_cny']:.1f}%。两个口径分开报告，不把保守值当作账单实扣。
- 3次总控调用可直接对应四块读取合并。另少1次调用来自本次模型直接使用初始来源索引、未额外请求context；不能保证每次发生。
- 仅有1组前后对照，模型输出和服务时延可能波动；这是读取与大纲阶段结果，不能写成整个PPT生成提速43.9%。
- 大纲数值单位出现是自动规则，不代表全部语义/事实正确；没有重新测评成稿、视觉质量、导出、并发或真实客户材料。

报价沿用2026-11-12核对的[DeepSeek官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)；供应商缓存使实际估算费用节省小于未命中保守口径。

## 证据

- before/、after/record.json：来源回执、模型调用、usage、原始任务与大纲；同目录保存各次Harness和提示词快照。
- model-ledger.json与request/response文件：两次共享预算、原始供应商返回，不保存API Key。
- summary.json：可机读结果；replay.json：零付费日志回放。
- python-tests-final.log、core-tests-final.log、check-final.log：最终验证输出。
- implementation-snapshot/与implementation-manifest.json：最终业务代码与测试快照、SHA256。
'''
(out/'报告.md').write_text(report,encoding='utf-8')
print(json.dumps(summary,ensure_ascii=False,indent=2))
