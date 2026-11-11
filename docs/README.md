# 文档体系与维护规范

> 本规范约束 `docs/` 下所有文档的创建、变更与废弃。目的：**两个开发者之间不靠记忆和聊天记录对齐，靠文档对齐。**

## 一、四层结构

| 层 | 目录 | 性质 | 变更规则 |
|---|---|---|---|
| **总纲** | `product-tech-charter.md` | 产品/架构唯一事实源，极少变 | **必须 PR + 双方评审** |
| **决策** | `adr/NNNN-kebab-case-title.md` | 追加式，一条决策一份 | **不可修改**，翻案 = 新 ADR 标注 `Supersedes ADR-NNNN` |
| **计划** | `plans/YYYYMMDD-主题.md` | 进行中的开发计划，有生命周期 | 可直接提交，完成后状态标 `done` |
| **笔记** | `notes/` | 踩坑、调研、spike 结果 | 可直接提交 |

## 二、铁律

1. **讨论不定稿，不写代码**——涉及方向/架构的讨论，结论先落 ADR 或总纲，再开工；
2. **代码与文档同 PR**——改行为必须同步改对应文档，reviewer 有权以"文档没跟上"打回；
3. **ADR 追加不改写**——历史决策保留原文，错了用新 ADR 翻案，这样"当时为什么这么定"永远可查；
4. **本文件是 docs/ 的唯一索引入口**——新增文档必须在此登记，否则视为不存在；
5. **每份文档头部带状态行**：`状态: draft | active | done | superseded` + 最后验证日期；
6. **每月第一个工作日做一次 freshness 检查**：active 文档里与现实不符的，更新或降级。

## 三、ADR 编号

沿用现有 `adr/` 目录编号（当前最大 0071），新决策从 **0072** 起编。编号永久不复用。

模板：

```markdown
# ADR-0072: 标题

- 状态: accepted
- 日期: YYYY-MM-DD
- 决策人: …

## 背景
## 决策
## 备选方案（为什么否掉）
## 影响
```

## 四、文档索引

| 文档 | 说明 | 状态 |
|---|---|---|
| [product-tech-charter.md](product-tech-charter.md) | 产品与技术总纲（定位/垂直/计费/架构/路线） | active · 2026-10-30 盘点 |
| [current-state.md](current-state.md) | **系统全景与下一步（协作者交接首选）** | active · 2026-10-30 |
| [Python Brain Harness PRD](../.scratch/python-brain-harness/PRD.md) | 已确认的单总控 Agent 产品规则与交互（Q1–Q20） | active · 2026-11-10 |
| [独立引擎任务服务 PRD](../.scratch/engine-job-service/PRD.md) | 跨机器固定输入、异步引擎任务、多用户调度与等待时间验收设计 | draft · 2026-11-11 |
| [Harness 验收记录](../.scratch/python-brain-harness/验收记录.md) | 回归、四进程恢复、浏览器交互与真实模型评测 | active · 2026-11-10 |
| [adr/0080-python-brain-agent-harness.md](adr/0080-python-brain-agent-harness.md) | Python 单总控 Harness、持久化、预算与版本边界 | accepted · 2026-11-10 |
| [plans/20261110-Python-Brain-Harness改造方案.md](plans/20261110-Python-Brain-Harness改造方案.md) | Harness 契约、持久化、预算、工具闭环与分阶段改造 | active · 2026-11-10 |
| [plans/20261026-M0最小闭环.md](plans/20261026-M0最小闭环.md) | M0：brief → pptx 最小闭环（4 天） | done · 2026-10-29 |
| [notes/20261026-M0-spike-引擎独立导出.md](notes/20261026-M0-spike-引擎独立导出.md) | 第 0 步 spike 通过：引擎可独立导出 | done · 2026-10-26 |
| [deployment.md](deployment.md) | 部署运行手册（安装/三种启动/计费 key 管理） | active · 2026-10-30 |
| [notes/20261101-M6交付记录.md](notes/20261101-M6交付记录.md) | M6：用量页/空状态/编辑区扩展/导出命名/错误统一 | done · 2026-11-01 |
| [plans/20261101-深度全面优化计划.md](plans/20261101-深度全面优化计划.md) | 深度全面优化计划（已完成） | done · 2026-11-01 |
| [plans/20261101-P1三服务骨架.md](plans/20261101-P1三服务骨架.md) | P1：跨服务契约与 Go／Node／Python 三服务骨架 | active · 2026-11-01 |
| [plans/20261101-P2生产存储.md](plans/20261101-P2生产存储.md) | P2：认证计费 PostgreSQL、任务 outbox 与对象存储路线 | active · 2026-11-01 |
| [notes/20261030-M4M5交付记录.md](notes/20261030-M4M5交付记录.md) | M4/M5：品牌资产/附件/偏离度审计/模板库/自动推荐 | done · 2026-10-30 |
| [notes/20261030-D4-WPS插件spike.md](notes/20261030-D4-WPS插件spike.md) | D4：WPS 插件可行（文档级），实机验证清单 | active · 2026-10-30 |
| [notes/20261029-M1交付记录.md](notes/20261029-M1交付记录.md) | M1：能力层/版面闸门/MCP Server | done · 2026-10-29 |
| [notes/20261030-M2交付记录.md](notes/20261030-M2交付记录.md) | M2：预览/HTTP/计费三项交付 | done · 2026-10-30 |
| [notes/20261030-人工验收清单.md](notes/20261030-人工验收清单.md) | 人工验收逐项检查表（待用户逐项打勾） | active · 2026-10-30 |
| [adr/](adr/) | 架构决策记录（0001–0071 为历史决策） | active |
| `plans/` | 开发计划 | — |
| `notes/` | 调研与踩坑笔记 | — |
