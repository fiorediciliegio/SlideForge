import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGoogleStaticCssUrl,
  parseGoogleStaticCss,
} from "../src/pptx-export/google-static-fonts.ts";

test("Google static CSS URL asks for one upright weight rather than a variable range", () => {
  const url = new URL(buildGoogleStaticCssUrl({ family: "Bodoni Moda", weight: 900, style: "normal" })!);
  assert.equal(url.origin, "https://fonts.googleapis.com");
  assert.equal(url.searchParams.get("family"), "Bodoni Moda:wght@900");
  assert.equal(url.searchParams.get("display"), "swap");
});

test("Google static CSS URL keeps an italic face distinct", () => {
  const url = new URL(buildGoogleStaticCssUrl({ family: "DM Sans", weight: "700", style: "italic" })!);
  assert.equal(url.searchParams.get("family"), "DM Sans:ital,wght@1,700");
});

test("static CSS parser returns all Unicode slices for the requested face only", () => {
  const css = `
    @font-face {
      font-family: 'Bodoni Moda';
      font-style: normal;
      font-weight: 900;
      src: url(https://fonts.gstatic.com/s/bodoni/latin.woff) format('woff');
      unicode-range: U+0000-00FF;
    }
    @font-face {
      font-family: 'Bodoni Moda';
      font-style: normal;
      font-weight: 900;
      src: url('https://fonts.gstatic.com/s/bodoni/cyrillic.woff') format('woff');
      unicode-range: U+0400-04FF;
    }
    @font-face {
      font-family: 'Bodoni Moda';
      font-style: normal;
      font-weight: 400;
      src: url(https://fonts.gstatic.com/s/bodoni/regular.woff) format('woff');
    }
  `;
  assert.deepEqual(
    parseGoogleStaticCss(css, { family: "Bodoni Moda", weight: 900, style: "normal" }),
    [
      "https://fonts.gstatic.com/s/bodoni/latin.woff",
      "https://fonts.gstatic.com/s/bodoni/cyrillic.woff",
    ],
  );
});
