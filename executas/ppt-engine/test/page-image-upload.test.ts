import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

test("手动配图独立入库、重试、去重、并发和快照恢复，不改变附件及大纲", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-manual-images-"));
  const previous = process.env.ANNA_WORKSPACE_DIR;
  process.env.ANNA_WORKSPACE_DIR = root;
  try {
    const api = await import("../src/app-workspace/index.js");
    const store = await import("../src/app-workspace/page-image-upload.js");
    const workspace = await api.createAppWorkspace({ title: "手动配图" });
    const workspace_dir = workspace.workspace_dir;
    await api.uploadAppUploadedSource({ workspace_dir, filename: "source.txt", mime_type: "text/plain", content_base64: Buffer.from("Existing source material").toString("base64") });
    const outlinePath = path.join(workspace_dir, "outline.json");
    const outline = await readFile(outlinePath, "utf8");
    const sources = await api.listAppUploadedSources({ workspace_dir });
    const staging = path.join(root, "red.png");
    const bytes = await sharp({ create: { width: 8, height: 4, channels: 3, background: "red" } }).png().toBuffer();
    await writeFile(staging, bytes);
    const commit = { workspace_dir, action: "commit" as const, filename: "red.png", staging_file_path: staging, expected_size_bytes: bytes.length };
    const uploaded = (await api.appPageImageUpload(commit)).images[0]!;
    assert.equal(path.basename(uploaded.file_path), `image-${uploaded.sha256.slice(0, 16)}.png`);
    assert.equal(uploaded.description, "");
    assert.equal((await api.appPageImageUpload({ workspace_dir, action: "list_pending" })).images.length, 1);
    assert.equal(((await api.getAppSharedResearchContext({ workspace_dir })).uploaded_asset_catalog?.assets as unknown[]).length, 1);
    assert.deepEqual(await readFile((await api.resolveAppOutlineImage({ workspace_dir, asset_id: uploaded.asset_id })).file_path), bytes);
    assert.match((await api.getAppOutlineImagePreview({ workspace_dir, asset_id: uploaded.asset_id })).preview_url, /^data:image\/webp;base64,/);
    assert.equal((await api.appPageImageUpload(commit)).images[0]?.asset_id, uploaded.asset_id);
    await assert.rejects(api.appPageImageUpload({ workspace_dir, action: "describe", asset_id: uploaded.asset_id, description: " " }), /DESCRIPTION/);
    assert.deepEqual(await readFile((await api.appPageImageUpload({ workspace_dir, action: "prepare", asset_id: uploaded.asset_id })).images[0]!.file_path), bytes);
    await api.appPageImageUpload({ workspace_dir, action: "describe", asset_id: uploaded.asset_id, description: "红色矩形。" });
    assert.equal((await api.appPageImageUpload({ workspace_dir, action: "list_pending" })).images.length, 0);
    assert.deepEqual(await readFile((await api.resolveAppOutlineImage({ workspace_dir, asset_id: uploaded.asset_id })).file_path), bytes);
    assert.match((await api.getAppOutlineImagePreview({ workspace_dir, asset_id: uploaded.asset_id })).preview_url, /^data:image\/webp;base64,/);
    const duplicate = await api.appPageImageUpload({ ...commit, filename: "同内容.png" });
    assert.equal(duplicate.images[0]?.asset_id, uploaded.asset_id);
    assert.equal(duplicate.images[0]?.description, "红色矩形。");
    await Promise.all(["blue", "green"].map(async (color) => {
      const data = await sharp({ create: { width: 8, height: 4, channels: 3, background: color } }).png().toBuffer();
      const file = path.join(root, `${color}.png`); await writeFile(file, data);
      return api.appPageImageUpload({ ...commit, filename: `${color}.png`, staging_file_path: file, expected_size_bytes: data.length });
    }));
    assert.equal((await api.appPageImageUpload({ workspace_dir, action: "list_pending" })).images.length, 2);
    assert.equal(((await api.getAppSharedResearchContext({ workspace_dir })).uploaded_asset_catalog?.assets as unknown[]).length, 3);
    assert.deepEqual(await api.listAppUploadedSources({ workspace_dir }), sources);
    assert.equal(await readFile(outlinePath, "utf8"), outline);
    const snapshot = await api.publishAppWorkspaceSnapshot({ workspace_dir });
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await readFile(snapshot.snapshot_path!));
    assert.ok(zip.file("uploaded-sources/asset/manual/catalog.json"));
    assert.deepEqual(await zip.file(`uploaded-sources/asset/manual/${path.basename(uploaded.file_path)}`)!.async("nodebuffer"), bytes);
    const restored = path.join(root, "restored");
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const target = path.join(restored, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await entry.async("nodebuffer"));
    }
    assert.equal((await store.readPageUploadedImages(restored)).length, 3);
    assert.ok((await store.resolvePageUploadedImage(restored, uploaded.asset_id)).file_path.startsWith(await realpath(restored)));
    await writeFile(uploaded.file_path, "corrupted");
    await assert.rejects(api.appPageImageUpload({ workspace_dir, action: "prepare", asset_id: uploaded.asset_id }), /CHANGED/);
  } finally {
    if (previous === undefined) delete process.env.ANNA_WORKSPACE_DIR; else process.env.ANNA_WORKSPACE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("历史手动配图继续解析原长文件名，保存描述及重复上传不迁移已有引用", async () => {
  const store = await import("../src/app-workspace/page-image-upload.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-legacy-manual-image-"));
  try {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const staging = path.join(root, "staging.png");
    await writeFile(staging, bytes);
    const input = { workspace_dir: root, filename: "red.png", staging_file_path: staging, expected_size_bytes: bytes.length, existing: [] };
    const image = await store.commitPageUploadedImage(input);
    const legacyPath = path.join(path.dirname(image.file_path), `${image.sha256}.png`);
    await rename(image.file_path, legacyPath);
    const { file_path: _path, file_name: _name, ...legacy } = image;
    const catalog = path.join(path.dirname(legacyPath), "catalog.json");
    await writeFile(catalog, JSON.stringify({ version: 1, images: [legacy] }));
    assert.equal((await store.resolvePageUploadedImage(root, image.asset_id)).file_path, await realpath(legacyPath));
    assert.equal((await store.commitPageUploadedImage(input)).file_path, legacyPath);
    await store.describePageUploadedImage(root, image.asset_id, "红色矩形。");
    assert.equal((await store.readPageUploadedImages(root))[0]!.file_path, legacyPath);
    assert.deepEqual(await readFile(legacyPath), bytes);
    await writeFile(catalog, JSON.stringify({ version: 1, images: [{ ...legacy, file_name: "../staging.png" }] }));
    await assert.rejects(store.readPageUploadedImages(root), /Invalid page image filename/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("拒绝伪装图片、错误大小和路径，重复已有搜索图沿用素材标识", async () => {
  const { commitPageUploadedImage, readPageUploadedImages } = await import("../src/app-workspace/page-image-upload.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-image-validation-"));
  try {
    const file = path.join(root, "image.png");
    await writeFile(file, "not an image");
    const input = { workspace_dir: root, filename: "image.png", staging_file_path: file, expected_size_bytes: 12, existing: [] };
    await assert.rejects(commitPageUploadedImage(input));
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).png().toBuffer();
    await writeFile(file, bytes); input.expected_size_bytes = bytes.length;
    await assert.rejects(commitPageUploadedImage({ ...input, filename: "../image.png" }), /INVALID_FILE/);
    await assert.rejects(commitPageUploadedImage({ ...input, filename: "image.jpg" }), /INVALID_FILE/);
    await assert.rejects(commitPageUploadedImage({ ...input, expected_size_bytes: 26 * 1024 * 1024 }), /TOO_LARGE/);
    const { createHash } = await import("node:crypto");
    const known = { asset_id: "existing-search", sha256: createHash("sha256").update(bytes).digest("hex"), description: "" };
    assert.equal((await commitPageUploadedImage({ ...input, existing: [known] })).asset_id, known.asset_id);
    assert.deepEqual(await readPageUploadedImages(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
