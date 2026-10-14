import assert from "node:assert/strict";
import test from "node:test";

import type { BatchTestCaseInput, HostUploadRef } from "../../src/api/types.ts";
import type { AppHostUploadClient } from "../../src/runtime/appHostUploadClient.ts";
import { prepareBatchTestRunCreationInput } from "../../src/features/batch-testing/createRunInput.ts";

const uploadRef: HostUploadRef = {
  transport: "host_upload",
  r2_key: "batch-test/input.json",
  url: "https://uploads.example/batch-test/input.json",
  mime_type: "application/json",
  size_bytes: 1,
  filename: "batch-test-input.json",
};

function input(targetStage: "pptx-exported" | "research-routing-completed") {
  return {
    target_stage: targetStage,
    briefs: [{ brief: "测试 Brief" }],
  };
}

function client(uploaded: File[]): AppHostUploadClient {
  return {
    uploadFile: async (file) => {
      uploaded.push(file);
      return uploadRef;
    },
  };
}

test("keeps small Batch inputs inline", async () => {
  const uploaded: File[] = [];
  const cases: BatchTestCaseInput[] = [{
    case_id: "brief-001-001",
    brief_id: "brief-001",
    brief: "测试 Brief",
    repetition: 1,
    total_repetitions: 1,
  }];

  const result = await prepareBatchTestRunCreationInput(
    input("pptx-exported"),
    cases,
  );

  assert.deepEqual(result, {
    target_stage: "pptx-exported",
    cases,
  });
  assert.equal(uploaded.length, 0);
});

test("keeps large Batch inputs as original cases for the common invoke transport", async () => {
  const uploaded: File[] = [];
  const cases: BatchTestCaseInput[] = [{
    case_id: "brief-001-001",
    brief_id: "brief-001",
    brief: "x".repeat(50_000),
    repetition: 1,
    total_repetitions: 1,
  }];

  const result = await prepareBatchTestRunCreationInput(
    input("research-routing-completed"),
    cases,
  );

  assert.deepEqual(result, { target_stage: "research-routing-completed", cases });
  assert.equal(uploaded.length, 0);
});
