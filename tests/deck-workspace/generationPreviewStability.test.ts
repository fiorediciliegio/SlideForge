import assert from "node:assert/strict";
import test from "node:test";
import { withEmptyVisualStyleCatalog } from "../helpers/emptyVisualStyleCatalog.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { LiveHtmlPagePreview } from "../../src/features/deck-workspace/components/LiveHtmlPagePreview.tsx";
import { GenerationPagePreviewPanel } from "../../src/features/deck-workspace/components/GenerationPagePreviewPanel.tsx";
import { SlideThumbnail } from "../../src/features/deck-workspace/components/SlideThumbnail.tsx";
import { loadCachedPageHtml } from "../../src/features/deck-workspace/pageHtmlPreviewCache.ts";
import { loadCachedPageThumbnail } from "../../src/features/deck-workspace/pageThumbnailCache.ts";
import { pagePreviewKey } from "../../src/features/deck-workspace/pagePreviewWork.ts";
import { messages } from "../../src/i18n/messages.ts";
import type { WorkspacePageHtml } from "../../src/api/pageHtmlPreview.ts";
import type { PageThumbnail } from "../../src/api/pageThumbnail.ts";
import type { DeckGenerationProgressPage } from "../../src/features/deck-generation/types.ts";

function dom() {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const observers: Array<() => void> = [];
  const animations = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  install("window", window); install("document", document); install("IS_REACT_ACT_ENVIRONMENT", true);
  install("ResizeObserver", class { observe() {} disconnect() {} });
  install("IntersectionObserver", class {
    constructor(callback: (entries: unknown[]) => void) { observers.push(() => callback([{ isIntersecting: true }])); }
    observe() {} disconnect() {}
  });
  install("requestAnimationFrame", (callback: FrameRequestCallback) => { animations.set(++sequence, callback); return sequence; });
  install("cancelAnimationFrame", (id: number) => animations.delete(id));
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  return { window, host, root,
    intersect: () => act(async () => { for (const callback of observers) callback(); }),
    paint: () => act(async () => {
      const callbacks = [...animations.values()]; animations.clear();
      for (const callback of callbacks) callback(0);
    }),
    async dispose() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("连续 HTML 输出按固定间隔更新，慢图片无需 load 事件即可展示", async (context) => {
  const view = dom();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const render = (html: string) => act(async () => view.root.render(createElement(LiveHtmlPagePreview, { html, title: "第一页" })));
  const shown = () => [...view.host.querySelectorAll<HTMLIFrameElement>("iframe")].find((frame) => frame.style.opacity === "1")!;
  try {
    await render("首帧");
    const firstFrame = shown();
    await render("第二帧");
    await act(async () => context.mock.timers.tick(180));
    await render("第三帧");
    await act(async () => context.mock.timers.tick(70));
    assert.equal(shown(), firstFrame, "替换画面准备时保留已有帧");
    await view.paint(); await view.paint();
    assert.equal(shown().srcdoc, "第三帧", "持续输出不会重置更新期限");
    assert.notEqual(shown(), firstFrame);
    await render("第四帧");
    await act(async () => context.mock.timers.tick(250));
    await view.paint(); await view.paint();
    assert.equal(shown().srcdoc, "第四帧");
    assert.equal(view.host.querySelectorAll("iframe").length, 2);
  } finally { await view.dispose(); context.mock.timers.reset(); }
});

test("实时画面保留到正式 HTML 可见，切页不显示上一页", async () => {
  const view = dom();
  const workspaceDir = "/generation-handoff-dom";
  let deliver!: (html: WorkspacePageHtml) => void;
  const pending = loadCachedPageHtml(pagePreviewKey(workspaceDir, { pageId: "p1", version: "v1" }),
    () => new Promise<WorkspacePageHtml>((resolve) => { deliver = resolve; }));
  const render = (accepted: boolean, pageId = "p1", snapshot = accepted) => act(async () => view.root.render(createElement(GenerationPagePreviewPanel, {
    workspaceDir, t: messages.zh, pinnedPageId: pageId, onSelectPage: () => undefined,
    previews: { [pageId]: { pageId, pageIndex: 0, title: pageId, htmlPath: snapshot ? "/output/page.html" : "",
      renderSourceFingerprint: "v1", snapshotSourceFingerprint: "v1", status: snapshot ? "ready" : "loading" } },
    pageProgress: [{ page_id: pageId, status: accepted ? "accepted" : "layout_checking" } as DeckGenerationProgressPage],
    activeStreams: !accepted && pageId === "p1" ? [{ page_id: pageId, page_index: 0, kind: "page-html", status: "authoring", lines: [], activities: [], preview_html: "实时第一页" }] : [],
  })));
  try {
    await render(false);
    const firstFrame = view.host.querySelector(".generation-live-html-preview iframe");
    await render(false, "p1", true);
    assert.ok(view.host.querySelector(".static-html-preview"), "正式预览在页面验收前即可准备");
    await render(true);
    assert.equal(view.host.querySelector(".generation-live-html-preview iframe"), firstFrame);
    assert.equal(view.host.querySelector(".generation-live-html-preview")?.parentElement?.style.opacity, "1");
    await act(async () => {
      deliver({ page_id: "p1", html: "<html><body>正式第一页<img src='slow-image'></body></html>",
        html_fingerprint: "v1", preview_source_fingerprint: "v1", resources_expires_at: null });
      await pending;
    });
    assert.equal(view.host.querySelector(".static-html-preview")?.parentElement?.style.opacity, "1");
    assert.equal(view.host.querySelector(".generation-live-html-preview")?.parentElement?.style.opacity, "0");
    assert.equal(view.host.querySelector(".static-html-preview-overlay"), null, "无需等待正式 iframe 的 load");
    await render(false, "p2");
    assert.equal(view.host.querySelector(".generation-live-html-preview"), null);
    assert.equal(view.host.querySelector(".static-html-preview"), null);
    assert.ok(view.host.textContent?.includes(messages.zh.generating.preview.loading));
  } finally { await view.dispose(); }
});

test("缩略图更新期间保留旧图，新图加载后才替换，迟到响应不覆盖新版", async () => {
  const view = dom();
  const workspaceDir = "/generation-thumbnail-dom";
  const pageId = "p1";
  const thumbnail = (version: string) => ({ page_id: pageId, image_url: `data:image/webp;base64,${version}`,
    preview_source_fingerprint: version } as PageThumbnail);
  await loadCachedPageThumbnail(pagePreviewKey(workspaceDir, { pageId, version: "v1" }), async () => thumbnail("v1"));
  let deliverSecond!: (image: PageThumbnail) => void;
  const second = loadCachedPageThumbnail(pagePreviewKey(workspaceDir, { pageId, version: "v2" }),
    () => new Promise<PageThumbnail>((resolve) => { deliverSecond = resolve; }));
  await loadCachedPageThumbnail(pagePreviewKey(workspaceDir, { pageId, version: "v3" }), async () => thumbnail("v3"));
  const render = (version: string, refreshEnabled = true) => act(async () => view.root.render(createElement(SlideThumbnail, {
    workspaceDir, pageId, version, refreshEnabled, preservePreview: true, title: "第一页", t: messages.zh,
  })));
  const visible = () => view.host.querySelector<HTMLImageElement>("img:not(.slide-thumbnail-incoming)");
  const load = () => act(async () => view.host.querySelector(".slide-thumbnail-incoming")!.dispatchEvent(new view.window.Event("load")));
  try {
    await render("v1"); await view.intersect(); await load();
    const original = visible();
    assert.equal(original?.src, thumbnail("v1").image_url);
    await render("v1", false);
    assert.equal(visible(), original);
    assert.ok(view.host.querySelector(".generation-thumbnail-updating"));
    await render("v2");
    assert.equal(visible(), original);
    await render("v3");
    assert.equal(visible(), original, "新图尚未解码时仍显示旧图");
    await load();
    assert.equal(visible()?.src, thumbnail("v3").image_url);
    await act(async () => { deliverSecond(thumbnail("v2")); await second; });
    assert.equal(visible()?.src, thumbnail("v3").image_url);
    assert.equal(view.host.querySelector(".generation-thumbnail-updating"), null);
    assert.equal(view.host.querySelector(".slide-preview-loading"), null);
  } finally { await view.dispose(); }
});

test("同页旧 HTML 的图片尚未加载完时，也保留到新版本可见", async () => {
  const { RenderedSlideHtml } = await import("../../src/features/deck-workspace/components/RenderedSlideHtml.tsx");
  const view = dom();
  const workspaceDir = "/generation-slow-version-dom";
  const pageId = "p1";
  const value = (version: string): WorkspacePageHtml => ({ page_id: pageId, html: `<html><body>${version}</body></html>`,
    html_fingerprint: version, preview_source_fingerprint: version, resources_expires_at: null });
  await loadCachedPageHtml(pagePreviewKey(workspaceDir, { pageId, version: "v1" }), async () => value("v1"));
  let deliver!: (html: WorkspacePageHtml) => void;
  const pending = loadCachedPageHtml(pagePreviewKey(workspaceDir, { pageId, version: "v2" }),
    () => new Promise<WorkspacePageHtml>((resolve) => { deliver = resolve; }));
  const render = (version: string) => act(async () => view.root.render(createElement(RenderedSlideHtml, {
    workspaceDir, pageId, version, title: "第一页", t: messages.zh, recoveryEnabled: false,
  })));
  const visible = () => [...view.host.querySelectorAll<HTMLIFrameElement>("iframe")].filter((frame) => frame.style.visibility === "visible");
  try {
    await render("v1");
    const oldFrame = visible()[0];
    await render("v2");
    assert.deepEqual(visible(), [oldFrame]);
    assert.equal(view.host.querySelector(".static-html-preview-overlay"), null);
    await act(async () => { deliver(value("v2")); await pending; });
    assert.equal(visible().length, 1);
    assert.notEqual(visible()[0], oldFrame);
    await act(async () => oldFrame.dispatchEvent(new view.window.Event("load")));
    assert.notEqual(visible()[0], oldFrame, "旧图的迟到事件不能抢回可见区域");
  } finally { await view.dispose(); }
});

test("逐页卡片直接更新当前状态，不因其他页进度或完成事件恢复详情", async () => {
  const { GeneratingPage } = await withEmptyVisualStyleCatalog(() => import("../../src/features/deck-workspace/components/GeneratingPage.tsx"));
  const { buildGenerationViewState } = await import("../../src/features/deck-workspace/generationViewState.ts");
  const view = dom();
  const noop = () => undefined;
  const render = (step: "page-layout-check" | "page-authoring", completed = false) => {
    const progress = { step, message: "", currentPageIndex: 1, totalPages: 2,
      pages: [{ page_id: "p1", index: 0, title: "第一页", status: completed ? "accepted" : "layout_checking" } as DeckGenerationProgressPage],
      activeStreams: [{ page_id: "p1", page_index: 0, kind: "page-layout-check", run_id: "attempt1",
        status: completed ? "completed" : "layout_checking", lines: ["布局检查详情"], activities: [] }] };
    return act(async () => view.root.render(createElement(GeneratingPage, {
      previewWorkspaceDir: "/page-status-dom", t: messages.zh, progress,
      history: [{ id: "previous-attempt", page_id: "p1", page_index: 0, phase: "page-authoring",
        label: "历史生成过程", status: "completed", message: "", lines: ["历史生成原文"], activities: [],
        updated_at: "2026-09-30T00:00:00.000Z" }], pagePreviews: {},
      viewState: buildGenerationViewState({ loading: "none", progress, activeRun: null }),
      pinnedPreviewPageId: null, onSelectPreviewPage: noop, onBack: noop, onBackToOutline: noop,
      onStop: noop, onResume: async () => undefined, canBackToOutline: false,
    })));
  };
  const assertCompactCard = (status: string) => {
    const card = view.host.querySelector(".generation-page-item")!;
    assert.equal(card.querySelector("strong")?.textContent, "1. 第一页");
    assert.equal(card.querySelectorAll(".generation-status-badge").length, 1);
    assert.equal(card.querySelector(".generation-status-badge")?.textContent, status);
    assert.equal(card.querySelector("details, button, pre"), null);
    assert.doesNotMatch(card.textContent ?? "", /布局检查详情|历史生成原文/);
    return card;
  };
  try {
    await render("page-layout-check");
    const card = assertCompactCard(messages.zh.generating.stageRecords.running);
    await render("page-authoring");
    assert.equal(assertCompactCard(messages.zh.generating.stageRecords.running), card);
    await render("page-layout-check", true);
    assert.equal(assertCompactCard(messages.zh.generating.stageRecords.pageStatuses.accepted), card);
  } finally { await view.dispose(); }
});

test("切换生成工作区后，自动跟随从新工作区第一页开始", async () => {
  const view = dom();
  const render = (workspaceDir: string, ids: string[]) => act(async () => view.root.render(createElement(GenerationPagePreviewPanel, {
    workspaceDir, t: messages.zh, pinnedPageId: null, onSelectPage: () => undefined,
    previews: Object.fromEntries(ids.map((pageId, pageIndex) => [pageId, { pageId, pageIndex, title: pageId,
      htmlPath: "", status: "loading" as const }])),
    pageProgress: ids.map((page_id) => ({ page_id, status: "authoring" } as DeckGenerationProgressPage)),
  })));
  try {
    await render("/automatic-old", ["old-first", "old-second"]);
    assert.equal(view.host.querySelector(".generation-preview-header strong")?.textContent, "1. old-first");
    await render("/automatic-new", ["new-first", "new-second"]);
    assert.equal(view.host.querySelector(".generation-preview-header strong")?.textContent, "1. new-first");
  } finally { await view.dispose(); }
});
