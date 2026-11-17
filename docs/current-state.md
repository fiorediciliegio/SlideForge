# SlideForge 系统全景与下一步（2026-11-16）

状态: active · 最后验证日期: 2026-11-16

## 独立引擎任务现状

业务 Node 已通过固定输入/任务 ID 调用独立引擎，在线页面校验、批量截图、PDF/PPTX 不再在业务进程执行。Go 保存队列与私有文件，按 owner 公平轮转，支持取消和一次失联恢复，交付先幂等扣点再开放下载。本机重型并发 1，Brain 项目并发 5，排队等待不计有效执行时间。

本期 A 保留单个逻辑业务 Node 的项目目录，不承诺业务多副本接管。接口和环境边界见 [ADR-0081](adr/0081-independent-engine-jobs.md)，性能与未验证环境见[验收记录](../.scratch/engine-job-service/验收记录.md)。

## Python Brain Harness 现状

2026-11-16：上下文优化首轮加入权威运行状态：Node在既有检查调度接口汇总当前大纲/约束/用户更正、阶段、页面进度、已识别问题、修订计数、成功读取区间、预算及权限；Python决策前按变化追加完整快照和短状态，已登记调用恢复时使用原请求视图。原资料、HTML、截图、推理协议和历史消息保留，读取不等于事实已核验。内部context_version=2只用于新创建及新续改执行，旧执行继续保持原格式。模型上限、并发、工具与质量闸门不变；工具结果精简、模板重排等后续步骤尚未实施。零付费验收和缓存基线见[本轮记录](../.scratch/context-optimization/首轮验收记录.md)，真实模型测评待本轮预算授权；`context-status-v1`配置与上轮20261115并发3结果比较总控/页面/整体加权缓存命中率。

2026-11-15：页面整页工作位改用`AGENT_PAGE_CONCURRENCY`，默认3；业务Node内的页面模型请求共享`PAGE_MODEL_CONCURRENCY=12`并按客户/项目轮转，覆盖Harness与同进程固定流程HTTP/HTTP-MCP。Brain仍5项目，每业务Key最多2个活跃Harness项目，固定流程原有页并发默认2保持。预算被在途请求暂占时释放模型槽后等结算；Go记录活动与等待，纯等待不计有效时间，其他并行工作按墙钟计一次。引擎默认仍1，未实施上下文精简及WPS/MCP/CLI的Harness迁移；独立CLI/stdio MCP和多业务Node不受该单进程共享池统一约束。验收见[本期记录](../.scratch/page-concurrency-optimization/验收记录.md)。

2026-11-14：检查返工已在执行器限制到有效阻断清单，单页工具也不能越界；单阻断页仅提供单页修订。Agent单页输出及费用预留同步为16000，总控8192、默认并发2、思考配置保持。测评配置`repair-scope-16000`保留原案例与评分器，主参考20261114-review、辅助参考20261114-revision-batch；新增首次程序通过、初稿无需必要返工与截断指标，历史只读补算、不重跑旧版。

2026-11-14：检查收齐后的独立修订可通过`revise_pages`一次提交2–6页，每页分别给出修改要求与可选候选，默认并发仍为2；有依赖的修改拆批，单页及用户主动续改沿用单页工具。批次固定输入、逐页回执与串行提交，普通单页错误继续其他页，提交前拒绝本页版本/约束已经变化的旧候选。总控输出及费用预留同步调整为8192，单页12000与思考强度不变。测评使用显式配置`--profile revision-batch-8192`，以上一轮保存的20261114-review为主参考；保留v1的4096协议和原始基线，按综合变更解释对比。

2026-11-14：检查阶段改为按需自动推进。程序安排缺失/失效的版面检查、全稿内容评审和最多4页的视觉批次；模型保留评审、资料读取、有理由的追加检查及单页修订决策。同阶段先收齐问题，修完已有清单后重查受影响页并补齐当前全稿内容复核；质量闸门通过且已有授权导出完成后，程序沿用原finish回执自动提交completed/ready。没有修改模型思考强度、页面并发或加入多页修订批处理。

Web 现已接入单总控工具闭环：需求/场景 → 可编辑大纲或直接生成 → 页面工具 → 版面/内容/视觉检查 → 定向修订 → 预览。Go 保存条件执行、成本预算、回执与当前修订引用；Node 保存项目/资料/页面快照，运行模型生成与项目版本工具，通过固定快照提交独立引擎作业；Python 保存可恢复的控制协议并调用工具。模型消息与截图保存在 Node artifact，Go 保存检查点引用。

默认 `npm run dev` 启动四进程，入口 `http://localhost:8080/app`。模型 Key 来自项目 `.env`；现有 `.tooling` Go/Python 自动识别。CLI/MCP/WPS 继续现有接口，已迁移作品的写入进入页面版本链。新接口见 [Agent 契约](../contracts/openapi/agent.yaml)，决策见 [ADR-0080](adr/0080-python-brain-agent-harness.md)，验收结果见 [Harness 验收记录](../.scratch/python-brain-harness/验收记录.md)。

旧链路的结构与历史测试记录保留在下文；其中“20页70秒”等历史数据不适用于新增的规划/视觉检查闭环。

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
  DeepSeek 直连   版面闸门          Go 引擎作业 → 独立引擎
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
| `src/http/capabilityServer.ts` | HTTP 服务、用户隔离、限流、admin 接口与 /console |
| `src/server/jobQueue.ts` | 旧生成任务的有界准入队列；浏览器作业归 Go 引擎队列 |
| `src/server/httpSecurity.ts` | 请求体上限、固定窗口限流与安全响应头 |
| `src/server/jobs.ts` | 任务热存储、归属信息、事件上限与原子快照 |
| `src/billing/index.ts` | 计费、串行余额事务、原子持久化、台账与 key 管理 |
| `scripts/keys.ts` | key 签发/充值/列表 CLI |
| `integrations/wps-addon/` | WPS 加载项骨架（实机验证中） |

## 现役与 legacy 退役结果

- 现役主链路为 HTTP 薄壳 / CLI / MCP → `src/contracts` → Capability API；新任务的任务 ID、计费 ID 和工作区目录统一为同一个 `deck_id`。
- React／Host 旧体系及其测试已通过依赖可达性审计分批删除；根级 React／Vite 依赖和 legacy 入口已清理。
- `src/features/templates/presets` 是现役共享资产，已完整保留；`dev` 启动四进程，`serve` 为单 Node 入口。

## 验证方式

| 验证 | 命令/位置 |
|---|---|
| 核心门禁 | `npm run check && npm run test:core` |
| 全量现役测试 | `npm run test:unit`；Go 网关使用 `npm run test:gateway` |
| 端到端生成 | `npm run generate -- --brief "测试" --pages 2 --out artifacts/t.pptx` |
| MCP 全链路 | `npm run mcp:smoke`（含图片预览） |
| HTTP 全链路 | `npm run serve` 后按 deployment.md §四-3 curl |
| 人工验收 | `docs/notes/20261030-人工验收清单.md`（逐项打勾） |

## 已验证的关键指标

- 20 页 deck 70 秒、0 导出警告、成本约 1 毛钱；
- 版面溢出修复：同内容对照 11 页溢出 → 0；
- 计费扣减链实测：100 → 97（生成）→ 87（导出）。

## 待办（按优先级）

1. **P0 架构收敛（已完成）**：统一纯契约、`deck_id` 与工作区，退役 React／Host legacy，现役测试独立运行。
2. **P1 目标架构**：按总纲建立跨服务 `contracts/` 与 Go 骨架层；Node 收敛为引擎服务，Python 承接大脑层。
3. **人工验收**（用户）：WPS 目检清单 + WPS 加载项实机验证。
4. **已交付**：M4/M5 品牌与模板能力、M6 产品交互优化、D2 方言契约、D6 CI 保真回归。

## 不要做的事

- 不要给 UI 开后门绕过能力层；
- 不要在 deck.html 里合并未作用域的页面 CSS（会跨页串台）；
- 不要把 key/台账/data 目录提交进仓库；
- 不要恢复 anna 时代的 executa 进程桥。
