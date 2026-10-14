# `presenton-template-engine-executa`

`presenton-template-engine` 是本仓库内部维护的 SlideForge Executa 工具包。它 vendored 了 Presenton template engine 能力，并提供 `ppt-engine` 插件入口。

这个包采用 ESM-only 构建和导出契约。不要为 runtime/SDK 产物重新引入 CommonJS 输出或 `require` 导出分支。`scripts/sea-bootstrap.cjs` 是 Node SEA 二进制启动器例外，不代表包级 CommonJS 支持。

## 角色

- 根据 Confirmed Outline（已确认大纲）准备独立 HTML Page Source（HTML 页面源码）并重建最小 Deck Manifest（演示文稿清单）。
- 根据 Page Source manifest 渲染 Deck HTML；App 页面只持久化静态 HTML，会话截图按需临时生成。
- 在后端受管 Chrome 中将整体静态 Deck HTML 直接转换为 `.pptx`。
- 提供 app-facing 工作区工具和任务状态机工具。
- 作为 SlideForge Executa 插件响应 JSON-RPC `describe`、`health` 和 `invoke`。

旧的模板发现、模板选择和模板 fork 能力仍暂时保留，供 PPT App 前端切换前使用，不属于新的创作主路径。

## Executa 插件

插件入口文件：

- `example_plugin.js`

对外协议清单来自本目录的 `manifest.json`，`describe` 只公布统一网关、分块通道、PDF 异步导出和导出镜像异步发布四个入口。普通业务参数定义保存在 `invoke-tools.json`，只能经 `app_invoke_transport` 调用；不能直接发送原业务工具名。两个清单分别与分发器校验，并一起打包。版本以 `manifest.json` 为准，真实 tool id 在 `executa.json`。

最小协议测试：

```bash
printf '%s\n' '{"jsonrpc":"2.0","method":"describe","id":1}' | node example_plugin.js 2>/dev/null
```

参数兼容说明：

- Discovery 相关工具里的 `local_roots` 这类 `array` 参数，除了直接传 JSON 数组，也兼容传字符串形式的 JSON 数组，例如 `"[\"/path/a\",\"/path/b\"]"`。
- 如果传入的字符串无法解析为字符串数组，插件仍会返回参数错误。
- 对外工具里的路径参数只接受绝对路径；如果传入相对路径，会明确返回对应参数不是绝对路径。

## 常用命令

```bash
npm install
cd ../../third_party/dom-to-pptx && corepack pnpm install --frozen-lockfile
cd ../../executas/ppt-engine
npm run build
npm run check
npm run test:unit
npm run start:plugin
```

## 构建产物

普通构建会先从仓库内 `third_party/dom-to-pptx/` 重建 browser bundle，再生成 ESM Node artifacts、browser runtime artifacts、类型声明、Authoring Kit 资源和 forkable templates 资源。旧 Template Group PNG 预览不再由 engine 生成或打包。vendored `dist/` 不提交；构建后的运行时复制到 `dist/vendor/dom-to-pptx/`。

`dist/` 是生成目录，不提交到 git。修改 `src/**` 后需要重新构建，插件入口会从构建后的 `dist/index.js` 加载 engine。

## 二进制打包

当前提供基于 Node.js SEA 的 SlideForge Binary 分发包打包脚本：

```bash
./build_binary.sh --test
```

生成产物：

- `bundle/<binary-name>-v<manifest.version>-<slideforge-platform-key>.tar.gz`
- `bundle/<binary-name>-v<manifest.version>-<slideforge-platform-key>.tar.gz.sha256`
- Windows 平台生成 `.zip` 和 `.zip.sha256`

说明：

- 这是当前平台构建。例如在 Apple Silicon macOS 上执行，产出 `darwin-arm64` 分发包。
- 大仓的 `publish-ppt-engine.yml` workflow 会构建 `darwin-x86_64`、`darwin-arm64`、`windows-x86_64` 和 `linux-x86_64`，然后通过 `apps push` / `apps cut` 的 Direct Upload（直接上传）流程发布。`ppt-engine` 暂不发布 `linux-aarch64`，其他 Executa 的平台范围不受影响。
- `bundle/` 只保留最终 archive 和 sha256，不再保留中间裸二进制。
- archive 内部包含 bootstrap-only SEA（仅含启动器的 SEA）`bin/ppt-engine`、原样安装的 `lib/app/` 应用运行时、`lib/browser/` 下与固定 Puppeteer revision 匹配的完整 Chrome for Testing、`data/` 和顶层 binary distribution `manifest.json`。运行时不要求目标机器预装 Node.js 或 Chrome，也不会首次联网下载浏览器。
- `manifest.json` 名称有两层含义：本目录下的 Executa tool manifest 是 `describe` 的来源；archive 顶层 manifest 是 SlideForge Binary 分发入口配置。
- 打包脚本的 `--test` 会解压最终 archive，校验 binary distribution manifest、`lib/app/`、vendored dom-to-pptx bundle 和浏览器资源，并发启动多个 `describe` 进程，并通过真实 JSON-RPC 调用完成 HTML 与 PNG 冒烟。
- SEA 只提供 Node.js runtime 和最小启动器；启动器通过 `process.execPath` 定位相邻的 `lib/app/example_plugin.js` 并直接加载。应用文件由 SlideForge Binary 安装过程随 archive 一次解压，不再在首次启动时生成 SEA 二次解包缓存。
- `linux-x86_64` 的运行基线是 Ubuntu 22.04 兼容的 glibc Linux。Binary 提供 Chrome，但不捆绑 glibc、NSS、GTK、GBM 等系统动态库，也不支持 Alpine/musl 或缺少 Chrome 基础运行库的极简镜像。

## 主要工具能力

### Workspace Authoring

新的创作主路径使用以下工作区结构：

```text
workspace/
├── outline.json
├── manifest.json
├── visual-master.html
├── aesthetic-reference-selections.json
├── template-reference/
│   ├── preset.json
│   └── html/
└── slides/
    └── <page_id>.html
```

- Confirmed Outline 持有稳定、与页序无关的 `page_id`。
- 每个 `page_id` 始终对应一个完整、可运行的 `./slides/<page_id>.html` Page Source。
- `manifest.json` 包含顶层 `title`、可选 `aspect_ratio`（缺失时默认 16:9），以及每页的 `id`、`source`；比例从作品需求投影。
- Page Source 是页面可见内容和布局的唯一渲染来源，不再配套 `data/*.json`。
- `visual-master.html` 是跨页视觉母版；`template-reference/` 是需求确认时复制进 Workspace 的不可变模板 HTML 快照。
- 模板选择只通过 app-facing 工具读取 `path`、`description` 等有界元数据；选定后再按 `path` 读取一份 HTML，不通过 RPC 返回完整模板快照。
- Agent Session 只返回 HTML，不直接写磁盘；PPT App 负责提取原始 HTML，并通过统一 invoke 层调用引擎持久化。
- 页面在受管 Chrome 中执行一次并静态化；截图可重新打开静态文件，最终 Deck 不重新执行 Page Source。

插件暴露了模板参考目录与单页读取、视觉母版、逐页 HTML、美学参考选择、页面静态化和最终 Deck 组合所需的 app-facing 工具。旧 Authoring Kit、Page Plan（页面计划）和 Theme Token 工具暂留在底层，但 HTML v1 主路径不调用它们。

### 图片候选和描述准备

共享研究上下文同时返回正式素材目录及完整的 APS 图片候选引用；候选从首次研究进度和独立按页搜索任务归一化读取，按 SHA-256 合并。仅成功获取的受支持原图可人工采用，AI 推荐状态不限制人工选择；临时 URL 不持久化，未采用原图不全量下载。

空描述图片可保存大纲、预览和准备原图附件。普通业务工具 `app_outline_image_descriptions` 支持按素材标识写入客观描述及读取、更新同次生成已处理的内容哈希，复用各素材目录的写入队列。影子工作区校验活动事务并与提交、放弃操作串行，已放弃运行拒绝迟到写入；影子变更只在生成提交后成为正式快照内容。候选、人工采用和正式描述变更标记作品快照待同步。

本工具仍经统一调用网关分发。描述会话由前端生成准备服务负责，最多 6 张一批，失败继续生成；引擎不调用模型。详见 [ADR-0077](../../docs/adr/0077-image-candidates-and-deferred-descriptions.md)。

### Deck HTML 渲染

`buildDeckHtmlFromManifest` 读取 `manifest_path` 指向的 JSON 文件，把结果写到 `output_dir`，并返回输出文件路径和基础元数据。它会输出整体的 `*-deck.html`，并为每一页输出浏览器渲染后的 PNG 截图，供显式需要图片的底层调用者使用。PPT App 的普通生成、恢复和候选流程使用关闭截图的单页静态化入口，不调用这条持久化图片路径。

Page Source HTML 是从权威 Page Source 重建的机器产物，不应直接编辑。按照 [ADR-0021](../../docs/adr/0021-persist-browser-rendered-static-html-snapshots.md)，所有 manifest 渲染入口内部先执行 Page Source，再只把浏览器完成渲染后的静态 DOM HTML 写入正式输出。

- 单页 HTML 和 Deck HTML 的可见 DOM、Tailwind 最终 CSS、Recharts SVG 等内容在文件中已经存在，重新打开时不执行 React 或 Page Source。
- 普通图片、字体和其他资源链接保持原有引用语义，不额外复制到新的资源目录。
- Deck HTML 不含预览 viewer；`#presentation-slides-wrapper` 直接包含纵向、无间隙排列、统一使用作品画布尺寸的 slide shell。
- Tailwind 使用随 ppt-engine 和 SEA 二进制发布的固定 `@tailwindcss/browser` 4.3.2，正式 HTML 不加载 Tailwind CDN 或携带 Tailwind runtime。
- 截图和 PPTX 导出从重新打开的同一静态 HTML 生成。

`manifest_path` 和 `output_dir` 必须是绝对路径。源码模式需要本机有可用的 Chrome / Chrome for Testing；SlideForge Binary 模式默认使用 archive 内置浏览器，缺失或启动失败时直接报错，不隐式回退系统 Chrome。

### App 预览与会话截图

`app_get_workspace_page_html` 读取当前静态 HTML，省略 `page_id` 时读取第一页封面；候选预览同时传
`batch_id` 与 `candidate_id`。预览版本包含 HTML 和本地图片、字体字节，资源映射及统一 invoke 传输预算
保持一致。原来的封面、页面图片工具已移除；列表统一通过 `app_get_workspace_page_thumbnail`
获取当前页面的 WebP，省略页面标识时读取第一页。每页小图长边不超过 640 像素，按 HTML 和
本地资源指纹复用，成功更新后删除该页旧图。普通逐页生成提前准备，其余缺失或新版本按需补齐。
图片存于 `output/page-thumbnails/`，不保存整页 PNG；普通调用返回 WebP
数据地址，完整响应由统一 invoke 层按 3 MiB 预算决定是否压缩或上传。缩略图不作为页面生成成功的必要条件。

页面优化、布局修复和一键美化使用 `withTransientPageScreenshot`：在系统临时目录截图，上传回调
完成或失败后均删除本地文件，并检查截图前后的版本。人工保存仍做浏览器验证，但不写 PNG。
`Page Progress` 使用 `snapshot_source_sha256`，读取时兼容旧截图版本字段。

打开旧作品且页面 HTML 齐备后，只清理已知整页截图和 WebP 派生物；不扫描正文素材或改写历史 ZIP。
新的每页 WebP 缓存不在历史图片清理范围内。详见 [ADR-0064](../../docs/adr/0064-webp-thumbnails-and-retained-candidate-previews.md)。

### PPTX 导出作业

App 通过 `app_start_pptx_export` 启动作业，并轮询 `app_get_pptx_export_status`。启动参数可选传入从 1 开始的 `page_numbers`；省略时导出完整演示。引擎验证 Final Deck Render 记录的 `deck.html`，在受管 Chrome 中逐页生成 PPTX，再把选中页面按原顺序合并并发布为 `output/deck.pptx`。状态持久化在 `output/pptx-export.json`，包含逐页渲染和合并进度；单进程 FIFO 并发度为 1。缺失或非法 Deck HTML、非法页码或不可读取的图片资源会使作业失败，不会自动重建 Deck 或回退旧 PPTX。

### 模板 fork

> 过渡能力：只服务于尚未切换的旧 PPT App 流程，不是新 Workspace Authoring 主路径。

`forkTemplateGroup` 会把一个内置模板组 fork 到指定目录，生成一套可本地继续修改的模板工程。

输出内容包括：

- `slides/*.tsx`
- `group.json`
- `manifest.json`
- `catalog.json`，如果原模板组提供
- `data/`，如果原模板组提供

输入参数：

- `template_group`: 内置模板组 id
- `out_dir`: 输出目录，必须是绝对路径
- `manifest_title`: 可选，生成 `manifest.json` 时使用的标题
- `overwrite`: 可选，是否覆盖非空输出目录，默认 `false`

fork 后不执行 `npm install`。生成的 TSX 模板由引擎二进制内置运行时解析。

## 内部 API 维护说明

内部 engine API 主要分为：

- 模板摘要、模板详情和主题预设查询。
- 单页 HTML、整 Deck HTML 和 standalone Deck HTML 构建。
- 本地模板编译和 runtime bundle 生成。
- 整体静态 Deck HTML 到 PPTX 的内部转换。
- 工作区 artifact 读写、PPTX 导出作业和任务状态机。

这些 API 是本仓库内部维护边界，不是公共 npm SDK 契约。新增调用方时优先通过插件 tool 或 App 的 `src/api/PptBackend` 适配层接入。

## 服务端入口

CLI 入口：

```bash
node dist/cli.js
```

内部 ESM 调用方也可以从 server subpath 导入 server 启动函数。该 subpath 只提供 ESM 导出，不提供 CommonJS `require` 导出。

可用接口：

- `GET /healthz`
- `GET /template-groups`
- `GET /themes`
- `GET /template-info?groupId=<groupId>`
- `POST /render-slide`

## 验证要求

修改 engine 构建、导出、路径解析或插件入口后，至少运行：

```bash
npm run build
npm run check
npm run test:unit
printf '%s\n' '{"jsonrpc":"2.0","method":"describe","id":1}' | node example_plugin.js 2>/dev/null
```

`./build_binary.sh --test` 用于二进制打包冒烟，耗时较长，可按需要由人工单独运行。

## 普通 invoke 传输协议

自 6.0.9 起，App 普通调用使用 `app_invoke_transport`，参数为业务工具名 `tool` 和版本化 `payload`。`invoke-transport.js` 在浏览器与 Node 共用：完整消息不超过 3 MiB 时直接传 JSON；超限尝试一次 gzip + Base64；仍超限上传原始 JSON。引擎在原调用上下文中完成结果编码与上传，保留 `invoke_id`，仅重试存储事务，不重放业务工具。

`invoke-transport-server.js` 提供有界下载与 `app_invoke_transport_channel` 分块中转。普通调用的帧直接写入标准输出并受 3 MiB 预算约束；只有白名单中的两个异步入口继续走原文件指针及 `app_stdio.js`。`invokeAsyncAwait`、异步恢复与结果读取不迁移，其他业务直连在执行前被拒绝。

普通调用的业务处理器返回原始对象、HTML 或 Markdown，不创建业务专用大内容上传。APS 资源映射、持久化和需要 HTTPS 地址的会话附件保持原样。详细决定见 [ADR-0071](../../docs/adr/0071-unified-ordinary-invoke-transport.md)。
