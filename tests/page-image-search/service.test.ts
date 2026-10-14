import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmedRequirements } from "../fixtures/imageRequirements";
import { createPageImageSearchService, pageImageTargetKey, type PageImageSearchInput } from "../../src/features/page-image-search/service";
import type { DeckGenerationRuntime } from "../../src/features/deck-generation/types";
import type { PageImageSearchRequest, PageImageSearchTask } from "../../src/api/pageImageSearchTypes";
import type { SharedResearchImageAsset } from "../../src/api/types";

const context: PageImageSearchInput = {
  title: "Harry Potter",
  global_creation_requirements: "真实截图",
  opinion: "桥上点灯镜头",
  page: { title: "桥上镜头", content: "当前编辑中尚未保存的正文", creation_requirements: "两张截图", selected_image_ids: [] },
};

const hash = (index: number) => index.toString(16).padStart(64, "0");

function createHarness() {
  let saved: PageImageSearchTask | null = null;
  const savedSnapshots: PageImageSearchTask[] = [];
  const assets: SharedResearchImageAsset[] = [];
  const imageSearchInputs: Array<Record<string, unknown>> = [];
  const fetchInputs: Array<Record<string, unknown>> = [];
  const descriptionBatches: number[] = [];
  const attachmentUrls: string[][] = [];
  const logs: Array<Record<string, unknown>> = [];
  const preparedUrls: string[] = [];
  const importedIds: string[] = [];
  let activeFetches = 0;
  let maxFetches = 0;
  let appendCalls = 0;
  let cleanupCalls = 0;
  const runtime = {
    workspace: {
      workspace_dir: `/tmp/page-search-${crypto.randomUUID()}`,
      workspace_id: "test",
      requirements: confirmedRequirements(),
      setting: { research_image_max_searches: 1 },
    },
    confirmedOutline: { title: "Saved deck", items: [] },
    locale: "zh",
    activeStreams: new Map(),
    getProgress: () => null,
    setProgress() {},
    onProgress() {},
    isCancelled: () => false,
    backend: {
      appendWorkspaceLog: async ({ entry }: { entry: Record<string, unknown> }) => { logs.push(entry); },
      pageImageSearch: async (request: PageImageSearchRequest) => {
        if (request.action === "get") return structuredClone(saved);
        if (request.task) {
          saved = structuredClone(request.task);
          savedSnapshots.push(structuredClone(request.task));
        }
        return null;
      },
      getSharedResearchContext: async () => ({
        image_catalog: { schema_version: 2, assets },
        uploaded_asset_catalog: { assets: [] },
      }),
      prepareSharedResearchImageCandidate: async ({ candidate_id, expected_sha256, source_url }: { candidate_id: string; expected_sha256?: string; source_url: string }) => {
        preparedUrls.push(source_url);
        return {
          local_file_path: `/tmp/${candidate_id}.jpg`,
          sha256: expected_sha256 ?? candidate_id,
          mime_type: "image/jpeg",
          bytes_size: 10,
          width: 800,
          height: 600,
        };
      },
      importSharedResearchImageLocal: async ({ candidate_id, sha256 }: { candidate_id: string; sha256: string }) => {
        importedIds.push(candidate_id);
        return { file_path: `/tmp/${candidate_id}.jpg`, sha256, mime_type: "image/jpeg", bytes_size: 10, width: 800, height: 600 };
      },
      appendSharedImageResearchBatch: async ({ batch }: { batch: { candidates: Array<{ candidate_id: string; sha256?: string; description?: string }> } }) => {
        appendCalls += 1;
        for (const candidate of batch.candidates) {
          if (!assets.some((asset) => asset.sha256 === candidate.sha256)) {
            assets.push({
              asset_id: candidate.candidate_id,
              file_path: `/tmp/${candidate.candidate_id}.jpg`,
              sha256: candidate.sha256 ?? candidate.candidate_id,
              mime_type: "image/jpeg",
              bytes_size: 10,
              aspect_ratio: 4 / 3,
              description: candidate.description ?? "",
              reason: "用户选择",
              matched_queries: [context.opinion],
              source_url: "https://source.test",
            });
          }
        }
        return { workspace_dir: runtime.workspace.workspace_dir, image_catalog_path: "/tmp/catalog.json", appended: true };
      },
      cleanupSharedResearchImageStaging: async () => { cleanupCalls += 1; return { cleaned: true }; },
    },
    researchWebClient: {
      imageSearch: async (input: Record<string, unknown>) => {
        imageSearchInputs.push(input);
        return {
          results: Array.from({ length: 20 }, (_, index) => ({
            image_url: `https://image.test/${index}.jpg`,
            source_url: `https://source.test/${index}`,
            title: `结果 ${index}`,
          })),
        };
      },
      imageFetch: async (input: Record<string, unknown>) => {
        fetchInputs.push(input);
        activeFetches += 1;
        maxFetches = Math.max(maxFetches, activeFetches);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeFetches -= 1;
        const url = String(input.url);
        const index = Number(url.match(/(\d+)\.jpg$/)?.[1] ?? -1);
        if (index === 0 || index === 1 || index === 2) throw new Error("image fetch failed");
        if (index === 3) return { path: "aps/3", get_url: "https://aps.test/3.jpg", mime_type: "image/svg+xml", bytes_size: 10, sha256: hash(3), source_url: url, final_url: url };
        return {
          path: `aps/${index}`,
          get_url: `https://aps.test/${index}.jpg`,
          mime_type: "image/jpeg",
          bytes_size: 10,
          sha256: hash(index === 5 ? 4 : index),
          source_url: url,
          final_url: url,
        };
      },
      getImageDownloadUrl: async (path: string) => `https://aps.test/refreshed-${path.split("/").at(-1)}.jpg`,
    },
    agentClient: {
      runStructuredPrompt: async (_prompt: string, validate: (value: unknown) => unknown, options?: { attachments?: Array<{ url: string }> }) => {
        descriptionBatches.push(options?.attachments?.length ?? 0);
        attachmentUrls.push((options?.attachments ?? []).map((attachment) => attachment.url));
        return validate({ descriptions: (options?.attachments ?? []).map((_, index) => ({ attachment_index: index + 1, description: `图片 ${index + 1} 的一句话描述` })) });
      },
    },
    aiLogger: null,
  } as unknown as DeckGenerationRuntime;
  return {
    runtime,
    assets,
    savedSnapshots,
    imageSearchInputs,
    fetchInputs,
    descriptionBatches,
    attachmentUrls,
    logs,
    preparedUrls,
    importedIds,
    get maxFetches() { return maxFetches; },
    get appendCalls() { return appendCalls; },
    get cleanupCalls() { return cleanupCalls; },
  };
}

test("关键词搜索最多请求 20 条，并以 10 并发抓取，只保留可导入图片并按 SHA-256 去重", async () => {
  const h = createHarness();
  const service = createPageImageSearchService(h.runtime);
  const task = await service.run(context, null, () => undefined);

  assert.equal(task.status, "completed");
  assert.equal(h.imageSearchInputs[0]?.max_results, 20);
  assert.equal(h.imageSearchInputs[0]?.query, context.opinion);
  assert.equal(h.fetchInputs.length, 20);
  assert.equal(h.maxFetches, 10);
  assert.equal(task.results.length, 15);
  assert.equal(task.result_ids.length, 15);
  assert.ok(task.results.every((result) => result.mime_type === "image/jpeg"));
  assert.equal(new Set(task.results.map((result) => result.sha256)).size, task.results.length);
  assert.equal(h.savedSnapshots.at(-1)?.results.every((result) => result.get_url === ""), true);
});

test("搜索和预览不导入；添加只下载原图，空描述立即可用且不调用模型", async () => {
  const h = createHarness();
  const service = createPageImageSearchService(h.runtime);
  const task = await service.run(context, null, () => undefined);
  const selected = task.result_ids.slice(0, 7);

  assert.deepEqual(h.descriptionBatches, []);
  assert.deepEqual(h.importedIds, []);
  const ids = await service.add(task, selected);

  assert.deepEqual(h.descriptionBatches, []);
  assert.ok(h.assets.every((image) => image.description === ""));
  assert.equal(h.importedIds.length, 7);
  assert.equal(h.appendCalls, 7);
  assert.deepEqual(ids, selected);
  assert.equal(h.assets.length, 7);
  assert.equal(h.cleanupCalls, 7);
});

test("加载已保存任务时重新获取短时 APS 地址", async () => {
  const h = createHarness();
  const service = createPageImageSearchService(h.runtime);
  const task = await service.run(context, null, () => undefined);
  const loaded = await service.load(context);

  assert.ok(loaded);
  assert.equal(loaded?.results.length, task.results.length);
  assert.ok(loaded?.results.every((result) => result.get_url.startsWith("https://aps.test/refreshed-")));
});

test("空关键词在搜索前直接拒绝", async () => {
  const h = createHarness();
  const service = createPageImageSearchService(h.runtime);
  await assert.rejects(service.run({ ...context, opinion: "   " }, null, () => undefined), /PAGE_IMAGE_SEARCH_QUERY_REQUIRED/);
  assert.equal(h.imageSearchInputs.length, 0);
});

test("草稿目标标识不依赖页序，页面内容变化会生成新的标识", async () => {
  assert.equal(await pageImageTargetKey(context), await pageImageTargetKey(structuredClone(context)));
  assert.notEqual(await pageImageTargetKey(context), await pageImageTargetKey({ ...context, page: { ...context.page, title: "另一页" } }));
  assert.equal(await pageImageTargetKey({ ...context, page: { ...context.page, page_id: "page-stable" } }), "page-stable");
});


for (const fetchedUrl of ["data:image/jpeg;base64,AAAA", "", "https://stale.test/a.jpg"]) {
  test(`首次搜索忽略 image_fetch URL 并重新解析 APS path: ${fetchedUrl}`, async () => {
    const h = createHarness();
    const fetchImage = h.runtime.researchWebClient.imageFetch;
    h.runtime.researchWebClient.imageFetch = async (...args) => ({ ...await fetchImage(...args), get_url: fetchedUrl });
    const task = await createPageImageSearchService(h.runtime).run(context, null, () => undefined);
    assert.equal(task.results!.length, 15);
    assert.ok(task.results!.every((result) => result.get_url.startsWith("https://aps.test/refreshed-")));
    assert.ok(h.savedSnapshots.at(-1)!.results!.every((result) => result.get_url === ""));
  });
}

for (const badUrl of ["data:image/jpeg;base64,AAAA", "", "ftp://aps.test/a.jpg", "https://", "//aps.test/a.jpg", "throw"]) {
  test(`添加时隔离无效 URL，保留其余图片及附件映射: ${badUrl}`, async () => {
    const h = createHarness();
    const service = createPageImageSearchService(h.runtime);
    const task = await service.run(context, null, () => undefined);
    const selected = task.results!.slice(1, 4);
    const getUrl = h.runtime.researchWebClient.getImageDownloadUrl;
    h.runtime.researchWebClient.getImageDownloadUrl = async (path) => {
      if (path === selected[0]!.aps_path) {
        if (badUrl === "throw") throw new Error("files.download_url HTTP 503");
        return badUrl;
      }
      return getUrl(path);
    };
    // An old valid URL must not be used after a refresh failure either.
    const ids = await service.add(task, selected.map((item) => item.result_id));
    assert.deepEqual(ids, selected.slice(1).map((item) => item.result_id));
    assert.deepEqual(h.attachmentUrls, []);
    assert.deepEqual(h.preparedUrls, selected.slice(1).map((item) => item.get_url));
    assert.deepEqual(h.assets.map((item) => item.description), ["", ""]);
    const log = h.logs.find((entry) => entry.operation === "image-candidate-adoption");
    assert.equal(log?.aps_path, selected[0]!.aps_path);
    assert.equal(log?.sha256, selected[0]!.sha256);
    assert.ok(!JSON.stringify(h.logs).includes("data:image"));
  });
}

test("刷新失败仍保留成功抓取候选和多个 APS 引用，历史加载可恢复预览", async () => {
  const h = createHarness();
  const getUrl = h.runtime.researchWebClient.getImageDownloadUrl;
  h.runtime.researchWebClient.getImageDownloadUrl = async (path) => ["aps/4", "aps/5"].includes(path) ? "" : getUrl(path);
  const service = createPageImageSearchService(h.runtime);
  const task = await service.run(context, null, () => undefined);
  const candidate = task.results!.find((result) => result.sha256 === hash(4))!;
  assert.equal(candidate.aps_path, "aps/4");
  assert.deepEqual(candidate.aps_paths, ["aps/4", "aps/5"]);
  assert.equal(candidate.get_url, "");
  assert.equal(task.results!.length, 15);
  const loaded = await service.load(context);
  assert.equal(loaded!.results!.length, 15);
  assert.deepEqual(loaded!.result_ids, loaded!.results!.map((result) => result.result_id));
  h.runtime.researchWebClient.getImageDownloadUrl = async (path) => path === "aps/4" ? "" : getUrl(path);
  assert.match(await service.preview(candidate), /refreshed-5/);
  assert.match((await service.load(context))!.results!.find((result) => result.sha256 === hash(4))!.get_url, /refreshed-5/);
});

test("全部 URL 失败时不调用 Agent、不导入、不回退旧 URL，并可重试", async () => {
  const h = createHarness();
  const service = createPageImageSearchService(h.runtime);
  const task = await service.run(context, null, () => undefined);
  const getUrl = h.runtime.researchWebClient.getImageDownloadUrl;
  h.runtime.researchWebClient.getImageDownloadUrl = async () => { throw new Error("files.download_url unavailable"); };
  assert.deepEqual(await service.add(task, task.result_ids), []);
  assert.deepEqual(h.descriptionBatches, []);
  assert.deepEqual(h.importedIds, []);
  assert.equal(h.appendCalls, 0);
  assert.equal(h.cleanupCalls, task.result_ids.length);
  const loaded = await service.load(context);
  assert.equal(loaded!.results!.length, task.results!.length);
  assert.deepEqual(loaded!.result_ids, task.result_ids);
  assert.ok(loaded!.results!.every((result) => result.get_url === ""));
  const failedSearch = await service.run(context, null, () => undefined);
  assert.equal(failedSearch.results!.length, 15);
  assert.ok(failedSearch.results!.every((result) => result.get_url === ""));
  h.runtime.researchWebClient.getImageDownloadUrl = getUrl;
  assert.deepEqual(await service.add(task, task.result_ids), task.result_ids);
});

test("描述模型不可用也不影响搜索添加，所有保存成功图片立即可用", async () => {
  const h = createHarness();
  const service = createPageImageSearchService(h.runtime);
  const task = await service.run(context, null, () => undefined);
  h.runtime.agentClient.runStructuredPrompt = async (_prompt, validate) => validate({ descriptions: [
    { attachment_index: 1, error: "IMAGE_NOT_AVAILABLE" },
    { attachment_index: 2, description: "第二张图片" },
  ] });
  const selected = task.result_ids.slice(0, 2);
  assert.deepEqual(await service.add(task, selected), selected);
  assert.ok(h.assets.every((image) => image.description === ""));
  assert.deepEqual(h.descriptionBatches, []);
});

test("单张导入失败不阻止其余图片发布", async () => {
  const h = createHarness();
  const service = createPageImageSearchService(h.runtime);
  const task = await service.run(context, null, () => undefined);
  const selected = task.result_ids.slice(0, 2);
  const importImage = h.runtime.backend.importSharedResearchImageLocal;
  h.runtime.backend.importSharedResearchImageLocal = async (input) => {
    if (input.candidate_id === selected[0]) throw new Error("import failed");
    return importImage(input);
  };
  assert.deepEqual(await service.add(task, selected), selected.slice(1));
  assert.equal(h.assets.length, 1);
  assert.equal(h.cleanupCalls, 2);
});


test("添加不触发描述预算，诊断服务不可用不影响文件成功", async () => {
  const h = createHarness();
  const service = createPageImageSearchService(h.runtime);
  const task = await service.run(context, null, () => undefined);
  const describe = h.runtime.agentClient.runStructuredPrompt;
  let calls = 0;
  h.runtime.agentClient.runStructuredPrompt = async (...args) => {
    if (++calls === 1) throw new Error("Agent unavailable");
    return describe(...args);
  };
  h.runtime.backend.appendWorkspaceLog = async () => { throw new Error("log unavailable"); };
  const selected = task.result_ids.slice(0, 7);
  assert.deepEqual(await service.add(task, selected), selected);
  assert.equal(calls, 0);
  assert.equal(h.cleanupCalls, 7);
});


test("重复已有空描述上传图沿用素材 ID，不下载；文件失败重试仅补失败项", async () => {
  const h = createHarness();
  const service = createPageImageSearchService(h.runtime);
  const task = await service.run(context, null, () => undefined);
  const selected = task.results!.slice(0, 2);
  h.assets.push({ asset_id: "existing-upload", sha256: selected[0].sha256, description: "", file_path: "/tmp/existing.jpg",
    mime_type: "image/jpeg", bytes_size: 10, aspect_ratio: 1, reason: "", matched_queries: [], source_url: "manual-upload://existing" });
  const prepare = h.runtime.backend.prepareSharedResearchImageCandidate;
  let fail = true;
  h.runtime.backend.prepareSharedResearchImageCandidate = async (input) => { if (fail) throw new Error("download failed"); return prepare(input); };
  assert.deepEqual(await service.add(task, selected.map((item) => item.result_id)), ["existing-upload"]);
  fail = false;
  assert.deepEqual(await service.add(task, selected.map((item) => item.result_id)), ["existing-upload", selected[1].result_id]);
  assert.equal(h.importedIds.length, 1); assert.equal(h.descriptionBatches.length, 0);
});

test("取消停止后续抓取，已成功获取的候选仍保存，未采用原图不导入", async () => {
  const h = createHarness();
  const service = createPageImageSearchService(h.runtime);
  const fetch = h.runtime.researchWebClient.imageFetch;
  h.runtime.researchWebClient.imageFetch = async (...args) => {
    const result = await fetch(...args);
    if (args[0].url.includes("7.jpg")) service.cancel();
    return result;
  };
  const task = await service.run(context, null, () => undefined);
  assert.equal(task.status, "cancelled"); assert.ok(task.results!.length > 0);
  assert.ok(h.fetchInputs.length < 20);
  assert.equal(h.savedSnapshots.at(-1)!.status, "cancelled");
  assert.deepEqual(h.savedSnapshots.at(-1)!.result_ids, task.result_ids);
  assert.deepEqual(h.importedIds, []); assert.deepEqual(h.descriptionBatches, []);
});
