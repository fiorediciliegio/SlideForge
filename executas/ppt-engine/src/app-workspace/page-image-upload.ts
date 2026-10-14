import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { imageAssetFileName, writeImageAssetFile } from "./image-asset-file.js";

export const PAGE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES = 50;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const FORMATS: Record<string, { mime: string; extensions: string[] }> = {
  png: { mime: "image/png", extensions: [".png"] },
  jpeg: { mime: "image/jpeg", extensions: [".jpg", ".jpeg"] },
  webp: { mime: "image/webp", extensions: [".webp"] },
  gif: { mime: "image/gif", extensions: [".gif"] },
};

export interface PageUploadedImage {
  asset_id: string;
  file_path: string;
  file_name?: string;
  sha256: string;
  mime_type: string;
  bytes_size: number;
  width: number;
  height: number;
  aspect_ratio: number;
  source_filename: string;
  source_url: string;
  description: string;
  reason: string;
  matched_queries: string[];
}

function directory(workspace: string) { return path.join(workspace, "uploaded-sources", "asset", "manual"); }
function catalogPath(workspace: string) { return path.join(directory(workspace), "catalog.json"); }

// Paths are derived from content identities on read, so snapshots remain portable.
export async function readPageUploadedImages(workspace: string): Promise<PageUploadedImage[]> {
  let raw: string;
  try { raw = await readFile(catalogPath(workspace), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const catalog = JSON.parse(raw) as { version: number; images: PageUploadedImage[] };
  if (catalog.version !== 1 || !Array.isArray(catalog.images)) throw new Error("Invalid page image catalog");
  return catalog.images.map((image) => {
    if (!/^[a-f0-9]{64}$/.test(image.sha256) || image.asset_id !== `manual-${image.sha256}`) throw new Error("Invalid page image identity");
    const format = Object.values(FORMATS).find((entry) => entry.mime === image.mime_type);
    if (!format) throw new Error("Invalid page image format");
    if (image.file_name !== undefined && image.file_name !== imageAssetFileName(image.sha256, image.mime_type)) {
      throw new Error("Invalid page image filename");
    }
    // Historical catalogs omit file_name and retain their original long paths.
    return { ...image, file_path: path.join(directory(workspace), image.file_name ?? `${image.sha256}${format.extensions[0]}`) };
  });
}

async function save(workspace: string, images: PageUploadedImage[]) {
  const target = catalogPath(workspace);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, images: images.map(({ file_path: _path, ...image }) => image) }));
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => undefined); }
}

// The caller serializes writes using the workspace's uploaded-source queue.
export async function commitPageUploadedImage(input: {
  workspace_dir: string; filename: string; staging_file_path: string; expected_size_bytes: number;
  existing: Array<Record<string, unknown>>;
}): Promise<PageUploadedImage> {
  if (!Number.isSafeInteger(input.expected_size_bytes) || input.expected_size_bytes <= 0 || input.expected_size_bytes > PAGE_IMAGE_MAX_BYTES) {
    throw new Error("PAGE_IMAGE_FILE_TOO_LARGE");
  }
  if (!input.filename || input.filename.length > 180 || /[/\\\x00-\x1f]/u.test(input.filename)) throw new Error("PAGE_IMAGE_INVALID_FILE");
  const info = await stat(input.staging_file_path);
  if (!info.isFile() || info.size !== input.expected_size_bytes) throw new Error("PAGE_IMAGE_INVALID_FILE");
  const bytes = await readFile(input.staging_file_path);
  const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
  const format = FORMATS[metadata.format ?? ""];
  if (!format || !format.extensions.includes(path.extname(input.filename).toLowerCase()) || !metadata.width || !metadata.height) {
    throw new Error("PAGE_IMAGE_INVALID_FILE");
  }
  // Force decoding before publishing a catalog entry; a valid header alone is insufficient.
  await sharp(bytes, { limitInputPixels: 40_000_000 }).resize(1, 1).raw().toBuffer();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const images = await readPageUploadedImages(input.workspace_dir);
  const existing = input.existing.find((image) => image.sha256 === sha256);
  if (existing) return existing as unknown as PageUploadedImage;
  const previous = images.find((image) => image.sha256 === sha256);
  if (previous) return previous;
  if (images.length >= MAX_IMAGES || images.reduce((sum, image) => sum + image.bytes_size, 0) + bytes.length > MAX_TOTAL_BYTES) {
    throw new Error("PAGE_IMAGE_LIBRARY_LIMIT");
  }
  const filePath = await writeImageAssetFile({ directory: directory(input.workspace_dir), bytes, sha256, mimeType: format.mime });
  const image: PageUploadedImage = {
    asset_id: `manual-${sha256}`, file_path: filePath, file_name: path.basename(filePath), sha256, mime_type: format.mime, bytes_size: bytes.length,
    width: metadata.width, height: metadata.height, aspect_ratio: metadata.width / metadata.height,
    source_filename: input.filename, source_url: `manual-upload://${sha256}`, description: "",
    reason: "User explicitly uploaded this image for page illustration.", matched_queries: [],
  };
  await save(input.workspace_dir, [...images, image]);
  return image;
}

export async function resolvePageUploadedImage(workspace: string, id: string) {
  const image = (await readPageUploadedImages(workspace)).find((entry) => entry.asset_id === id);
  if (!image) throw new Error("PAGE_IMAGE_NOT_FOUND");
  const [root, source] = await Promise.all([realpath(workspace), realpath(image.file_path)]);
  const relative = path.relative(root, source);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Invalid page image path");
  const bytes = await readFile(source);
  if (bytes.length !== image.bytes_size || createHash("sha256").update(bytes).digest("hex") !== image.sha256) throw new Error("PAGE_IMAGE_CHANGED");
  return { ...image, file_path: source };
}

export async function describePageUploadedImage(workspace: string, id: string, description: string) {
  if (typeof description !== "string" || !description.trim() || description.trim().length > 400) throw new Error("PAGE_IMAGE_INVALID_DESCRIPTION");
  await resolvePageUploadedImage(workspace, id);
  const images = await readPageUploadedImages(workspace);
  const image = images.find((entry) => entry.asset_id === id)!;
  // Retrying an acknowledged or concurrently completed description is idempotent.
  if (!image.description) {
    image.description = description.trim();
    await save(workspace, images);
  }
  return image;
}
