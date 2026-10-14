import assert from "node:assert/strict";
import test from "node:test";
import { deckResultHarness as harness, deferred } from "../helpers/deckResults";
import type { RenderDeckHtmlResult, WorkspaceResult } from "../../src/api/types";
import { withOutlineTitles, reconcileReviewRender } from "../../src/features/deck-workspace/reviewRenderReconciliation";
import { pagePreviewKey } from "../../src/features/deck-workspace/pagePreviewWork";
import { pageAdoptionFixture } from "../helpers/pageAdoption";

type Slide = RenderDeckHtmlResult["slides"][number];
const previewKey = (slide: Slide, workspaceDir = "/page-adoption") => pagePreviewKey(workspaceDir, {
  pageId: slide.slide_id, title: slide.title,
  version: slide.preview_version ?? slide.preview_source_fingerprint ?? slide.html_path,
  expectedFingerprint: slide.preview_source_fingerprint,
});

function reconcile(fixture = pageAdoptionFixture()) {
  return reconcileReviewRender({ previous: fixture.rendered, metadata: fixture.metadata,
    previousProgress: fixture.progress, nextProgress: fixture.nextProgress,
    changedPageIds: [fixture.pageId], outline: fixture.outline.items });
}

test("标题按页面标识关联大纲，页序不同也不会串页", () => {
  const fixture = pageAdoptionFixture();
  const result = withOutlineTitles(fixture.metadata, [...fixture.outline.items].reverse());
  assert.deepEqual(result.slides.map((slide) => slide.title), fixture.outline.items.map((item) => item.title));
  const missing = withOutlineTitles(fixture.metadata, fixture.outline.items.slice(1));
  assert.equal(missing.slides[0].title, "page-1", "缺失页面不能套用下一页标题");
  const legacy = withOutlineTitles(fixture.metadata, fixture.outline.items.map(({ page_id, ...item }) => item));
  assert.equal(legacy.slides[0].title, fixture.outline.items[0].title);
});

test("第九页采用后只改变本页缓存标识，保留其余十一页的 HTML 和缩略图版本", () => {
  const fixture = pageAdoptionFixture();
  const result = reconcile(fixture);
  assert.deepEqual(result.slides.map((slide) => slide.title), fixture.outline.items.map((item) => item.title));
  result.slides.forEach((slide, index) => {
    if (index === 8) {
      assert.notEqual(previewKey(slide), previewKey(fixture.rendered.slides[index]));
      assert.equal(slide.preview_unavailable, true);
    } else {
      assert.equal(previewKey(slide), previewKey(fixture.rendered.slides[index]));
      assert.equal(slide.html_path, fixture.rendered.slides[index].html_path);
    }
  });
  assert.equal(fixture.metadata.slides[0].title, "page-1", "不修改后端原始回执");
});

test("其他页面同时变化、缺少原进度或切换作品时，不沿用过时预览", () => {
  const fixture = pageAdoptionFixture();
  fixture.nextProgress.pages[0] = { ...fixture.nextProgress.pages[0], updated_at: "new-save" };
  assert.equal(reconcile(fixture).slides[0].html_path, "");
  const noProgress = reconcileReviewRender({ previous: fixture.rendered, metadata: fixture.metadata,
    previousProgress: null, nextProgress: fixture.nextProgress, changedPageIds: [fixture.pageId], outline: fixture.outline.items });
  assert.ok(noProgress.slides.every((slide) => slide.preview_unavailable));
  fixture.rendered.workspace_dir = "/another-workspace";
  assert.ok(reconcile(fixture).slides.every((slide) => slide.preview_unavailable));
});

test("保留未变化的人工编辑预览版本，并采用重新生成后的新标题", () => {
  const fixture = pageAdoptionFixture();
  fixture.rendered.slides[0] = { ...fixture.rendered.slides[0], manually_edited: true, preview_version: "manual-save:v1" };
  fixture.outline.items[8].title = "第九页的新标题";
  fixture.metadata.slides = [...fixture.metadata.slides].reverse();
  const result = reconcile(fixture);
  assert.equal(result.slides.find((slide) => slide.slide_id === fixture.pageId)?.title, "第九页的新标题");
  assert.equal(previewKey(result.slides.at(-1)!), previewKey(fixture.rendered.slides[0]));
  assert.equal(result.slides.at(-1)?.manually_edited, true);
});

test("读取工作区之后页面又发生变化时，元数据中的新版本也会使旧预览失效", () => {
  const fixture = pageAdoptionFixture();
  fixture.metadata.slides[0] = { ...fixture.metadata.slides[0], render_source_fingerprint: "later-source" };
  fixture.metadata.slides[1] = { ...fixture.metadata.slides[1], preview_version: "later-save" };
  const result = reconcile(fixture);
  assert.equal(result.slides[0].preview_unavailable, true);
  assert.equal(result.slides[1].preview_unavailable, true);
});

test("实际采用回调只读取一次元数据，保留第九页及其余十一页预览", async () => {
  const h = harness();
  const opened = deferred<WorkspaceResult>();
  const metadata = deferred<RenderDeckHtmlResult>();
  h.backend.openWorkspace = async () => { h.calls.push("open"); return opened.promise; };
  h.backend.getRenderedDeckHtml = async () => { h.calls.push("metadata"); return metadata.promise; };
  const adoption = h.workflow.applyAdoptedPage(h.fixture.workspace.workspace_dir, h.fixture.pageId);
  assert.equal(h.state.reviewRender.result, h.fixture.rendered);
  opened.resolve(h.fixture.nextWorkspace);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.state.currentSlide, 8);
  assert.equal(h.state.reviewRender.result, h.fixture.rendered);
  metadata.resolve(h.fixture.metadata);
  await adoption;
  assert.deepEqual(h.calls, ["open", "metadata"]);
  assert.equal(h.state.currentSlide, 8);
  assert.deepEqual(h.state.deck.map((slide: Slide) => slide.title), h.fixture.outline.items.map((item) => item.title));
  assert.ok(h.events.filter((event) => event.name === "setReviewRender").every((event) => event.value.result !== null));
  assert.equal(previewKey(h.state.reviewRender.result.slides[0]), previewKey(h.fixture.rendered.slides[0]));
  assert.notEqual(previewKey(h.state.reviewRender.result.slides[8]), previewKey(h.fixture.rendered.slides[8]));
});

test("采用后按页面标识选中目标，页面重排时不沿用旧序号", async () => {
  const h = harness();
  h.fixture.metadata.slides.reverse();
  await h.workflow.applyAdoptedPage(h.fixture.workspace.workspace_dir, h.fixture.pageId);
  assert.equal(h.state.currentSlide, 3);
  assert.equal(h.state.deck[3].title, "第 9 页标题");
});

test("元数据加载迟到时，不能覆盖已采用的结果或重置用户选择", async () => {
  const h = harness();
  const oldRequest = deferred<RenderDeckHtmlResult>();
  h.backend.getRenderedDeckHtml = async () => oldRequest.promise;
  const load = h.workflow.loadDeckHtmlForWorkspace(h.fixture.workspace, "review");
  h.backend.getRenderedDeckHtml = async () => h.fixture.metadata;
  await h.workflow.applyAdoptedPage(h.fixture.workspace.workspace_dir, h.fixture.pageId);
  const adopted = h.state.reviewRender;
  h.state.currentSlide = 5;
  oldRequest.resolve(h.fixture.rendered);
  assert.equal(await load, null);
  assert.equal(h.state.reviewRender, adopted);
  assert.equal(h.state.currentSlide, 5);
  assert.equal(h.state.loading, "none", "过时请求仍需结束自己的加载状态");
});

test("普通加载与异步工作区刷新也保留当前页和大纲标题", async () => {
  const h = harness();
  await h.workflow.loadDeckHtmlForWorkspace(h.fixture.workspace, "review");
  assert.equal(h.state.currentSlide, 8);
  assert.equal(h.state.deck[8].title, "第 9 页标题");
  const request = deferred<RenderDeckHtmlResult>();
  h.backend.getRenderedDeckHtml = async () => request.promise;
  h.workflow.applyWorkspace(h.fixture.workspace, { preserveCurrentSlide: true });
  assert.equal(h.state.currentSlide, 8);
  h.state.currentSlide = 3;
  request.resolve(h.fixture.metadata);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.currentSlide, 3, "晚到的初始预览不能抢走用户刚选中的页面");
  assert.equal(h.state.deck[3].title, "第 4 页标题");
  assert.deepEqual(h.state.outline, h.state.outlineDraft, "只刷新预览不能让未修改的大纲变成待保存");
});

test("同一作品的重复加载只接受最后一个请求，早到旧请求也不能结束新请求的加载状态", async () => {
  const h = harness();
  const first = deferred<RenderDeckHtmlResult>();
  const second = deferred<RenderDeckHtmlResult>();
  h.backend.getRenderedDeckHtml = async () => first.promise;
  const oldLoad = h.workflow.loadDeckHtmlForWorkspace(h.fixture.workspace, "review");
  h.backend.getRenderedDeckHtml = async () => second.promise;
  const newLoad = h.workflow.loadDeckHtmlForWorkspace(h.fixture.workspace, "review");
  first.resolve(h.fixture.rendered);
  assert.equal(await oldLoad, null);
  assert.equal(h.state.loading, "review");
  second.resolve(h.fixture.metadata);
  assert.ok(await newLoad);
  assert.equal(h.state.loading, "none");
  assert.equal(h.state.currentSlide, 8);
});

test("采用后的读取失败保留已展示状态，切换作品后忽略旧请求", async () => {
  const h = harness();
  h.backend.getRenderedDeckHtml = async () => { throw new Error("temporary failure"); };
  await assert.rejects(h.workflow.applyAdoptedPage(h.fixture.workspace.workspace_dir, h.fixture.pageId), /temporary failure/);
  assert.equal(h.state.reviewRender.result, h.fixture.rendered);
  assert.equal(h.state.currentSlide, 8);
  const request = deferred<RenderDeckHtmlResult>();
  h.backend.getRenderedDeckHtml = async () => request.promise;
  const adoption = h.workflow.applyAdoptedPage(h.fixture.workspace.workspace_dir, h.fixture.pageId);
  await Promise.resolve(); await Promise.resolve();
  h.currentWorkspaceRef.current = { ...h.fixture.workspace, workspace_dir: "/another-workspace" };
  h.state.currentSlide = 0;
  request.resolve(h.fixture.metadata);
  await adoption;
  assert.equal(h.currentWorkspaceRef.current.workspace_dir, "/another-workspace");
  assert.equal(h.state.currentSlide, 0);
});
