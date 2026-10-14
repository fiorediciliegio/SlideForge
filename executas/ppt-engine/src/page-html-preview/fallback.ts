import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { slideFormat, type SlideAspectRatio } from "../slide-format.js";
import { manualPageRevisionPaths } from "../manual-page-revisions/index.js";
import { readWorkspacePageSnapshot } from "./current-page.js";
import { fingerprintPageSnapshot } from "./snapshot.js";

export type PreviewFallbackSource = "saved_snapshot" | "manual_base" | "thumbnail";

/** View-only candidates for exactly one page. Never reads or executes Page Source. */
export async function* readPagePreviewFallbacks(input: {
  workspaceDir: string; pageId: string; snapshotPath?: string; screenshotPath?: string; aspectRatio?: SlideAspectRatio;
}) {
  const manual = manualPageRevisionPaths(input.workspaceDir, input.pageId);
  const output = path.join(input.workspaceDir, "output", "page-preview-html");
  const files = await readdir(output, { withFileTypes: true }).catch(() => []);
  const snapshots = await Promise.all(files.filter((entry) => entry.isFile()
    && entry.name.endsWith(".html") && !/^\d+-preparing-[a-f0-9]{24}-/.test(entry.name)
    && (entry.name.includes(`-${input.pageId}`)
      || entry.name.startsWith(`${input.pageId}-current-`)))
    .map(async (entry) => ({ file: path.join(output, entry.name),
      mtime: await stat(path.join(output, entry.name)).then((info) => info.mtimeMs).catch(() => 0) })));
  snapshots.sort((a, b) => b.mtime - a.mtime);
  const candidates: Array<{ file: string; source: PreviewFallbackSource }> = [
    ...(input.snapshotPath && path.normalize(input.snapshotPath) !== path.normalize(manual.currentHtml)
      ? [{ file: input.snapshotPath, source: "saved_snapshot" as const }] : []),
    ...snapshots.slice(0, 4).map(({ file }) => ({ file, source: "saved_snapshot" as const })),
    { file: manual.baseHtml, source: "manual_base" },
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    try {
      const snapshot = await readWorkspacePageSnapshot(input.workspaceDir, candidate.file);
      if (seen.has(snapshot.htmlPath) || !snapshot.html.trim()) continue;
      seen.add(snapshot.htmlPath);
      // Resource fingerprinting rejects missing local assets. Continue to the
      // next candidate rather than returning a known broken backup.
      const version = await fingerprintPageSnapshot(input.workspaceDir, snapshot.htmlPath, snapshot.html);
      yield { page_id: input.pageId, html_path: snapshot.htmlPath, html: snapshot.html,
        html_fingerprint: createHash("sha256").update(snapshot.html).digest("hex"),
        preview_source_fingerprint: version, fallback: { source: candidate.source } };
    } catch { /* A missing backup does not make another backup unusable. */ }
  }
  // Last resort: an existing same-page image, without launching a browser.
  const thumbnailDirectory = path.join(input.workspaceDir, "output", "page-thumbnails",
    createHash("sha256").update(input.pageId).digest("hex"));
  const record = await readFile(path.join(thumbnailDirectory, "current.json"), "utf8").then(JSON.parse).catch(() => null);
  const images = [
    ...(typeof record?.preview_source_fingerprint === "string" && /^[a-f0-9]{64}$/.test(record.preview_source_fingerprint)
      ? [path.join(thumbnailDirectory, `${record.preview_source_fingerprint}.webp`)] : []),
    ...(input.screenshotPath ? [input.screenshotPath] : []),
  ];
  for (const file of images) {
    try {
      const [root, resolved] = await Promise.all([realpath(input.workspaceDir), realpath(file)]);
      const relative = path.relative(root, resolved);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) continue;
      const info = await stat(resolved);
      if (!info.isFile() || info.size > 8 * 1024 * 1024) continue;
      const bytes = await readFile(resolved);
      const metadata = await sharp(bytes).metadata();
      if (!metadata.width || !metadata.height || !["png", "jpeg", "webp"].includes(metadata.format ?? "")) continue;
      const format = slideFormat(input.aspectRatio);
      const html = `<!doctype html><html data-ppt-aspect-ratio="${format.aspectRatio}"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0} .slide{width:${format.width}px;height:${format.height}px}img{width:100%;height:100%;object-fit:contain}</style></head><body><div class="slide"><img alt="" src="data:image/${metadata.format};base64,${bytes.toString("base64")}"></div></body></html>`;
      const hash = createHash("sha256").update(html).digest("hex");
      yield { page_id: input.pageId, html_path: resolved, html, html_fingerprint: hash,
        preview_source_fingerprint: hash, fallback: { source: "thumbnail" as const } };
    } catch { /* No usable image; the caller reports the page-local failure. */ }
  }
}
