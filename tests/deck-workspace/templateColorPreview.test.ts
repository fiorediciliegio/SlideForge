import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { messages } from "../../src/i18n/messages";
import type { VisualStylePreset } from "../../src/api/types";

let htmlLoads = 0;
const hooks = registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith("/templates/visualStylePresets.ts")) return result;
  return { ...result, source: `
    export const findVisualStylePreset = () => null;
    export const getVisualStylePresetColorVariants = (preset) => preset.color_variants ?? [];
    export const getVisualStylePresetFamilyId = (preset) => preset.id;
    export const isVisualStylePresetSelection = (id, preset) => id === preset.id;
    export const resolveVisualStylePresetColorVariant = (preset, id) => preset;
    export const getVisualStylePresetColorVariableOverrides = () => ({});
    export const loadVisualStylePresetReferenceHtmlPages = async () => {
      globalThis.__recordTemplatePreviewLoad();
      return [{ html: '<html><body><div class="slide">Preview</div></body></html>' }];
    };
  ` };
} });
const { BriefPage } = await import("../../src/features/deck-workspace/components/BriefPage");
hooks.deregister();

test("color preview waits for interaction and retains its loaded iframe", async () => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window, document, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} disconnect() {} },
    __recordTemplatePreviewLoad: () => { htmlLoads++; },
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const preset: VisualStylePreset = {
    id: "test", version: 1, ppt_number: 1, name: "Test", description: "Test",
    theme: "light", color: ["blue"], user: "Test", use_case: "Test", industry: "Test",
    preview_images: [{ url: "/cover.webp", alt: "Cover" }],
    reference_html_pages: [{ path: "html/cover.html", description: "Cover" }],
    color_variants: [
      { id: "blue", name: "Blue", swatches: ["#fff", "#00f"], roles: {} },
      { id: "green", name: "Green", swatches: ["#fff", "#0f0"], roles: {} },
    ],
  };
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(BriefPage, {
      t: messages.zh, prompt: "Test", setPrompt() {}, loading: "none",
      generateDeck: async () => {}, visualStylePresets: [preset],
      selectedVisualStylePresetId: null, onSelectVisualStylePreset() {},
      uploadedSources: [], uploadedSourcePreflights: [],
      uploadUploadedSource: async () => {}, removeUploadedSource: async () => {},
    })));
    assert.equal(htmlLoads, 0);
    assert.equal(host.querySelectorAll("iframe").length, 0);
    assert.ok(host.textContent.includes("2 套配色"));
    const swatches = host.querySelectorAll(".brief-style-preset-color-choice");
    await act(async () => swatches[0]!.dispatchEvent(new window.Event("focusin", { bubbles: true })));
    assert.equal(htmlLoads, 1);
    const frame = host.querySelector("iframe");
    assert.ok(frame);
    await act(async () => swatches[1]!.dispatchEvent(new window.Event("focusin", { bubbles: true })));
    assert.equal(htmlLoads, 1);
    assert.equal(host.querySelector("iframe"), frame);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
