import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import type { BatchTestWorkflowDependencies } from "../../src/features/batch-testing/workflow.ts";
import type { BatchTestInput } from "../../src/features/batch-testing/types.ts";
import { expandBatchTestInput } from "../../src/features/batch-testing/input.ts";
import { createEmptyPresentationRequirements } from "../../src/features/requirements/presentationRequirements.ts";

// Keep the actual batch orchestration and attachment Brief pipeline. Replace
// external research/generation and the Vite-only visual catalog at their seams.
const hooks = registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  const stub = (source: string) => ({ ...result, source });
  if (url.endsWith("/templates/visualStylePresets.ts")) return stub(`
    const preset = {id: "test", version: 1, name: "Test", description: "Test", color: ["blue"]};
    export const VISUAL_STYLE_PRESETS = [preset];
    export const findVisualStylePreset = () => preset;
    export const listVisualStylePresetColors = () => ["blue"];
    export const sampleVisualStylePresetsByColor = () => [preset];
    export const toVisualStylePresetSelection = () => preset;
    export const loadVisualStylePresetReferenceHtmlPages = async () => [];
  `);
  if (url.endsWith("/deck-generation/index.ts")) return stub(`
    export const runParallelSharedResearch = async (input, options) => globalThis.__batchAttachmentScenario.research(input, options);
    export const runDeckGeneration = async (input) => globalThis.__batchAttachmentScenario.generate(input);
  `);
  if (url.endsWith("/deck-generation/uploadedSourceAnalysisWorkflow.ts")) return stub(`
    export const ensureFreshUploadedSourceAnalysis = async () => ({summary: "Uploaded analysis"});
  `);
  if (url.endsWith("/deck-generation/uploadedSourceAnalysis.ts")) return stub(`
    export const renderUploadedSourceAnalysisMarkdown = () => "Uploaded analysis";
  `);
  return result;
} });
const { runBatchTestWorkflow } = await import("../../src/features/batch-testing/workflow.ts");
hooks.deregister();

function scenario(target: BatchTestInput["target_stage"], options: { cancelOcr?: boolean; supported?: boolean; reuse?: boolean } = {}) {
  const events: string[] = [];
  const controller = new AbortController();
  const upload = { transport: "host_upload" as const, r2_key: "source.pdf", url: "https://example.test/source.pdf", mime_type: "application/pdf", size_bytes: 42 };
  const input: BatchTestInput = { target_stage: target, ...(options.reuse ? { repeat: 2, reuse_requirements: true } : {}), briefs: [{ brief: "Use this PDF", attachments: [{ filename: "source.pdf", size_bytes: 42, host_upload: upload }] }] };
  const cases = expandBatchTestInput(input).map((item) => ({ ...item, status: "pending", workspace_id: item.case_id, workspace_dir: `/test/${item.case_id}`, case_dir: `/test/${item.case_id}`, performance_dir: `/test/${item.case_id}/performance` }));
  const stored: any = { test_id: "test", root_dir: "/test", target_stage: target, status: "queued", cases };
  // Attachment-only engine responses intentionally omit large upload refs.
  const transport = () => ({ ...structuredClone(stored), cases: stored.cases.map(({ attachments: _, ...item }: any) => structuredClone(item)) });
  const workspace: any = { workspace_id: "test", workspace_dir: cases[0]!.workspace_dir, requirements: createEmptyPresentationRequirements(), outline: { title: "", items: [] } };
  const source = { uploaded_source_id: "source-1", extension: ".pdf", original_filename: "source.pdf", status: "active" };
  const text = "# Page 1\nRevenue is 42.";
  const attachmentContext: any = { version: 1, user_brief: input.briefs[0]!.brief, attachment_context: [] };
  let ocrCalls = 0;
  let recommendationCalls = 0;
  let reloads = 0;
  const confirmations: any[] = [];
  const result = () => ({ source_id: "source-1", filename: "source.pdf", file_type: "pdf", parse_status: "ready", content_strategy: ocrCalls < 2 ? null : "full_context", original_reading_method: "document_read", character_count: text.length, token_estimate: 12, warnings: [], pdf_ocr_progress: { status: ocrCalls < 2 ? "processing" : "completed" } });
  const assertContext = (value: any) => assert.equal(value.attachment_context[0].content, text);
  (globalThis as any).__batchAttachmentScenario = {
    research: async (value: any, opts: any) => { assertContext(value.attachmentContext); events.push("research"); },
    generate: async (value: any) => { assert.equal(value.resumeResearch, true); events.push("generation"); return { status: "completed" }; },
  };
  const candidates = { slide_count: [1], output_language: ["English"], };
  const deps = {
    locale: "en", appVersion: "test", signal: controller.signal, aiLogger: null,
    onRun: () => {}, onProgress: () => {}, agentClient: {},
    attachmentBriefCompletionClient: { complete: async () => { throw new Error("Small PDF should use full context"); } },
    hostUploadClient: { uploadFile: async () => { throw new Error("Template snapshots must use ordinary invoke"); } },
    aiClient: {
      detectOutputLanguage: async () => ({ output_language: "English" }),
      generatePresentationRequirements: async (value: any) => { assertContext(value.attachmentContext); events.push("requirements"); return candidates; },
      analyzeVisualStylePresetRecommendationIntent: async () => {
        recommendationCalls++;
        return { intent: { use_cases: [], industries: [], audiences: [], formats: [], explicit_styles: [], inferred_styles: [], excluded_styles: [] }, attempts: [] };
      },
      generateOutline: async (value: any) => {
        assertContext(value.attachmentContext);
        assert.equal(value.webResearchSummary, "Web evidence");
        events.push("outline");
        return { outline: { title: "Revenue", items: [{ title: "Revenue", content: "Revenue is 42" }] } };
      },
    },
    researchAiClient: { recommendResearch: async (value: any) => { assertContext(value.attachmentContext); return { web: { enabled: true }, images: { enabled: true } }; } },
    backend: {
      listPerformanceRuns: async () => ({ active_run: null }),
      createBatchTestRun: async () => ({ run: transport() }), listBatchTestRuns: async () => { reloads++; return { runs: [transport()] }; },
      listUserTemplates: async () => { throw new Error("Automatic recommendations must not read hidden personal templates"); },
      updateBatchTestRun: async ({ status }: any) => { stored.status = status; return transport(); },
      updateBatchTestCase: async (update: any) => { Object.assign(stored.cases.find((item: any) => item.case_id === update.case_id), update); return transport(); },
      startPerformanceRun: async () => ({ run_id: "perf" }), finalizePerformanceRun: async () => ({ run: { status: "completed", report_available: true } }),
      materializePerformanceRun: async () => ({ files: ["/test/report.html"] }),
      openWorkspace: async () => workspace,
      commitUploadedSourceHostUpload: async () => { events.push("upload"); }, listUploadedSources: async () => ({ active: [source] }),
      runUploadedSourcePreflight: async () => ({ results: [result()] }),
      getRuntimeInfo: async () => ({ uploaded_source_preflight: { pdf_ocr_continuation: options.supported !== false } }),
      continueUploadedSourcePdfOcr: async () => { ocrCalls++; events.push("ocr"); if (options.cancelOcr) controller.abort(); return { results: [result()] }; },
      getUploadedSourcePreflightText: async () => ({ content: text, offset: 0, next_offset: null, total_characters: text.length }),
      recordAttachmentBrief: async ({ brief }: any) => { attachmentContext.attachment_context = [brief]; return brief; },
      writeAttachmentContext: async () => { events.push("context"); }, getAttachmentContext: async () => attachmentContext,
      updateWorkspaceRequirements: async ({ requirements }: any) => { workspace.requirements = requirements; return workspace; },
      confirmWorkspaceRequirements: async (input: any) => {
        assert.ok(input.template_snapshot);
        assert.equal(input.host_upload, undefined);
        confirmations.push(input);
        workspace.requirements = input.requirements; return { workspace };
      },
      getPageProgress: async () => ({}), getSharedResearchContext: async () => ({ web_summary: "Web evidence", image_catalog: { schema_version: 2, assets: [] } }),
      saveWorkspaceOutlineDraft: async ({ outline }: any) => { workspace.outline = outline; return workspace; },
      confirmWorkspaceOutline: async () => workspace,
      beginGenerationRun: async () => ({ run_id: "generation" }), prepareGenerationRun: async () => ({ workspace, transaction: { state: "active" } }),
      cleanupGenerationRun: async () => {},
      commitGenerationRun: async () => ({ workspace }), runPptxExport: async () => { events.push("export"); return { status: "completed", pptx_path: "/test/deck.pptx" }; },
    },
  } as unknown as BatchTestWorkflowDependencies;
  return { input, deps, events, confirmations, controller, recommendationCalls: () => recommendationCalls, reloads: () => reloads };
}

for (const target of ["attachment-context-created", "requirements-confirmed", "web-research-completed", "outline-confirmed", "image-research-completed", "pptx-exported"] as const) {
  test(`${target} finishes PDF OCR before consuming attachments and preserves stage order`, async () => {
    const s = scenario(target);
    const run = await runBatchTestWorkflow(s.input, s.deps);
    assert.equal(run.status, "completed", run.cases[0]?.error ?? undefined);
    const expected = ["upload", "ocr", "ocr", "context"];
    if (target !== "attachment-context-created") expected.push("requirements");
    if (!["attachment-context-created", "requirements-confirmed"].includes(target)) expected.push("research");
    if (["outline-confirmed", "pptx-exported"].includes(target)) expected.push("outline");
    if (target === "pptx-exported") expected.push("generation", "export");
    assert.deepEqual(s.events, expected);
  });
}

test("cancelling during PDF OCR stops before creating attachment context or requirements", async () => {
  const s = scenario("pptx-exported", { cancelOcr: true });
  const run = await runBatchTestWorkflow(s.input, s.deps);
  assert.equal(run.status, "cancelled");
  assert.deepEqual(s.events, ["upload", "ocr"]);
});

test("an older engine fails explicitly before consuming incomplete PDF context", async () => {
  const s = scenario("requirements-confirmed", { supported: false });
  const run = await runBatchTestWorkflow(s.input, s.deps);
  assert.equal(run.status, "failed");
  assert.match(run.cases[0]!.error!, /does not support PDF OCR continuation/);
  assert.deepEqual(s.events, ["upload"]);
});


test("repeated requirements tests reuse requirements while confirming each recommendation via ordinary invoke", async () => {
  const s = scenario("requirements-confirmed", { reuse: true });
  const run = await runBatchTestWorkflow(s.input, s.deps);
  assert.equal(run.status, "completed", run.cases.find((item) => item.error)?.error ?? undefined);
  assert.equal(s.events.filter((event) => event === "requirements").length, 1);
  assert.equal(s.recommendationCalls(), 2);
  assert.equal(s.confirmations.length, 2);
  assert.equal(s.confirmations[1].template_snapshot.preset.id, "test");
  assert.equal(s.reloads(), 0, "successful full-run updates should not enter response recovery");
});

test("recommendation-only batches persist the built-in recommendation without starting workspace generation", async () => {
  const s = scenario("template-recommendation-completed");
  const run = await runBatchTestWorkflow(s.input, s.deps);
  assert.equal(run.status, "completed", run.cases[0]?.error ?? undefined);
  assert.equal(run.cases[0]?.template_recommendation_result?.preset.id, "test");
  assert.equal(run.cases[0]?.template_recommendation_result?.trace.low_signal, true);
  assert.equal(s.recommendationCalls(), 1);
  assert.equal(s.reloads(), 0);
  assert.deepEqual(s.events, []);
});


test("cancelling during template analysis cannot persist a successful recommendation", async () => {
  const s = scenario("template-recommendation-completed");
  s.deps.aiClient.analyzeVisualStylePresetRecommendationIntent = async () => {
    s.controller.abort();
    throw new Error("cancelled");
  };
  const run = await runBatchTestWorkflow(s.input, s.deps);
  assert.equal(run.status, "cancelled");
  assert.equal(run.cases[0]?.template_recommendation_result, undefined);
});
