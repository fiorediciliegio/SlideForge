import assert from "node:assert/strict";
import test from "node:test";
import { toReadyUserVisualStylePresets } from "../../src/features/user-templates/userTemplateVisualStylePresets";
import type { UserTemplateListEntry } from "../../src/features/user-templates/types";

const readyTemplate: UserTemplateListEntry = {
  id: "user-ready",
  version: 1 as const,
  name: "Ready user template",
  description: "Published.",
  filename: "ready.pptx",
  status: "ready" as const,
  created_at: "2026-09-17T00:00:00.000Z",
  pages: [
    { page_number: 1, description: "Cover" },
    { page_number: 2, description: "Agenda" },
  ],
  master_ready: true,
  completed_pages: [1, 2],
  preview_images: [],
};

test("covers map wins over the (now empty) list preview_images", () => {
  const presets = toReadyUserVisualStylePresets([readyTemplate], {
    "user-ready": [
      { url: "blob:p1", alt: "Ready user template · 1" },
      { url: "blob:p2", alt: "Ready user template · 2" },
    ],
  });
  assert.equal(presets.length, 1);
  assert.deepEqual(presets[0].preview_images.map((image) => image.url), ["blob:p1", "blob:p2"]);
});

test("templates missing from the covers map keep legacy preview_images behaviour", () => {
  const legacy: UserTemplateListEntry = { ...readyTemplate, id: "user-legacy", preview_images: [{ url: "/old.webp", alt: "Old" }] };
  const presets = toReadyUserVisualStylePresets([legacy], {});
  assert.deepEqual(presets[0].preview_images, [{ url: "/old.webp", alt: "Old" }]);
  const withoutLegacy = toReadyUserVisualStylePresets([readyTemplate], {});
  assert.deepEqual(withoutLegacy[0].preview_images, []);
});

test("draft templates are excluded regardless of covers", () => {
  const draft: UserTemplateListEntry = { ...readyTemplate, id: "user-draft", status: "draft" as const };
  const presets = toReadyUserVisualStylePresets([draft], { "user-draft": [{ url: "blob:x", alt: "x" }] });
  assert.equal(presets.length, 0);
});
