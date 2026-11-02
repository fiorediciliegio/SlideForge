# 真实基础设施联调

- 状态: done
- 最后验证: 2026-11-01（真实 PostgreSQL、S3 与双 Go 副本均通过）

## 覆盖范围

默认使用 Docker PostgreSQL 16 与本地 Moto S3 服务，MinIO 作为可选后端，运行真实集成测试：

- API key 与幂等扣费共享事务。
- 两个独立任务 Store 实例之间的 `LISTEN/NOTIFY` 更新。
- 持久 outbox 回调投递。
- PostgreSQL 文件元数据与 S3 对象上传下载。
- 两个 Go 副本共享余额、任务、SSE、webhook、文件对象与取消状态。

联调期间修复了 outbox worker 被内存快速通道提前退出的问题；outbox 模式现在只通过持久队列投递。

## 运行

要求 Docker 与 Docker Compose、Go 1.22+、Python 及 Moto 依赖。

```bash
npm run test:integration
```

脚本执行 `docker compose up -d --wait`，运行 `go test -tags=integration ./internal/integration`，最后无论成功失败都执行 `docker compose down -v` 清理临时实例和数据。

可用 `GO_BINARY`、`DOCKER_BINARY` 指定工具路径，或设置 `OBJECT_STORE_BACKEND=minio` 改用 MinIO。其他地址可用 `deploy/integration/.env.example` 中的环境变量覆盖。

双副本 HTTP 验收位于 `tests/server/multiReplicaSmoke.test.ts`，需同时提供 `SLIDEFORGE_DOCKER_BINARY` 和 `SLIDEFORGE_GO_BINARY`。
