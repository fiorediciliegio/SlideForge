import assert from "node:assert/strict";
import test from "node:test";

import { AsyncJobQueue, QueueFullError } from "../../src/server/jobQueue.ts";

test("queue enforces concurrency and drains pending tasks", async () => {
  const queue = new AsyncJobQueue(2, 3);
  let active = 0;
  let maximumActive = 0;
  let completed = 0;
  const task = async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    completed++;
  };
  for (let index = 0; index < 5; index++) queue.enqueue(task);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(maximumActive, 2);
  assert.equal(completed, 5);
  assert.deepEqual(queue.stats, { active: 0, pending: 0, concurrency: 2, maxPending: 3 });
});

test("queue rejects excess pending work instead of growing without bound", async () => {
  const queue = new AsyncJobQueue(1, 1);
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  queue.enqueue(() => blocked);
  queue.enqueue(async () => undefined);
  assert.throws(() => queue.enqueue(async () => undefined), QueueFullError);
  release();
  await blocked;
});

test("submit returns operation results and propagates failures", async () => {
  const queue = new AsyncJobQueue(1, 1);
  assert.equal(await queue.submit(async () => 42), 42);
  await assert.rejects(() => queue.submit(async () => { throw new Error("failed"); }), /failed/);
  assert.equal(queue.stats.active, 0);
});
