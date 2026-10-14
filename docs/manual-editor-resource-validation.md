# 人工编辑器本地资源链路验证

2026-09-17：人工修订使用本地资源路径持久化，浏览器通过 APS 临时地址展示。协议与资源约束见 [ADR-0040](adr/0040-manual-page-revisions-edit-static-html.md)。

## 已通过的定向验证

- 前端与适配器共 45 项：原文、gzip + Base64、上传三档传输；完整调用与响应的 48 KiB 预算；中文和 JSON 转义；解压限额；资源刷新分批与完整性；图片、候选图、CSS、SVG、字体、模板资源的本地化；过期链接保存；刷新不改变快照；字体地址与到期时间一起更新；页面优化上下文；中英文文案键一致。
- 后端人工修订和预览共 22 项：工作区路径归属、资源去重、图片格式和大小、旧 Base64 提取、移除旧智能体副本、修订冲突、并发发布、预览资源签发和三档响应。
- 真实渲染集成 1 项：创建 HTML 页面，保存带图片的人工修改，重新打开并检查落盘无图片 Base64，验证截图，拒绝旧修订号，再生成整份演示 HTML、导出 PPTX/PDF，恢复原始页面并确认原始源码未变。

真实渲染集成发现并修复了恢复原始页时的路径切换问题：增量更新整份演示的指纹必须使用恢复后的页面路径，不能继续读取已经删除的人工修订路径。

## 运行命令

在 `apps/ppt-app` 执行前端定向测试：

```sh
node --import tsx/esm --test tests/api/hostPptBackend.test.ts tests/api/manualPageTransport.test.ts tests/manual-page-editor/resources.test.ts tests/manual-page-editor/fonts.test.ts tests/manual-page-editor/localization.test.ts tests/deck-generation/pageGenerationRunnerAttachments.test.ts tests/deck-workspace/pageHtmlPreview.test.ts
```

在 `apps/ppt-app/executas/ppt-engine` 执行后端定向测试和真实渲染集成：

```sh
node --import tsx/esm --test test/manual-page-revisions.test.ts test/page-html-preview.test.ts test/app-workspace/html-authoring-generation.test.ts
```

最后按 AGENTS.md 运行引擎构建、应用构建和严格校验，并运行两端类型检查。上述命令不启动开发服务器。

## 全量回归的限制

全量测试已运行，但尚未全绿。除已修复的人工编辑旧接口用例外，仍有旧 TSX/Authoring Kit 协议、旧资料字段和界面源码结构断言等失败。编辑器移动、文本、缩放、工具栏相关的 10 项失败已经在临时目录中用原始 HEAD 重现，本轮未改动这些旧用例或扩大功能范围。

集成测试快速连续执行 PDF 导出与恢复时，异步工作区快照可能报告旧修订文件已删除；这不影响本次保存、导出和恢复的结果，快照并发问题尚未在本轮解决。

## 仍需真实宿主界面验收

自动化测试中的 APS 使用模拟响应，真实渲染使用本地资源。还需在用户已启动并登录 APS 的 App 中检查实际跨域下载、签名过期、字体加载，以及插图、换图、裁剪、撤销、重做和切页的交互。验收应使用测试作品，保持既有作品不变；无需为此引入其他开发服务器。
