import assert from "node:assert/strict";
import test from "node:test";

import {
  capturePdfSlideScreenshot,
  type PdfSlidePageLike,
} from "../../src/app-workspace/pdf-export.ts";

test("PDF export captures the complete 1920x1080 slide element", async () => {
  const calls: Array<{ name: string; value: unknown }> = [];
  const expectedScreenshot = new Uint8Array([1, 2, 3]);
  const page: PdfSlidePageLike = {
    async setViewport(viewport) {
      calls.push({ name: "setViewport", value: viewport });
    },
    async goto(url, options) {
      calls.push({ name: "goto", value: { url, options } });
    },
    async waitForSelector(selector, options) {
      calls.push({ name: "waitForSelector", value: { selector, options } });
      return {
        async screenshot(screenshotOptions) {
          calls.push({ name: "elementScreenshot", value: screenshotOptions });
          return expectedScreenshot;
        },
      };
    },
  };

  const screenshot = await capturePdfSlideScreenshot(page, "/tmp/slide.html");

  assert.deepEqual(screenshot, expectedScreenshot);
  assert.deepEqual(calls[0], {
    name: "setViewport",
    value: { width: 1920, height: 1080, deviceScaleFactor: 2 },
  });
  assert.equal(calls.some((call) => call.name === "elementScreenshot"), true);
});
