import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { RenderDeckHtmlResult } from "../../src/api/types";
import type { PageThumbnail } from "../../src/api/pageThumbnail";
import type { WorkspacePageHtml } from "../../src/api/pageHtmlPreview";
import { messages } from "../../src/i18n/messages";
import { DeckPage } from "../../src/features/deck-workspace/components/DeckPage";
import { loadCachedPageHtml } from "../../src/features/deck-workspace/pageHtmlPreviewCache";
import { loadCachedPageThumbnail } from "../../src/features/deck-workspace/pageThumbnailCache";
import { pagePreviewKey } from "../../src/features/deck-workspace/pagePreviewWork";
import { deckResultHarness } from "../helpers/deckResults";

for (const entry of ["candidate", "refinement", "manual"] as const) {
test(`${entry} 更新第九页时显示加载状态，其余十一页保留原图片和 iframe`, async () => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const observers: Array<() => void> = [];
  for (const [name, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class {
      constructor(callback: (entries: unknown[]) => void) { observers.push(() => callback([{ isIntersecting: true }])); }
      observe() {} disconnect() {}
    },
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const h = deckResultHarness(`/page-result-preview-dom-${entry}`);
  const { fixture } = h;
  const key = (slide: RenderDeckHtmlResult["slides"][number]) => pagePreviewKey(fixture.workspace.workspace_dir, {
    pageId: slide.slide_id, title: slide.title,
    version: slide.preview_version ?? slide.preview_source_fingerprint ?? slide.html_path,
    expectedFingerprint: slide.preview_source_fingerprint,
  });
  const thumbnail = (pageId: string, version = "before"): PageThumbnail => ({ version: 1, page_id: pageId,
    preview_source_fingerprint: `preview-${pageId}`, width: 640, height: 360, size_bytes: 4,
    generated_at: "2026-09-30T06:00:00.000Z", image_url: `data:image/webp;base64,${pageId}-${version}`, expires_at: null });
  const html = (pageId: string, version = "before"): WorkspacePageHtml => ({ page_id: pageId,
    html: `<html><body>${pageId}-${version}</body></html>`, html_fingerprint: version,
    preview_source_fingerprint: `preview-${pageId}`, resources_expires_at: null });
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const noop = () => undefined;
  const render = (result: RenderDeckHtmlResult, currentSlide = 8) => act(async () => root.render(createElement(DeckPage, {
    t: messages.zh, deck: result.slides.map((slide) => ({ title: slide.title, subtitle: "" })), currentSlide,
    reviewRender: { status: "ready", result, error: "", renderKey: result.rendered_at }, loading: "none",
    setCurrentSlide: noop, onPreview: noop, onBack: noop, onRefineSlide: noop, onRegeneratePage: noop,
    onBeautifyPage: noop, canRegeneratePage: true, onRefineDeck: noop, onExport: noop, onEdit: noop,
  })));
  try {
    await Promise.all(fixture.rendered.slides.flatMap((slide) => [
      loadCachedPageHtml(key(slide), async () => html(slide.slide_id)),
      loadCachedPageThumbnail(key(slide), async () => thumbnail(slide.slide_id)),
    ]));
    await render(fixture.rendered);
    await act(async () => { observers.forEach((intersect) => intersect()); });
    for (let pass = 0; pass < 5; pass++) {
      await act(async () => { host.querySelectorAll(".slide-thumbnail-incoming").forEach((image) => image.dispatchEvent(new window.Event("load"))); });
    }
    for (let pass = 0; pass < 4; pass++) {
      await act(async () => { host.querySelectorAll("iframe").forEach((frame) => frame.dispatchEvent(new window.Event("load"))); });
    }
    const images = [...host.querySelectorAll(".slide-thumbnail > img:not(.slide-thumbnail-incoming)")];
    const frames = new Map([...host.querySelectorAll("iframe")].map((frame) => [frame.title, frame]));
    assert.equal(images.length, 12);
    assert.equal(frames.size, 12);
    const previousFrame = frames.get(fixture.rendered.slides[8].title)!;
    assert.equal(previousFrame.style.visibility, "visible");
    if (entry === "candidate") {
      await h.workflow.applyAdoptedPage(fixture.workspace.workspace_dir, fixture.pageId);
    } else if (entry === "refinement") {
      await h.workflow.applyDeckGenerationCompletion({ status: "completed", result: {
        rendered: fixture.metadata, outline: fixture.outline, progress: fixture.nextProgress,
      } }, fixture.nextWorkspace, { returnPageId: fixture.pageId, changedPageIds: [fixture.pageId] });
    } else {
      h.workflow.applyManualPageUpdate({ workspace_dir: fixture.workspace.workspace_dir, page_id: fixture.pageId,
        manifest: { current_html_path: `${fixture.workspace.workspace_dir}/slides/${fixture.pageId}.html`, current_html_sha256: "manual-source" },
        preview_source_fingerprint: "manual-preview", page_progress_updated_at: fixture.nextProgress.updated_at,
        final_deck_render_updated: true, deck_html_path: fixture.metadata.deck_html_path, rendered_at: fixture.metadata.rendered_at });
      await h.workflow.exitManualEditor(fixture.workspace.workspace_dir, fixture.pageId, false);
    }
    const next = h.state.reviewRender.result as RenderDeckHtmlResult;
    let deliverHtml!: (value: WorkspacePageHtml) => void;
    let deliverThumbnail!: (value: PageThumbnail) => void;
    const incomingHtml = loadCachedPageHtml(key(next.slides[8]), () => new Promise((resolve) => { deliverHtml = resolve; }));
    const incomingThumbnail = loadCachedPageThumbnail(key(next.slides[8]), () => new Promise((resolve) => { deliverThumbnail = resolve; }));
    await render(next);
    await act(async () => { observers.forEach((intersect) => intersect()); });
    assert.equal(previousFrame.style.visibility, "hidden", "新版 HTML 获取期间不能展示旧版页面");
    assert.equal(previousFrame.getAttribute("aria-hidden"), "true");
    assert.equal([...host.querySelectorAll("iframe")].some((frame) => frame.style.visibility === "visible"), false);
    assert.equal(host.querySelector(".static-html-preview")?.getAttribute("aria-busy"), "true");
    assert.ok(host.querySelector(".static-html-preview-overlay .slide-preview-loading"));
    await act(async () => previousFrame.dispatchEvent(new window.Event("load")));
    assert.equal(previousFrame.style.visibility, "hidden", "旧版的迟到加载事件不能恢复旧画面");
    const buttons = [...host.querySelectorAll(".thumb")];
    fixture.rendered.slides.forEach((slide, index) => {
      if (index === 8) return;
      assert.equal(buttons[index].querySelector(".slide-thumbnail > img"), images[index]);
      assert.equal([...host.querySelectorAll("iframe")].find((frame) => frame.title === slide.title), frames.get(slide.title));
      assert.equal(buttons[index].textContent?.includes(messages.zh.review.previewLoading), false);
    });
    assert.equal(buttons[8].getAttribute("aria-current"), "true");
    await act(async () => {
      deliverHtml(html(fixture.pageId, "adopted"));
      deliverThumbnail(thumbnail(fixture.pageId, "adopted"));
      await Promise.all([incomingHtml, incomingThumbnail]);
    });
    const adoptedFrame = [...host.querySelectorAll("iframe")].find((frame) => (frame.getAttribute("srcDoc") ?? frame.getAttribute("srcdoc"))?.includes("page-9-adopted"));
    assert.ok(adoptedFrame);
    assert.equal(adoptedFrame.style.visibility, "visible", "新版 HTML 到达后立即展示，不等待图片全部加载");
    assert.equal(host.querySelector(".static-html-preview")?.getAttribute("aria-busy"), "false");
    assert.equal(host.querySelector(".static-html-preview-overlay"), null);
    assert.equal(previousFrame.style.visibility, "hidden");
    await act(async () => adoptedFrame.dispatchEvent(new window.Event("load")));
    assert.equal(previousFrame.isConnected, false, "新版加载完成后释放旧版 iframe");
    await render(next, 0);
    const firstFrame = frames.get(fixture.rendered.slides[0].title)!;
    assert.equal(firstFrame.isConnected, true);
    assert.equal(firstFrame.style.visibility, "visible");
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});

}
