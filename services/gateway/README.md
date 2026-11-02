# SlideForge Go Gateway

- 状态: active
- 最后验证: 2026-11-01

总纲中的骨架层过渡实现。当前提供统一 HTTP 入口、请求 ID、结构化日志、超时、优雅退出、就绪检查与 Node Capability API 反向代理。

## 边界

- `/healthz`：仅表示 Go 网关进程健康。
- `/readyz`：检查 `ENGINE_UPSTREAM_URL` 指向的 Node `/healthz`。
- `/internal/auth/*`、`/internal/billing/*`、`/internal/jobs`、`/internal/files`：Node 专用内部接口，必须携带 `X-Internal-Token`。
- `/admin/keys`：由 Go 直接处理 key 签发、列表与充值，继续校验管理员 token。
- `GET /decks/{id}/events`：Go 直接提供 SSE 任务快照与更新；`POST /decks/{id}/cancel` 记录协作式取消。
- `POST /decks/{id}/webhooks`：注册任务回调；HMAC-SHA256 签名、有界重试与 `job-webhooks.jsonl` 审计。
- 其他路径：透明代理到 Node，保留路径、查询、请求体、API key 和响应。
- `GET /decks/{id}/files`、`GET /files/{id}`：作品文件列表与按用户隔离的下载。
- Go 独占 API key、余额、计费台账、任务记录与已发布文件；Node 配置远程模式后不再读写这些元数据。生成工作区仍由 Node 管理。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `GATEWAY_PORT` | `8080` | Go 网关监听端口 |
| `GATEWAY_REPLICAS` | `1` | 大于 1 时强制校验共享 PostgreSQL／S3，并禁止并发迁移 |
| `ENGINE_UPSTREAM_URL` | `http://127.0.0.1:3210` | Node Capability API 地址 |
| `NODE_ENGINE_URL` | `http://127.0.0.1:3211` | 独立 Node 引擎健康检查地址 |
| `BRAIN_URL` | `http://127.0.0.1:3212` | Python 大脑层健康检查地址 |
| `GATEWAY_INTERNAL_TOKEN` | 空 | 内部接口令牌；空值时内部接口不可用 |
| `SLIDEFORGE_ADMIN_TOKEN` | 空 | 管理接口令牌；生产必填 |
| `SLIDEFORGE_DATA_DIR` | `../../data` | Go 本地数据目录及 JSON 迁移来源 |
| `DATABASE_URL` | 空 | 配置后认证计费与任务使用 PostgreSQL，不再写 JSON |
| `FILES_DATABASE_URL` | 空 | 独立文件库，缺省复用 `DATABASE_URL`；需同时配置 S3 |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` | 空 | S3 兼容对象存储地址、桶与区域 |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 空 | S3 访问凭证 |
| `S3_FORCE_PATH_STYLE` | `true` | 默认使用 path-style 对象地址 |
| `SLIDEFORGE_MIGRATE_JSON` | `false` | 首次启动执行一次 JSON 导入，完成后改回 false |

Node 还需设置 `SLIDEFORGE_BILLING_API_URL=http://127.0.0.1:8080/internal` 进入远程模式。

## 运行与验证

```bash
cd services/gateway
go run ./cmd/gateway
go test ./...
go vet ./...
```

先启动 Go 网关并签发 key，再启动 Node `npm run serve`，客户端统一通过 `http://localhost:8080` 使用现有 API。跨服务协议见 `contracts/openapi/gateway.yaml` 与 `contracts/openapi/auth-billing.yaml`。
