import assert from "node:assert/strict";
import test from "node:test";
import { isDiagnosticLoggingEnabled } from "../../src/runtime/diagnosticLogging.ts";

test("only the explicit build setting true enables diagnostics", () => {
  assert.equal(isDiagnosticLoggingEnabled("true"), true);
  for (const value of [undefined, null, "false", "", "TRUE", "1", true, 1]) {
    assert.equal(isDiagnosticLoggingEnabled(value), false);
  }
});
