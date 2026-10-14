import assert from "node:assert/strict";
import test from "node:test";

import {
  addTokenUsageSummary,
  createEmptyTokenUsageSummary,
  normalizeTokenUsage,
  summaryFromTokenUsage,
} from "../../src/performance/tokenUsage.ts";

test("normalizes Session and LLM usage into the shared token shape", () => {
  const session = normalizeTokenUsage({
    total_prompt_tokens: 445,
    total_completion_tokens: 10,
    total_tokens: 455,
    total_calls: 1,
    total_estimated_cost: 0.000253,
  }, "session");
  const llm = normalizeTokenUsage({ inputTokens: 1, outputTokens: 15, totalTokens: 16 }, "llm");

  assert.equal(session?.total_tokens, 455);
  assert.equal(session?.estimated_cost, 0.000253);
  assert.equal(llm?.total_tokens, 16);

  const summary = addTokenUsageSummary(
    createEmptyTokenUsageSummary(),
    addTokenUsageSummary(
      summaryFromTokenUsage("session", session!),
      summaryFromTokenUsage("llm", llm!),
    ),
  );
  assert.equal(summary.session.total_tokens, 455);
  assert.equal(summary.llm.total_tokens, 16);
  assert.equal(summary.total.total_tokens, 471);
});

test("ignores responses without token usage fields", () => {
  assert.equal(normalizeTokenUsage({ quotaConsumed: 12 }, "llm"), null);
});
