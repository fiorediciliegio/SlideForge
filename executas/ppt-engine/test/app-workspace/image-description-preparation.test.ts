import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

test("空描述素材可保存选图和快照；描述按来源保存，运行恢复复用，放弃后的写入隔离", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-description-preparation-"));
  const previous = process.env.SLIDEFORGE_WORKSPACE_DIR;
  process.env.SLIDEFORGE_WORKSPACE_DIR = root;
  try {
    const api = await import("../../src/app-workspace/index");
    const workspace = await api.createAppWorkspace({ title: "图片准备" });
    const workspace_dir = workspace.workspace_dir;
    await api.updateAppWorkspaceRequirements({ workspace_dir, requirements: {
      version: 1, status: "confirmed", source: { brief: "图片演示" }, candidates: { slide_count: [1], output_language: ["中文"] },
      selections: { slide_count: 1, output_language: "中文" },
      research: { web: { recommended: false, reason: "", enabled: false }, images: { recommended: false, reason: "", enabled: false } },
      updated_at: null, confirmed_at: null,
    } });
    const bytes = await sharp({ create: { width: 8, height: 4, channels: 3, background: "red" } }).png().toBuffer();
    const staging = path.join(root, "red.png"); await writeFile(staging, bytes);
    const manual = (await api.appPageImageUpload({ workspace_dir, action: "commit", filename: "red.png", staging_file_path: staging, expected_size_bytes: bytes.length })).images[0]!;
    const context = await api.getAppSharedResearchContext({ workspace_dir });
    const blueBytes = await sharp({ create: { width: 4, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
    const blueHash = createHash("sha256").update(blueBytes).digest("hex");
    const blueFile = path.join(context.images_dir, `image-${blueHash.slice(0, 16)}.png`); await writeFile(blueFile, blueBytes);
    await api.appendAppImageResearchBatch({ workspace_dir, batch: { title: "人工采用", candidates: [{
      candidate_id: "blue", sha256: blueHash, mime_type: "image/png", bytes_size: blueBytes.length, file_path: blueFile,
      aps_path: "aps/blue", aps_fetch_status: "completed", use_in_ppt: false, selected_by_user: true, recommendation: "not_recommended",
      import_status: "imported", description: "AI 未推荐：诊断字符串", width: 4, height: 8, source_url: "https://source.test/blue", matched_queries: ["蓝色"],
    }] } });
    const outline = { title: "图片演示", items: [{ page_type: "standard" as const, title: "图片", content: "两张原图", selected_image_ids: [manual.asset_id, "blue"] }] };
    await api.saveAppWorkspaceOutlineDraft({ workspace_dir, outline });
    await api.confirmAppWorkspaceOutline({ workspace_dir, outline });
    assert.deepEqual((await api.getAppWorkspaceOutline({ workspace_dir })).items[0].selected_image_ids, [manual.asset_id, "blue"]);
    const catalog = (await api.getAppSharedResearchContext({ workspace_dir })).image_catalog.assets as Record<string, unknown>[];
    assert.equal(catalog[0].description, ""); assert.equal(catalog[0].recommended, false); assert.equal(catalog[0].recommendation, "not_recommended");
    const before = (await api.getAppWorkspaceSnapshotSyncState({ workspace_dir }))!.change_seq;
    await api.patchAppSharedResearchProgress({ workspace_dir, operations: [{ op: "upsert_image_candidate", candidate_id: "remote", candidate: {
      candidate_id: "remote", aps_fetch_status: "completed", aps_path: "aps/remote", sha256: "e".repeat(64), mime_type: "image/png", bytes_size: 50,
      use_in_ppt: false, analysis_status: "skipped", description: "预算超限",
    } }] });
    assert.ok((await api.getAppWorkspaceSnapshotSyncState({ workspace_dir }))!.change_seq > before);
    assert.equal((await api.getAppSharedResearchContext({ workspace_dir })).image_candidates?.length, 1);
    const transaction = await api.beginAppGenerationRun({ workspace_dir, run_kind: "deck-generation" });
    await api.prepareAppGenerationRun({ run_id: transaction.run_id });
    const shadow = transaction.shadow_workspace_dir;
    const shadowBefore = (await api.getAppWorkspaceSnapshotSyncState({ workspace_dir }))!.change_seq;
    await api.appOutlineImageDescriptions({ workspace_dir: shadow, action: "describe", asset_id: manual.asset_id, description: "红色矩形" });
    await api.appOutlineImageDescriptions({ workspace_dir: shadow, action: "describe", asset_id: "blue", description: "蓝色矩形" });
    await api.appOutlineImageDescriptions({ workspace_dir: shadow, action: "mark_attempted", run_key: transaction.run_id, sha256s: [manual.sha256, blueHash] });
    assert.deepEqual((await api.appOutlineImageDescriptions({ workspace_dir: shadow, action: "get_run", run_key: transaction.run_id })).attempted_sha256, [manual.sha256, blueHash]);
    assert.equal((await api.getAppWorkspaceSnapshotSyncState({ workspace_dir }))!.change_seq, shadowBefore);
    assert.equal(((await api.getAppSharedResearchContext({ workspace_dir })).image_catalog.assets as Record<string, unknown>[])[0].description, "");
    await api.commitAppGenerationRun({ run_id: transaction.run_id });
    assert.equal(((await api.getAppSharedResearchContext({ workspace_dir })).image_catalog.assets as Record<string, unknown>[])[0].description, "蓝色矩形");
    const next = await api.beginAppGenerationRun({ workspace_dir, run_kind: "deck-generation" });
    await api.prepareAppGenerationRun({ run_id: next.run_id });
    assert.deepEqual((await api.appOutlineImageDescriptions({ workspace_dir: next.shadow_workspace_dir, action: "get_run", run_key: next.run_id })).attempted_sha256, []);
    await assert.rejects(api.appOutlineImageDescriptions({ workspace_dir: next.shadow_workspace_dir, action: "get_run", run_key: transaction.run_id }), /identity mismatch/);
    await api.abandonAppGenerationRun({ run_id: next.run_id });
    const official = await readFile(path.join(workspace_dir, "research", "evidence", "image-catalog.json"));
    await assert.rejects(api.appOutlineImageDescriptions({ workspace_dir: next.shadow_workspace_dir, action: "describe", asset_id: "blue", description: "迟到描述" }), /no longer active/);
    assert.deepEqual(await readFile(path.join(workspace_dir, "research", "evidence", "image-catalog.json")), official);
    const snapshot = await api.publishAppWorkspaceSnapshot({ workspace_dir });
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await readFile(snapshot.snapshot_path!));
    assert.ok(zip.file("research/web-image-search-progress.json"));
    assert.ok(zip.file("research/image-description-preparation.json"));
    assert.ok(zip.file(`uploaded-sources/asset/manual/${path.basename(manual.file_path)}`));
  } finally {
    if (previous === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR; else process.env.SLIDEFORGE_WORKSPACE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
