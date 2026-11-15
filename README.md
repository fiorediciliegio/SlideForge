# SlideForge

AI 驱动的演示文稿交付服务：HTML 原生幻灯片、确定性版面校验、可审计的 AI 改动和可编辑的 PPTX 导出。

> 产品形态与目标架构以 `docs/product-tech-charter.md` 为唯一事实源：能力层唯一，Web 薄壳与 AI 客户端平等。

## 当前主链路

```text
Web 薄壳 / CLI / MCP
        ↓
HTTP / MCP / CLI 薄适配层
        ↓
src/contracts（统一 DTO、错误与标识）
        ↓
src/capabilities/deck.ts
        ↓
模型生成 / 项目版本 → Go 固定快照与任务 → 独立引擎检查、预览与导出
```

- 现役 Web 入口：`src/http/app.html`，由 `npm run dev` 在 `http://localhost:8080/app` 提供。
- 现役服务端：`src/http/capabilityServer.ts`、`src/mcp/**`、`src/capabilities/**`。
- 统一契约：`src/contracts/**`；新任务的 `deck_id` 同时作为任务、计费和 `artifacts/decks/<deck_id>` 工作区标识。
- 引擎：`src/engine/**` 驱动独立任务，`executas/ppt-engine/**` 执行 HTML 渲染与 PPTX／PDF 导出；不共享业务目录，见 [ADR-0081](docs/adr/0081-independent-engine-jobs.md)。
- Web 默认使用 Python Brain 单总控 Harness，经 Node 业务工具和 Go 状态/预算完成闭环；接口与迁移说明见 [部署手册](docs/deployment.md)和 [ADR-0080](docs/adr/0080-python-brain-agent-harness.md)。CLI/MCP 现有契约保留。

## Harness 性能测评

后续测评沿用[固定测评基准](tools/harness-eval/README.md)：固定6类虚拟案例、6页、PPT模板和评分器，每轮只运行当前代码，自动对比已保存的历史结果，不重跑旧版。`npm run eval:harness -- --check` 免费校验；真实模型运行必须明确提供预算。

## Legacy 退役结果

React／Host 旧入口、旧业务功能和对应测试已通过依赖可达性审计分批退役。`src/features/templates/presets/**` 是现役服务仍在使用的共享模板资产，已完整保留；引擎、Go 网关和跨服务契约不受清理影响。

- `dev` 启动 Go 网关、Node Capability、Node 引擎和 Python 大脑层，客户端统一访问 `http://localhost:8080/app`；`serve` 只启动业务 API，生成/导出需要 Go 和独立引擎在线。
- 根级 React／Vite 依赖已移除；`executas/ppt-engine` 的独立 React 渲染依赖继续保留。
- 后续删除仍须独立进行引用与运行时资产审计，不按目录名直接处理。

## 开发与验证

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
