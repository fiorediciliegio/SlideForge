# layout-audit Eval

PPT 页面布局溢出检测的评测集与评测脚本，对应 PR 中 `apps/ppt-app/executas/ppt-engine/src/layout-audit/` 的检测逻辑演进（v5 几何单轨 → v6 文字单轨 → v7 双轨合并 → 相触规则 TEXT_RING_CONTACT / TEXT_FRAME_CONTACT）。

> **当前接入状态**：CLI 仍支持离线检查；HTML 页面生成主流程已接入同一 TypeScript 检测模块，严重问题触发一次新会话重写，重写后不复查。Python 评测原型与 TypeScript 实现的差异仍然存在。详见 [ADR-0059](../../docs/adr/0059-page-layout-audit-and-single-rewrite.md)。

## 背景

需求文档：《单页 HTML 自动核验与修复能力验证需求》——先以 Batch + Eval 验证程序化布局检查的识别能力，达标后再评估接入 PPT 生成主流程。

## 目录结构

```
layout-audit/
├── cases/                    # 82 个样本 HTML（共 1.1MB，可直接入库）
│   ├── C01/ … C04/           # 80 个受控样本（4 case × V0/V1 × 10 次重复，
│   │                         #   由 gemini-3.5-flash 按溢出/对照提示词生成）
│   ├── page13.html           # 真实生成页面（ppt-20260908-023100 第 13 页）
│   └── page15.html           # 真实生成页面（ppt-20260908-023100 第 15 页）
├── ground-truth.json         # 样本标签：2026-09-07 人工标注 80 受控样本
│                             #   （2026-09-08 修订 4 条：C02-V0-02 / C02-V0-08 /
│                             #   C04-V1-03 确认为正，C02-V1-03 确认为负）；
│                             #   page13/page15 于 2026-09-08 标注：均为正样本
│                             #   （右侧上框卡片下边界溢出，v7 漏检）
├── run_audit_eval.py         # 评测脚本（v7 双轨逻辑，Playwright 驱动 Chromium）
└── results/
    ├── audit-results-v5.json     # v5 逐样本结果（80 条）
    ├── text-audit-results-v6.json # v6 逐样本结果（82 条）
    ├── audit-results-v7.json     # v7 逐样本结果（82 条，含 page13/15）
    └── SUMMARY.md                # 三版指标对比与结论
```

样本渲染截图（PNG，共 18MB）未入库；如需核对视觉效果，可用脚本对 `cases/` 内任意 HTML 重新渲染。

## 环境与运行

```bash
pip install playwright pandas   # pandas 仅历史脚本需要，本脚本不依赖
playwright install chromium

cd apps/ppt-app/evals/layout-audit
python run_audit_eval.py                    # 审计全部 82 个样本
python run_audit_eval.py --compare results/audit-results-v5.json
```

输出：逐样本 JSON（含 errors/warnings 明细）+ 控制台统计（TP/FP/FN/TN、Accuracy/Precision/Recall/F1、FN/FP 归因、新样本结果）。

## 判定口径

- **GT**：`ground-truth.json` 中 `gt_has_overflow == true` 为正样本（修订后 80 受控样本为 26 正 / 54 负）
- **预测**：`has_error = errors.length > 0`，WARNING 不参与判定
- 指标只对 80 个受控样本计算；page13/page15 仅输出检测结果供人工核对
- **相触规则口径**（TS 模块，2026-09-09 新增）：文字字形与 `bg-frame` 装饰环相触 ≥0.5px 记 `TEXT_RING_CONTACT`（ERROR）；与非祖先普通边框带相触 ≥1px 记 `TEXT_FRAME_CONTACT`（WARNING）

## 历史指标

**v7 复算（2026-09-09，GT 修订后，80 受控样本）**：

| 版本 | TP | FP | FN | TN | Accuracy | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|---|
| v7 双轨合并 | 17 | 1 | 9 | 53 | 87.50% | 94.44% | 65.38% | 77.27% |

- 漏报（FN 9 个）：C01-V1-06、C02-V0-09、C03-V0-04、C03-V0-08、C03-V1-01、C04-V0-01、C04-V0-07、C04-V0-08、C04-V1-04
- 误报（FP 1 个）：C03-V0-01
- page13 / page15：v7 runner 均判 `has_error=false`（漏检），与 SUMMARY.md 记录一致
- 注：GT 修订前（2026-09-08）记录为 TP15 / FP7 / FN9 / TN49（80.00% / 68.18% / 62.50% / 65.22%），见 `results/SUMMARY.md`；修订主要翻转 C02/C04 的 4 条标签，提升了精度

**历史演进（GT 修订前口径，2026-09-08 复算，详见 results/SUMMARY.md）**：

| 版本 | Accuracy | Precision | Recall | F1 |
|---|---|---|---|---|
| v5 几何单轨 | 80.00% | 64.29% | 75.00% | 69.23% |
| v6 文字单轨 | 76.25% | 59.26% | 66.67% | 62.75% |
| v7 双轨合并 | 80.00% | 68.18% | 62.50% | 65.22% |

## TS 模块验证记录（2026-09-09）

- `npm run check`（tsc --noEmit）通过
- 布局专项单测 `test/layout-audit-geometry.test.ts` 3/3 通过
- C03-V0-08（v7 FN 样本）：字体稳定后 TS 模块输出 3 条 `TEXT_RING_CONTACT`，深度 0.8 / 4.6 / 0.8，与 Python v9 参考实现一致
- 合成夹具：`ring-contact.html` → 1 条 `TEXT_RING_CONTACT` error；`frame-contact.html` → 1 条 `TEXT_FRAME_CONTACT` warning
- 已知边界：完整双轨算法（Python v9 原型）尚未全部同步到 TS 模块；全量单测存在既有 Windows 环境问题，与布局审计无关
