import assert from "node:assert/strict";
import test from "node:test";
import type { RenderDeckHtmlResult } from "../../src/api/types";
import { deckResultHarness, deferred } from "../helpers/deckResults";
import { pagePreviewKey } from "../../src/features/deck-workspace/pagePreviewWork";
import { reconcileReviewRender } from "../../src/features/deck-workspace/reviewRenderReconciliation";

const previewKey = (result: RenderDeckHtmlResult, index: number) => {
  const slide = result.slides[index];
  return pagePreviewKey(result.workspace_dir, { pageId: slide.slide_id, title: slide.title,
    version: slide.preview_version ?? slide.preview_source_fingerprint ?? slide.html_path,
    expectedFingerprint: slide.preview_source_fingerprint });
};

function manualReceipt(h: ReturnType<typeof deckResultHarness>, pageId = "page-9", time = "2026-09-30T06:20:00.000Z") {
  return { workspace_dir: h.fixture.workspace.workspace_dir, page_id: pageId,
    manifest: { current_html_path: `${h.fixture.workspace.workspace_dir}/slides/${pageId}.html`, current_html_sha256: `source-${pageId}-${time}` },
    preview_source_fingerprint: `saved-${pageId}-${time}`, page_progress_updated_at: time,
    final_deck_render_updated: true, final_deck_render_requires_rebuild: false,
    deck_html_path: h.fixture.rendered.deck_html_path, rendered_at: time };
}

for (const entry of ["candidate", "refinement", "manual"] as const) {
  test(`${entry} 发布只刷新变化页，并保留大纲标题和第九页位置`, async () => {
    const h = deckResultHarness();
    if (entry === "candidate") {
      await h.workflow.applyAdoptedPage(h.fixture.workspace.workspace_dir, "page-9");
    } else if (entry === "refinement") {
      await h.workflow.applyDeckGenerationCompletion({ status: "completed", result: {
        rendered: h.fixture.metadata, outline: h.fixture.outline, progress: h.fixture.nextProgress,
      } }, h.fixture.nextWorkspace, { returnPageId: "page-9", changedPageIds: ["page-9"] });
    } else {
      h.workflow.applyManualPageUpdate(manualReceipt(h));
      await h.workflow.exitManualEditor(h.fixture.workspace.workspace_dir, "page-9", false);
    }
    assert.equal(h.state.currentSlide, 8);
    assert.equal(h.state.stage, "deck");
    assert.equal(h.state.page, "main");
    const result = h.state.reviewRender.result as RenderDeckHtmlResult;
    result.slides.forEach((slide, index) => {
      assert.equal(slide.title, h.fixture.outline.items[index].title);
      if (index === 8) assert.notEqual(previewKey(result, index), previewKey(h.fixture.rendered, index));
      else assert.equal(previewKey(result, index), previewKey(h.fixture.rendered, index));
    });
    assert.ok(h.events.filter((event) => event.name === "setReviewRender").every((event) => event.value.result));
  });
}

test("多页保存只累计内容，返回位置取编辑器退出页，后续加载仍保留其他页缓存", async () => {
  const h = deckResultHarness();
  for (const pageId of ["page-11", "page-9"]) h.workflow.applyManualPageUpdate(manualReceipt(h, pageId));
  assert.equal(h.state.currentSlide, 8);
  await h.workflow.exitManualEditor(h.fixture.workspace.workspace_dir, "page-11", false);
  assert.equal(h.state.currentSlide, 10);
  const result = h.state.reviewRender.result as RenderDeckHtmlResult;
  for (const index of [8, 10]) assert.notEqual(previewKey(result, index), previewKey(h.fixture.rendered, index));
  const progress = h.state.pageProgress;
  h.backend.getRenderedDeckHtml = async () => ({ ...result, slides: result.slides.map((slide, index) => ({
    ...slide, html_path: "", preview_unavailable: true, preview_source_fingerprint: "",
    preview_version: progress.pages[index].updated_at,
  })) });
  await h.workflow.loadDeckHtmlForWorkspace(h.currentWorkspaceRef.current, "review");
  assert.equal(h.state.currentSlide, 10);
  result.slides.forEach((_, index) => assert.equal(previewKey(h.state.reviewRender.result, index), previewKey(result, index)));
});

test("指定优化完成按标识定位，页面重排也不退回原序号", async () => {
  const h = deckResultHarness();
  h.fixture.metadata.slides.reverse();
  await h.workflow.applyDeckGenerationCompletion({ status: "completed", result: {
    rendered: h.fixture.metadata, outline: h.fixture.outline, progress: h.fixture.nextProgress,
  } }, h.fixture.nextWorkspace, { returnPageId: "page-9", changedPageIds: ["page-9"] });
  assert.equal(h.state.currentSlide, 3);
  assert.equal(h.state.deck[3].title, "第 9 页标题");
});

test("实际指定优化入口从操作页标识返回，后端页序变化不影响目标", async () => {
  const h = deckResultHarness();
  h.deps.refine = async (input) => {
    assert.equal(input.scope, "slide");
    assert.equal(input.pageId, "page-9");
    h.fixture.metadata.slides.reverse();
    return { status: "completed", result: { rendered: h.fixture.metadata, outline: h.fixture.outline, progress: h.fixture.nextProgress } };
  };
  await h.workflow.refineSlide("请优化当前页的文字排版");
  assert.equal(h.state.currentSlide, 3);
  assert.equal(h.state.deck[3].title, "第 9 页标题");
  assert.equal(h.state.stage, "deck");
});

test("指定优化等待提交时发生新发布，旧提交回执不能覆盖它", async () => {
  const h = deckResultHarness();
  const pending = deferred<{ workspace: typeof h.fixture.workspace }>();
  h.deps.commit = async () => pending.promise;
  const refinement = h.workflow.refineSlide("优化当前页");
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  h.workflow.applyManualPageUpdate(manualReceipt(h));
  const latest = h.state.reviewRender;
  pending.resolve({ workspace: h.fixture.nextWorkspace });
  await refinement;
  assert.equal(h.state.reviewRender, latest);
});

test("工作区轻量预览转为优化完成的严格元数据时，未变化页继续使用原缓存", async () => {
  const h = deckResultHarness();
  const partial = { ...h.fixture.rendered, slides: h.fixture.rendered.slides.map((slide) => ({
    ...slide, html_path: "", preview_source_fingerprint: "", preview_unavailable: true,
    preview_version: h.fixture.progress.updated_at,
  })) };
  h.workflow.publishDeckResult(h.fixture.workspace, partial, { changedPageIds: [] });
  // Simulate opening a workspace whose preview has only invalidation timestamps.
  h.reviewRenderRef.current = { ...h.reviewRenderRef.current, result: partial };
  const strict = { ...h.fixture.rendered, slides: h.fixture.rendered.slides.map((slide, index) => index === 8
    ? { ...slide, render_source_fingerprint: "new-source", preview_source_fingerprint: "new-preview" } : slide) };
  await h.workflow.applyDeckGenerationCompletion({ status: "completed", result: {
    rendered: strict, outline: h.fixture.outline, progress: h.fixture.nextProgress,
  } }, h.fixture.nextWorkspace, { returnPageId: "page-9", changedPageIds: ["page-9"] });
  partial.slides.forEach((_, index) => {
    if (index !== 8) assert.equal(previewKey(h.state.reviewRender.result, index), previewKey(partial, index));
  });
});

test("人工保存同步正文哈希，之后采用另一页不会让已保存页重新加载", async () => {
  const h = deckResultHarness();
  const saved = manualReceipt(h, "page-1");
  h.workflow.applyManualPageUpdate(saved);
  const before = h.state.reviewRender.result;
  assert.equal(h.state.pageProgress.pages[0].render_source_sha256, saved.manifest.current_html_sha256);
  assert.equal(before.slides[0].render_source_fingerprint, saved.manifest.current_html_sha256);
  h.fixture.nextWorkspace.page_progress = { ...h.state.pageProgress,
    updated_at: "2026-09-30T06:30:00.000Z",
    pages: h.state.pageProgress.pages.map((page: any) => page.page_id === "page-9"
      ? { ...page, render_source_sha256: "new-source", snapshot_source_sha256: "new-source", updated_at: "2026-09-30T06:30:00.000Z" } : page),
  };
  h.fixture.metadata.slides[0] = { ...h.fixture.metadata.slides[0],
    render_source_fingerprint: saved.manifest.current_html_sha256, preview_version: saved.page_progress_updated_at };
  await h.workflow.applyAdoptedPage(h.fixture.workspace.workspace_dir, "page-9");
  assert.equal(previewKey(h.state.reviewRender.result, 0), previewKey(before, 0));
});

test("多个变化页与返回页独立，严格元数据中的资源指纹变化也需要刷新", () => {
  const h = deckResultHarness();
  const metadata = structuredClone(h.fixture.metadata);
  metadata.slides[0].preview_source_fingerprint = "new-image-resource";
  const result = reconcileReviewRender({ previous: h.fixture.rendered, metadata,
    previousProgress: h.fixture.progress, nextProgress: h.fixture.nextProgress,
    changedPageIds: ["page-9", "page-11"], outline: h.fixture.outline.items });
  for (const index of [0, 8, 10]) assert.notEqual(previewKey(result, index), previewKey(h.fixture.rendered, index));
  for (const index of [1, 2, 3, 4, 5, 6, 7, 9, 11]) assert.equal(previewKey(result, index), previewKey(h.fixture.rendered, index));
});

test("编辑器退出后必要的重建保留旧预览和第十一页选择", async () => {
  const h = deckResultHarness();
  h.workflow.applyManualPageUpdate(manualReceipt(h));
  const saved = h.state.reviewRender.result;
  const metadata = deferred<RenderDeckHtmlResult>();
  h.backend.getRenderedDeckHtml = async () => metadata.promise;
  h.backend.openWorkspace = async () => h.currentWorkspaceRef.current;
  const exit = h.workflow.exitManualEditor(h.fixture.workspace.workspace_dir, "page-11", true);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.state.currentSlide, 10);
  assert.equal(h.state.reviewRender.result, saved);
  metadata.resolve(saved);
  await exit;
  assert.equal(h.state.currentSlide, 10);
  saved.slides.forEach((_: unknown, index: number) => assert.equal(previewKey(h.state.reviewRender.result, index), previewKey(saved, index)));
  assert.ok(h.events.filter((event) => event.name === "setReviewRender").every((event) => event.value.result));
});

test("重建失败保留已保存预览和退出页，迟到的重建也不能覆盖后续保存", async () => {
  const h = deckResultHarness();
  h.workflow.applyManualPageUpdate(manualReceipt(h));
  const saved = h.state.reviewRender.result;
  h.backend.getRenderedDeckHtml = async () => { throw new Error("render failed"); };
  await h.workflow.exitManualEditor(h.fixture.workspace.workspace_dir, "page-11", true);
  assert.equal(h.state.reviewRender.result, saved);
  assert.equal(h.state.currentSlide, 10);
  const pending = deferred<RenderDeckHtmlResult>();
  h.backend.getRenderedDeckHtml = async () => pending.promise;
  const rebuild = h.workflow.renderDeckHtmlForWorkspace(h.currentWorkspaceRef.current, "review");
  await Promise.resolve(); await Promise.resolve();
  h.workflow.applyManualPageUpdate(manualReceipt(h, "page-11", "2026-09-30T06:30:00.000Z"));
  const latest = h.state.reviewRender;
  pending.resolve(saved);
  assert.equal(await rebuild, null);
  assert.equal(h.state.reviewRender, latest);
  assert.equal(h.state.currentSlide, 10);
});

test("旧保存回执不能回退新版本，旧作品的退出不能切换当前作品", async () => {
  const h = deckResultHarness();
  h.workflow.applyManualPageUpdate(manualReceipt(h, "page-9", "2026-09-30T06:30:00.000Z"));
  const latest = h.state.reviewRender;
  h.workflow.applyManualPageUpdate(manualReceipt(h));
  assert.equal(h.state.reviewRender, latest);
  h.state.stage = "outline";
  await h.workflow.exitManualEditor("/another-workspace", "page-11", true);
  assert.equal(h.state.stage, "outline");
  assert.deepEqual(h.calls, []);
});

test("同一作品相同更新时间的迟到请求也不能覆盖后续发布", async () => {
  const h = deckResultHarness();
  const pending = deferred<RenderDeckHtmlResult>();
  h.backend.getRenderedDeckHtml = async () => pending.promise;
  const adoption = h.workflow.applyAdoptedPage(h.fixture.workspace.workspace_dir, "page-9");
  await Promise.resolve();
  h.workflow.publishDeckResult(h.fixture.workspace, h.fixture.rendered, { changedPageIds: [], returnTo: { pageId: "page-11" } });
  const latest = h.state.reviewRender;
  pending.resolve(h.fixture.metadata);
  await adoption;
  assert.equal(h.state.reviewRender, latest);
  assert.equal(h.state.currentSlide, 10);
});

test("只读取预览不回退最新设置，也不重置正在进行的导出", async () => {
  const h = deckResultHarness();
  const pending = deferred<RenderDeckHtmlResult>();
  h.backend.getRenderedDeckHtml = async () => pending.promise;
  h.deps.exportInFlightRef.current = true;
  const load = h.workflow.loadDeckHtmlForWorkspace(h.fixture.workspace, "export");
  const latest = { ...h.fixture.workspace, setting: { custom_setting: "latest" } };
  h.currentWorkspaceRef.current = latest;
  pending.resolve(h.fixture.rendered);
  await load;
  assert.equal(h.currentWorkspaceRef.current, latest);
  assert.ok(h.events.every((event) => !["setExportArtifactWithProgress", "setExportDownload"].includes(event.name)));
});
