import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { deckResultHarness } from "../helpers/deckResults";

// Follow the existing hook-workflow harness: execute production callbacks with
// in-memory state and delayed backend operations, without a Host or browser.
function callbacks(file: string, component: string, names: string[]) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === component)!;
  const selected = fn.body!.statements.filter((node) =>
    ts.isFunctionDeclaration(node) ? names.includes(node.name!.text)
      : ts.isVariableStatement(node) && node.declarationList.declarations.some((decl) => names.includes(decl.name.getText(source))));
  return ts.transpileModule(selected.map((node) => node.getText(source)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
const saveCode = callbacks("src/features/manual-page-editor/ManualPageEditorShell.tsx", "ManualPageEditorShell", ["saveAll", "requestSwitch", "requestExit", "resolveConfirm", "reloadLatest"]);

function harness(performSave: () => Promise<boolean>, saveStashedPages: () => Promise<boolean>) {
  const state = { saving: false, status: "unsaved", html: "原文", exits: 0, exitArguments: [] as unknown[][], pages: [] as number[] };
  const saveRequestRef = { current: null as Promise<boolean> | null };
  const pendingPageIndexRef = { current: null as number | null };
  const deps = {
    useCallback: (callback: unknown) => callback, saveRequestRef, pendingPageIndexRef,
    navigatingRef: { current: false }, savedSnapshotRef: { current: "原文" },
    loading: false, pageIndex: 0, page: { pageId: "a" }, context: { revision: 1 },
    dirtyPagesRef: { current: new Map() }, setDirtyStashCount: () => {},
    setSavingAll: (value: boolean) => { state.saving = value; }, setError: () => {},
    setSaveStatus: (value: string) => { state.status = value; },
    currentHtml: () => state.html, performSave, saveStashedPages, setConflictPageId: () => {},
    conflictPageId: "b", pageCacheRef: { current: new Map() },
    iframeRef: { current: null }, finishSvgTextRef: { current: () => {} }, finishCropRef: { current: () => false },
    hasUnsavedChanges: () => state.html !== "原文",
    props: { workspaceDir: "/workspace", pages: [{ pageId: "a" }, { pageId: "b" }], onExit: (...args: unknown[]) => { state.exits++; state.exitArguments.push(args); } }, deckRenderRequiredRef: { current: false },
    confirm: { kind: "exit" }, setConfirm: () => {}, restore: async () => {},
    loadPage: async (index: number) => { state.pages.push(index); },
  };
  const flow = new Function(...Object.keys(deps), `${saveCode}\nreturn { saveAll, requestSwitch, requestExit, resolveConfirm, reloadLatest };`)(...Object.values(deps));
  return { flow, state, saveRequestRef, pendingPageIndexRef, deps };
}

test("整次保存共享请求，其他页尚未完成时不能切页、退出或放弃草稿", async () => {
  let currentSaves = 0; let stashedSaves = 0;
  let release!: () => void;
  const barrier = new Promise<boolean>((resolve) => { release = () => resolve(true); });
  const h = harness(async () => { currentSaves++; return true; }, async () => { stashedSaves++; return barrier; });
  const first = h.flow.saveAll();
  assert.equal(h.flow.saveAll("shortcut"), first);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(currentSaves, 1); assert.equal(stashedSaves, 1);
  assert.equal(h.flow.saveAll(), first);
  assert.equal(h.state.saving, true);
  await h.flow.requestSwitch(1); await h.flow.requestSwitch(2);
  h.flow.requestExit(); await h.flow.resolveConfirm("discard");
  assert.deepEqual(h.state.pages, []); assert.equal(h.state.exits, 0);
  assert.equal(h.pendingPageIndexRef.current, 2);
  release(); assert.equal(await first, true);
  assert.equal(h.saveRequestRef.current, null); assert.equal(h.state.saving, false);
  await h.flow.requestSwitch(2);
  assert.deepEqual(h.state.pages, [2]);
});

test("保存期间继续编辑保留未保存状态，失败释放锁后可以重试", async () => {
  let succeed = false;
  const h = harness(async () => true, async () => {
    h.state.html = "保存期间新增的文字";
    return succeed;
  });
  assert.equal(await h.flow.saveAll(), false);
  assert.equal(h.saveRequestRef.current, null); assert.equal(h.state.saving, false);
  succeed = true;
  assert.equal(await h.flow.saveAll(), true);
  assert.equal(h.state.status, "unsaved");
  assert.equal(h.state.html, "保存期间新增的文字");
});

test("返回草稿保留编辑起点和修订号，资源刷新后连续跳过该页也不丢稿", async () => {
  const code = callbacks("src/features/manual-page-editor/ManualPageEditorShell.tsx", "ManualPageEditorShell", ["loadPage"]);
  const originalDraft = { html: "草稿的本地 HTML", baseline: "原始正文", baseRevision: 1 };
  const drafts = new Map([["a", originalDraft]]);
  const state = { context: null as any, html: "", refreshed: 0 };
  const resources = { needsRefresh: true, localUrls: ["file:///workspace/page-assets/new.png"], merge: () => { resources.needsRefresh = false; } };
  const deps = {
    useCallback: (callback: unknown) => callback,
    props: { workspaceDir: "/workspace", pages: [{ pageId: "a" }, { pageId: "b" }] },
    backend: { refreshManualPageResources: async () => { state.refreshed++; return []; } },
    fetchPageIntoCache: async () => ({ context: { revision: 2, workspace_fonts: [] }, html: "服务端的新内容" }),
    pageLoadRequestRef: { current: 0 }, loadSpanRef: { current: null }, beginPerformanceSpan: () => null,
    setLoading: () => {}, setError: () => {}, setConflictPageId: () => {}, setSelected: () => {}, setTextEditingTarget: () => {}, setSvgTextEditingTarget: () => {},
    cropSessionRef: { current: null }, setCropSession: () => {}, iframeCleanupRef: { current: null },
    resourceRegistriesRef: { current: new Map([["a", resources], ["b", resources]]) }, resourcesRef: { current: null },
    dirtyPagesRef: { current: drafts }, pendingDraftRef: { current: null }, pendingBaselineRef: { current: null },
    setContext: (value: unknown) => { state.context = value; }, setManagedFontLibrary: () => {}, setWorkspaceFontLibrary: () => {}, setRuntimeFonts: () => {},
    refreshRuntimeFontResources: (fonts: unknown) => fonts, displayEditorHtml: (html: string) => html,
    setHtml: (html: string) => { state.html = html; }, savedSnapshotRef: { current: null },
    setPageIndex: () => {}, setSaveStatus: () => {}, setHistory: () => {}, setFuture: () => {},
    formatMessage: () => "error", t: {},
  };
  const load = new Function(...Object.keys(deps), `${code}\nreturn loadPage;`)(...Object.values(deps));
  await load(0);
  assert.equal(state.context.revision, 1);
  assert.equal(state.html, originalDraft.html);
  assert.equal(deps.pendingBaselineRef.current, originalDraft.baseline);
  assert.equal(state.refreshed, 1);
  await load(1);
  assert.equal(drafts.get("a"), originalDraft);
  assert.equal(state.context.revision, 2);
});

test("重新加载冲突页保留当前页与其他页面草稿", async () => {
  const h = harness(async () => true, async () => true);
  h.state.html = "当前页尚未保存的修改";
  h.deps.dirtyPagesRef.current.set("b", { html: "冲突页草稿", baseline: "旧内容", baseRevision: 1 });
  h.deps.dirtyPagesRef.current.set("c", { html: "另一页草稿", baseline: "旧内容", baseRevision: 1 });
  await h.flow.reloadLatest();
  assert.deepEqual(h.state.pages, [1]);
  assert.equal(h.deps.dirtyPagesRef.current.has("b"), false);
  assert.equal(h.deps.dirtyPagesRef.current.get("a").html, h.state.html);
  assert.equal(h.deps.dirtyPagesRef.current.get("c").html, "另一页草稿");
});

test("连续保存多页累计更新页面进度，旧工作区的晚到响应不影响当前作品", () => {
  const h = deckResultHarness();
  h.fixture.workspace.task = { artifacts: { pptx: "old.pptx", pdf: "old.pdf" } };
  for (const id of ["page-9", "page-11"]) h.workflow.applyManualPageUpdate({
    workspace_dir: h.fixture.workspace.workspace_dir, page_id: id,
    manifest: { current_html_path: `${id}.html` },
    preview_source_fingerprint: `saved-${id}`,
    final_deck_render_updated: true, deck_html_path: "deck.html", page_progress_updated_at: "2026-09-30T06:20:00.000Z",
  });
  const pages = h.state.pageProgress.pages;
  assert.equal(pages[8].last_html_path, "page-9.html");
  assert.equal(pages[10].last_html_path, "page-11.html");
  assert.equal(h.reviewRenderRef.current.result!.slides[8].html_path, "page-9.html");
  assert.equal(h.reviewRenderRef.current.result!.slides[10].html_path, "page-11.html");
  assert.deepEqual((h.currentWorkspaceRef.current.task as any).artifacts, {});
  assert.equal(h.state.currentSlide, 8, "保存顺序不能决定返回位置");
  const current = h.currentWorkspaceRef.current;
  h.workflow.applyManualPageUpdate({ workspace_dir: "/other", page_id: "page-9" });
  assert.equal(h.currentWorkspaceRef.current, current);
});

for (const action of ["clean", "save", "discard"] as const) {
  test(`编辑器${action}退出传回最后查看的页面标识，与草稿保存顺序无关`, async () => {
    const h = harness(async () => true, async () => {
      h.deps.dirtyPagesRef.current.clear();
      return true;
    });
    // The editor entered on page 9; its latest render is now page 11.
    h.deps.page.pageId = "page-11";
    h.deps.deckRenderRequiredRef.current = true;
    if (action !== "clean") {
      h.deps.dirtyPagesRef.current.set("page-9", { html: "另一个页面的草稿" });
      await h.flow.resolveConfirm(action);
    } else {
      h.flow.requestExit();
    }
    assert.deepEqual(h.state.exitArguments, [["/workspace", "page-11", true]]);
  });
}

test("取消退出或保存失败不会返回结果页", async () => {
  const h = harness(async () => false, async () => true);
  await h.flow.resolveConfirm("cancel");
  await h.flow.resolveConfirm("save");
  assert.equal(h.state.exits, 0);
});
