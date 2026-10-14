import { slideFormatFromHtml, stampSlideFormat } from "../slide-format.js";
import { readWorkspaceSlideFormat } from "../workspace-slide-format.js";
import path from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { publishPageRegenerationFiles, recoverPageRegenerationPublication } from "../page-regeneration/store.js";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { rewriteHtmlResourceReferences } from "../page-html-preview/resources.js";
import { injectWorkspaceManagedFontCss } from "../font-library/index.js";

export const MANUAL_HTML_MAX_BYTES = 64 * 1024 * 1024;
const revisionPublishQueues = new Map<string, Promise<unknown>>();
const deckPublishQueues = new Map<string, Promise<unknown>>();
const WORKSPACE_LOCAL_IMAGE_ROOTS = [
  "research/evidence/images",
  "page-assets",
  "uploaded-sources/asset",
  "fonts",
] as const;

export interface ManualPageRevisionManifest {
  version: 1;
  source_authority?: "slides";
  page_id: string;
  revision: number;
  manually_edited: true;
  base_source_sha256: string;
  base_html_sha256: string;
  current_html_sha256: string;
  base_html_path: string;
  current_html_path: string;
  screenshot_path: string;
  updated_at: string;
}

export interface ManualPageRevisionPaths {
  directory: string;
  manifest: string;
  baseHtml: string;
  currentHtml: string;
  screenshot: string;
  assetsDirectory: string;
}

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPageId(pageId: string): string {
  const normalized = pageId.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized)) {
    throw new Error(`Invalid page_id "${pageId}"`);
  }
  return normalized;
}

export function manualPageRevisionPaths(workspaceDir: string, pageId: string): ManualPageRevisionPaths {
  const safePageId = assertPageId(pageId);
  const directory = path.join(workspaceDir, "manual-edits", safePageId);
  return {
    directory,
    manifest: path.join(directory, "manifest.json"),
    baseHtml: path.join(directory, "base.html"),
    currentHtml: path.join(directory, "current.html"),
    screenshot: path.join(directory, "current.png"),
    assetsDirectory: path.join(workspaceDir, "page-assets", safePageId),
  };
}

export async function readManualPageRevision(
  workspaceDir: string,
  pageId: string,
): Promise<ManualPageRevisionManifest | null> {
  const paths = manualPageRevisionPaths(workspaceDir, pageId);
  try {
    recoverPageRegenerationPublication(workspaceDir);
    const value = JSON.parse(readFileSync(paths.manifest, "utf8")) as Partial<ManualPageRevisionManifest>;
    if (
      value.version !== 1 || value.page_id !== pageId || value.manually_edited !== true ||
      !Number.isInteger(value.revision) || Number(value.revision) < 1
    ) {
      throw new Error(`Invalid Manual Page Revision manifest for ${pageId}`);
    }
    delete (value as Record<string, unknown>).agent_html_path;
    if (value.source_authority === "slides") {
      const sourcePath = path.join(workspaceDir, "slides", `${assertPageId(pageId)}.html`);
      return { ...value, base_html_path: sourcePath, current_html_path: sourcePath } as ManualPageRevisionManifest;
    }
    // Legacy revisions are promoted once. Publish the source and migration
    // marker together, so a crash/reopen cannot reinstate an older revision.
    const root = realpathSync(workspaceDir);
    const currentPath = realpathSync(paths.currentHtml);
    if (!isPathWithin(root, currentPath)) throw new Error("Manual HTML is outside its Workspace");
    const html = readFileSync(currentPath, "utf8");
    extractSlideShell(html);
    const sourcePath = path.join(workspaceDir, "slides", `${assertPageId(pageId)}.html`);
    const next = { ...value, source_authority: "slides" as const,
      base_source_sha256: hash(html), base_html_sha256: hash(html), current_html_sha256: hash(html),
      base_html_path: sourcePath, current_html_path: sourcePath } as ManualPageRevisionManifest;
    publishPageRegenerationFiles(workspaceDir, new Map([
      [path.relative(workspaceDir, sourcePath), html],
      [path.relative(workspaceDir, paths.manifest), JSON.stringify(next, null, 2)],
      [path.relative(workspaceDir, paths.baseHtml), null],
      [path.relative(workspaceDir, paths.currentHtml), null],
    ]));
    return next;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT"
      && "path" in error && error.path === paths.manifest) return null;
    throw error;
  }
}

export async function removeManualPageRevision(workspaceDir: string, pageId: string): Promise<void> {
  await rm(manualPageRevisionPaths(workspaceDir, pageId).directory, { recursive: true, force: true });
}

export async function removePageOwnedManualArtifacts(workspaceDir: string, pageId: string): Promise<void> {
  const paths = manualPageRevisionPaths(workspaceDir, pageId);
  await rm(paths.directory, { recursive: true, force: true });
  await rm(paths.assetsDirectory, { recursive: true, force: true });
}

export async function removeAllManualPageRevisions(workspaceDir: string): Promise<void> {
  await rm(path.join(workspaceDir, "manual-edits"), { recursive: true, force: true });
  await rm(path.join(workspaceDir, "page-assets"), { recursive: true, force: true });
}

function removeActiveContent(html: string): string {
  let next = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<(?:iframe|frame|frameset|object|embed|applet|form)\b[^>]*>[\s\S]*?<\/(?:iframe|frame|frameset|object|embed|applet|form)\s*>/gi, "")
    .replace(/<(?:iframe|frame|object|embed|applet|form)\b[^>]*\/?>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");
  next = next.replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  next = next.replace(/\s+(href|src|action|formaction)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, "");
  next = next.replace(/@import\s+[^;]+;?/gi, "");
  next = next.replace(/(?:expression|-moz-binding)\s*:[^;"']+/gi, "");
  next = next.replace(/url\(\s*["']?\s*javascript:[^)]+\)/gi, "none");
  return next;
}

function ensureEditorCsp(html: string): string {
  const withoutOld = html.replace(/<meta\b[^>]*data-ppt-editor-csp=["']true["'][^>]*>/gi, "");
  const csp = '<meta data-ppt-editor-csp="true" http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: file: http: https:; style-src \'unsafe-inline\'; font-src data: file: http: https:; media-src data: file: http: https:; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; form-action \'none\'; base-uri \'none\'">';
  return /<head\b[^>]*>/i.test(withoutOld)
    ? withoutOld.replace(/<head\b[^>]*>/i, (match) => `${match}\n${csp}`)
    : withoutOld.replace(/<html\b[^>]*>/i, (match) => `${match}\n<head>${csp}</head>`);
}

function findMatchingDivEnd(html: string, startIndex: number): number {
  const tagPattern = /<\/?div\b[^>]*>/gi;
  tagPattern.lastIndex = startIndex;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html))) {
    const closing = /^<\/div/i.test(match[0]);
    if (closing) depth -= 1;
    else depth += 1;
    if (depth === 0) return tagPattern.lastIndex;
  }
  throw new Error("Slide shell has no matching closing div");
}

export function extractSlideShell(html: string): { shell: string; start: number; end: number } {
  const matches = Array.from(html.matchAll(/<div\b[^>]*data-presenton-slide-shell\s*=\s*["']true["'][^>]*>/gi));
  if (matches.length !== 1 || matches[0].index === undefined) {
    throw new Error(`Manual page HTML must contain exactly one slide shell; found ${matches.length}`);
  }
  const start = matches[0].index;
  const end = findMatchingDivEnd(html, start);
  return { shell: html.slice(start, end), start, end };
}

export function ensureSinglePageSlideShell(html: string): string {
  const { width, height } = slideFormatFromHtml(html);
  if (/data-presenton-slide-shell\s*=\s*["']true["']/i.test(html)) {
    extractSlideShell(html);
    return html;
  }
  const wrapperOpen = /<div\b[^>]*id\s*=\s*["']presentation-slides-wrapper["'][^>]*>/i.exec(html);
  if (!wrapperOpen || wrapperOpen.index === undefined) {
    throw new Error('Manual page HTML must contain "#presentation-slides-wrapper"');
  }
  const contentStart = wrapperOpen.index + wrapperOpen[0].length;
  const wrapperEnd = findMatchingDivEnd(html, wrapperOpen.index);
  const contentEnd = html.lastIndexOf("</div", wrapperEnd);
  if (contentEnd < contentStart) throw new Error("Unable to locate page wrapper contents");
  const content = html.slice(contentStart, contentEnd);
  return `${html.slice(0, contentStart)}<div data-presenton-slide-shell="true" style="position:relative;display:block;width:${width}px;height:${height}px;overflow:hidden;">${content}</div>${html.slice(contentEnd)}`;
}

function ensureShellDimensions(html: string): string {
  const { width, height } = slideFormatFromHtml(html);
  const extracted = extractSlideShell(html);
  const openingEnd = extracted.shell.indexOf(">");
  const opening = extracted.shell.slice(0, openingEnd + 1);
  const rest = extracted.shell.slice(openingEnd + 1);
  const styleMatch = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(opening);
  const required = `position:relative;display:block;width:${width}px;height:${height}px;overflow:hidden;`;
  const nextOpening = styleMatch
    ? opening.replace(styleMatch[0], ` style=${styleMatch[1]}${styleMatch[2]};${required}${styleMatch[1]}`)
    : opening.replace(/>$/, ` style="${required}">`);
  return `${html.slice(0, extracted.start)}${nextOpening}${rest}${html.slice(extracted.end)}`;
}

const RESOURCE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".avif": "image/avif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};
function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Newly selected images are stored once, independently of the HTML revision. */
export async function storeManualPageImage(workspaceDir: string, pageId: string, bytes: Buffer, mimeType: string) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType) || !bytes.length || bytes.length > 20 * 1024 * 1024) {
    throw new Error("Manual image must be PNG, JPEG or WebP and at most 20 MiB");
  }
  const metadata = await sharp(bytes, { animated: false }).metadata();
  const expected = mimeType === "image/jpeg" ? "jpeg" : mimeType.slice(6);
  if (metadata.format !== expected || !metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192 || (metadata.pages ?? 1) > 1) {
    throw new Error("Invalid manual image format or dimensions");
  }
  const extension = expected === "jpeg" ? ".jpg" : `.${expected}`;
  const directory = manualPageRevisionPaths(workspaceDir, pageId).assetsDirectory;
  await mkdir(directory, { recursive: true });
  const root = await realpath(workspaceDir);
  if (!isPathWithin(root, await realpath(directory))) throw new Error("Manual image directory is outside Workspace");
  const filePath = path.join(directory, `${hash(bytes)}${extension}`);
  await writeFile(filePath, bytes, { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  if (!isPathWithin(root, await realpath(filePath)) || hash(await readFile(filePath)) !== hash(bytes)) throw new Error("Invalid existing manual image asset");
  return { local_url: pathToFileURL(await realpath(filePath)).href, width: metadata.width, height: metadata.height };
}

/** Normalize legacy embedded assets and validate every local resource before rendering. */
export async function normalizeManualPageResources(workspaceDir: string, pageId: string, html: string, htmlPath?: string): Promise<string> {
  const root = await realpath(workspaceDir);
  const roots = (await Promise.all(WORKSPACE_LOCAL_IMAGE_ROOTS.map(async (relative) => {
    const candidate = await realpath(path.join(root, relative)).catch(() => null);
    return candidate && isPathWithin(root, candidate) ? candidate : null;
  }))).filter((value): value is string => Boolean(value));
  const pending = new Map<string, Promise<string>>();
  return rewriteHtmlResourceReferences(html, (reference) => {
    if (!reference || reference.startsWith("#") || /^(?:https:)?\/\//i.test(reference)) return Promise.resolve(reference);
    const existing = pending.get(reference);
    if (existing) return existing;
    const operation = (async () => {
      if (/^data:/i.test(reference)) {
        const match = /^data:([^;,]+)((?:;[^,]*)?),([\s\S]*)$/i.exec(reference);
        const extension = match && Object.keys(RESOURCE_MIME).find((key) => RESOURCE_MIME[key] === match[1].toLowerCase());
        if (!match || !extension) throw new Error("Unsupported embedded manual resource");
        const bytes = /;base64(?:;|$)/i.test(match[2]) ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
        if (bytes.length > 20 * 1024 * 1024) throw new Error("Manual resource exceeds 20 MiB");
        if (["image/png", "image/jpeg", "image/webp"].includes(match[1])) return (await storeManualPageImage(workspaceDir, pageId, bytes, match[1])).local_url;
        const directory = manualPageRevisionPaths(workspaceDir, pageId).assetsDirectory;
        await mkdir(directory, { recursive: true });
        if (!isPathWithin(root, await realpath(directory))) throw new Error("Manual resource is outside Workspace");
        const destination = path.join(directory, `${hash(bytes)}${extension}`);
        await writeFile(destination, bytes, { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
        if (!isPathWithin(root, await realpath(destination)) || hash(await readFile(destination)) !== hash(bytes)) throw new Error("Invalid existing manual resource asset");
        return pathToFileURL(await realpath(destination)).href;
      }
      if (/^[a-z][a-z\d+.-]*:/i.test(reference) && !/^file:/i.test(reference) && !/^[a-z]:[\\/]/i.test(reference)) throw new Error("Unsupported manual resource URL");
      const url = /^file:/i.test(reference) ? new URL(reference) : null;
      const fragment = url?.hash ?? (reference.includes("#") ? reference.slice(reference.indexOf("#")) : "");
      const filename = url ? fileURLToPath(url) : path.resolve(path.dirname(htmlPath ?? path.join(workspaceDir, "slides", `${pageId}.html`)), decodeURIComponent(reference.split(/[?#]/, 1)[0]));
      const resolved = await realpath(filename);
      if (!roots.some((allowed) => isPathWithin(allowed, resolved))) throw new Error("Manual resource is outside allowed Workspace assets");
      const info = await stat(resolved);
      if (!info.isFile() || info.size > 20 * 1024 * 1024 || !RESOURCE_MIME[path.extname(resolved).toLowerCase()]) throw new Error("Invalid manual resource file");
      return `${pathToFileURL(resolved).href}${fragment}`;
    })();
    pending.set(reference, operation);
    return operation;
  });
}

export async function sanitizeManualPageHtml(
  workspaceDir: string,
  pageId: string,
  inputHtml: string,
): Promise<{ currentHtml: string }> {
  if (Buffer.byteLength(inputHtml, "utf8") > MANUAL_HTML_MAX_BYTES) {
    throw new Error(`Manual page HTML exceeds ${MANUAL_HTML_MAX_BYTES} bytes`);
  }
  const { aspectRatio } = await readWorkspaceSlideFormat(workspaceDir);
  let html = ensureSinglePageSlideShell(stampSlideFormat(removeActiveContent(inputHtml), aspectRatio));
  html = ensureShellDimensions(html);

  html = await injectWorkspaceManagedFontCss(workspaceDir, html);
  extractSlideShell(html);
  return { currentHtml: ensureEditorCsp(await normalizeManualPageResources(workspaceDir, pageId, html)) };
}

async function writeAtomic(filePath: string, value: string | Buffer): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, value);
  await rename(temporaryPath, filePath);
}

export async function publishManualPageIntoDeck(input: {
  deckHtmlPath: string;
  pageHtmlPath: string;
  pageIndex: number;
}): Promise<void> {
  const deckHtmlPath = path.resolve(input.deckHtmlPath);
  const previous = deckPublishQueues.get(deckHtmlPath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const [deckHtml, pageHtml] = await Promise.all([
      readFile(deckHtmlPath, "utf8"),
      readFile(path.resolve(input.pageHtmlPath), "utf8"),
    ]);
    const replacementShell = extractSlideShell(pageHtml).shell;
    await writeAtomic(
      deckHtmlPath,
      replaceSlideShellAtIndex(deckHtml, input.pageIndex, replacementShell),
    );
  });
  const tail = run.catch(() => undefined);
  deckPublishQueues.set(deckHtmlPath, tail);
  try {
    await run;
  } finally {
    if (deckPublishQueues.get(deckHtmlPath) === tail) deckPublishQueues.delete(deckHtmlPath);
  }
}

export async function publishManualPageRevision(input: {
  workspaceDir: string;
  pageId: string;
  baseRevision: number;
  baseHtml: string;
  currentHtml: string;
  screenshotPath?: string;
  sourceBytes: Buffer;
}): Promise<ManualPageRevisionManifest> {
  const queueKey = `${path.normalize(input.workspaceDir)}\0${assertPageId(input.pageId)}`;
  const previous = revisionPublishQueues.get(queueKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const paths = manualPageRevisionPaths(input.workspaceDir, input.pageId);
    const existing = await readManualPageRevision(input.workspaceDir, input.pageId);
    const currentRevision = existing?.revision ?? 0;
    if (input.baseRevision !== currentRevision) {
      throw new Error(`Manual Page Revision conflict: expected ${currentRevision}, received ${input.baseRevision}`);
    }
    const sourcePath = path.join(input.workspaceDir, "slides", `${input.pageId}.html`);
    // Also guard source replacement by generation/adoption during validation.
    if (!readFileSync(sourcePath).equals(input.sourceBytes)) throw new Error("Page source changed while saving");
    const updatedAt = new Date().toISOString();
    const manifest: ManualPageRevisionManifest = {
      version: 1, source_authority: "slides", page_id: input.pageId,
      revision: currentRevision + 1, manually_edited: true,
      base_source_sha256: hash(input.currentHtml), base_html_sha256: hash(input.currentHtml),
      current_html_sha256: hash(input.currentHtml), base_html_path: sourcePath,
      current_html_path: sourcePath, screenshot_path: "", updated_at: updatedAt,
    };
    publishPageRegenerationFiles(input.workspaceDir, new Map([
      [path.relative(input.workspaceDir, sourcePath), input.currentHtml],
      [path.relative(input.workspaceDir, paths.manifest), JSON.stringify(manifest, null, 2)],
      [path.relative(input.workspaceDir, paths.baseHtml), null],
      [path.relative(input.workspaceDir, path.join(paths.directory, "current.agent.html")), null],
      [path.relative(input.workspaceDir, paths.currentHtml), null],
    ]));
    return manifest;
  });
  const tail = run.catch(() => undefined);
  revisionPublishQueues.set(queueKey, tail);
  try {
    return await run;
  } finally {
    if (revisionPublishQueues.get(queueKey) === tail) revisionPublishQueues.delete(queueKey);
  }
}

export function replaceSlideShellAtIndex(deckHtml: string, index: number, replacementShell: string): string {
  const matches = Array.from(deckHtml.matchAll(/<div\b[^>]*data-presenton-slide-shell\s*=\s*["']true["'][^>]*>/gi));
  const target = matches[index];
  if (!target || target.index === undefined) throw new Error(`Deck HTML is missing slide shell ${index + 1}`);
  const end = findMatchingDivEnd(deckHtml, target.index);
  const originalShell = deckHtml.slice(target.index, end);
  const notes = originalShell.match(/<template\b[^>]*\bdata-pptx-notes(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>[\s\S]*?<\/template\s*>/i)?.[0];
  const replacementHasNotes = /<template\b[^>]*\bdata-pptx-notes(?:\s*=|\s|>)/i.test(replacementShell);
  let nextShell = markManualPageRevisionShell(replacementShell);
  if (notes && !replacementHasNotes) {
    const closingIndex = nextShell.toLowerCase().lastIndexOf("</div");
    if (closingIndex < 0) throw new Error("Replacement slide shell has no matching closing div");
    nextShell = `${nextShell.slice(0, closingIndex)}${notes}${nextShell.slice(closingIndex)}`;
  }
  return `${deckHtml.slice(0, target.index)}${nextShell}${deckHtml.slice(end)}`;
}

function markManualPageRevisionShell(shell: string): string {
  const openingEnd = shell.indexOf(">");
  if (openingEnd < 0) throw new Error("Replacement slide shell has no opening tag");
  const opening = shell.slice(0, openingEnd);
  const alreadyMarked = /\bdata-presenton-manual-page-revision\s*=\s*["']true["']/i.test(opening);
  const markedOpening = alreadyMarked
    ? opening
    : `${opening} data-presenton-manual-page-revision="true"`;

  // A manually edited shell is already final DOM. Leaving a deck slot inside it
  // would let the browser runtime overwrite the user's saved content with the
  // older Page Source during a later Final Deck Render.
  return `${markedOpening}${shell.slice(openingEnd)}`.replace(
    /\sdata-presenton-deck-slot\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    "",
  );
}

export function replaceSinglePageSlideShell(documentHtml: string, replacementShell: string): string {
  const normalized = ensureSinglePageSlideShell(documentHtml);
  const base = extractSlideShell(normalized);
  extractSlideShell(`<!doctype html><html><body>${replacementShell}</body></html>`);
  return `${normalized.slice(0, base.start)}${replacementShell}${normalized.slice(base.end)}`;
}

export async function assertFile(pathname: string): Promise<void> {
  const value = await stat(pathname);
  if (!value.isFile()) throw new Error(`Expected a file: ${pathname}`);
}
