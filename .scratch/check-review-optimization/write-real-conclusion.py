import json
import sys
from pathlib import Path

out=Path(sys.argv[1]).resolve()
load=lambda name:json.loads((out/name).read_text(encoding='utf-8'))
summary=load('summary.json');detail=load('optimization-1.json')
comparison=next(c for c in summary['comparisons'] if c['baseline_id']=='20261113-after')
a,b=comparison['before'],comparison['after']
delta=lambda x,y:f'{(y/x-1)*100:.1f}%' if x else '不适用'
lines=['# 优化1真实模型测评结论','','日期：2026-11-14。只运行优化后的当前代码6次，固定6类虚拟案例、每份6页；与已冻结的20261113-after主基线比较，未重跑旧版。','',
    '## 主要结果','','| 指标 | 主基线 | 优化1后 | 变化 |','|---|---:|---:|---:|']
for label,key,digits in [
    ('生成平均耗时，含检查和修订（秒）','generation_mean_s',2),
    ('生成中位数（秒）','generation_median_s',2),
    ('导出平均耗时（秒）','export_mean_s',2),
    ('生成＋导出平均耗时（秒）','generation_export_mean_s',2),
    ('模型调用总数','calls',0),
    ('统一报价无缓存费用，6份合计（元）','cost_peak_cny',4),
    ('统一报价含实际缓存费用，6份合计（元）','cost_cache_peak_cny',4),
]:
    lines.append(f'| {label} | {a[key]:.{digits}f} | {b[key]:.{digits}f} | {delta(a[key],b[key])} |')
lines+=['',f"这次6例均有成功配对，平均每份生成及导出少用{a['generation_export_mean_s']-b['generation_export_mean_s']:.2f}秒。全部尝试都保留，没有失败替换或额外补跑。", '',
    '## 哪些变化直接对应优化1','',
    f"- 模型用于选择inspect_deck和finish_deck的调度请求：{detail['before']['inspection_and_finish_decisions']}→{detail['after']['inspection_and_finish_decisions']}。程序仍完成了{detail['after']['automatic_completed_tools'].get('inspect',0)}次有回执取证及{detail['after']['automatic_completed_tools'].get('finish',0)}次收尾，必要检查没有被删除。",
    f"- 总控调用：{detail['before']['controller_calls']}→{detail['after']['controller_calls']}；内容/视觉评审提交：{detail['before']['first_tools']['record_assessment']}→{detail['after']['first_tools']['record_assessment']}，判断仍由模型完成。",
    f"- 页面模型调用（含补生成、修订）：{detail['before']['page_calls']}→{detail['after']['page_calls']}；有完成回执的修订操作：{detail['before']['completed_repairs']}→{detail['after']['completed_repairs']}。这一差异受到生成结果和评审波动影响，不全部归因于自动调度。",
    '- 活动案例先评完4＋2页，再逐页修改第4、5页；之后只评这两页视觉，最后复核一次全稿内容。调用证据为response-35/36/37/38/40/42/43.json。',
    '- 长资料案例先在内容评审中发现阻断项并修订，内容通过后才进行视觉评审，避免先评将被重做页面的旧视觉。','',
    '## 质量和可靠性','','| 指标 | 主基线 | 优化1后 |','|---|---:|---:|']
for label,key in [('成功交付','delivered'),('PPTX结构、6页和逐页文本检查通过','pptx_passes'),
    ('全部自动规则通过','rules_passes'),('严格词面关联事实命中','facts_hit'),
    ('已知数字单位出现','value_hits'),('指定章节命中','section_hits'),('右/底越界页','overflow_pages')]:
    denom='/6' if key in ['delivered','pptx_passes','rules_passes'] else '/26' if key in ['facts_hit','value_hits'] else '/24' if key=='section_hits' else '/36'
    lines.append(f'| {label} | {a[key]}{denom} | {b[key]}{denom} |')
lines+=['',
    '严格词面命中25/26→23/26的差异来自旅游案例（3/4→1/4），原始分数未调整。其4项数字单位均出现。核对可见文本：页面将“旅行天数”写为“行程天数2天”；第3页标题为“第一天”，正文明确“当日步行总量上限4.6公里”；第4页标题为“第二天”，正文明确“当日步行总量上限3.2公里”。这些表达差异解释了词面漏记，不能因此修改固定评分或声称通用事实准确率提高。',
    '上述检查没有覆盖所有幻觉、内部遮挡或审美，未进行WPS/PowerPoint人工视觉验收。不能把数值出现率当成完整语义质量，也不能仅凭这组结果宣称视觉质量完全相同。','',
    f"模型供应商请求{detail['supplier_requests']}次，全部结算，无未知结果。程序/供应商费用对账一致，未发送私有消息字段，运行期间业务源码无变化，协议/模板和历史基线未改变。审计结果：{detail['audit_status']}。",'',
    '## 费用口径与解释边界','',
    f"- 授权预算15元，按固定高峰未缓存口径保守计量¥{detail['cost_peak_cny']:.4f}；按本轮周末时段及实际缓存估算¥{detail['cost_time_cache_cny']:.4f}。没有供应商账单对账，也不包含机器/部署成本。",
    '- 前后费用比较统一使用固定高峰报价；本轮是周末，不能把供应商空闲时段折扣当成代码优化收益。官方报价核对日期2026-11-14：[DeepSeek报价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。',
    '- 这是跨日期历史基线回归比较，每类只运行一次，不是同轮随机A/B或统计显著性结论。服务负载、缓存和模型生成/评审路径存在波动，整体差异不能全部归因于本次代码。',
    '- 本次没有实施多页批量修订、通用上下文精简、生成并发提升或降低思考强度。','',
    '## 文件','','所有新版PPTX链接见[完整报告](报告.md)，检查调度详见[专项统计](优化1专项统计.md)。原始数据在metadata.json、model-ledger.json、source-manifest.json与各案例目录中。','',
    '## 简历表述示例','',
    '> 优化Python Agent Harness检查编排，在6类虚拟场景、36页产物的历史基线测评中，将检查取证及收尾专用模型调度回合由34次降至0，平均生成及导出耗时由285秒降至191秒（约33%），统一报价含缓存模型费用降低约25%，6份PPTX均通过结构检查。',
    '',
    '面试时说明这是固定虚拟集、每类一轮的历史对照；保留严格词面核验23/26的质量边界，不扩写为生产SLA、通用准确率或真实客户收益。']
(out/'测评结论.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print(str(out/'测评结论.md'))
