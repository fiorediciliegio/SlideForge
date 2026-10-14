import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DeckPreviewCanvas } from "../../src/features/deck-workspace/components/DeckPreviewCanvas.tsx";
import { SlideAspectRatioContext, SLIDE_FORMATS, type SlideAspectRatio } from "../../src/slideFormat.ts";
import { messages, type Locale } from "../../src/i18n/messages.ts";

test("result preview fits every format and preserves zoom and mounted content across page changes", async () => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  let resize: (entries: Array<{ contentRect: { width: number; height: number } }>) => void;
  let disconnected = false;
  install("window", window);
  install("document", document);
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("ResizeObserver", class {
    constructor(callback: typeof resize) { resize = callback; }
    observe() { resize([{ contentRect: { width: 1200, height: 720 } }]); }
    disconnect() { disconnected = true; }
  });
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const render = (format: SlideAspectRatio, pageId = "page-1", locale: Locale = "zh") => act(async () => {
    root.render(createElement(SlideAspectRatioContext.Provider, { value: format },
      createElement(DeckPreviewCanvas, { t: messages[locale], pageId, children: createElement("iframe", { title: "preview" }) })));
  });
  const button = (action: string) => host.querySelector<HTMLButtonElement>(`[data-performance-id="deck.zoom.${action}"]`)!;
  const page = () => host.querySelector<HTMLElement>(".deck-preview-scaled-page")!;
  const percentage = () => host.querySelector("[aria-live]")!.textContent;
  try {
    for (const format of Object.keys(SLIDE_FORMATS) as SlideAspectRatio[]) {
      await render(format);
      const width = parseFloat(page().style.width);
      const height = parseFloat(page().style.height);
      assert.ok(width <= 1200 && height <= 720, `${format} must fit both dimensions`);
      assert.ok(Math.abs(width / height - SLIDE_FORMATS[format].width / SLIDE_FORMATS[format].height) < 0.001);
    }

    await render("9:16");
    const frame = host.querySelector("iframe");
    await act(async () => button("in").click());
    assert.ok(parseFloat(page().style.height) > 720, "portrait page must grow beyond the viewport");
    assert.equal(button("fit").getAttribute("aria-pressed"), "false");
    const zoomedWidth = page().style.width;
    const zoomedPercentage = percentage();
    const viewport = host.querySelector<HTMLElement>(".deck-preview-viewport")!;
    viewport.scrollTop = 200;
    viewport.scrollLeft = 100;
    await render("9:16", "page-2", "en");
    assert.equal(page().style.width, zoomedWidth);
    assert.equal(percentage(), zoomedPercentage);
    assert.equal(viewport.scrollTop, 0);
    assert.equal(viewport.scrollLeft, 0);
    assert.equal(host.querySelector("iframe"), frame, "zoom and page selection must not remount previews");
    assert.equal(button("in").getAttribute("aria-label"), messages.en.deck.zoomIn);

    await act(async () => resize([{ contentRect: { width: 0, height: 0 } }]));
    assert.equal(percentage(), zoomedPercentage, "hiding the retained result page must not reset zoom");
    await act(async () => resize([{ contentRect: { width: 800, height: 600 } }]));
    assert.equal(page().style.width, zoomedWidth, "manual zoom survives viewport resizing");
    await act(async () => button("fit").click());
    assert.equal(parseFloat(page().style.height), 600);
    assert.equal(button("fit").getAttribute("aria-pressed"), "true");

    // Fit can legitimately be below the normal manual minimum in a tiny
    // viewport; pressing minus must never make such a page larger.
    await act(async () => resize([{ contentRect: { width: 100, height: 96 } }]));
    assert.equal(percentage(), "5%");
    assert.equal(button("out").disabled, true);
    await act(async () => button("in").click());
    await act(async () => button("out").click());
    assert.equal(percentage(), "5%");

    for (let i = 0; i < 25; i++) await act(async () => button("in").click());
    assert.equal(percentage(), "200%");
    assert.equal(button("in").disabled, true);
  } finally {
    await act(async () => root.unmount());
    assert.equal(disconnected, true);
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
