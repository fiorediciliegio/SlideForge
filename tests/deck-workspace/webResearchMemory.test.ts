import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import ts from "typescript";

// Execute the actual hook workflow against in-memory state setters, without Host services.
const source = ts.createSourceFile("hook.ts", readFileSync("src/features/deck-workspace/hooks/useDeckWorkspace.ts", "utf8"), ts.ScriptTarget.Latest, true);
const hook = source.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === "useDeckWorkspace")!;
const functions = hook.body!.statements.filter((n) => ts.isFunctionDeclaration(n) && ["resetWebResearchProgress", "runWebResearchBeforeOutline", "retryWebResearch"].includes(n.name!.text));
const code = ts.transpileModule(functions.map((n) => n.getText(source)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(research: (runtime: any) => Promise<void>) {
  const workspace = { workspace_dir: "/work/one", requirements: { research: { web: { enabled: true }, images: { enabled: true } } } };
  const state = { status: "idle", progress: null as any, error: "" };
  const deps = {
    requirementsOperationRef: { current: 1 }, webResearchRunRef: { current: 0 }, currentWorkspaceRef: { current: workspace }, currentWorkspace: workspace,
    backend: { getPageProgress: async () => ({ pages: [] }) }, aiClient: {}, researchWebClient: {}, agentClient: {}, hostUploadClient: {}, aiLogger: {}, locale: "zh", prompt: "Brief",
    t: { webResearch: { errorBody: "研究失败" }, errors: { summaryUnknown: "未知错误" } },
    setWebResearchProgress: (v: any) => { state.progress = v; }, setWebResearchStatus: (v: string) => { state.status = v; }, setWebResearchError: (v: string) => { state.error = v; },
    setLoading: () => {}, setWebResearchErrorDetail: () => {}, setPage: () => {}, setStage: () => {},
    workspaceOutlineForDownstream: () => ({ items: [] }), awaitUploadedSourceAnalysisForOutline: async () => null,
    formatWebResearchRequirements: () => "", runParallelSharedResearch: research,
    summarizeUserFacingError: (_t: any, error: Error) => ({ summary: error.message, detail: "" }),
    createOutlineFromConfirmedRequirements: async () => {}, console: { warn: () => {} },
  };
  const workflow = new Function(...Object.keys(deps), `${code}\nreturn { resetWebResearchProgress, runWebResearchBeforeOutline, retryWebResearch };`)(...Object.values(deps));
  return { state, workspace, workflow };
}

it("retains completed research details independently of deck progress", async () => {
  const progress = { researchDiscovery: { records: [{ report: "Research report", liveRounds: [{ text: "Decision" }] }] } };
  const h = harness(async (runtime) => { runtime.onProgress(progress); });
  await h.workflow.runWebResearchBeforeOutline(h.workspace, false);
  assert.equal(h.state.status, "completed");
  assert.equal(h.state.progress, progress);
});

it("retains partial details on failure and clears them for the next attempt", async () => {
  let attempt = 0;
  const partial = { message: "Collected sources" };
  const h = harness(async (runtime) => {
    if (++attempt === 1) { runtime.onProgress(partial); throw new Error("Search failed"); }
    assert.equal(h.state.progress, null);
    assert.equal(h.state.error, "");
    runtime.onProgress({ message: "Complete" });
  });
  await assert.rejects(h.workflow.runWebResearchBeforeOutline(h.workspace, false), /Search failed/);
  assert.equal(h.state.progress, partial);
  assert.equal(h.state.status, "error");
  await h.workflow.runWebResearchBeforeOutline(h.workspace, true);
  assert.equal(h.state.status, "completed");
});

it("ignores late progress and retry errors after the session is cleared", async () => {
  let runtime: any;
  let reject!: (error: Error) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const h = harness(async (value) => {
    runtime = value;
    started();
    await new Promise<void>((_resolve, fail) => { reject = fail; });
  });
  const pending = h.workflow.retryWebResearch();
  await ready;
  h.workflow.resetWebResearchProgress();
  runtime.onProgress({ message: "Obsolete" });
  assert.equal(runtime.isCancelled(), true);
  reject(new Error("Obsolete failure"));
  await pending;
  assert.deepEqual(h.state, { status: "idle", progress: null, error: "" });
});
