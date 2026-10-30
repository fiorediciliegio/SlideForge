# SlideForge 系统全景与下一步（2026-10-30）

> 给协作者的交接摘要：10 分钟了解系统现状、各入口、验证方式与待办。
> 前置阅读：`docs/product-tech-charter.md`（总纲）、`docs/deployment.md`（部署手册）。

## 一句话现状

**SlideForge 已是一个可用的 AI PPT 交付服务**：DeepSeek 生成 → 确定性版面闸门 → 可编辑 PPTX 导出，CLI / MCP / HTTP 三端可用，点数计费与运营控制台齐备。

## 架构全景

```
客户端（三端等价，共用能力层）
├── CLI        npm run generate -- --brief "..." --pages 8 --out x.pptx
├── MCP        npm run mcp        （Claude/Kimi 对话内 5 个工具）
└── HTTP       npm run serve      （localhost:3210 + /console 控制台）
                    │
                    ▼
能力层  src/capabilities/deck.ts
        createDeck / regeneratePage / exportDeck / getDeckPreview
                    │
        ┌───────────┼────────────────┐
        ▼           ▼                ▼
  DeepSeek 直连   版面闸门          引擎（进程内直调）
  scripts/m0/     scopeCss 隔离     executas/ppt-engine
  llmClient.ts    + 无头 Chrome     runExportOnly → 可编辑 pptx
  prompts.ts      溢出测量
                    │
                    ▼
计费  src/billing/（API key 鉴权、token 计量、点数结算、JSONL 台账）
```

## 关键文件地图

| 文件 | 职责 |
|---|---|
| `src/capabilities/deck.ts` | 能力层唯一入口（铁律：无 UI 后门） |
| `scripts/m0/` | LLM 客户端、提示词、deck 组装、版面校验、缩略图 |
| `src/mcp/server.ts` | MCP Server（create_deck/get_deck_job/regenerate_page/get_deck_preview/export_deck） |
| `src/http/capabilityServer.ts` | HTTP 服务 + admin 接口 + /console |
| `src/billing/index.ts` | 计费：价目表、鉴权、结算、台账、key 管理 |
| `scripts/keys.ts` | key 签发/充值/列表 CLI |
| `integrations/wps-addon/` | WPS 加载项骨架（实机验证中） |

## 验证方式

| 验证 | 命令/位置 |
|---|---|
| 端到端生成 | `npm run generate -- --brief "测试" --pages 2 --out artifacts/t.pptx` |
| MCP 全链路 | `npm run mcp:smoke`（含图片预览） |
| HTTP 全链路 | `npm run serve` 后按 deployment.md §四-3 curl |
| 人工验收 | `docs/notes/20261030-人工验收清单.md`（逐项打勾） |

## 已验证的关键指标

- 20 页 deck 70 秒、0 导出警告、成本约 1 毛钱；
- 版面溢出修复：同内容对照 11 页溢出 → 0；
- 计费扣减链实测：100 → 97（生成）→ 87（导出）。

## 待办（按优先级）

1. **人工验收**（用户）：WPS 目检清单 + WPS 加载项实机验证；
2. **生产化**：部署到云主机（deploy/ 套件与本机彩排已就绪；管理员鉴权与 MCP Streamable HTTP 已完成）；
3. **M4/M5 已交付**（品牌资产/附件/偏离度审计/模板库/自动推荐）；
4. **后续候选**：Go 网关替换 Node HTTP 层（高并发）、完整 HTML 方言白名单契约（D2 收尾）、CI 保真回归（D6）、PasteHtml 内容级写回探索。

## 不要做的事

- 不要给 UI 开后门绕过能力层；
- 不要在 deck.html 里合并未作用域的页面 CSS（会跨页串台）；
- 不要把 key/台账/data 目录提交进仓库；
- 不要恢复 anna 时代的 executa 进程桥。
