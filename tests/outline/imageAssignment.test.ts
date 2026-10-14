import assert from "node:assert/strict";
import test from "node:test";
import { assignOutlineImages, parseImageAssignments } from "../../src/features/outline/imageAssignment";
import { availableOutlineImages, type OutlineImageAsset } from "../../src/features/outline/images";
import { cloneOutlineItems, normalizeValidOutline } from "../../src/features/outline/model";
import { buildPageHtmlPrompt } from "../../src/features/deck-generation/htmlPrompts";
import { authoringDeckFromConfirmedOutline } from "../../src/features/deck-generation/deckGenerationStartArtifacts";
import { confirmedRequirements } from "../fixtures/imageRequirements";
import type { WorkspaceOutline } from "../../src/api/types";
import type { AgentClient } from "../../src/agent/agentClient";

const asset = (id: string, hash = id): OutlineImageAsset => ({ asset_id: id, sha256: hash, source: "search", file_path: `/workspace/images/${id}.png`, mime_type: "image/png", bytes_size: 100, aspect_ratio: 1, description: `${id} description`, title: `${id} title`, reason: "Relevant", source_url: "https://example.test", matched_queries: [] });
const assets = [asset("portrait"), asset("stadium")];
const outline = { global_creation_requirements: "每页图片至少占 80%", title: "Tennis", items: [
  { page_type: "cover" as const, title: "Final", content: "Final preview" },
  { page_type: "standard" as const, title: "Players", content: "Player background", creation_requirements: "本页图片不要裁切" },
] };

test("user-uploaded duplicates take precedence over search images", () => {
  const selected = availableOutlineImages({ image_catalog: { schema_version: 2, assets: [asset("web", "same"), asset("other")] }, uploaded_asset_catalog: { schema_version: 2, assets: [asset("upload", "same")] } });
  assert.deepEqual(selected.map((item) => [item.asset_id, item.source]), [["upload", "uploaded"], ["other", "search"]]);
});

test("assignment allows empty pages and multiple images but rejects unknown, duplicated, or missing pages and images", () => {
  const result = parseImageAssignments({ pages: [{ page_number: 2, image_ids: [] }, { page_number: 1, image_ids: ["portrait", "stadium"] }] }, outline, assets);
  assert.deepEqual(result.items.map((item) => item.selected_image_ids), [["portrait", "stadium"], []]);
  for (const pages of [
    [{ page_number: 1, image_ids: ["unknown"] }, { page_number: 2, image_ids: [] }],
    [{ page_number: 1, image_ids: ["portrait"] }, { page_number: 2, image_ids: ["portrait"] }],
    [{ page_number: 1, image_ids: [] }, { page_number: 1, image_ids: [] }],
    [{ page_number: 1, image_ids: [] }],
  ]) assert.throws(() => parseImageAssignments({ pages }, outline, assets));
  assert.throws(() => parseImageAssignments({ pages: [{ page_number: 1, image_ids: ["portrait"] }, { page_number: 2, image_ids: ["alias"] }] }, outline, [asset("portrait", "same"), asset("alias", "same")]));
});

test("independent assignment Session gets metadata, raw input, requirements and every page, without attachments", async () => {
  let calls = 0;
  const agent = { runStructuredPrompt: async (prompt: string, validate: (value: unknown) => unknown, options: any) => {
    calls++;
    assert.match(prompt, /portrait title/);
    assert.match(prompt, /Final preview/);
    assert.match(prompt, /Player background/);
    assert.match(prompt, /每页图片至少占 80%/);
    assert.match(prompt, /本页图片不要裁切/);
    assert.ok(prompt.includes(confirmedRequirements().source!.brief));
    assert.equal(options.attachments, undefined);
    assert.deepEqual(options.sessionTools, []);
    assert.equal(options.toolAccessPolicy, "off");
    return validate({ pages: [{ page_number: 1, image_ids: [] }, { page_number: 2, image_ids: ["portrait"] }] });
  } } as unknown as AgentClient;
  const result = await assignOutlineImages({ agent, requirements: confirmedRequirements(), outline, assets });
  assert.equal(calls, 1);
  assert.equal(result.global_creation_requirements, outline.global_creation_requirements);
  assert.equal(result.items[1]?.creation_requirements, "本页图片不要裁切");
  const cloned = cloneOutlineItems(result.items);
  cloned[1]!.selected_image_ids!.push("stadium");
  assert.deepEqual(result.items[1]!.selected_image_ids, ["portrait"]);
  assert.deepEqual(normalizeValidOutline(result).items[1]!.selected_image_ids, ["portrait"]);
  await assignOutlineImages({ agent, requirements: confirmedRequirements(), outline, assets: [] });
  assert.equal(calls, 1, "empty libraries do not need a model call");
});

test("HTML prompts resolve only this page's selected image and reject unavailable assignments", () => {
  const deck: WorkspaceOutline = { version: 4, status: "confirmed", ...outline, items: outline.items.map((item, index) => ({ ...item, page_id: `page-${index}`, selected_image_ids: [assets[index]!.asset_id] })), updated_at: null, confirmed_at: null };
  const pages = authoringDeckFromConfirmedOutline(deck).pages;
  for (const [index, page] of pages.entries()) {
    const prompt = buildPageHtmlPrompt({ outline: deck, page, referenceHtml: "REFERENCE", visualMasterHtml: "MASTER", availableImages: assets });
    assert.ok(prompt.includes(assets[index]!.file_path));
    assert.ok(!prompt.includes(assets[1 - index]!.file_path));
    assert.ok(prompt.indexOf(assets[index]!.file_path) > prompt.indexOf(page.outline));
    assert.throws(() => buildPageHtmlPrompt({ outline: deck, page, referenceHtml: "", visualMasterHtml: "", availableImages: [] }), /unavailable/);
  }
});


test("rewrite can preserve manual cross-page reuse without introducing extra reuse or same-page duplicates", () => {
  const previous = { ...outline, items: outline.items.map((item) => ({ ...item, selected_image_ids: ["portrait"] })) };
  const pages = [{ page_number: 1, image_ids: ["portrait"] }, { page_number: 2, image_ids: ["portrait"] }];
  assert.deepEqual(parseImageAssignments({ pages }, outline, assets, previous).items.map((item) => item.selected_image_ids), [["portrait"], ["portrait"]]);
  assert.throws(() => parseImageAssignments({ pages }, outline, assets));
  assert.throws(() => parseImageAssignments({ pages: [{ page_number: 1, image_ids: ["portrait", "portrait"] }, { page_number: 2, image_ids: [] }] }, outline, assets, previous));
});
