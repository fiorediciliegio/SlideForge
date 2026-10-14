import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import type { BatchTestWorkflowDependencies } from "../../src/features/batch-testing/workflow.ts";
import { expandBatchTestInput } from "../../src/features/batch-testing/input.ts";
import type { BatchTestInput } from "../../src/features/batch-testing/types.ts";
import type { BatchTestRunRecord } from "../../src/api/types.ts";

// This test exercises the classifier route, which never selects visual presets.
// Supply Vite's asset-glob hook only while loading that unrelated catalog in Node.
const hooks = registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  return url.endsWith("/templates/visualStylePresets.ts")
    ? { ...result, source: `import.meta.glob = () => ({});\n${result.source}` }
    : result;
} });
const { runBatchTestWorkflow } = await import("../../src/features/batch-testing/workflow.ts");
hooks.deregister();

function scenario(mode: "lost-success" | "failure-write" | "success-write" | "offline") {
  const input: BatchTestInput = {
    test_id: "recovery-test", target_stage: "page-refinement-classification-completed",
    briefs: [{ brief: "first" }, { brief: "second" }],
    page_refinement_classification: { git_commit: "a".repeat(40), prompts: [{ prompt_version: "v1", prompt: "Classify", prompt_hash: "b".repeat(64) }] },
  };
  const cases = expandBatchTestInput(input, "en").map((item) => ({
    ...item, status: "pending", workspace_id: item.case_id, workspace_dir: `/test/${item.case_id}`, case_dir: `/test/${item.case_id}`, performance_dir: `/test/${item.case_id}/performance`,
  }));
  const stored = { test_id: input.test_id, target_stage: input.target_stage, root_dir: "/test/recovery-test", status: "queued", cases } as unknown as BatchTestRunRecord;
  const writes: string[] = [];
  const progress: Array<[string | null, string]> = [];
  let executions = 0;
  let offline = false;
  const copy = () => structuredClone(stored);
  const deps = {
    locale: "en", appVersion: "test", signal: new AbortController().signal, aiLogger: null,
    onRun: () => {}, onProgress: (id: string | null, step: string) => progress.push([id, step]),
    backend: {
      listPerformanceRuns: async () => ({ active_run: null }),
      createBatchTestRun: async () => ({ run: copy() }),
      listBatchTestRuns: async () => { if (offline) throw new Error("offline"); return { runs: [copy()] }; },
      updateBatchTestRun: async ({ status }: { status: BatchTestRunRecord["status"] }) => { if (offline) throw new Error("offline"); stored.status = status; return copy(); },
      updateBatchTestCase: async (update: any) => {
        writes.push(update.status);
        const item = stored.cases.find((c) => c.case_id === update.case_id)!;
        if ((mode === "failure-write" && update.status === "failed") || (mode === "success-write" && update.status === "completed")) throw new Error("write failed");
        Object.assign(item, update);
        if (mode === "offline" && update.status === "completed") { offline = true; throw new Error("offline"); }
        if (mode === "lost-success" && update.status === "completed") throw new Error("response download failed after commit");
        return copy();
      },
      startPerformanceRun: async () => ({ run_id: "perf" }),
      finalizePerformanceRun: async () => ({ run: { status: "completed", report_available: true } }),
      materializePerformanceRun: async () => ({ files: ["/test/report.html"] }),
    },
    pageRefinementClassifier: { classifyForEvaluation: async () => {
      executions += 1;
      if (mode === "failure-write") throw new Error("model failed");
      return { classification: { task_type: "exact_text_edit", execution_scope: "local", web_research: false, image_research: false, reason: "Edit" }, actual_model: "test", latency_ms: 1, token_usage: null, json_repair_count: 0, retry_count: 0, retry_reasons: [] };
    } },
  } as unknown as BatchTestWorkflowDependencies;
  return { input, deps, stored, writes, progress, executions: () => executions };
}

test("lost success responses recover from persisted cases and continue the batch", async () => {
  const s = scenario("lost-success");
  const result = await runBatchTestWorkflow(s.input, s.deps);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.cases.map((item) => item.status), ["completed", "completed"]);
  assert.equal(s.executions(), 2);
  assert.ok(!s.writes.includes("failed"));
  assert.deepEqual(s.progress.at(-1), [null, ""]);
});

for (const mode of ["failure-write", "success-write"] as const) {
  test(`${mode} stops the loop and finalizes the batch instead of leaving running`, async () => {
    const s = scenario(mode);
    await assert.rejects(runBatchTestWorkflow(s.input, s.deps), /write failed/);
    assert.equal(s.stored.status, "failed");
    assert.equal(s.executions(), 1);
    assert.equal(s.stored.cases[1]?.status, "pending");
    if (mode === "success-write") assert.ok(!s.writes.includes("failed"));
    assert.deepEqual(s.progress.at(-1), [null, ""]);
  });
}

test("unreachable storage reports an unconfirmed final state without overwriting success", async () => {
  const s = scenario("offline");
  await assert.rejects(runBatchTestWorkflow(s.input, s.deps), /final status could not be confirmed/);
  assert.equal(s.stored.cases[0]?.status, "completed");
  assert.ok(!s.writes.includes("failed"));
  assert.deepEqual(s.progress.at(-1), [null, ""]);
});
