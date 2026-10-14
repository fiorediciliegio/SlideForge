# PPT App

`ppt-app` 是 Anna App 形态的 PPT 生成工作台。当前目录同时承载前端 SPA、PPT 引擎、
评估与开发资料，作为 `anna-apps` 大仓中的独立 App 工作区。它把前端 SPA、PPT 引擎和
PPTX 导出引擎打包在同一个 app 目录下，方便被 Anna App runtime
加载到 iframe；Web 和图片研究直接调用 Anna Host 官方 Web API。

本 App 已从独立的 `ppt-sdk` 仓库收拢到 `anna-apps/apps/ppt-app`。迁移后的目录是
App 自包含的工作区；大仓根目录负责统一依赖安装、校验和发布编排。

## 项目架构

```text
apps/ppt-app/
├── manifest.json          # Anna App manifest，声明权限、视图和 bundled Executa
├── app.json               # Marketplace metadata 和 bundled_executas 路径
├── bundle/                # Vite 构建后的静态 SPA，运行时加载到 iframe
├── public/                # 前端静态资源
├── src/                   # React 前端、Anna runtime adapter、业务状态和 workflow UI
├── tests/                 # 前端和 workflow 单测
├── scripts/               # app 内同步、校验和 pipeline 辅助脚本
├── docs/                  # ADR、Anna RPC 和存储设计文档
├── evals/                 # 评估脚本、fixtures 和评分基线
├── examples/              # Anna App / Host API 示例
├── tools/                 # 不进入 App 发布包的独立离线开发工具
├── third_party/           # 仓库内维护的 dom-to-pptx 源码
├── agent-ppt-runs/        # 确定性 Agent PPT 工具和提示词
└── executas/
    └── ppt-engine/        # Node Executa：模板、渲染、工作区、校验、任务状态机
```

前端页面只通过 `src/api/PptBackend` 访问后端能力。Anna runtime 模式下，
工具调用走 `anna.tools.invoke(...)`；真实 tool id 由运行时生成的
`bundle/anna-tool-ids.js` 注入到 `window.__ANNA_TOOL_IDS__`。前端不要写死
真实 tool id，也不要从 `.env` 回退。

`manifest.json` 使用稳定 bundled handle：

```text
bundled:ppt-engine
```

对应关系由以下文件保持同步：

- `manifest.json` 的 `required_executas[].tool_id`
- `manifest.json` 的 `ui.host_api.tools`
- `app.json` 的 `bundled_executas`
- `executas/*/executa.json` 的真实本地 `tool_id`
- `executas/*/executa.json` 的发布元数据 `name`、`version`、`description`
- 各 Executa `describe` 返回的 manifest `display_name` 和 `version`

`executas/*/manifest.json` 只作为 JSON-RPC `describe` 的 tool protocol manifest，
不再保存真实 `tool_id`。

## 本地环境

需要先安装：

- Node.js 22+
- npm
- pnpm 11.15.1（由 Corepack 管理）
- Anna App CLI（通常来自 `@anna-ai/cli`）
- Chrome 或 Chrome for Testing，用于 `ppt-engine` 的浏览器渲染与导出

如果要使用真实 Anna LLM bridge，需要先登录：

```bash
anna-app login --host <nexus-url>
```

## 首次安装和构建

按下面顺序执行。

### 1. 构建 ppt-engine

```bash
cd apps/ppt-app/executas/ppt-engine
npm install
cd ../../third_party/dom-to-pptx && corepack pnpm install --frozen-lockfile
cd ../../executas/ppt-engine
npm run build
```

`build` 会生成 `dist/`、forkable templates 和浏览器运行时资源。

### 2. 构建 ppt-app

```bash
cd apps/ppt-app
npm install
npm run build
```

`ppt-app` 的 `prebuild` 会校验 Visual Style Preset，并同步 tool manifest，
然后由 Vite 输出 `bundle/`。

## 常用命令

### 诊断日志开关

仅在 App 根目录现有 `.env` 中配置 `VITE_PPT_LOG_ENABLED=true`（开启）或
`VITE_PPT_LOG_ENABLED=false`（关闭）。默认关闭，只有字符串 `true` 才会开启。
修改后重新执行 `npm run build`，并重新加载 App；不需要第二份后端 `.env`。

前端会在每次普通及异步工具调用中传递 `diagnostic_logging_enabled`，后端重启后
也会收到配置。关闭时不上传或追加工作区 `.log/`、大内容附属文件及快照恢复计时日志，
不额外读取用于日志的 Agent 会话历史；已有日志不会删除。生成进度、事务恢复记录、
显式性能测试和研究测试工件继续保存。宿主自身日志与工具协议响应不属于此开关。
附件批量测试需要日志中的详细耗时和模型用量时，请开启此开关后再测试。

单次后端调用及其衍生任务保留调用时的开关值；独立定时任务采用该 App 引擎最近
收到的配置，未收到配置时不记录。前端请求停用日志会返回 `appended: false` 和空的
`log_file`，不会把日志停用作为业务失败。

### 开发命令

```bash
cd apps/ppt-app
npm run build
npm run check
npm run validate
npm run preset-previews:test
npm run ppt:check-env
npm run ppt:generate-tsx -- --entry <page.preview.tsx> --rasterize 1
npm run dev
npm run dev:mock-llm
npm run dev:mock-llm:retry
```

`npm run dev` 会执行 `anna-app dev --storage aps`，由 Anna App harness 连接真实 APS、发现
`executas/*/executa.json` 并按需启动对应命令。

本地开发默认已经登录 Anna。APS Files 相关 reverse RPC 需要真实 APS；不要移除
`--storage aps`，也不要为 APS 不可用的环境增加 Host Upload fallback。

`npm run dev:mock-llm` 使用 `fixtures/mock-outline.jsonl` 作为 mock LLM
响应，适合稳定测试 outline 生成流程。

`npm run dev:mock-llm:retry` 使用 `fixtures/mock-outline-retry.jsonl`，第一轮
返回无效 JSON，后续 repair 请求返回有效 JSON，用来测试重试逻辑。

## Visual Style Preset 预览图

前端 Visual Style Preset（视觉风格预设）位于
`src/features/templates/presets/<preset-id>/`。每个预设包含 `preset.json`、
自包含的 Template Reference Page（模板参考页）HTML，以及 UI 使用的
`1280x720` WebP 预览图。

离线生成和严格校验工具位于
`tools/visual-style-preset-preview-renderer/`。它是拥有独立 `package-lock.json`
和依赖的私有 Node 包，首次使用前运行：

```bash
cd tools/visual-style-preset-preview-renderer
npm ci
```

随后可以从 `apps/ppt-app` 根目录运行：

```bash
npm run preset-previews:render -- \
  --source-root <完整预设源目录> \
  --output-root <完整App预设目录> \
  --browser-executable <Chromium可执行文件>

npm run preset-previews:convert -- \
  --source-root <完整旧预设源目录> \
  --output-root <完整App预设目录>

npm run preset-previews:check -- \
  --presets-root <完整待校验预设目录> \
  --browser-executable <Chromium可执行文件>
```

该工具不会在普通 `npm run build` 或 `prebuild` 中自动运行，避免构建过程修改
已提交的模板资源。发布或更新预设后仍需运行
`npm run validate:visual-style-presets`。

旧 Template Group（模板组）PNG 预览生成、同步和发布链路已经移除；WebP 工具是
当前唯一的模板预览资源维护入口。

### 个人模板

侧栏和首页“我的模板”入口已开放。个人模板支持手动选择，自动模板推荐继续只使用内置模板。

侧栏“我的作品”下方的“我的模板”支持上传一个不超过 20 MiB 的 PPTX。应用通过 `doc_read`
分析并选择最多六页，使用 `pptx-svg` 转为图片，再生成一份视觉母版和逐页 HTML 参考。
模板页面可查看生成进度、继续未完成的创建，以及预览母版和参考页。

个人模板保存在运行时工作空间根目录的 `user-templates/<id>/`。首页模板选择器的
“我的模板”显示已完成模板；确认演示需求后，母版和参考页会复制到当前作品，生成时
跳过母版创建。详细约定见 [ADR-0052](docs/adr/0052-personal-html-templates-from-pptx.md)。

模板目录在上传前创建；上传失败也可选中该草稿，从设置下载问题排查包。没有保存原件时，
点击“重新选择原 PPTX”继续同一模板。新建和每次续跑使用不同运行标识，日志保留在同一目录的 `.log/` 下。
开启 `VITE_PPT_LOG_ENABLED=true` 后记录创建阶段、每次会话请求、App 实际收到的原始帧和存储传输；
帧按批次持续写入，不只保留最终摘要，鉴权信息和签名地址脱敏。写入故障或容量保护会标记日志不完整。

设置页的下载入口仍需 `VITE_WORKSPACE_DIAGNOSTIC_BUNDLE_ENABLED=true`。从“我的模板”进入设置后，
选择排查对象，下载该模板的完整目录 ZIP；失败、取消、生成中均可下载。模板日志会先复制一份稳定副本，
其余文件变化时可能要求重新生成。ZIP 发布到独立的 APS 临时下载对象，不增加模板云同步或排查包历史。
详见 [ADR-0074](docs/adr/0074-personal-template-diagnostics.md)。

### 从 HTML Page Source 生成最终 PPTX

当前创作主路径使用 `html-authoring-v1`：Agent Session（智能体会话）返回完整 HTML，
PPT App 提取唯一完整文档并持久化为 `slides/<page_id>.html`。受管 Chrome 只执行页面源
一次，随后保存静态 HTML 和可重建的每页 WebP 缩略图；最终 `deck.html` 只组合这些静态页面快照，再交给
dom-to-pptx 转换为 `.pptx`。首页可选择 16:9（1920×1080）、4:3（1440×1080）、9:16（1080×1920）、3:4（1080×1440）。整份作品的生成、预览、人工编辑及 PPTX／PDF 导出使用同一尺寸，默认 16:9；已有页面源码后如需其他尺寸，请新建作品。

### 管理本页配图

大纲卡片右侧最多展示三张本页配图，超过三张时叠加剩余数量，末尾始终保留加号；无图时也可直接点击加号。
点击缩略图查看大图，点击加号直接打开共用配图窗口。确认配图后立即回显到当前大纲草稿，仍需底部保存或确认。
卡片适度加宽，窄屏将图片移到标题下方。详见 [ADR-0079](docs/adr/0079-outline-card-image-entry.md)。

大纲详情和单页批量重新生成也使用“选择或搜索配图”入口，按钮旁提示“已有图片 · 上传 · 搜索”。窗口回显当前未保存的页码、标题和大纲，
可展开阅读全文及本页创作要求；本页已选图片单独汇总，支持查看大图和移除。

下方“已有图片”“搜索图片”共用一份选择草稿。已有图片展示正式素材和所有成功获取的搜索候选，
包含未推荐、未分析及超过研究附件预算的图片，支持来源筛选、标题和描述过滤，以及其他页面的使用提示。
切换标签、修改筛选词或新一轮搜索均不清空已选图片；同内容跨来源去重，已有正式素材不会重复保存。

关键词搜索每次最多获取 20 个结果，以最多 10 路并发检查原图，不调用描述模型。
本次窗口内可以切回最近五轮搜索结果，更早结果中已选图片也会保留；关闭窗口后不提供历史任务恢复入口。
搜索只保存 APS 引用和元数据，勾选不下载作品原图。预览地址按需刷新，失败可在大图中重试。

“已有图片”中保留上传入口，支持多选 PNG、JPG、WebP、GIF，每张最多 25 MiB；
每份作品最多保存 50 张手动配图、总计 100 MiB。应用逐张校验、保存原图，成功后自动勾选，允许移除。
上传不调用描述模型，单张失败可以重试，成功图片仍可使用。

点击“确认配图”后统一下载、校验并保存所选远程候选，按钮显示转圈图标及“正在保存图片”。
全部成功才应用到外层编辑并关闭窗口；部分失败保留选择并标出失败图片，再次确认只重试未成功图片，
也可移除失败图片后继续。搜索、取消收尾、上传和保存期间不能关闭窗口；离开页面取消本窗口的搜索。

“取消”、关闭或 Esc 不应用本次选择草稿，已保存素材仍留在作品中。
卡片入口仍需保存或确认大纲，大纲详情仍需“保存修改”，单页批量重新生成仍需采用候选后才修改正式大纲和页面。
上传配图不改变首页资料分析。四语文案及交互约定见 [ADR-0078](docs/adr/0078-unified-page-image-manager.md)，
素材与描述规则继续见 ADR-0069、ADR-0070 和 ADR-0077。

### 生成前补充图片描述

HTML 生成前，只为实际选用且缺描述的图片补充客观画面描述，按内容哈希去重，每批最多 6 张。描述会话使用现有有界重试；最终失败或辅助保存失败仍继续生成，保留成功描述和全部选图。取消会停止生成。同次运行的页面重试和恢复不重复消耗已处理图片的描述预算。

整份生成在影子工作区准备描述；单页多个候选共享一次描述及原图准备。全部选图进入 HTML 清单，原图附件仍只附前 6 张；超过 6 张不阻止选择。美化和精修沿用整页截图规则。详见 [ADR-0077](docs/adr/0077-image-candidates-and-deferred-descriptions.md)。

### HTML 预览与临时截图

结果页大图、放映和候选预览展示静态 HTML。候选首次按需加载，最多同时准备四个预览；
成功后的 iframe（内嵌页面）及已打开的放大预览保留到退出候选页，不因滚动或状态刷新重建。
封面、网格和各处缩略条复用每页当前版本的 WebP，长边不超过 640 像素；第一页同时作为封面。
普通逐页生成提前准备小图，旧作品及人工修订、候选采用后的新版本按需补齐，不积累缩略图历史。
结果页拿到页面目录后，会在后台逐步准备、下载并解码全部缩略图；当前页和接近可视区域的页面优先，
同时最多处理四张、纯后台最多三张。相同版本复用已加载图片，单页失败不阻塞其他页，
离开作品后停止调度。作品列表封面、网格和其他缩略图入口仍按可视区域加载。

页面优化、一键美化和布局修复需要视觉附件时，才从对应 HTML 临时截图，上传后删除本地文件。
正常生成和人工保存不持久化整页 PNG。打开旧作品时，确认页面
HTML 齐备后清理已知历史生成截图，保留新的每页 WebP 缓存；正文配图、字体、模板资源和历史 ZIP 归档保留。异常退出留下的临时
截图在后续截图请求时清理超过 24 小时的目录。详见 [ADR-0064](docs/adr/0064-webp-thumbnails-and-retained-candidate-previews.md)。

## 手动编辑器：本轮功能与验收清单

手动编辑器修改的是当前页面的静态 HTML。修改完成后由用户主动保存，保存仍会经过
统一 invoke 传输、修订号校验和浏览器渲染验证，再增量更新最终演示；编辑器不会自动修复页面内容。

人工修订的 `current.html` 保留工作区资源的 `file://` 路径，编辑器在内存中使用 APS 临时
地址展示。图片单独上传并按内容指纹存储，保存前将链接还原为本地引用；编辑上下文与保存
均经统一 invoke 层，按完整消息的 3 MiB 预算选择原始 JSON、一次 gzip + Base64 压缩或上传。页面优化按需准备截图，并读取同一
当前 HTML。旧修订在当前页进入新链路时提取内嵌资源，不批量重写作品。详见 [ADR-0040](docs/adr/0040-manual-page-revisions-edit-static-html.md)。

下面的编号对应本轮人工验收清单。`已实现`表示代码已经纳入当前分支，仍需在真实页面上复测
不同模板和缩放比例。

| 编号 | 需求 | 当前实现 |
| --- | --- | --- |
| 1 | 编辑页面打开速度 | 页面请求按 page id 缓存并合并重复请求；当前页就绪后只预取相邻页，避免一次加载整套页面。 |
| 2 | 保存速度 | 当前页与其他页草稿统一保存，整次请求去重；没有修改的页面不提交。失败保留剩余草稿，已成功页面不回滚。 |
| 3 | 未修改却显示“修改待保存” | 以规范化 HTML 快照比较实际内容，排除编辑器运行时节点和样式。 |
| 4 | 切页保存提示过于频繁 | 切页在当前会话暂存草稿，返回时恢复；退出时统一询问“保存 / 放弃 / 取消”。草稿不跨应用重载恢复。 |
| 5 | 不同字号显示差异不明显 | 字号控件写入明确的像素值，并按原有字号比例同步文本后代元素。 |
| 6 | 调整字号导致周围元素一起移动 | 字号调整只修改选中文本框及其文本后代，不改动其他页面元素的位置。 |
| 7 | 段落间距控件不清晰或无效 | “间距”面板同时提供行高、段后间距的滑杆与数字输入；段后距写入内部段落的 `margin-bottom` 或单段文本框的 `padding-bottom`，读取时使用同一来源。 |
| 8 | 文本框缺少明确拖动入口 | 选中 HTML 文本框后显示移动手柄；必须按住手柄持续拖动，松开后结束。 |
| 9 | 调整文本框大小后位置异常 | 缩放按元素布局尺寸和本地缩放比例计算，同时更新 `left/top/width/height`，避免位置跳变。 |
| 10 | 弹窗按钮视觉效果 | 弹窗操作统一使用编辑器按钮样式、状态色和键盘关闭行为。 |
| 11 | 缩放后顶部工具栏数值不完整 | 间距数字在独立面板内输入，字体和字号单行显示并固定保留下拉箭头。常用文字样式留在主栏，其他放不下的完整功能进入“更多”；缩放百分比始终显示当前值。 |
| 12 | 大比例页面工具栏布局不协调 | 工具栏保持单行并按内容收缩，单独占用顶部空间；画布缩放按剩余空间与真实留白计算。对齐按钮循环切换，填充、边框使用图标和统一的白色配色面板。悬停提示采用白底、13px 常规字重和 80ms 延迟，菜单字号统一。 |

清单中被划掉的“不同页面字体效果不一致”不属于本轮验收范围；字体选择、字号、行距和段后距
编辑属于本轮范围。SVG 文本继续使用原有 SVG 编辑流程，移动手柄当前主要覆盖 HTML 元素。

### 手动验收步骤

1. 打开“我的作品”的手动编辑器，确认当前页出现加载状态，页面就绪后可以编辑。
2. 连续切换相邻页面，确认页面能够显示且不会重复请求；切换未修改页面不弹保存确认。
3. 修改多页文字、字号或段落间距后切页，不应弹保存提示；返回各页应保留草稿。点击保存应保存所有已编辑页面，退出时只对剩余修改进行确认；连续跳页、保存期间切页和重复保存不能丢稿。
4. 选中文本框，按住移动手柄拖动；拖动期间选框和元素同步移动，松开鼠标后停止。
5. 从八个边角控制点调整文本框大小，确认元素位置不会突然跳动。
6. 在不同缩放比例下检查字号、行距、段后距、弹窗和顶部工具栏，确认控件可见且可操作。

详细设计和测试记录见 [`docs/manual-editor-save-state-fix.md`](docs/manual-editor-save-state-fix.md)
和 [`docs/manual-editor-move-handle.md`](docs/manual-editor-move-handle.md)。

## 同步 manifest

修改任一 Executa tool protocol manifest、版本号或 `executa.json` 里的 tool id 后，运行：

```bash
cd apps/ppt-app
npm run sync:tool-manifests
```

这个脚本会同步 app manifest、`executa.json` 发布元数据、package/pyproject
入口、marketplace metadata 和前端生成的 `src/api/toolManifests.generated.ts`。

## 普通 invoke 传输

所有普通调用通过 `src/runtime/invokeTransport.ts` 进入引擎的 `app_invoke_transport`，请求与响应都使用 **3 MiB（3,145,728 字节）**预算。预算内直接传；超限压缩一次；仍超限才使用带重试的 Host Upload，接收端自动恢复原始对象。业务层无需分别处理大纲、日志、HTML 或批量数据的上传。后端只公开统一网关、分块通道、PDF 异步导出和导出镜像异步发布四个入口，普通业务清单在 `executas/ppt-engine/invoke-tools.json`；旧传输工具与普通直连均已关闭，不兼容旧版前端。

`invokeAsyncAwait`、异步任务恢复和结果读取保持原协议。真实文件、会话图片附件、APS 持久化与图片/字体资源仍保留原用途。新前端要求 `ppt-engine >= 6.0.9`。协议、边界及跨域分块机制见 [ADR-0071](docs/adr/0071-unified-ordinary-invoke-transport.md)。

### 正式页面与恢复

`slides/<page_id>.html` 是唯一正式正文。人工保存也替换此文件；旧人工修订自动迁移，编辑器不再提供恢复原始生成版。预览和整份演示是可重建产物，缺失时从当前源码重建，不因历史验收指纹不同而阻断。已完成作品不会因预览暂时缺失被归到未完成。见 [ADR-0075](docs/adr/0075-single-authoritative-page-source.md)。
