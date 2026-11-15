"""Build local synthetic benchmark inputs; no model or network calls."""
import hashlib
import json
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

import pymupdf

out = Path(__file__).parent / '20261112-172000'
materials = out / 'materials'
materials.mkdir(parents=True, exist_ok=True)

def fact(subject, value, unit=''):
    return {'subject': subject, 'value': str(value), 'unit': unit}

cases = [
    {'id': 'product', 'scene': '企业', 'kind': 'text', 'title': '澄图工单云产品介绍',
     'audience': '企业市场与客户成功团队',
     'sections': ['客户问题', '产品能力', '试点数据', '实施步骤'],
     'facts': [fact('试点团队', 17, '支'), fact('试点工单', 426, '张'), fact('平均响应时长', 19, '分钟'), fact('培训时长', 3, '小时')],
     'source': '澄图工单云是完全虚构的B2B工单协作产品，提供工单归类、责任人分派、状态追踪三项功能。目标用户为客户成功团队。试点团队17支，试点工单426张，平均响应时长19分钟，培训时长3小时。这些是测评构造值，不代表真实经营效果。实施按资料梳理、流程映射、小组试用、复盘四步进行。没有经过证实的营收、市场份额或认证信息。'},
    {'id': 'brand', 'scene': '企业', 'kind': 'docx', 'title': '溪木咖啡品牌传播',
     'audience': '品牌与门店运营团队',
     'sections': ['品牌定位', '表达原则', '触点安排', '执行边界'],
     'facts': [fact('试点门店', 11, '家'), fact('传播周期', 5, '周'), fact('触点类型', 3, '类'), fact('素材版本', 14, '套')],
     'source': '溪木咖啡是虚构的社区咖啡品牌，定位为日常、友好、易理解。品牌口号为“把日常慢慢喝好”。试点门店11家，传播周期5周，触点类型3类，素材版本14套。三类触点为门店海报、社区社群和公众号。第一周准备素材，第二至四周发布与收集反馈，第五周复盘。不使用销售增长或市场排名作为已实现成效。所有数字仅供测评。'},
    {'id': 'campaign', 'scene': '企业', 'kind': 'pdf', 'title': '镜桥产品体验日方案',
     'audience': '企业市场活动执行团队',
     'sections': ['活动目标', '体验流程', '资源安排', '反馈机制'],
     'facts': [fact('邀请名额', 84, '人'), fact('体验分组', 7, '组'), fact('每组体验时长', 26, '分钟'), fact('反馈问题', 9, '项')],
     'source': '镜桥产品体验日是虚构的企业活动。目标是收集可观察的使用问题，不承诺成交。邀请名额84人，体验分组7组，每组体验时长26分钟，反馈问题9项。流程依次为签到、任务说明、分组体验、问题记录、汇总复盘。岗位包括主持、引导、技术支持、记录。日期、场地与实际预算尚未确定，必须保持待确认。案例中所有数值均为测试构造值。'},
    {'id': 'academic', 'scene': '学术/教育', 'kind': 'pdf', 'title': '虚构隔振支架研究开题',
     'audience': '研究开题评审',
     'sections': ['研究背景', '研究内容与技术路线', '可行性与进度', '拟议创新点'],
     'facts': [fact('拟设试件', 18, '件'), fact('设计工况', 6, '类'), fact('拟设测点', 24, '个'), fact('计划周期', 8, '个月')],
     'source': '这是完全虚构的隔振支架开题案例，不提供已完成的实验结论。研究拟比较不同连接方式对支架响应的影响。拟设试件18件，设计工况6类，拟设测点24个，计划周期8个月。技术路线依次为问题界定、参数设计、试验准备、数据采集、对比分析。第1至2个月完成设计，第3至5个月准备和采集，第6至8个月分析与写作。拟议创新点是连接参数与多工况响应的联合分析，不应写成已经证实的技术领先或确定性能提升。'},
    {'id': 'travel', 'scene': '旅游', 'kind': 'text', 'title': '虚构青岚市周末慢游',
     'audience': '喜欢步行与摄影的普通游客',
     'sections': ['行程原则', '第一天', '第二天', '准备清单'],
     'facts': [fact('旅行天数', 2, '天'), fact('首日步行上限', '4.6', '公里'), fact('次日步行上限', '3.2', '公里'), fact('同行人数', 5, '人')],
     'source': '青岚市及以下景点全部为虚构，不对应真实票价和开放时间。旅行天数2天，同行人数5人。首日步行上限4.6公里，安排芦汀园与旧街摄影；次日步行上限3.2公里，安排星港步道与书店休息。偏好慢行、拍照、保留机动时间。不提供门票价格、交通班次、真实营业时间或商务项目的市场推广目标。'},
]
padding = '本节说明资料整理、角色分工、沟通记录和版本归档方式，不新增成果指标。'
long_source = '此资料为虚构企业资料治理项目。\n【前部核验信息】试点部门9个；原始样本284份。\n' + padding * 170
long_source += '\n【中部核验信息】流程节点13个；复盘会议7次。\n' + padding * 280
long_source += '\n【末部核验信息】资料复用率42.7%；已确认模板17套。上述指标仅为本次测评构造值。\n'
cases.append({'id': 'long-document', 'scene': '企业', 'kind': 'txt', 'title': '长资料覆盖核验',
              'audience': '企业资料治理项目组', 'sections': ['项目概况', '整理流程', '前中后部核验数据', '结论与边界'],
              'facts': [fact('试点部门', 9, '个'), fact('原始样本', 284, '份'), fact('流程节点', 13, '个'), fact('复盘会议', 7, '次'), fact('资料复用率', '42.7', '%'), fact('已确认模板', 17, '套')],
              'source': long_source})

font = pymupdf.Font('china-s')
for case in cases:
    case['proposed_pages'] = 6
    case['brief'] = ('生成6页中文演示，直接生成预览，不联网。主题：' + case['title'] + '。受众：' + case['audience']
                     + '。覆盖以下部分：' + '、'.join(case['sections'])
                     + '。以上部分名称须原样出现在某页可见标题中。以附件或正文资料为唯一事实来源，准确呈现其中关键数据，保留计划、未确定与已完成的区别；不编造日期、预算或业务成果。资料为虚构测评材料，不要补充外部事实。')
    text = case['source']
    if case['kind'] == 'docx':
        name = case['id'] + '.docx'
        xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + ''.join('<w:p><w:r><w:t>' + escape(line) + '</w:t></w:r></w:p>' for line in [case['title'], *text.splitlines()]) + '</w:body></w:document>'
        with zipfile.ZipFile(materials/name, 'w') as archive:
            archive.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
            archive.writestr('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
            archive.writestr('word/document.xml', xml)
        case['attachment'] = 'materials/' + name
    elif case['kind'] == 'pdf':
        name = case['id'] + '.pdf'
        document = pymupdf.open()
        page = document.new_page()
        lines = [case['title']]
        for paragraph in text.splitlines():
            current = ''
            for char in paragraph:
                if font.text_length(current + char, fontsize=11) > 510:
                    lines.append(current)
                    current = char
                else:
                    current += char
            if current:
                lines.append(current)
        page.insert_text((40, 55), '\n'.join(lines), fontname='china-s', fontsize=11, lineheight=1.8)
        document.save(materials/name)
        document.close()
        case['attachment'] = 'materials/' + name
    elif case['kind'] == 'txt':
        name = case['id'] + '.txt'
        (materials/name).write_text(text, encoding='utf-8')
        case['attachment'] = 'materials/' + name
    case['source_chars'] = len(text)
    case['source_sha256'] = hashlib.sha256(text.encode('utf-8')).hexdigest()

# Only the input text/attachment is sent to the generator; this rubric stays local.
payload = {'status': 'draft-awaiting-final-design', 'fixture_version': 1, 'all_materials_synthetic': True,
           'template_id': '134-Adaptive Systems Editorial Cover', 'cases': cases,
           'scoring_scope': 'Known-fact association and visible text coverage; not a general truth or aesthetic score.'}
(out/'fixtures.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'cases': len(cases), 'attachments': [case.get('attachment') for case in cases if case.get('attachment')],
                  'long_source_chars': len(long_source), 'tail_fact_offset': long_source.index('资料复用率')}, ensure_ascii=True))
