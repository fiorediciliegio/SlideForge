/** SlideForge 能力层 HTTP 服务：REST、控制台与 MCP 共用任务、队列和鉴权边界。 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadDotEnv } from "../server/env.js";

loadDotEnv();

import { createDeck, regeneratePage, exportDeck, getDeckPreview, type DeckEvent } from "../capabilities/deck.js";
import {
  apiKeyHash, billingEnabled, checkKey, runWithBilling, settleDeck,
  listKeys, issueKey, rechargeKey, readLedger, type BillingContext,
} from "../billing/index.js";
import {
  appendDeckJobEvent, createDeckJob, deckJobs, deleteDeckJob, getDeckJob,
  listDeckJobs, loadDeckJobs, persistDeckJob, remoteJobsEnabled, type DeckJob,
} from "../server/jobs.js";
import { AsyncJobQueue, QueueFullError } from "../server/jobQueue.js";
import { runIdempotentExport } from "../server/exportCoordinator.js";
import {
  applySecurityHeaders, FixedWindowRateLimiter, HttpRequestError,
  readJsonBody, requestIdentity,
} from "../server/httpSecurity.js";
import { extractBrandProfile } from "../brand/profile.js";
import { BRANDS_DIR, loadBrand } from "../brand/store.js";
import { createSlideForgeMcpServer } from "../mcp/tools.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDeckHttpSchema, toDeckJobDto } from "../contracts/deck.js";
import { apiError } from "../contracts/errors.js";
import { newDeckId } from "../contracts/ids.js";
import { extractDocumentViaBrain, remoteBrainEnabled } from "../server/brainClient.js";

const ADMIN_TOKEN = process.env.SLIDEFORGE_ADMIN_TOKEN?.trim();
const PORT = Number(process.env.PORT ?? 3210);
const MAX_BODY_BYTES = Math.max(1024, Number(process.env.MAX_BODY_BYTES ?? 32 * 1024 * 1024));
const DECK_CONCURRENCY = Math.max(1, Math.min(5, Number(process.env.DECK_CONCURRENCY ?? 2)));
const generationQueue = new AsyncJobQueue(
  Math.max(1, Number(process.env.DECK_JOB_CONCURRENCY ?? 1)),
  Math.max(0, Number(process.env.DECK_QUEUE_SIZE ?? 50)),
);
const requestLimiter = new FixedWindowRateLimiter(
  Math.max(1, Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120)), 60_000,
);
const createLimiter = new FixedWindowRateLimiter(
  Math.max(1, Number(process.env.DECK_CREATE_PER_HOUR ?? 20)), 3_600_000,
);

await loadDeckJobs();
if (process.env.NODE_ENV === "production" && (!ADMIN_TOKEN || !billingEnabled())) {
  throw new Error("生产启动前必须配置 SLIDEFORGE_ADMIN_TOKEN，并先通过 scripts/keys.ts 签发至少一个 API key");
}

function adminAuthorized(req: IncomingMessage): boolean {
  if (!ADMIN_TOKEN) return true;
  return req.headers["x-admin-token"] === ADMIN_TOKEN;
}

function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) {
  const normalized = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    && "error" in payload && typeof payload.error === "string"
    ? { ...apiError(status, payload.error), ...payload }
    : payload;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(normalized));
}

function readBody(req: IncomingMessage) { return readJsonBody(req, MAX_BODY_BYTES); }

async function userAuthorized(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const auth = await checkKey(req.headers["x-api-key"] as string | undefined);
  if (auth.ok) return true;
  json(res, 402, { error: auth.reason });
  return false;
}

function ownsResource(req: IncomingMessage, ownerKeyHash?: string): boolean {
  if (!billingEnabled()) return true;
  return Boolean(ownerKeyHash && ownerKeyHash === apiKeyHash(req.headers["x-api-key"] as string | undefined));
}

function ownJob(req: IncomingMessage, job: DeckJob | undefined): job is DeckJob {
  return Boolean(job && ownsResource(req, job.ownerKeyHash));
}

function safeExportPath(runDir: string, requested: unknown, defaultName: string): string {
  const candidate = path.resolve(runDir, typeof requested === "string" && requested ? requested : defaultName);
  if (candidate !== runDir && !candidate.startsWith(`${runDir}${path.sep}`)) {
    throw new HttpRequestError(400, "out_path 必须位于当前 deck 工作区内");
  }
  return candidate;
}

const server = createServer(async (req, res) => {
  applySecurityHeaders(res);
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, {
        ok: true, service: "slideforge-capabilities", jobs: (await listDeckJobs()).length,
        queue: generationQueue.stats, uptime_seconds: Math.round(process.uptime()),
      });
    }

    if (!url.pathname.startsWith("/template-cover/")) {
      const limited = requestLimiter.consume(requestIdentity(req));
      if (!limited.allowed) {
        return json(res, 429, { error: "请求过于频繁，请稍后重试" }, { "retry-after": String(limited.retryAfterSeconds) });
      }
    }
    if (url.pathname.startsWith("/admin/") && !adminAuthorized(req)) {
      return json(res, 401, { error: "admin unauthorized" });
    }

    if (req.method === "GET" && url.pathname === "/editor-dnd.js") {
      const { readFile } = await import("node:fs/promises");
      const js = await readFile(new URL("./editor-dnd.js", import.meta.url), "utf8");
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      return res.end(js);
    }
    if (req.method === "GET" && url.pathname === "/console") {
      const { readFile } = await import("node:fs/promises");
      const html = await readFile(new URL("./console.html", import.meta.url), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (req.method === "GET" && (url.pathname === "/app" || url.pathname === "/")) {
      const { readFile } = await import("node:fs/promises");
      const html = await readFile(new URL("./app.html", import.meta.url), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (url.pathname === "/admin/keys" && req.method === "GET") return json(res, 200, await listKeys());
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
    if (url.pathname === "/admin/ledger" && req.method === "GET") return json(res, 200, await readLedger());
    if (url.pathname === "/admin/decks" && req.method === "GET") {
      return json(res, 200, (await listDeckJobs()).map((job) => ({
        deck_id: job.id, title: job.title, status: job.status, recent_events: job.events.slice(-2),
      })));
    }
    if (url.pathname === "/admin/metrics" && req.method === "GET") {
      return json(res, 200, { queue: generationQueue.stats, memory: process.memoryUsage(), uptime_seconds: process.uptime() });
    }

    if (req.method === "GET" && url.pathname === "/templates") {
      const { listTemplates } = await import("../templates/library.js");
      return json(res, 200, await listTemplates());
    }
    const coverMatch = url.pathname.match(/^\/template-cover\/(.+)$/);
    if (req.method === "GET" && coverMatch) {
      const { readdir, readFile } = await import("node:fs/promises");
      const presetId = decodeURIComponent(coverMatch[1]);
      if (presetId.includes("..") || presetId.includes("/") || presetId.includes("\\")) return json(res, 400, { error: "bad id" });
      try {
        const dir = path.resolve(import.meta.dirname, "..", "features", "templates", "presets", presetId, "images");
        const file = (await readdir(dir)).find((name) => name.endsWith(".webp"));
        if (!file) return json(res, 404, { error: "no cover" });
        const data = await readFile(path.join(dir, file));
        res.writeHead(200, { "content-type": "image/webp", "cache-control": "public, max-age=86400" });
        return res.end(data);
      } catch { return json(res, 404, { error: "no cover" }); }
    }

    if (url.pathname === "/brands" || url.pathname.startsWith("/brands/")) {
      if (!await userAuthorized(req, res)) return;
    }
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
      Object.assign(profile, { brand_id: brandId, ownerKeyHash: apiKeyHash(req.headers["x-api-key"] as string | undefined) });
      if (typeof body.logo_base64 === "string" && body.logo_base64.length > 0) {
        const ext = typeof body.logo_ext === "string" && /^[a-z]{3,4}$/.test(body.logo_ext) ? body.logo_ext : "png";
        const logoFile = `logo.${ext}`;
        await writeFile(path.join(dir, logoFile), Buffer.from(body.logo_base64, "base64"));
        Object.assign(profile, {
          logoFile,
          logoPosition: ["top-right", "top-left", "bottom-right", "bottom-left"].includes(String(body.logo_position))
            ? String(body.logo_position) : "top-right",
        });
      }
      await writeFile(path.join(dir, "profile.json"), JSON.stringify(profile, null, 2), "utf8");
      return json(res, 200, { brand_id: brandId, profile });
    }
    if (req.method === "GET" && url.pathname === "/brands") {
      const { readdir } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      if (!existsSync(BRANDS_DIR)) return json(res, 200, []);
      const brands = [];
      for (const id of await readdir(BRANDS_DIR)) {
        const profile = await loadBrand(id);
        if (profile && ownsResource(req, (profile as { ownerKeyHash?: string }).ownerKeyHash)) {
          brands.push({ brand_id: id, ...profile });
        }
      }
      return json(res, 200, brands);
    }
    const optimizeMatch = url.pathname.match(/^\/brands\/([\w-]+)\/optimize$/);
    if (req.method === "POST" && optimizeMatch) {
      const brandId = optimizeMatch[1];
      const profile = await loadBrand(brandId);
      if (!profile || !ownsResource(req, (profile as { ownerKeyHash?: string }).ownerKeyHash)) {
        return json(res, 404, { error: "品牌不存在" });
      }
      const body = await readBody(req);
      const instruction = String(body.instruction ?? "").trim();
      if (!instruction) return json(res, 400, { error: "instruction 不能为空" });
      const { optimizeBrandProfile } = await import("../brand/optimize.js");
      const { writeFile } = await import("node:fs/promises");
      const result = await optimizeBrandProfile(profile, instruction);
      Object.assign(result.profile, { ownerKeyHash: apiKeyHash(req.headers["x-api-key"] as string | undefined) });
      await writeFile(path.join(BRANDS_DIR, brandId, "profile.json"), JSON.stringify(result.profile, null, 2), "utf8");
      return json(res, 200, { brand_id: brandId, profile: result.profile, drift: result.drift });
    }

    if (req.method === "POST" && url.pathname === "/research") {
      if (!await userAuthorized(req, res)) return;
      const body = await readBody(req);
      const query = String(body.query ?? "").trim();
      if (!query) return json(res, 400, { error: "query 不能为空" });
      const { researchWeb } = await import("../research/web.js");
      return json(res, 200, await researchWeb(query));
    }
    if (req.method === "GET" && url.pathname === "/usage") {
      const { getUsage } = await import("../billing/index.js");
      const usage = await getUsage(req.headers["x-api-key"] as string | undefined);
      if (!usage) return json(res, 200, { enabled: false });
      return json(res, 200, { enabled: true, ...usage });
    }

    if (url.pathname === "/decks" || url.pathname.startsWith("/decks/")) {
      if (!await userAuthorized(req, res)) return;
    }
    if (req.method === "GET" && url.pathname === "/decks") {
      return json(res, 200, (await listDeckJobs()).filter((job) => ownsResource(req, job.ownerKeyHash)).map((job) => ({
        deck_id: job.id, title: job.title, status: job.status, recent_events: job.events.slice(-2),
      })));
    }
    if (req.method === "POST" && url.pathname === "/decks") {
      const limited = createLimiter.consume(requestIdentity(req));
      if (!limited.allowed) {
        return json(res, 429, { error: "创建任务超过频率上限，请稍后重试" }, { "retry-after": String(limited.retryAfterSeconds) });
      }
      const parsed = createDeckHttpSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, {
          error: "请求参数无效",
          details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        });
      }
      const body = parsed.data;
      const apiKey = req.headers["x-api-key"] as string | undefined;
      const brandProfile = body.brand_id ? await loadBrand(body.brand_id) : null;
      if (body.brand_id && (!brandProfile || !ownsResource(req, (brandProfile as { ownerKeyHash?: string }).ownerKeyHash))) {
        return json(res, 404, { error: `brand_id 不存在：${body.brand_id}` });
      }
      let sourceText: string | undefined;
      if (body.attachment_base64) {
        try {
          const content = Buffer.from(body.attachment_base64, "base64");
          const filename = body.filename ?? "attachment";
          if (remoteBrainEnabled()) {
            const extracted = await extractDocumentViaBrain(content, filename);
            sourceText = extracted.text;
          } else {
            const { extractDocumentText } = await import("../documents/extract.js");
            const extracted = await extractDocumentText(content, filename);
            sourceText = extracted.text;
          }
        } catch (error) {
          return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const jobId = newDeckId();
      const job: DeckJob = {
        id: jobId, status: "creating", events: [], overflowPages: [],
        ownerKeyHash: apiKeyHash(apiKey), createdAt: new Date().toISOString(),
      };
      await createDeckJob(job);
      const onEvent = (event: DeckEvent) => {
        appendDeckJobEvent(job, event);
        if (remoteJobsEnabled()) void persistDeckJob(job).catch(() => undefined);
      };
      const billingCtx: BillingContext = { apiKey: apiKey ?? "", deckId: jobId, promptTokens: 0, completionTokens: 0 };
      try {
        generationQueue.enqueue(async () => {
          try {
            const deck = await runWithBilling(billingCtx, () => createDeck({
              deckId: jobId, brief: body.brief, pageCount: body.page_count,
              concurrency: DECK_CONCURRENCY, brandProfile: brandProfile ?? undefined,
              sourceText, templateId: body.template_id,
              research: body.research === true, onEvent,
            }));
            job.runDir = deck.runDir;
            job.title = deck.outline.title;
            job.overflowPages = deck.overflowWarnings.map((warning) => warning.page);
            job.status = "ready";
            job.billing = await settleDeck(billingCtx);
          } catch (error) {
            job.status = "error";
            job.error = error instanceof Error ? error.message : String(error);
          } finally { await persistDeckJob(job); }
        });
      } catch (error) {
        await deleteDeckJob(jobId);
        if (error instanceof QueueFullError) return json(res, 503, { error: error.message }, { "retry-after": "30" });
        throw error;
      }
      return json(res, 202, { deck_id: jobId, status: job.status, queue: generationQueue.stats });
    }

    const match = url.pathname.match(/^\/decks\/([\w-]+)(?:\/(regenerate|preview|export|reimport|page-html|theme))?$/);
    if (match) {
      let job = await getDeckJob(match[1]);
      if (!job && !billingEnabled()) {
        const { existsSync } = await import("node:fs");
        const runDir = path.resolve(import.meta.dirname, "..", "..", "artifacts", "decks", match[1]);
        if (existsSync(path.join(runDir, "outline.json"))) {
          job = { id: match[1], runDir, status: "ready", events: [], overflowPages: [] };
          deckJobs.set(job.id, job);
        }
      }
      if (!ownJob(req, job)) return json(res, 404, { error: "deck 不存在" });
      const action = match[2];
      if (req.method === "GET" && !action) {
        return json(res, 200, toDeckJobDto(job));
      }
      if (req.method === "POST" && action === "regenerate") {
        if (!job.runDir) return json(res, 409, { error: "deck 尚未 ready" });
        const body = await readBody(req);
        const result = await generationQueue.submit(() => regeneratePage({
          runDir: job.runDir!, page: Number(body.page), instruction: String(body.instruction ?? ""),
        }));
        return json(res, 200, { deck_id: job.id, status: "regenerated", overflow_warnings: result.overflowWarnings, drift_report: result.drift });
      }
      if (req.method === "GET" && action === "preview") {
        if (!job.runDir) return json(res, 409, { error: "deck 尚未 ready" });
        const pages = url.searchParams.get("pages")?.split(",").map(Number).filter(Boolean);
        const images = await generationQueue.submit(() => getDeckPreview({ runDir: job.runDir!, pages }));
        if (images.length === 1) {
          res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=60" });
          return res.end(Buffer.from(images[0].base64, "base64"));
        }
        return json(res, 200, { deck_id: job.id, images });
      }
      if (req.method === "POST" && action === "reimport") {
        if (!job.runDir) return json(res, 409, { error: "deck 尚未 ready" });
        const body = await readBody(req);
        const base64 = String(body.pptx_base64 ?? "");
        if (!base64) return json(res, 400, { error: "pptx_base64 必填" });
        const { reimportDeck } = await import("../capabilities/deck.js");
        const result = await generationQueue.submit(() => reimportDeck({
          runDir: job.runDir!, pptxBuffer: Buffer.from(base64, "base64"),
        }));
        return json(res, 200, { deck_id: job.id, status: "reimported", ...result, hint: "调用 export 导出新版本" });
      }
      if (action === "page-html") {
        if (!job.runDir) return json(res, 409, { error: "deck 尚未 ready" });
        const pageNumber = Number(url.searchParams.get("page") ?? 0);
        if (req.method === "GET") {
          const { readFile } = await import("node:fs/promises");
          try {
            const html = await readFile(path.join(job.runDir, `page-${pageNumber}.html`), "utf8");
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "sandbox; default-src 'none'; img-src data: file:; style-src 'unsafe-inline'" });
            return res.end(html);
          } catch { return json(res, 404, { error: `第 ${pageNumber} 页不存在` }); }
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const { updatePageHtml } = await import("../capabilities/deck.js");
          const result = await generationQueue.submit(() => updatePageHtml({
            runDir: job.runDir!, page: Number(body.page), html: String(body.html ?? ""),
          }));
          return json(res, 200, { deck_id: job.id, status: "page-updated", ...result });
        }
      }
      if (req.method === "POST" && action === "theme") {
        if (!job.runDir) return json(res, 409, { error: "deck 尚未 ready" });
        const body = await readBody(req);
        const { applyTheme } = await import("../capabilities/deck.js");
        const result = await generationQueue.submit(() => applyTheme({
          runDir: job.runDir!, templateId: typeof body.template_id === "string" ? body.template_id : undefined,
        }));
        return json(res, 200, { deck_id: job.id, status: "theme-applied", ...result });
      }
      if (req.method === "POST" && action === "export") {
        if (!job.runDir) return json(res, 409, { error: "deck 尚未 ready" });
        const body = await readBody(req);
        const format = body.format === "pdf" ? "pdf" : "pptx";
        const defaultName = format === "pdf" ? "deck.pdf" : "deck.pptx";
        const outPath = safeExportPath(job.runDir, body.out_path, defaultName);
        const apiKey = req.headers["x-api-key"] as string | undefined;
        const idempotencyKey = req.headers["idempotency-key"];
        const result = await generationQueue.submit(() => runIdempotentExport({
          apiKey, ownerKeyHash: job.ownerKeyHash, deckId: job.id, runDir: job.runDir!,
          format, outPath,
          idempotencyKey: typeof body.idempotency_key === "string"
            ? body.idempotency_key
            : typeof idempotencyKey === "string" ? idempotencyKey : undefined,
          execute: () => exportDeck({ runDir: job.runDir!, outPath, format }),
        }));
        return json(res, 200, result);
      }
    }

    if (url.pathname === "/mcp") {
      if (!await userAuthorized(req, res)) return;
      const apiKey = req.headers["x-api-key"] as string | undefined;
      const mcpServer = createSlideForgeMcpServer({ apiKey, queue: generationQueue, deckConcurrency: DECK_CONCURRENCY });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      try {
        const body = req.method === "POST" ? await readBody(req) : undefined;
        await transport.handleRequest(req, res, body);
      } finally { await mcpServer.close(); }
      return;
    }
    return json(res, 404, { error: "not found", path: url.pathname });
  } catch (error) {
    if (res.headersSent) return res.end();
    if (error instanceof QueueFullError) {
      return json(res, 503, { error: error.message }, { "retry-after": "30" });
    }
    const status = error instanceof HttpRequestError ? error.status : 500;
    return json(res, status, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.requestTimeout = 60_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.listen(PORT, () => console.log(`[slideforge] capability server listening on http://localhost:${PORT}`));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  const force = setTimeout(() => process.exit(1), 30_000);
  force.unref();
  server.closeAllConnections();
  const { closeValidatorBrowser } = await import("../../scripts/m0/validatePage.js");
  await closeValidatorBrowser().catch(() => undefined);
  clearTimeout(force);
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
