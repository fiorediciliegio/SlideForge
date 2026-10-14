import assert from "node:assert/strict";
import { test } from "node:test";
import { createPreviewPreparationQueue } from "../../src/features/deck-workspace/previewPreparationQueue.ts";

test("visible preview preparation has a shared limit, cancels queued work and releases once", () => {
  const queue = createPreviewPreparationQueue(2);
  const starts: number[] = [];
  const releases: Array<() => void> = [];
  const cancel = Array.from({ length: 5 }, (_, index) => queue((release) => { starts.push(index); releases[index] = release; }));
  assert.deepEqual(starts, [0, 1]);
  cancel[2]();
  releases[1](); releases[1]();
  assert.deepEqual(starts, [0, 1, 3]);
  releases[0]();
  assert.deepEqual(starts, [0, 1, 3, 4]);
});
