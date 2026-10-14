import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPresets, outputPreset, previewReferencePairs } from "../src/presets.mjs";

const preset = {
  id: "example",
  version: 1,
  ppt_number: 1,
  score: 9,
  theme: "dark",
  color: ["blue"],
  name: "Example",
  description: "Example preset",
  user: "Founders",
  use_case: "Pitch deck",
  industry: "Technology",
  preview_images: [{ path: "images/1-cover.png", alt: "Blue cover" }],
  reference_html_pages: [{ path: "html/1-cover.html", description: "Blue cover layout" }],
};

test("preview and reference pages retain matching order and filename stems", () => {
  assert.deepEqual(previewReferencePairs(preset, "preset.json").map((pair) => pair.fileStem), ["1-cover"]);
  assert.throws(
    () => previewReferencePairs({
      ...preset,
      reference_html_pages: [{ path: "html/other.html", description: "Other" }],
    }, "preset.json"),
    /same filename stem/,
  );
});

test("a preset must provide accessible preview text", () => {
  assert.throws(
    () => previewReferencePairs({
      ...preset,
      preview_images: [{ path: "images/1-cover.png", alt: "" }],
    }, "preset.json"),
    /alt must be a non-empty string/,
  );
  assert.throws(
    () => previewReferencePairs({ ...preset, preview_images: undefined }, "preset.json"),
    /preview_images must be a non-empty array/,
  );
});

test("pairing does not mutate preset metadata", () => {
  const before = structuredClone(preset);
  previewReferencePairs(preset, "preset.json");
  assert.deepEqual(preset, before);
});

test("output changes only the preview extension", () => {
  const output = outputPreset(preset, "preset.json");
  assert.deepEqual(output.preview_images, [{ path: "images/1-cover.webp", alt: "Blue cover" }]);
});

test("an empty source root fails instead of reporting a no-op success", async () => {
  const root = await mkdtemp(join(tmpdir(), "slideforge-empty-preview-root-"));
  try {
    await assert.rejects(() => loadPresets(root), /does not contain any preset directories/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
