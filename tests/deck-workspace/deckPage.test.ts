import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DeckPage } from "../../src/features/deck-workspace/components/DeckPage.tsx";
import type { DeckReviewRenderState } from "../../src/features/deck-workspace/types.ts";
import { messages } from "../../src/i18n/messages.ts";

const deck = [
  {
    title: "AI Foundations",
    subtitle: "template:cover-statement",
  },
  {
    title: "Market context",
    subtitle: "template:market-context",
  },
];

const loadingReviewRender: DeckReviewRenderState = {
  status: "loading",
  error: "",
  renderKey: "loading",
  result: null,
};

function renderDeckPage(reviewRender: DeckReviewRenderState = loadingReviewRender) {
  return renderToStaticMarkup(
    createElement(DeckPage, {
      t: messages.zh,
      deck,
      currentSlide: 0,
      setCurrentSlide: () => undefined,
      reviewRender,
      loading: "none",
      onRefineDeck: () => undefined,
      onRefineSlide: () => undefined,
      onBeautifyPage: () => undefined,
      onRegeneratePage: () => undefined,
      canRegeneratePage: true,
      onPreview: () => undefined,
      onBack: () => undefined,
      onExport: () => undefined,
      onEdit: () => undefined,
    }),
  );
}

function renderDeckPageAtSlide(currentSlide: number, reviewRender: DeckReviewRenderState) {
  return renderToStaticMarkup(
    createElement(DeckPage, {
      t: messages.zh,
      deck,
      currentSlide,
      setCurrentSlide: () => undefined,
      reviewRender,
      loading: "none",
      onRefineDeck: () => undefined,
      onRefineSlide: () => undefined,
      onBeautifyPage: () => undefined,
      onRegeneratePage: () => undefined,
      canRegeneratePage: true,
      onPreview: () => undefined,
      onBack: () => undefined,
      onExport: () => undefined,
      onEdit: () => undefined,
    }),
  );
}

const partialReviewRender: DeckReviewRenderState = {
  status: "ready",
  error: "",
  renderKey: "partial",
  result: {
    workspace_dir: "/tmp/workspace",
    title: "AI Foundations",
    slide_count: 2,
    output_dir: "/tmp/workspace/rendered",
    deck_html_path: "/tmp/workspace/rendered/deck.html",
    slides: [
      {
        page_id: "page-01",
        index: 0,
        title: "AI Foundations",
        html_path: "/tmp/workspace/rendered/page-01.html",
        screenshot_path: "/tmp/workspace/rendered/page-01.png",
        screenshot_upload: {
          transport: "host_upload",
          r2_key: "preview/page-01.png",
          url: "https://example.com/page-01.png",
          mime_type: "image/png",
          size_bytes: 1024,
        },
      },
      {
        page_id: "page-02",
        index: 1,
        title: "Market context",
        html_path: "/tmp/workspace/rendered/page-02.html",
        screenshot_path: "/tmp/workspace/rendered/page-02.png",
      },
    ],
  },
};

describe("DeckPage", () => {
  it("shows a loading preview instead of the text fallback while screenshots are rendering", () => {
    const html = renderDeckPage();

    assert.match(html, /slide-preview-loading/);
    assert.match(html, new RegExp(`role="status"[^>]*aria-label="${messages.zh.review.previewLoading}"`));
    assert.doesNotMatch(html, /slide-preview-card large/);
    assert.doesNotMatch(html, /template:cover-statement/);
  });

  it("keeps a later page in a loading frame while its screenshot is still arriving", () => {
    const html = renderDeckPageAtSlide(1, partialReviewRender);

    assert.match(html, /deck-stage-html-frame[\s\S]*slide-preview-loading/);
    assert.doesNotMatch(html, /slide-preview-card/);
    assert.match(html, /thumbnail-strip[\s\S]*thumb-html-frame[\s\S]*slide-preview-loading/);
  });

  it("does not render the deck title row under the main preview", () => {
    const html = renderDeckPage();

    assert.doesNotMatch(html, /deck-title-label/);
    assert.doesNotMatch(html, /AI Deck/);
    assert.doesNotMatch(html, /deck-title-editor/);
    assert.doesNotMatch(html, /aria-label="Deck title"/);
  });

  it("shows the current-page refinement entry while keeping deck-wide refinement hidden", () => {
    const html = renderDeckPage();

    assert.match(html, new RegExp(messages.zh.controls.refineSlide));
    assert.doesNotMatch(html, /优化整套/);
    assert.doesNotMatch(html, /复制页面|删除页面|更改布局/);
  });

  it("opens the top actions row with a back entry", () => {
    const html = renderDeckPage();

    assert.match(html, /deck-top-actions"><button [^>]*class="secondary-btn deck-back-btn"/);
    assert.match(html, new RegExp(`deck-back-btn[\\s\\S]*${messages.zh.controls.back}`));
  });

  it("drops the unlabelled preview refresh button from the top actions", () => {
    const html = renderDeckPage();

    assert.doesNotMatch(html, /deck-refresh-btn/);
    assert.doesNotMatch(html, /重新渲染/);
  });

  it("shows the HTML manual editor entry", () => {
    const zh = renderDeckPage();
    const en = renderToStaticMarkup(
      createElement(DeckPage, {
        t: messages.en,
        deck,
        currentSlide: 0,
        setCurrentSlide: () => undefined,
        reviewRender: loadingReviewRender,
        loading: "none",
        onRefineDeck: () => undefined,
        onRefineSlide: () => undefined,
      onBeautifyPage: () => undefined,
      onRegeneratePage: () => undefined,
      canRegeneratePage: true,
        onPreview: () => undefined,
        onBack: () => undefined,
        onExport: () => undefined,
        onEdit: () => undefined,
      }),
    );

    assert.match(zh, new RegExp(`aria-label="${messages.zh.controls.edit}"`));
    assert.match(en, new RegExp(`aria-label="${messages.en.controls.edit}"`));
    assert.match(zh, /编辑/);
    assert.match(en, /Edit/);
  });

  it("keeps preview and export in the top row and preserves page actions without duplication", () => {
    const html = renderDeckPage();
    const topActions = html.slice(html.indexOf(`class="deck-top-actions"`), html.indexOf(`class="slide-navigator`));
    const bar = html.slice(html.indexOf(`class="action-bar"`));

    for (const icon of ["lucide-eye", "lucide-download"]) {
      assert.match(topActions, new RegExp(icon), icon);
    }
    assert.match(bar, /lucide-pen-line/);
    assert.match(bar, /lucide-sparkles/);
    for (const action of ["deck.manual-edit", "deck.refine-page", "deck.beautify-page", "deck.regenerate-alternatives"]) {
      assert.equal(html.split(`data-performance-id="${action}"`).length - 1, 1, action);
      assert.ok(bar.includes(`data-performance-id="${action}"`), action);
    }
    assert.match(bar, new RegExp(messages.zh.pageBeautification.button));
    assert.match(bar, new RegExp(messages.zh.pageRegeneration.button));
  });

  it("uses sidebar thumbnails without a separate pagination row", () => {
    const html = renderDeckPage();

    assert.match(html, /thumbnail-strip vertical/);
    assert.match(html, /data-performance-id="deck.thumbnail.select"/);
    assert.doesNotMatch(html, /class="preview-controls"|class="slide-counter"/);
    assert.doesNotMatch(html, /data-performance-id="deck.slide.(previous|next)"/);
  });
});
