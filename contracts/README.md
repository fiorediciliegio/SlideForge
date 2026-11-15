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
- `openapi/engine.yaml`：Go 私有快照、持久引擎任务/租约和交付协议；独立 Node worker 执行检查、预览与导出。
- `openapi/brain.yaml`：Python 大脑层的 Prompt 编排和文档分块协议。
- `openapi/agent.yaml`：单总控 Harness 的生成选项、大纲编辑/确认、场景纠正、续改/回退，以及 Go 执行/预算和 Node 工具协议。模型成本预算与产品点数独立，模型与检查点正文存 Node artifact，Go 保存执行引用和回执。

引擎/异步导出契约已升级至 0.2.0。本期为用户本机方案升级，Web/WPS 随服务同步升级，不保留传递本地目录的旧引擎接口；决策见 ADR-0081。
