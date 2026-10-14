import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { scoreStage2 } from "../src/stage2.mjs";

const hash = createHash("sha256").update("prompt").digest("hex");

test("stage two groups comparisons by Anna actual model and detects flaky cases", () => {
  const score = scoreStage2([{
    schema_version: 1,
    run_id: "model-a",
    results: [
      { case_id: "case-001", prompt_version: "v1", prompt_hash: hash, status: "completed", expected: { web: true, images: false }, actual: { web: true, images: false }, requested_model: "Local A", actual_model: "anna-a", latency_ms: 10, token_usage: { total_tokens: 1 }, json_repair_count: 0 },
      { case_id: "case-001", prompt_version: "v1", prompt_hash: hash, status: "completed", expected: { web: true, images: false }, actual: { web: false, images: false }, requested_model: "Local A", actual_model: "anna-a", latency_ms: 10, token_usage: { total_tokens: 1 }, json_repair_count: 0 },
      { case_id: "case-001", prompt_version: "v1", prompt_hash: hash, status: "completed", expected: { web: true, images: false }, actual: { web: true, images: false }, requested_model: "Local B", actual_model: "anna-b", latency_ms: 10, token_usage: { total_tokens: 1 }, json_repair_count: 0 },
    ],
  }]);
  assert.equal(score.prompt_model_comparison.length, 2);
  assert.equal(score.stability.flaky_cases.length, 1);
  assert.equal(score.model_disagreements.length, 1);
  assert.deepEqual(score.model_disagreements[0].expected, { web: true, images: false });
  assert.equal(score.cross_model_agreement.summaries[0].all_models_completed, 1);
  assert.equal(score.cross_model_agreement.summaries[0].exact_agreement, 0);
});
