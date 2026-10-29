/**
 * M1-3 · SlideForge MCP Server（stdio）。
 * AI 客户端（Claude / Kimi / Cursor）经 MCP 直接调用能力层。
 *
 * 启动：OPENAI_API_KEY=sk-... node --import tsx/esm src/mcp/server.ts
 * 工具：create_deck / get_deck_job / regenerate_page / export_deck
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createDeck, regeneratePage, exportDeck, type DeckEvent } from "../capabilities/deck.js";

interface DeckJob {
  id: string;
  runDir?: string;
  title?: string;
  status: "creating" | "ready" | "error";
  events: string[];
  error?: string;
  overflowPages: number[];
}

const jobs = new Map<string, DeckJob>();

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

const server = new McpServer({ name: "slideforge", version: "0.1.0" });

server.tool(
  "create_deck",
  "从一段需求文字创建一份 PPT（HTML 原生页面，可导出 pptx）。异步任务：立即返回 deck_id，用 get_deck_job 查询进度。",
  {
    brief: z.string().describe("演示需求描述，越具体越好（主题、受众、关键数据）"),
    page_count: z.number().min(2).max(20).optional().describe("页数，默认 8"),
  },
  async ({ brief, page_count }) => {
    const jobId = `deck-${randomUUID().slice(0, 8)}`;
    const job: DeckJob = { id: jobId, status: "creating", events: [], overflowPages: [] };
    jobs.set(jobId, job);
    const onEvent = (event: DeckEvent) => {
      job.events.push(`[${event.stage}]${event.page ? ` p${event.page}` : ""} ${event.message}`);
    };
    void (async () => {
      try {
        const deck = await createDeck({ brief, pageCount: page_count, concurrency: 4, onEvent });
        job.runDir = deck.runDir;
        job.title = deck.outline.title;
        job.overflowPages = deck.overflowWarnings.map((w) => w.page);
        job.status = "ready";
      } catch (error) {
        job.status = "error";
        job.error = error instanceof Error ? error.message : String(error);
      }
    })();
    return text({ deck_id: jobId, status: job.status, hint: "用 get_deck_job 轮询，status=ready 后调用 export_deck" });
  },
);

server.tool(
  "get_deck_job",
  "查询 deck 生成任务的进度与状态。",
  { deck_id: z.string() },
  async ({ deck_id }) => {
    const job = jobs.get(deck_id);
    if (!job) return text({ error: `unknown deck_id: ${deck_id}` });
    return text({
      deck_id,
      status: job.status,
      title: job.title,
      recent_events: job.events.slice(-8),
      overflow_pages: job.overflowPages,
      error: job.error,
    });
  },
);

server.tool(
  "regenerate_page",
  "只重新生成某一页（指哪改哪），其余页面保持不变。",
  {
    deck_id: z.string(),
    page: z.number().min(1).describe("1-based 页码"),
    instruction: z.string().describe("对这一页的修改要求"),
  },
  async ({ deck_id, page, instruction }) => {
    const job = jobs.get(deck_id);
    if (!job?.runDir) return text({ error: "deck 不存在或尚未 ready" });
    const result = await regeneratePage({ runDir: job.runDir, page, instruction });
    return text({
      deck_id,
      page,
      status: "regenerated",
      overflow_warnings: result.overflowWarnings,
      hint: "调用 export_deck 导出最新版本",
    });
  },
);

server.tool(
  "export_deck",
  "把 deck 导出为可编辑的 PPTX 文件（真实文本框/形状，WPS/Office 可继续编辑）。",
  {
    deck_id: z.string(),
    out_path: z.string().optional().describe("输出路径，默认 <工作区>/deck.pptx"),
  },
  async ({ deck_id, out_path }) => {
    const job = jobs.get(deck_id);
    if (!job?.runDir) return text({ error: "deck 不存在或尚未 ready" });
    const outPath = out_path ?? path.join(job.runDir, "deck.pptx");
    const result = await exportDeck({ runDir: job.runDir, outPath });
    return text({
      deck_id,
      pptx_path: result.outPath,
      slide_count: result.slideCount,
      size_bytes: result.sizeBytes,
      warnings: result.warnings,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[slideforge-mcp] stdio server ready");
