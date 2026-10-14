import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { imageAssetFileName, writeImageAssetFile } from "../src/app-workspace/image-asset-file.js";

test("相同配图并发入库复用完整文件，不留下临时文件", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ppt-image-asset-"));
  try {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).png().toBuffer();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const files = await Promise.all(Array.from({ length: 4 }, () => writeImageAssetFile({ directory, bytes, sha256, mimeType: "image/png" })));
    assert.equal(new Set(files).size, 1);
    assert.equal(path.basename(files[0]!), `image-${sha256.slice(0, 16)}.png`);
    assert.deepEqual(await readFile(files[0]!), bytes);
    assert.deepEqual(await readdir(directory), [path.basename(files[0]!)]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("短文件名已被不同内容占用时拒绝覆盖", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ppt-image-collision-"));
  try {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const filename = imageAssetFileName(sha256, "image/png");
    const original = Buffer.from("Another existing image");
    await writeFile(path.join(directory, filename), original);
    await assert.rejects(writeImageAssetFile({ directory, bytes, sha256, mimeType: "image/png" }), /short identifier collision/);
    assert.deepEqual(await readFile(path.join(directory, filename)), original);
    assert.deepEqual(await readdir(directory), [filename]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
