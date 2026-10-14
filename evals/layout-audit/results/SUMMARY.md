# layout-audit Eval 结果汇总

> 复算日期：2026-09-08 ｜ 评测集：80 个受控样本（C01–C04 × V0/V1 × 10 次重复，人工标注 26 正 / 54 负）+ 2 个真实页面样本（page13 / page15，GT 待标注，不参与指标）
> 判定口径：各版本预测字段 → v5=`has_overflow`，v6=`has_text_issue`，v7=`has_error`（ERROR 口径，WARNING 不参与）

## 三版指标对比（80 个受控样本）

| 版本 | 检测层 | TP | FP | FN | TN | Accuracy | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|---|---|
| v5 | 几何单轨（slide 越界 / 容器溢出 / 绝对定位悬出） | 18 | 10 | 6 | 46 | 80.00% | 64.29% | 75.00% | 69.23% |
| v6 | 文字单轨（出界 / 裁切 / 重叠，Range 行矩形） | 16 | 11 | 8 | 45 | 76.25% | 59.26% | 66.67% | 62.75% |
| v7 | 双轨合并（文字裁决 ERROR + 几何降级 WARNING） | 15 | 7 | 9 | 49 | 80.00% | 68.18% | 62.50% | 65.22% |

## 结论

- **v7 vs v5**：精度 64.29%→68.18%（FP 10→7），召回 75%→62.5%（FN 6→9）——过滤误报的同时漏检增多
- **v7 vs v6**：精度与召回均提升，双轨策略整体优于单文字轨
- **当前盲区（v7 FN=9）**：GT 判定溢出但 v7 未报 ERROR 的 9 个样本，明细见 `audit-results-v7.json` 中 `gt_has_overflow=true && has_error=false` 的记录
- **真实页面样本**：page13 / page15 人工核查（2026-09-08）确认**均为正样本**——右侧上框卡片（GOALS / 02 生产端）下边界溢出，文字压入下层区域；v7 均误判为无问题（`has_error=false`），属于 v7 真实漏检案例

## 逐样本结果明细

| 文件 | 内容 |
|---|---|
| `audit-results-v5.json` | 80 条，几何候选明细（slide/container/absolute overflows） |
| `text-audit-results-v6.json` | 82 条，文字层明细（out_of_slide / text_overflow / text_overlap） |
| `audit-results-v7.json` | 82 条，双轨合并后 ERROR/WARNING 分级明细 |

## 复现方式

```bash
cd apps/ppt-app/evals/layout-audit
python run_audit_eval.py                       # 跑全部 82 个样本
python run_audit_eval.py --compare results/audit-results-v5.json   # 附 v5 对比
```
