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

## 六、生产化配置（2026-10-30 起）

- **管理员鉴权**：设置 `SLIDEFORGE_ADMIN_TOKEN=<随机串>` 后，`/console` 与 `/admin/*` 需 `X-Admin-Token` 请求头（控制台页面会提示输入并记忆）；未设置 = 本机开发模式全放行。
- **MCP 远程接入**：HTTP 服务同时挂载 `POST /mcp`（Streamable HTTP，无状态模式）。远程 AI 客户端直接指向 `http://<主机>:3210/mcp` 即可使用全部 5 个工具，与 stdio 共用任务存储（HTTP 建的 deck，MCP 可操作）。
- 生产部署建议：仅暴露 3210 给可信网络，管理员 token 与客户端 key 分开管理。

## 七、验证清单（部署后自检）

1. `npm run generate -- --brief "测试" --pages 2 --out artifacts/test.pptx` 出文件；
2. `curl http://localhost:3210/healthz` 返回 ok；
3. MCP smoke：`OPENAI_API_KEY=sk-... npm run mcp:smoke` 全链路通过（含图片预览）。

人工验收项另见 `docs/notes/20261030-人工验收清单.md`。
