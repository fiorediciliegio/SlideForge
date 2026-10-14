import { readFileSync } from "node:fs";
import ts from "typescript";
import type { DeckReviewRenderState } from "../../src/features/deck-workspace/types";
import { withOutlineTitles, reconcileReviewRender } from "../../src/features/deck-workspace/reviewRenderReconciliation";
import { createWorkspaceReviewRenderKey } from "../../src/features/deck-workspace/workspaceReviewRenderKey";
import { normalizeWorkspacePageProgress } from "../../src/features/deck-workspace/workspaceRecovery";
import { assembleReviewRender } from "../../src/features/deck-workspace/reviewRenderAssembly";
import { pageAdoptionFixture } from "./pageAdoption";

// Run the actual hook functions with in-memory state, without connecting to Host.
const source = ts.createSourceFile("hook.ts", readFileSync("src/features/deck-workspace/hooks/useDeckWorkspace.ts", "utf8"), ts.ScriptTarget.Latest, true);
const hook = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "useDeckWorkspace")!;
const functionNames = ["workspaceOutlineToState", "applyRenderedDeck", "applyWorkspace", "loadDeckHtmlForWorkspace", "applyAdoptedPage", "captureReviewResultGuard", "returnToDeckPage", "publishDeckResult", "applyManualPageUpdate", "exitManualEditor", "renderDeckHtmlForWorkspace", "applyDeckGenerationCompletion", "refineSlide"];
const functions = hook.body!.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && functionNames.includes(node.name!.text));
const code = ts.transpileModule(functions.map((node) => node.getText(source)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export function deckResultHarness(workspaceDir = "/page-adoption") {
  const fixture = pageAdoptionFixture(workspaceDir);
  const review: DeckReviewRenderState = { status: "ready", result: fixture.rendered, error: "",
    renderKey: createWorkspaceReviewRenderKey(fixture.workspace) };
  const state: Record<string, any> = { currentSlide: 8, reviewRender: review, currentWorkspace: fixture.workspace,
    deck: fixture.outline.items.map((item) => ({ title: item.title, subtitle: "" })), page: "main", stage: "deck", history: ["main"] };
  const reviewRenderRef = { current: review };
  const currentWorkspaceRef = { current: fixture.workspace };
  const events: Array<{ name: string; value: any }> = [];
  const calls: string[] = [];
  const backend = {
    openWorkspace: async () => { calls.push("open"); return fixture.nextWorkspace; },
    renderDeckHtml: async () => { calls.push("render"); return {}; },
    listWorkspaces: async () => ({}),
    cleanupGenerationRun: async () => {},
    getRenderedDeckHtml: async () => { calls.push("metadata"); return fixture.metadata; },
  };
  const setters = Object.fromEntries([...new Set(code.match(/\bset[A-Z]\w*/g))].map((name) => {
    const key = name[3].toLowerCase() + name.slice(4);
    return [name, (value: any) => {
      state[key] = typeof value === "function" ? value(state[key]) : value;
      events.push({ name, value: state[key] });
      if (key === "reviewRender") reviewRenderRef.current = state[key];
      if (key === "currentWorkspace") currentWorkspaceRef.current = state[key];
    }];
  }));
  const deps = { ...setters, currentWorkspaceRef, reviewRenderRef, backend, reviewLoadRequestRef: { current: 0 }, reviewPublicationRef: { current: 0 },
    currentWorkspace: fixture.workspace, currentSlide: 8, deck: state.deck,
    aiClient: {}, researchWebClient: {}, agentClient: {}, hostUploadClient: {}, aiLogger: {},
    beginPerformanceSpan: () => null, beginCancellableGeneration: () => new AbortController().signal,
    resetGenerationProgress: () => {}, showRefinementLoadingPreviews: () => {},
    workspaceOutlineForDownstream: (workspace: any) => workspace.outline,
    refreshCurrentWorkspaceSnapshot: async () => fixture.workspace,
    prepareShadowGenerationRun: async () => ({ workspace: fixture.workspace, transaction: {
      run_id: "test-run", official_workspace_dir: fixture.workspace.workspace_dir, shadow_workspace_dir: "/shadow",
    } }),
    measurePerformanceOperation: (_name: string, _workspace: string, run: () => Promise<unknown>) => run(),
    refine: async (_input: any): Promise<any> => ({ status: "completed", result: {
      rendered: fixture.metadata, outline: fixture.outline, progress: fixture.nextProgress,
    } }),
    runDeckRefinement: (input: any) => deps.refine(input), generationProgressHandler: () => () => {},
    ownsGenerationOperation: () => true, cancelCreateDeckRef: { current: false },
    commit: async () => ({ workspace: fixture.nextWorkspace }),
    commitShadowGenerationRun: () => deps.commit(), rebaseCompletion: (value: unknown) => value,
    releaseGenerationPagePreviewHolds: () => {}, finishActiveGenerationRun: async () => {},
    waitForFinalDeckRender: async () => fixture.nextProgress, showToast: () => {},
    generationPagePreviewsRef: { current: {} }, withOutlineTitles, reconcileReviewRender,
    normalizeWorkspacePageProgress, workspaceReviewRenderKey: createWorkspaceReviewRenderKey,
    assembleMeasuredReviewRender: (input: any) => deps.assemble(input), assemble: assembleReviewRender, cloneOutlineItems: structuredClone,
    readWorkspaceExportArtifactPath: () => null, exportInFlightRef: { current: false },
    normalizeSlideAspectRatio: () => "16:9", getWorkspaceTitle: () => "测试演示", isWorkspaceDeckStale: () => false,
    completedDeckIsAvailable: () => true, restoreDeckGenerationProgress: () => null,
    requirementsOwnedRecoveryStage: () => null, workspaceContextRowsToState: () => ({ shouldSync: false, rows: [] }),
    pickLocale: (_locale: string, values: Record<string, string>) => values.zh, locale: "zh",
    DEFAULT_TEMPLATE_GROUP_ID: "test", t: { review: { renderFailed: "预览加载失败" }, status: { slideRefined: "完成", refiningSlide: "优化中" } },
  };
  const workflow = new Function(...Object.keys(deps), `${code}; return { ${functionNames.join(",")} };`)(...Object.values(deps));
  return { fixture, state, calls, events, backend, currentWorkspaceRef, reviewRenderRef, workflow, deps };
}
