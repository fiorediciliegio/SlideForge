/**
 * M2-2 · SlideForge 能力层 HTTP 服务。
 * 与 MCP Server 共用能力层（src/capabilities/deck.ts），远程客户端/Go 网关的对接点。
 *
 * 启动：OPENAI_API_KEY=sk-... npm run serve（默认端口 3210，PORT 可改）
 *
 * 接口：
 *   GET  /healthz
 *   POST /decks                      {brief, page_count?} → {deck_id}
 *   GET  /decks/:id                  → 任务状态与进度
 *   POST /decks/:id/regenerate       {page, instruction}
 *   GET  /decks/:id/preview?pages=1,2 → JPEG 图片（单页）；JSON base64（多页）
 *   POST /decks/:id/export           {out_path?} → {pptx_path,...}
 */
import { createServer } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  createDeck,
  regeneratePage,
  exportDeck,
  getDeckPreview,
  type DeckEvent,
} from "../capabilities/deck.js";
import {
  checkKey,
  runWithBilling,
  settleDeck,
  chargeFixed,
  type BillingContext,
} from "../billing/index.js";

interface DeckJob {
  id: string;
  runDir?: string;
  title?: string;
  status: "creating" | "ready" | "error";
  events: string[];
  error?: string;
  overflowPages: number[];
  billing?: { points: number; balance?: number };
}

const jobs = new Map<string, DeckJob>();
const PORT = Number(process.env.PORT ?? 3210);

function json(res: import("node:http").ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

async function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, { ok: true, service: "slideforge-capabilities", jobs: jobs.size });
    }

    if (req.method === "POST" && url.pathname === "/decks") {
      const body = await readBody(req);
      const brief = String(body.brief ?? "").trim();
      if (!brief) return json(res, 400, { error: "brief 不能为空" });
      const apiKey = req.headers["x-api-key"] as string | undefined;
      const auth = await checkKey(apiKey);
      if (!auth.ok) return json(res, 402, { error: auth.reason });
      const jobId = `deck-${randomUUID().slice(0, 8)}`;
      const job: DeckJob = { id: jobId, status: "creating", events: [], overflowPages: [] };
      jobs.set(jobId, job);
      const onEvent = (event: DeckEvent) => {
        job.events.push(`[${event.stage}]${event.page ? ` p${event.page}` : ""} ${event.message}`);
      };
      const billingCtx: BillingContext = { apiKey: apiKey ?? "", deckId: jobId, promptTokens: 0, completionTokens: 0 };
      void (async () => {
        try {
          const deck = await runWithBilling(billingCtx, () => createDeck({
            brief,
            pageCount: typeof body.page_count === "number" ? body.page_count : undefined,
            concurrency: 4,
            onEvent,
          }));
          job.runDir = deck.runDir;
          job.title = deck.outline.title;
          job.overflowPages = deck.overflowWarnings.map((w) => w.page);
          job.status = "ready";
          job.billing = await settleDeck(billingCtx);
        } catch (error) {
          job.status = "error";
          job.error = error instanceof Error ? error.message : String(error);
        }
      })();
      return json(res, 202, { deck_id: jobId, status: job.status });
    }

    const match = url.pathname.match(/^\/decks\/([\w-]+)(?:\/(regenerate|preview|export))?$/);
    if (match) {
      const job = jobs.get(match[1]);
      if (!job) return json(res, 404, { error: "deck 不存在" });
      const action = match[2];

      if (req.method === "GET" && !action) {
        return json(res, 200, {
          deck_id: job.id,
          status: job.status,
          title: job.title,
          recent_events: job.events.slice(-8),
          overflow_pages: job.overflowPages,
          billing: job.billing,
          error: job.error,
        });
      }

      if (req.method === "POST" && action === "regenerate") {
        if (!job.runDir) return json(res, 409, { error: "deck 尚未 ready" });
        const body = await readBody(req);
        const result = await regeneratePage({
          runDir: job.runDir,
          page: Number(body.page),
          instruction: String(body.instruction ?? ""),
        });
        return json(res, 200, { deck_id: job.id, status: "regenerated", overflow_warnings: result.overflowWarnings });
      }

      if (req.method === "GET" && action === "preview") {
        if (!job.runDir) return json(res, 409, { error: "deck 尚未 ready" });
        const pages = url.searchParams.get("pages")?.split(",").map(Number).filter(Boolean);
        const images = await getDeckPreview({ runDir: job.runDir, pages });
        if (images.length === 1) {
          res.writeHead(200, { "content-type": "image/jpeg" });
          return res.end(Buffer.from(images[0].base64, "base64"));
        }
        return json(res, 200, { deck_id: job.id, images });
      }

      if (req.method === "POST" && action === "export") {
        if (!job.runDir) return json(res, 409, { error: "deck 尚未 ready" });
        const apiKey = req.headers["x-api-key"] as string | undefined;
        const auth = await checkKey(apiKey);
        if (!auth.ok) return json(res, 402, { error: auth.reason });
        const body = await readBody(req);
        const outPath = typeof body.out_path === "string" ? body.out_path : path.join(job.runDir, "deck.pptx");
        const result = await exportDeck({ runDir: job.runDir, outPath });
        const charge = await chargeFixed(apiKey, job.id, "export");
        return json(res, 200, { ...result, billing: charge });
      }
    }

    return json(res, 404, { error: "not found", path: url.pathname });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, () => {
  console.log(`[slideforge] capability server listening on http://localhost:${PORT}`);
});
