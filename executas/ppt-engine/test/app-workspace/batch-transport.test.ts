import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");

test("batch endpoints return original data and leave large payloads to the unified transport", async () => {
  const run = {
    target_stage: "research-routing-completed",
    cases: Array.from({ length: 50 }, (_, i) => ({
      case_id: `case-${i}`, status: "completed", workspace_id: `workspace-${i}`,
      performance_metrics: [{ operation_name: "任务性能😀".repeat(350), count: 1 }],
    })),
  };
  let receivedCases: unknown;
  let updateArgs: any;
  const code = source.slice(source.indexOf("async function toolAppCreateBatchTestRun("), source.indexOf("\nasync function toolAppDeleteBatchTestRun("));
  const api = new Function("run", "createAppBatchTestRun", "captureUpdate", `
    const listAppBatchTestRuns = async () => ({runs: [run]});
    const updateAppBatchTestCase = async (args) => { captureUpdate(args); return run; };
    const updateAppBatchTestRun = async () => run;
    const readRequiredAbsolutePathArg = (args, key) => args[key];
    ${code}
    return { create: toolAppCreateBatchTestRun, list: toolAppListBatchTestRuns, update: toolAppUpdateBatchTestCase, finish: toolAppUpdateBatchTestRun };
  `)(run, async (input: any) => { receivedCases = input.cases; return { run }; }, (args: any) => { updateArgs = args; });
  const cases = [{ title: "中文", brief: "原始业务输入" }];
  const created = await api.create({ cases, target_stage: run.target_stage });
  assert.equal(receivedCases, cases);
  const listed = await api.list({});
  const recommendation = { preset: { id: "test" }, trace: { low_signal: true } };
  const updated = await api.update({ root_dir: "/test", status: "completed", template_recommendation_result: recommendation });
  assert.deepEqual(updateArgs.template_recommendation_result, recommendation);
  const finished = await api.finish({ root_dir: "/test", status: "completed" });
  for (const value of [created.run, listed.runs[0], updated, finished]) {
    assert.deepEqual(value.cases[17].performance_metrics, run.cases[17].performance_metrics);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) > 48 * 1024);
    assert.equal(value.result_upload, undefined);
  }
});
