import assert from "node:assert/strict";
import test from "node:test";

import { apiError, apiErrorSchema } from "../../src/contracts/errors.ts";

test("api errors preserve messages and add machine-readable fields", () => {
  assert.deepEqual(apiError(400, "bad input"), {
    error: "bad input",
    error_code: "bad_request",
    retryable: false,
  });
  assert.deepEqual(apiError(413, "too large"), {
    error: "too large",
    error_code: "payload_too_large",
    retryable: false,
  });
});

test("retryable errors and details follow the shared schema", () => {
  const rateLimited = apiErrorSchema.parse(apiError(429, "slow down"));
  assert.equal(rateLimited.error_code, "rate_limited");
  assert.equal(rateLimited.retryable, true);

  const unavailable = apiErrorSchema.parse(apiError(503, "queue full", { pending: 50 }));
  assert.equal(unavailable.error_code, "service_unavailable");
  assert.equal(unavailable.retryable, true);
  assert.deepEqual(unavailable.details, { pending: 50 });
});
