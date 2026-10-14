import assert from "node:assert/strict";
import test from "node:test";
import { runPageGeneration } from "../../src/features/deck-generation/pageGenerationRunner.ts";
import { authoringDeckFromConfirmedOutline } from "../../src/features/deck-generation/deckGenerationStartArtifacts.ts";
import { createHarness } from "./helpers/htmlWorkflowHarness.ts";

test("HTML transport failure during persistence retries the complete page attempt three times", async () => {
  const harness = createHarness({ uploadError: new Error("storage upload failed") });
  const deck = authoringDeckFromConfirmedOutline(harness.input.confirmedOutline);
  const result = await runPageGeneration(harness.runtime, deck, deck.pages[0]!);

  assert.equal(result.reason, "page_failed");
  assert.equal(result.error?.page_status, "workspace_commit_failed");
  assert.equal(harness.progress.pages[0]?.status, "workspace_commit_failed");
  assert.equal(harness.progress.pages[0]?.last_error, "storage upload failed");
  assert.equal(harness.requests.length, 3);
  assert.equal(harness.uploads.length, 0);
  assert.equal(harness.committedPageIds.length, 0);
  assert.equal(harness.counts().renderCalls, 0);
});

test("Workspace commit failure retries the complete page attempt three times", async () => {
  const harness = createHarness({ commitError: new Error("workspace commit failed") });
  const deck = authoringDeckFromConfirmedOutline(harness.input.confirmedOutline);
  const result = await runPageGeneration(harness.runtime, deck, deck.pages[0]!);

  assert.equal(result.reason, "page_failed");
  assert.equal(result.error?.page_status, "workspace_commit_failed");
  assert.equal(harness.progress.pages[0]?.status, "workspace_commit_failed");
  assert.equal(harness.progress.pages[0]?.last_error, "workspace commit failed");
  assert.equal(harness.requests.length, 3);
  assert.equal(harness.uploads.length, 0);
  assert.equal(harness.counts().renderCalls, 0);
});

test("render failure retries with the original prompt and never exposes the render error to the Agent", async () => {
  const harness = createHarness({ renderError: new Error("images failed to load: /private/long/path/image.png") });
  const deck = authoringDeckFromConfirmedOutline(harness.input.confirmedOutline);
  const result = await runPageGeneration(harness.runtime, deck, deck.pages[0]!);

  assert.equal(result.reason, "page_failed");
  assert.equal(result.error?.page_status, "render_failed");
  assert.equal(harness.requests.length, 3);
  assert.equal(harness.counts().renderCalls, 3);
  assert.ok(harness.requests.every((request) => request.prompt === harness.requests[0].prompt));
  assert.ok(harness.requests.every((request) => !request.prompt.includes("images failed to load")));
});

test("render retries create and close fresh sessions, then accept the successful version", async () => {
  const { createAgentClient } = await import("../../src/agent/agentClient.ts");
  const h = createHarness({ statuses: ["pending", "accepted"] });
  const sessions: string[][] = [];
  let closed = 0;
  h.runtime.agentClient = await createAgentClient({
    tools: { invoke: async () => ({}) }, llm: { complete: async () => ({}) },
    agent: { session: async () => {
      const prompts: string[] = [];
      sessions.push(prompts);
      return {
        run: (input) => {
          prompts.push(input.content);
          return (async function* () {
            yield { event: "message", text: "<!doctype html><html><body>Page</body></html>" };
            yield { event: "complete" };
          })();
        }, delete: async () => { closed++; },
      };
    } },
  });
  const render = h.runtime.backend.renderWorkspacePagePreview;
  let calls = 0;
  const retryActivities: string[] = [];
  h.runtime.onProgress = (progress) => {
    for (const stream of progress.activeStreams ?? []) {
      retryActivities.push(...stream.activities);
    }
  };
  h.runtime.backend.renderWorkspacePagePreview = async (...args) => {
    if (++calls < 3) throw new Error("private renderer failure");
    return render(...args);
  };
  const deck = authoringDeckFromConfirmedOutline(h.input.confirmedOutline);
  assert.equal((await runPageGeneration(h.runtime, deck, deck.pages[0])).reason, "accepted");
  assert.equal(sessions.length, 3);
  assert.equal(closed, 3);
  assert.deepEqual(sessions[1], sessions[0]);
  assert.deepEqual(sessions[2], sessions[0]);
  assert.ok(retryActivities.some((activity) => activity.includes("Regenerating page 1 (attempt 2/3)")));
  assert.ok(retryActivities.some((activity) => activity.includes("Regenerating page 1 (attempt 3/3)")));
  assert.equal(h.progress.pages[0].last_error, "");
  assert.equal(h.progress.pages[1].status, "accepted");
  assert.deepEqual(h.committedPageIds, ["page-1", "page-1", "page-1"]);
});

test("cancellation after render failure prevents another generation attempt", async () => {
  const h = createHarness();
  h.runtime.backend.renderWorkspacePagePreview = async () => {
    h.runtime.isCancelled = () => true;
    throw new Error("render cancelled");
  };
  const deck = authoringDeckFromConfirmedOutline(h.input.confirmedOutline);
  assert.equal((await runPageGeneration(h.runtime, deck, deck.pages[0])).reason, "cancelled");
  assert.equal(h.requests.length, 1);
});
