import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { convertImageToWebp } from "../src/image.mjs";

test("validated WebPs do not keep a staged preset directory locked", async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-deck-preview-image-lock-"));
  try {
    const sourcePath = join(root, "source.png");
    const stagedPreset = join(root, "staging", "preset");
    const stagedImages = join(stagedPreset, "images");
    await sharp(Buffer.from('<svg width="16" height="9"><rect width="16" height="9" fill="#3355aa"/></svg>'))
      .png()
      .toFile(sourcePath);
    await mkdir(stagedImages, { recursive: true });

    for (let index = 0; index < 3; index += 1) {
      await convertImageToWebp(sourcePath, join(stagedImages, `${index}.webp`), 90);
    }

    await mkdir(join(root, "published"));
    await assert.doesNotReject(rename(stagedPreset, join(root, "published", "preset")));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
