import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import type { BriefPageProps } from "../../src/features/deck-workspace/components/BriefPage.tsx";
import { withEmptyVisualStyleCatalog } from "../helpers/emptyVisualStyleCatalog";
const { BriefPage } = await withEmptyVisualStyleCatalog(() => import("../../src/features/deck-workspace/components/BriefPage.tsx"));
import { messages } from "../../src/i18n/messages.ts";
import { SLIDE_FORMATS, type SlideAspectRatio } from "../../src/slideFormat.ts";
import { createRequirementsDraft } from "../../src/features/requirements/presentationRequirements.ts";
import { buildPageHtmlPrompt, buildPageHtmlRefinementPrompt, buildVisualMasterHtmlPrompt } from "../../src/features/deck-generation/htmlPrompts.ts";
import { buildPageLayoutRewritePrompt } from "../../src/features/deck-generation/pageLayoutRewrite.ts";
import { authoringDeckFromConfirmedOutline } from "../../src/features/deck-generation/deckGenerationStartArtifacts.ts";
import type { WorkspaceOutline } from "../../src/api/types.ts";

const briefProps: BriefPageProps = {
  t: messages.zh, prompt: "Test", setPrompt() {}, loading: "none", generateDeck: async () => {},
  onAspectRatioChange() {}, visualStylePresets: [], selectedVisualStylePresetId: null,
  onSelectVisualStylePreset() {}, uploadedSources: [], uploadedSourcePreflights: [],
  uploadUploadedSource: async () => {}, removeUploadedSource: async () => {},
};

for (const locale of ["zh", "en"] as const) {
  for (const aspectRatio of Object.keys(SLIDE_FORMATS) as SlideAspectRatio[]) {
    test(`${locale}: homepage preserves ${aspectRatio} and shows only ratios for its orientation`, () => {
      const html = renderToStaticMarkup(createElement(BriefPage, { ...briefProps, t: messages[locale], aspectRatio }));
      const { document } = parseHTML(html);
      const format = document.querySelector(".brief-page-format")!;
      const select = format.querySelector("select")!;
      assert.equal(select.querySelector("option[selected]")?.textContent, aspectRatio);
      assert.deepEqual(Array.from(select.querySelectorAll("option"), (option) => option.textContent),
        ["16:9", "4:3"].includes(aspectRatio) ? ["16:9", "4:3"] : ["9:16", "3:4"]);
      assert.equal(format.querySelector('[role="group"]')?.getAttribute("aria-label"), messages[locale].brief.pageOrientation);
      assert.equal(select.getAttribute("aria-label"), messages[locale].brief.pageAspectRatio);
      assert.ok(!format.textContent.includes(messages[locale].brief.pageOrientation));
      assert.ok(!format.textContent.includes(messages[locale].brief.pageAspectRatio));
      assert.equal(format.parentElement, document.querySelector(".prompt-inline-actions"));
      assert.ok(html.includes(messages[locale].brief.portrait));
      assert.ok(html.includes(messages[locale].brief.landscape));
      assert.doesNotMatch(format.textContent, /1920|1080|1440/);
    });
  }
}

test("orientation changes preserve the ratio family and locked or busy controls cannot change it", async () => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const selected: SlideAspectRatio[] = [];
  const render = async (aspectRatio: SlideAspectRatio, overrides: Partial<BriefPageProps> = {}) => {
    await act(async () => root.render(createElement(BriefPage, {
      ...briefProps, aspectRatio, onAspectRatioChange: (ratio) => selected.push(ratio), ...overrides,
    })));
  };
  try {
    for (const [from, to] of [["16:9", "9:16"], ["9:16", "16:9"], ["4:3", "3:4"], ["3:4", "4:3"]] as const) {
      await render(from);
      const previousCount = selected.length;
      await act(async () => host.querySelector<HTMLButtonElement>('.brief-page-orientation button[aria-pressed="true"]')!.click());
      assert.equal(selected.length, previousCount);
      await act(async () => host.querySelector<HTMLButtonElement>('.brief-page-orientation button[aria-pressed="false"]')!.click());
      assert.equal(selected.at(-1), to);
      await render(to);
      assert.equal(host.querySelector(".brief-page-ratio-select option[selected]")?.textContent, to);
    }
    for (const overrides of [{ aspectRatioLocked: true }, { loading: "requirements" as const }]) {
      await render("4:3", overrides);
      const previousCount = selected.length;
      const controls = host.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(".brief-page-format button, .brief-page-format select");
      assert.equal(controls.length, 3);
      for (const control of controls) {
        assert.equal(control.disabled, true);
        await act(async () => control.click());
      }
      assert.equal(selected.length, previousCount);
    }
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("master, page, refinement, and layout repair share the chosen canvas for every format", () => {
  const outline: WorkspaceOutline = {
    version: 4, status: "confirmed", title: "Test", updated_at: null, confirmed_at: null,
    items: [{ page_id: "page-test", page_type: "standard", title: "Test", content: "Test", creation_requirements: "文案一字不改" }],
  };
  const page = authoringDeckFromConfirmedOutline(outline).pages[0]!;
  for (const aspectRatio of Object.keys(SLIDE_FORMATS) as SlideAspectRatio[]) {
    const { width, height } = SLIDE_FORMATS[aspectRatio];
    const requirements = createRequirementsDraft("Test", { slide_count: [1], output_language: ["中文"] });
    requirements.selections.aspect_ratio = aspectRatio;
    const pageInput = { aspectRatio, outline, page, visualMasterHtml: "MASTER", referenceHtml: "REFERENCE" };
    const prompts = [
      buildVisualMasterHtmlPrompt({ requirements, outline, referenceHtml: "REFERENCE" }),
      buildPageHtmlPrompt(pageInput),
      buildPageHtmlRefinementPrompt({ ...pageInput, originalHtml: "ORIGINAL", refinementRequest: "Improve" }),
      buildPageLayoutRewritePrompt("ORIGINAL", aspectRatio),
    ];
    for (const prompt of prompts) assert.ok(prompt.includes(`${width}×${height}`));
    if (aspectRatio !== "16:9") for (const prompt of prompts) assert.doesNotMatch(prompt, /固定为 1920×1080/);
  }
});
