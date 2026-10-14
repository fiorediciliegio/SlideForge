import assert from "node:assert/strict";
import test from "node:test";
import { createAnnaAiClient } from "../../src/ai/annaAiClient";
import type { AnnaLlmCompleteInput, AnnaRuntime } from "../../src/runtime/annaRuntime";
import type { PlanDeckRefinementInput } from "../../src/ai/types";

const input: PlanDeckRefinementInput = {
  instruction: "Make the second page clearer",
  locale: "en",
  currentStyleGuide: "# Style\nUse blue.",
  requirements: {
    version: 1, status: "confirmed", source: { brief: "A deck" },
    candidates: { slide_count: [2], output_language: ["English"], },
    selections: {
      slide_count: 2, output_language: "English",
    },
    updated_at: null, confirmed_at: null,
  },
  outline: {
    version: 4, title: "Demo", status: "confirmed", updated_at: null, confirmed_at: null,
    items: [
      { page_id: "page-1", title: "One", content: "A" },
      { page_id: "page-2", title: "Two", content: "B" },
    ],
  },
};

test("Deck Refinement Planning tolerates fenced JSON and recovers from an invalid schema", async () => {
  const requests: AnnaLlmCompleteInput[] = [];
  const responses = [
    { content: { type: "text", text: "not json" } },
    { content: { type: "text", text: "```json\n{\"route\":\"proceed\",\"title\":\"Demo\",\"output_language_change\":{\"changed\":false},\"style_guide_change\":{\"action\":\"preserve\",\"reason\":\"Keep\"},\"operations\":[{\"op\":\"keep\",\"page_id\":\"page-1\",\"reason\":\"Keep\"}],\"reason\":\"Proceed\"}\n```" } },
    { content: { type: "text", text: JSON.stringify({
      route: "proceed", title: "Demo", output_language_change: { changed: false }, style_guide_change: { action: "preserve", reason: "Keep" },
      persistent_elements_action: "preserve",
      visual_rhythm_action: "preserve",
      operations: [
        { op: "keep", page_id: "page-1", reason: "Keep" },
        { op: "keep", page_id: "page-2", reason: "Keep" },
      ], reason: "Proceed",
    }) } },
  ];
  const runtime: AnnaRuntime = {
    tools: { invoke: async () => ({}) },
    llm: { complete: async (request) => { requests.push(request); return responses[requests.length - 1]; } },
    agent: { session: async () => { throw new Error("not used"); } },
  };
  const result = await createAnnaAiClient(runtime).planDeckRefinement(input);
  assert.equal(result.plan.operations.length, 2);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.attempts[0]?.status, "retry");
  assert.equal(result.attempts[1]?.status, "retry");
  assert.equal(result.attempts[2]?.status, "success");
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[2], requests[0]);
});
