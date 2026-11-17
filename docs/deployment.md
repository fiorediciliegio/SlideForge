# SlideForge 部署运行手册

> 面向协作者/部署者：不看代码也能把系统跑起来并发出第一个计费 key。
> 状态: active · 最后验证日期: 2026-11-10（新增 Python Brain Harness）

## 一、环境要求

- Node.js ≥ 22（本机验证版本 v24）
- Chrome 或 Edge（渲染/导出用）：默认自动探测常见安装路径，也可显式指定
- 一个 OpenAI 兼容模型端点（DeepSeek / Kimi 等均可）
- Go ≥ 1.22、Python ≥ 3.11（四进程 dev 与新 Harness 必需）。Harness 模型须支持原生工具调用及图片输入。

## 二、首次安装

```bash
git clone https://github.com/xiaoyuankele/SlideForge.git slideforge
cd slideforge
npm install

# 独立引擎依赖（只由引擎进程执行渲染与导出）
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
| `AGENT_INPUT_CNY_PER_MILLION` | Harness 必填 | 人民币/百万输入 tokens 的保守单价，执行开始后冻结 |
| `AGENT_OUTPUT_CNY_PER_MILLION` | Harness 必填 | 人民币/百万输出 tokens 的保守单价，包含模型报告的输出用量 |
| `AGENT_PRICING_VERSION` | 建议 | 价格快照标识，便于审计 |
| `PYTHON`、`GO_BINARY` | 可选 | 显式指定解释器/Go；未指定则优先使用仓库 `.tooling` 中已安装的工具 |

## 四进程启动与 Harness

本机启动：

```powershell
Set-Location 'D:\SlideForge'
npm.cmd run dev
```

浏览器打开 `http://localhost:8080/app`。终端保持运行，Ctrl+C 关闭本次四个服务。启动器加载根目录 `.env`，已有进程环境变量优先；模型 Key 只写在本机 `.env`，不要放入业务 Key 输入框。业务 Key 仍由 Go 网关签发，用于登录、作品隔离和导出点数。

端口：Go 网关8080、Node Capability3210、Node引擎3211、Python Brain3212。启动器默认识别 `.tooling/go/bin/go.exe` 与 `.tooling/brain-venv/Scripts/python.exe`，无需为每次启动重复设置 PATH。在线检查、预览、PDF/PPTX 均通过独立引擎作业执行；业务 Node 不启动 Chrome。

新机器准备 Python 虚拟环境可用以下命令（本机已有，无需重复）：

```powershell
python -m venv .tooling\brain-venv
& .\.tooling\brain-venv\Scripts\python.exe -m pip install -e './services/brain[documents,images]'
```

`.env` 中保留既有 `OPENAI_*` 三项，另配置成本估算单价。本机使用已核对的 DeepSeek Flash 高峰、缓存未命中价作为保守上界：输入2元/百万、输出8元/百万，版本标识 `deepseek-flash-peak-cache-miss-2026-11-10`。来源：[DeepSeek 官方模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。这会高于部分实际账单，界面称“估算”；切换模型/供应商时应同步调整报价，不能把人民币估算当作产品点数。

Web 默认预算为600秒有效时间、模型成本估算2元。排队、等待大纲/资料与停机不计有效执行时间；中断按最后确认的心跳保存累计。关闭网页不停止后台任务；服务重启或执行租约过期后，用户点击“继续”恢复，不自动发起付费调用。模型响应丢失则保留未知调用预留，需明确同意重试，并可能需要追加预算。

点击“继续”会先复用已完整落盘但尚未结算的响应，避免再次调用和付费；只有确实找不到结果的调用才需要同意重试。PostgreSQL单网关启动同样中断旧执行；多网关模式依据共享租约判断失联，单个副本启动不打断仍健康的执行。本机PostgreSQL多副本实测尚未完成，见验收记录。

选择“先确认大纲”，或者需求中明确说“先规划一下”，会停在大纲编辑器。自动保存成功后才能确认；409冲突保留本地文字，不覆盖服务端。页数包含封面、目录和附录，合计2–20页。用户更正场景后需核对大纲；结构提案也必须打开编辑并确认。

首次续改旧作品会从现存文件建立基线，明确标识缺失的原始附件/历史；不要求先迁移才能预览/导出。回退创建新版本并保留当前约束，相关检查失效后以草稿展示。新 Harness 的生成/预览/修改不扣产品点数，明确导出时沿用现有幂等扣点和带 Key 下载。

`npm run serve` 保留单 Node 旧 API 入口；新 Web Harness 必须使用四进程配置。未配置必要服务时会明确报错，不退回旧链路。WPS/MCP 的新 Harness 交互是后续工作，现有调用继续使用原参数。

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
- **容量保护**：Brain默认`AGENT_PROJECT_CONCURRENCY=5`、每业务Key`AGENT_OWNER_PROJECT_CONCURRENCY=2`；Harness整页工作位`AGENT_PAGE_CONCURRENCY=3`，固定流程保留`DECK_CONCURRENCY=2`。同一业务Node内页面模型请求共享`PAGE_MODEL_CONCURRENCY=12`，按客户/项目轮转；Python总控、独立CLI/stdio MCP及其他业务Node不计入该单进程池。引擎默认`ENGINE_CONCURRENCY=1`，检查/预览/导出仍走独立队列；引擎等待不占页面模型请求槽，但仍占该项目的整页工作位。纯等待不计有效时间，有其他实际工作时按墙钟计一次。部署容量须压测，12不是已验证的生产吞吐承诺。
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
6. 客户端统一访问 8080。Go 直接处理 key 管理、任务查询、SSE 进度与取消，其他 API 透明代理到 Node。独立引擎上传私有产物，Go 幂等扣点后发布文件，并提供 `GET /files/<file_id>` 鉴权下载与 `GET /decks/<deck_id>/files` 列表；导出回执可包含 `file_id`、`download_url`。
7. 本地生成和导出也需要运行 Go 与独立引擎；CLI/MCP 在 `npm run dev` 已运行时连接本机网关。单独 `serve` 仅启动业务 API，不提供本地渲染；生产远程模式不得同时让两个进程写同一计费或任务文件，文件对象与元数据只归 Go 文件服务。

跨服务接口以 `contracts/openapi/gateway.yaml`、`contracts/openapi/auth-billing.yaml`、`contracts/openapi/jobs.yaml` 和 `contracts/openapi/files.yaml` 为准。

## 六-C、P1-D1 Node 独立引擎服务

1. 本机使用 `npm.cmd run dev` 启动四进程，访问 `http://localhost:8080/app`，既有 `.env` 无需增加配置。默认重型并发为 1，Brain 活跃项目为 5。
2. 分机部署时，业务 Node 和引擎均配置 `SLIDEFORGE_ENGINE_API_URL=https://网关/internal/engine` 与相同的 `GATEWAY_INTERNAL_TOKEN`；该内部端点只向可信服务开放。引擎仅需可写的 `ENGINE_WORK_ROOT`（未设置时用系统临时目录），不挂载业务作品目录。引擎进程保留 Chrome/字体与 engine 依赖。
3. Go 暴露私有 `POST /internal/engine/artifacts`、`jobs`、`claim`，统一内部令牌。输入只能包含固定 HTML 和内嵌资源，不接受绝对路径或任意 URL。私有输入/截图不会出现在客户文件列表。原同步引擎目录接口已移除。
4. 多引擎实例共享同一 Go 队列；每次执行带租约，失联最多重跑一次。生产使用 `JOBS_DATABASE_URL` 加 S3，JSON 仅供单网关开发。生产 PostgreSQL 采用短行事务协调，不把 HTML/文件内容写进调度记录。
5. `POST /decks/<id>/export` 返回 202、`engine_job_id` 和 `status_url`。GET 状态 URL 得到 queued/running/completed/failed/cancelled；completed 包含鉴权下载回执。请求取消用相同 POST 携带 `{ "engine_job_id":"...", "cancel":true }`。同版本任务复用，取消会影响其他使用该任务的窗口；关闭页面不取消。
6. 客户导出先生成私有文件，再以引擎任务 ID 幂等扣点，最后发布 `/files/<id>`。扣点后响应丢失可继续查询原交付，不重复扣点；未扣点产物不会开放下载。CLI/MCP 的等待仍使用同一任务协议，受信本地 stdio/CLI 可保存文件到本机。
7. `ENGINE_CONCURRENCY=1` 是本机起点。服务器可配置 1–8，每增加一个槽位都要测 Chrome 峰值内存；用户数量不等于浏览器进程数。队列全局 100、每 owner 20，满时明确拒绝。仅排队不扣 Agent 有效时间。
8. 本期不实现多个业务 Node 对同一项目目录的接管。详见 [ADR-0081](adr/0081-independent-engine-jobs.md)、[协议](../contracts/openapi/engine.yaml)及[验收记录](../.scratch/engine-job-service/验收记录.md)。

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
