import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { LazySlideHtml } from "../../src/features/deck-workspace/components/LazySlideHtml.tsx";
import { loadCachedPageHtml } from "../../src/features/deck-workspace/pageHtmlPreviewCache.ts";
import { pagePreviewKey } from "../../src/features/deck-workspace/pagePreviewWork.ts";
import { messages } from "../../src/i18n/messages.ts";

test("candidate keeps its rendered iframe across scrolling and metadata refresh, releases it on exit", async () => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const observers: Array<{ callback: (entries: Array<{ isIntersecting: boolean }>) => void; disconnected: boolean }> = [];
  install("window", window); install("document", document);
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("IntersectionObserver", class {
    entry: typeof observers[number];
    constructor(callback: typeof observers[number]["callback"]) { this.entry = { callback, disconnected: false }; observers.push(this.entry); }
    observe() {}
    disconnect() { this.entry.disconnected = true; }
  });
  install("ResizeObserver", class { observe() {} disconnect() {} });
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const props = { workspaceDir: "/candidate-workspace", pageId: "page-1", batchId: "batch-1", candidateId: "candidate-1",
    version: "v1", title: "候选 1", t: messages.zh };
  const key = pagePreviewKey(props.workspaceDir, { ...props, version: "batch-1:candidate-1:v1" });
  try {
    await loadCachedPageHtml(key, async () => ({ page_id: props.pageId, html: "<html><body>候选</body></html>",
      html_fingerprint: "html-v1", preview_source_fingerprint: "v1", resources_expires_at: null }));
    await act(async () => root.render(createElement(LazySlideHtml, props)));
    assert.equal(host.querySelector("iframe"), null);
    await act(async () => observers[0].callback([{ isIntersecting: true }]));
    const frame = host.querySelector("iframe");
    assert.ok(frame);
    await act(async () => frame.dispatchEvent(new window.Event("load")));
    assert.equal(observers[0].disconnected, true);
    await act(async () => observers[0].callback([{ isIntersecting: false }]));
    assert.equal(host.querySelector("iframe"), frame);
    await act(async () => root.render(createElement(LazySlideHtml, { ...props, title: "候选已完成" })));
    assert.equal(host.querySelector("iframe"), frame);
    await act(async () => observers[0].callback([{ isIntersecting: true }]));
    assert.equal(host.querySelector("iframe"), frame);
  } finally {
    await act(async () => root.unmount());
    assert.equal(host.querySelector("iframe"), null);
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
