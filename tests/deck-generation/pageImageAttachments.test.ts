import assert from "node:assert/strict";
import test from "node:test";
import type { PptBackend } from "../../src/api/pptBackend.ts";
import type { OutlineImageAsset } from "../../src/features/outline/images.ts";
import { preparePageImageAttachments } from "../../src/features/deck-generation/pageImageAttachments.ts";
import { buildPageHtmlPrompt, buildPageHtmlRefinementPrompt } from "../../src/features/deck-generation/htmlPrompts.ts";
import { authoringDeckFromConfirmedOutline } from "../../src/features/deck-generation/deckGenerationStartArtifacts.ts";
import { runPageGeneration } from "../../src/features/deck-generation/pageGenerationRunner.ts";
import { createHarness } from "./helpers/htmlWorkflowHarness.ts";

const images = Array.from({ length: 8 }, (_, index) => ({
  asset_id: `image-${index}`, file_path: `/workspace/image-${index}.png`, sha256: String(index),
  description: `Image ${index}`, source: "search", mime_type: "image/png",
})) as OutlineImageAsset[];

test("attachment ordering survives asynchronous uploads; only first six are attached and all metadata remains", async () => {
  const selectedImageIds = images.map((image) => image.asset_id).reverse();
  const uploaded: string[] = [];
  const backend = { uploadOutlineImageForAgent: async ({ asset_id }: { asset_id: string }) => {
    uploaded.push(asset_id);
    await new Promise((resolve) => setTimeout(resolve, Number(asset_id.slice(-1))));
    return { host_upload: { url: `https://uploads.example/${asset_id}.png`, mime_type: "image/png" } };
  } } as PptBackend;
  const prepared = await preparePageImageAttachments({ backend, workspaceDir: "/workspace", selectedImageIds, availableImages: images });
  assert.deepEqual(uploaded, selectedImageIds.slice(0, 6));
  assert.deepEqual(prepared.images.map((image) => image.attachment_index), [1, 2, 3, 4, 5, 6, null, null]);
  assert.deepEqual(prepared.attachments.map((image) => image.url), selectedImageIds.slice(0, 6).map((id) => `https://uploads.example/${id}.png`));
  const { input } = createHarness({ statuses: ["pending"] });
  input.confirmedOutline.items[0].selected_image_ids = selectedImageIds;
  const page = authoringDeckFromConfirmedOutline(input.confirmedOutline).pages[0];
  const prompt = buildPageHtmlPrompt({ outline: input.confirmedOutline, page, preparedPageImages: prepared, visualMasterHtml: null, referenceHtml: "REFERENCE" });
  for (const image of images) assert.ok(prompt.includes(image.file_path));
  assert.equal((prompt.match(/"attachment_index": null/g) ?? []).length, 2);
  assert.doesNotMatch(prompt, /https:\/\/uploads/);
  const refined = buildPageHtmlRefinementPrompt({ outline: input.confirmedOutline, page, availableImages: images,
    visualMasterHtml: null, referenceHtml: "REFERENCE", refinementRequest: "调整布局", originalHtml: "ORIGINAL" });
  assert.equal((refined.match(/"attachment_index": null/g) ?? []).length, 8);
  assert.match(refined, /附件.*当前页原始 HTML.*截图/);
});

test("missing or failed images do not silently drop or shift attachments", async () => {
  let calls = 0;
  const backend = { uploadOutlineImageForAgent: async () => { calls++; throw new Error("upload failed"); } } as unknown as PptBackend;
  const input = { backend, workspaceDir: "/workspace", availableImages: images };
  await assert.rejects(preparePageImageAttachments({ ...input, selectedImageIds: ["image-0", "missing"] }), /unavailable/);
  assert.equal(calls, 0);
  await assert.rejects(preparePageImageAttachments({ ...input, selectedImageIds: ["image-0"] }), /upload failed/);
  assert.deepEqual(await preparePageImageAttachments({ ...input, selectedImageIds: [] }), { images: [], attachments: [] });
});

test("first generation attaches selected originals for cover and standard pages", async () => {
  const harness = createHarness();
  harness.runtime.sharedResearchContext = { image_catalog: { assets: images } } as never;
  harness.runtime.backend.uploadOutlineImageForAgent = async ({ asset_id }) => ({ host_upload: {
    url: `https://uploads.example/${asset_id}.png`, mime_type: "image/png",
  } } as never);
  for (const item of harness.runtime.confirmedOutline.items) item.selected_image_ids = ["image-0"];
  const deck = authoringDeckFromConfirmedOutline(harness.runtime.confirmedOutline);
  for (const page of deck.pages) assert.equal((await runPageGeneration(harness.runtime, deck, page)).reason, "accepted");
  assert.equal(harness.requests.length, 2);
  for (const request of harness.requests) {
    assert.equal(request.options?.attachments?.[0].url, "https://uploads.example/image-0.png");
    assert.match(request.prompt, /"attachment_index": 1/);
  }
});
