# SlideForge 跨服务契约

- 状态: active
- 最后验证: 2026-11-01

本目录是 Go 骨架层、Node 引擎层和 Python 大脑层之间的协议事实源。`src/contracts/` 仅服务于现役 TypeScript 内部边界，两者职责不同，不互相导入。

## 规则

1. 先修改契约，再实现生产端与消费端；禁止 UI 或客户端专用业务后门。
2. 外部字段使用 `snake_case`，内部语言可做映射，不改变字段语义。
3. `deck_id` 与后续 `job_id` 是 opaque 字符串，客户端不得解析路径或时间。
4. 错误统一包含 `error`、`error_code`、`retryable`，可选 `details`。
5. 不兼容变更必须升级契约版本并保留迁移期，不直接覆盖已发布语义。

## 文件

- `openapi/gateway.yaml`：Go 网关过渡 API，包括健康检查、Deck 创建／查询／导出和统一错误。
- `openapi/auth-billing.yaml`：Node 调用 Go 的内部认证、结算、扣费、用量与台账协议。
- `openapi/jobs.yaml`：Go 任务仓库内部协议，以及公共 SSE 进度、协作式取消和签名 webhook 协议。
- `openapi/files.yaml`：Node 内部文件发布、作品文件列表和按用户隔离的公共下载协议。
- `openapi/engine.yaml`：独立 Node 引擎的 HTML 校验、预览渲染和 PPTX／PDF 导出协议。
- `openapi/brain.yaml`：Python 大脑层的 Prompt 编排和文档分块协议。
