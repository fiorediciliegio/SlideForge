# APS 目录清理 Demo

批量清空当前 `anna-app login` 账号的个人 APS 目录，包括子目录中的文件。适合清理「文件与笔记」里的 `workspaces`，或其中某一个 `ppt-*` 目录。

## 启动

需要 Node.js 22+、uv 和已安装的 Anna CLI（开发验证使用 `anna-app 0.1.53`）。本 demo 不需要安装 npm 依赖。

```bash
cd /Users/leyouming/company_program/anna/anna-apps/apps/ppt-app/examples/anna-app-aps-cleanup-demo
npm run build
anna-app dev --storage aps
```

也可以使用 `npm run dev`，会自动构建并带上 `--storage aps`。打开 CLI 输出的带 token 的完整地址。如 5180 已被 PPT App 占用，使用 `anna-app dev --storage aps --port 5181`。

使用已有的 CLI 登录账号；需要切换时先运行 `anna-app login --host https://staging.anna.partners`。目标账号由登录凭据决定，`--user-id` 不是切换真实 APS 账号的方法。不要搭配 `--no-llm` 或 `--mock-llm`；APS bridge 需要登录，但本 demo 不调用模型。

## 使用

1. 停止向目标目录写入的 PPT 生成、恢复或同步任务。
2. 输入 `workspaces` 或具体目录，例如 `workspaces/ppt-20260719-143941`，点击「扫描目录」。不带开头的 `/`，不要填写网址或本地磁盘路径。
3. 核对目录、总文件数、总大小和文件列表。扫描会遍历所有分页，表格每页展示 100 个文件。
4. 在确认框输入页面显示的完整目录（例如 `workspaces/`），点击「清空预览中的文件」。删除会影响云端真实文件，本 demo 不提供撤销。
5. 查看进度，完成后重新扫描确认剩余文件。点击「停止」会在当前请求完成后停止；遇到错误立即停止并显示失败文件。重新扫描和确认后才能继续。

只删除扫描快照中的文件，不会自动删除扫描后新出现的文件。目录匹配始终带 `/`：`workspaces/a/` 不会匹配 `workspaces/ab/`。拒绝清空根目录、路径穿越和范围外响应。删除逐项携带预览的 ETag 作为 `if_match`，不自动重试，也不在缺少 ETag 时改为无条件删除。服务端对并发写入的最终保护取决于部署版本是否执行此条件，因此清理期间仍应停止其他写入任务。

该工具清理的是 APS Files 对象，不清理 KV、其他 App 私有空间或本地 PPT 工作区。APS 目录是文件路径形成的逻辑分组；文件删完后可能不再显示空目录。若还有独立的产品层文件夹记录，本 demo 不操作它们。APS 官方删除语义为软删除、立即释放配额，底层对象由平台后续回收；本 demo 没有恢复入口。

## 实现与排错

- 前端通过 `window.__ANNA_TOOL_IDS__["aps-cleanup"]` 获取 CLI 生成的真实 tool id，无硬编码回退。缺少映射时应在本目录启动 CLI；构建后需要让 CLI 重新生成 sidecar。
- Executa 只提供 `list_directory` 和 `delete_file`，通过官方 reverse RPC `files/list`、`files/delete`，每次显式指定 `scope: "user"`。它不读取登录文件或自行处理 token，认证由 CLI/Host 完成。
- App 和 Executa manifest 均声明 `aps.files`。不直接使用前端 `anna.files.*`：当前 CLI 的该路径固定到 App 空间，无法用于清理个人空间。
- `not_granted` / `forbidden_scope`：检查登录 host、账号和平台存储授权；不要关闭 strict capability gate。
- `precondition_failed`：文件在扫描后变化，重新扫描核对。
- 超时或网络错误：删除可能已生效，重新扫描核实，不要假设失败文件一定还存在。

## 验证

```bash
npm run check
npm test
npm run build
npm run validate
```

测试使用模拟 APS，覆盖分页、目录边界、确认、停止、失败处理，以及真实 Node stdio 插件的 user scope 和 invoke context 转发。不连接或删除真实账号文件。

官方参考：[文档入口](https://staging.anna.partners/llms.txt)、[本地 APS 开发](https://staging.anna.partners/developers/apps/local-dev.md)、[Executa APS](https://staging.anna.partners/developers/tools/executa-storage.md)、[Files reverse RPC](https://staging.anna.partners/developers/reference/executa-persistent-storage.md)。
