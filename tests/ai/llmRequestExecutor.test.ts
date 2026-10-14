import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LLM_MAX_ATTEMPTS,
  executeLlmRequest,
  LlmRequestExecutionError,
} from "../../src/ai/llmRequestExecutor.ts";
import type { AnnaLlmCompleteInput, HostRuntime } from "../../src/runtime/hostRuntime.ts";

function runtimeWithResponses(
  requests: AnnaLlmCompleteInput[],
  responses: Array<unknown | Error>,
): HostRuntime {
  return {
    tools: { invoke: async () => ({}) },
    llm: {
      complete: async (request) => {
        requests.push(request);
        const response = responses[requests.length - 1];
        if (response instanceof Error) throw response;
        return response;
      },
    },
    agent: { session: async () => { throw new Error("not used"); } },
  };
}

test("retries request and validation failures without changing the request", async () => {
  const requests: AnnaLlmCompleteInput[] = [];
  const waits: number[] = [];
  const request: AnnaLlmCompleteInput = {
    messages: [{ role: "user", content: { type: "text", text: "Return JSON." } }],
  };
  const result = await executeLlmRequest({
    runtime: runtimeWithResponses(requests, [
      new Error("network interrupted"),
      { text: "not json" },
      { text: '{"ok":true}' },
    ]),
    request,
    timeoutMs: 1_000,
    performanceLayer: "test-llm",
    wait: async (delayMs) => { waits.push(delayMs); },
    random: () => 0.5,
    accept: (rawText) => JSON.parse(rawText) as { ok: boolean },
  });

  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.attempts.length, 3);
  assert.equal(result.attempts[0]?.failure_kind, "request");
  assert.equal(result.attempts[1]?.failure_kind, "response_validation");
  assert.equal(result.attempts[2]?.status, "success");
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[2], requests[0]);
  assert.deepEqual(requests[0]?.modelPreferences, {
    hints: [{ name: "google/gemini-3-flash-preview" }],
  });
  assert.deepEqual(result.attempts.map((attempt) => attempt.request), requests);
  assert.equal(request.modelPreferences, undefined);
  assert.deepEqual(waits, [250]);
});

test("adds corrective feedback only after a validation failure when requested", async () => {
  const requests: AnnaLlmCompleteInput[] = [];
  const request: AnnaLlmCompleteInput = {
    messages: [{ role: "user", content: { type: "text", text: "Return JSON." } }],
  };

  const result = await executeLlmRequest({
    runtime: runtimeWithResponses(requests, [
      { text: "not json" },
      { text: '{"ok":true}' },
    ]),
    request,
    timeoutMs: 1_000,
    performanceLayer: "test-llm",
    wait: async () => undefined,
    random: () => 0.5,
    accept: (rawText) => JSON.parse(rawText) as { ok: boolean },
    onValidationRetry: ({ baseRequest, attempt }) => ({
      ...baseRequest,
      messages: [
        ...baseRequest.messages,
        {
          role: "user",
          content: { type: "text", text: `Correct the previous output: ${attempt.errors.join("; ")}` },
        },
      ],
    }),
  });

  assert.deepEqual(result.value, { ok: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.messages.length, 1);
  assert.equal(requests[1]?.messages.length, 2);
  assert.match(requests[1]?.messages[1]?.content.text ?? "", /Correct the previous output/);
  assert.equal(request.messages.length, 1);
  assert.deepEqual(requests[1]?.modelPreferences, {
    hints: [{ name: "google/gemini-3-flash-preview" }],
  });
});

test("preserves caller model preferences on the runtime.call path", async () => {
  for (const modelPreferences of [
    { hints: [{ name: "openai/gpt-5-mini" }], speedPriority: 0.8 },
    { costPriority: 1 },
    {},
  ]) {
    const requests: AnnaLlmCompleteInput[] = [];
    const runtime = runtimeWithResponses([], []);
    runtime.call = async (namespace, method, input) => {
      assert.equal(namespace, "llm");
      assert.equal(method, "complete");
      requests.push(input as AnnaLlmCompleteInput);
      return { text: "ok" };
    };
    await executeLlmRequest({
      runtime,
      request: {
        messages: [{ role: "user", content: "Return ok." }],
        modelPreferences,
      },
      timeoutMs: 1_000,
      performanceLayer: "test-llm",
      accept: (text) => text,
    });
    assert.deepEqual(requests[0]?.modelPreferences, modelPreferences);
  }
});

test("returns all attempts when the retry budget is exhausted", async () => {
  const requests: AnnaLlmCompleteInput[] = [];
  const request: AnnaLlmCompleteInput = {
    messages: [{ role: "user", content: { type: "text", text: "Return JSON." } }],
  };

  await assert.rejects(
    () => executeLlmRequest({
      runtime: runtimeWithResponses(requests, Array.from(
        { length: DEFAULT_LLM_MAX_ATTEMPTS },
        () => ({ text: "not json" }),
      )),
      request,
      timeoutMs: 1_000,
      performanceLayer: "test-llm",
      accept: (rawText) => JSON.parse(rawText),
    }),
    (error) => {
      assert.equal(error instanceof LlmRequestExecutionError, true);
      const executionError = error as LlmRequestExecutionError;
      assert.equal(executionError.attempts.length, DEFAULT_LLM_MAX_ATTEMPTS);
      assert.equal(requests.length, DEFAULT_LLM_MAX_ATTEMPTS);
      assert.equal(executionError.attempts.at(-1)?.will_retry, false);
      assert.ok(executionError.attempts.every((attempt) => (
        attempt.request_hash === executionError.attempts[0]?.request_hash
      )));
      return true;
    },
  );
});
