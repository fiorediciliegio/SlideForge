import assert from "node:assert/strict";
import test from "node:test";

test("three fingerprints distinguish equality, each side ahead, divergence, and missing baseline", async () => {
  const { classifyWorkspaceSnapshotReconcile } = await import("../../src/app-workspace/snapshot-sync.ts");
  const classify = (local: string | null, baseline: string | null, remote: string | null) =>
    classifyWorkspaceSnapshotReconcile({
      local_source_sha256: local,
      baseline_source_sha256: baseline,
      remote_source_sha256: remote,
    });

  assert.equal(classify("N", "N", "N"), "in_sync");
  assert.equal(classify("N", "N", "N+1"), "cloud_ahead");
  assert.equal(classify("N+1", "N", "N"), "local_ahead");
  assert.equal(classify("N+1-local", "N", "N+1-cloud"), "diverged");
  assert.equal(classify("N+1", null, "N"), "baseline_missing");
  assert.equal(classify("N+1", "N", null), "baseline_missing");
});
