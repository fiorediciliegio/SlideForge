import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import test from "node:test";

import { FixedWindowRateLimiter, HttpRequestError, readJsonBody } from "../../src/server/httpSecurity.ts";

function request(...chunks: Buffer[]): IncomingMessage {
  return Readable.from(chunks) as IncomingMessage;
}

test("readJsonBody parses objects and rejects malformed JSON", async () => {
  assert.deepEqual(await readJsonBody(request(Buffer.from('{"brief":"hello"}')), 100), { brief: "hello" });
  await assert.rejects(() => readJsonBody(request(Buffer.from("[]")), 100), (error: unknown) => {
    return error instanceof HttpRequestError && error.status === 400;
  });
});

test("readJsonBody stops requests above the byte limit", async () => {
  await assert.rejects(
    () => readJsonBody(request(Buffer.from("12345"), Buffer.from("67890")), 8),
    (error: unknown) => error instanceof HttpRequestError && error.status === 413,
  );
});

test("fixed window limiter isolates identities and recovers after the window", () => {
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter(2, 60_000, () => now);
  assert.equal(limiter.consume("a").allowed, true);
  assert.equal(limiter.consume("a").allowed, true);
  const blocked = limiter.consume("a");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
  assert.equal(limiter.consume("b").allowed, true);
  now += 60_001;
  assert.equal(limiter.consume("a").allowed, true);
});
