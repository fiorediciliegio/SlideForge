import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyOverlapSeverity,
  intersectRects,
  isMeaningfulOverflow,
  overflowDelta,
  rectArea,
} from "../src/layout-audit/index.js";

const rect = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
  right: x + width,
  bottom: y + height,
});

test("intersectRects returns exact intersection and area", () => {
  const intersection = intersectRects(rect(0, 0, 100, 50), rect(50, 25, 100, 50));
  assert.deepEqual(intersection, rect(50, 25, 50, 25));
  assert.equal(rectArea(intersection!), 1250);
  assert.equal(intersectRects(rect(0, 0, 10, 10), rect(10, 0, 10, 10)), null);
});

test("overflowDelta measures all four canvas edges", () => {
  assert.deepEqual(overflowDelta(rect(-4, -2, 110, 30), { width: 100, height: 20 }), {
    left: 4,
    top: 2,
    right: 6,
    bottom: 8,
  });
  assert.equal(isMeaningfulOverflow({ left: 0, top: 0, right: 1, bottom: 0 }), false);
  assert.equal(isMeaningfulOverflow({ left: 0, top: 0, right: 2, bottom: 0 }), true);
});

test("overlap thresholds distinguish ignored, warning, suspicious and error", () => {
  assert.equal(classifyOverlapSeverity(0.005), "ignored");
  assert.equal(classifyOverlapSeverity(0.05), "warning");
  assert.equal(classifyOverlapSeverity(0.2), "suspicious");
  assert.equal(classifyOverlapSeverity(0.4), "error");
});
