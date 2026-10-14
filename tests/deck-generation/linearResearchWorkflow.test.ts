import { confirmedRequirements } from "../fixtures/imageRequirements";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AiInteractionLogger } from "../../src/ai/interactionLog.ts";
import type {
  SharedResearchContextResult,
  SharedResearchImageAsset,
  SharedResearchImageBatch,
  SharedResearchProgressOperation,
} from "../../src/api/types.ts";
import {
  buildLinearResearchUiProgress,
  chunkSharedResearchProgressOperations,
  compactWebSearchRecordForPatch,
  runParallelSharedResearch,
  runLinearSharedResearch,
} from "../../src/features/deck-generation/linearResearchWorkflow.ts";
import type { DeckGenerationRuntime } from "../../src/features/deck-generation/types.ts";
import {
  applySharedResearchProgressOperations,
  createDefaultSharedResearchProgress,
} from "../../executas/ppt-engine/src/app-workspace/shared-research-progress.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function createRuntime(
  overrides: Record<string, unknown> = {},
  options: { strictSharedResearchProgress?: boolean } = {},
) {
  const context: SharedResearchContextResult = {
    workspace_dir: "/tmp/workspace",
    web_summary_path: "/tmp/workspace/research/evidence/web-summary.md",
    image_catalog_path: "/tmp/workspace/research/evidence/image-catalog.json",
    images_dir: "/tmp/workspace/research/evidence/images",
    progress_path: "/tmp/workspace/research/web-image-search-progress.json",
    web_summary: "# Web Research Summary\n",
    image_catalog: { schema_version: 2, assets: [] },
    progress: options.strictSharedResearchProgress ? createDefaultSharedResearchProgress() : {},
  };
  const webBatches: string[] = [];
  const imageBatches: SharedResearchImageBatch[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const pageProgress = { pages: [] };
  let pageProgressWriteCount = 0;
  const asRecord = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const upsert = (items: unknown, key: string, value: Record<string, unknown>) => {
    const current = Array.isArray(items) ? items.map(asRecord) : [];
    const index = current.findIndex((item) => item[key] === value[key]);
    if (index >= 0) current[index] = structuredClone(value);
    else current.push(structuredClone(value));
    return current;
  };
  const applyPatch = (operations: SharedResearchProgressOperation[]) => {
    const progress = context.progress;
    progress.schema_version ??= 2;
    progress.status ??= "waiting";
    progress.stages ??= {};
    for (const operation of operations) {
      const web = asRecord(progress.web);
      const image = asRecord(progress.image);
      if (operation.op === "set_stage") {
        asRecord(progress.stages)[operation.stage] = operation.state;
        if (operation.state === "running" && progress.status === "waiting") progress.status = "running";
      } else if (operation.op === "set_web_decision") progress.web = { ...web, decision: structuredClone(operation.decision) };
      else if (operation.op === "upsert_web_search") progress.web = { ...web, searches: upsert(web.searches, "query", { ...operation.search, query: operation.query }) };
      else if (operation.op === "set_web_fetch_result_ids") progress.web = { ...web, fetch_result_ids: [...operation.result_ids] };
      else if (operation.op === "upsert_web_fetched_page") progress.web = { ...web, fetched_pages: upsert(web.fetched_pages, "url", { ...operation.page, url: operation.url }) };
      else if (operation.op === "set_web_prepared_batch") progress.web = { ...web, prepared_batch: operation.markdown, written: false };
      else if (operation.op === "set_web_diagnostics") progress.web = { ...web, gaps: [...operation.gaps], diagnostic_errors: [...operation.diagnostic_errors] };
      else if (operation.op === "set_image_decision") progress.image = { ...image, decision: structuredClone(operation.decision) };
      else if (operation.op === "upsert_image_search") progress.image = { ...image, searches: upsert(image.searches, "query", { ...operation.search, query: operation.query }) };
      else if (operation.op === "set_image_work_status") progress.image = { ...image, [operation.field]: operation.state };
      else if (operation.op === "upsert_image_deduplication_entry") {
        const deduplication = asRecord(image.deduplication);
        progress.image = {
          ...image,
          deduplication: { ...deduplication, groups: upsert(deduplication.groups, "candidate_id", { ...operation.group, candidate_id: operation.candidate_id }) },
          candidates: upsert(image.candidates, "candidate_id", { ...operation.candidate, candidate_id: operation.candidate_id }),
        };
      } else if (operation.op === "set_image_deduplication_summary") {
        progress.image = { ...image, deduplication: { ...asRecord(image.deduplication), status: "completed", strategy: operation.strategy, statistics: operation.statistics } };
      } else if (operation.op === "upsert_image_analysis_batch") {
        let candidates = image.candidates;
        for (const candidate of operation.candidates) candidates = upsert(candidates, "candidate_id", { ...candidate.candidate, candidate_id: candidate.candidate_id });
        progress.image = { ...image, analysis_batches: upsert(image.analysis_batches, "batch_id", { ...operation.batch, batch_id: operation.batch_id }), candidates };
      }
      else if (operation.op === "upsert_image_candidate") progress.image = { ...image, candidates: upsert(image.candidates, "candidate_id", { ...operation.candidate, candidate_id: operation.candidate_id }) };
      else if (operation.op === "set_image_diagnostics") progress.image = { ...image, gaps: [...operation.gaps], diagnostic_errors: [...operation.diagnostic_errors] };
      else if (operation.op === "set_image_content_deduplication") progress.image = { ...image, content_deduplication: structuredClone(operation.value) };
      else if (operation.op === "finalize_image_research") {
        progress.image = {
          ...image,
          prepared_batch: {
            title: operation.title,
            status: operation.status,
            queries: structuredClone(operation.queries),
            candidates: structuredClone(Array.isArray(image.candidates) ? image.candidates : []),
            gaps: [...operation.gaps],
            statistics: structuredClone(operation.statistics),
          },
          written: false,
        };
      } else if (operation.op === "finalize_shared_research") progress.status = "completed";
    }
  };
  const backend = {
    prepareSharedResearchWorkspace: async () => context,
    getSharedResearchContext: async () => context,
    patchSharedResearchProgress: async ({ operations }: { operations: SharedResearchProgressOperation[] }) => {
      if (options.strictSharedResearchProgress) {
        context.progress = applySharedResearchProgressOperations(
          context.progress,
          operations as Parameters<typeof applySharedResearchProgressOperations>[1],
        ).progress;
      } else {
        applyPatch(operations);
      }
      return { workspace_dir: context.workspace_dir, progress_path: context.progress_path, updated: true, revision: 1, updated_at: new Date().toISOString() };
    },
    recordPageProgress: async () => {
      pageProgressWriteCount += 1;
      return pageProgress;
    },
    publishPreparedWebResearchBatch: async () => {
      const web = asRecord(context.progress.web);
      const markdown = String(web.prepared_batch ?? "");
      webBatches.push(markdown);
      context.web_summary = `${context.web_summary.trimEnd()}\n\n${markdown}\n`;
      context.progress.web = { ...web, written: true };
      return { workspace_dir: context.workspace_dir, artifact_path: context.web_summary_path, published: true, already_published: false, revision: 1 };
    },
    publishPreparedImageResearchBatch: async () => {
      const batch = asRecord(asRecord(context.progress.image).prepared_batch) as unknown as SharedResearchImageBatch;
      imageBatches.push(structuredClone(batch));
      const assets = batch.candidates.filter((candidate) => (
        candidate.use_in_ppt
        && candidate.import_status === "imported"
        && candidate.file_path
        && candidate.sha256
        && candidate.mime_type
        && candidate.bytes_size
      )).map((candidate): SharedResearchImageAsset => ({
        asset_id: candidate.candidate_id,
        file_path: candidate.file_path as string,
        sha256: candidate.sha256 as string,
        mime_type: candidate.mime_type as string,
        bytes_size: candidate.bytes_size as number,
        ...(typeof candidate.width === "number" ? { width: candidate.width } : {}),
        ...(typeof candidate.height === "number" ? { height: candidate.height } : {}),
        description: candidate.description,
        reason: candidate.reason,
        matched_queries: candidate.matched_queries ?? [candidate.query],
        source_url: candidate.source_url,
      }));
      for (const asset of assets) {
        if (!context.image_catalog.assets.some((existing) => existing.sha256 === asset.sha256)) {
          context.image_catalog.assets.push(structuredClone(asset));
        }
      }
      context.progress.image = { ...asRecord(context.progress.image), written: true };
      return { workspace_dir: context.workspace_dir, artifact_path: context.image_catalog_path, published: true, already_published: false, revision: 1 };
    },
    prepareSharedResearchImageCandidate: async ({ candidate_id, source_url }: { candidate_id: string; source_url: string }) => ({
      workspace_dir: context.workspace_dir,
      candidate_id,
      local_file_path: `/tmp/workspace/research/evidence/images/.staging/research/${candidate_id}.jpg`,
      final_url: source_url,
      mime_type: "image/jpeg",
      bytes_size: 3,
      sha256: candidate_id.padEnd(64, "0").slice(0, 64),
      width: 1600,
      height: 900,
    }),
    uploadSharedResearchImageCandidate: async ({ candidate_id }: { candidate_id: string }) => ({
      workspace_dir: context.workspace_dir,
      candidate_id,
      host_upload: {
        transport: "host_upload" as const,
        r2_key: `uploads/${candidate_id}`,
        url: `https://upload.test/${candidate_id}`,
        mime_type: "image/jpeg",
        size_bytes: 3,
        filename: `${candidate_id}.jpg`,
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    }),
    importSharedResearchImageLocal: async ({
      candidate_id,
      sha256,
      mime_type,
      size_bytes,
    }: { candidate_id: string; sha256: string; mime_type: string; size_bytes: number }) => ({
      workspace_dir: context.workspace_dir,
      candidate_id,
      file_path: `/tmp/workspace/research/evidence/images/${candidate_id}.png`,
      sha256,
      mime_type,
      bytes_size: size_bytes,
    }),
    cleanupSharedResearchImageStaging: async ({ operation_id }: { operation_id: string }) => ({
      workspace_dir: context.workspace_dir,
      operation_id,
      cleaned: true,
    }),
    appendWorkspaceLog: async ({ entry }: { entry: Record<string, unknown> }) => {
      logs.push(structuredClone(entry));
      return { appended: true };
    },
  };
  const runtime = {
    backend,
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
    getProgress: () => pageProgress,
    setProgress: () => undefined,
    onProgress: () => undefined,
    isCancelled: () => false,
    researchWebClient: {
      search: async () => ({ results: [] }),
      fetch: async () => ({ pages: [] }),
      imageSearch: async () => ({ results: [] }),
      imageFetch: async () => ({
        path: "aps/image",
        get_url: "https://download.test/image",
        mime_type: "image/png",
        bytes_size: 3,
        sha256: "sha256",
        source_url: "https://source.test",
        final_url: "https://image.test",
      }),
      getImageDownloadUrl: async () => "https://download.test/image",
    },
    hostUploadClient: {
      uploadFile: async () => ({
        transport: "host_upload",
        r2_key: "key",
        url: "https://upload.test/image",
        mime_type: "image/png",
        size_bytes: 3,
      }),
    },
    ...overrides,
    agentClient: {
      createWebResearchSession: async () => ({
        run: async () => '{"action":"finish"}\n# Research summary\n\n## Sources\n\n- None required.',
        close: async () => undefined,
      }),
      createImageResearchSession: async () => ({
        run: async () => '{"action":"finish","query":null,"decisions":[],"summary":"No new image search is needed."}',
        close: async () => undefined,
      }),
      ...asRecord(overrides.agentClient),
    },
  } as unknown as DeckGenerationRuntime;
  const runtimeRecord = runtime as unknown as { researchWebClient: Record<string, unknown> };
  runtimeRecord.researchWebClient = {
    search: async () => ({ results: [] }),
    fetch: async () => ({ pages: [] }),
    imageSearch: async () => ({ results: [] }),
    imageFetch: async () => ({
      path: "aps/image",
      get_url: "https://download.test/image",
      mime_type: "image/png",
      bytes_size: 3,
      sha256: "sha256",
      source_url: "https://source.test",
      final_url: "https://image.test",
    }),
    getImageDownloadUrl: async () => "https://download.test/image",
    ...asRecord(overrides.researchWebClient),
  };
  return {
    runtime,
    context,
    webBatches,
    imageBatches,
    logs,
    get pageProgressWriteCount() {
      return pageProgressWriteCount;
    },
  };
}

describe("Linear Shared Research workflow", () => {
  it("projects bounded live Web and image progress from the checkpoint", () => {
    const checkpoint = {
      schema_version: 2,
      status: "running",
      stages: {
        web_decision: "completed",
        web_research: "running",
        image_decision: "completed",
        image_research: "running",
        image_search: "completed",
        image_deduplication: "completed",
        image_prefetch: "completed",
        image_analysis: "running",
        image_import: "running",
      },
      web: {
        decision: { needs_search: true, queries: ["market evidence", "policy update"], rationale: "Current sources are needed." },
        searches: [
          { query: "market evidence", status: "completed", result: [{ result_id: "web-q1-r1", title: "Official report", url: "https://source.test/report", snippet: "Evidence", site: "source.test" }] },
          { query: "policy update", status: "running" },
        ],
      },
      image: {
        decision: { needs_search: true, queries: ["factory photo"] },
        searches: [{ query: "factory photo", status: "completed", result: [] }],
        candidates: [{
          candidate_id: "image-1",
          query: "factory photo",
          image_url: "https://images.test/factory.jpg",
          source_url: "https://source.test/factory",
          use_in_ppt: true,
          description: "Factory",
          reason: "Relevant",
          local_download_status: "completed",
          upload_status: "completed",
          analysis_status: "completed",
          import_status: "imported",
        }],
        analysis_batches: [
          { batch_id: "batch-1", candidate_ids: ["image-1"], status: "completed", attempt: 1, interaction_ids: [] },
          { batch_id: "batch-2", candidate_ids: [], status: "running", attempt: 1, interaction_ids: [] },
        ],
      },
    } as Parameters<typeof buildLinearResearchUiProgress>[0];

    const progress = buildLinearResearchUiProgress(checkpoint, "2026-08-05T00:00:00.000Z");
    const web = progress.records.find((record) => record.phase === "web-collection");
    const image = progress.records.find((record) => record.phase === "visual-collection");

    assert.deepEqual(web?.activity, { kind: "web-search", completed: 1, total: 2 });
    assert.deepEqual(web?.queries?.map((query) => query.status), ["collected", "running"]);
    assert.deepEqual(image?.activity, { kind: "image-analysis", completed: 1, total: 2, selected: 1 });
    assert.equal(progress.summary.visualAssets, 1);
    assert.equal(image?.queries?.[0]?.images?.[0]?.imageUrl, "https://images.test/factory.jpg");
    assert.equal(image?.queries?.[0]?.images?.[0]?.state, "available");
    assert.equal(web?.queries?.[0]?.sources?.[0]?.url, "https://source.test/report");
    assert.equal(web?.queries?.[0]?.sources?.[0]?.snippet, "Evidence");
  });

  it("publishes image research UI without writing the previous Page Progress", async () => {
    const progressEvents: Array<{ researchDiscovery?: unknown }> = [];
    const harness = createRuntime({
      onProgress: (progress: { researchDiscovery?: unknown }) => {
        progressEvents.push(progress);
      },
    });

    await runLinearSharedResearch(harness.runtime, {
      phase: "image",
      resume: false,
      imageEnabled: false,
      publishToPageProgress: false,
    });

    assert.equal(harness.pageProgressWriteCount, 0);
    assert.ok(progressEvents.some((progress) => progress.researchDiscovery));
  });

  it("finalizes strict shared research when Web and image research are disabled", async () => {
    const harness = createRuntime({}, { strictSharedResearchProgress: true });

    await runLinearSharedResearch(harness.runtime, {
      phase: "image",
      resume: false,
      webEnabled: false,
      imageEnabled: false,
      publishToPageProgress: false,
    });

    const stages = harness.context.progress.stages as Record<string, string>;
    assert.equal(stages.web_decision, "skipped");
    assert.equal(stages.web_research, "skipped");
    // 图片搜索关闭时，图片各阶段必须全部 skipped，而不是 waiting。
    for (const stage of ["image_search", "image_deduplication", "image_prefetch", "image_analysis", "image_import"]) {
      assert.equal(stages[stage], "skipped", stage);
    }
    assert.equal(harness.context.progress.status, "skipped");
  });

  it("runs Web and image sessions concurrently and finalizes after both settle", async () => {
    let activeSessions = 0;
    let maxActiveSessions = 0;
    const harness = createRuntime({
      agentClient: {
        createWebResearchSession: async () => ({
          run: async () => {
            activeSessions += 1;
            maxActiveSessions = Math.max(maxActiveSessions, activeSessions);
            await new Promise<void>((resolve) => setImmediate(resolve));
            activeSessions -= 1;
            return '{"action":"finish"}\n# Web summary\n\n- Fact';
          },
          close: async () => undefined,
        }),
        createImageResearchSession: async () => ({
          run: async () => {
            activeSessions += 1;
            maxActiveSessions = Math.max(maxActiveSessions, activeSessions);
            await new Promise<void>((resolve) => setImmediate(resolve));
            activeSessions -= 1;
            return '{"action":"finish","query":null,"decisions":[],"summary":"No image search needed."}';
          },
          close: async () => undefined,
        }),
      },
    }, { strictSharedResearchProgress: true });

    const result = await runParallelSharedResearch(harness.runtime, {
      resume: false,
      webEnabled: true,
      imageEnabled: true,
      publishToPageProgress: false,
    });

    assert.ok(maxActiveSessions >= 2);
    assert.equal(result.context.progress.status, "completed");
    const stages = (result.context.progress.stages ?? {}) as Record<string, string>;
    assert.equal(stages.web_research, "completed");
    assert.equal(stages.image_research, "skipped");
  });

  it("executes batched Agent search and fetch actions in one Session", async () => {
    const urls = [
      "https://source.test/first",
      "https://source.test/second",
      "https://source.test/third",
    ];
    const searchCalls: Array<{ query: string; max_results?: number }> = [];
    const fetchCalls: Array<{ urls: string[]; max_chars?: number }> = [];
    const sessionRuns: Array<{ prompt: string; options: { modelPreference?: string } }> = [];
    let sessionSystemPrompt = "";
    let sessionCreations = 0;
    let sessionCloses = 0;
    let activeSearches = 0;
    let maxActiveSearches = 0;
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const { runtime } = createRuntime({
      agentClient: {
        createWebResearchSession: async (systemPrompt: string) => {
          sessionSystemPrompt = systemPrompt;
          sessionCreations += 1;
          const actions = [
            JSON.stringify({ action: "search", queries: ["market evidence", "policy update"] }),
            JSON.stringify({ action: "fetch", urls }),
            '{"action":"finish"}\n# Market evidence\n\n## Sources\n\n- https://source.test/first',
          ];
          return {
            run: async (prompt: string, options: { modelPreference?: string }) => {
              sessionRuns.push({ prompt, options });
              return actions.shift() ?? "";
            },
            close: async () => { sessionCloses += 1; },
          };
        },
      },
      researchWebClient: {
        search: async (input: { query: string; max_results?: number }) => {
          searchCalls.push({ ...input });
          activeSearches += 1;
          maxActiveSearches = Math.max(maxActiveSearches, activeSearches);
          await new Promise<void>((resolve) => setImmediate(resolve));
          activeSearches -= 1;
          return {
            results: urls.map((url, index) => ({
              title: `${input.query} source ${index + 1}`,
              url,
              snippet: `Evidence ${index + 1}`,
              site: "source.test",
            })),
          };
        },
        fetch: async (input: { urls: string[]; max_chars?: number }) => {
          fetchCalls.push(structuredClone(input));
          activeFetches += 1;
          maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
          await new Promise<void>((resolve) => setImmediate(resolve));
          activeFetches -= 1;
          return {
            pages: input.urls.map((url) => ({ url, ok: true, content: `Content for ${url}` })),
          };
        },
        imageSearch: async () => ({ results: [] }),
        imageFetch: async () => ({
          path: "aps/image",
          get_url: "https://download.test/image",
          mime_type: "image/png",
          bytes_size: 3,
          sha256: "sha256",
          source_url: "https://source.test",
          final_url: "https://image.test",
        }),
      },
    });

    await runLinearSharedResearch(runtime, { resume: false });

    assert.deepEqual(fetchCalls, [{ urls, max_chars: 8000 }]);
    assert.deepEqual(searchCalls.map((call) => call.max_results), [6, 6]);
    assert.equal(maxActiveSearches, 2);
    assert.equal(maxActiveFetches, 1);
    assert.equal(sessionCreations, 1);
    assert.equal(sessionCloses, 1);
    assert.ok(sessionRuns[0]?.prompt.includes("当前日期（搜索资料截止日期）"));
    assert.ok(sessionRuns[0]?.prompt.includes("## 演示主题"));
    assert.match(sessionRuns[0]?.prompt ?? "", /Create a market deck\./);
    assert.ok(sessionSystemPrompt.includes("不要调用任何工具"));
  });

  it("returns one Web API failure to the same Session and continues researching", async () => {
    const urls = ["https://source.test/failing", "https://source.test/available"];
    const fetchCalls: string[][] = [];
    const sessionPrompts: string[] = [];
    const { runtime, context } = createRuntime({
      agentClient: {
        createWebResearchSession: async () => {
          const actions = [
            '{"action":"search","queries":["market evidence"]}',
            JSON.stringify({ action: "fetch", urls }),
            '{"action":"finish"}\n# Market evidence\n\n## Sources\n\n- https://source.test/available',
          ];
          return {
            run: async (prompt: string) => {
              sessionPrompts.push(prompt);
              return actions.shift() ?? "";
            },
            close: async () => undefined,
          };
        },
      },
      researchWebClient: {
        search: async () => ({ results: urls.map((url, index) => ({ title: `Source ${index + 1}`, url, snippet: "Evidence", site: "source.test" })) }),
        fetch: async ({ urls: requested }: { urls: string[] }) => {
          fetchCalls.push([...requested]);
          return {
            pages: [...requested].reverse().map((url) => url.endsWith("failing")
              ? { url, ok: false, error: "source unavailable" }
              : { url, ok: true, content: "Available evidence" }),
          };
        },
        imageSearch: async () => ({ results: [] }),
      },
    });

    await runLinearSharedResearch(runtime, { resume: false });

    assert.deepEqual(fetchCalls, [urls]);
    const fetchedPages = (context.progress as { web?: { fetched_pages?: Array<{ ok: boolean }> } }).web?.fetched_pages ?? [];
    assert.deepEqual(fetchedPages.map((page) => page.ok), [false, true]);
    assert.ok(sessionPrompts.some((prompt) => prompt.includes("source unavailable")));
  });

  it("stops after three consecutive Agent protocol errors", async () => {
    let runs = 0;
    let closes = 0;
    const { runtime, context } = createRuntime({
      agentClient: {
        createWebResearchSession: async () => ({
          run: async () => {
            runs += 1;
            return "not a protocol action";
          },
          close: async () => { closes += 1; },
        }),
      },
    });

    await assert.rejects(
      () => runLinearSharedResearch(runtime, { phase: "web", resume: false, webEnabled: true }),
      /invalid protocol output 3 consecutive times/,
    );

    assert.equal(runs, 3);
    assert.equal(closes, 1);
    const rounds = (context.progress as { web?: { decision?: { rounds?: unknown[] } } }).web?.decision?.rounds ?? [];
    assert.equal(rounds.length, 3);
  });

  it("blocks publication when the Web research Session cannot be deleted", async () => {
    const { runtime, webBatches } = createRuntime({
      agentClient: {
        createWebResearchSession: async () => ({
          run: async () => '{"action":"finish"}\n# Research\n\n## Sources\n\n- https://source.test',
          close: async () => { throw new Error("delete failed"); },
        }),
      },
    });

    await assert.rejects(
      () => runLinearSharedResearch(runtime, { phase: "web", resume: false, webEnabled: true }),
      /delete failed/,
    );
    assert.equal(webBatches.length, 0);
  });

  it("stops after the default round budget when finish is never returned", async () => {
    let runs = 0;
    let searches = 0;
    const { runtime } = createRuntime({
      agentClient: {
        createWebResearchSession: async () => ({
          run: async () => {
            runs += 1;
            return '{"action":"search","queries":["same query"]}';
          },
          close: async () => undefined,
        }),
      },
      researchWebClient: {
        search: async () => {
          searches += 1;
          return { results: [] };
        },
        fetch: async () => ({ pages: [] }),
        imageSearch: async () => ({ results: [] }),
      },
    });

    await assert.rejects(
      () => runLinearSharedResearch(runtime, { phase: "web", resume: false, webEnabled: true }),
      /valid finish action within 10 rounds/,
    );

    // Ten research rounds plus three refused round-limit finish requests.
    assert.equal(runs, 13);
    assert.equal(searches, 1);
  });

  it("starts a new Session on retry and reuses saved search results", async () => {
    let sessionAttempt = 0;
    let searchCalls = 0;
    const retryPrompts: string[] = [];
    const { runtime, context, webBatches } = createRuntime({
      agentClient: {
        createWebResearchSession: async () => {
          sessionAttempt += 1;
          let run = 0;
          return {
            run: async (prompt: string) => {
              run += 1;
              if (sessionAttempt === 1) {
                if (run === 1) return '{"action":"search","queries":["saved query"]}';
                throw new Error("Session interrupted");
              }
              retryPrompts.push(prompt);
              if (run === 1) return '{"action":"search","queries":["saved query"]}';
              return '{"action":"finish"}\n# Recovered research\n\n## Sources\n\n- https://source.test/saved';
            },
            close: async () => undefined,
          };
        },
      },
      researchWebClient: {
        search: async () => {
          searchCalls += 1;
          return { results: [{ title: "Saved", url: "https://source.test/saved", snippet: "Evidence", site: "source.test" }] };
        },
        fetch: async () => ({ pages: [] }),
        imageSearch: async () => ({ results: [] }),
      },
    });

    await assert.rejects(
      () => runLinearSharedResearch(runtime, { phase: "web", resume: false, webEnabled: true }),
      /Session interrupted/,
    );
    await runLinearSharedResearch(runtime, { phase: "web", resume: true, webEnabled: true });

    assert.equal(sessionAttempt, 2);
    assert.equal(searchCalls, 1);
    assert.ok(retryPrompts[0]?.includes("本次研究已完成的动作"));
    assert.equal(webBatches.length, 1);
    const attempt = (context.progress as { web?: { decision?: { session_attempt?: number } } }).web?.decision?.session_attempt;
    assert.equal(attempt, 2);
  });

  it("splits a five-query image checkpoint into patches below 32 KiB", () => {
    const operations: SharedResearchProgressOperation[] = Array.from({ length: 5 }, (_, queryIndex) => ({
      op: "upsert_image_search" as const,
      query: `query-${queryIndex + 1}`,
      search: {
        query: `query-${queryIndex + 1}`,
        status: "completed",
        result: Array.from({ length: 6 }, (_, resultIndex) => ({
          occurrence_id: `image-q${queryIndex + 1}-r${resultIndex + 1}`,
          image_url: `https://images.test/${queryIndex + 1}/${resultIndex + 1}.jpg`,
          source_url: `https://source.test/${queryIndex + 1}/${resultIndex + 1}`,
          title: `Candidate ${queryIndex + 1}-${resultIndex + 1}`,
          description: "x".repeat(1200),
        })),
      },
    }));
    const batches = chunkSharedResearchProgressOperations("/tmp/workspace", operations);
    assert.ok(batches.length > 1);
    assert.equal(batches.flat().length, operations.length);
    for (const batch of batches) {
      const bytes = new TextEncoder().encode(JSON.stringify({ workspace_dir: "/tmp/workspace", operations: batch })).byteLength;
      assert.ok(bytes <= 32 * 1024, `patch was ${bytes} bytes`);
    }
  });

  it("compacts an oversized Web search operation by UTF-8 snippet bytes", () => {
    const workspaceDir = "/tmp/workspace";
    const search = {
      query: "long search query",
      status: "completed",
      result: Array.from({ length: 6 }, (_, index) => ({
        title: `Result ${index + 1}`,
        url: `https://example.test/${index + 1}`,
        snippet: "米兰科尔蒂纳冬奥会资料".repeat(900),
        site: "example.test",
      })),
    };
    const compacted = compactWebSearchRecordForPatch(workspaceDir, search);
    const operation = {
      workspace_dir: workspaceDir,
      operations: [{ op: "upsert_web_search", query: search.query, search: compacted }],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(operation)).byteLength;
    assert.ok(bytes <= 32 * 1024, `patch was ${bytes} bytes`);
    assert.ok((compacted.result as Array<{ snippet: string }>).some((item) => item.snippet.length < search.result[0].snippet.length));
  });

  it("keeps raw technical errors out of formal research batches", async () => {
    const sentinel = "SECRET_TECHNICAL_ERROR_123";
    const { runtime, webBatches, imageBatches, logs, context } = createRuntime({
      agentClient: {
        createImageResearchSession: async () => { throw new Error(sentinel); },
      },
    });
    await runLinearSharedResearch(runtime, { resume: false });
    assert.equal(webBatches.some((batch) => batch.includes(sentinel)), false);
    assert.equal(JSON.stringify(imageBatches).includes(sentinel), false);
    assert.equal(JSON.stringify(logs).includes(sentinel), true);
    assert.equal(JSON.stringify(context.progress).includes(sentinel), true);
  });

  it("summarizes Web research at the configured round limit instead of failing", async () => {
    const prompts: string[] = [];
    let round = 0;
    const harness = createRuntime({
      workspace: {
        workspace_dir: "/tmp/workspace",
        setting: { research_web_max_rounds: 2 },
        requirements: { ...confirmedRequirements(), source: { brief: "Create a market deck." } },
      },
      researchWebClient: {
        search: async ({ query }: { query: string }) => ({
          results: [{ title: `Result for ${query}`, url: `https://source.test/${encodeURIComponent(query)}`, snippet: "Evidence", site: "source.test" }],
        }),
      },
      agentClient: {
        createWebResearchSession: async () => ({
          run: async (prompt: string) => {
            prompts.push(prompt);
            round += 1;
            if (round <= 2) return `{"action":"search","queries":["market evidence ${round}"]}`;
            return '{"action":"finish"}\n# Research summary\n\n- Partial evidence only.';
          },
          close: async () => undefined,
        }),
      },
    });

    await runLinearSharedResearch(harness.runtime, {
      phase: "web",
      resume: false,
      webEnabled: true,
      publishToPageProgress: false,
    });

    // Two research rounds plus one round-limit finish request.
    assert.equal(round, 3);
    assert.match(prompts[2] as string, /轮次上限（2 轮）已经用尽/);
    assert.equal(harness.webBatches.length, 1);
    assert.match(harness.webBatches[0] as string, /Partial evidence only/);
    const web = harness.context.progress.web as { gaps?: string[] };
    assert.ok(web.gaps?.some((gap) => gap.includes("limit of 2 rounds")), JSON.stringify(web.gaps));
  });

  it("stops Web research when the Session ignores finish after the round limit", async () => {
    let round = 0;
    const harness = createRuntime({
      workspace: {
        workspace_dir: "/tmp/workspace",
        setting: { research_web_max_rounds: 1 },
        requirements: { ...confirmedRequirements(), source: { brief: "Create a market deck." } },
      },
      researchWebClient: {
        search: async ({ query }: { query: string }) => ({
          results: [{ title: `Result for ${query}`, url: `https://source.test/${encodeURIComponent(query)}`, snippet: "Evidence", site: "source.test" }],
        }),
      },
      agentClient: {
        createWebResearchSession: async () => ({
          run: async () => {
            round += 1;
            return `{"action":"search","queries":["market evidence ${round}"]}`;
          },
          close: async () => undefined,
        }),
      },
    });

    await assert.rejects(
      runLinearSharedResearch(harness.runtime, {
        phase: "web",
        resume: false,
        webEnabled: true,
        publishToPageProgress: false,
      }),
      /did not return a valid finish action within 1 rounds/,
    );
    // One research round plus three refused round-limit finish requests.
    assert.equal(round, 4);
    assert.equal(harness.webBatches.length, 0);
  });

  it("honors the configured image research search limit", async () => {
    let searches = 0;
    const harness = createRuntime({
      workspace: {
        workspace_dir: "/tmp/workspace",
        setting: { research_image_max_searches: 1 },
        requirements: { ...confirmedRequirements(), source: { brief: "Create a market deck." } },
      },
      researchWebClient: {
        imageSearch: async () => {
          searches += 1;
          return { results: [] };
        },
      },
      agentClient: {
        createImageResearchSession: async () => ({
          run: async () => `{"action":"search","query":"factory photo ${searches}","decisions":[],"summary":""}`,
          close: async () => undefined,
        }),
      },
    });

    await runLinearSharedResearch(harness.runtime, {
      phase: "image",
      resume: false,
      webEnabled: false,
      imageEnabled: true,
      publishToPageProgress: false,
    });

    assert.equal(searches, 1);
    const image = harness.context.progress.image as { gaps?: string[] };
    assert.ok(image.gaps?.some((gap) => gap.includes("@diag:IMG_SEARCH_LIMIT_REACHED") && gap.includes('"limit":1')), JSON.stringify(image.gaps));
  });
});

for (const webEnabled of [true, false]) for (const imageEnabled of [true, false]) {
  it(`pre-outline parallel research honors independent switches: web=${webEnabled}, image=${imageEnabled}`, async () => {
    let webCalls = 0;
    let imageCalls = 0;
    const harness = createRuntime({
      agentClient: {
        createWebResearchSession: async () => ({ run: async () => { webCalls++; return '{"action":"finish"}\\n# Research\\nAvailable facts'.replaceAll('\\n', '\n'); }, close: async () => undefined }),
        createImageResearchSession: async () => ({ run: async (prompt: string) => {
          imageCalls++;
          assert.match(prompt, /Create a market deck/);
          assert.doesNotMatch(prompt, /完整大纲：|Web 研究资料/);
          return '{"action":"finish","query":null,"decisions":[],"summary":"No additional photos needed"}';
        }, close: async () => undefined }),
      },
    }, { strictSharedResearchProgress: true });
    await runParallelSharedResearch(harness.runtime, { resume: false, webEnabled, imageEnabled, publishToPageProgress: false });
    assert.equal(webCalls, webEnabled ? 1 : 0);
    assert.equal(imageCalls, imageEnabled ? 1 : 0);
    const stages = harness.context.progress.stages as Record<string, string>;
    assert.ok(Object.values(stages).every((state) => state !== "waiting" && state !== "running"));
    await runParallelSharedResearch(harness.runtime, { resume: true, webEnabled, imageEnabled, publishToPageProgress: false });
    assert.equal(webCalls, webEnabled ? 1 : 0, "completed Web research must not run again on resume");
    assert.equal(imageCalls, imageEnabled ? 1 : 0, "completed image research must not run again on resume");
  });
}


it("emits Web report content before the Session finishes without persisting live rounds", async () => {
  const { runResearchSession, researchProgressForPersistence } = await import("../../src/features/deck-generation/researchLiveProgress.ts");
  const { streamedResearchReport } = await import("../../src/features/process-progress/model.ts");
  const gate = deferred<string>();
  const events: import("../../src/features/deck-generation/types.ts").DeckGenerationProgress[] = [];
  const harness = createRuntime({ onProgress: (event: import("../../src/features/deck-generation/types.ts").DeckGenerationProgress) => events.push(event) });
  harness.runtime.researchDiscoveryProgress = buildLinearResearchUiProgress({
    schema_version: 2, status: "running", stages: { web_research: "running" },
  } as Parameters<typeof buildLinearResearchUiProgress>[0]);
  const pending = runResearchSession(harness.runtime, "web", {
    run: async (_prompt, options) => {
      options.onStreamEvent?.({ type: "content", text: '{"action":"finish"}\n# Live report\n\nFirst paragraph' });
      // A single chunk must flush even if the provider then goes silent.
      return gate.promise;
    }, close: async () => undefined,
  }, "research", {});
  await new Promise((resolve) => setTimeout(resolve, 110));
  const live = events.at(-1)?.researchDiscovery;
  const round = live?.records.find((record) => record.phase === "web-collection")?.liveRounds?.[0];
  assert.equal(round?.state, "running");
  assert.equal(streamedResearchReport(round?.text ?? ""), "# Live report\n\nFirst paragraph");
  assert.equal(JSON.stringify(researchProgressForPersistence(live!)).includes("First paragraph"), false);
  gate.resolve('{"action":"finish"}\n# Final report');
  await pending;
  assert.equal(events.at(-1)?.researchDiscovery?.records.find((record) => record.phase === "web-collection")?.liveRounds?.[0]?.state, "completed");
  assert.equal(round?.state, "running", "previous event snapshots must remain immutable");
});
