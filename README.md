# SlideForge

AI 驱动的演示文稿交付服务：HTML 原生幻灯片、确定性版面校验、可审计的 AI 改动和可编辑的 PPTX 导出。

能力层唯一，Web 薄壳与 AI 客户端共用同一套业务能力。

## 总体架构

[![SlideForge 总体架构：Web Harness、业务 Node、Go 网关与独立引擎](docs/images/architecture.svg)](docs/images/architecture.svg)

[PNG 图片](docs/images/architecture.png)

Python Brain 负责规划、工具决策与评审，业务 Node 执行页面生成和项目版本工具，Go 管理鉴权、状态、预算与引擎任务，独立 Node 引擎执行检查、预览和导出。Web 默认进入 Harness；CLI、MCP、WPS 当前仍使用固定流程，各入口共用统一契约和 Capability 能力。

引擎通过固定输入快照和任务 ID 与业务协作，不依赖共享业务目录。Go 本地使用 JSON 和私有文件，可配置 PostgreSQL/S3；业务项目目录仍由单个逻辑 Node 持有。图中端口为本地开发默认值。

- 现役 Web 入口：`src/http/app.html`，由 `npm run dev` 在 `http://localhost:8080/app` 提供。
- 现役服务端：`src/http/capabilityServer.ts`、`src/mcp/**`、`src/capabilities/**`。
- 统一契约：`src/contracts/**`；新任务的 `deck_id` 同时作为任务、计费和 `artifacts/decks/<deck_id>` 工作区标识。
- 引擎：`src/engine/**` 驱动独立任务，`executas/ppt-engine/**` 执行 HTML 渲染与 PPTX／PDF 导出，不共享业务目录。
- Web 默认使用 Python Brain 单总控 Harness，经 Node 业务工具和 Go 状态/预算完成闭环。CLI/MCP 现有契约保留。

## Harness 性能测评

测评工具位于 `tools/harness-eval/`：固定6类虚拟案例、6页、PPT模板和评分器，每轮只运行当前代码，自动对比已保存的历史结果，不重跑旧版。`npm run eval:harness -- --check` 免费校验；真实模型运行必须明确提供预算。

## Legacy 退役结果

React／Host 旧入口、旧业务功能和对应测试已通过依赖可达性审计分批退役。`src/features/templates/presets/**` 是现役服务仍在使用的共享模板资产，已完整保留；引擎、Go 网关和跨服务契约不受清理影响。

- `dev` 启动 Go 网关、Node Capability、Node 引擎和 Python 大脑层，客户端统一访问 `http://localhost:8080/app`；`serve` 只启动业务 API，生成/导出需要 Go 和独立引擎在线。
- 根级 React／Vite 依赖已移除；`executas/ppt-engine` 的独立 React 渲染依赖继续保留。
- 后续删除仍须独立进行引用与运行时资产审计，不按目录名直接处理。

## 开发与验证

需要 Node.js ≥ 22、Go ≥ 1.22、Python ≥ 3.11，以及用于渲染和导出的 Chrome 或 Edge。模型凭据配置在本机根目录 `.env` 中，使用 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL`；`npm run dev` 自动加载该文件，已有进程环境变量优先。

```bash
npm install
npm run dev           # 四进程入口，客户端访问 8080/app
npm run serve         # 仅 Node Capability API
npm run serve:engine  # 仅 Node 引擎，端口 3211
npm run serve:brain   # 仅 Python 大脑层，端口 3212
npm run serve:gateway # 仅 Go 网关，端口 8080
npm run mcp           # MCP stdio；先保持四进程在线
npm run check         # TypeScript 类型检查
npm run test:core     # 契约、工作区、服务端核心测试
npm run test:unit     # 全量现役测试
npm run test:gateway  # Go 网关测试
```

引擎：

```bash
cd executas/ppt-engine
npm install
npm run check
npm run test:unit
```

## 架构路线

1. P0（已完成）：统一契约、`deck_id` 与工作区，退役 legacy 双栈。
2. P1：按总纲建立 `contracts/` 跨服务协议与 Go 骨架层。
3. P2：Node 收敛为引擎服务，Python 承接 Prompt 编排、文档理解与评测。
4. P3：按服务边界引入各自存储，不允许跨域直连数据库。

## License

待定。若含上游开源项目衍生代码，发布前需保留对应 NOTICE。
