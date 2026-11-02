# SlideForge Python Brain

- 状态: active
- 最后验证: 2026-11-01

总纲中的大脑层基础服务。当前提供确定性 Prompt 编排和文档文本分块，不直接访问 Chrome、作品文件、用户或计费存储。

## 接口

- `GET /healthz`：进程健康检查。
- `POST /internal/brain/outline-prompt`：生成 OpenAI 兼容的大纲消息数组，保留事实与用户约束。
- `POST /internal/brain/page-prompt`：生成单页 HTML 消息，保留视觉与事实约束。
- `POST /internal/brain/outline`：由 Python 调模型并校验大纲结构和页数，同时返回 token usage。
- `POST /internal/brain/document-extract`：提取 DOCX／PDF／TXT 正文。
- `POST /internal/brain/document-chunks`：生成稳定文档 SHA-256、带字符位置的重叠文本块。
- `POST /internal/brain/image-drift`：计算图像尺寸归一化、RMS、变化像素比例和差异区域。
- `POST /internal/brain/evals/run`：运行大纲、文档和图像声明式夹具，返回逐例结果和汇总。

内部接口使用 `X-Internal-Token`。生产环境必须配置 `GATEWAY_INTERNAL_TOKEN`。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `BRAIN_HOST` | `127.0.0.1` | 监听地址 |
| `BRAIN_PORT` | `3212` | 监听端口 |
| `GATEWAY_INTERNAL_TOKEN` | 空 | 内部服务令牌，生产必填 |
| `OPENAI_BASE_URL` | `https://api.deepseek.com` | 大纲模型端点 |
| `OPENAI_API_KEY` | 空 | 大纲模型凭证，调用 `/outline` 时必填 |
| `OPENAI_MODEL` | `deepseek-chat` | 大纲模型名称 |

## 运行与验证

要求 Python 3.11+。基础服务无第三方运行时依赖；PDF 提取需要可选依赖 PyMuPDF。

```bash
cd services/brain
python -m brain.app
python -m unittest discover -s tests -v
```

跨服务契约见 `contracts/openapi/brain.yaml`。后续里程碑在此服务中接入模型编排、文档格式理解、图像偏离度分析与 Evals，不在 Node 中复制这些职责。
