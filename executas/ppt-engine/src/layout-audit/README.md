# layout-audit（PPT 页面布局审计）

对单页 HTML 做**离线几何/文字布局检查**，输出结构化审计报告（JSON / Markdown / 供 AI Agent 消费的精简 JSON）。

当前既保留离线 CLI，也通过 `app_audit_workspace_page_layout` 接入 HTML 页面生成主流程。
页面首次渲染完成后按 1920×1080 检查；仅严重问题数大于 0 时，由 App 在新会话中重写一次。
重写只接收 `slides/` 源 HTML 和当前截图，不接收大纲、母版、参考或检测报告。
重写结果保存并重新渲染后直接接受，不再次审计；警告和可疑项不触发重写。
检测模块本身仍只负责出报告，重写及接受决策由页面生成流程管理。详见 [ADR-0059](../../../../docs/adr/0059-page-layout-audit-and-single-rewrite.md)。

## 检查规则

| 规则 | 严重级 | 说明 |
|---|---|---|
| `SLIDE_OUT_OF_BOUNDS` | error | 元素超出画布边界 |
| `CONTAINER_OVERFLOW` | error/warning | 子容器内容溢出（按溢出量与元素类型分级） |
| `TEXT_OVERFLOW` | error | 文字盒溢出其容器 |
| `ELEMENT_OVERLAP` | warning | 元素间异常重叠 |
| `TEXT_RING_CONTACT` | error | 文字字形与 `bg-frame` 装饰环相触（≥0.5px，采集时等待字体/图片稳定） |
| `TEXT_FRAME_CONTACT` | warning | 文字字形与非祖先普通边框带相触（≥1px） |
| `BROKEN_IMAGE` | error | 图片加载失败 |
| `RENDER_STATE` | warning | 渲染状态异常 |

## 使用

```bash
cd apps/ppt-app/executas/ppt-engine
npm run audit:layout -- --input <绝对 HTML 路径> [--format both|agent|json|markdown] [--output <path>]
```

默认画布 1280×720，可用 `--width` / `--height` / `--slide-selector` 调整。

## 验证状态（截至 2026-09-09）

- `npm run check`（tsc --noEmit）通过
- 布局专项单测 `test/layout-audit-geometry.test.ts` 3/3 通过
- C03-V0-08 复算：3 条 `TEXT_RING_CONTACT`，深度 0.8 / 4.6 / 0.8
- 82 页评测集（80 受控样本 + 2 真实页面）基线指标见
  [`apps/ppt-app/evals/layout-audit/README.md`](../../../../evals/layout-audit/README.md)
- 已知边界：完整双轨算法（Python v9 原型）尚未全部同步到本 TS 模块；
  全量单测存在既有 Windows 环境问题，与布局审计无关

## 目录

- `audit.ts` — 浏览器采集（Playwright）+ 几何/文字分析
- `types.ts` — 规则、元素结构类型
- `agent-report.ts` — 供下游 AI Agent 消费的精简报告
- `report.ts` — Markdown 报告渲染
- `cli.ts` — CLI 入口（`npm run audit:layout`）
- `geometry.ts` — 矩形几何工具函数
