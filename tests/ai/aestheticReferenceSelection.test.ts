import assert from "node:assert/strict";
import test from "node:test";

import { createAnnaAiClient } from "../../src/ai/annaAiClient";
import type { AnnaRuntime } from "../../src/runtime/annaRuntime";

const requirements = {
  version: 1 as const,
  status: "draft" as const,
  source: { brief: "A park introduction" },
  candidates: { audience: [], purpose: [], desired_outcome: [], slide_count: [], output_language: [], visual_tone: [] },
  selections: { audience: null, purpose: null, desired_outcome: null, slide_count: null, output_language: null, visual_tone: null, visual_style_preset: null },
  updated_at: null,
  confirmed_at: null,
};

test("uses the only aesthetic reference without asking the LLM", async () => {
  let completionCalls = 0;
  const runtime: AnnaRuntime = {
    tools: { invoke: async () => ({}) },
    llm: { complete: async () => { completionCalls += 1; throw new Error("LLM must not be called"); } },
    agent: { session: async () => { throw new Error("not used"); } },
  };

  const selectedPath = await createAnnaAiClient(runtime).selectDominantAestheticReference({
    target: "page",
    brief: "A park introduction",
    requirements,
    outline: { title: "Park", status: "confirmed", items: [] },
    page: { page_id: "page-4", page_type: "content", title: "Dining", core_message: "Dining options", content: "Dining options" },
    candidates: [{ path: "html/cover.html", description: "Editorial cover" }],
  });

  assert.equal(selectedPath, "html/cover.html");
  assert.equal(completionCalls, 0);
});
