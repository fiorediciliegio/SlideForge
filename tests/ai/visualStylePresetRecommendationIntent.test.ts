import assert from "node:assert/strict";
import test from "node:test";

import { createAnnaAiClient } from "../../src/ai/annaAiClient";
import {
  parseVisualStylePresetRecommendationIntentResponse,
} from "../../src/ai/visualStylePresetRecommendationIntent";
import type { AnnaLlmCompleteInput, AnnaRuntime } from "../../src/runtime/annaRuntime";

test("template intent parser accepts only the controlled response schema", () => {
  const parsed = parseVisualStylePresetRecommendationIntentResponse({
    use_cases: ["fundraising"], industries: ["consumer"], audiences: ["investor"], formats: ["pitch-deck"],
    explicit_styles: ["formal"], inferred_styles: [], excluded_styles: ["playful"],
  });
  assert.deepEqual(parsed.explicit_styles, ["formal"]);
  assert.deepEqual(parseVisualStylePresetRecommendationIntentResponse({
    ...parsed,
    explicit_styles: [],
    excluded_styles: ["cartoon", "illustration"],
  }).excluded_styles, ["cartoon", "illustration"]);
  assert.throws(() => parseVisualStylePresetRecommendationIntentResponse({
    ...parsed,
    industries: ["unknown-industry"],
  }), /controlled tags/);
});

test("template intent analysis performs at most three total attempts", async () => {
  const requests: AnnaLlmCompleteInput[] = [];
  const runtime: AnnaRuntime = {
    tools: { invoke: async () => ({}) },
    llm: {
      complete: async (input) => {
        requests.push(input);
        return { content: { type: "text", text: "not-json" } };
      },
    },
    agent: { session: async () => { throw new Error("not used"); } },
  };

  await assert.rejects(
    createAnnaAiClient(runtime).analyzeVisualStylePresetRecommendationIntent({ brief: "不要卡通的正式融资路演" }),
    /failed after 3 attempts/,
  );
  assert.equal(requests.length, 3);
});
