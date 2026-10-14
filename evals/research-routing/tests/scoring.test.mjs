import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { scoreStage1 } from "../src/scoring.mjs";

const hash = createHash("sha256").update("prompt").digest("hex");

test("stage one scores Web and Image independently and ranks by macro F1", () => {
  const score = scoreStage1({
    schema_version: 1,
    results: [
      { case_id: "case-001", prompt_version: "v1", prompt_hash: hash, status: "completed", expected: { web: true, images: false }, actual: { web: true, images: false }, latency_ms: 20, token_usage: { total_tokens: 8 }, json_repair_count: 0 },
      { case_id: "case-002", prompt_version: "v1", prompt_hash: hash, status: "completed", expected: { web: false, images: true }, actual: { web: false, images: true }, latency_ms: 20, token_usage: { total_tokens: 8 }, json_repair_count: 0 },
      { case_id: "case-001", prompt_version: "v2", prompt_hash: hash, status: "completed", expected: { web: true, images: false }, actual: { web: false, images: false }, latency_ms: 10, token_usage: { total_tokens: 5 }, json_repair_count: 0 },
      { case_id: "case-002", prompt_version: "v2", prompt_hash: hash, status: "failed", expected: { web: false, images: true }, failure_kind: "json_format", error: "invalid json" },
    ],
  });
  assert.equal(score.prompt_comparison[0].prompt_version, "v1");
  assert.equal(score.prompt_comparison[0].exact_match_rate, 1);
  assert.equal(score.prompt_comparison[1].json_error_rate, 0.5);
});

test("stage one keeps transport failures out of JSON error rate", () => {
  const score = scoreStage1({
    schema_version: 1,
    results: [
      { case_id: "case-001", prompt_version: "v1", prompt_hash: hash, status: "failed", expected: { web: true, images: false }, failure_kind: "invocation", error: "quota" },
    ],
  });
  assert.equal(score.prompt_comparison[0].json_error_rate, 0);
  assert.equal(score.prompt_comparison[0].failure_rate, 1);
  assert.equal(score.prompt_comparison[0].failures.invocation, 1);
});

test("stage one preserves token usage from Batch Testing's camelCase bridge fields", () => {
  const score = scoreStage1({
    schema_version: 1,
    results: [
      { case_id: "case-001", prompt_version: "v1", prompt_hash: hash, status: "completed", expected: { web: true, images: false }, actual: { web: true, images: false }, token_usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 } },
    ],
  });
  assert.equal(score.prompt_comparison[0].mean_total_tokens, 9);
});
