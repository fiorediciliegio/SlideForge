import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { GetWorkspacePageHtmlInput, WorkspacePageHtml } from "../../src/api/pageHtmlPreview";
import type { RenderDeckHtmlResult } from "../../src/api/types";
import { DeckPage } from "../../src/features/deck-workspace/components/DeckPage";
import { messages } from "../../src/i18n/messages";
import { deckResultHarness } from "../helpers/deckResults";
import { withOrdinaryInvokeTransport } from "../helpers/invokeRuntime";

function mountDeck(workspaceDir: string) {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} disconnect() {} },
    // Scroll events are unnecessary for either result-page prefetch queue.
    IntersectionObserver: class { observe() {} disconnect() {} },
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const requests: Array<{
    input: GetWorkspacePageHtmlInput;
    resolve: (value: WorkspacePageHtml) => void;
    reject: (error: Error) => void;
    settled: boolean;
  }> = [];
  const preparations: Array<{ pageId: string; priority: string }> = [];
  const unexpected: string[] = [];
  window.__BUNDLED_TOOL_IDS__ = { "ppt-engine": "test-engine" };
  window.HostAppRuntime = { connect: async () => ({ tools: { invoke: withOrdinaryInvokeTransport(async (input) => {
    const args = input.args as GetWorkspacePageHtmlInput & { priority: string; kind?: string };
    if (input.method === "app_prepare_workspace_page_preview") {
      if (args.kind !== "thumbnail") preparations.push({ pageId: args.page_id!, priority: args.priority });
      return { success: true, data: { task_id: args.page_id, workspace_dir: workspaceDir,
        page_id: args.page_id, status: "ready", input_version: "current" } };
    }
    if (input.method === "app_get_workspace_page_thumbnail") return { success: true, data: {
      version: 1, page_id: args.page_id, preview_source_fingerprint: args.expected_preview_fingerprint || "current",
      width: 640, height: 360, size_bytes: 4, generated_at: "2026-10-01T00:00:00Z",
      image_data_url: "data:image/webp;base64,YWJjZA==",
    } };
    if (input.method === "app_get_workspace_page_html") {
      const data = await new Promise<WorkspacePageHtml>((resolve, reject) => {
        requests.push({ input: args, resolve, reject, settled: false });
      });
      return { success: true, data };
    }
    if (input.method === "app_append_workspace_log") return { success: true, data: { appended: true } };
    unexpected.push(input.method);
    throw new Error(`Unexpected method ${input.method}`);
  }) } }) as any };
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const noop = () => undefined;
  const render = (result: RenderDeckHtmlResult, currentSlide = 0) => act(async () => {
    root.render(createElement(DeckPage, {
      t: messages.zh, deck: result.slides.map((slide) => ({ title: slide.title, subtitle: "" })), currentSlide,
      reviewRender: { status: "ready", result, error: "", renderKey: result.rendered_at }, loading: "none",
      setCurrentSlide: noop, onPreview: noop, onBack: noop, onRefineSlide: noop, onRegeneratePage: noop,
      onBeautifyPage: noop, canRegeneratePage: true, onRefineDeck: noop, onExport: noop, onEdit: noop,
    }));
  });
  const finish = (request: typeof requests[number], marker = "loaded", error?: Error) => {
    assert.equal(request.settled, false);
    request.settled = true;
    if (error) request.reject(error);
    else request.resolve({ page_id: request.input.page_id!,
      html: `<html><body>${request.input.page_id}-${marker}</body></html>`, html_fingerprint: marker,
      preview_source_fingerprint: request.input.expected_preview_fingerprint || marker, resources_expires_at: null });
  };
  const loadFrames = async () => {
    // linkedom does not load iframe documents; settle each bounded preparation batch explicitly.
    for (let pass = 0; pass < 5; pass++) await act(async () => {
      host.querySelectorAll("iframe").forEach((frame) => frame.dispatchEvent(new window.Event("load")));
    });
  };
  const dispose = async () => {
    try {
      await act(async () => {
        root.unmount();
        requests.filter((request) => !request.settled).forEach((request) => finish(request));
      });
    } finally {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      }
    }
  };
  return { host, requests, preparations, unexpected, render, finish, loadFrames, dispose };
}

for (const scenario of ["全部轻量元数据", "仅一页缺少快照"] as const) {
  test(`${scenario}：不切页也预取全稿，单页失败不阻塞其余页面`, async () => {
    const workflow = deckResultHarness(`/prefetch-${scenario}`);
    const { fixture } = workflow;
    const metadata = scenario === "全部轻量元数据" ? fixture.metadata : {
      ...fixture.rendered,
      slides: fixture.rendered.slides.map((slide, index) => index === 3 ? fixture.metadata.slides[index] : slide),
    };
    const h = mountDeck(fixture.workspace.workspace_dir);
    try {
      await h.render(metadata);
      assert.deepEqual(h.requests.map((request) => request.input.page_id),
        metadata.slides.slice(0, 10).map((slide) => slide.slide_id), "首批应获取十页，而非只获取选中页");
      assert.equal(h.preparations[0].priority, "foreground");
      assert.ok(h.preparations.slice(1).every((request) => request.priority === "background"));
      await act(async () => {
        h.finish(h.requests[1], "", new Error("Preview page identity mismatch"));
      });
      assert.equal(h.requests.length, 11, "失败释放的名额继续加载未访问页面");
      assert.equal(h.requests.filter((request) => !request.settled).length, 10);
      await act(async () => h.finish(h.requests[0]));
      assert.equal(h.requests.length, 12);
      assert.equal(h.requests.filter((request) => !request.settled).length, 10);
      await act(async () => {
        h.requests.filter((request) => !request.settled).forEach((request) => h.finish(request));
      });
      assert.ok(h.host.querySelectorAll("iframe").length <= 4, "获取完成也不能突破网页准备并发上限");
      await h.loadFrames();
      assert.equal(h.host.querySelectorAll("iframe").length, 11);
      assert.equal(h.host.querySelector("dialog"), null, "后台页失败不弹恢复对话框");
      const fourthFrame = [...h.host.querySelectorAll("iframe")].find((frame) => frame.title === metadata.slides[3].title)!;
      assert.ok(fourthFrame, "第四页在用户选中之前已准备完成");
      await h.render(metadata, 3);
      assert.equal(h.requests.length, 12, "切到第四页应复用预取结果");
      assert.equal(fourthFrame.isConnected, true);
      assert.equal(fourthFrame.style.visibility, "visible");
      assert.deepEqual(h.unexpected, []);
    } finally { await h.dispose(); }
  });
}

test("全页预取期间更新第九页，只刷新变化页并丢弃旧版迟到响应", async () => {
  const workflow = deckResultHarness("/prefetch-incremental-update");
  const { fixture } = workflow;
  const initial: RenderDeckHtmlResult = { ...fixture.rendered, slides: fixture.metadata.slides.map((slide, index) => ({
    ...slide, title: fixture.rendered.slides[index].title,
    render_source_fingerprint: fixture.progress.pages[index].render_source_sha256,
    preview_version: fixture.progress.pages[index].updated_at,
  })) };
  workflow.reviewRenderRef.current = { ...workflow.reviewRenderRef.current, result: initial };
  const h = mountDeck(fixture.workspace.workspace_dir);
  try {
    await h.render(initial);
    assert.equal(h.requests.length, 10);
    const oldNinth = h.requests.find((request) => request.input.page_id === "page-9")!;
    await act(async () => {
      h.requests.filter((request) => request !== oldNinth).forEach((request) => h.finish(request));
    });
    assert.equal(h.requests.length, 12);
    const twelfth = h.requests.find((request) => request.input.page_id === "page-12")!;
    await act(async () => h.finish(h.requests.find((request) => request.input.page_id === "page-11")!));
    await h.loadFrames();
    const retained = [...h.host.querySelectorAll("iframe")];
    assert.equal(retained.length, 10);

    await workflow.workflow.applyAdoptedPage(fixture.workspace.workspace_dir, "page-9");
    const updated = workflow.state.reviewRender.result as RenderDeckHtmlResult;
    await h.render(updated, workflow.state.currentSlide);
    assert.equal(h.requests.length, 13);
    const newNinth = h.requests[12];
    assert.equal(newNinth.input.page_id, "page-9", "只请求发生变化的页面");
    assert.ok(retained.every((frame) => frame.isConnected), "其余已加载页面不能被卸载");
    assert.equal([...h.host.querySelectorAll("iframe")].some((frame) => frame.style.visibility === "visible"), false);
    assert.ok(h.host.querySelector(".static-html-preview-overlay .slide-preview-loading"));

    await act(async () => h.finish(newNinth, "new-version"));
    const currentFrame = [...h.host.querySelectorAll("iframe")].find((frame) => frame.style.visibility === "visible")!;
    assert.ok((currentFrame.getAttribute("srcDoc") ?? currentFrame.getAttribute("srcdoc"))?.includes("new-version"));
    assert.equal(h.host.querySelector(".static-html-preview-overlay"), null, "新版 HTML 不等待 iframe 加载完成才展示");
    await h.loadFrames();
    await act(async () => {
      h.finish(oldNinth, "obsolete-version");
      h.finish(twelfth);
    });
    await h.loadFrames();
    assert.equal(h.requests.length, 13, "尚未完成的第十二页继续原请求，无需重新获取");
    assert.equal(h.host.querySelectorAll("iframe").length, 12);
    assert.ok(retained.every((frame) => frame.isConnected));
    assert.equal(currentFrame.style.visibility, "visible", "后台响应不能改变选中页面");
    assert.ok([...h.host.querySelectorAll("iframe")].every((frame) =>
      !(frame.getAttribute("srcDoc") ?? frame.getAttribute("srcdoc"))?.includes("obsolete-version")));
    await h.render(updated, 11);
    assert.equal(h.requests.length, 13);
    assert.equal([...h.host.querySelectorAll("iframe")].find((frame) => frame.style.visibility === "visible")?.title,
      updated.slides[11].title);
    assert.deepEqual(h.unexpected, []);
  } finally { await h.dispose(); }
});
