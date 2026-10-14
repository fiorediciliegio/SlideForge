# Session 生命周期测试 App

这个 Anna App 用于诊断前端 raw Agent session API 和 `llm.complete` 的调用结果与耗时：

- `agent.session.create`
- `agent.session.run`
- `agent.session.delete`
- `llm.complete`

页面分为 `Session 测试`、`批量测试`、`LLM 测试`、`调用记录` 四个页签。每次 API 操作都有独立的
`record_id`，完整请求、响应、错误、事件时间线和耗时会持久化到浏览器 IndexedDB。

LLM 测试页会将 `llm.complete` 的结果整理为易读摘要：显示最终文字、实际使用模型、输入/输出/总
token、停止原因、服务商、Provider 延迟和配额消耗；原始响应仍保留在“调用记录”页的完整记录中。

Session 页签底部的“选中 Session 的 RPC 诊断”会从已保存的 `session.run` stream frames
提取工具调用、工具输入/输出、最终文字返回、模型、首个 stream frame、首个文字和 token usage；
同时展示 Anna 返回的 Agent 调用数、缓存读取 token 与估算成本。工具输入/输出默认折叠，
打开单条调用后才展开完整内容；这里不再显示实时日志，便于直接按结构查看长调用。

Session 创建区支持三种工具权限策略：

- “全部”通过 `quotaCaps.inherit_host_tools: true` 继承 Host 完整工具集；
- “部分多选”通过 `inherit_host_tools: false` 和 `allowed_tools` 创建 Sandbox Session；
- “手动输入”支持用逗号、空格或换行输入多个 Sandbox 工具名称。

Session 测试和批量测试均允许不选任何工具：选择“部分多选”并取消全部勾选，或选择
“手动输入”并留空。创建时显式发送 `inherit_host_tools: false` 和 `allowed_tools: []`，
不继承 Host 工具。工具策略只在创建时生效，已有 Session 需要重新创建才能使用新策略。
批量输出仍由 App 调用自带的 `batch-writer` 写盘，不需要给 Session 开放文件工具。

连接 Runtime 后，App 会调用 `agent.session.catalog()` 显示工具是否可用及 `blocked_by`
诊断。Manifest 显式声明了当前官方 Sandbox registry，未知名称仍可能被平台静默丢弃。

Session 区域提供截图中模型的下拉选择。该选择会作为
`session.run.modelPreferences.hints[0].name` 发送；这是受用户模型授权约束的路由偏好，
并非 create 时的硬绑定。诊断区域会继续从运行帧显示实际使用的模型。

Session 区域把创建级和运行级 System prompt 分成两个独立输入：左侧创建配置中的非空
System prompt 只通过 `session.create.systemPrompt` 保存到新 Session；右侧运行区的非空
System prompt 只通过 `session.run.systemPrompt` 覆盖当前一轮，留空时沿用 Session 创建时的设置。
User prompt 通过 `session.run.content` 发送。选中 Session 的摘要会显示创建响应回显的
`system_prompt`，通过 UUID 恢复且缺少回显时则明确标记为未知。

## 批量测试

`批量测试` 页签并发发起多个独立会话，用户不再手动管理 Session。填写并发数、输出目录、
输出文件前缀和后缀，点击“开始批量测试”后，每一路流水线依次执行：

```text
session.create → session.run → 写输出文件 → session.delete
```

`session.delete` 放在 `finally` 中，运行失败也会释放 Session。并发数等于总运行次数：填 8
就是同时创建 8 个 Session 并同时跑 8 次 `session.run`，上限 64。所有并发共用同一份
User prompt、模型偏好和工具策略；创建配置和 `session.run` 配置与 Session 页签相互独立，
各自保存在 `localStorage`。

输出文件名为 `前缀_<第几次>.后缀`，内容是模型最终返回的纯文本。失败的那一次写成
`前缀_<第几次>.error.后缀`，内容为错误信息——序号保持连续，同时不看内容就能区分成败。
后缀可以留空（写出无扩展名文件），也可以写成 `txt` 或 `.txt`。同名文件会被覆盖。

批量测试不携带图片附件；需要测试识图请使用 Session 或 LLM 页签。批量运行没有“停止等待”入口，
运行期间输入框会禁用，需要中断时刷新页面即可（遗留记录会在下次加载时标记为 `interrupted`）。

进度区每一行对应一路流水线，显示阶段、`app_session_uuid`、run 耗时、总耗时、写入字节数和
输出路径；删除失败会显式标注“未能删除 Session”。完整 RPC 记录进入“调用记录”页签的
`批量测试` 类型（`category: "batch"`，`record_id` 以 `batch-` 开头），与手动调用区分开，
因此并发运行不会占用 Session 页签的单请求状态。

### 为什么需要一个自带的 Executa

本 App 是 `static-spa` 包，运行在 Anna Host 的 iframe 中，**无法写入任意本地目录**：
`a[download]` 只能落到浏览器下载目录，File System Access API 不保证在宿主 frame 中可用。
Executa 是本机普通进程，有正常的文件系统权限，因此批量输出通过 `tools.invoke` 交给自带的
`batch-writer` Executa 写盘（与 PPT App 通过 `ppt-engine` 落盘的做法一致）。

`executas/batch-writer/` 是一个极小的 Node stdio Executa，只有两个工具：

- `ensure_output_dir` — 校验绝对路径并递归创建目录。批量开始前调用一次，
  路径不合法时立刻失败，不浪费任何一次会话调用；
- `write_text_file` — 递归创建目录并写入一个 UTF-8 文本文件。

两个工具都要求 `dir` 是**绝对路径**：相对路径会按 Executa 进程的工作目录解析，
那个位置 UI 看不到、用户也猜不到。文件名必须是不含路径分隔符和 `..` 的纯文件名，
避免前缀或后缀打错时写到目录外面。单次调用的文本上限 4 MiB（受 stdio 行式通道限制），
超出会明确报错而不是静默截断。

这个 Executa 只用于开发环境，不发布，因此 `executa.json` 只声明 `local` 分发配置。
新增 Executa 后**首次需要重启 `anna-app dev`** 让开发环境注册它的 `tool_id`；
如果 `tools.invoke` 仍不可用，删除 `.anna/dev-app.json` 后重新启动，强制重新注册。

## 会话图片附件

在 Session 页签的“本轮图片附件”区域选择本地图片，点击“上传／重新上传图片”，
待全部上传成功后再运行会话。支持 PNG、JPEG、WebP 和 GIF，每次最多 6 张，
可以查看缩略图、移除单张或清空列表，并选择高精度、自动或低精度识别。
选中会话、手动 ID 和已保存 ID 三种运行入口都会携带当前图片列表；没有图片时仍为纯文本请求。

上传直接使用 Anna 前端 `upload.negotiate → PUT → upload.confirm`，指定
`purpose: image_input`，随后把短时 HTTPS 地址通过 `session.run.attachments`
交给模型。文件字节只在 PUT 请求中传输，不进入 JSON-RPC 或浏览器调用记录。
不依赖额外的 Executa，也不调用 `analyze_image`。

图片列表和上传地址只在当前页面内存中保留，直到移除、清空或刷新；重复运行会继续携带
列表中的图片。上传失败或图片地址有效期不足两分钟时，会阻止运行并提示重新上传。
没有过期时间元数据时直接使用当前地址；提交后的模型错误按原样保留，不自动重跑会话。

“调用记录”新增“图片上传”筛选，记录每张图片的上传阶段、结果及耗时。
会话运行记录保存实际附件参数，并通过 `image_upload_record_ids` 关联上传记录；
会话的 RPC、首帧和完成耗时不包含之前的上传过程。
历史诊断中会保存当时的图片地址，但不把它们恢复为可再次运行的附件。

真实识图需要 Anna Host 上传能力及支持视觉输入的模型，运行环境须支持 manifest 中的
`ui.host_api.upload: ["negotiate", "confirm"]`。上传能力缺失会明确报错，纯文本会话不受影响。

## LLM 图片附件

LLM 页签沿用 Session 的图片选择、缩略图、单张移除和清空样式，图片列表彼此独立。
支持 PNG、JPEG、WebP 和 GIF，测试页同样限制最多 6 张（这是本页限制，不代表 LLM API 上限）。
选择后自动在本地读取，显示“待发送”；读取失败时须移除后重新选择，不能静默丢弃图片继续调用。
重复调用会携带当前列表中的全部图片，刷新页面清空列表。

根据[官方 LLM Host API 文档](https://staging.anna.partners/developers/reference/host-api-llm.md)，
`llm.complete.messages[].content` 支持 MCP 图片块。当前实现将文字与各张图片分别放在有序的
`user` messages 中，图片采用 `{ type: "image", data: "<base64>", mimeType: "image/png" }`。
这与 Session 的上传 URL / `attachments` 协议不同：无需提前上传，也不传 Session 的 `detail`。
所选模型必须支持多模态，否则 Host 可能返回 `APP_PROVIDER_ERROR`；错误保留在调用记录中。

LLM 请求计时不包含选择时的本地读取。记录保留文件名、MIME 类型、大小和消息结构，
图片 `data` 用占位文字替代，避免把大段 base64 持久化到 IndexedDB；实际 RPC 仍携带完整图片。
真实 Host 的识图效果需要连接 Anna 后验证。

## 目录

```text
test-session-app/
├── manifest.json
├── app.json
├── src/
│   ├── app.js             # Anna 调用编排和 UI 状态
│   ├── anna-llm.js        # LLM 请求构造和 Runtime 调用适配
│   ├── session-config.js  # Session 工具策略、模型列表和请求构造
│   ├── batch-runner.js    # 批量输入校验、输出文件名和并发调度（纯逻辑）
│   ├── batch-writer-client.js # batch-writer Executa 的 tools.invoke 适配
│   ├── image-attachments.js # 图片校验、Host Upload 和本轮附件构造
│   ├── record-store.js    # IndexedDB 调用记录存储
│   └── record-utils.js    # 安全序列化、文本提取、耗时和 RPC 诊断提取工具
├── executas/
│   └── batch-writer/      # 开发用 Node stdio Executa：批量输出落盘
├── test/                  # 不依赖后端的纯逻辑单测
├── bundle/                # npm run build 后生成
└── scripts/build.mjs
```

## 记录内容

Session 操作会分别记录：

- `session.create` 的完整请求、响应和创建耗时；
- `session.run` 的 RPC 响应耗时、`stream_id`、`run_id`、首帧耗时、完成耗时、最大帧间隔、完整 stream frames 和输出文本；
- `session.delete` 的完整请求、响应和删除耗时。

批量测试的每一路流水线记录 `session.create`、`session.run`、`batch.write_file` 和
`session.delete` 四条记录，均带 `batch_index` 字段，`category` 为 `batch`。

LLM 操作会记录：

- system/user messages；
- 实际调用路径：`runtime.call` 或回退的 `runtime.llm.complete`；
- 传给 Anna Runtime 的超时时间；
- 完整原始响应、提取文本、model、usage、stop reason 和完整耗时。

记录使用 `performance.now()` 计算毫秒耗时，同时保存 ISO 时间。无法直接写入 IndexedDB
的错误、循环引用或特殊对象会转成 JSON-compatible（JSON 兼容）结构，不截断长文本或流帧。

## 停止等待

“停止等待”只解除当前页面的前台等待状态，不宣称取消平台请求。请求会继续在后台运行，
之后收到的响应或 stream frames 仍会更新到原来的 IndexedDB 记录。页面顶部会显示后台请求数量，
用户可以立即发起新的测试。

如果页面在请求完成前刷新或关闭，下次加载时会将遗留的 `running` / `waiting_stopped` 记录标记为
`interrupted`。

## 数据存储

- 完整调用记录保存在 IndexedDB 数据库 `anna-session-llm-diagnostics` 中，不自动删除。
- 表单配置和现有 `app_session_uuid` 列表保存在 `localStorage`。
- “调用记录”页签支持筛选、查看完整 JSON、复制、删除和清空。
- “清空全部”采用页面内二次确认，不依赖会被 Anna iframe 沙箱拦截的浏览器 `confirm()`。
  点击“确认清空”才会删除全部调用记录（含当前筛选之外的记录）；有请求或批量测试运行时不可清空，
  清空前会等待已有记录写入完成，存储失败会在页面显示错误。此操作不删除平台 Session。
- Chrome DevTools 中也可以通过 `Application → Storage → IndexedDB` 查看原始记录。

App 不会在页面关闭时自动删除 Session，方便观察 active session 和 ID 复用行为。`localStorage`
只保存 `app_session_uuid`，不会保存 `app_session_token`。本地 `@anna-ai/cli` harness 中，
`session.run` 仍依赖 harness 进程内存中的 token 缓存，只凭 UUID 不能跨 harness 重启复用。

## 构建与验证

```bash
cd examples/test-session-app
npm install
npm test
npm run build
npm run validate
```

本地交互测试由用户自行启动：

```bash
npm run dev
```

工具授权缓存问题需要 `@anna-ai/cli >= 0.1.48`。截至本次实现时，当前 npm registry 和
本机全局 CLI 仍是 `0.1.47`，论坛已经宣布修复但包尚未可安装；发布后需要重新执行
`npm install`。继续使用更老的 CLI 时，可删除项目中的 `.anna/dev-app.json` 后重新启动
`anna-app dev`，迫使开发授权重新注册，但论坛确认的完整自动修复仍以 `0.1.48` 为准。

未连接 Anna runtime 时，页面会显示错误并禁用 Session 和 LLM 操作，不提供 mock 响应。
