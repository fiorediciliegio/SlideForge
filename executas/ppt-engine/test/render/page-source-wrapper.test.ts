import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHtmlPageSourceDocumentHtml,
  createPageSourceRenderContext,
} from "../../src/render/page-source-document.ts";
import { buildStaticDeckHtml } from "../../src/render/build-deck.ts";

const PAGE_ID = "page-11111111-1111-4111-8111-111111111111";

test("HTML page source keeps the authored slide separate from the engine wrapper", () => {
  const html = buildHtmlPageSourceDocumentHtml({
    context: createPageSourceRenderContext({
      id: PAGE_ID,
      title: "Wrapper contract",
      pageNumber: 1,
      totalPages: 1,
    }),
    sourceHtml: `<!doctype html><html><head><style>.slide{display:flex;padding:60px 80px}</style></head><body><main class="slide">content</main></body></html>`,
    tailwindRuntimeBundle: "",
  });

  assert.match(html, /#presentation-slides-wrapper\{[^}]*display:block!important/);
  assert.match(html, /data-presenton-authored-slide/);
  assert.match(html, /const wrapper=document\.createElement\("div"\)/);
  assert.match(html, /const shell=document\.createElement\("div"\)/);
  assert.match(html, /shell\.setAttribute\("data-presenton-slide-shell","true"\)/);
  assert.match(html, /shell\.append\(slide\)/);
  assert.match(html, /wrapper\.append\(shell\)/);
  assert.doesNotMatch(html, /slide\.setAttribute\("data-presenton-slide-shell","true"\)/);
});

test("static Deck keeps the per-page shell around the authored slide", () => {
  const page = `<!doctype html><html><head><style>[data-presenton-page-id="${PAGE_ID}"]{display:flex;justify-content:center}[data-presenton-page-id="${PAGE_ID}"] .slide{padding:60px 80px}</style></head><body><div id="presentation-slides-wrapper" data-presenton-render-status="ready"><div data-presenton-slide-shell="true" data-presenton-page-id="${PAGE_ID}" style="display:block"><main class="slide" data-presenton-authored-slide="true" style="padding:60px 80px"><div>content</div></main></div></div></body></html>`;
  const deck = buildStaticDeckHtml({ title: "Wrapper contract", pages: [page] });

  assert.equal((deck.match(/id="presentation-slides-wrapper"/g) ?? []).length, 1);
  assert.match(deck, /<div data-presenton-slide-shell="true" data-presenton-page-id="[^"]+"[^>]*>\s*<main class="slide"/);
  assert.match(deck, new RegExp(`data-presenton-page-id="${PAGE_ID}"\\]\\{display:flex`));
  assert.match(deck, new RegExp(`data-presenton-page-id="${PAGE_ID}"\\] \\.slide\\{padding:60px 80px\\}`));
  assert.doesNotMatch(deck, /<div id="presentation-slides-wrapper"[^>]*>\s*<div id="presentation-slides-wrapper"/);
});

test("static Deck keeps one copy of shared external stylesheets", () => {
  const pageOne = `<!doctype html><html><head><link rel="stylesheet" href="https://fonts.example.test/shared.css"><style>.one{color:red}</style></head><body><div data-presenton-slide-shell="true"><main class="one">one</main></div></body></html>`;
  const pageTwo = `<!doctype html><html><head><link href="https://fonts.example.test/shared.css" rel="stylesheet"><style>.two{color:blue}</style></head><body><div data-presenton-slide-shell="true"><main class="two">two</main></div></body></html>`;
  const deck = buildStaticDeckHtml({ title: "Shared stylesheet", pages: [pageOne, pageTwo] });

  assert.equal((deck.match(/https:\/\/fonts\.example\.test\/shared\.css/g) ?? []).length, 1);
  assert.match(deck, /<link rel="stylesheet" href="https:\/\/fonts\.example\.test\/shared\.css">/);
});

test("static Deck hoists strictly identical font faces without merging distinct faces", () => {
  const sharedFace = '@font-face{font-family:"Deck Font";src:url("deck-font-latin.woff2") format("woff2");font-style:normal;font-weight:400;unicode-range:U+0000-00FF;}';
  const pageOne = `<!doctype html><html><head><style>${sharedFace}[data-presenton-page-id="one"] .title{font-family:"Deck Font";color:red}</style></head><body><div data-presenton-slide-shell="true" data-presenton-page-id="one"><main class="title">one</main></div></body></html>`;
  const pageTwo = `<!doctype html><html><head><style>${sharedFace}[data-presenton-page-id="two"] .title{font-family:"Deck Font";color:blue}</style></head><body><div data-presenton-slide-shell="true" data-presenton-page-id="two"><main class="title">two</main></div></body></html>`;
  const pageThree = `<!doctype html><html><head><style>@font-face{font-family:"Deck Font";src:url("deck-font-cjk.woff2") format("woff2");font-style:normal;font-weight:400;unicode-range:U+4E00-9FFF;}[data-presenton-page-id="three"] .title{font-family:"Deck Font";color:green}</style></head><body><div data-presenton-slide-shell="true" data-presenton-page-id="three"><main class="title">three</main></div></body></html>`;

  const deck = buildStaticDeckHtml({ title: "Font face deduplication", pages: [pageOne, pageTwo, pageThree] });

  assert.equal((deck.match(/@font-face/g) ?? []).length, 2);
  assert.match(deck, /<style data-presenton-deck-font-faces="true">/);
  assert.equal((deck.match(/deck-font-latin\.woff2/g) ?? []).length, 1);
  assert.equal((deck.match(/deck-font-cjk\.woff2/g) ?? []).length, 1);
  assert.match(deck, /data-presenton-page-id="one"\] \.title\{font-family:"Deck Font";color:red\}/);
  assert.match(deck, /data-presenton-page-id="two"\] \.title\{font-family:"Deck Font";color:blue\}/);
  assert.match(deck, /data-presenton-page-id="three"\] \.title\{font-family:"Deck Font";color:green\}/);
});


test("saved static page remains authoritative without executable bootstrap or a second shell", () => {
  const sourceHtml = '<html><head></head><body><div id="presentation-slides-wrapper"><div data-presenton-slide-shell="true"><main class="slide">已保存的修改</main></div></div></body></html>';
  const result = buildHtmlPageSourceDocumentHtml({ sourceHtml,
    context: createPageSourceRenderContext({ id: PAGE_ID, title: "保存", pageNumber: 1, totalPages: 1 }) });
  assert.match(result, /已保存的修改/);
  assert.equal((result.match(/data-presenton-slide-shell="true"/g) ?? []).length, 1);
  assert.doesNotMatch(result, /<script|document.body.replaceChildren/);
});
