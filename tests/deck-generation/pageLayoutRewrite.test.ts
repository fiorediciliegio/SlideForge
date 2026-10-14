import assert from "node:assert/strict";
import test from "node:test";
import { runPageGeneration } from "../../src/features/deck-generation/pageGenerationRunner.ts";
import { authoringDeckFromConfirmedOutline } from "../../src/features/deck-generation/deckGenerationStartArtifacts.ts";
import { createHarness } from "./helpers/htmlWorkflowHarness.ts";

const sourceHtml = '<!doctype html><html><body><div class="slide">Only the slides source</div></body></html>';
const sourceUrl = "https://uploads.example/slides-source.html";
const screenshotUrl = "https://uploads.example/current-render.png";

function setup(errors: number, warnings = 0) {
  const h = createHarness({ statuses: ["pending"] });
  const deck = authoringDeckFromConfirmedOutline(h.input.confirmedOutline);
  let audits = 0;
  h.runtime.backend.auditWorkspacePageLayout = async (input) => {
    audits++;
    assert.equal(input.expected_source_sha256, "source");
    assert.equal(h.progress.pages[0].status, "layout_checking");
    return {
      page_id: input.page_id, source_sha256: "source", error_count: errors,
      warning_count: warnings, report_path: "/output/layout-audit/report.json",
      ...(errors > 0 ? {
        source_html: sourceHtml,
        screenshot_upload: { url: screenshotUrl, mime_type: "image/png", filename: "page-1.png" },
      } : {}),
    } as never;
  };
  return { h, run: () => runPageGeneration(h.runtime, deck, deck.pages[0]), audits: () => audits };
}

test("warnings and suspicious findings do not trigger a rewrite", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  const { h, run, audits } = setup(0, 33);
  assert.equal((await run()).reason, "accepted");
  assert.equal(audits(), 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.counts().renderCalls, 1);
  assert.equal(fetch.mock.callCount(), 0);
});

test("serious findings create one fresh HTML run with only slides source and screenshot; never re-audit", async (t) => {
  const fetched: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    fetched.push(url);
    return new Response(sourceHtml);
  });
  const { h, run, audits } = setup(25, 5);
  h.runtime.confirmedOutline.items[0].selected_image_ids = ["original"];
  h.runtime.sharedResearchContext = { image_catalog: { assets: [{ asset_id: "original", file_path: "/workspace/original.png", sha256: "original", description: "Original" }] } } as never;
  let originalUploads = 0;
  h.runtime.backend.uploadOutlineImageForAgent = async () => {
    originalUploads++;
    return { host_upload: { url: "https://uploads.example/original.png", mime_type: "image/png" } } as never;
  };
  const states: string[] = [];
  h.runtime.onProgress = (progress) => { states.push(progress.pages[0].status); };
  assert.equal((await run()).reason, "accepted");
  assert.equal(audits(), 1, "the still-problematic replacement is accepted without another audit");
  assert.equal(h.requests.length, 2);
  assert.equal(originalUploads, 1);
  assert.equal(h.requests[0].options?.attachments?.[0].url, "https://uploads.example/original.png");
  assert.equal(h.counts().renderCalls, 2);
  assert.equal(h.uploads.length, 0);
  assert.deepEqual(h.committedPageIds, ["page-1", "page-1"]);
  assert.deepEqual(fetched, []);
  const request = h.requests[1];
  assert.ok(request.prompt.includes(sourceHtml));
  assert.match(request.prompt, /不要改动这页的文字内容/);
  assert.match(request.prompt, /20px.*18px/);
  assert.match(request.prompt, /1920×1080/);
  assert.doesNotMatch(request.prompt, /Reference aesthetics|Required content|Message 1|PAGE_CONTENT|Build a market deck|report.json/);
  assert.deepEqual(request.options?.attachments, [{ type: "image/png", url: screenshotUrl, filename: "page-1.png", detail: "auto" }]);
  assert.ok(states.includes("layout_checking"));
  assert.ok(states.includes("layout_rewriting"));
  assert.equal(h.progress.pages[0].status, "accepted");
});

test("audit failures remain retryable failures without a rewrite or acceptance", async () => {
  const { h, run } = setup(0);
  h.runtime.backend.auditWorkspacePageLayout = async () => { throw new Error("audit browser failed"); };
  const result = await run();
  assert.equal(result.reason, "page_failed");
  assert.equal(result.error?.page_status, "layout_check_failed");
  assert.equal(h.requests.length, 1);
});

test("missing source HTML blocks rewriting without extra authoring context fallback", async () => {
  const { h, run } = setup(1);
  const audit = h.runtime.backend.auditWorkspacePageLayout;
  h.runtime.backend.auditWorkspacePageLayout = async (...args) => ({ ...await audit(...args), source_html: undefined });
  assert.equal((await run()).error?.page_status, "layout_check_failed");
  assert.equal(h.requests.length, 1);
});

test("rewrite session failure does not start a third run", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(sourceHtml));
  const { h, run, audits } = setup(1);
  const generate = h.runtime.agentClient.runHtmlGenerationPrompt;
  let calls = 0;
  h.runtime.agentClient.runHtmlGenerationPrompt = async (...args) => {
    if (++calls === 2) throw new Error("rewrite session exhausted retries");
    return generate(...args);
  };
  assert.equal((await run()).error?.page_status, "agent_failed");
  assert.equal(calls, 2);
  assert.equal(audits(), 1);
  assert.equal(h.counts().renderCalls, 1);
});

test("replacement render failure restarts original authoring with a fresh layout budget", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(sourceHtml));
  const { h, run, audits } = setup(1);
  h.runtime.confirmedOutline.global_creation_requirements = "全局要求：保持品牌蓝色";
  h.runtime.confirmedOutline.items[0].creation_requirements = "本页要求：图片放在右侧";
  h.runtime.confirmedOutline.items[0].selected_image_ids = ["original"];
  h.runtime.refinementRequest = "本轮要求：保留所有数字";
  h.runtime.sharedResearchContext = { image_catalog: { assets: [{ asset_id: "original", file_path: "/workspace/original.png", sha256: "original", description: "Original" }] } } as never;
  let originalUploads = 0;
  h.runtime.backend.uploadOutlineImageForAgent = async () => {
    originalUploads++;
    return { host_upload: { url: "https://uploads.example/original.png", mime_type: "image/png" } } as never;
  };
  const render = h.runtime.backend.renderWorkspacePagePreview;
  let calls = 0;
  h.runtime.backend.renderWorkspacePagePreview = async (...args) => {
    if (++calls === 2) throw new Error("replacement render failed");
    return render(...args);
  };
  assert.equal((await run()).reason, "accepted");
  assert.equal(h.requests.length, 4);
  assert.equal(audits(), 2);
  assert.equal(h.requests[2].prompt, h.requests[0].prompt);
  assert.equal(originalUploads, 2);
  for (const index of [0, 2]) {
    assert.equal(h.requests[index].options?.attachments?.length, 1);
    assert.equal(h.requests[index].options?.attachments?.[0].url, "https://uploads.example/original.png");
    assert.match(h.requests[index].prompt, /"attachment_index": 1/);
    assert.doesNotMatch(h.requests[index].prompt, /replacement render failed/);
  }
  for (const index of [1, 3]) {
    assert.equal(h.requests[index].options?.attachments?.length, 1);
    assert.equal(h.requests[index].options?.attachments?.[0].url, screenshotUrl);
    assert.match(h.requests[index].prompt, /全局要求：保持品牌蓝色/);
    assert.match(h.requests[index].prompt, /本页要求：图片放在右侧/);
    assert.match(h.requests[index].prompt, /本轮要求：保留所有数字/);
  }
});

test("cancellation during audit prevents repair and acceptance", async () => {
  const { h, run } = setup(1);
  const audit = h.runtime.backend.auditWorkspacePageLayout;
  h.runtime.backend.auditWorkspacePageLayout = async (...args) => {
    const result = await audit(...args);
    h.runtime.isCancelled = () => true;
    return result;
  };
  assert.equal((await run()).reason, "cancelled");
  assert.equal(h.requests.length, 1);
  assert.notEqual(h.progress.pages[0].status, "accepted");
});

test("late rewrite completion after cancellation cannot upload or commit", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(sourceHtml));
  const { h, run } = setup(1);
  const generate = h.runtime.agentClient.runHtmlGenerationPrompt;
  let calls = 0;
  h.runtime.agentClient.runHtmlGenerationPrompt = async (...args) => {
    const result = await generate(...args);
    if (++calls === 2) h.runtime.isCancelled = () => true;
    return result;
  };
  assert.equal((await run()).reason, "cancelled");
  assert.equal(h.uploads.length, 0);
  assert.equal(h.committedPageIds.length, 1);
});


test("missing screenshot and stale audit responses cannot become accepted pages", async () => {
  for (const patch of [
    { screenshot_upload: undefined },
    { source_html: undefined },
    { source_sha256: "stale" },
    { page_id: "another-page" },
    { error_count: -1 },
  ]) {
    const { h, run } = setup(1);
    const audit = h.runtime.backend.auditWorkspacePageLayout;
    h.runtime.backend.auditWorkspacePageLayout = async (...args) => ({ ...await audit(...args), ...patch });
    assert.equal((await run()).error?.page_status, "layout_check_failed");
    assert.equal(h.requests.length, 1);
  }
});

test("layout repair opens a fresh tool-free session and uses its existing same-session HTML retry", async (t) => {
  const { createAgentClient } = await import("../../src/agent/agentClient.ts");
  t.mock.method(globalThis, "fetch", async () => new Response(sourceHtml));
  const { h, run, audits } = setup(1);
  const sessions: Array<{ prompts: string[]; attachments: unknown[] }> = [];
  let deleted = 0;
  h.runtime.agentClient = await createAgentClient({
    tools: { invoke: async () => ({}) },
    llm: { complete: async () => ({}) },
    agent: {
      session: async (options) => {
        assert.deepEqual(options, { submode: "auto", quotaCaps: { inherit_host_tools: false, allowed_tools: [] } });
        const session = { prompts: [] as string[], attachments: [] as unknown[] };
        sessions.push(session);
        const isRewrite = sessions.length === 2;
        return {
          run: (input) => {
            session.prompts.push(input.content);
            session.attachments.push(input.attachments);
            const html = isRewrite && session.prompts.length === 1 ? "<html><body>incomplete" : sourceHtml;
            return (async function* () {
              yield { event: "message", text: html };
              yield { event: "complete" };
            })();
          },
          delete: async () => { deleted++; },
        };
      },
    },
  });
  assert.equal((await run()).reason, "accepted");
  assert.equal(audits(), 1);
  assert.equal(sessions.length, 2);
  assert.equal(deleted, 2);
  assert.equal(sessions[0].prompts.length, 1);
  assert.equal(sessions[1].prompts.length, 2);
  assert.match(sessions[1].prompts[0], /Only the slides source/);
  assert.match(sessions[1].prompts[1], /唯一的完整 HTML/);
  assert.deepEqual(sessions[1].attachments[0], [{ type: "image/png", url: screenshotUrl, filename: "page-1.png", detail: "auto" }]);
  assert.equal(h.counts().renderCalls, 2);
});
