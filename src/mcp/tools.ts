/** MCP 工具定义：stdio 为受信本地模式，Streamable HTTP 传入用户鉴权上下文。 */
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createDeck, regeneratePage, exportDeck, getDeckPreview, type DeckEvent } from "../capabilities/deck.js";
import {
  createDeckMcpShape, deckPreviewMcpShape, exportDeckMcpShape,
  regeneratePageMcpShape, toDeckJobDto,
} from "../contracts/deck.js";
import { deckIdSchema, newDeckId } from "../contracts/ids.js";
import {
  appendDeckJobEvent, createDeckJob, deleteDeckJob, getDeckJob,
  persistDeckJob, remoteJobsEnabled, type DeckJob,
} from "../server/jobs.js";
import { AsyncJobQueue } from "../server/jobQueue.js";
import { apiKeyHash, billingEnabled, runWithBilling, settleDeck, type BillingContext } from "../billing/index.js";
import { runIdempotentExport } from "../server/exportCoordinator.js";
import { loadBrand } from "../brand/store.js";

export interface McpSecurityContext {
  apiKey?: string;
  queue?: AsyncJobQueue;
  deckConcurrency?: number;
}

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export function createSlideForgeMcpServer(context: McpSecurityContext = {}): McpServer {
  const server = new McpServer({ name: "slideforge", version: "0.1.0" });
  const queue = context.queue ?? new AsyncJobQueue(1, 50);
  const ownerKeyHash = apiKeyHash(context.apiKey);
  const remoteUser = Boolean(context.apiKey);
  const owns = (job: DeckJob | undefined): job is DeckJob => Boolean(
    job && (!remoteUser || (job.ownerKeyHash && job.ownerKeyHash === ownerKeyHash)),
  );
  const ownsProfile = (profile: object | null) => Boolean(
    profile && (!remoteUser || ((profile as { ownerKeyHash?: string }).ownerKeyHash
      && (profile as { ownerKeyHash?: string }).ownerKeyHash === ownerKeyHash)),
  );

  server.tool(
    "create_deck",
    "从一段需求文字创建一份 PPT（HTML 原生页面，可导出 pptx）。异步任务：立即返回 deck_id，用 get_deck_job 查询进度。",
    createDeckMcpShape,
    async ({ brief, page_count, brand_id, source_text, template_id }) => {
      const brandProfile = brand_id ? await loadBrand(brand_id) : null;
      if (brand_id && !ownsProfile(brandProfile)) return text({ error: `brand_id 不存在：${brand_id}` });
      const jobId = newDeckId();
      const job: DeckJob = {
        id: jobId, status: "creating", events: [], overflowPages: [],
        ownerKeyHash, createdAt: new Date().toISOString(),
      };
      await createDeckJob(job);
      const onEvent = (event: DeckEvent) => {
        appendDeckJobEvent(job, event);
        if (remoteJobsEnabled()) void persistDeckJob(job).catch(() => undefined);
      };
      const billingCtx: BillingContext = { apiKey: context.apiKey ?? "", deckId: jobId, promptTokens: 0, completionTokens: 0 };
      try {
        queue.enqueue(async () => {
          try {
            const deck = await runWithBilling(billingCtx, () => createDeck({
              deckId: jobId, brief, pageCount: page_count,
              concurrency: context.deckConcurrency ?? Math.max(1, Math.min(5, Number(process.env.DECK_CONCURRENCY ?? 2))),
              brandProfile: brandProfile ?? undefined, sourceText: source_text, templateId: template_id, onEvent,
            }));
            job.runDir = deck.runDir;
            job.title = deck.outline.title;
            job.overflowPages = deck.overflowWarnings.map((warning) => warning.page);
            job.status = "ready";
            if (remoteUser && billingEnabled()) job.billing = await settleDeck(billingCtx);
          } catch (error) {
            job.status = "error";
            job.error = error instanceof Error ? error.message : String(error);
          } finally { await persistDeckJob(job); }
        });
      } catch (error) {
        await deleteDeckJob(jobId);
        return text({ error: error instanceof Error ? error.message : String(error) });
      }
      return text({ deck_id: jobId, status: job.status, hint: "用 get_deck_job 轮询，status=ready 后调用 export_deck" });
    },
  );

  server.tool("get_deck_job", "查询当前用户 deck 生成任务的进度与状态。", { deck_id: deckIdSchema }, async ({ deck_id }) => {
    const job = await getDeckJob(deck_id);
    if (!owns(job)) return text({ error: `unknown deck_id: ${deck_id}` });
    return text(toDeckJobDto(job));
  });

  server.tool("regenerate_page", "只重新生成当前用户 deck 的某一页，其余页面保持不变。", regeneratePageMcpShape, async ({ deck_id, page, instruction }) => {
    const job = await getDeckJob(deck_id);
    if (!owns(job) || !job.runDir) return text({ error: "deck 不存在或尚未 ready" });
    const result = await queue.submit(() => regeneratePage({ runDir: job.runDir!, page, instruction }));
    return text({ deck_id, page, status: "regenerated", overflow_warnings: result.overflowWarnings, drift_report: result.drift, hint: "调用 export_deck 导出最新版本" });
  });

  server.tool("get_deck_preview", "获取当前用户 deck 页面缩略图。", deckPreviewMcpShape, async ({ deck_id, pages }) => {
    const job = await getDeckJob(deck_id);
    if (!owns(job) || !job.runDir) return text({ error: "deck 不存在或尚未 ready" });
    const images = await queue.submit(() => getDeckPreview({ runDir: job.runDir!, pages }));
    return {
      content: [
        { type: "text" as const, text: `共 ${images.length} 页预览：${images.map((image) => `第${image.page}页`).join("、")}` },
        ...images.map((image) => ({ type: "image" as const, data: image.base64, mimeType: image.mimeType })),
      ],
    };
  });

  server.tool("export_deck", "把当前用户 deck 导出为可编辑的 PPTX 文件；相同内容重复调用不重复扣费。", exportDeckMcpShape, async ({ deck_id, out_path, idempotency_key }) => {
    const job = await getDeckJob(deck_id);
    if (!owns(job) || !job.runDir) return text({ error: "deck 不存在或尚未 ready" });
    const output = remoteUser ? "deck.pptx" : out_path ?? "deck.pptx";
    const resolved = path.resolve(job.runDir, output);
    if (resolved !== job.runDir && !resolved.startsWith(`${job.runDir}${path.sep}`)) return text({ error: "out_path 必须位于 deck 工作区内" });
    const result = await queue.submit(() => runIdempotentExport({
      apiKey: context.apiKey, ownerKeyHash, deckId: deck_id, runDir: job.runDir!,
      format: "pptx", outPath: resolved, idempotencyKey: idempotency_key,
      execute: () => exportDeck({ runDir: job.runDir!, outPath: resolved }),
    }));
    return text({
      deck_id, pptx_path: result.outPath, slide_count: result.slideCount,
      size_bytes: result.sizeBytes, warnings: result.warnings,
      billing: result.billing, export_id: result.export_id, idempotent: result.idempotent,
      file_id: result.file_id, download_url: result.download_url,
    });
  });

  return server;
}
