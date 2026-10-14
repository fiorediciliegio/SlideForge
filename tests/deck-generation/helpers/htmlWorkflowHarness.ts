import assert from "node:assert/strict";
import type { AgentRunOptions } from "../../../src/agent/agentClient.ts";
import type { PageProgress, WorkspaceOutline } from "../../../src/api/types.ts";
import type { DeckGenerationRuntime, RunDeckGenerationInput } from "../../../src/features/deck-generation/types.ts";

// This harness models the HTML workflow's persistence and queued render boundary.
// Agent/LLM parsing and retry algorithms are covered by their executor tests.
export function createHarness(options: {
  statuses?: string[];
  agentError?: Error;
  renderError?: Error;
  finalRenderError?: Error;
  concurrency?: number;
  uploadError?: Error;
  commitError?: Error;
} = {}) {
  const statuses = options.statuses ?? ["pending", "pending"];
  const outline: WorkspaceOutline = {
    version: 4, title: "Demo Deck", status: "confirmed", updated_at: null, confirmed_at: null,
    items: statuses.map((_, index) => ({
      page_id: `page-${index + 1}`, page_type: index === 0 ? "cover" : "standard",
      title: `Title ${index + 1}`,
      content: `Required content ${index + 1}`,
    })),
  };
  let progress: PageProgress = {
    version: 1, status: "running", updated_at: null,
    pages: statuses.map((status, index) => ({
      page_id: `page-${index + 1}`, status, render_attempts: 0,
      visual_review_attempts: 0, agent_failures: 0, agent_infrastructure_failures: 0,
      last_error: "", last_html_path: "", last_screenshot_path: "", updated_at: null,
      ...(status === "accepted" ? { last_html_path: `/output/page-${index + 1}.html`, last_screenshot_path: `/output/page-${index + 1}.png` } : {}),
    })),
  };
  const requests: Array<{ prompt: string; options?: AgentRunOptions }> = [];
  const uploads: Array<{ name: string; content: string }> = [];
  const committedPageIds: string[] = [];
  const committedHtml: string[] = [];
  let renderCalls = 0;
  let finalRenderCalls = 0;
  let activeAgents = 0;
  let maxActiveAgents = 0;
  let prepared = 0;
  const research = { web_summary: "Verified market facts", image_catalog: { assets: [] }, progress: {} };
  const input = {
    backend: {
      getPageProgress: async () => structuredClone(progress),
      getAttachmentContext: async () => null,
      getSharedResearchContext: async () => research,
      getWorkspaceVisualMasterHtml: async () => ({ content: "<html><body>{{PAGE_CONTENT}}</body></html>" }),
      getWorkspaceAestheticReferenceSelections: async () => ({ pages: Object.fromEntries(outline.items.map((item) => [item.page_id, { path: "references/page.html" }])) }),
      getWorkspaceTemplateReferenceHtml: async () => ({ html: "<html><body>Reference aesthetics</body></html>" }),
      prepareWorkspacePageSources: async () => { prepared += 1; },
      reconcileWorkspacePageSources: async () => { prepared += 1; },
      initializePageProgress: async () => structuredClone(progress),
      recordPageProgress: async ({ page_id, patch }: { page_id?: string; patch: Record<string, unknown> }) => {
        const { deck_status, recovery, final_deck_render, ...rest } = patch;
        progress = {
          ...progress,
          ...(page_id
            ? { pages: progress.pages.map((page) => page.page_id === page_id ? { ...page, ...rest } : page) }
            : rest),
          ...(deck_status ? { status: deck_status as string } : {}),
          ...(recovery ? { recovery: { ...progress.recovery, ...recovery as object } } : {}),
          ...(final_deck_render ? { final_deck_render: { ...progress.final_deck_render, ...final_deck_render as object } } : {}),
        } as PageProgress;
        return structuredClone(progress);
      },
      commitWorkspacePageHtml: async ({ page_id, content }: { page_id: string; content: string }) => {
        if (options.uploadError) throw options.uploadError;
        if (options.commitError) throw options.commitError;
        committedPageIds.push(page_id);
        committedHtml.push(content);
      },
      auditWorkspacePageLayout: async ({ page_id }: { page_id: string }) => ({ page_id, source_sha256: "source", error_count: 0, warning_count: 0, report_path: "/output/audit.json" }),
      renderWorkspacePagePreview: async ({ page_id }: { page_id: string }) => {
        renderCalls += 1;
        if (options.renderError) throw options.renderError;
        const index = outline.items.findIndex((item) => item.page_id === page_id);
        progress = { ...progress, pages: progress.pages.map((page) => page.page_id === page_id ? {
          ...page, status: "rendered", render_attempts: 1,
          last_html_path: `/output/${page_id}.html`, last_screenshot_path: `/output/${page_id}.png`,
        } : page) };
        return { slide_id: page_id, page_index: index, render_attempt: 1, source_sha256: "source", workspace_dir: "/workspace" };
      },
      renderDeckHtml: async () => {
        finalRenderCalls += 1;
        assert.ok(progress.pages.every((page) => page.status === "accepted"), "Final render requires all pages to be accepted");
        if (options.finalRenderError) throw options.finalRenderError;
        progress = { ...progress, final_deck_render: { ...progress.final_deck_render, status: "completed" } } as PageProgress;
        return { source_fingerprint: "deck-source" };
      },
      getRenderedDeckHtml: async () => ({ output_dir: "/output", deck_html_path: "/output/deck.html", slides: [], rendered_at: "2026-09-08T00:00:00Z" }),
    },
    agentClient: {
      checkToolAccess: async () => undefined,
      runHtmlGenerationPrompt: async (prompt: string, agentOptions?: AgentRunOptions) => {
        requests.push({ prompt, options: agentOptions });
        activeAgents += 1;
        maxActiveAgents = Math.max(maxActiveAgents, activeAgents);
        // Yield once so the concurrency assertion observes simultaneous page work.
        await new Promise<void>((resolve) => setImmediate(resolve));
        activeAgents -= 1;
        if (options.agentError) throw options.agentError;
        return { html: "<!doctype html><html><body>Generated page</body></html>" };
      },
    },
    aiClient: {},
    hostUploadClient: {
      uploadFile: async (file: File) => {
        if (options.uploadError) throw options.uploadError;
        uploads.push({ name: file.name, content: await file.text() });
        return { transport: "host_upload", size_bytes: file.size, filename: file.name, url: "https://uploads.example/page.html" };
      },
    },
    workspace: {
      workspace_dir: "/workspace", workspace_root: "/", workspace_id: "demo",
      requirements: {
        source: { brief: "Build a market deck" },
        selections: { output_language: "English" },
      },
      setting: { page_generation_concurrency: options.concurrency ?? 1 },
    },
    confirmedOutline: outline,
    // Research itself has dedicated integration tests; these scenarios reuse
    // its persisted result to exercise preparation, pages and final render.
    reuseExistingResearch: true,
    startMode: "resume",
    locale: "en",
    isCancelled: () => false,
    onProgress: () => undefined,
  } as unknown as RunDeckGenerationInput;
  const runtime: DeckGenerationRuntime = {
    ...input,
    activeStreams: new Map(),
    getProgress: () => progress,
    setProgress: (next) => { progress = next; },
  };
  return {
    input, runtime, requests, uploads, committedPageIds, committedHtml,
    get progress() { return progress; },
    counts: () => ({ renderCalls, finalRenderCalls, prepared, maxActiveAgents }),
  };
}

