"""Summarize the pre-registered reading-batch A/B, without re-scoring artifacts."""
import json
import statistics
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent / '20261113'
OUT = ROOT / 'results'
meta = json.loads((OUT / 'metadata.json').read_text(encoding='utf-8'))
ledger = json.loads((OUT / 'model-ledger.json').read_text(encoding='utf-8'))
fixtures = json.loads((ROOT.parents[1] / 'harness-real-eval/20261112-172000/fixtures.json').read_text(encoding='utf-8'))
records, calls = meta['records'], ledger['calls']
finished = [r for r in records if r.get('finished_at')]

def median(values):
    return statistics.median(values) if values else None

def change(a, b):
    return (b / a - 1) * 100 if a else None

def fmt(value, digits=2):
    return f'{value:.{digits}f}' if value is not None else '未采集'

def request_tools(call):
    response = OUT / f"response-{call['id']}.json"
    if not response.exists() or call['status'] != 'completed':
        return []
    return json.loads(response.read_text(encoding='utf-8')).get('choices', [{}])[0].get('message', {}).get('tool_calls', [])

def classify(tool):
    name = tool['function']['name']
    if name != 'read_project':
        return name
    try:
        args = json.loads(tool['function']['arguments'])
    except json.JSONDecodeError:
        return 'read_project:invalid'
    section = args.get('section', 'context')
    if section == 'sources':
        section += ':body' if args.get('source_id') else ':index'
    return 'read_project:' + section

def trial_stats(record):
    model = [c for c in calls if c['trial'] == record['id']]
    settled = [c for c in model if c['status'] == 'completed']
    observed = set()
    for call in model:
        request_file = OUT / f"request-{call['id']}.json"
        if request_file.exists():
            for message in json.loads(request_file.read_text(encoding='utf-8')).get('messages', []):
                if message.get('role') == 'tool':
                    answer=json.loads(message['content'])
                    if not answer.get('error'):
                        observed.add(message['tool_call_id'])
    selections, batch_turns, selected_reads, source_decisions = Counter(), [], [], []
    for call in settled:
        tools = request_tools(call)
        selections.update(classify(t) for t in tools)
        if tools and classify(tools[0])=='read_project:sources:body' and tools[0]['id'] in observed:
            source_decisions.append(call)
        if tools and all(classify(t) in ['read_project:sources:body', 'read_project:pages', 'read_project:history'] for t in tools):
            selected_reads.append({'call_id':call['id'], 'tools':len(tools), 'kinds':[classify(t) for t in tools]})
            if len(tools) > 1:
                batch_turns.append({'call_id':call['id'], 'tools':len(tools), 'observed_results':sum(t['id'] in observed for t in tools), 'kinds':[classify(t) for t in tools]})
    operations = list(record.get('raw_job', {}).get('agent', {}).get('operations', {}).values())
    receipts = [op.get('result', {}) for op in operations if op['status'] == 'completed']
    source_reads = [{k:result.get(k) for k in ['source_id', 'start', 'end', 'total']} for result in receipts if result.get('source_id') and isinstance(result.get('start'), (int, float))]
    source_coverage = {}
    for source in set(r['source_id'] for r in source_reads):
        spans = sorted((r['start'], r['end']) for r in source_reads if r['source_id'] == source)
        merged = []
        for lo, hi in spans:
            if merged and lo <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], hi)
            else:
                merged.append([lo, hi])
        total = next(r['total'] for r in source_reads if r['source_id'] == source)
        source_coverage[source] = {'intervals':merged, 'covered_chars':sum(hi-lo for lo, hi in merged), 'total_chars':total}
    return {
        'model_calls':len(model), 'calls_by_kind':dict(Counter(c['kind'] for c in model)),
        'cost_peak_cny':sum(c.get('cost_peak_cny', c.get('reserved_cny', 0)) for c in model),
        'cost_peak_with_cache_cny':sum(((c['usage']['prompt_tokens']-c['usage'].get('prompt_cache_hit_tokens', 0))*2+c['usage'].get('prompt_cache_hit_tokens', 0)*.04+c['usage']['completion_tokens']*8)/1e6 for c in settled),
        'cost_time_cache_cny':sum(c['cost_time_cache_cny'] for c in settled),
        'prompt_tokens':sum(c['usage']['prompt_tokens'] for c in settled),
        'completion_tokens':sum(c['usage']['completion_tokens'] for c in settled),
        'reasoning_tokens':sum(c['usage'].get('completion_tokens_details', {}).get('reasoning_tokens', 0) for c in settled),
        'cache_hit_tokens':sum(c['usage'].get('prompt_cache_hit_tokens', 0) for c in settled),
        'selections':dict(selections), 'qualified_read_turns':selected_reads, 'multi_read_turns':batch_turns,
        'observed_multi_read_turns':sum(t['observed_results']>1 for t in batch_turns),
        'source_read_decision_calls':len(source_decisions),
        'source_read_decision_model_seconds':sum(c['elapsed_ms'] for c in source_decisions)/1000,
        'source_read_decision_prompt_tokens':sum(c['usage']['prompt_tokens'] for c in source_decisions),
        'source_read_decision_completion_tokens':sum(c['usage']['completion_tokens'] for c in source_decisions),
        'source_read_decision_cost_peak_cny':sum(c['cost_peak_cny'] for c in source_decisions),
        'completed_repair_operations':sum(bool(r.get('repair') and r.get('page_id')) for r in receipts),
        'source_reads':source_reads, 'source_coverage':source_coverage,
        'unknown_calls':sum(c['status']=='unknown' for c in model),
        'native_unknown_calls':sum(c['status']=='unknown' for c in record.get('raw_job', {}).get('agent', {}).get('calls', {}).values()),
        'native_reserved_cny':record.get('raw_job', {}).get('agent', {}).get('budget', {}).get('reserved_cny', 0),
        'output_limit_stops':sum(c.get('finish_reason')=='length' for c in model),
        'budget_delta_cny':sum(c.get('cost_peak_cny', 0) for c in settled)-record.get('raw_job', {}).get('agent', {}).get('budget', {}).get('spent_cny', 0),
    }

details = {r['id']:trial_stats(r) for r in finished}
stats = {}
for arm in ['before', 'after']:
    rs = [r for r in finished if r['arm'] == arm]
    ds = [details[r['id']] for r in rs]
    scored = [r['score'] for r in rs if r.get('score')]
    stats[arm] = {
        'attempted':len(rs), 'delivered':sum(bool(r.get('delivery_success')) for r in rs),
        'rules_passes':sum(bool(r.get('delivery_success') and r.get('score', {}).get('rules_pass')) for r in rs),
        'pptx_passes':sum(bool(r.get('export', {}).get('pass')) for r in rs),
        'page_count_passes':sum(s['page_count_ok'] for s in scored),
        'facts_hit':sum(s['facts_hit'] for s in scored), 'facts_total':sum(s['facts_total'] for s in scored),
        'values_hit':sum(f['value_present'] for s in scored for f in s['facts']),
        'sections_hit':sum(s['section_hits'] for s in scored), 'sections_total':sum(len(s['sections']) for s in scored),
        'overflow_pages':sum(len(s['overflow_pages']) for s in scored), 'scored_pages':sum(s['page_count'] for s in scored),
        'generation_median_s':median([r['generation_ms']/1000 for r in rs if r.get('delivery_success')]),
        'export_median_s':median([r['export']['elapsed_ms']/1000 for r in rs if r.get('export')]),
        'budget_pauses':sum(r.get('phase')=='paused_budget' for r in rs),
        'waiting_user':sum(r.get('phase')=='waiting_user' for r in rs),
        'interrupted':sum(r.get('phase')=='interrupted' for r in rs),
        'error_trials':sum(r['status']=='error' for r in rs),
    }
    for field in ['model_calls', 'cost_peak_cny', 'cost_peak_with_cache_cny', 'cost_time_cache_cny', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'cache_hit_tokens', 'completed_repair_operations', 'unknown_calls', 'native_unknown_calls', 'native_reserved_cny', 'output_limit_stops', 'observed_multi_read_turns']:
        stats[arm][field] = sum(d[field] for d in ds)
    stats[arm]['calls_by_kind'] = dict(sum((Counter(d['calls_by_kind']) for d in ds), Counter()))
    stats[arm]['selections'] = dict(sum((Counter(d['selections']) for d in ds), Counter()))
    stats[arm]['multi_read_turns'] = sum(len(d['multi_read_turns']) for d in ds)
    stats[arm]['selected_batch_tools'] = sum(sum(t['tools'] for t in d['multi_read_turns']) for d in ds)

pairs = []
for case in fixtures['cases']:
    a = next((r for r in finished if r['case_id']==case['id'] and r['arm']=='before'), None)
    b = next((r for r in finished if r['case_id']==case['id'] and r['arm']=='after'), None)
    if a and b:
        da, db = details[a['id']], details[b['id']]
        pairs.append({'case_id':case['id'], 'both_delivered':bool(a.get('delivery_success') and b.get('delivery_success')), 'before_seconds':a.get('generation_ms', 0)/1000, 'after_seconds':b.get('generation_ms', 0)/1000, 'time_change_pct':change(a.get('generation_ms'), b.get('generation_ms')), 'before_calls':da['model_calls'], 'after_calls':db['model_calls'], 'before_peak_cny':da['cost_peak_cny'], 'after_peak_cny':db['cost_peak_cny'], 'before_facts':a.get('score', {}).get('facts_hit'), 'after_facts':b.get('score', {}).get('facts_hit')})
comparable = [p for p in pairs if p['both_delivered']]
paired = {'count':len(comparable)}
if comparable:
    for arm in ['before', 'after']:
        paired[arm+'_mean_seconds'] = statistics.mean(p[arm+'_seconds'] for p in comparable)
        paired[arm+'_median_seconds'] = median([p[arm+'_seconds'] for p in comparable])
        paired[arm+'_calls'] = sum(p[arm+'_calls'] for p in comparable)
        paired[arm+'_cost_peak_cny'] = sum(p[arm+'_peak_cny'] for p in comparable)
    paired['mean_time_change_pct'] = change(paired['before_mean_seconds'], paired['after_mean_seconds'])
    paired['median_time_change_pct'] = change(paired['before_median_seconds'], paired['after_median_seconds'])
    paired['faster_cases'] = sum(p['after_seconds']<p['before_seconds'] for p in comparable)
    paired['calls_change_pct'] = change(paired['before_calls'], paired['after_calls'])
    paired['cost_change_pct'] = change(paired['before_cost_peak_cny'], paired['after_cost_peak_cny'])

summary = {'status':meta['status'], 'finished_trials':len(finished), 'planned_trials':12, 'stats':stats, 'pairs':pairs, 'paired_success_timing':paired, 'details':details,
    'cost_peak_cny':sum(c.get('cost_peak_cny', c.get('reserved_cny', 0)) for c in calls), 'cost_time_cache_cny':sum(c.get('cost_time_cache_cny', 0) for c in calls),
    'provider_requests':len(calls), 'supplier_statuses':dict(Counter(c['status'] for c in calls)),
    'model_fingerprints':sorted(set(c['system_fingerprint'] for c in calls if c.get('system_fingerprint'))),
    'models':sorted(set(c['model'] for c in calls if c.get('model'))),
    'source_audit':meta['baseline_audit'],
}
for arm in ['before', 'after']:
    normal = [r['score'] for r in finished if r['arm']==arm and r['case_id']!='long-document' and r.get('score')]
    summary.setdefault('normal_cases_facts', {})[arm] = {'hit':sum(s['facts_hit'] for s in normal), 'total':sum(s['facts_total'] for s in normal)}
(OUT/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')

a, b = stats['before'], stats['after']
lines = ['# 批量读取改造：完整生成 A/B 测评', '', f"状态：{meta['status']}；已记录{len(finished)}/12次。两组均为Python Brain Harness，比较批量读取改造前后，不是固定流程与Harness对比。", '',
    '## 结果', '', '| 指标 | 改造前 | 改造后 |', '|---|---:|---:|']
for label, va, vb in [
    ('成功交付',f"{a['delivered']}/{a['attempted']}",f"{b['delivered']}/{b['attempted']}"),
    ('自动规则全部通过',f"{a['rules_passes']}/{a['attempted']}",f"{b['rules_passes']}/{b['attempted']}"),
    ('6页达标',a['page_count_passes'],b['page_count_passes']),
    ('严格词面关联事实命中',f"{a['facts_hit']}/{a['facts_total']}",f"{b['facts_hit']}/{b['facts_total']}"),
    ('数字单位出现',f"{a['values_hit']}/{a['facts_total']}",f"{b['values_hit']}/{b['facts_total']}"),
    ('指定章节命中',f"{a['sections_hit']}/{a['sections_total']}",f"{b['sections_hit']}/{b['sections_total']}"),
    ('右/底越界页',f"{a['overflow_pages']}/{a['scored_pages']}",f"{b['overflow_pages']}/{b['scored_pages']}"),
    ('PPTX结构/页数/文本通过',a['pptx_passes'],b['pptx_passes']),
    ('成功生成中位数（秒）',fmt(a['generation_median_s']),fmt(b['generation_median_s'])),
    ('模型调用',a['model_calls'],b['model_calls']),
    ('总控调用',a['calls_by_kind'].get('controller',0),b['calls_by_kind'].get('controller',0)),
    ('页面生成/修订模型调用',a['calls_by_kind'].get('page',0),b['calls_by_kind'].get('page',0)),
    ('输入token',a['prompt_tokens'],b['prompt_tokens']),('输出token',a['completion_tokens'],b['completion_tokens']),
    ('其中思考token',a['reasoning_tokens'],b['reasoning_tokens']),
    ('实际回传多个读取结果的回合',a['observed_multi_read_turns'],b['observed_multi_read_turns']),
    ('有完成回执的单页修订',a['completed_repair_operations'],b['completed_repair_operations']),
    ('统一高峰未缓存费用（元）',fmt(a['cost_peak_cny'],4),fmt(b['cost_peak_cny'],4)),
    ('统一高峰含实际缓存估算（元）',fmt(a['cost_peak_with_cache_cny'],4),fmt(b['cost_peak_with_cache_cny'],4)),
    ('按时段和缓存估算（元）',fmt(a['cost_time_cache_cny'],4),fmt(b['cost_time_cache_cny'],4)),
    ('预算暂停',a['budget_pauses'],b['budget_pauses']),('等待用户',a['waiting_user'],b['waiting_user']),('执行中断',a['interrupted'],b['interrupted']),
    ('供应商结果未知调用',a['unknown_calls'],b['unknown_calls']),('产品记录未知调用',a['native_unknown_calls'],b['native_unknown_calls']),
    ('项目保留预留费用（元）',fmt(a['native_reserved_cny'],4),fmt(b['native_reserved_cny'],4)),
    ('独立导出中位数（秒）',fmt(a['export_median_s']),fmt(b['export_median_s'])),
]:
    lines.append(f'| {label} | {va} | {vb} |')
lines += ['', f"总预算统一高峰未缓存口径：¥{fmt(summary['cost_peak_cny'],4)} / ¥30；按时段与缓存估算¥{fmt(summary['cost_time_cache_cny'],4)}。均不是供应商账单。", '', '## 同案例配对', '', '| 案例 | 改造前秒 | 改造后秒 | 耗时变化 | 模型调用前→后 | 统一费用前→后 | 严格事实前→后 |', '|---|---:|---:|---:|---:|---:|---:|']
for p in pairs:
    timing=f"{fmt(p['time_change_pct'],1)}%" if p['both_delivered'] else '不可比：一方未交付'
    lines.append(f"| {p['case_id']} | {fmt(p['before_seconds'])} | {fmt(p['after_seconds'])} | {timing} | {p['before_calls']}→{p['after_calls']} | {fmt(p['before_peak_cny'],4)}→{fmt(p['after_peak_cny'],4)} | {p['before_facts']}→{p['after_facts']} |")
lines += ['', '耗时变化负值表示更快。只有两组均交付成功的案例纳入配对速度结论；失败、暂停和评分缺失均保留。', '', '## 初步评估', '']
if comparable:
    lines.append(f"{len(comparable)}组成功配对的平均耗时为{fmt(paired['before_mean_seconds'])}→{fmt(paired['after_mean_seconds'])}秒，变化{fmt(paired['mean_time_change_pct'],1)}%；其中{paired['faster_cases']}例新版更快。对应中位数{fmt(paired['before_median_seconds'])}→{fmt(paired['after_median_seconds'])}秒，变化{fmt(paired['median_time_change_pct'],1)}%。")
    lines.append(f"相同成功配对子集的调用{paired['before_calls']}→{paired['after_calls']}（{fmt(paired['calls_change_pct'],1)}%），统一费用¥{fmt(paired['before_cost_peak_cny'],4)}→¥{fmt(paired['after_cost_peak_cny'],4)}（{fmt(paired['cost_change_pct'],1)}%）。这三例均未实际触发多工具读取，因此此整体差异不能作为批量执行的直接因果收益。")
if a['model_calls']:
    lines.append(f"全部已记录任务的模型调用{a['model_calls']}→{b['model_calls']}，变化{fmt(change(a['model_calls'],b['model_calls']),1)}%；统一高峰未缓存费用变化{fmt(change(a['cost_peak_cny'],b['cost_peak_cny']),1)}%。若两组完成数不同，这些总数不构成等量任务节省率。")
lines += [
    '这轮每类只运行一对，属于探索性测评。总控会自主选择检查、修订和读取，且模型输出存在波动；完整耗时与成本的差异不能全部归因于批量执行本身。必须结合总控/页面调用拆分、真实多读回合和长资料回执解释。',
    '普通五类和长资料分别统计在summary.json；长资料的完整读取区间见details中的source_coverage。页面/历史批量能力允许使用，但首次生成不保证触发，不能据未触发案例宣称其收益。',
]
old_long, new_long = details.get('long-document-before'), details.get('long-document-after')
if old_long and new_long:
    lines += ['', '## 长资料：读取阶段的直接证据', '', '| 指标 | 改造前 | 改造后 |', '|---|---:|---:|']
    for label, field, digits in [
        ('正文读取决策模型回合','source_read_decision_calls',0),
        ('对应模型请求累计等待（秒）','source_read_decision_model_seconds',3),
        ('对应输入token','source_read_decision_prompt_tokens',0),
        ('对应输出token','source_read_decision_completion_tokens',0),
        ('对应统一费用（元）','source_read_decision_cost_peak_cny',6),
    ]:
        lines.append(f'| {label} | {fmt(old_long[field],digits)} | {fmt(new_long[field],digits)} |')
    lines += ['', f"正文读取回合4→1（-75%），其模型请求累计等待变化{fmt(change(old_long['source_read_decision_model_seconds'],new_long['source_read_decision_model_seconds']),1)}%，统一费用变化{fmt(change(old_long['source_read_decision_cost_peak_cny'],new_long['source_read_decision_cost_peak_cny']),1)}%。这里只计选择正文读取工具的模型请求，不含索引/上下文、规划、工具HTTP与检查点开销，不能当作整份PPT的提速或费用降幅。", '两版各4条成功资料回执均覆盖0–15409字，长资料6/6事实均命中。新版一个回合四次读取均成功；旧版曾提议三个工具，其中两个收到“每回合只执行一个工具”的错误占位，后续才重选，错误占位不计成功读取。', '旧版长资料停在预算预留拦截（已结算¥1.742338/¥2），新版完成交付；因此不把258.16→161.07秒写成完整生成提速37.6%。', '页面/历史读取在本轮首次生成中均未触发，不能从本轮得出这两项的耗时收益。']
lines += ['', '## 未完成任务与观测边界', '',
    '- campaign-before：request_user / repair_limit，模型认为封面仍有内部重叠，要求用户选择继续方式；未代替用户确认。确定性右/底越界检查通过，并不能排除内部遮挡。',
    '- travel-before：产品将一次修订调用标记unknown，保留¥0.149108预留；代理未登记该次供应商外发，已登记的28次供应商请求全部成功结算。现有日志无法确定具体失败原因；没有自动重发，也未在本轮修改业务代码。',
    '- long-document-before：下一次调用预留不足而暂停，已结算金额未达到2元。这是预算预留状态，不应表述为供应商已扣满2元。',
    '- 本轮72页均生成并采集评分，只有9份完成状态的作品导出PPTX，9份均通过。审计PASS表示测评记录/版本/预算核验通过，不表示12次业务任务全部交付成功。',
    '', '## 逐次状态', '', '| 任务 | 终态 | 记录状态 | 事实 | PPTX |', '|---|---|---|---:|---|']
for r in records:
    s=r.get('score')
    lines.append(f"| {r['id']} | {r.get('phase','运行中')} | {r['status']} | {str(s['facts_hit'])+'/'+str(s['facts_total']) if s else '未采集'} | {'通过' if r.get('export',{}).get('pass') else '未通过/未生成'} |")
lines += ['', '## 控制变量与边界', '',
    '- 新增优化1/2/4/5均未实施；未降低思考强度，未改成模板代码复用。',
    '- 复用同一6类虚拟材料、固定6页、同模板、deepseek-flash、页面12000/总控4096输出上限；串行、交替先后。每次隔离启动相同引擎，服务启动不计入生成耗时。',
    '- 旧版4文件与首次完整测评SHA256一致，其他818份清单文件一致。新版4文件同样冻结；预检与各次runtime-load.jsonl验证实际加载。变化包含批次、提示词、错误回执和修订恢复，衡量该轮改造整体。',
    '- 每任务2元/600有效秒，总预算30元，900秒墙钟截止；预留不足不发起模型请求，结果未知不自动重发。没有挑选或补跑低分样本。',
    '- 生成计时从创建请求到约1秒轮询观察终态，评分和导出分别计时。总控与并行页面的调用耗时不能直接相加为墙钟耗时。',
    '- 评分器沿用原规则，未根据本轮结果调分。严格事实要求同一最多240字可见块包含主体及数值单位，可能漏掉同义表达；数值出现也不等于语义准确。未全面评估臆造、遮挡、审美。',
    '- PPTX检查仅ZIP/OOXML、6页和逐页存在文本，不能代替WPS/PowerPoint实机视觉验收。全部虚拟、各一轮，不代表真实客户成功率或统计显著收益。',
    '- 统一高峰未缓存费用按2/8元每百万输入/输出token；另报相同时段价格含实际缓存，以及真实调用时段/缓存估算，避免把价格时段或缓存波动当成代码收益。官方报价2026-11-13核对：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/。供应商账单未对账。',
    f"- 返回模型：{summary['models']}；system_fingerprint：{summary['model_fingerprints']}。相同模型名不证明后台实例完全一致。", '',
    '## 产物与证据', '',
    '- summary.json：配对数据、调用拆分、读取区间、费用与原生预算对账。',
    '- metadata.json、model-ledger.json、request-*.json、response-*.json：完整调用与终态原始证据，不保存API Key。',
    '- 每案例before/after目录：deck.pptx、page-*.jpg、score.json、visible-text.json、project.json、raw-job.json、runtime-load.jsonl、services.log。',
    '- ../baseline-audit.json及before/after：旧版逐字节恢复和冻结新版证据。',
]
lines += ['', '## PPTX文件', '', '| 案例 | 改造前 | 改造后 |', '|---|---|---|']
for fixture in fixtures['cases']:
    row=[fixture['id']]
    for arm in ['before','after']:
        r=next((r for r in finished if r['case_id']==fixture['id'] and r['arm']==arm),None)
        file=OUT/(fixture['id']+'-'+arm)/'deck.pptx'
        row.append(f'[打开PPTX]({file.as_posix()})' if r and r.get('export',{}).get('pass') else '未完成交付，未导出')
    lines.append('| '+' | '.join(row)+' |')
lines += ['', '## 可用于简历的有边界表述', '',
    '> 实现Python Agent只读工具批量调度，建立覆盖6类虚拟场景、12次真实模型端到端尝试的A/B测评；在15409字长资料用例中，将正文读取决策回合由4次降至1次，对应模型等待减少55%、统一报价费用减少83.8%，保持完整资料读取与6/6已知事实命中。',
    '', '需要保留“虚拟场景”“该长资料用例”“读取决策阶段”的边界；不能改写成所有PPT生成提速55%、成本降低83.8%或真实客户成功率100%。',
]
(OUT/'报告.md').write_text('\n'.join(lines)+'\n', encoding='utf-8')
print(json.dumps({'status':summary['status'],'finished':len(finished),'stats':stats,'paired':paired,'cost_peak_cny':summary['cost_peak_cny']},ensure_ascii=False,indent=2))
