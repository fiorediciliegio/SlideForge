import assert from "node:assert/strict";
import test from "node:test";
import { AgentInfrastructureError, AgentRunCancelledError } from "../../src/agent/agentClient.ts";
import type { WorkspaceOutline } from "../../src/api/types.ts";
import { runDeckGeneration, runPageGenerationRetry } from "../../src/features/deck-generation/index.ts";

import { createHarness } from "./helpers/htmlWorkflowHarness.ts";

test("generates and persists HTML for confirmed page identities before final Deck render", async () => {
  const harness = createHarness();
  const completion = await runDeckGeneration({ ...harness.input, startMode: "new" });
  assert.equal(completion.status, "completed");
  assert.deepEqual(harness.committedPageIds, ["page-1", "page-2"]);
  assert.deepEqual(harness.uploads, []);
  assert.equal(harness.committedHtml.length, 2);
  assert.ok(harness.committedHtml.every((html) => html.includes("Generated page")));
  assert.ok(harness.requests[0]?.prompt.includes("Title 1"));
  assert.doesNotMatch(harness.requests[0]!.prompt, /core_message|页面核心信息/);
  assert.ok(harness.requests[0]?.prompt.includes("Required content 1"));
  // 页面提示词只带这一页的内容，Web 摘要不再注入。
  assert.ok(!harness.requests[0]?.prompt.includes("Verified market facts"));
  assert.ok(harness.progress.pages.every((page) => page.status === "accepted"));
  assert.equal(harness.progress.final_deck_render?.deck_html_path, "/output/deck.html");
  assert.equal(harness.counts().finalRenderCalls, 1);
});

test("rejects unconfirmed outlines and missing page identities before preparing artifacts", async () => {
  for (const invalid of [
    { status: "draft" },
    { items: [{ title: "Missing identity", content: "Content" }] },
  ]) {
    const harness = createHarness();
    const completion = await runDeckGeneration({ ...harness.input, confirmedOutline: { ...harness.input.confirmedOutline, ...invalid } as WorkspaceOutline });
    assert.equal(completion.status, "failed");
    assert.equal(harness.counts().prepared, 0);
    assert.equal(harness.requests.length, 0);
  }
});

test("keeps accepted pages unchanged and regenerates only unfinished pages on resume", async () => {
  const harness = createHarness({ statuses: ["accepted", "render_failed", "interrupted"] });
  const acceptedPage = structuredClone(harness.progress.pages[0]);
  const completion = await runDeckGeneration(harness.input);
  assert.equal(completion.status, "completed");
  assert.deepEqual(harness.committedPageIds, ["page-2", "page-3"]);
  assert.deepEqual(harness.progress.pages[0], acceptedPage);
});

test("rejects mismatched persisted page identities on resume", async () => {
  const harness = createHarness();
  harness.progress.pages[0]!.page_id = "another-generation-page";
  const completion = await runDeckGeneration(harness.input);
  assert.equal(completion.status, "failed");
  if (completion.status === "failed") assert.equal(completion.error.type, "stale_artifacts");
  assert.equal(harness.counts().prepared, 0);
  assert.equal(harness.requests.length, 0);
});

test("render failure leaves the page retryable and prevents final render after three complete attempts", async () => {
  const harness = createHarness({ statuses: ["pending"], renderError: new Error("browser render failed") });
  const completion = await runDeckGeneration(harness.input);
  assert.equal(completion.status, "failed");
  assert.equal(harness.progress.pages[0]?.status, "render_failed");
  assert.equal(harness.requests.length, 3);
  assert.equal(harness.counts().renderCalls, 3);
  assert.equal(harness.counts().finalRenderCalls, 0);
});

test("cancelled Agent work propagates cancellation without counting an Agent failure", async () => {
  const harness = createHarness({ statuses: ["pending"], agentError: new AgentRunCancelledError() });
  const completion = await runDeckGeneration(harness.input);
  assert.equal(completion.status, "cancelled");
  assert.equal(harness.progress.pages[0]?.agent_failures, 0);
  assert.equal(harness.progress.recovery?.status, "interrupted");
  assert.equal(harness.uploads.length, 0);
  assert.equal(harness.counts().finalRenderCalls, 0);
});

test("Agent infrastructure failure stops scheduling while preserving unclaimed pages", async () => {
  const harness = createHarness({ statuses: ["pending", "render_failed", "interrupted"], agentError: new AgentInfrastructureError("session limit", "http", true) });
  const unclaimed = structuredClone(harness.progress.pages.slice(1));
  const completion = await runDeckGeneration(harness.input);
  assert.equal(completion.status, "failed");
  if (completion.status === "failed") assert.equal(completion.error.type, "agent_infrastructure");
  assert.equal(harness.progress.pages[0]?.agent_infrastructure_failures, 1);
  assert.deepEqual(harness.progress.pages.slice(1), unclaimed);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.counts().finalRenderCalls, 0);
});

test("ordinary Agent failure records a page failure and leaves it available for resume", async () => {
  const harness = createHarness({ statuses: ["pending"], agentError: new Error("invalid HTML after content attempts") });
  const completion = await runDeckGeneration(harness.input);
  assert.equal(completion.status, "failed");
  assert.equal(harness.progress.pages[0]?.status, "agent_failed");
  assert.equal(harness.progress.pages[0]?.agent_failures, 1);
  assert.equal(harness.uploads.length, 0);
});

test("bounds concurrent page sessions by the workspace setting", async () => {
  const harness = createHarness({ statuses: Array(7).fill("pending"), concurrency: 3 });
  const completion = await runDeckGeneration(harness.input);
  assert.equal(completion.status, "completed");
  assert.equal(harness.requests.length, 7);
  assert.equal(harness.counts().maxActiveAgents, 3);
});

test("retries one failed page and preserves accepted pages before final render", async () => {
  const harness = createHarness({ statuses: ["accepted", "render_failed"] });
  const acceptedPage = structuredClone(harness.progress.pages[0]);
  const completion = await runPageGenerationRetry({ ...harness.input, pageId: "page-2" });
  assert.equal(completion.status, "completed");
  assert.deepEqual(harness.committedPageIds, ["page-2"]);
  assert.deepEqual(harness.progress.pages[0], acceptedPage);
  assert.equal(harness.counts().finalRenderCalls, 1);
});

test("final render failure preserves accepted pages and can resume without reauthoring", async () => {
  const options = { finalRenderError: new Error("deck assembly failed") as Error | undefined };
  const harness = createHarness(options);
  const failed = await runDeckGeneration(harness.input);
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") assert.equal(failed.error.type, "final_render_failed");
  assert.ok(harness.progress.pages.every((page) => page.status === "accepted"));
  assert.equal(harness.progress.final_deck_render?.status, "failed");
  options.finalRenderError = undefined;
  const completed = await runDeckGeneration(harness.input);
  assert.equal(completed.status, "completed");
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.counts().finalRenderCalls, 2);
});

for (const descriptionFailure of [false, true]) test(`整份生成只为目标选图准备描述，所有图片进入清单且原图附件仍限前六张：失败=${descriptionFailure}`, async () => {
  const harness = createHarness();
  const images = Array.from({ length: 14 }, (_, index) => ({ asset_id: `selected-${index + 1}`,
    sha256: (index + 1).toString(16).padStart(64, "0"), file_path: `/workspace/${index + 1}.png`,
    mime_type: "image/png", bytes_size: 100, aspect_ratio: 1, description: "", reason: "", matched_queries: [], source_url: "manual-upload://image" }));
  const batches: number[] = [];
  const events: string[] = [];
  harness.input.confirmedOutline.items[0].selected_image_ids = images.map((image) => image.asset_id);
  harness.input.confirmedOutline.items[1].selected_image_ids = [images[0].asset_id, images[7].asset_id];
  harness.input.backend.getSharedResearchContext = async () => ({ image_catalog: { schema_version: 2, assets: images }, progress: {} } as any);
  harness.input.backend.uploadOutlineImageForAgent = async (input) => ({ host_upload: { url: `https://images.test/${input.asset_id}.png`, mime_type: "image/png", filename: `${input.asset_id}.png` } } as any);
  harness.input.backend.outlineImageDescriptions = async () => { throw new Error("auxiliary persistence unavailable"); };
  harness.input.agentClient.runStructuredPrompt = async (_prompt, validate, options) => {
    const count = options!.attachments!.length; batches.push(count); events.push("describe");
    if (descriptionFailure) throw new Error("description failed after retry budget");
    return validate({ descriptions: options!.attachments!.map((image, index) => ({ attachment_index: index + 1, description: `客观描述 ${image.filename}` })) });
  };
  const html = harness.input.agentClient.runHtmlGenerationPrompt;
  harness.input.agentClient.runHtmlGenerationPrompt = async (...args) => { events.push("html"); return html(...args); };
  const result = await runDeckGeneration({ ...harness.input, generationRunId: crypto.randomUUID() });
  assert.equal(result.status, "completed");
  assert.deepEqual(batches, [6, 6, 2]);
  assert.deepEqual(events, ["describe", "describe", "describe", "html", "html"]);
  assert.equal(harness.requests[0].options!.attachments!.length, 6);
  for (const image of images) assert.ok(harness.requests[0].prompt.includes(image.asset_id));
  assert.match(harness.requests[0].prompt, /"attachment_index": null/);
  assert.equal(harness.requests[0].prompt.includes("客观描述 selected-14.png"), !descriptionFailure);
  assert.deepEqual(harness.input.confirmedOutline.items[0].selected_image_ids, images.map((image) => image.asset_id));
});

test("整份生成描述阶段取消直接停止，不调度 HTML 页面", async () => {
  const harness = createHarness();
  harness.input.confirmedOutline.items[0].selected_image_ids = ["selected"];
  harness.input.backend.getSharedResearchContext = async () => ({ image_catalog: { assets: [{ asset_id: "selected", sha256: "a".repeat(64), file_path: "/workspace/a.png", description: "" }] }, progress: {} } as any);
  harness.input.backend.uploadOutlineImageForAgent = async () => ({ host_upload: { url: "https://images.test/a.png", mime_type: "image/png" } } as any);
  harness.input.agentClient.runStructuredPrompt = async () => { throw new AgentRunCancelledError(); };
  const result = await runDeckGeneration(harness.input);
  assert.equal(result.status, "cancelled"); assert.equal(harness.requests.length, 0);
  assert.equal(harness.progress.recovery?.status, "interrupted");
});

test("单页重试描述准备取消按原有完成协议返回取消，保留已接受页面", async () => {
  const harness = createHarness({ statuses: ["accepted", "render_failed"] });
  const accepted = structuredClone(harness.progress.pages[0]);
  harness.input.confirmedOutline.items[1].selected_image_ids = ["selected"];
  harness.input.backend.getSharedResearchContext = async () => ({ image_catalog: { assets: [{ asset_id: "selected", sha256: "b".repeat(64), file_path: "/workspace/b.png", description: "" }] } } as any);
  harness.input.backend.uploadOutlineImageForAgent = async () => ({ host_upload: { url: "https://images.test/b.png", mime_type: "image/png" } } as any);
  harness.input.agentClient.runStructuredPrompt = async () => { throw new AgentRunCancelledError(); };
  const result = await runPageGenerationRetry({ ...harness.input, pageId: "page-2" });
  assert.equal(result.status, "cancelled"); assert.equal(harness.requests.length, 0);
  assert.deepEqual(harness.progress.pages[0], accepted);
  assert.equal(harness.progress.recovery?.status, "interrupted");
});
