import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { WorkspacePageHtml } from "../../src/api/pageHtmlPreview.ts";
import { RenderedSlideHtml } from "../../src/features/deck-workspace/components/RenderedSlideHtml.tsx";
import { loadCachedPageHtml } from "../../src/features/deck-workspace/pageHtmlPreviewCache.ts";
import { pagePreviewKey } from "../../src/features/deck-workspace/pagePreviewWork.ts";
import { messages } from "../../src/i18n/messages.ts";
import { DeckPage } from "../../src/features/deck-workspace/components/DeckPage.tsx";
import { withOrdinaryInvokeTransport } from "../helpers/invokeRuntime.ts";

test("foreground HTML is visible before load, while slow images keep preparation bounded", async () => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  install("window", window);
  install("document", document);
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("ResizeObserver", class { observe() {} disconnect() {} });
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const workspaceDir = "/progressive-result-preview";
  const pages = Array.from({ length: 8 }, (_, index) => ({ pageId: `p${index}`, title: `第 ${index + 1} 页`, version: "v1" }));
  const content = (index: number): WorkspacePageHtml => ({
    page_id: pages[index].pageId,
    html: `<html><body>第 ${index + 1} 页<img src="https://example.test/slow-image.jpg" /></body></html>`,
    html_fingerprint: `html-${index}`, preview_source_fingerprint: "v1", resources_expires_at: null,
  });
  let deliverFirst!: (value: WorkspacePageHtml) => void;
  let settled = 0;
  const onSettled = () => { settled++; };
  const render = (index: number) => act(async () => root.render(createElement(RenderedSlideHtml, {
    workspaceDir, pages, ...pages[index], t: messages.zh, onSettled, preservePreviousPreview: false,
  })));
  const frame = (index: number) => host.querySelector<HTMLIFrameElement>(`iframe[title="${pages[index].title}"]`)!;
  const visible = () => [...host.querySelectorAll<HTMLIFrameElement>("iframe")].filter((entry) => entry.style.visibility === "visible");
  const overlay = () => host.querySelector(".static-html-preview-overlay");
  try {
    const first = loadCachedPageHtml(pagePreviewKey(workspaceDir, pages[0]),
      () => new Promise<WorkspacePageHtml>((resolve) => { deliverFirst = resolve; }));
    await Promise.all(pages.slice(1).map((page, index) => loadCachedPageHtml(pagePreviewKey(workspaceDir, page), async () => content(index + 1))));
    await render(0);
    assert.ok(overlay(), "HTML acquisition still has a loading indicator");
    assert.equal(host.querySelectorAll("iframe").length, 3, "background work leaves room for the current page");
    assert.equal(visible().length, 0);

    await act(async () => { deliverFirst(content(0)); await first; });
    const firstFrame = frame(0);
    assert.ok(firstFrame);
    assert.equal(overlay(), null, "slow images must not obscure available content");
    assert.deepEqual(visible(), [firstFrame]);
    assert.equal(host.querySelector(".static-html-preview")?.getAttribute("aria-busy"), "false");
    assert.equal(settled, 0, "showing content must not release its preparation slot");
    assert.equal(host.querySelectorAll("iframe").length, 4);

    await render(7);
    assert.deepEqual(visible(), [frame(7)], "a jump can display HTML before any previous iframe loads");
    assert.equal(overlay(), null);
    assert.equal(host.querySelectorAll("iframe").length, 4);
    await act(async () => firstFrame.dispatchEvent(new window.Event("load")));
    assert.deepEqual(visible(), [frame(7)], "a late load must not steal foreground selection");
    assert.equal(settled, 0);

    await render(0);
    assert.equal(frame(0), firstFrame, "already loaded pages are reused");
    assert.equal(settled, 1);
    for (const index of [6, 4, 2, 7]) {
      await render(index);
      assert.deepEqual(visible(), [frame(index)]);
      assert.equal(overlay(), null);
      assert.equal(frame(0), firstFrame);
      assert.ok(host.querySelectorAll("iframe").length <= 5, "one loaded page plus at most four unfinished frames");
      assert.equal(settled, 1);
    }
    await act(async () => frame(7).dispatchEvent(new window.Event("load")));
    assert.equal(settled, 2, "load completes preparation independently of visibility");
    assert.deepEqual(visible(), [frame(7)]);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("资源解析超时时显示重试入口，不打开页面恢复弹窗", async () => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  install("window", window); install("document", document); install("IS_REACT_ACT_ENVIRONMENT", true);
  install("ResizeObserver", class { observe() {} disconnect() {} });
  const workspaceDir = "/timeout-result-preview";
  const pageId = "timeout-page";
  let recoveryChecks = 0;
  window.__ANNA_TOOL_IDS__ = { "ppt-engine": "test-engine" };
  window.AnnaAppRuntime = { connect: async () => ({ tools: { invoke: withOrdinaryInvokeTransport(async (input) => {
    if (input.method === "app_prepare_workspace_page_preview") return { success: true, data: {
      task_id: "prepared", workspace_dir: workspaceDir, page_id: pageId, status: "ready", input_version: "current",
    } };
    if (input.method === "app_get_workspace_page_html") throw new Error("Preview request timed out");
    if (input.method === "app_append_workspace_log") return { success: true, data: { appended: true } };
    if (input.method === "app_prepare_page_recovery") { recoveryChecks++; throw new Error("Recovery must not be checked"); }
    throw new Error(`Unexpected method ${input.method}`);
  }) } }) as any };
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(RenderedSlideHtml, {
      workspaceDir, pageId, version: "v1", title: "超时页面", t: messages.zh,
    })));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert.equal(host.querySelector("dialog"), null);
    assert.ok(host.textContent?.includes(messages.zh.review.previewFailed));
    assert.ok(host.querySelector("button"), "失败后应提供重试按钮");
    assert.equal(recoveryChecks, 0);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("确认恢复后可编辑和优化，取消保留入口，不自动展示旧版", async () => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  install("window", window); install("document", document); install("IS_REACT_ACT_ENVIRONMENT", true);
  install("ResizeObserver", class { observe() {} disconnect() {} });
  install("IntersectionObserver", class { observe() {} disconnect() {} });
  // linkedom has no native modal top layer; only emulate open/close, not browser layout.
  window.HTMLElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute("open"); };
  const workspaceDir = "/confirmed-dom-review";
  const pageId = "page-11111111-1111-4111-8111-111111111111";
  let restored = false;
  let commits = 0;
  let clicked = 0;
  const events: string[] = [];
  const calls: string[] = [];
  window.__ANNA_TOOL_IDS__ = { "ppt-engine": "test-engine" };
  window.AnnaAppRuntime = { connect: async () => ({ tools: { invoke: withOrdinaryInvokeTransport(async (input) => {
    calls.push(input.method);
    if (input.method === "app_run_workspace_snapshot_publish_dedicated_invoke") return { success: true, data: { status: "completed" } };
    if (input.method === "app_prepare_workspace_page_preview") return { success: true, data: {
      task_id: "prepared", workspace_dir: workspaceDir, page_id: pageId, status: "ready", input_version: "current",
    } };
    if (input.method === "app_append_workspace_log") {
      events.push((input.args as any).entry.event);
      return { success: true, data: { appended: true } };
    }
    if (input.method === "app_prepare_page_recovery") return { success: true, data: {
      workspace_dir: workspaceDir, page_id: pageId, available: true, source: "manual_base", recovery_token: "a".repeat(64),
    } };
    if (input.method === "app_restore_page_source_version") {
      assert.equal((input.args as any).recovery_token, "a".repeat(64));
      commits++; restored = true;
      return { success: true, data: { workspace_dir: workspaceDir, page_id: pageId, restored: true,
        html_path: "recovered", preview_source_fingerprint: "new", page_progress_updated_at: "now" } };
    }
    if (input.method === "app_get_workspace_page_html") {
      assert.equal((input.args as any).fallback_only, undefined);
      if (!restored) throw new Error("Page preview version changed");
      return { success: true, data: { page_id: pageId, html: "<html><body>正式恢复的画面</body></html>",
        html_fingerprint: "html", preview_source_fingerprint: "new", resources_expires_at: null } };
    }
    throw new Error(`Unexpected method ${input.method}`);
  }) } }) as any };
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const noop = () => undefined;
  const render = (enabled = true) => act(async () => root.render(createElement(DeckPage, {
    recoveryEnabled: enabled,
    t: messages.zh, deck: [{ title: "测试页", subtitle: "" }], currentSlide: 0, setCurrentSlide: noop,
    reviewRender: { status: "ready", error: "", renderKey: "v1", result: { workspace_dir: workspaceDir,
      manifest_path: "manifest", output_dir: "output", deck_html_path: "deck", title: "测试", slide_count: 1,
      rendered_at: "", slides: [{ slide_id: pageId, title: "测试页", layout_id: pageId, html_path: "snapshot", speaker_note: "" }] } },
    loading: "none", onPreview: noop, onBack: noop, onRefineSlide: noop, onRegeneratePage: () => { clicked++; },
    onBeautifyPage: () => { clicked++; }, canRegeneratePage: true, onRefineDeck: noop, onExport: noop, onEdit: () => { clicked++; },
  })));
  const click = (id: string) => act(async () => { host.querySelector(`[data-performance-id="${id}"]`)!.dispatchEvent(new window.Event("click", { bubbles: true })); });
  try {
    await render(false);
    assert.equal(host.querySelector("dialog"), null, "hidden retained Deck must not prompt");
    assert.equal(calls.includes("app_prepare_page_recovery"), false);
    await render();
    assert.ok(host.querySelector("dialog[open]"));
    assert.ok(host.textContent?.includes(messages.zh.review.previewRecoveryManualBase));
    assert.equal(host.querySelector("iframe"), null, "no automatic old-version preview");
    assert.equal(commits, 0, "opening the dialog is read-only");
    const edit = () => host.querySelector<HTMLButtonElement>('[data-performance-id="deck.manual-edit"]')!;
    assert.equal(edit().disabled, true);
    await click("preview.recovery.cancel");
    assert.equal(host.querySelector("dialog"), null);
    assert.ok(host.querySelector('[data-performance-id="preview.recovery.open"]'));
    assert.equal(commits, 0);
    await render(false); await render();
    assert.equal(host.querySelector("dialog"), null, "cancellation survives remounts");
    await click("preview.recovery.open");
    assert.ok(host.querySelector("dialog[open]"));
    await click("preview.recovery.confirm");
    assert.equal(commits, 1);
    assert.equal(host.querySelector("dialog"), null);
    const frame = host.querySelector("iframe")!;
    assert.ok((frame.getAttribute("srcDoc") ?? frame.getAttribute("srcdoc"))?.includes("正式恢复的画面"));
    assert.equal(edit().disabled, false);
    for (const id of ["deck.manual-edit", "deck.beautify-page", "deck.regenerate-alternatives"]) {
      assert.equal(host.querySelector<HTMLButtonElement>(`[data-performance-id="${id}"]`)!.disabled, false);
      await click(id);
    }
    assert.equal(clicked, 3);
    assert.ok(events.includes("preview.failed"));
    assert.ok(events.includes("preview.cancelled"));
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
