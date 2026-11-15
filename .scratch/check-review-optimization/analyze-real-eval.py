"""Read-only counters for optimization 1, using original requests and receipts."""
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

root=Path(__file__).resolve().parents[2]
out=Path(sys.argv[1]).resolve()
old=root/'.scratch/reading-batch-ab/20261113/results'
load=lambda p:json.loads(p.read_text(encoding='utf-8'))

def analyze(folder,arm):
    meta=load(folder/'metadata.json')
    calls=[c for c in load(folder/'model-ledger.json')['calls'] if c['trial'].endswith('-'+arm)]
    first=Counter();judgments=Counter();private=Counter();image_calls=0;images=0
    for call in calls:
        if call['status']!='completed' or call['kind']!='controller':continue
        request=load(folder/f"request-{call['id']}.json")
        for message in request.get('messages',[]):
            private.update(k for k in message if k.startswith('_'))
        images+=call.get('images',0)
        image_calls+=bool(call.get('images'))
        tools=load(folder/f"response-{call['id']}.json")['choices'][0]['message'].get('tool_calls',[])
        if tools:
            function=tools[0]['function'];first[function['name']]+=1
            if function['name']=='record_assessment':
                args=json.loads(function['arguments'])
                judgments[args.get('kind','unknown')]+=1
    records=[r for r in meta['records'] if r['arm']==arm]
    automatic=Counter()
    repairs=0
    for record in records:
        for key,operation in record.get('raw_job',{}).get('agent',{}).get('operations',{}).items():
            if operation['status']!='completed':continue
            result=operation.get('result',{})
            repairs+=bool(result.get('repair') and result.get('page_id'))
            if ':auto-' in key:
                if result.get('completed'):automatic['finish']+=1
                elif result.get('evidence_id'):automatic['inspect']+=1
                elif result.get('download_url'):automatic['export']+=1
    return {'records':len(records),'delivered':sum(bool(r.get('delivery_success')) for r in records),
        'controller_calls':sum(c['kind']=='controller' for c in calls),
        'page_calls':sum(c['kind']=='page' for c in calls),
        'first_tools':dict(first),'assessment_kinds':dict(judgments),
        'inspection_and_finish_decisions':first['inspect_deck']+first['finish_deck'],
        'check_related_decisions':first['inspect_deck']+first['record_assessment']+first['finish_deck'],
        'automatic_completed_tools':dict(automatic),'completed_repairs':repairs,
        'controller_image_calls':image_calls,'controller_images':images,'private_fields_sent':dict(private)}

before=analyze(old,'after');after=analyze(out,'current')
meta=load(out/'metadata.json');ledger=load(out/'model-ledger.json')
accounting=[]
for record in meta['records']:
    calls=[c for c in ledger['calls'] if c['trial']==record['id']]
    settled=sum(c.get('cost_peak_cny',0) for c in calls)
    native=record.get('raw_job',{}).get('agent',{}).get('budget',{}).get('spent_cny')
    accounting.append({'id':record['id'],'settled_cny':settled,'native_cny':native,
        'match':native is not None and abs(settled-native)<1e-8,
        'within_2_cny':sum(c.get('cost_peak_cny',c.get('reserved_cny',0)) for c in calls)<=2})
drift=[]
for item in load(out/'source-manifest.json'):
    path=root/item['file']
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest()!=item['sha256']:
        drift.append(item['file'])
protocol=root/'tools/harness-eval/suite-v1.json'
audit={'run_finished':meta['status']=='finished','six_cases_recorded':len(meta['records'])==6 and all(r.get('finished_at') for r in meta['records']),
    'all_supplier_calls_settled':all(c['status']=='completed' for c in ledger['calls']),
    'within_15_cny':sum(c.get('cost_peak_cny',c.get('reserved_cny',0)) for c in ledger['calls'])<=15,
    'no_runtime_source_drift':not drift,
    'same_protocol':hashlib.sha256(protocol.read_bytes()).hexdigest()==meta['protocol_hash'],
    'all_task_budgets_within_2_cny':all(r['within_2_cny'] for r in accounting),
    'native_accounting_matches':all(r['match'] for r in accounting),
    'no_private_fields_sent':not after['private_fields_sent'],
    'delivered_pptx_pass':all(r.get('export',{}).get('pass') for r in meta['records'] if r.get('delivery_success'))}
result={'before':before,'after':after,'audit':audit,'audit_status':'PASS' if all(audit.values()) else 'INCOMPLETE_OR_FAILED',
    'accounting':accounting,
    'source_drift':drift,'supplier_requests':len(ledger['calls']),
    'cost_peak_cny':sum(c.get('cost_peak_cny',c.get('reserved_cny',0)) for c in ledger['calls']),
    'cost_time_cache_cny':sum(c.get('cost_time_cache_cny',0) for c in ledger['calls'])}
(out/'optimization-1.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
lines=['# 优化1：检查调度专项统计','','比较主基线20261113-after与当前记录；不重跑旧版，不修改评分。','',
    '| 指标 | 主基线 | 本轮 |','|---|---:|---:|']
for title,a,b in [
    ('总控模型请求',before['controller_calls'],after['controller_calls']),
    ('模型选择inspect_deck',before['first_tools'].get('inspect_deck',0),after['first_tools'].get('inspect_deck',0)),
    ('模型提交评审',before['first_tools'].get('record_assessment',0),after['first_tools'].get('record_assessment',0)),
    ('其中内容／视觉',str(before['assessment_kinds'].get('content',0))+'/'+str(before['assessment_kinds'].get('visual',0)),str(after['assessment_kinds'].get('content',0))+'/'+str(after['assessment_kinds'].get('visual',0))),
    ('模型选择finish_deck',before['first_tools'].get('finish_deck',0),after['first_tools'].get('finish_deck',0)),
    ('取证及收尾调度决策合计',before['inspection_and_finish_decisions'],after['inspection_and_finish_decisions']),
    ('检查相关决策合计（含评审）',before['check_related_decisions'],after['check_related_decisions']),
    ('页面模型请求（含修订）',before['page_calls'],after['page_calls']),
    ('有回执的修订操作',before['completed_repairs'],after['completed_repairs']),
    ('模型查看的截图总张次',before['controller_images'],after['controller_images']),
]:
    lines.append(f'| {title} | {a} | {b} |')
lines+=['','本轮已完成的自动工具回执：'+json.dumps(after['automatic_completed_tools'],ensure_ascii=False)+'。',
    '', '## 解释边界','',
    '- 以每个总控响应的第一个工具归类，额外未执行的工具提议不计作实际调度决策。这里只解释请求结构；自动程序取证仍然发生，并未删除必要检查。',
    '- 内容和视觉判断仍由模型完成；评审提交次数变化不等于检查质量变化。页面修订次数受输出和评审波动影响，不能全部归因于调度。',
    '- 完整耗时、费用、成功配对子集与程序评分见报告.md和summary.json。模型请求等待累计不等于用户墙钟等待，页面调用存在并发。',
    '- 这是跨日期历史基线比较，每例一轮，不宣称统计显著性、真实客户收益或通用事实准确率。',
    '- 2026-11-14为周末，实际时段估算使用空闲价；对比统一按固定高峰价重算，避免将折扣当成代码收益。报价来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/。',
    '- 审计PASS表示记录、预算、源码、协议和成功产物检查通过，不代表全部任务交付或人工视觉验收通过。','',
    '审计：'+result['audit_status']+'；'+json.dumps(audit,ensure_ascii=False)+'。']
(out/'优化1专项统计.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
