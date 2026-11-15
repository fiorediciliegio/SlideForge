import hashlib
import json
import re
from pathlib import Path

root=Path(__file__).resolve().parents[2]
here=Path(__file__).resolve().parent
out=here/'20261112-readonly'
meta=json.loads((out/'metadata.json').read_text(encoding='utf-8'))
ledger=json.loads((out/'model-ledger.json').read_text(encoding='utf-8'))
assert meta['status']=='pass' and len(meta['cases'])==3
assert ledger['limit_cny']==1 and len(ledger['calls'])==7
assert all(c['status']=='completed' for c in ledger['calls'])
assert meta['cost_peak_cny']<1
origins=0
for case in meta['cases']:
    assert case['project_unchanged'] and case['html_unchanged'] and case['current_read_versions']
    assert case['status']=='pass'
    compact=re.sub(r'\s+','',case['summary'])
    for value in ['17支','426张','19分钟','3小时']:
        assert re.search(r'(?<![\d.+\-])'+re.escape(value),compact)
    for call in case['job']['agent']['calls'].values():
        result=json.loads((root/'artifacts/decks'/case['deck_id']/call['response_ref']).read_text(encoding='utf-8'))
        assert result['_project_revision_id']==case['revision_id'];origins+=1
    assert abs(case['job']['agent']['budget']['spent_cny']-sum(c['cost_peak_cny'] for c in case['calls']))<1e-8
for call in ledger['calls']:
    request=json.loads((out/f"request-{call['id']}.json").read_text(encoding='utf-8'))
    assert all('_read_revision_id' not in message for message in request['messages'])
events=[json.loads(line) for line in (out/'readonly-tools.jsonl').read_text(encoding='utf-8').splitlines()]
assert all(e['name'] in ['_describe','read_project','request_user'] for e in events)
summary={'status':'PASS','cases':3,'model_requests':7,'unknown_requests':0,'numeric_unit_checks':12,'project_and_html_unchanged':3,'response_origin_revision_checks':origins,'provider_private_metadata_leaks':0,'total_cost_peak_cny':meta['cost_peak_cny'],'total_cost_time_cache_cny':sum(c['cost_time_cache_cny'] for c in ledger['calls']),'budget_limit_cny':1,'case_results':[{k:c[k] for k in ['id','status','elapsed_seconds','covered_sections','multi_tool_turns','summary_history_hit','current_read_versions']}|{'model_calls':len(c['calls'])} for c in meta['cases']]}
(out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
files=['services/brain/brain/harness.py','services/brain/brain/agent_tools.py','services/brain/brain/models.py','src/capabilities/agent.ts','services/brain/tests/test_harness.py','services/brain/tests/test_agent_models.py','tests/capabilities/agentRecoveryBoundaries.test.ts','CHANGELOG.md']
snapshot=out/'implementation-snapshot';snapshot.mkdir(exist_ok=True)
manifest=[]
for name in files:
    data=(root/name).read_bytes();dest=snapshot/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
    manifest.append({'file':name,'sha256':hashlib.sha256(data).hexdigest()})
(out/'implementation-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
report='''# 页面与历史读取批次验收

## 已交付

- 资料正文、当前页面、页面历史可在同回合混合最多4项，顺序执行；单次page_ids原有1–20能力保留。context/索引与生成、修改、检查、导出不加入批次。
- 当前页面返回完整HTML，历史返回版本号、修改指令与时间，不含历史HTML。missing_pages明确指出未生成/找不到的ID，同时保留成功内容；已删除页面仍可查询有效历史。
- 结果携带revision_id，已完成回执不得冒充新版本结果；暂停后改版再恢复时停止旧读取批次，旧结果留存并标版本，模型获得当前上下文并重新读取。取消、预算暂停、epoch隔离、普通错误回执沿用原机制。
- 模型决策的输入修订在请求前捕获、随响应artifact保存；响应已经结算但assistant消息检查点尚未提交时崩溃，重放仍保留原版本，不会重新标为当前版。私有修订字段不发送供应商。
- 提示词、测试与CHANGELOG同步更新；没有修改.env、Go数据协议、独立引擎或原始测评产物。

## 零付费验证

- Python新增批次/版本/模型回执窗口窄测试先复现后修复；独立审查发现并复核了“模型回执已保存但消息未提交”的版本窗口，最终无阻塞项。
- `python -X utf8 -m unittest discover -s tests -v`：41项通过，含22项Harness与5项模型控制测试。最终输出见../python-tests-final.log。
- `npm.cmd run check`：通过；`npm.cmd run test:core`：70通过、6按原条件跳过、0失败，见../check.log、../core-tests.log。
- Node版本/缺失/历史/错误回执与原有隔离定向测试12项通过。期间1个断言按JSON省略undefined字段的规则校正，没有为此调整业务行为。

## 真实模型只读验收

共3个案例共享新增估算上限1元，使用此前虚拟产品演示中选取的两页HTML及虚构资料。为每例创建独立副本、两次虚构版本记录；不写回原作品。验收时工具声明及执行守卫仅允许read_project与request_user（后者仅保存核验摘要并暂停）。使用deepseek-flash，未额外运行原全量A/B或生成PPTX。

| 案例 | 总模型请求 | 用时（秒） | 同回合读取表现 | 结果 |
|---|---:|---:|---|---|
'''
names={'cross-page':'跨页','page-history':'页面＋历史','mixed-source-page-history':'资料＋页面＋历史'}
for c in meta['cases']:
    maximum=max((len(call.get('tool_names',[])) for call in c['calls'] if any(n=='read_project' for n in call.get('tool_names',[]))),default=0)
    report+=f"| {names[c['id']]} | {len(c['calls'])} | {c['elapsed_seconds']:.2f} | 峰值{maximum}项 | 通过 |\n"
report+=f'''
全部摘要的4项数值单位核验合计12/12，要求引用最新历史的2例均命中原文；3例的项目修订与HTML哈希未变，7个模型响应原始修订均与对应项目一致，供应商请求中私有元数据泄漏0。执行工具未超出只读白名单，没有生成、修改或导出工具执行。

共7次真实模型请求，无未知结果或额外重跑。保守高峰未命中估算¥{summary['total_cost_peak_cny']:.6f}/¥1；按时段和缓存估算¥{summary['total_cost_time_cache_cny']:.6f}。未核对供应商账单，不称为实扣。[价格依据](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，沿用2026-11-12核对值。

## 解释边界

- 这是三类只读接入验收，每例1次，不是生成速度或审美A/B；不能据此宣称完整PPT流程提速。
- 跨页例使用一次page_ids数组读两页，随后模型自主追加资料比对，未强求所有读取同回合；后两例实际出现2项、3项同回合读取。批内本地顺序执行，没有增加线程/浏览器并发。
- 原HTML来自6页作品的第3、4页，构造2页只读副本时保留原HTML页码。模型指出页脚“3/6、4/6”与副本2页元数据不同，这是验收副本的已知特征；没有自动修改，也不作为原作品的生成缺陷。
- 版本变化、取消、缺失ID、错误回执及进程恢复通过零付费用例验证；真实模型案例没有故障注入或修改项目。
- 数值/单位出现及历史原文引用是窄自动规则，不等同全部事实准确性或人工语义评审。

## 修改文件

'''
report+='\n'.join('- '+name for name in files)
report+='''

## 证据

- metadata.json：每例原始job、回执、摘要、用量与不变性检查。
- summary.json：可机读汇总；model-ledger.json与request/response文件：预算与供应商请求，未保存API Key。
- readonly-tools.jsonl：实际执行白名单；implementation-snapshot/和implementation-manifest.json：最终实现快照与SHA256。
- ../before/：本轮修改前的Harness、提示词和Node读取工具；../方案.md：已确认范围。
'''
(out/'报告.md').write_text(report,encoding='utf-8')
print(json.dumps(summary,ensure_ascii=False,indent=2))
