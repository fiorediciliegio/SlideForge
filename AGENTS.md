# Agent 项目指南

这是本仓库面向 coding agent 的入口说明。旧的 `CLAUDE.md`、`Agent.md`、`AGENT.md` 不再使用。

## 先读这些

- [`CONTEXT.md`](CONTEXT.md)
- [`docs/adr/`](docs/adr/)
- [`README.md`](README.md)
- [`executas/ppt-engine/README.md`](executas/ppt-engine/README.md)

如果 `CONTEXT.md` 或 `docs/adr/` 暂时不存在，静默跳过即可。不要同时创建 `context.md` 和 `CONTEXT.md`；在大小写不敏感文件系统上它们会指向同一路径。

## 仓库概览

当前主线是当前 App 根目录：把现有 PPT 生成链路包装成可交互的 Anna App 工作台。

相关子项目都收敛在 `executas/` 下：

- [`executas/ppt-engine/`](executas/ppt-engine/)：HTML Page Source 工作区能力、模板参考快照、HTML 静态化、PPTX model 转换和任务状态机。
- [`third_party/dom-to-pptx/`](third_party/dom-to-pptx/)：仓库内直接维护的 HTML 到 PPTX 权威源码。
- Web 和图片研究由 Anna Host 官方 Web API 提供，不再使用本地搜索 Executa。

完整链路仍然是：

```text
manifest.json -> deck.html -> .pptx
```

## 当前代码架构

### App 前端

- `src/app/`：应用入口、路由和整体壳子。
- `src/features/`：按业务域切分的功能层，主要有 `deck-workspace`、`outline`、`requirements`、`templates`、`review`、`export`、`task`、`pages`。
- `src/api/`：前端后端适配层，React 页面只通过 `PptBackend` 调用。
- `src/runtime/`：Anna runtime 连接与模式识别。
- `src/ai/`、`src/agent/`：LLM 提示词、解析和 agent 相关逻辑。
- `src/state/`：本地状态管理。

### `executas/ppt-engine`

- `src/app/presentation-templates/`：内置模板、蓝图和主题。
- `src/authoring-kit-workspace/`：当前保留旧模块名，但 HTML v1 只负责稳定页面标识、`slides/*.html` 与最小 manifest 重建，不安装 Authoring Kit。
- `src/app-workspace/`：工作区 artifact 读写和聚合。
- `src/pptx-export/`：在后端受管 Chrome 中加载 vendored dom-to-pptx，并从整体 Deck HTML 生成 `.pptx`。
- `src/render/`：Deck / slide 渲染与运行时 bundle。
- `src/task-state-machine/`：任务状态机、恢复、查询与持久化。
- `src/discovery/`、`src/local-template/`、`src/browser/`、`src/http/`、`src/cli.ts`：发现、本地模板、浏览器渲染、HTTP 和 CLI 入口。

## 关键边界

- React 页面组件只调用 `PptBackend`。
- Anna Runtime / standalone 的差异只放在 adapter 层。
- 工作区文件读写和 gate 判断放在 `ppt-engine` app-facing tools。
- `ppt-engine` 持有完整的 Deck HTML 到 PPTX 后端导出作业。
- 前端不能直接读写本地文件系统。
- 不要把前端的 `tools.invoke` 写成插件内部 JSON-RPC envelope。

## Tool ID 不变量

App manifest 使用 `bundled:<handle>` 引用 Executa，前端只从
`window.__ANNA_TOOL_IDS__` 读取运行时生成的真实 tool id；缺失 sidecar 或 handle
应直接失败，不要回退到 `.env` 或硬编码真实 id。

以下位置必须通过 [`scripts/sync-tool-manifests.mjs`](scripts/sync-tool-manifests.mjs)
保持同步：

- [`manifest.json`](manifest.json) 的 `required_executas[].tool_id`：固定为 `bundled:ppt-engine`
- [`manifest.json`](manifest.json) 的 `required_executas[].min_version`：来自各 Executa manifest 的 `version`
- [`manifest.json`](manifest.json) 的 `ui.host_api.tools`：固定为 `required:bundled:<handle>`
- [`app.json`](app.json) 的 `bundled_executas`
- [`executas/*/executa.json`](executas/) 的真实 `tool_id`
- [`executas/*/executa.json`](executas/) 的发布元数据 `name`、`version`、`description`
- 真实插件 `describe` 返回的 manifest `display_name` 和 `version`

各 Executa 的 `manifest.json` 是 JSON-RPC `describe` 返回的 tool protocol manifest，
不再承载真实 `tool_id`；真实 `tool_id` 只放在对应 `executa.json`。

当前真实 ID：

```text
ppt-engine:  tool-lightvoss-ppt-engine-kqhra9hy
```

## 开发与运行

- 默认不要自己启动 `npm run dev` 或 `anna-app dev`。
- 一般由用户自己在本机启动 dev server，并打开 `http://localhost:5180/`。
- 如果需要看 UI 或复现 bug，优先用 Chrome DevTools MCP 操作用户已经打开的 `http://localhost:5180/`。
- 如果发现用户没有启动 dev server，就直接提醒用户启动，不要代为拉起。
- 不要重新引入独立 Vite dev server proxy 路径。
- 当前环境无法直接启动 Chrome / Puppeteer；如果必须运行相关渲染或截图测试，需要按提权流程请求用户授权。

App 根目录常用命令是：

```bash
npm run build
npm run check
npm run validate
npm run dev:mock-llm
npm run dev:mock-llm:retry
```

`npm run dev` 仍然是正式的本地入口，并固定使用 `anna-app dev --storage aps` 连接真实 APS；只在用户明确要求时配合使用。

`ppt-engine` 里常用命令是：

```bash
cd executas/ppt-engine && npm run build
cd executas/ppt-engine && npm run check
cd executas/ppt-engine && npm run test:unit
cd executas/ppt-engine && npm run start
cd executas/ppt-engine && npm run start:plugin
```

## 构建与验证顺序

如果改动涉及下游产物，优先按这个顺序：

1. `cd executas/ppt-engine && npm run build`
2. `npm run build`
3. `npm run validate`

如果修改了 `executas/ppt-engine/src/**`，要先重建 engine，因为 `example_plugin.js` 从 `dist/index.js` 导入。

如果改动只在 `src/**`，通常先跑 `npm run check`，再根据需要跑 `npm run build` 或 `npm run validate`。

## 测试

- `executas/ppt-engine/test/**/*.test.ts` 是主要的单测入口，命令是 `npm run test:unit`。
- App 目前主要靠 `npm run check`、`npm run build` 和 `npm run validate` 做回归。
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

## Anna Runtime 与 tool 返回值

- Anna runtime 目前还不能原生理解 `__file_transport` pointer response。
- `executas/ppt-engine/app_stdio.js` 会把 pointer file 内联回 stdout，原生支持 pointer 之前不要删除它。
- 普通 `invoke` 统一经 `src/runtime/invokeTransport.ts` → `app_invoke_transport`。按完整消息 JSON 的 UTF-8 字节数，使用 **3 MiB（3,145,728 字节）**预算，为平台的 4 MiB 上限留余量。
- 请求与响应使用同一协议：预算内直接传；超限只做一次 gzip + Base64 压缩；仍超限才走 Host Upload。业务层传原始对象或文本，禁止再添加业务专用阈值、压缩或大内容上传分支。
- 上传复用现有协商、PUT、确认的失败重试；浏览器跨域失败只在统一传输层使用有界分块中转。业务调用不能因传输失败被传输层自动重放。
- `invokeAsyncAwait`、任务恢复与结果读取仍沿用原协议。保留的异步入口文件指针内联上限仍是 1 MiB；新普通调用和分块控制帧直接输出受预算约束的响应，不经过该文件指针路径。
- 后端 `manifest.json` 只公开统一网关、分块通道及 `app_run_pdf_export`、`app_run_export_artifact_publish` 两个异步入口。普通业务定义在 `invoke-tools.json`，仅由网关分发；禁止重新注册旧传输工具、旧上传字段或普通业务直连入口，不兼容旧版前端。
- APS 持久化、图片/字体资源映射、真实文件上传以及 AI 会话需要 HTTPS 地址的附件保持原有存储用途。参见 [ADR-0071](docs/adr/0071-unified-ordinary-invoke-transport.md)。

## 常见坑

- `executas/ppt-engine` runtime/SDK 产物采用 ESM-only 构建；路径解析优先使用 `import.meta.url`，不要为这些产物重新引入 CJS 输出兼容。`scripts/sea-bootstrap.cjs` 是 Node SEA 启动器例外，不代表包级 CommonJS 支持。
- GitHub Actions 的 Windows runner 可能把文本文件 checkout 成 CRLF。同步脚本如果解析 `pyproject.toml`、`uv.lock`、manifest 等文本文件，不能把 `\n` 当作唯一换行；要么先归一化行尾，要么用 `\r?\n`，并加 CRLF 回归测试。否则 Windows job 里 `npm run sync:tool-manifests && git diff --exit-code` 会因为误改文件失败。
- Windows release zip 不要依赖 PowerShell `Compress-Archive` 保留空目录。`ppt-engine` 的 Anna Binary archive 需要顶层 `bin/`、`lib/`、`data/`，其中 `lib/`、`data/` 可能为空；Windows zip 打包必须显式创建目录 entry，不能用 placeholder 文件污染包内容。
- Puppeteer 相关命令可能需要本机 Chrome / Chrome for Testing。
- HTML v1 的权威页面源是 `<workspace>/slides/<page_id>.html`；Agent Session 只返回 HTML，不直接写文件，PPT App 提取唯一完整 HTML 后交由后端持久化。
- `AGENTS.md` 是本仓库 canonical 的 agent guidance；不要把新约束写回别的旧指导文件。

## 术语与文档

- 默认使用中文友好的表达；新增或更新的 markdown 文档，尤其是 `.scratch/` 下的 issue 和 PRD，应尽量使用中文。

issue 和 PRD 放在 `.scratch/` 里的 markdown 文件中。相关说明见：

- [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)
- [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)
- [`docs/agents/domain.md`](docs/agents/domain.md)
