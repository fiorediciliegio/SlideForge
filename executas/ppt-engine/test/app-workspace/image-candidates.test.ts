import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeImageCandidates, readImageCandidateReferences } from "../../src/app-workspace/image-candidates";

const candidate = (id: string, overrides: Record<string, unknown> = {}) => ({
  candidate_id: id, aps_fetch_status: "completed", aps_path: `aps/${id}`,
  sha256: id.charCodeAt(0).toString(16).padStart(64, "0"), mime_type: "image/png", bytes_size: 100,
  image_url: `https://images.test/${id}.png`, source_url: `https://source.test/${id}`,
  query: id, get_url: "https://signed.test/image?signature=secret", description: "附件预算超限；没有分析",
  ...overrides,
});

test("完整候选池保留未推荐、未分析和附件预算跳过图片，诊断及短时地址不成为素材描述", () => {
  const values = normalizeImageCandidates([
    candidate("a", { analysis_status: "completed", use_in_ppt: false, description: "AI 未入选" }),
    candidate("b", { analysis_status: "skipped" }), candidate("c", { analysis_status: "pending" }),
    candidate("d", { analysis_status: "completed", use_in_ppt: true, description: "蓝色山峰" }),
    candidate("e", { aps_fetch_status: "failed" }), candidate("f", { mime_type: "image/svg+xml" }),
    candidate("g", { sha256: "invalid" }), candidate("h", { bytes_size: 0 }),
  ]);
  assert.equal(values.length, 4);
  assert.deepEqual(values.map((image) => image.recommendation), ["not_recommended", "not_analysed", "not_analysed", "recommended"]);
  assert.deepEqual(values.map((image) => image.description), ["", "", "", "蓝色山峰"]);
  assert.doesNotMatch(JSON.stringify(values), /signature=secret|get_url|AI 未入选|没有分析/);
});

test("相同内容合并所有来源、搜索词和 APS 引用，保留 AI 推荐状态与客观描述", () => {
  const hash = "a".repeat(64);
  const values = normalizeImageCandidates([
    candidate("a", { sha256: hash, analysis_status: "completed", use_in_ppt: true, description: "山峰" }),
    candidate("b", { sha256: hash.toUpperCase(), query: "另一个词", aps_paths: ["aps/alternate"], source_urls: ["https://source.test/alternate"] }),
    candidate("c", { sha256: hash, analysis_status: "completed", use_in_ppt: false }),
  ]);
  assert.equal(values.length, 1);
  assert.equal(values[0].candidate_id, "a"); assert.equal(values[0].use_in_ppt, true); assert.equal(values[0].description, "山峰");
  assert.deepEqual(values[0].matched_queries, ["a", "另一个词", "c"]);
  assert.deepEqual(values[0].aps_paths, ["aps/a", "aps/b", "aps/alternate", "aps/c"]);
  assert.equal(values[0].source_urls.length, 4);
});

test("首次研究和历史按页搜索共同读取候选，损坏任务隔离，读取不创建或导入原图", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ppt-candidate-list-"));
  try {
    const directory = path.join(workspace, "research", "page-image-search");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "11111111-1111-1111-1111-111111111111.json"), JSON.stringify({ results: [
      { ...candidate("b"), candidate_id: undefined, result_id: "page-b" },
    ] }));
    await writeFile(path.join(directory, "22222222-2222-2222-2222-222222222222.json"), "invalid JSON");
    await writeFile(path.join(directory, "lease.json"), JSON.stringify({ results: [candidate("z")] }));
    const before = await readdir(workspace, { recursive: true });
    const pool = await readImageCandidateReferences(workspace, { image: { candidates: [candidate("a")] } });
    assert.deepEqual(pool.map((image) => image.candidate_id), ["a", "page-b"]);
    assert.deepEqual(await readdir(workspace, { recursive: true }), before);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
