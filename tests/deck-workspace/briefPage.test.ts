import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { VisualStylePreset } from "../../src/api/types.ts";
import { withEmptyVisualStyleCatalog } from "../helpers/emptyVisualStyleCatalog";
const { BriefPage } = await withEmptyVisualStyleCatalog(() => import("../../src/features/deck-workspace/components/BriefPage.tsx"));
import type { LoadingKind } from "../../src/features/deck-workspace/types.ts";
import { messages } from "../../src/i18n/messages.ts";

const presets: VisualStylePreset[] = [
  {
    id: "aurora-consulting",
    version: 1,
    ppt_number: 1,
    score: 90,
    name: "Aurora Consulting",
    description: "A light consulting presentation.",
    user: "Business Professionals",
    use_case: "Reports & Analysis",
    industry: "Business & Finance",
    theme: "light",
    color: ["blue"],
    preview_images: [
      { url: "/previews/aurora-cover.webp", alt: "Aurora cover" },
      { url: "/previews/aurora-detail.webp", alt: "Aurora detail" },
    ],
    reference_html_pages: [
      { path: "html/aurora-cover.html", description: "Cover" },
      { path: "html/aurora-detail.html", description: "Detail" },
    ],
  },
  {
    id: "midnight-product",
    version: 1,
    ppt_number: 2,
    score: 80,
    name: "Midnight Product",
    description: "A dark product launch presentation.",
    user: "Product Teams",
    use_case: "Launches",
    industry: "Technology",
    theme: "dark",
    color: ["purple"],
    preview_images: [{ url: "/previews/midnight-cover.webp", alt: "Midnight cover" }],
    reference_html_pages: [{ path: "html/midnight-cover.html", description: "Cover" }],
  },
];

function renderBriefPage(options: {
  loading?: LoadingKind;
  selectedVisualStylePresetId?: string | null;
  onForward?: () => void;
} = {}) {
  return renderToStaticMarkup(
    createElement(BriefPage, {
      t: messages.zh,
      prompt: "Generate a presentation about AI.",
      setPrompt: () => undefined,
      loading: options.loading ?? "none",
      generateDeck: async () => undefined,
      visualStylePresets: presets,
      selectedVisualStylePresetId: options.selectedVisualStylePresetId ?? null,
      onSelectVisualStylePreset: () => undefined,
      uploadedSources: [],
      uploadedSourcePreflights: [],
      uploadUploadedSource: async () => undefined,
      removeUploadedSource: async () => undefined,
      onForward: options.onForward,
    }),
  );
}

describe("BriefPage template previews", () => {
  it("keeps the composer and optional stage navigation in the main layout", () => {
    const html = renderBriefPage({ onForward: () => undefined });

    assert.match(html, /class="page active brief-page"/);
    assert.match(html, /class="prompt-label"/);
    assert.match(html, /class="prompt-input-wrapper"/);
    assert.match(html, /class="prompt-input"/);
    assert.match(html, /class="prompt-inline-actions"/);
    assert.match(html, /class="inline-attach-btn"/);
    assert.match(html, /class="inline-create-btn"/);
    assert.match(html, /data-performance-id="brief\.forward"/);
    assert.match(html, />前进</);
  });

  it("uses preview_images[0] as the lazy-loaded template card cover", () => {
    const html = renderBriefPage();

    assert.match(html, /src="\/previews\/aurora-cover\.webp"/);
    assert.doesNotMatch(html, /src="\/previews\/aurora-detail\.webp"/);
    assert.match(html, /src="\/previews\/aurora-cover\.webp"[^>]*loading="lazy"/);
  });

  it("allows PDF files in the attachment picker", () => {
    const html = renderBriefPage();

    assert.match(html, /type="file"[^>]*accept="[^"]*\.pdf[^"]*"/);
    assert.match(html, /accept="[^"]*application\/pdf[^"]*"/);
  });

  it("keeps the card action as a preview dialog, not immediate selection", () => {
    const html = renderBriefPage();

    assert.match(html, /data-performance-id="brief\.visual-style\.preview"[^>]*aria-haspopup="dialog"/);
    assert.doesNotMatch(html, /brief\.visual-style\.select/);
  });

  it("keeps untouched template cards free of live iframe previews", async () => {
    const componentSource = await readFile(
      new URL("../../src/features/deck-workspace/components/BriefPage.tsx", import.meta.url),
      "utf8",
    );

    assert.doesNotMatch(componentSource, /preloadPresetPreviews/);
    assert.doesNotMatch(renderBriefPage(), /<iframe/);
  });

  it("retains the template grid while generation is disabled", () => {
    const html = renderBriefPage({ loading: "requirements" });

    assert.match(html, /brief-style-preset-grid/);
    assert.match(html, /data-performance-id="brief\.visual-style\.preview"[^>]*disabled=""/);
    assert.match(html, /class="inline-create-btn"[^>]*disabled=""/);
  });

  it("marks the selected preset without hiding the other cards", () => {
    const html = renderBriefPage({ selectedVisualStylePresetId: "midnight-product" });

    assert.match(html, /brief-style-preset-card active/);
    assert.match(html, /class="brief-style-preset-selected"/);
    assert.match(html, /class="brief-style-preset-accessible-name">Midnight Product<\/span>/);
  });

  it("offers an all option for each style filter", () => {
    const html = renderBriefPage();
    const filterBlock = /class="brief-style-preset-filters"[\s\S]*?class="brief-style-preset-grid"/
      .exec(html)?.[0] ?? "";

    assert.equal((filterBlock.match(/<option value=""[^>]*>全部<\/option>/g) ?? []).length, 5);
  });
});
