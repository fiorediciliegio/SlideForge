import path from "node:path";
import { createHash } from "node:crypto";
import { buildDeckPageScreenshotFromManifest } from "../render/build-deck-from-manifest.js";
import { readFile, realpath, stat, link, unlink } from "node:fs/promises";
import { readManualPageRevision } from "../manual-page-revisions/index.js";
import { PREVIEW_HTML_MAX_BYTES } from "./limits.js";

/** Reads a static artifact without executing Page Source or changing the Workspace. */
export async function readWorkspacePageSnapshot(workspaceDir: string, htmlPath: string) {
  if (!htmlPath) throw new Error("Page has no rendered HTML snapshot");
  const [root, resolved] = await Promise.all([realpath(workspaceDir), realpath(htmlPath)]);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Preview HTML is outside its Workspace");
  }
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("Page HTML is not a file");
  if (info.size > PREVIEW_HTML_MAX_BYTES) throw new Error("Preview HTML exceeds 64 MiB");
  const html = await readFile(resolved, "utf8");
  if (Buffer.byteLength(html, "utf8") > PREVIEW_HTML_MAX_BYTES) throw new Error("Preview HTML exceeds 64 MiB");
  return { htmlPath: resolved, html };
}

const preparations = new Map<string, Promise<{ htmlPath: string; html: string }>>();
const hash = (html: string) => createHash("sha256").update(html).digest("hex");

/** Static saved pages can be consumed directly; executable sources must render first. */
export function isStaticPageSource(html: string): boolean {
  return /data-presenton-slide-shell\s*=\s*["']true["']/i.test(html)
    && !/<(?:script|iframe|object|embed)\b/i.test(html);
}

/** slides/ is authoritative. Cached HTML is disposable and never gates recovery. */
export async function resolveCurrentPageSnapshot(input: {
  workspaceDir: string;
  pageId: string;
  snapshotPath?: string;
}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.pageId)) throw new Error("Invalid page_id");
  // This idempotently promotes legacy current.html before reading the source.
  const manual = await readManualPageRevision(input.workspaceDir, input.pageId);
  const source = await readWorkspacePageSnapshot(input.workspaceDir,
    path.join(input.workspaceDir, "slides", `${input.pageId}.html`));
  if (isStaticPageSource(source.html)) return { ...source, manual };
  const sourceHash = hash(source.html);
  if (input.snapshotPath) {
    const progress = JSON.parse(await readFile(path.join(input.workspaceDir, "page-progress.json"), "utf8"));
    const page = progress.pages?.find((item: { page_id: string }) => item.page_id === input.pageId);
    if ((page?.snapshot_source_sha256 ?? page?.screenshot_source_sha256) === sourceHash) {
      try { return { ...await readWorkspacePageSnapshot(input.workspaceDir, input.snapshotPath), manual }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  const manifestPath = path.join(input.workspaceDir, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const renderHash = hash(input.pageId + sourceHash + manifestBytes.toString("utf8"));
  const key = `${path.resolve(input.workspaceDir)}\0${input.pageId}\0${renderHash}`;
  let pending = preparations.get(key);
  if (!pending) {
    pending = (async () => {
      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      const index = manifest.slides.findIndex((slide: { id: string }) => slide.id === input.pageId);
      if (index < 0) throw new Error("Unknown preview page");
      const cacheRoot = path.join(input.workspaceDir, "output", "page-preview-html");
      const cachedPath = path.join(cacheRoot, `${input.pageId}-current-${renderHash.slice(0, 24)}.html`);
      try { return await readWorkspacePageSnapshot(input.workspaceDir, cachedPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // The previous cache key omitted page identity. Reuse it only when the
      // rendered shell proves that it belongs to this page.
      const oldHash = hash(sourceHash + manifestBytes.toString("utf8"));
      const legacyPath = path.join(input.workspaceDir, "output", "current-page-previews", oldHash.slice(0, 24), "current.html");
      try {
        const legacy = await readWorkspacePageSnapshot(input.workspaceDir, legacyPath);
        if (legacy.html.includes(`data-presenton-page-id="${input.pageId}"`)) return legacy;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const output = path.join(cacheRoot, ".preparing");
      const result = await buildDeckPageScreenshotFromManifest({ manifestPath,
        outputDir: output, htmlOutputDir: cacheRoot,
        name: `preparing-${renderHash.slice(0, 24)}`, page: index + 1, screenshot: false });
      try {
        if (hash(await readFile(source.htmlPath, "utf8")) !== sourceHash
          || !(await readFile(manifestPath)).equals(manifestBytes)) throw new Error("Page preview version changed");
        try { await link(result.htmlPath, cachedPath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      } finally {
        await unlink(result.htmlPath).catch(() => undefined);
      }
      return readWorkspacePageSnapshot(input.workspaceDir, cachedPath);
    })();
    preparations.set(key, pending);
  }
  try {
    const snapshot = await pending;
    if (hash(await readFile(source.htmlPath, "utf8")) !== sourceHash
      || !(await readFile(manifestPath)).equals(manifestBytes)) throw new Error("Page preview version changed");
    return { ...snapshot, manual };
  }
  finally { if (preparations.get(key) === pending) preparations.delete(key); }
}
