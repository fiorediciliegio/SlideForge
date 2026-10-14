import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { snapshotUploadBackoffMs } from "../../src/features/deck-workspace/snapshotUploadRetry.ts";

describe("snapshotUploadBackoffMs", () => {
  it("grows with the retry count and caps at 10 seconds", () => {
    assert.equal(snapshotUploadBackoffMs(1), 1500);
    assert.ok(snapshotUploadBackoffMs(2) > snapshotUploadBackoffMs(1));
    assert.equal(snapshotUploadBackoffMs(100), 10_000);
  });
});
