import assert from "node:assert/strict";
import test from "node:test";
import { isDiagnosticLoggingEnabled, runWithDiagnosticLogging } from "../src/diagnostic-logging.ts";

test("concurrent calls and deferred child jobs retain their diagnostic setting", async () => {
  assert.equal(isDiagnosticLoggingEnabled(), false);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const enabled = runWithDiagnosticLogging(true, async () => {
    await gate;
    assert.equal(isDiagnosticLoggingEnabled(), true);
    await new Promise<void>((resolve) => setImmediate(() => {
      assert.equal(isDiagnosticLoggingEnabled(), true);
      resolve();
    }));
  });
  await runWithDiagnosticLogging(false, async () => {
    release();
    await enabled;
    assert.equal(isDiagnosticLoggingEnabled(), false);
  });
  assert.equal(isDiagnosticLoggingEnabled(), false);
});
