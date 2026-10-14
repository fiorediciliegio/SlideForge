import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const IMAGE_ASSET_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export function imageAssetFileName(sha256: string, mimeType: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid image asset SHA-256");
  const extension = IMAGE_ASSET_EXTENSIONS[mimeType];
  if (!extension) throw new Error(`Unsupported image asset MIME type: ${mimeType}`);
  return `image-${sha256.slice(0, 16)}${extension}`;
}

/** 短文件名用于页面引用；完整哈希防止并发入库或短标识冲突覆盖已有图片。 */
export async function writeImageAssetFile(input: {
  directory: string; bytes: Buffer; sha256: string; mimeType: string;
}): Promise<string> {
  const target = path.join(input.directory, imageAssetFileName(input.sha256, input.mimeType));
  await mkdir(input.directory, { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, input.bytes, { flag: "wx" });
    try {
      // Publish complete bytes without replacing another writer's file.
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(target);
      if (createHash("sha256").update(existing).digest("hex") !== input.sha256) {
        throw new Error(`Image asset short identifier collision: ${path.basename(target)}`);
      }
    }
    return target;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
