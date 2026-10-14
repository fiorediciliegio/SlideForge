import assert from "node:assert/strict";
import test from "node:test";
import { createAnnaAiClient } from "../../src/ai/hostAiClient";
import type { AnnaLlmCompleteInput, HostRuntime } from "../../src/runtime/hostRuntime";

test("requirements retry sends the exact original request again", async () => {
  const requests: AnnaLlmCompleteInput[] = [];
  const responses = [
    { content: { type: "text", text: '{"slide_count":["auto"]}' } },
    { content: { type: "text", text: JSON.stringify({
      slide_count: [5],
    }) } },
  ];
  const runtime: HostRuntime = {
    tools: { invoke: async () => ({}) },
    llm: {
      complete: async (input) => {
        requests.push(input);
        return responses[requests.length - 1];
      },
    },
    agent: { session: async () => { throw new Error("not used"); } },
  };

  const result = await createAnnaAiClient(runtime).generatePresentationRequirements({
    brief: "Five slides in English.",
    outputLanguage: "English",
  });
  assert.equal(result.slide_count[0], 5);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
});
