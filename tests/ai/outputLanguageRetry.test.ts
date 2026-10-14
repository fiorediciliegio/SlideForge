import assert from "node:assert/strict";
import test from "node:test";
import { createAnnaAiClient } from "../../src/ai/hostAiClient";
import type { AnnaLlmCompleteInput, HostRuntime } from "../../src/runtime/hostRuntime";

test("output language detection retries invalid JSON with the exact original request", async () => {
  const requests: AnnaLlmCompleteInput[] = [];
  const responses = [
    { content: { type: "text", text: "not json" } },
    { content: { type: "text", text: "```json\n{\"output_language\":\"English\"}\n```" } },
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

  const result = await createAnnaAiClient(runtime).detectOutputLanguage({
    brief: "Create an English presentation.",
  });
  assert.deepEqual(result, { output_language: "English" });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
});
