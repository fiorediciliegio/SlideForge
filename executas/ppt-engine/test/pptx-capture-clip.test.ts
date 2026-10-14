import assert from "node:assert/strict";
import test from "node:test";

import { resolvePptxCaptureClip } from "../src/pptx-export/dom-to-pptx.js";

test("PPTX capture clip validates against the viewport and preserves document coordinates", () => {
  assert.deepEqual(
    resolvePptxCaptureClip(
      {
        documentX: 240,
        documentY: 1320,
        width: 420,
        height: 180,
        slideTop: 1080,
        slideLeft: 0,
        rasterScale: 1.0416667,
      },
      { width: 1920, height: 1080, scrollX: 0, scrollY: 1080 },
    ),
    { x: 240, y: 1320, width: 420, height: 180, scale: 1.0416667 },
  );
});

test("PPTX capture clip preserves horizontal document coordinates after scrolling", () => {
  assert.deepEqual(
    resolvePptxCaptureClip(
      {
        documentX: 2160,
        documentY: 180,
        width: 420,
        height: 180,
        slideTop: 0,
        slideLeft: 1920,
      },
      { width: 1920, height: 1080, scrollX: 1920, scrollY: 0 },
    ),
    { x: 2160, y: 180, width: 420, height: 180, scale: 1 },
  );
});

test("PPTX capture clip rejects out-of-viewport coordinates instead of clamping", () => {
  assert.throws(
    () => resolvePptxCaptureClip(
      {
        documentX: 1900,
        documentY: 1080,
        width: 40,
        height: 40,
        slideTop: 0,
      },
      { width: 1920, height: 1080, scrollX: 0, scrollY: 0 },
    ),
    /outside the viewport/,
  );
});
