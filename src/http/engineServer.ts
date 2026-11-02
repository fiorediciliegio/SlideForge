import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { ZodError } from "zod";

import { loadDotEnv } from "../server/env.js";

loadDotEnv();

import { exportDeck, getDeckPreview } from "../capabilities/deck.js";
import { engineExportSchema, enginePreviewSchema, engineValidatePageSchema } from "../contracts/engine.js";
import { apiError } from "../contracts/errors.js";
import { HttpRequestError, applySecurityHeaders, readJsonBody } from "../server/httpSecurity.js";
import { closeValidatorBrowser, validateSlideHtmlFile } from "../../scripts/m0/validatePage.js";

const PORT = Number(process.env.ENGINE_PORT ?? 3211);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN?.trim();
const DECKS_ROOT = path.resolve(
  process.env.SLIDEFORGE_DECKS_ROOT ?? path.join(import.meta.dirname, "..", "..", "artifacts", "decks"),
);

if (process.env.NODE_ENV === "production" && !INTERNAL_TOKEN) {
  throw new Error("生产引擎服务必须配置 GATEWAY_INTERNAL_TOKEN");
}

function json(res: ServerResponse, status: number, payload: unknown) {
  const normalized = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    && "error" in payload && typeof payload.error === "string"
    ? { ...apiError(status, payload.error), ...payload }
    : payload;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(normalized));
}

function internalAuthorized(req: IncomingMessage): boolean {
  if (!INTERNAL_TOKEN) return false;
  const supplied = req.headers["x-internal-token"];
  if (typeof supplied !== "string") return false;
  const expected = Buffer.from(INTERNAL_TOKEN);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function resolveRunDir(raw: string): string {
  const runDir = path.resolve(raw);
  if (path.dirname(runDir) !== DECKS_ROOT) {
    throw new HttpRequestError(400, "runDir 必须是 Decks 根目录下的直接子目录");
  }
  return runDir;
}

function resolveExportPath(runDir: string, raw: string | undefined, format: "pptx" | "pdf"): string {
  const output = path.resolve(runDir, raw ?? `deck.${format}`);
  if (path.dirname(output) !== runDir) {
    throw new HttpRequestError(400, "outPath 必须直接位于当前 deck 工作区内");
  }
  return output;
}

const server = createServer(async (req, res) => {
  applySecurityHeaders(res);
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, { ok: true, service: "slideforge-engine" });
    }
    if (!internalAuthorized(req)) return json(res, 404, { error: "not found" });

    if (req.method === "POST" && url.pathname === "/internal/engine/validate-page") {
      const body = engineValidatePageSchema.parse(await readJsonBody(req, MAX_BODY_BYTES));
      const temporary = await mkdtemp(path.join(os.tmpdir(), "slideforge-engine-validate-"));
      try {
        const file = path.join(temporary, "page.html");
        await writeFile(file, body.html, "utf8");
        return json(res, 200, await validateSlideHtmlFile(file));
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }

    if (req.method === "POST" && url.pathname === "/internal/engine/preview") {
      const body = enginePreviewSchema.parse(await readJsonBody(req, MAX_BODY_BYTES));
      const images = await getDeckPreview({
        runDir: resolveRunDir(body.runDir), pages: body.pages, maxPages: body.maxPages,
      });
      return json(res, 200, { images });
    }

    if (req.method === "POST" && url.pathname === "/internal/engine/export") {
      const body = engineExportSchema.parse(await readJsonBody(req, MAX_BODY_BYTES));
      const runDir = resolveRunDir(body.runDir);
      const format = body.format ?? "pptx";
      const result = await exportDeck({
        runDir, outPath: resolveExportPath(runDir, body.outPath, format), format,
      });
      return json(res, 200, result);
    }
    return json(res, 404, { error: "not found" });
  } catch (error) {
    if (error instanceof ZodError) {
      return json(res, 400, {
        error: "请求参数无效",
        details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    const status = error instanceof HttpRequestError ? error.status : 500;
    return json(res, status, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.requestTimeout = 600_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.listen(PORT, () => {
  console.log(`[slideforge-engine] listening on http://localhost:${PORT}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  server.closeAllConnections();
  await closeValidatorBrowser().catch(() => undefined);
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
