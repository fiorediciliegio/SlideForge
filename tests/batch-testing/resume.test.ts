import assert from "node:assert/strict";
import test from "node:test";

import type { BatchTestRunRecord } from "../../src/api/types.ts";
import { assertBatchTestResumeCompatible } from "../../src/features/batch-testing/resume.ts";
import type { BatchTestInput } from "../../src/features/batch-testing/types.ts";

const input: BatchTestInput = {
  test_id: "routing-eval",
  target_stage: "research-routing-completed",
  briefs: [{ id: "brief-001", brief: "Evaluate this brief" }],
  research_routing: {
    git_commit: "0123456789abcdef",
    requested_model: null,
    prompts: [{ prompt_version: "v1", prompt: "Prompt body", prompt_hash: "a".repeat(64) }],
    expected_by_brief_id: { "brief-001": { web: true, images: false } },
  },
};

function run(): BatchTestRunRecord {
  return {
    version: 1,
    test_id: "routing-eval",
    target_stage: "research-routing-completed",
    status: "partial_failure",
    root_dir: "E:\\test\\routing-eval",
    manifest_path: "E:\\test\\routing-eval\\batch-test.json",
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    research_routing_run_signature: JSON.stringify(["0123456789abcdef", null]),
    research_routing_cases_fingerprint: "3f78f11d",
    cases: [{
      case_id: "brief-001-v1-001",
      brief_id: "brief-001",
      brief: "Evaluate this brief",
      repetition: 1,
      total_repetitions: 1,
      research_routing_signature: `${"a".repeat(64)}|10`,
      status: "completed",
      case_dir: "E:\\test\\routing-eval\\brief-001-v1-001",
      workspace_dir: "E:\\test\\routing-eval\\brief-001-v1-001\\workspace\\ppt-1",
      workspace_id: "ppt-1",
      performance_dir: "E:\\test\\routing-eval\\brief-001-v1-001\\performance",
      started_at: null,
      ended_at: null,
      error: null,
      pptx_path: null,
    }],
  };
}

test("accepts an interrupted run only when the imported experiment is identical", () => {
  assert.equal(assertBatchTestResumeCompatible(input, run(), "en").length, 1);
  const changed = structuredClone(input);
  changed.research_routing!.prompts[0].prompt_hash = "b".repeat(64);
  assert.throws(() => assertBatchTestResumeCompatible(changed, run(), "en"), /resume cases/);
});

test("does not require research-routing identity for an ordinary image-research run", () => {
  const ordinaryInput: BatchTestInput = {
    test_id: "image-eval",
    target_stage: "image-research-completed",
    briefs: [{ id: "brief-001", brief: "Evaluate image research" }],
  };
  const ordinaryRun: BatchTestRunRecord = {
    version: 1,
    test_id: "image-eval",
    target_stage: "image-research-completed",
    status: "partial_failure",
    root_dir: "E:\\test\\image-eval",
    manifest_path: "E:\\test\\image-eval\\batch-test.json",
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    cases: [{
      case_id: "brief-001-001",
      brief_id: "brief-001",
      brief: "Evaluate image research",
      repetition: 1,
      total_repetitions: 1,
      status: "failed",
      case_dir: "E:\\test\\image-eval\\brief-001-001",
      workspace_dir: "E:\\test\\image-eval\\brief-001-001\\workspace\\ppt-1",
      workspace_id: "ppt-1",
      performance_dir: "E:\\test\\image-eval\\brief-001-001\\performance",
      started_at: null,
      ended_at: null,
      error: "interrupted",
      pptx_path: null,
    }],
  };
  assert.equal(assertBatchTestResumeCompatible(ordinaryInput, ordinaryRun, "en").length, 1);
});
