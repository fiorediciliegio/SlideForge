import assert from "node:assert/strict";
import test from "node:test";
import { createAiInteractionLogger } from "../../src/ai/interactionLog.ts";
import { runDeckRefinement } from "../../src/features/deck-generation/index.ts";
import { createHarness } from "./helpers/htmlWorkflowHarness.ts";

const originalHtml = '<!doctype html><html><body>Original<img src="file:///workspace/page-assets/image.png"></body></html>';
const screenshot = {
  url: "https://uploads.example/page-1.png", mime_type: "image/png", filename: "page-1.png",
};

function refinementHarness(withScreenshot = true, html = originalHtml) {
  const harness = createHarness({ statuses: ["accepted", "accepted"] });
  const editRequests: string[] = [];
  harness.input.backend.getPageEditContext = async ({ page_id, purpose }) => {
    assert.equal(purpose, "refinement");
    editRequests.push(page_id);
    return {
      html,
      screenshot_upload: withScreenshot ? screenshot : null,
    } as never;
  };
  const input = {
    ...harness.input,
    scope: "slide" as const,
    pageId: "page-1",
    instruction: "把布局改得更紧凑。",
  };
  return { harness, input, editRequests };
}

test("HTML page refinement preserves other pages and sends original HTML, request, screenshot and logging context", async (t) => {
  const { harness, input, editRequests } = refinementHarness();
  const fetched: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    fetched.push(url);
    return new Response(originalHtml);
  });
  const untouched = structuredClone(harness.progress.pages[1]);
  const originalOutline = structuredClone(input.confirmedOutline);
  input.aiLogger = createAiInteractionLogger({ appendWorkspaceLog: async () => undefined });
  const completion = await runDeckRefinement(input);

  assert.equal(completion.status, "completed");
  assert.deepEqual(editRequests, ["page-1"]);
  assert.deepEqual(fetched, []);
  assert.deepEqual(harness.committedPageIds, ["page-1"]);
  assert.deepEqual(harness.progress.pages[1], untouched);
  assert.deepEqual(input.confirmedOutline, originalOutline);
  assert.equal(harness.requests.length, 1);
  const request = harness.requests[0]!;
  assert.ok(request.prompt.includes(originalHtml));
  assert.ok(request.prompt.includes(input.instruction));
  assert.doesNotMatch(request.prompt, /data:image\/(?:png|jpeg|webp);base64,/);
  assert.deepEqual(request.options?.attachments, [{ type: "image/png", url: screenshot.url, filename: "page-1.png", detail: "auto" }]);
  assert.equal(request.options?.logContext?.page_id, "page-1");
});

test("HTML refinement rejects unavailable context before changing page state", async (t) => {
  for (const context of ["missing screenshot", "empty HTML"] as const) {
    const { harness, input } = refinementHarness(context !== "missing screenshot", context === "empty HTML" ? "" : originalHtml);
    const before = structuredClone(harness.progress);
    await assert.rejects(() => runDeckRefinement(input), /No screenshot|HTML is empty/);
    assert.deepEqual(harness.progress, before);
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.uploads.length, 0);
  }
});
