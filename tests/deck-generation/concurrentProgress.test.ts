import assert from "node:assert/strict";
import test from "node:test";
import { runDeckGeneration } from "../../src/features/deck-generation/index.ts";
import { reconcileGenerationPagePreviews, selectGenerationPagePreviewSources, type GenerationPagePreviews } from "../../src/features/deck-workspace/generationPagePreviews.ts";
import { createHarness } from "./helpers/htmlWorkflowHarness.ts";

for (const delayed of ["stream", "write-response", "poll-response"] as const) {
  test(`并发页面的旧 ${delayed} 不回退已完成页或清空缩略图`, { timeout: 3000 }, async () => {
    const harness = createHarness({ concurrency: 2 });
    let firstAccepted = false;
    let release!: () => void;
    const accepted = new Promise<void>((resolve) => { release = resolve; });
    let previews: GenerationPagePreviews = {};
    let checked = 0;
    harness.input.onProgress = (event) => {
      const first = event.pages.find((page) => page.page_id === "page-1");
      if (firstAccepted) {
        assert.equal(first?.status, "accepted", "另一页的旧响应不能回退第一页");
        assert.equal(first?.last_html_path, "/output/page-1.html");
        checked++;
      }
      const state = reconcileGenerationPagePreviews(previews, selectGenerationPagePreviewSources(event));
      previews = state.previews;
      for (const source of state.pending) previews[source.pageId]!.status = "ready";
      if (firstAccepted) assert.equal(previews["page-1"]?.status, "ready");
      if (first?.status === "accepted") { firstAccepted = true; release(); }
    };
    let agents = 0;
    harness.input.agentClient.runHtmlGenerationPrompt = async () => {
      if (++agents === 2 && delayed === "stream") await accepted;
      return { html: "<!doctype html><html><body>页面</body></html>" } as never;
    };
    if (delayed === "write-response") {
      const record = harness.input.backend.recordPageProgress;
      harness.input.backend.recordPageProgress = async (input) => {
        const response = await record(input);
        if (input.page_id === "page-2" && input.patch.status === "authoring") await accepted;
        return response;
      };
    }
    if (delayed === "poll-response") {
      let beginAudit!: () => void;
      let endAudit!: () => void;
      const auditing = new Promise<void>((resolve) => { beginAudit = resolve; });
      const polled = new Promise<void>((resolve) => { endAudit = resolve; });
      const audit = harness.input.backend.auditWorkspacePageLayout;
      harness.input.backend.auditWorkspacePageLayout = async (input) => {
        if (input.page_id === "page-1") { beginAudit(); await polled; }
        return audit(input);
      };
      const render = harness.input.backend.renderWorkspacePagePreview;
      harness.input.backend.renderWorkspacePagePreview = async (input) => {
        if (input.page_id === "page-2") await auditing;
        return render(input);
      };
      const read = harness.input.backend.getPageProgress;
      harness.input.backend.getPageProgress = async (input) => {
        const response = await read(input);
        if (response.pages[1]?.status === "rendered" && !firstAccepted) {
          endAudit();
          await accepted;
        }
        return response;
      };
    }
    const result = await runDeckGeneration(harness.input);
    assert.equal(result.status, "completed");
    assert.ok(checked > 0);
  });
}
