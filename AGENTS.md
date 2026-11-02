# Agent 项目指南

这是本仓库面向 coding agent 的入口说明。旧的 `CLAUDE.md`、`Agent.md`、`AGENT.md` 不再使用。

## 先读这些

- [`docs/current-state.md`](docs/current-state.md)
- [`docs/adr/`](docs/adr/)
- [`README.md`](README.md)
- [`executas/ppt-engine/README.md`](executas/ppt-engine/README.md)

如果 `CONTEXT.md` 或 `docs/adr/` 暂时不存在，静默跳过即可。不要同时创建 `context.md` 和 `CONTEXT.md`；在大小写不敏感文件系统上它们会指向同一路径。

## 仓库概览

当前主线是独立交付服务：HTTP 薄壳 / CLI / MCP → `src/contracts` → `src/capabilities/deck.ts` → 生成校验与 `ppt-engine`。产品与目标架构以 `docs/product-tech-charter.md` 为准。

相关子项目都收敛在 `executas/` 下：

- [`executas/ppt-engine/`](executas/ppt-engine/)：HTML Page Source 工作区能力、模板参考快照、HTML 静态化、PPTX model 转换和任务状态机。
- [`third_party/dom-to-pptx/`](third_party/dom-to-pptx/)：仓库内直接维护的 HTML 到 PPTX 权威源码。

完整链路仍然是：

```text
deck_id -> artifacts/decks/<deck_id> -> deck.html -> .pptx
```

## 当前代码架构

### 现役交付服务

- `src/contracts/`：纯 DTO、Zod 约束、错误结构与 `deck_id`，不得反向依赖 Capability、HTTP、MCP 或 React。
- `src/capabilities/`：系统功能唯一入口；新任务的任务、计费和工作区共用同一个 `deck_id`。
- `src/http/`、`src/mcp/`、CLI：薄适配层，不另建业务后门。
- `src/server/`、`src/billing/`：现役运行支撑，保留队列、任务恢复、浏览器生命周期和导出幂等边界。

### Legacy React／Host（已退役）

- 旧 React 入口、Host 专属模块和对应测试已通过依赖可达性审计分批删除，不再接受新功能或兼容性补丁。
- `src/features/templates/presets/` 是现役共享模板资产，必须保留，不随 legacy 删除。
- 不根据目录名直接删除引擎或旧模块；后续删除必须独立进行引用与运行时资产审计。

### `executas/ppt-engine`

- `src/app/presentation-templates/`：内置模板、蓝图和主题。
- `src/authoring-kit-workspace/`：当前保留旧模块名，但 HTML v1 只负责稳定页面标识、`slides/*.html` 与最小 manifest 重建，不安装 Authoring Kit。
- `src/app-workspace/`：工作区 artifact 读写和聚合。
- `src/pptx-export/`：在后端受管 Chrome 中加载 vendored dom-to-pptx，并从整体 Deck HTML 生成 `.pptx`。
- `src/render/`：Deck / slide 渲染与运行时 bundle。
- `src/task-state-machine/`：任务状态机、恢复、查询与持久化。
- `src/discovery/`、`src/local-template/`、`src/browser/`、`src/http/`、`src/cli.ts`：发现、本地模板、浏览器渲染、HTTP 和 CLI 入口。

## 关键边界

- HTTP／MCP／CLI 只通过 `src/contracts` 与 Capability API 调用业务能力，不另建 UI 后门。
- 工作区文件读写和 gate 判断放在 Capability 与 `ppt-engine` 的对应边界内。
- `ppt-engine` 持有完整的 Deck HTML 到 PPTX 后端导出作业。
- Web 薄壳不能直接读写本地文件系统；运行时 HTML／JS 资产必须经过路径白名单保护。

## 开发与运行

- 现役入口是 `npm run dev` 或 `npm run serve`（HTTP 薄壳与 Capability API，端口 3210）；默认不要代替用户启动长期服务。
- 根级 React／Vite 已退役，没有 `dev:legacy`、`build:legacy` 或 `test:legacy`；不要重新引入这些入口。
- 当前环境无法直接启动 Chrome / Puppeteer；如果必须运行相关渲染或截图测试，需要按提权流程请求用户授权。

App 根目录常用命令是：

```bash
npm run check
npm run test:core
npm run test:unit
npm run test:gateway
```

`ppt-engine` 里常用命令是：

```bash
cd executas/ppt-engine && npm run build
cd executas/ppt-engine && npm run check
cd executas/ppt-engine && npm run test:unit
cd executas/ppt-engine && npm run start
cd executas/ppt-engine && npm run start:plugin
```

## 构建与验证顺序

如果修改了 `executas/ppt-engine/src/**`，先重建 engine，再按影响范围运行核心测试。现役主链路改动至少运行：

1. `npm run check`
2. `npm run test:core`
3. 必要时 `npm run test:unit` 与 `npm run test:gateway`。

## 测试

- `executas/ppt-engine/test/**/*.test.ts` 是主要的单测入口，命令是 `npm run test:unit`。
- App 现役链路主要靠 `npm run check` 和 `npm run test:core`，全量现役结果由 `npm run test:unit` 报告。
- vendored dom-to-pptx 使用定向 Vitest 与 `ppt-engine` build 验证。
- 新增测试时，优先沿用现有目录和命名：`*.test.ts`。

## 模板与预览

- 主流程 Visual Style Preset（视觉风格预设）位于
  `src/features/templates/presets/<preset-id>/`，其中 `images/*.webp` 是 UI 预览，
  `html/*.html` 是 Template Reference Page（模板参考页）。
- Visual Style Preset WebP 使用独立工具
  `tools/visual-style-preset-preview-renderer/` 显式生成或校验。该工具不进入
  UI Bundle、Executa 或最终 App 发布包，也不接入普通 `prebuild` 自动生成资源。
- Visual Style Preset 更新后运行 `npm run validate:visual-style-presets`；新增预设或页面时
  同步更新校验脚本中的预设数和预览图数基线。
- 模板选择器使用静态图片 URL，不使用 data URL；Template Reference Page HTML
  必须自包含，不能依赖不会被 Workspace 快照复制的本地资源。
- 语义配色参考 HTML 的八个 `--theme-*` 角色保持稳定，选中配色必须在需求确认前写入参考快照；首页卡片不能预加载未交互模板的实时 iframe。
- 自动模板推荐当前只使用内置目录。个人模板入口已开放，用户可手动创建和选择；自动推荐流程不读取或加入历史个人模板。批量更新沿用完整批次对象及统一 invoke，不引入仅前端存在的精简回执协议。
- 旧 Template Group（模板组）PNG 预览生成、同步和发布链路已移除；不要重新接入
  `ppt-engine` 构建、App `prebuild` 或二进制打包。

- 个人模板在上传前创建 `user-templates/<id>/` 草稿目录；模板日志和排查包通过模板 ID 专用接口访问，不能放宽普通作品目录校验或初始化作品文件。诊断规则见 [ADR-0074](docs/adr/0074-personal-template-diagnostics.md)。

## 常见坑

- `executas/ppt-engine` runtime/SDK 产物采用 ESM-only 构建；路径解析优先使用 `import.meta.url`，不要为这些产物重新引入 CJS 输出兼容。`scripts/sea-bootstrap.cjs` 是 Node SEA 启动器例外，不代表包级 CommonJS 支持。
- GitHub Actions 的 Windows runner 可能把文本文件 checkout 成 CRLF。同步脚本如果解析 `pyproject.toml`、`uv.lock`、manifest 等文本文件，不能把 `\n` 当作唯一换行；要么先归一化行尾，要么用 `\r?\n`，并加 CRLF 回归测试。否则 Windows job 里 `npm run sync:tool-manifests && git diff --exit-code` 会因为误改文件失败。
- Windows release zip 不要依赖 PowerShell `Compress-Archive` 保留空目录。`ppt-engine` 的 SlideForge Binary archive 需要顶层 `bin/`、`lib/`、`data/`，其中 `lib/`、`data/` 可能为空；Windows zip 打包必须显式创建目录 entry，不能用 placeholder 文件污染包内容。
- Puppeteer 相关命令可能需要本机 Chrome / Chrome for Testing。
- HTML v1 的权威页面源是 `<workspace>/slides/<page_id>.html`；Agent Session 只返回 HTML，不直接写文件，PPT App 提取唯一完整 HTML 后交由后端持久化。
- `AGENTS.md` 是本仓库 canonical 的 agent guidance；不要把新约束写回别的旧指导文件。

## 术语与文档

- 默认使用中文友好的表达；新增或更新的 markdown 文档，尤其是 `.scratch/` 下的 issue 和 PRD，应尽量使用中文。

issue 和 PRD 放在 `.scratch/` 里的 markdown 文件中。相关说明见：

- [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)
- [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)
- [`docs/agents/domain.md`](docs/agents/domain.md)
