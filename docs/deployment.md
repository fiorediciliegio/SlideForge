# SlideForge 部署运行手册

> 面向协作者/部署者：不看代码也能把系统跑起来并发出第一个计费 key。
> 版本：2026-10-30（对应 M2 交付）

## 一、环境要求

- Node.js ≥ 22（本机验证版本 v24）
- Chrome 或 Edge（渲染/导出用）：默认自动探测常见安装路径，也可显式指定
- 一个 OpenAI 兼容模型端点（DeepSeek / Kimi 等均可）

## 二、首次安装

```bash
git clone https://github.com/xiaoyuankele/SlideForge.git slideforge
cd slideforge
npm install

# 引擎依赖（M0/M1 当前为进程内直调引擎模块，需引擎 node_modules）
cd executas/ppt-engine && npm install && cd ../..
```

**注意：vendor 导出 bundle**。`src/pptx-export/vendor/dom-to-pptx/` 是构建产物、不入 git。若导出时报 `ENOENT ... dom-to-pptx.bundle.js`，需执行引擎构建：

```bash
cd executas/ppt-engine && npm run build && cd ../..
```

## 三、环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | 模型 key（DeepSeek 等） |
| `OPENAI_BASE_URL` | 可选 | 默认 `https://api.deepseek.com`；Kimi 用 `https://api.moonshot.cn/v1` |
| `OPENAI_MODEL` | 可选 | 默认 `deepseek-chat` |
| `CHROME_PATH` | 可选 | Chrome/Edge 可执行文件路径 |
| `SLIDEFORGE_WORKSPACE_DIR` | 可选 | 引擎工作区，默认系统临时目录 |
| `PORT` | 可选 | HTTP 服务端口，默认 3210 |

## 四、三种使用方式（同一能力层）

### 1. CLI（本地一次性生成）

```bash
OPENAI_API_KEY=sk-... npm run generate -- \
  --brief "Q3 销售复盘：销售额 1200 万，同比 +15%" --pages 8 --out artifacts/decks/q3.pptx
```

### 2. MCP（AI 客户端对话内调用）

启动：`OPENAI_API_KEY=sk-... npm run mcp`

Claude Desktop 类配置：

```json
{
  "mcpServers": {
    "slideforge": {
      "command": "node",
      "args": ["--import", "tsx/esm", "<绝对路径>/slideforge/src/mcp/server.ts"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

工具：`create_deck` → `get_deck_job` →（可选 `regenerate_page` / `get_deck_preview`）→ `export_deck`

### 3. HTTP（远程客户端 / 团队）

```bash
OPENAI_API_KEY=sk-... npm run serve   # http://localhost:3210
```

```bash
# 创建（带 key 时走计费）
curl -X POST http://localhost:3210/decks \
  -H "content-type: application/json" -H "X-API-Key: <客户端key>" \
  -d '{"brief":"产品发布 PPT","page_count":8}'

curl http://localhost:3210/decks/<deck_id>                 # 进度
curl "http://localhost:3210/decks/<deck_id>/preview?pages=1" -o p1.jpg
curl -X POST http://localhost:3210/decks/<deck_id>/export -H "X-API-Key: <客户端key>" -d '{}'
```

## 五、计费与 key 管理

- **未创建 `data/api-keys.json` = 本地开发模式**：全部放行、不计费；
- 一旦签发第一个 key（自动生成该文件），HTTP 接口立即启用鉴权 + 点数结算。

## 五-A、生成入口参数（M4/M5 新增）

| 参数（HTTP `POST /decks` / MCP `create_deck`） | 用途 |
|---|---|
| `brief` | 一句话需求（必填） |
| `attachment_base64` + `filename`（HTTP）/ `source_text`（MCP） | 文档附件，作为唯一事实来源 |
| `brand_id` | 自有品牌模板（色/字/logo），`POST /brands` 上传 pptx+logo 获得 |
| `template_id` | 98 套内置预设之一，`GET /templates` 查看 |
| （都不传风格） | 自动模板推荐（确定性规则，零选择启动） |

相关接口：`POST /brands`、`GET /brands`、`GET /templates`；
`regenerate_page` 响应含 `drift_report`（改动可审计的确定性 diff）。

## 五-B、计费与 key 管理

```bash
# 签发（初始 200 点）
node --import tsx/esm scripts/keys.ts issue --name "张三" --points 200

# 充值
node --import tsx/esm scripts/keys.ts recharge --key sk-xxx --points 100

# 列表
node --import tsx/esm scripts/keys.ts list
```

- 价目表：`src/billing/index.ts` 的 `DEFAULT_PRICING`（input 0.2 点/K tokens、output 0.8 点/K、导出 10 点/次）
- 台账：`data/billing/ledger.jsonl`（每笔含 tokens、点数、余额）
- `data/` 已 gitignore，key 与台账不会进仓库。

## 六、生产化配置（2026-11-01 更新）

- **启动前置条件**：`NODE_ENV=production` 时必须配置 `SLIDEFORGE_ADMIN_TOKEN`，并在启动前执行 `node --import tsx/esm scripts/keys.ts issue --name "首位用户" --points 200` 创建至少一个 API key；否则服务拒绝以无鉴权模式启动。
- **管理员鉴权**：`/admin/*` 使用 `X-Admin-Token`。管理员 token 与客户端 key 分开管理，不要使用同一个值。
- **用户隔离**：开启计费后，deck、品牌模板和远程 MCP 都校验 API key 归属。旧的未归属数据不会自动对公开用户开放。
- **容量保护**：生成、重生成、预览、换肤和导出共享有界队列。保持 `DECK_JOB_CONCURRENCY=1`、`DECK_CONCURRENCY=2` 的保守起点，不要直接提高并发。
- **密钥存储**：API key 仅保存 SHA-256 哈希，原始 key 只在签发时显示一次；旧明文文件会在读取时自动迁移。
- **导出幂等**：相同内容重复导出复用回执且不重复扣费；客户端重试可额外携带 `Idempotency-Key`。
- **请求保护**：默认请求体上限 32 MiB、每身份 120 请求/分钟、20 次创建/小时，可通过 `deploy/env.example` 中参数调整。
- **MCP 远程接入**：`POST /mcp` 必须带与 REST 相同的 `X-API-Key`，远程客户端只能操作自己的任务。
- **网络**：仅通过 HTTPS 反向代理暴露服务；3210 不对公网直接开放。只有位于受信代理后才设置 `SLIDEFORGE_TRUST_PROXY=true`。
- **持久化**：`SLIDEFORGE_DATA_DIR` 和 `artifacts/decks` 必须在持久磁盘并定期备份。当前 JSON 与本地文件方案只允许单实例，禁止多副本共享启动。

完整架构和 1 万用户扩容路线见 `docs/architecture-10k.md`。

## 六-A、P1 Go 网关（过渡）

1. 配置 `GATEWAY_INTERNAL_TOKEN`、`SLIDEFORGE_BILLING_API_URL=http://127.0.0.1:8080/internal`、`SLIDEFORGE_JOB_API_URL=http://127.0.0.1:8080/internal/jobs` 和 `SLIDEFORGE_FILE_API_URL=http://127.0.0.1:8080/internal/files`，两个服务共享内部 token 与 `SLIDEFORGE_DATA_DIR`。
2. 安装 Go 1.22+，先启动网关：`npm run serve:gateway`，默认监听 8080。
3. 通过 Go 管理接口签发首位用户 key；旧明文 key 文件会由 Go 自动迁移为哈希。
4. 再启动 Node：`npm run serve`，继续监听 3210。远程模式下 Node 只调用 Go，不读写 API key、余额、台账或任务快照文件。
5. `GATEWAY_PORT` 控制网关端口；`ENGINE_UPSTREAM_URL`、`NODE_ENGINE_URL`、`BRAIN_URL` 分别指向 Node 主服务、独立引擎和 Python。`GET /healthz` 检查网关，`GET /readyz` 逐一检查三个上游并指出失败服务。
6. 客户端统一访问 8080。Go 直接处理 key 管理、任务查询、SSE 进度与取消，其他 API 透明代理到 Node。Node 导出后发布文件，Go 提供 `GET /files/<file_id>` 鉴权下载与 `GET /decks/<deck_id>/files` 列表；导出回执可包含 `file_id`、`download_url`。
7. 本地单进程开发可不设置远程 API URL，继续使用 Node 原本地实现；生产远程模式不得同时让两个进程写同一计费或任务文件，文件对象与元数据只归 Go 文件服务。

跨服务接口以 `contracts/openapi/gateway.yaml`、`contracts/openapi/auth-billing.yaml`、`contracts/openapi/jobs.yaml` 和 `contracts/openapi/files.yaml` 为准。

## 六-C、P1-D1 Node 独立引擎服务

1. 配置 `ENGINE_PORT=3211`、`SLIDEFORGE_DECKS_ROOT=<作品根目录>` 与现有 `GATEWAY_INTERNAL_TOKEN`，执行 `npm run serve:engine`。
2. 引擎只处理确定性页面校验、预览和导出，不承接用户、计费、任务或文件元数据；`GET /healthz` 可用于进程检查。
3. 内部接口为 `POST /internal/engine/validate-page`、`POST /internal/engine/preview`、`POST /internal/engine/export`，均要求 `X-Internal-Token`。
4. `runDir` 必须是 `SLIDEFORGE_DECKS_ROOT` 的直接子目录，`outPath` 必须直接位于对应 Deck 工作区内，禁止路径穿越。
5. 引擎契约见 `contracts/openapi/engine.yaml`。现有 Capability API 保持兼容，后续由 Go 按内部契约调用，不新增客户端专用业务接口。

## 六-D、P1-D2 Python 大脑层

1. 配置 `BRAIN_HOST=127.0.0.1`、`BRAIN_PORT=3212` 与现有 `GATEWAY_INTERNAL_TOKEN`，执行 `npm run serve:brain`。
2. `POST /internal/brain/outline` 由 Python 调模型并校验大纲，usage 回到原计费上下文；`POST /internal/brain/outline-prompt` 与 `POST /internal/brain/page-prompt` 分别编排大纲和单页消息；`POST /internal/brain/document-extract` 提取 DOCX／PDF／TXT，分块接口继续可用。
3. Python 不直接访问 Chrome、用户、计费或作品存储；跨服务只使用内部 API。契约见 `contracts/openapi/brain.yaml`。
4. Node 配置 `SLIDEFORGE_BRAIN_API_URL` 后使用远程大纲与附件能力，远程失败不静默回退；PDF 提取需安装 PyMuPDF。
5. `POST /internal/brain/image-drift` 提供确定性像素偏离度，`POST /internal/brain/evals/run` 运行大纲、文档和图像夹具；图像分析需安装 Pillow，Node 客户端复用同一指标。

## 六-E、P2-A 认证计费 PostgreSQL

1. 准备 PostgreSQL 数据库与最小权限账号，设置 `DATABASE_URL=postgres://user:password@host:5432/slideforge`。Go 启动时自动创建认证计费表。
2. 首次从 JSON 迁移前备份 `SLIDEFORGE_DATA_DIR`，设置 `SLIDEFORGE_MIGRATE_JSON=true` 启动一次；迁移标记与数据同事务提交，完成后改回 `false`。
3. 启用 PostgreSQL 后，Go 不再写 API key 或台账 JSON，Node 仍只通过内部 API 使用认证计费，不直接连接数据库。
4. 同一 `DATABASE_URL` 与迁移开关也会迁移任务快照；任务更新与通知、outbox 同事务，SSE 跨实例使用 `LISTEN/NOTIFY`。
5. 文件域可用 `FILES_DATABASE_URL` 独立配置，缺省复用 `DATABASE_URL`。启用后必须同时配置 `S3_ENDPOINT`、`S3_BUCKET`、`S3_REGION` 和访问凭证，否则 Go 拒绝启动。
6. 历史 `files.json` 与本地对象在迁移开关启用时逐个上传到 S3，公共下载由 Go 鉴权后从 S3 读取，不再依赖共享目录。多实例门禁见 `docs/plans/20261101-P2生产存储.md`。

## 六-F、P2-D Go 多副本门禁

1. 保持 `GATEWAY_REPLICAS=1` 时可直接单实例运行。增加到 2 前，必须先完成认证计费、任务和文件 PostgreSQL 与 S3 配置，并将 `SLIDEFORGE_MIGRATE_JSON` 设为 `false`，否则 Go 拒绝启动。
2. 停止独立 `slideforge-gateway`，再启动模板副本：`systemctl start slideforge-gateway@8081 slideforge-gateway@8082`。实例端口来自 `/etc/slideforge/gateway-<端口>.env`。
3. 按 `deploy/nginx-slideforge.conf` 配置 HTTPS 与 `least_conn`，客户端只访问负载均衡地址；两个副本共用内部 token 和上游 Node 地址。
4. Node Capability、导出幂等、内存限流和 Chrome 工作区继续单实例，不启动第二套生成工作节点。Node 服务或共享存储未就绪时，不要增加副本。

## 六-G、真实基础设施联调

准备 Docker 后执行 `npm run test:integration`。脚本会临时启动 PostgreSQL 16 与 Moto S3（可切换 MinIO），验证共享扣费、两个任务 Store 实例的 `LISTEN/NOTIFY`、持久 outbox、S3 文件读写和两个 Go 副本的共享行为，最后自动删除容器与临时数据。详见 `deploy/integration/README.md`。

## 七、验证清单（部署后自检）

1. `npm run generate -- --brief "测试" --pages 2 --out artifacts/test.pptx` 出文件；
2. `curl http://localhost:3210/healthz` 返回 ok；
3. MCP smoke：`OPENAI_API_KEY=sk-... npm run mcp:smoke` 全链路通过（含图片预览）。

人工验收项另见 `docs/notes/20261030-人工验收清单.md`。
