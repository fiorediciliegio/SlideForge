import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  guardStreamLiveness,
  StreamCancelledError,
  StreamIdleTimeoutError,
} from "../../src/agent/streamLivenessGuard.ts";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

describe("Stream Liveness Guard", () => {
  it("passes through a normal stream", async () => {
    async function* stream() {
      yield "a";
      yield "b";
    }

    assert.deepEqual(
      await collect(guardStreamLiveness(stream(), { idleMs: 25 })),
      ["a", "b"],
    );
  });

  it("throws a typed idle timeout when no frame arrives", async () => {
    async function* stream() {
      await new Promise(() => undefined);
    }

    await assert.rejects(
      () => collect(guardStreamLiveness(stream(), { idleMs: 5 })),
      StreamIdleTimeoutError,
    );
  });

  it("resets the idle timer after each frame", async () => {
    async function* stream() {
      await wait(3);
      yield "a";
      await wait(3);
      yield "b";
    }

    assert.deepEqual(
      await collect(guardStreamLiveness(stream(), { idleMs: 20 })),
      ["a", "b"],
    );
  });

  it("throws a typed cancellation error and calls iterator return", async () => {
    let returned = false;
    const controller = new AbortController();
    const stream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<string>>(() => undefined),
          return: async () => {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };

    const result = collect(guardStreamLiveness(stream, { idleMs: 100, signal: controller.signal }));
    controller.abort();

    await assert.rejects(() => result, StreamCancelledError);
    assert.equal(returned, true);
  });
});

for (const cleanupMode of ["resolved", "pending", "throw", "reject"] as const) {
  it(`forwards early break exactly once with ${cleanupMode} return`, async () => {
    let returned = 0;
    let nextCalls = 0;
    const states: string[] = [];
    const stream: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => { nextCalls += 1; return { done: false, value: 1 }; },
        return: () => {
          returned += 1;
          if (cleanupMode === "throw") throw new Error("cleanup failed");
          if (cleanupMode === "reject") return Promise.reject(new Error("cleanup failed"));
          if (cleanupMode === "pending") return new Promise(() => {});
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
    for await (const value of guardStreamLiveness(stream, { idleMs: 30, onCleanup: (state) => states.push(state) })) {
      assert.equal(value, 1);
      break;
    }
    await Promise.resolve();
    assert.equal(returned, 1);
    assert.equal(nextCalls, 1);
    assert.equal(states[0], "requested");
    assert.equal(states.at(-1), cleanupMode === "pending" ? "requested" : cleanupMode === "resolved" ? "resolved" : "rejected");
  });
}

it("does not call return after natural exhaustion", async () => {
  let returned = 0;
  let done = 0;
  await collect(guardStreamLiveness({
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true, value: undefined }),
      return: async () => { returned += 1; return { done: true, value: undefined }; },
    }),
  }, { idleMs: 30, onIteratorDone: () => { done += 1; } }));
  assert.equal(returned, 0);
  assert.equal(done, 1);
});

it("does not let a throwing return replace the idle error", async () => {
  let returned = 0;
  await assert.rejects(collect(guardStreamLiveness({
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise(() => {}),
      return: () => { returned += 1; throw new Error("cleanup failed"); },
    }),
  }, { idleMs: 5 })), StreamIdleTimeoutError);
  assert.equal(returned, 1);
});
