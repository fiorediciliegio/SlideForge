import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { GetWorkspacePageThumbnailInput, PageThumbnailTransport } from "../../src/api/pageThumbnail";
import type { RenderDeckHtmlResult } from "../../src/api/types";
import { DeckPage } from "../../src/features/deck-workspace/components/DeckPage";
import { SlideThumbnail } from "../../src/features/deck-workspace/components/SlideThumbnail";
import { messages } from "../../src/i18n/messages";
import { withOrdinaryInvokeTransport } from "../helpers/invokeRuntime";

function metadata(workspaceDir: string): RenderDeckHtmlResult {
  return { workspace_dir: workspaceDir, title: "缩略图预取", slide_count: 12, rendered_at: "v1",
    output_dir: `${workspaceDir}/output`, deck_html_path: "", slides: Array.from({ length: 12 }, (_, index) => ({
      slide_id: `page-${index + 1}`, index, title: `第 ${index + 1} 页`, html_path: "", preview_unavailable: true, preview_version: "v1",
    })) };
}

function mount() {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const observers: Array<{ callback: (entries: any[]) => void; targets: Set<Element>; root?: Element }> = [];
  for (const [name, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class {
      record: typeof observers[number];
      constructor(callback: (entries: any[]) => void, options: { root?: Element } = {}) {
        this.record = { callback, targets: new Set(), root: options.root }; observers.push(this.record);
      }
      observe(element: Element) { this.record.targets.add(element); }
      disconnect() { this.record.targets.clear(); }
    },
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const requests: Array<{ input: GetWorkspacePageThumbnailInput; resolve: (value: PageThumbnailTransport) => void;
    reject: (error: Error) => void; settled: boolean }> = [];
  const preparations: Array<{ workspace_dir: string; page_id: string; priority: string; kind?: string }> = [];
  const htmlRequests: string[] = [];
  window.__ANNA_TOOL_IDS__ = { "ppt-engine": "test-engine" };
  window.AnnaAppRuntime = { connect: async () => ({ tools: { invoke: withOrdinaryInvokeTransport(async (input) => {
    const args = input.args as any;
    if (input.method === "app_prepare_workspace_page_preview") {
      preparations.push(args);
      return { success: true, data: { task_id: args.page_id, workspace_dir: args.workspace_dir, page_id: args.page_id,
        status: "ready", input_version: "current" } };
    }
    if (input.method === "app_get_workspace_page_thumbnail") {
      const data = await new Promise<PageThumbnailTransport>((resolve, reject) => requests.push({ input: args, resolve, reject, settled: false }));
      return { success: true, data };
    }
    if (input.method === "app_get_workspace_page_html") {
      htmlRequests.push(args.page_id);
      return { success: true, data: { page_id: args.page_id, html: `<html><body>${args.page_id}</body></html>`,
        html_fingerprint: "html", preview_source_fingerprint: args.expected_preview_fingerprint || "current", resources_expires_at: null } };
    }
    if (input.method === "app_append_workspace_log") return { success: true, data: { appended: true } };
    throw new Error(`Unexpected method ${input.method}`);
  }) } }) as any };
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const noop = () => undefined;
  const flush = () => act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
  const render = (result: RenderDeckHtmlResult, currentSlide = 0) => act(async () => root.render(createElement(DeckPage, {
    t: messages.zh, deck: result.slides.map((slide) => ({ title: slide.title, subtitle: "" })), currentSlide,
    reviewRender: { status: "ready", result, error: "", renderKey: result.rendered_at }, loading: "none",
    setCurrentSlide: noop, onPreview: noop, onBack: noop, onRefineSlide: noop, onRegeneratePage: noop,
    onBeautifyPage: noop, canRegeneratePage: true, onRefineDeck: noop, onExport: noop, onEdit: noop,
  })));
  const finish = (request: typeof requests[number], marker = "current", error?: Error) => {
    assert.equal(request.settled, false); request.settled = true;
    if (error) request.reject(error);
    else request.resolve({ version: 1, page_id: request.input.page_id!, preview_source_fingerprint: request.input.expected_preview_fingerprint || marker,
      width: 640, height: 360, size_bytes: 4, generated_at: "2026-10-01T00:00:00Z",
      image_data_url: `data:image/webp;base64,${Buffer.from(`${request.input.page_id}-${marker}`).toString("base64")}` });
  };
  const loadImages = () => act(async () => host.querySelectorAll(".slide-thumbnail-incoming")
    .forEach((image) => image.dispatchEvent(new window.Event("load"))));
  const intersect = (index: number, isIntersecting = true) => act(async () => {
    const element = host.querySelectorAll(".thumb")[index];
    for (const observer of observers.filter((observer) => observer.root && observer.targets.has(element))) {
      observer.callback([{ target: element, isIntersecting }]);
    }
  });
  const dispose = async () => {
    try {
      await act(async () => { root.unmount(); requests.filter((request) => !request.settled).forEach((request) => finish(request)); });
    } finally {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      }
    }
  };
  return { host, root, window, requests, preparations, htmlRequests, flush, render, finish, loadImages, intersect, dispose };
}

test("不滚动或切页也下载全部缩略图，等待图片解码后才继续预取，并保留已加载图片", async () => {
  const h = mount();
  const result = metadata("/thumbnail-prefetch-all");
  try {
    await h.render(result); await h.flush();
    assert.deepEqual(h.requests.map((request) => request.input.page_id), ["page-1", "page-2", "page-3", "page-4"]);
    assert.equal(h.htmlRequests.length, 12, "缩略图准备不关闭整稿 HTML 预取");
    await act(async () => h.requests.forEach((request) => h.finish(request)));
    const images = [...h.host.querySelectorAll<HTMLImageElement>(".slide-thumbnail-incoming")];
    assert.equal(images.length, 4, "离屏图片也已经挂载并开始下载");
    assert.ok(images.every((image) => image.getAttribute("loading") === "eager"));
    const decodes: Array<() => void> = [];
    for (const image of images) image.decode = () => new Promise<void>((resolve) => decodes.push(resolve));
    await h.loadImages(); await h.flush();
    assert.equal(decodes.length, 4);
    assert.equal(h.requests.length, 4, "只有地址或 load 事件不能释放解码名额");
    await act(async () => decodes.forEach((resolve) => resolve())); await h.flush();
    assert.equal(h.requests.length, 7, "首批完成后后台最多三路，为可见页面保留名额");
    for (let pass = 0; pass < 4; pass++) {
      assert.ok(h.requests.filter((request) => !request.settled).length <= 4);
      await act(async () => h.requests.filter((request) => !request.settled).forEach((request) => h.finish(request)));
      await h.loadImages(); await h.flush();
    }
    const loaded = [...h.host.querySelectorAll(".slide-thumbnail > img:not(.slide-thumbnail-incoming)")];
    assert.equal(loaded.length, 12);
    assert.equal(h.requests.length, 12);
    await h.render({ ...result, rendered_at: "metadata-refresh" }, 11); await h.flush();
    assert.equal(h.requests.length, 12, "元数据刷新和跳页均复用已下载图片");
    assert.deepEqual([...h.host.querySelectorAll(".slide-thumbnail > img:not(.slide-thumbnail-incoming)")], loaded);
  } finally { await h.dispose(); }
});

test("滚入视口的页面占用预留名额，跳页后优先补齐当前页及其邻页", async () => {
  const h = mount();
  const result = metadata("/thumbnail-prefetch-priority");
  try {
    await h.render(result); await h.flush();
    await act(async () => h.finish(h.requests[0])); await h.loadImages(); await h.flush();
    assert.equal(h.requests.length, 4, "三张后台图片仍未完成，不能再启动第四张后台图片");
    await h.intersect(11); await h.flush();
    assert.equal(h.requests[4].input.page_id, "page-12", "滚到远端页面无需等待旧后台任务完成");
    await h.render(result, 11); await h.flush();
    assert.equal(h.requests.length, 5, "正在获取的当前页继续复用同一请求");
    assert.ok(h.preparations.some((input) => input.kind === "thumbnail" && input.page_id === "page-12" && input.priority === "foreground"));
    await act(async () => h.requests.filter((request) => !request.settled).forEach((request) => h.finish(request)));
    await h.loadImages(); await h.flush();
    assert.deepEqual(h.requests.slice(5).map((request) => request.input.page_id), ["page-11", "page-10", "page-9"]);
  } finally { await h.dispose(); }
});

test("离屏缩略图失败释放名额且不创建备用 iframe，页面版本变化只重新预取本页", async () => {
  const h = mount();
  const result = metadata("/thumbnail-prefetch-failure-version");
  try {
    await h.render(result); await h.flush();
    const late = h.requests[2];
    await act(async () => h.finish(h.requests[1], "", new Error("Thumbnail capture failed"))); await h.flush();
    assert.equal(h.requests.length, 5, "失败后继续预取其他页面");
    const failed = h.host.querySelectorAll(".thumb")[1];
    assert.equal(failed.querySelector("iframe"), null, "后台失败不能批量挂载 HTML 备用预览");
    assert.ok(failed.querySelector(".slide-thumbnail-error"));
    const updated = { ...result, slides: result.slides.map((slide, index) => index === 2 ? { ...slide, preview_version: "v2" } : slide) };
    await h.render(updated, 2); await h.flush();
    await act(async () => h.finish(late, "obsolete")); await h.flush();
    const newer = h.requests.find((request, index) => index > 2 && request.input.page_id === "page-3")!;
    assert.ok(newer);
    await act(async () => h.finish(newer, "new")); await h.loadImages(); await h.flush();
    const current = h.host.querySelectorAll(".thumb")[2].querySelector("img:not(.slide-thumbnail-incoming)")!;
    assert.equal(Buffer.from(current.getAttribute("src")!.split(",")[1], "base64").toString(), "page-3-new");
    assert.equal(h.requests.filter((request) => request.input.page_id === "page-1").length, 1);
    assert.equal(h.requests.filter((request) => request.input.page_id === "page-2").length, 1);
    await act(async () => h.root.unmount());
    const before = h.requests.length;
    await act(async () => h.requests.filter((request) => !request.settled).forEach((request) => h.finish(request)));
    await h.flush();
    assert.equal(h.requests.length, before, "离开作品后不再调度剩余页面");
  } finally { await h.dispose(); }
});

test("非结果页缩略图继续按视口加载", async () => {
  const h = mount();
  try {
    await act(async () => h.root.render(createElement(SlideThumbnail, {
      t: messages.zh, workspaceDir: "/thumbnail-lazy-cover", pageId: "page-1", version: "v1", title: "封面",
    })));
    await h.flush();
    assert.equal(h.requests.length, 0);
  } finally { await h.dispose(); }
});

test("图片解码失败只刷新一次，最终失败后继续其他缩略图", async () => {
  const h = mount();
  try {
    await h.render(metadata("/thumbnail-prefetch-image-retry")); await h.flush();
    await act(async () => h.requests.forEach((request) => h.finish(request)));
    const brokenImage = () => h.host.querySelectorAll(".thumb")[1].querySelector<HTMLImageElement>(".slide-thumbnail-incoming")!;
    brokenImage().decode = async () => { throw new Error("Invalid image bytes"); };
    await act(async () => brokenImage().dispatchEvent(new h.window.Event("load"))); await h.flush();
    assert.equal(h.requests.filter((request) => request.input.page_id === "page-2").length, 2);
    const retry = h.requests.find((request) => !request.settled && request.input.page_id === "page-2")!;
    await act(async () => h.finish(retry));
    brokenImage().decode = async () => { throw new Error("Still invalid"); };
    await act(async () => brokenImage().dispatchEvent(new h.window.Event("load"))); await h.flush();
    assert.equal(h.requests.filter((request) => request.input.page_id === "page-2").length, 2, "失败不能无限重试");
    assert.ok(h.requests.some((request) => request.input.page_id === "page-5"), "失败释放名额后继续后台预取");
    assert.ok(h.host.querySelectorAll(".thumb")[1].querySelector(".slide-thumbnail-error"));
  } finally { await h.dispose(); }
});

test("切换作品后从新作品当前页预取，旧作品的晚到响应不继续调度或展示", async () => {
  const h = mount();
  const previous = metadata("/thumbnail-prefetch-workspace-before");
  const current = metadata("/thumbnail-prefetch-workspace-after");
  try {
    await h.render(previous); await h.flush();
    await h.render(current, 8); await h.flush();
    const oldRequests = h.requests.filter((request) => request.input.workspace_dir === previous.workspace_dir);
    assert.equal(oldRequests.length, 4);
    await act(async () => oldRequests.forEach((request) => h.finish(request, "old-workspace"))); await h.flush();
    const newRequests = h.requests.filter((request) => request.input.workspace_dir === current.workspace_dir);
    assert.deepEqual(newRequests.map((request) => request.input.page_id), ["page-9", "page-10", "page-8", "page-11"]);
    assert.equal(h.requests.filter((request) => request.input.workspace_dir === previous.workspace_dir).length, 4);
    assert.equal(h.host.querySelector(".slide-thumbnail img"), null, "旧作品图片不能进入新作品");
    await act(async () => newRequests.forEach((request) => h.finish(request, "new-workspace")));
    await h.loadImages(); await h.flush();
    assert.ok([...h.host.querySelectorAll(".slide-thumbnail img")].every((image) =>
      Buffer.from(image.getAttribute("src")!.split(",")[1], "base64").toString().endsWith("new-workspace")));
  } finally { await h.dispose(); }
});
