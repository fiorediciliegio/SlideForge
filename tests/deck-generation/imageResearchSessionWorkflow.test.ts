import { confirmedRequirements } from "../fixtures/imageRequirements";
import assert from "node:assert/strict";
import { it } from "node:test";

import type { SharedResearchImageCandidate, SharedResearchContextResult, SharedResearchProgressOperation } from "../../src/api/types.ts";
import { runLinearSharedResearch } from "../../src/features/deck-generation/linearResearchWorkflow.ts";
import type { DeckGenerationRuntime } from "../../src/features/deck-generation/types.ts";
import {
  applySharedResearchProgressOperations,
  createDefaultSharedResearchProgress,
} from "../../executas/ppt-engine/src/app-workspace/shared-research-progress.ts";

type SessionActionFactory = (input: {
  runCount: number;
  prompt: string;
  candidateIds: string[];
}) => Record<string, unknown>;

function createReadyProgress() {
  return applySharedResearchProgressOperations(createDefaultSharedResearchProgress(), [
    { op: "set_stage", stage: "web_decision", state: "skipped" },
    { op: "set_stage", stage: "web_research", state: "skipped" },
  ]).progress;
}

function createInterruptedSearchProgress() {
  return applySharedResearchProgressOperations(createReadyProgress(), [
    { op: "set_stage", stage: "image_decision", state: "running" },
    {
      op: "set_image_decision",
      decision: {
        needs_search: true,
        queries: ["interrupted query"],
        rationale: "Image research Session selected a query.",
        mode: "agent-session-v2",
        session_attempt: 1,
        rounds: [],
      },
    },
    { op: "set_stage", stage: "image_decision", state: "completed" },
    { op: "set_stage", stage: "image_research", state: "running" },
    { op: "set_image_work_status", field: "search_status", state: "running" },
    {
      op: "upsert_image_search",
      query: "interrupted query",
      search: { query: "interrupted query", status: "running" },
    },
    { op: "set_stage", stage: "image_search", state: "running" },
  ]).progress;
}

function createHarness(options: {
  failDownloadIndexes?: number[];
  initialProgress?: Record<string, unknown>;
  sessionAction?: SessionActionFactory;
  sessionResponses?: string[];
  sessionError?: string;
  imageFetchBytes?: number;
  imageFetchUrl?: string;
  imageFetchHash?: (index: number) => string;
  downloadUrl?: (path: string) => Promise<string>;
} = {}) {
  const context: SharedResearchContextResult = {
    workspace_dir: "/tmp/image-session-workspace",
    web_summary_path: "/tmp/image-session-workspace/web-summary.md",
    image_catalog_path: "/tmp/image-session-workspace/image-catalog.json",
    images_dir: "/tmp/image-session-workspace/images",
    progress_path: "/tmp/image-session-workspace/progress.json",
    web_summary: "",
    image_catalog: { schema_version: 2, assets: [] },
    progress: structuredClone(options.initialProgress ?? createReadyProgress()),
  };
  const failedDownloads = new Set(options.failDownloadIndexes ?? []);
  let runCount = 0;
  let closeCount = 0;
  let fetchedCount = 0;
  let importedCount = 0;
  const attachmentCounts: number[] = [];
  const attachmentUrls: string[][] = [];
  const downloadPaths: string[] = [];
  const searchQueries: string[] = [];
  const defaultSessionAction: SessionActionFactory = ({ runCount: currentRun, candidateIds }) => (
    currentRun === 1
      ? { action: "search", query: "market documentary", decisions: [], summary: "" }
      : {
          action: "finish",
          query: null,
          decisions: candidateIds.slice(0, 1).map((candidate_id) => ({
            candidate_id,
            attachment_index: 1,
            use_in_ppt: true,
            description: "A clear documentary image",
            reason: "Relevant to the market deck",
          })),
          summary: "The selected image is sufficient.",
        }
  );
  const runtime = {
    backend: {
      prepareSharedResearchWorkspace: async () => context,
      getSharedResearchContext: async () => context,
      patchSharedResearchProgress: async ({ operations }: { operations: SharedResearchProgressOperation[] }) => {
        const result = applySharedResearchProgressOperations(
          context.progress as Record<string, unknown>,
          operations as Parameters<typeof applySharedResearchProgressOperations>[1],
        );
        context.progress = result.progress;
        return {
          workspace_dir: context.workspace_dir,
          progress_path: context.progress_path,
          updated: result.updated,
          revision: result.revision,
          updated_at: result.updated_at,
        };
      },
      recordPageProgress: async () => ({}),
      publishPreparedImageResearchBatch: async () => {
        const image = (context.progress as Record<string, unknown>).image as Record<string, unknown> | undefined;
        if (image) image.written = true;
        return {
          workspace_dir: context.workspace_dir,
          artifact_path: context.image_catalog_path,
          published: true,
          already_published: false,
          revision: Number((context.progress as Record<string, unknown>).revision ?? 0),
        };
      },
      prepareSharedResearchImageCandidate: async ({ candidate_id, source_url }: { candidate_id: string; source_url: string }) => {
        const resultIndex = Number(source_url.split("/").at(-1)?.replace(".jpg", ""));
        if (failedDownloads.has(resultIndex)) throw new Error("source returned 403");
        return {
          workspace_dir: context.workspace_dir,
          candidate_id,
          local_file_path: `/tmp/image-session-workspace/${candidate_id}.jpg`,
          final_url: source_url,
          mime_type: "image/jpeg",
          bytes_size: 3,
          sha256: candidate_id.padEnd(64, "0").slice(0, 64),
          width: 1600,
          height: 900,
        };
      },
      importSharedResearchImageLocal: async ({ candidate_id }: { candidate_id: string }) => {
        importedCount += 1;
        return {
          workspace_dir: context.workspace_dir,
          candidate_id,
          file_path: `/tmp/image-session-workspace/imported/${candidate_id}.jpg`,
          sha256: candidate_id.padEnd(64, "0").slice(0, 64),
          mime_type: "image/jpeg",
          bytes_size: 3,
        };
      },
      cleanupSharedResearchImageStaging: async () => ({ workspace_dir: context.workspace_dir, operation_id: "op", cleaned: true }),
      appendWorkspaceLog: async () => ({ appended: true }),
    },
    workspace: {
      workspace_dir: context.workspace_dir,
      setting: { research_image_session_concurrency: 2 },
      requirements: { ...confirmedRequirements(), source: { brief: "Create a market deck." } },
    },
    confirmedOutline: {
      version: 4,
      title: "Market deck",
      status: "confirmed",
      items: [{ page_id: "page-01", title: "Market", content: "Data" }],
    },
    locale: "en",
    activeStreams: new Map(),
    getProgress: () => ({ pages: [] }),
    setProgress: () => undefined,
    onProgress: () => undefined,
    isCancelled: () => false,
    researchWebClient: {
      search: async () => ({ results: [] }),
      fetch: async () => ({ pages: [] }),
      imageSearch: async ({ query }: { query: string }) => {
        searchQueries.push(query);
        return {
          results: Array.from({ length: 10 }, (_, index) => ({
            image_url: `https://images.test/${query}/${index}.jpg`,
            source_url: `https://source.test/${query}/${index}`,
            mime_type: "image/jpeg",
          })),
        };
      },
      imageFetch: async ({ url }: { url: string }) => {
        const resultIndex = Number(url.split("/").at(-1)?.replace(".jpg", ""));
        if (failedDownloads.has(resultIndex)) throw new Error("source returned 403");
        fetchedCount += 1;
        return {
          path: `web-images/${resultIndex}.jpg`,
          get_url: options.imageFetchUrl ?? `https://aps.test/${resultIndex}.jpg`,
          mime_type: "image/jpeg",
          bytes_size: options.imageFetchBytes ?? 3,
          sha256: options.imageFetchHash?.(resultIndex) ?? String(resultIndex).padStart(64, "0"),
          source_url: url,
          final_url: url,
        };
      },
      getImageDownloadUrl: async (path: string) => {
        downloadPaths.push(path);
        return options.downloadUrl ? options.downloadUrl(path) : `https://aps.test/${path.split("/").at(-1)}`;
      },
    },
    agentClient: {
      createImageResearchSession: async () => ({
        run: async (prompt: string, runOptions: { attachments?: Array<{ url: string }> }) => {
          runCount += 1;
          attachmentCounts.push(runOptions.attachments?.length ?? 0);
          attachmentUrls.push((runOptions.attachments ?? []).map((attachment) => attachment.url));
          if (options.sessionError) throw new Error(options.sessionError);
          const response = options.sessionResponses?.[runCount - 1];
          if (response !== undefined) return response;
          const candidateIds = [...prompt.matchAll(/"candidate_id": "([^\"]+)"/g)].map((match) => match[1] ?? "");
          return JSON.stringify((options.sessionAction ?? defaultSessionAction)({ runCount, prompt, candidateIds }));
        },
        close: async () => { closeCount += 1; },
      }),
    },
    hostUploadClient: {},
  } as unknown as DeckGenerationRuntime;

  return {
    context,
    runtime,
    attachmentCounts,
    attachmentUrls,
    downloadPaths,
    searchQueries,
    counts: () => ({ runCount, closeCount, fetchedCount, importedCount }),
  };
}

function progressState(context: SharedResearchContextResult) {
  return context.progress as Record<string, unknown> & {
    status: string;
    stages: Record<string, string>;
    image?: { gaps?: string[]; searches?: Array<{ query: string; status: string; error?: string }> };
  };
}

it("runs image search serially and validates every progress patch with the engine state machine", async () => {
  const harness = createHarness();

  await runLinearSharedResearch(harness.runtime, { resume: false, phase: "image", imageEnabled: true });

  assert.deepEqual(harness.counts(), { runCount: 2, closeCount: 1, fetchedCount: 10, importedCount: 1 });
  assert.deepEqual(harness.attachmentCounts, [0, 6]);
  assert.deepEqual(harness.searchQueries, ["market documentary"]);
  const progress = progressState(harness.context);
  assert.equal(progress.status, "completed");
  assert.equal(progress.stages.image_search, "completed");
  assert.equal(progress.stages.image_deduplication, "completed");
  assert.equal(progress.stages.image_prefetch, "completed");
  assert.equal(progress.stages.image_analysis, "completed");
  assert.equal(progress.stages.image_import, "completed");
});

it("整体搜图允许省略 decisions，有候选时按本轮全部未选中完成处理", async () => {
  const harness = createHarness({
    sessionResponses: [
      JSON.stringify({ action: "search", query: "market documentary", summary: "" }),
      JSON.stringify({ action: "finish", query: null, summary: "未找到适合的图片，继续搜索没有收益。" }),
    ],
  });

  await runLinearSharedResearch(harness.runtime, { resume: false, phase: "image", imageEnabled: true });

  assert.deepEqual(harness.counts(), { runCount: 2, closeCount: 1, fetchedCount: 10, importedCount: 0 });
  assert.deepEqual(harness.searchQueries, ["market documentary"]);
  assert.deepEqual(harness.attachmentCounts, [0, 6]);
  const progress = progressState(harness.context);
  assert.equal(progress.status, "completed");
  assert.equal(progress.stages.image_analysis, "completed");
});

it("does not resend image attachments during protocol repair", async () => {
  const harness = createHarness({
    sessionResponses: [
      JSON.stringify({ action: "search", query: "market documentary", decisions: [], summary: "" }),
      '{"action":"finish","query":null,"decisions":[],"summary":"Enough images"',
      JSON.stringify({ action: "finish", query: null, decisions: [], summary: "Enough images" }),
    ],
  });

  await runLinearSharedResearch(harness.runtime, { resume: false, phase: "image", imageEnabled: true });

  assert.deepEqual(harness.attachmentCounts, [0, 6, 0]);
  assert.equal(progressState(harness.context).status, "completed");
});

it("ignores invalid mappings and duplicates while saving valid images and continuing the next search", async () => {
  let selectedId = "";
  const harness = createHarness({
    sessionAction: ({ runCount, candidateIds }) => {
      if (runCount === 1) return { action: "search", query: "first query", decisions: [], summary: "" };
      if (runCount === 3) return { action: "finish", query: null, decisions: [], summary: "Enough images" };
      selectedId = candidateIds[0]!;
      const valid = {
        candidate_id: selectedId, attachment_index: 1, use_in_ppt: true,
        description: "A relevant image", reason: "Supports the deck",
      };
      return {
        action: "search", query: "second query", summary: "",
        decisions: [
          { ...valid, candidate_id: "image-unknown" },
          { ...valid, attachment_index: 2 },
          valid,
          { ...valid, description: "Duplicate selection" },
          { ...valid, candidate_id: candidateIds[1], attachment_index: 3 },
        ],
      };
    },
  });

  await runLinearSharedResearch(harness.runtime, { resume: false, phase: "image", imageEnabled: true });

  assert.deepEqual(harness.searchQueries, ["first query", "second query"]);
  assert.equal(harness.counts().runCount, 3);
  assert.equal(harness.counts().importedCount, 1);
  const progress = progressState(harness.context);
  assert.equal(progress.status, "completed");
  const image = progress.image as {
    diagnostic_errors: string[];
    candidates: Array<{ candidate_id: string; import_status: string; description: string }>;
  };
  assert.deepEqual(image.candidates.filter((candidate) => candidate.import_status === "imported").map((candidate) => candidate.candidate_id), [selectedId]);
  assert.equal(image.candidates.find((candidate) => candidate.candidate_id === selectedId)?.description, "A relevant image");
  for (const reason of ["unknown_candidate", "wrong_attachment_index", "duplicate_candidate"]) {
    assert.ok(image.diagnostic_errors.some((error) => error.includes(reason)));
  }
});

for (const nextAction of ["search", "finish"] as const) {
  it(`preserves earlier imports when all selections in a later round are invalid and follows ${nextAction}`, async () => {
    const harness = createHarness({
      sessionAction: ({ runCount, candidateIds }) => {
        if (runCount === 1) return { action: "search", query: "first query", decisions: [], summary: "" };
        if (runCount === 2) return {
          action: "search", query: "second query", summary: "",
          decisions: [{ candidate_id: candidateIds[0], attachment_index: 1, use_in_ppt: true, description: "A relevant image", reason: "Supports the deck" }],
        };
        if (runCount === 3) return {
          action: nextAction, query: nextAction === "search" ? "third query" : null,
          summary: nextAction === "search" ? "" : "No further search needed",
          decisions: [{ candidate_id: "image-unknown", attachment_index: 1, use_in_ppt: true, description: "Invalid image", reason: "Invalid selection" }],
        };
        return { action: "finish", query: null, decisions: [], summary: "Enough images" };
      },
    });

    await runLinearSharedResearch(harness.runtime, { resume: false, phase: "image", imageEnabled: true });

    assert.deepEqual(harness.searchQueries, nextAction === "search" ? ["first query", "second query", "third query"] : ["first query", "second query"]);
    assert.equal(harness.counts().runCount, nextAction === "search" ? 4 : 3);
    assert.equal(harness.counts().importedCount, 1);
    const progress = progressState(harness.context);
    assert.equal(progress.status, "completed");
    assert.equal(progress.stages.image_analysis, "completed");
    assert.equal(progress.stages.image_import, "completed");
    const image = progress.image as { candidates: Array<{ import_status: string }>; written: boolean };
    assert.equal(image.candidates.filter((candidate) => candidate.import_status === "imported").length, 1);
    assert.equal(image.written, true);
  });
}

it("skips candidates larger than the single-image attachment limit", async () => {
  const harness = createHarness({ imageFetchBytes: 4 * 1024 * 1024 });

  await runLinearSharedResearch(harness.runtime, { resume: false, phase: "image", imageEnabled: true });

  assert.deepEqual(harness.attachmentCounts, [0, 0]);
  const progress = progressState(harness.context);
  assert.equal(progress.status, "warning");
  assert.ok(progress.image?.gaps?.some((gap) => gap.includes("@diag:IMG_SOME_EXCEEDED_SIZE_LIMIT")));
  const candidates = (progress.image as { candidates?: Array<{ analysis_status?: string }> } | undefined)?.candidates ?? [];
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((candidate) => candidate.analysis_status === "skipped"));
});

it("stops image analysis when the held Session attachment budget is exhausted", async () => {
  const harness = createHarness({
    imageFetchBytes: 2_500_000,
    sessionAction: ({ runCount }) => (
      runCount <= 3
        ? { action: "search", query: `market documentary ${runCount}`, decisions: [], summary: "" }
        : { action: "finish", query: null, decisions: [], summary: "Enough images" }
    ),
  });

  await runLinearSharedResearch(harness.runtime, { resume: false, phase: "image", imageEnabled: true });

  assert.deepEqual(harness.attachmentCounts, [0, 6, 6]);
  const progress = progressState(harness.context);
  assert.equal(progress.status, "warning");
  assert.ok(progress.image?.gaps?.some((gap) => gap.includes("@diag:IMG_ATTACHMENT_BUDGET_REACHED_SKIPPED")), JSON.stringify(progress.image?.gaps));
});

it("keeps aggregate image stages running across multiple Session searches", async () => {
  const harness = createHarness({
    sessionAction: ({ runCount, candidateIds }) => {
      if (runCount === 1) return { action: "search", query: "first query", decisions: [], summary: "" };
      const decisions = candidateIds.slice(0, 1).map((candidate_id) => ({
        candidate_id,
        attachment_index: 1,
        use_in_ppt: true,
        description: "A usable documentary image",
        reason: "Supports the deck narrative",
      }));
      if (runCount === 2) return { action: "search", query: "second query", decisions, summary: "" };
      return { action: "finish", query: null, decisions, summary: "The selected images are sufficient." };
    },
  });

  await runLinearSharedResearch(harness.runtime, { resume: false, phase: "image", imageEnabled: true });

  assert.deepEqual(harness.searchQueries, ["first query", "second query"]);
  assert.equal(harness.counts().runCount, 3);
  assert.equal(progressState(harness.context).status, "completed");
});

it("records partial image download failures as warning without an illegal stage transition", async () => {
  const harness = createHarness({ failDownloadIndexes: [1] });

  await runLinearSharedResearch(harness.runtime, { resume: false, phase: "image", imageEnabled: true });

  const progress = progressState(harness.context);
  assert.equal(progress.status, "warning");
  assert.equal(progress.stages.image_prefetch, "warning");
  assert.equal(progress.stages.image_analysis, "completed");
  assert.equal(harness.counts().fetchedCount, 9);
  assert.ok(progress.image?.gaps?.some((gap) => gap.includes("@diag:IMG_APS_FETCH_FAILED")));
});

it("skips image sub-stages when the Session decides no search is needed", async () => {
  const harness = createHarness({
    sessionAction: () => ({ action: "finish", query: null, decisions: [], summary: "Existing images are sufficient." }),
  });

  await runLinearSharedResearch(harness.runtime, { resume: false, phase: "image", imageEnabled: true });

  const progress = progressState(harness.context);
  assert.equal(progress.status, "skipped");
  for (const stage of ["image_search", "image_deduplication", "image_prefetch", "image_analysis", "image_import"]) {
    assert.equal(progress.stages[stage], "skipped");
  }
});

it("settles an interrupted running search before resuming in a new Session", async () => {
  const harness = createHarness({
    initialProgress: createInterruptedSearchProgress(),
    sessionAction: () => ({ action: "finish", query: null, decisions: [], summary: "No further search is useful." }),
  });

  await runLinearSharedResearch(harness.runtime, { resume: true, phase: "image", imageEnabled: true });

  const progress = progressState(harness.context);
  assert.equal(progress.status, "warning");
  assert.equal(progress.stages.image_search, "warning");
  assert.equal(progress.image?.searches?.[0]?.status, "warning");
  assert.match(progress.image?.searches?.[0]?.error ?? "", /@diag:IMG_SEARCH_INTERRUPTED_RESUMED/);
  assert.equal(harness.searchQueries.length, 0);
});

it("settles unstarted image stages when the Session infrastructure fails", async () => {
  const harness = createHarness({ sessionError: "Session unavailable" });

  await runLinearSharedResearch(harness.runtime, { resume: false, phase: "image", imageEnabled: true });

  const progress = progressState(harness.context);
  assert.equal(progress.status, "warning");
  assert.equal(progress.stages.image_research, "warning");
  for (const stage of ["image_search", "image_deduplication", "image_prefetch", "image_analysis", "image_import"]) {
    assert.equal(progress.stages[stage], "skipped");
  }
});


function imageCandidates(harness: ReturnType<typeof createHarness>) {
  return (progressState(harness.context).image as { candidates: SharedResearchImageCandidate[] }).candidates;
}

for (const imageFetchUrl of ["data:image/jpeg;base64,AAAA", "", "https://stale.test/image.jpg"]) {
  it(`resolves APS paths instead of forwarding image_fetch URL: ${imageFetchUrl}`, async () => {
    const harness = createHarness({ imageFetchUrl });
    await runLinearSharedResearch(harness.runtime, { resume: false, phase: "image", imageEnabled: true });
    assert.equal(harness.downloadPaths.length, 10);
    assert.deepEqual(harness.attachmentUrls, [[], Array.from({ length: 6 }, (_, i) => `https://aps.test/${i}.jpg`)]);
    assert.equal(harness.counts().importedCount, 1);
    assert.equal(progressState(harness.context).status, "completed");
  });
}

for (const badUrl of ["data:image/jpeg;base64,AAAA", "", "ftp://images.test/a.jpg", "https://", "/relative.jpg", "//images.test/a.jpg", "throw"]) {
  it(`isolates URL preparation failure and preserves attachment order: ${badUrl}`, async () => {
    const harness = createHarness({
      downloadUrl: async (path) => {
        if (path === "web-images/0.jpg") {
          if (badUrl === "throw") throw new Error("files.download_url unavailable");
          return badUrl;
        }
        return `https://aps.test/${path.split("/").at(-1)}`;
      },
    });
    await runLinearSharedResearch(harness.runtime, { resume: false, phase: "image", imageEnabled: true });
    assert.deepEqual(harness.attachmentUrls, [[], Array.from({ length: 6 }, (_, i) => `https://aps.test/${i + 1}.jpg`)]);
    const candidates = imageCandidates(harness);
    const failed = candidates[0]!;
    assert.equal(failed.aps_fetch_status, "completed");
    assert.equal(failed.aps_path, "web-images/0.jpg");
    assert.equal(failed.sha256, "0".repeat(64));
    assert.equal(failed.mime_type, "image/jpeg");
    assert.equal(failed.bytes_size, 3);
    assert.equal(failed.aps_fetch_error, undefined);
    assert.equal(failed.analysis_status, "failed");
    assert.equal(failed.import_status, "skipped");
    assert.equal(failed.use_in_ppt, false);
    assert.match(failed.error!, /URL preparation failed/);
    assert.equal(candidates[1]!.import_status, "imported");
    assert.equal(harness.counts().importedCount, 1);
    assert.equal(progressState(harness.context).stages.image_analysis, "warning");
    assert.equal(progressState(harness.context).status, "warning");
  });
}

it("finishes with warning and zero imports when every APS URL fails", async () => {
  const harness = createHarness({ downloadUrl: async () => "data:image/jpeg;base64,AAAA" });
  await runLinearSharedResearch(harness.runtime, { resume: false, phase: "image", imageEnabled: true });
  assert.deepEqual(harness.attachmentCounts, [0, 0]);
  assert.equal(harness.counts().importedCount, 0);
  assert.equal(progressState(harness.context).status, "warning");
  assert.ok(imageCandidates(harness).every((c) => c.aps_fetch_status === "completed" && c.analysis_status === "failed" && !c.use_in_ppt));
});

it("resolves resumed APS paths without refetching and isolates failed URLs", async () => {
  const interrupted = createHarness();
  await runLinearSharedResearch(interrupted.runtime, { resume: false, phase: "image", imageEnabled: true });
  const progress = structuredClone(interrupted.context.progress) as any;
  progress.status = "running";
  progress.image.written = false;
  delete progress.image.prepared_batch;
  for (const stage of ["image_research", "image_prefetch", "image_analysis", "image_import"]) progress.stages[stage] = "running";
  progress.image.candidates = progress.image.candidates.slice(0, 2).map((c: SharedResearchImageCandidate) => ({
    ...c, analysis_status: "pending", import_status: "pending", use_in_ppt: false,
  }));
  progress.image.analysis_batches = [{ batch_id: "interrupted", candidate_ids: progress.image.candidates.map((c: SharedResearchImageCandidate) => c.candidate_id), status: "pending", attempt: 1 }];
  const harness = createHarness({
    initialProgress: progress,
    downloadUrl: async (path) => path.endsWith("0.jpg") ? "data:image/jpeg;base64,AAAA" : "https://aps.test/1.jpg",
    sessionAction: ({ candidateIds }) => ({ action: "finish", query: null, decisions: [{ candidate_id: candidateIds[0], attachment_index: 1, use_in_ppt: true, description: "Recovered", reason: "Relevant" }], summary: "Done" }),
  });
  await runLinearSharedResearch(harness.runtime, { resume: true, phase: "image", imageEnabled: true });
  assert.equal(harness.counts().fetchedCount, 0);
  assert.deepEqual(harness.downloadPaths, ["web-images/0.jpg", "web-images/1.jpg"]);
  assert.deepEqual(harness.attachmentUrls, [["https://aps.test/1.jpg"]]);
  assert.equal(harness.counts().importedCount, 1);
  assert.equal(imageCandidates(harness)[0]!.aps_fetch_status, "completed");
  assert.equal(imageCandidates(harness)[0]!.analysis_status, "failed");
});


it("does not let a failed URL suppress a usable candidate with identical content", async () => {
  const harness = createHarness({
    imageFetchHash: (index) => String(index === 9 ? 0 : index).padStart(64, "0"),
    downloadUrl: async (path) => path.endsWith("9.jpg") ? "data:image/jpeg;base64,AAAA" : `https://aps.test/${path.split("/").at(-1)}`,
  });
  await runLinearSharedResearch(harness.runtime, { resume: false, phase: "image", imageEnabled: true });
  assert.equal(harness.attachmentUrls[1]?.[0], "https://aps.test/0.jpg");
  assert.equal(imageCandidates(harness)[0]!.import_status, "imported");
  assert.equal(imageCandidates(harness)[9]!.analysis_status, "failed");
});
