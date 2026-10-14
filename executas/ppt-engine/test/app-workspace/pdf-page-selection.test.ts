import assert from "node:assert/strict";
import test from "node:test";

import { selectPdfSlideHtmlPaths } from "../../src/app-workspace/pdf-page-selection.ts";

test("PDF export retains every source page when no range is selected", () => {
  const htmlPaths = ["one.html", "two.html", "three.html"];

  assert.deepEqual(selectPdfSlideHtmlPaths(htmlPaths, undefined), htmlPaths);
});

test("PDF export selects valid one-based pages in deck order", () => {
  assert.deepEqual(
    selectPdfSlideHtmlPaths(["one.html", "two.html", "three.html", "four.html"], [4, 2, 2]),
    ["two.html", "four.html"],
  );
});

test("PDF export rejects an empty or out-of-range selection", () => {
  const htmlPaths = ["one.html", "two.html"];

  assert.throws(() => selectPdfSlideHtmlPaths(htmlPaths, []), /valid one-based pages/);
  assert.throws(() => selectPdfSlideHtmlPaths(htmlPaths, [0]), /valid one-based pages/);
  assert.throws(() => selectPdfSlideHtmlPaths(htmlPaths, [3]), /valid one-based pages/);
});
