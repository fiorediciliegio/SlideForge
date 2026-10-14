import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { writeSlideScreenshots } from "../render/browser-artifacts.js";
import { fingerprintPageSnapshot } from "./snapshot.js";

export const PAGE_THUMBNAIL_MAX_EDGE = 640;
const queues = new Map<string, Promise<unknown>>();
class ThumbnailBusy extends Error {}
interface ThumbnailRecord {
  version: 1;
  preview_source_fingerprint: string;
  width: number;
  height: number;
  size_bytes: number;
  generated_at: string;
}

/** One current WebP per page. This disposable cache never executes Page Source. */
export async function ensurePageThumbnail(input: {
  workspaceDir: string; pageId: string; htmlPath: string; expectedFingerprint?: string;
}, capture = writeSlideScreenshots, skipIfBusy = false) {
  const root = await realpath(input.workspaceDir);
  const pageKey = createHash("sha256").update(input.pageId).digest("hex");
  const directory = path.join(root, "output", "page-thumbnails", pageKey);
  // A render callback already owns a browser slot. Never wait here for a
  // thumbnail request that may itself be waiting for that browser slot.
  if (skipIfBusy && queues.has(directory)) throw new ThumbnailBusy();
  const previous = queues.get(directory) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const version = await fingerprintPageSnapshot(root, input.htmlPath);
    if (input.expectedFingerprint && input.expectedFingerprint !== version) throw new Error("Page thumbnail version changed");
    await mkdir(directory, { recursive: true });
    const relative = path.relative(root, await realpath(directory));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Thumbnail cache is outside its Workspace");
    const imagePath = path.join(directory, `${version}.webp`);
    const recordPath = path.join(directory, "current.json");
    const cached: ThumbnailRecord | null = await readFile(recordPath, "utf8").then(JSON.parse).catch(() => null);
    if (cached?.version === 1 && cached.preview_source_fingerprint === version
      && await stat(imagePath).then((info) => info.isFile() && info.size === cached.size_bytes).catch(() => false)) {
      return { ...cached, page_id: input.pageId, image_path: imagePath };
    }
    const temporary = path.join(directory, `${randomUUID()}.tmp.webp`);
    const temporaryRecord = `${temporary}.json`;
    try {
      await capture([{ html: "", htmlPath: input.htmlPath, outputPath: temporary }], "Page WebP thumbnail",
        { requireTailwind: false, thumbnailMaxEdge: PAGE_THUMBNAIL_MAX_EDGE });
      if (await fingerprintPageSnapshot(root, input.htmlPath) !== version) throw new Error("Page changed during thumbnail capture");
      // Read bytes rather than keeping a libvips file handle open on Windows.
      const bytes = await readFile(temporary);
      const metadata = await sharp(bytes).metadata();
      if (metadata.format !== "webp" || !metadata.width || !metadata.height
        || Math.max(metadata.width, metadata.height) > PAGE_THUMBNAIL_MAX_EDGE) throw new Error("Invalid page WebP thumbnail");
      const record: ThumbnailRecord = { version: 1, preview_source_fingerprint: version,
        width: metadata.width, height: metadata.height, size_bytes: bytes.length, generated_at: new Date().toISOString() };
      await writeFile(temporaryRecord, JSON.stringify(record));
      await rename(temporary, imagePath);
      await rename(temporaryRecord, recordPath);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".webp") && entry.name !== path.basename(imagePath)) {
          await rm(path.join(directory, entry.name), { force: true });
        }
      }
      return { ...record, page_id: input.pageId, image_path: imagePath };
    } finally {
      await rm(temporary, { force: true });
      await rm(temporaryRecord, { force: true });
    }
  });
  queues.set(directory, operation);
  try { return await operation; }
  finally { if (queues.get(directory) === operation) queues.delete(directory); }
}

/** Preview cache failures must not change generation/save/adoption success. */
export async function preparePageThumbnail(input: Parameters<typeof ensurePageThumbnail>[0], capture = writeSlideScreenshots) {
  await ensurePageThumbnail(input, capture, true).catch((error) => {
    if (error instanceof ThumbnailBusy) return;
    console.warn("Deferred page thumbnail:", error instanceof Error ? error.message : String(error));
  });
}
