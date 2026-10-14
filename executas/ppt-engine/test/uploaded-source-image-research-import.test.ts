import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("an uploaded image is promoted through Engine-owned research staging", async () => {
  const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ppt-engine-uploaded-image-"));
  process.env.SLIDEFORGE_WORKSPACE_DIR = workspaceRoot;
  try {
    const {
      createAppWorkspace,
      uploadAppUploadedSource,
      importAppUploadedSourceImageToResearch,
    } = await import("../src/app-workspace/index.js");
    const workspace = await createAppWorkspace({ title: "Uploaded image" });
    const uploaded = await uploadAppUploadedSource({
      workspace_dir: workspace.workspace_dir,
      filename: "team.png",
      mime_type: "image/png",
      content_base64: PNG.toString("base64"),
    });

    const imported = await importAppUploadedSourceImageToResearch({
      workspace_dir: workspace.workspace_dir,
      uploaded_source_id: uploaded.material.uploaded_source_id,
      candidate_id: "uploaded-team",
    });

    assert.equal(imported.file_path, path.join(workspace.workspace_dir, "research/evidence/images", `image-${imported.sha256.slice(0, 16)}.png`));
    assert.deepEqual(await readFile(imported.file_path), PNG);
    assert.equal(imported.sha256, uploaded.material.sha256);
  } finally {
    if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
    else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("a classified uploaded image is copied into the persistent uploaded asset catalog", async () => {
  const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ppt-engine-uploaded-asset-"));
  process.env.SLIDEFORGE_WORKSPACE_DIR = workspaceRoot;
  try {
    const {
      createAppWorkspace,
      uploadAppUploadedSource,
      copyAppUploadedSourceImageToAsset,
      getAppSharedResearchContext,
    } = await import("../src/app-workspace/index.js");
    const workspace = await createAppWorkspace({ title: "Uploaded image asset" });
    const uploaded = await uploadAppUploadedSource({
      workspace_dir: workspace.workspace_dir,
      filename: "avatar.png",
      mime_type: "image/png",
      content_base64: PNG.toString("base64"),
    });

    const copied = await copyAppUploadedSourceImageToAsset({
      workspace_dir: workspace.workspace_dir,
      uploaded_source_id: uploaded.material.uploaded_source_id,
      candidate_id: "uploaded-avatar",
      description: "Professional avatar",
      reason: "The user asked to place this avatar in the presentation.",
    });

    assert.equal(copied.file_path, path.join(workspace.workspace_dir, "uploaded-sources/asset", `image-${copied.sha256.slice(0, 16)}.png`));
    assert.deepEqual(await readFile(copied.file_path), PNG);
    const catalog = JSON.parse(await readFile(path.join(workspace.workspace_dir, "uploaded-sources", "asset", "catalog.json"), "utf8"));
    assert.equal(catalog.assets[0]?.file_path, copied.file_path);
    assert.equal(catalog.assets[0]?.reason, "The user asked to place this avatar in the presentation.");
    assert.equal(catalog.assets[0]?.source_filename, "avatar.png");

    const context = await getAppSharedResearchContext({ workspace_dir: workspace.workspace_dir });
    assert.equal(context.uploaded_asset_catalog_path, path.join(workspace.workspace_dir, "uploaded-sources", "asset", "catalog.json"));
    assert.equal((context.uploaded_asset_catalog as { assets?: Array<{ file_path?: string }> }).assets?.[0]?.file_path, copied.file_path);
  } finally {
    if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
    else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function withImageWorkspace(run: (api: typeof import("../src/app-workspace/index.js"), workspaceDir: string) => Promise<void>) {
  const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ppt-image-lifecycle-"));
  process.env.SLIDEFORGE_WORKSPACE_DIR = workspaceRoot;
  try {
    const api = await import("../src/app-workspace/index.js");
    const workspace = await api.createAppWorkspace({ title: "图片生命周期" });
    await run(api, workspace.workspace_dir);
  } finally {
    if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
    else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

test("移除、忽略或改判为不用的图片不再提供给生成，但保留已生成页面引用的文件", async () => {
  await withImageWorkspace(async (api, workspaceDir) => {
    for (const action of ["remove", "ignore", "reclassify"] as const) {
      const uploaded = await api.uploadAppUploadedSource({ workspace_dir: workspaceDir, filename: `${action}.png`, mime_type: "image/png", content_base64: PNG.toString("base64") });
      const sourceId = uploaded.material.uploaded_source_id;
      const copied = await api.copyAppUploadedSourceImageToAsset({ workspace_dir: workspaceDir, uploaded_source_id: sourceId, candidate_id: action, description: "头像", reason: "作为素材" });
      const input = { workspace_dir: workspaceDir, uploaded_source_id: sourceId };
      if (action === "remove") await api.removeAppUploadedSource(input);
      else if (action === "ignore") await api.ignoreAppUploadedSource({ ...input, reason: "跳过" });
      else await api.recordAppAttachmentBrief({ ...input, brief: {
        content_strategy: "full_context", original_reading_method: "image_multimodal_read", content: "", use_in_ppt: false,
        key_facts: [], must_include: [], must_avoid: [], recommended_storyline: [], gaps: [], unread_content: [],
      } });
      const context = await api.getAppSharedResearchContext({ workspace_dir: workspaceDir });
      assert.deepEqual(context.uploaded_asset_catalog?.assets, []);
      assert.deepEqual(await readFile(copied.file_path), PNG);
    }
  });
});

test("并发导入不同图片不会丢失素材目录条目", async () => {
  await withImageWorkspace(async (api, workspaceDir) => {
    const sharp = (await import("sharp")).default;
    const sources = [];
    for (const color of ["red", "blue"]) {
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: color } }).png().toBuffer();
      const uploaded = await api.uploadAppUploadedSource({ workspace_dir: workspaceDir, filename: `${color}.png`, mime_type: "image/png", content_base64: bytes.toString("base64") });
      sources.push(uploaded.material);
    }
    await Promise.all(sources.map((source, index) => api.copyAppUploadedSourceImageToAsset({ workspace_dir: workspaceDir, uploaded_source_id: source.uploaded_source_id, candidate_id: `image-${index}`, description: "图片", reason: "素材" })));
    const context = await api.getAppSharedResearchContext({ workspace_dir: workspaceDir });
    assert.equal((context.uploaded_asset_catalog?.assets as unknown[]).length, 2);
  });
});

test("作品快照包含上传图片素材及目录，不重复打包原始附件", async () => {
  await withImageWorkspace(async (api, workspaceDir) => {
    const uploaded = await api.uploadAppUploadedSource({ workspace_dir: workspaceDir, filename: "avatar.png", mime_type: "image/png", content_base64: PNG.toString("base64") });
    const copied = await api.copyAppUploadedSourceImageToAsset({ workspace_dir: workspaceDir, uploaded_source_id: uploaded.material.uploaded_source_id, candidate_id: "avatar", description: "头像", reason: "素材" });
    const snapshot = await api.publishAppWorkspaceSnapshot({ workspace_dir: workspaceDir });
    assert.equal(snapshot.status, "generated");
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await readFile(snapshot.snapshot_path!));
    assert.ok(zip.file("uploaded-sources/asset/catalog.json"));
    assert.deepEqual(await zip.file(`uploaded-sources/asset/${path.basename(copied.file_path)}`)!.async("nodebuffer"), PNG);
    assert.equal(Object.keys(zip.files).some((name) => name.startsWith("uploaded-sources/files/")), false);
  });
});
