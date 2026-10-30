/**
 * MCP 工具定义（stdio 与 Streamable HTTP 共用）。
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { createDeck, regeneratePage, exportDeck, getDeckPreview, type DeckEvent } from "../capabilities/deck.js";
import { deckJobs } from "../server/jobs.js";

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export function createSlideForgeMcpServer(): McpServer {
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
      const job = { id: jobId, status: "creating" as const, events: [] as string[], overflowPages: [] as number[] };
      deckJobs.set(jobId, job);
      const onEvent = (event: DeckEvent) => {
        job.events.push(`[${event.stage}]${event.page ? ` p${event.page}` : ""} ${event.message}`);
      };
      void (async () => {
        try {
          const deck = await createDeck({ brief, pageCount: page_count, concurrency: Math.max(1, Math.min(5, Number(process.env.DECK_CONCURRENCY ?? 4))), onEvent });
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
      const job = deckJobs.get(deck_id);
      if (!job) return text({ error: `unknown deck_id: ${deck_id}` });
      return text({
        deck_id,
        status: job.status,
        title: job.title,
        recent_events: job.events.slice(-8),
        overflow_pages: job.overflowPages,
        billing: job.billing,
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
      const job = deckJobs.get(deck_id);
      if (!job?.runDir) return text({ error: "deck 不存在或尚未 ready" });
      const result = await regeneratePage({ runDir: job.runDir, page, instruction });
      return text({ deck_id, page, status: "regenerated", overflow_warnings: result.overflowWarnings, hint: "调用 export_deck 导出最新版本" });
    },
  );

  server.tool(
    "get_deck_preview",
    "获取 deck 页面缩略图（JPEG 图片消息），用于在对话中直接预览 PPT 效果。",
    {
      deck_id: z.string(),
      pages: z.array(z.number().min(1)).max(4).optional().describe("页码列表，默认前 4 页，最多 4 页"),
    },
    async ({ deck_id, pages }) => {
      const job = deckJobs.get(deck_id);
      if (!job?.runDir) return text({ error: "deck 不存在或尚未 ready" });
      const images = await getDeckPreview({ runDir: job.runDir, pages });
      return {
        content: [
          { type: "text" as const, text: `共 ${images.length} 页预览：${images.map((i) => `第${i.page}页`).join("、")}` },
          ...images.map((image) => ({ type: "image" as const, data: image.base64, mimeType: image.mimeType })),
        ],
      };
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
      const job = deckJobs.get(deck_id);
      if (!job?.runDir) return text({ error: "deck 不存在或尚未 ready" });
      const outPath = out_path ?? path.join(job.runDir, "deck.pptx");
      const result = await exportDeck({ runDir: job.runDir, outPath });
      return text({ deck_id, pptx_path: result.outPath, slide_count: result.slideCount, size_bytes: result.sizeBytes, warnings: result.warnings });
    },
  );

  return server;
}
