import { withOrdinaryInvokeTransport } from "../helpers/invokeRuntime";
import assert from "node:assert/strict";
import test from "node:test";
import { createAnnaPptBackend } from "../../src/api/hostPptBackend.ts";
import type { HostRuntime } from "../../src/runtime/hostRuntime.ts";

function backend(invoke: HostRuntime["tools"]["invoke"]) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __BUNDLED_TOOL_IDS__: { "ppt-engine": "engine" } } });
  return createAnnaPptBackend({ tools: { invoke: withOrdinaryInvokeTransport(invoke) }, llm: { complete: async () => ({}) }, agent: { session: async () => { throw new Error("unused"); } } });
}
const run = { root_dir: "/test/batch", cases: [], padding: "中文😀\\\"".repeat(10_000) };
function upload(value: unknown) {
  return { transport: "host_upload", mime_type: "application/json", url: "https://upload.example/result.json", r2_key: "result", size_bytes: Buffer.byteLength(JSON.stringify(value)) };
}

test("all four batch APIs receive original results through the ordinary transport", async (t) => {
  let current: unknown;
  const calls: string[] = [];
  let caseUpdateArgs: unknown;
  const api = backend(async ({ method, args }) => {
    if (method === "app_update_batch_test_case") caseUpdateArgs = args;
    calls.push(method);
    current = method === "app_create_batch_test_run" ? { run } : method === "app_list_batch_test_runs" ? { runs: [run] } : run;
    return { success: true, data: current };
  });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(current)));
  assert.equal((await api.createBatchTestRun({ cases: [], target_stage: "research-routing-completed" })).run.root_dir, run.root_dir);
  assert.equal((await api.listBatchTestRuns()).runs[0]?.root_dir, run.root_dir);
  const recommendation = { preset: { id: "test", version: 1, name: "Test", description: "Test" }, trace: { low_signal: true } };
  const updated = await api.updateBatchTestCase({ root_dir: run.root_dir, case_id: "case", status: "completed", template_recommendation_result: recommendation as any });
  assert.deepEqual(updated.cases, run.cases);
  assert.deepEqual((caseUpdateArgs as any).template_recommendation_result, recommendation);
  assert.equal((await api.updateBatchTestRun({ root_dir: run.root_dir, status: "completed" })).root_dir, run.root_dir);
  assert.deepEqual(calls, ["app_create_batch_test_run", "app_list_batch_test_runs", "app_update_batch_test_case", "app_update_batch_test_run"]);
});
