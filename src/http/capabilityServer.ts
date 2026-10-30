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
import { loadDotEnv } from "../server/env.js";

loadDotEnv();

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
  listKeys,
  issueKey,
  rechargeKey,
  readLedger,
  type BillingContext,
} from "../billing/index.js";
import { deckJobs } from "../server/jobs.js";
import { extractBrandProfile, type BrandProfile } from "../brand/profile.js";
import { createSlideForgeMcpServer } from "../mcp/tools.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const BRANDS_DIR = path.resolve(import.meta.dirname, "..", "..", "data", "brands");

async function loadBrand(brandId: string): Promise<BrandProfile | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(path.join(BRANDS_DIR, brandId, "profile.json"), "utf8")) as BrandProfile;
  } catch {
    return null;
  }
}

const jobs = deckJobs;
const ADMIN_TOKEN = process.env.SLIDEFORGE_ADMIN_TOKEN?.trim();
// 小内存主机用 DECK_CONCURRENCY=1 或 2 降配（每个生成页都需 LLM+渲染开销）
const DECK_CONCURRENCY = Math.max(1, Math.min(5, Number(process.env.DECK_CONCURRENCY ?? 4)));

function adminAuthorized(req: import("node:http").IncomingMessage): boolean {
  if (!ADMIN_TOKEN) return true; // 未配置 = 本机开发模式
  return req.headers["x-admin-token"] === ADMIN_TOKEN;
}

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

    // ── M3 控制台（生产部署设置 SLIDEFORGE_ADMIN_TOKEN 启用鉴权）──
    if (url.pathname === "/console" || url.pathname.startsWith("/admin/")) {
      if (!adminAuthorized(req)) return json(res, 401, { error: "admin unauthorized" });
    }
    if (req.method === "GET" && url.pathname === "/console") {
      const { readFile } = await import("node:fs/promises");
      const html = await readFile(new URL("./console.html", import.meta.url), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (url.pathname === "/admin/keys" && req.method === "GET") {
      return json(res, 200, await listKeys());
    }
    if (url.pathname === "/admin/keys" && req.method === "POST") {
      const body = await readBody(req);
      const name = String(body.name ?? "").trim();
      if (!name) return json(res, 400, { error: "name 不能为空" });
      return json(res, 200, await issueKey(name, Number(body.points ?? 100)));
    }
    if (url.pathname === "/admin/keys/recharge" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, await rechargeKey(String(body.key), Number(body.points ?? 100)));
    }
    if (url.pathname === "/admin/ledger" && req.method === "GET") {
      return json(res, 200, await readLedger());
    }
    if (url.pathname === "/admin/decks" && req.method === "GET") {
      return json(res, 200, [...jobs.values()].map((job) => ({
        deck_id: job.id, title: job.title, status: job.status, recent_events: job.events.slice(-2),
      })));
    }

    // ── M4 品牌模板：上传 pptx → 提取品牌档案 ──
    if (req.method === "POST" && url.pathname === "/brands") {
      const body = await readBody(req);
      const name = String(body.name ?? "").trim();
      const base64 = String(body.pptx_base64 ?? "");
      if (!name || !base64) return json(res, 400, { error: "name 与 pptx_base64 必填" });
      const brandId = `brand-${randomUUID().slice(0, 8)}`;
      const dir = path.join(BRANDS_DIR, brandId);
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
      const buffer = Buffer.from(base64, "base64");
      await writeFile(path.join(dir, "source.pptx"), buffer);
      const profile = await extractBrandProfile(buffer, name);
      await writeFile(path.join(dir, "profile.json"), JSON.stringify(profile, null, 2), "utf8");
      return json(res, 200, { brand_id: brandId, profile });
    }
    if (req.method === "GET" && url.pathname === "/brands") {
      const { readdir } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      if (!existsSync(BRANDS_DIR)) return json(res, 200, []);
      const entries = await readdir(BRANDS_DIR);
      const brands = [];
      for (const id of entries) {
        const profile = await loadBrand(id);
        if (profile) brands.push({ brand_id: id, ...profile });
      }
      return json(res, 200, brands);
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
      const brandProfile = typeof body.brand_id === "string" ? await loadBrand(body.brand_id) : null;
      if (typeof body.brand_id === "string" && !brandProfile) {
        return json(res, 404, { error: `brand_id 不存在：${body.brand_id}` });
      }
      void (async () => {
        try {
          const deck = await runWithBilling(billingCtx, () => createDeck({
            brief,
            pageCount: typeof body.page_count === "number" ? body.page_count : undefined,
            concurrency: DECK_CONCURRENCY,
            brandProfile: brandProfile ?? undefined,
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

    // ── MCP Streamable HTTP（远程 AI 客户端接入点，无状态模式）──
    if (url.pathname === "/mcp") {
      const mcpServer = createSlideForgeMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await transport.handleRequest(req, res, body);
      return;
    }

    return json(res, 404, { error: "not found", path: url.pathname });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, () => {
  console.log(`[slideforge] capability server listening on http://localhost:${PORT}`);
});
