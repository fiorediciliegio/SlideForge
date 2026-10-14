import assert from "node:assert/strict";
import test from "node:test";
import { dominantFromPixels, evaluateDrift, nearestPaletteDistance } from "../../src/features/user-templates/profile-drift.ts";

test("palette distance separates near colors from off-palette colors", () => {
  assert.ok(nearestPaletteDistance("#0E4D9D", ["#0E4D9C"]) < 10);
  assert.ok(nearestPaletteDistance("#FF0000", ["#0E4D9D", "#F49416"]) > 140);
});

test("evaluateDrift flags dominant colors outside the palette only", () => {
  const clean = evaluateDrift(1, [{ hex: "#0E4D9E", coverage: 0.4 }, { hex: "#F49416", coverage: 0.1 }], ["#0E4D9D", "#F49416", "#FFFFFF"]);
  assert.equal(clean.drifted, false);
  assert.equal(clean.unmatched.length, 0);
  const drifted = evaluateDrift(2, [{ hex: "#0E4D9E", coverage: 0.4 }, { hex: "#00FF40", coverage: 0.2 }], ["#0E4D9D", "#FFFFFF"]);
  assert.equal(drifted.drifted, true);
  assert.deepEqual(drifted.unmatched.map((sample) => sample.hex), ["#00FF40"]);
  // noise-level coverage never triggers drift
  const noise = evaluateDrift(3, [{ hex: "#00FF40", coverage: 0.01 }], ["#FFFFFF"]);
  assert.equal(noise.drifted, false);
});

test("dominantFromPixels aggregates quantized buckets by coverage", () => {
  // 4 pixels: 3 red-ish, 1 blue
  const pixels = new Uint8ClampedArray([
    250, 10, 10, 255, 245, 15, 12, 255, 252, 8, 10, 255, 10, 10, 240, 255,
  ]);
  const dominant = dominantFromPixels(pixels, 4);
  assert.equal(dominant.length, 2);
  assert.ok(dominant[0].coverage > dominant[1].coverage);
  assert.match(dominant[0].hex, /^#F/);
});
