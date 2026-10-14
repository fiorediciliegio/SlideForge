import assert from "node:assert/strict";
import test from "node:test";

import type { BatchTestRunRecord } from "../../src/api/types.ts";
import { formatBatchTestDate, formatBatchTestDuration } from "../../src/features/batch-testing/runTiming.ts";

function run(overrides: Partial<BatchTestRunRecord> = {}): BatchTestRunRecord {
  return {
    version: 1,
    test_id: "batch-test",
    target_stage: "requirements-confirmed",
    status: "running",
    root_dir: "/tmp/batch-test",
    manifest_path: "/tmp/batch-test/batch-test.json",
    created_at: "2026-08-22T00:00:00.000Z",
    started_at: "2026-08-22T00:01:00.000Z",
    ended_at: null,
    updated_at: "2026-08-22T00:02:00.000Z",
    cases: [],
    ...overrides,
  };
}

test("running batch tests have no completion time and use the current time for duration", () => {
  const current = Date.parse("2026-08-22T00:03:05.000Z");
  assert.equal(formatBatchTestDate(run().ended_at, "zh"), "-");
  assert.equal(formatBatchTestDuration(run(), current), "2m 5s");
});

test("terminal batch tests use ended_at instead of updated_at", () => {
  const completed = run({
    status: "completed",
    ended_at: "2026-08-22T00:04:00.000Z",
    updated_at: "2026-08-22T00:04:30.000Z",
  });
  assert.equal(formatBatchTestDuration(completed), "3m 0s");
  assert.match(formatBatchTestDate(completed.ended_at, "zh"), /2026/);
});
