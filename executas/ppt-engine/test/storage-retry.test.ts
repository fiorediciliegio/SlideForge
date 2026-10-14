import assert from "node:assert/strict";
import test from "node:test";

import {
  assertStorageResponseOk,
  classifyHostUploadAware,
  classifyStorageError,
  runWithStorageRetry,
  StorageHttpError,
} from "../storage-retry.js";

test("storage retry reruns transient failures with bounded backoff", async () => {
  let attempts = 0;
  const delays: number[] = [];

  const result = await runWithStorageRetry(async ({ attempt }) => {
    attempts += 1;
    if (attempt < 3) {
      throw new StorageHttpError({ status: 503, message: "temporary storage failure" });
    }
    return "ok";
  }, {
    baseDelayMs: 10,
    maxDelayMs: 100,
    jitterRatio: 0,
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("storage retry does not retry deterministic errors", async () => {
  let attempts = 0;
  await assert.rejects(
    runWithStorageRetry(async () => {
      attempts += 1;
      throw new StorageHttpError({ status: 403, message: "forbidden" });
    }, { sleep: async () => undefined }),
    /forbidden/,
  );
  assert.equal(attempts, 1);
  assert.equal(classifyStorageError(new StorageHttpError({ status: 500, message: "InternalError" })).retryable, true);
});

test("HTTP response errors preserve provider code and Retry-After", async () => {
  await assert.rejects(
    assertStorageResponseOk({
      ok: false,
      status: 500,
      headers: { get: (name: string) => name === "retry-after" ? "2" : null },
      text: async () => "<Code>InternalError</Code>",
    }, "upload failed"),
    (error: unknown) => {
      assert.ok(error instanceof StorageHttpError);
      assert.equal(error.status, 500);
      assert.equal(error.providerCode, "InternalError");
      assert.equal(error.retryAfterMs, 2_000);
      return true;
    },
  );
});

test("classifyHostUploadAware retries bridge-wrapped RPC failures", () => {
  // Bridge upstream failure wrapped as JSON-RPC error: neither TypeError nor a
  // retryable code — must still be retried (the "instant failure" fix).
  const wrapped = new Error("fetch failed");
  wrapped.name = "HostUploadError";
  (wrapped as { code?: number }).code = -32603;
  const decision = classifyHostUploadAware(wrapped);
  assert.equal(decision.retryable, true);
  assert.equal(decision.reason, "host_upload_rpc_transient");

  // Deterministic rules still win for HostUploadError (permission denied).
  const denied = new Error("permission denied");
  denied.name = "HostUploadError";
  assert.equal(classifyHostUploadAware(denied).retryable, false);

  // Regression guard: direct TypeError stays retryable, plain unknown errors stay non-retryable.
  assert.equal(classifyHostUploadAware(new TypeError("fetch failed")).retryable, true);
  assert.equal(classifyHostUploadAware(new Error("boom")).retryable, false);

  // runWithStorageRetry honours the injected classifier end to end.
  let attempts = 0;
  return runWithStorageRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw wrapped;
    return "ok";
  }, {
    classify: classifyHostUploadAware,
    sleep: async () => undefined,
  }).then((result) => {
    assert.equal(result, "ok");
    assert.equal(attempts, 3);
  });
});
