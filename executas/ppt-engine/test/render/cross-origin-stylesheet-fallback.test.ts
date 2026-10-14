import assert from "node:assert/strict";
import test from "node:test";

import { withQueuedManagedPage } from "../../src/render/managed-page.ts";
import { serializeRenderedPageToStaticHtml } from "../../src/render/static-html.ts";

test("static HTML preserves stylesheet links whose CSS rules are unreadable", async () => {
  await withQueuedManagedPage("cross-origin stylesheet fallback test", 30_000, async (page) => {
    await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="https://fonts.example.test/shared.css"></head><body><div id="presentation-slides-wrapper"><div data-presenton-slide-shell="true" data-presenton-page-id="page-test"><main>content</main></div></div></body></html>`);
    await page.evaluate(() => {
      const ownerNode = document.querySelector('link[rel="stylesheet"]');
      if (!(ownerNode instanceof HTMLLinkElement)) throw new Error("Stylesheet link was not found");
      Object.defineProperty(document, "styleSheets", {
        configurable: true,
        value: [{
          ownerNode,
          get cssRules() {
            throw new DOMException("Cannot access rules", "SecurityError");
          },
        }],
      });
    });

    const html = await serializeRenderedPageToStaticHtml(page, "page");

    assert.match(html, /<link rel="stylesheet" href="https:\/\/fonts\.example\.test\/shared\.css">/);
    assert.match(html, /data-presenton-render-document="static"/);
  });
});
