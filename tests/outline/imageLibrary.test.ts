import assert from "node:assert/strict";
import test from "node:test";
import type { PptBackend } from "../../src/api/pptBackend";
import type { ResearchWebClient } from "../../src/api/researchWebClient";
import type { ImageCandidateReference, SharedResearchContextResult, SharedResearchImageAsset } from "../../src/api/types";
import { createOutlineImageLibraryService } from "../../src/features/outline/imageLibrary";
import { availableOutlineImages, mergeOutlineImageAssets, matchesOutlineImage, type OutlineImageAsset } from "../../src/features/outline/images";
import { preparePageImageAttachments } from "../../src/features/deck-generation/pageImageAttachments";

const candidate = (id: string): ImageCandidateReference => ({
  candidate_id: id, sha256: id.charCodeAt(0).toString(16).padStart(64, "0"), aps_path: `aps/${id}`,
  image_url: `https://image.test/${id}.png`, source_url: `https://source.test/${id}`, source_urls: [`https://source.test/${id}`],
  mime_type: "image/png", bytes_size: 100, description: "", matched_queries: ["图片"], use_in_ppt: false, recommendation: "not_recommended",
});
function harness(candidates: ImageCandidateReference[]) {
  const assets: SharedResearchImageAsset[] = [];
  const downloads: string[] = [];
  const imports: string[] = [];
  const batches: any[] = [];
  const cleanup: string[] = [];
  const urls: string[] = [];
  const research = { image_catalog: { schema_version: 2, assets }, uploaded_asset_catalog: { schema_version: 2, assets: [] }, image_candidates: candidates } as SharedResearchContextResult;
  const backend = {
    getSharedResearchContext: async () => research,
    getOutlineImagePreview: async () => ({ preview_url: "data:image/webp;base64,LOCAL" }),
    prepareSharedResearchImageCandidate: async (input: { candidate_id: string; expected_sha256: string }) => {
      downloads.push(input.candidate_id);
      return { sha256: input.expected_sha256, local_file_path: `/staging/${input.candidate_id}.png`, mime_type: "image/png", bytes_size: 100 };
    },
    importSharedResearchImageLocal: async (input: { candidate_id: string }) => { imports.push(input.candidate_id); return { file_path: `/workspace/${input.candidate_id}.png`, width: 100, height: 100 }; },
    appendSharedImageResearchBatch: async ({ batch }: { batch: { candidates: any[] } }) => {
      batches.push(batch);
      for (const image of batch.candidates) assets.push({ ...image, asset_id: image.candidate_id, aspect_ratio: 1 });
    },
    cleanupSharedResearchImageStaging: async ({ operation_id }: { operation_id: string }) => { cleanup.push(operation_id); },
    appendWorkspaceLog: async () => {},
  } as unknown as PptBackend;
  const web = { getImageDownloadUrl: async (path: string) => { urls.push(path); return `https://fresh.test/${path}`; } } as ResearchWebClient;
  const library = createOutlineImageLibraryService({ backend, web, workspaceDir: "/workspace", locale: "zh" });
  return { backend, web, library, assets, batches, downloads, imports, cleanup, urls, research };
}

test("打开完整列表和预览仅刷新 APS 引用，采用才下载，AI 未推荐标记和空描述不被改写", async () => {
  const h = harness([candidate("a")]);
  const list = await h.library.load();
  assert.equal(list.length, 1); assert.equal(list[0].file_path, "");
  assert.match(await h.library.preview("a"), /^https:\/\/fresh.test/);
  assert.deepEqual(h.downloads, []); assert.deepEqual(h.imports, []);
  const adopted = await h.library.adopt(list[0]);
  assert.equal(adopted.description, ""); assert.ok(adopted.file_path);
  assert.deepEqual(h.downloads, ["a"]); assert.deepEqual(h.imports, ["a"]); assert.equal(h.cleanup.length, 1);
  assert.equal(h.batches[0].candidates[0].use_in_ppt, false);
  assert.equal(h.batches[0].candidates[0].selected_by_user, true);
});

test("同内容候选并发采用只下载一次，已有空描述素材跨来源复用不再下载", async () => {
  const first = candidate("a"); const alias = { ...candidate("b"), sha256: first.sha256 };
  const h = harness([first, alias]);
  const result = await h.library.adoptMany([first, alias]);
  assert.deepEqual(result.map((image) => image.asset_id), ["a", "a"]);
  assert.deepEqual(h.downloads, ["a"]);
  h.research.uploaded_asset_catalog!.assets.push({ ...h.assets[0], asset_id: "upload", source_url: "manual-upload://same" });
  assert.deepEqual((await h.library.adoptMany([alias])).map((image) => image.asset_id), ["upload"]);
  assert.equal(h.downloads.length, 1);
});

test("APS 刷新失败可用备用引用，文件内容变化隔离且可重试，其余文件成功保留", async () => {
  const a = { ...candidate("a"), aps_paths: ["aps/alternate"] }; const b = candidate("b");
  const h = harness([a, b]);
  h.web.getImageDownloadUrl = async (path) => { if (path === "aps/a") throw new Error("expired"); return `https://fresh.test/${path}`; };
  const prepare = h.backend.prepareSharedResearchImageCandidate;
  let fail = true;
  h.backend.prepareSharedResearchImageCandidate = async (input) => {
    const saved = await prepare(input);
    return fail && input.candidate_id === "b" ? { ...saved, sha256: "f".repeat(64) } : saved;
  };
  assert.match(await h.library.preview("a"), /alternate/);
  assert.deepEqual((await h.library.adoptMany([a, b])).map((image) => image.asset_id), ["a"]);
  assert.deepEqual(h.imports, ["a"]); assert.equal(h.cleanup.length, 2);
  fail = false;
  assert.deepEqual((await h.library.adoptMany([a, b])).map((image) => image.asset_id), ["a", "b"]);
  assert.deepEqual([...h.downloads].sort(), ["a", "b", "b"]);
});

test("跨来源重复图片保留历史素材引用，空描述仍能准备原图附件", async () => {
  const h = harness([]);
  h.assets.push({ ...candidate("a"), asset_id: "old-search", file_path: "/workspace/a.png", aspect_ratio: 1, reason: "" });
  h.research.uploaded_asset_catalog!.assets.push({ ...h.assets[0], asset_id: "upload", source_url: "manual-upload://same" });
  const images = availableOutlineImages(h.research);
  assert.equal(images.length, 1); assert.equal(images[0].asset_id, "upload");
  h.backend.uploadOutlineImageForAgent = async (input) => {
    assert.equal(input.asset_id, "old-search");
    return { host_upload: { url: "https://upload.test/original.png", mime_type: "image/png" } } as any;
  };
  const prepared = await preparePageImageAttachments({ backend: h.backend, workspaceDir: "/workspace", availableImages: images, selectedImageIds: ["old-search"] });
  assert.equal(prepared.images[0].asset_id, "old-search"); assert.equal(prepared.images[0].description, "");
  assert.equal(prepared.attachments.length, 1);
});

test("新搜索命中已有正式素材时保留原图及历史 ID，不退回远程候选", () => {
  const data = candidate("a");
  const saved: OutlineImageAsset = { ...data, asset_id: "uploaded", file_path: "/workspace/a.png", aspect_ratio: 1,
    reason: "", source: "uploaded", asset_aliases: ["legacy"], description: "原有描述" };
  const remote: OutlineImageAsset = { ...saved, asset_id: "new-search", file_path: "", source: "search", description: "",
    asset_aliases: [], matched_queries: ["新搜索词"], remote_candidate: { ...data, candidate_id: "new-search" } };
  const images = mergeOutlineImageAssets([saved], [remote]);
  assert.equal(images.length, 1);
  assert.equal(images[0].asset_id, "uploaded");
  assert.equal(images[0].file_path, "/workspace/a.png");
  assert.equal(images[0].remote_candidate, undefined);
  assert.equal(images[0].description, "原有描述");
  assert.ok(matchesOutlineImage(images[0], "legacy"));
  assert.ok(matchesOutlineImage(images[0], "new-search"));
  assert.deepEqual(images[0].matched_queries, ["图片", "新搜索词"]);
});
