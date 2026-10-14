# Session 诊断（纯前端）

从同级 `test-session-app` 独立出来的纯前端 Anna App，用于在不同平台复现
Session 问题，检查并复制完整调用记录。页面保留 **Session 测试、LLM 测试、调用记录**
三个页签，以及 Session 工具策略、模型偏好、System prompt 和图片附件能力。

不包含批量测试、本地目录写盘或自带 Executa；无需构建、安装 `batch-writer` 或
`ppt-engine` 二进制，也不需要对应的 GitHub Actions。原版 demo 保持独立。

“纯前端”指 App 自身没有后端进程。Session、LLM、图片上传和可选的 Agent 工具仍由
Anna Host 提供，运行时需要有效的 Anna 连接及用户授权，不能离线双击 HTML 使用。
工具选择区中的文件、命令和浏览器工具是 Host 能力，不是 App 自带的后端；具体可用性
以 Session 工具目录显示的结果为准。

## 本地运行

在本目录执行：

```bash
npm install
npm test
npm run build
npm run validate
npm run dev
```

开发时使用 Anna App CLI 提供的入口，不另起独立前端服务器。安装到 Anna 宿主后，
运行静态前端无需目标机器另装 Node；上面的 Node/npm 命令仅用于本地开发和构建。

App slug 是 `session-diagnostics`，与原版 `test-session-lifecycle` 不同。
`app.json` 不声明 bundled Executa，`manifest.json` 的 Executa 依赖、App `tools.invoke`
权限和 Host `tools` 列表均为空。构建结果位于 `bundle/`，沿用 Anna App 的静态包发布方式。

## 复现并取得完整记录

1. 等待右上角显示“已连接 Anna”。
2. 在 Session 页选择工具策略、模型偏好，填写创建级 System prompt（可选），创建 Session。
3. 填写本轮 User prompt 和运行级 System prompt（可选），执行 `session.run`。
4. 打开“调用记录”，点击“刷新”，选择对应的 `session.run`，再点击“复制当前”。
5. 需要同时保留创建、运行和删除等上下文时，点击“复制全部”，将 JSON 保存到自己的文件中。

**“复制 Session 摘要”只包含整理后的诊断字段，不包含完整 `stream_frames`。**
排查逐帧差异时请复制“调用记录”中的完整 JSON。跨平台比较应使用相同提示词、
模型偏好和工具策略，并另外记录操作系统、Anna Host 和 CLI 版本；App 当前不自动采集这些版本。

## 记录内容与边界

- `request`：Session 调用参数及部分诊断字段。
- `response`：创建、删除或 LLM 响应；运行的初始响应保存在 `response.rpc_response`。
- `stream_frames`：匹配本次 `stream_id` 的 Runtime 事件，包含完整 `envelope`、帧序号、
  接收时间、相对耗时和帧间隔；不会因文本过长而主动截断。
- `metrics`：RPC、首帧、首段文字和完成耗时，以及帧数和最大帧间隔。
- `events`、`error`、`output_text`：操作时间线、错误及成功完成时提取的文字。

监听先于 `session.run` 发起，早于初始响应到达的帧会先暂存，再按返回的 `stream_id` 匹配。
这里记录的是前端收到的 Anna Runtime 事件，不包含平台内部或底层网络原始数据包。
收到 error 帧或 done 标志后，采集器停止监听；如果初始 RPC 失败或缺少 `stream_id`，
暂存帧不会写入对应运行记录。沿用原版行为，诊断版不改变 Session 调用或流结束语义。

“停止等待”仅释放前台操作状态，请求和帧采集会在页面后台继续；刷新或关闭页面会中断
监听，并可能丢失尚未落入 IndexedDB 的记录。下次加载会把遗留运行标记为 `interrupted`。
图片原始字节不写入调用记录，Session 图片保留实际附件 URL；LLM 图片内容以占位文字代替。

## 独立存储

- IndexedDB：`anna-session-diagnostics-frontend`，对象仓库 `call-records`。
- 表单配置：`session-diagnostics-app.settings.v1`。
- 保存的 Session UUID：`session-diagnostics-app.saved-session-ids.v1`。

这些名称与原版不同，即使两个 App 使用同一浏览器 origin，配置和调用记录也不会混用。
记录不会自动删除，可在“调用记录”中删除或清空。“清空全部”会在页面内显示确认区，
点击“确认清空”才执行删除；不使用会被 Anna iframe 沙箱拦截的浏览器 `confirm()`。
有请求运行时不可清空，存储操作失败会显示错误。关闭页面不自动删除平台 Session。
UUID 保存不代表会话跨 Host/开发服务重启后仍然有效。

## 目录

```text
session-diagnostics-app/
├── app.json                 # 独立 App 身份，无 bundled Executa
├── manifest.json            # 仅使用 Anna Host API
├── src/                     # Session、LLM、图片与调用记录前端
├── scripts/build.mjs        # 生成可独立分发的静态 bundle
└── test/                    # 请求构造、图片和诊断提取测试
```
