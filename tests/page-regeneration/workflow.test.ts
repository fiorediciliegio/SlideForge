import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { editedRegenerationOutline, generatePageAlternatives, validRegenerationInput } from "../../src/features/page-regeneration/workflow.ts";
import type { PageRegenerationBatch, PageRegenerationInput } from "../../src/api/pageRegenerationTypes.ts";
import type { WorkspaceOutlineItem } from "../../src/api/types.ts";

const original: WorkspaceOutlineItem = {
  page_id: "page-original", page_type: "standard", title: "旧标题", content: "旧大纲",
  selected_image_ids: [],
  creation_requirements: "文案一字不改",
  title_segments: [{ text: "旧标题", source: "user", focus: true }],
};

test("single-page edits preserve identity and reject invalid counts or empty content", () => {
  const edited = editedRegenerationOutline(original, " 新标题 ", " 新大纲 ");
  assert.equal(edited.page_id, original.page_id);
  assert.equal(edited.creation_requirements, "文案一字不改");
  assert.equal(edited.title_segments, undefined);
  assert.equal(original.title, "旧标题");
  for (const count of [0, 11, 2.5, NaN, Infinity]) assert.equal(validRegenerationInput(count, edited), false);
  for (const count of [1, 10]) assert.equal(validRegenerationInput(count, edited), true);
  assert.equal(validRegenerationInput(4, { ...edited, content: "  " }), false);
});

test("ten independent Sessions use edited content, isolate failure, and never publish the accepted page", async () => {
  const edited = editedRegenerationOutline(original, "新标题", "新大纲");
  edited.selected_image_ids = ["new-image"];
  let batch: PageRegenerationBatch | null = null;
  const actions: string[] = [];
  const prompts: string[] = [];
  let active = 0;
  let maximum = 0;
  let calls = 0;
  let masterReads = 0;
  let imageUploads = 0;
  let descriptions = 0;
  const attachments: unknown[] = [];
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => { release = resolve; });
  const backend = {
    uploadOutlineImageForAgent: async ({ asset_id }: { asset_id: string }) => {
      imageUploads++;
      assert.equal(asset_id, "new-image");
      return { host_upload: { url: "https://uploads.example/new.png", mime_type: "image/png" } };
    },
    getSharedResearchContext: async () => ({ image_catalog: { schema_version: 2, assets: [{ asset_id: "new-image", sha256: "new", file_path: "/workspace/new.png", description: "" }, { asset_id: "unselected", sha256: "unused", file_path: "/workspace/unused.png", description: "Not selected" }] } }),
    outlineImageDescriptions: async (input: { action: string; description?: string }) => {
      if (input.action === "describe") return { image: { description: input.description } };
      return { attempted_sha256: [] };
    },
    getWorkspaceAestheticReferenceSelections: async () => ({ pages: { [original.page_id!]: { path: "html/reference.html" } } }),
    getWorkspaceTemplateReferenceHtml: async () => ({ path: "html/reference.html", html: "REFERENCE" }),
    getWorkspaceVisualMasterHtml: async () => { masterReads++; return { content: "MASTER" }; },
    pageRegeneration: async (input: PageRegenerationInput) => {
      actions.push(input.action);
      if (input.action === "create") batch = {
        id: randomUUID(), page_id: input.page_id, page_index: 0, status: "running", outline: input.outline,
        reference_path: input.reference_path, created_at: new Date().toISOString(),
        candidates: Array.from({ length: input.count }, () => ({ id: randomUUID(), status: "generating" })),
      };
      if (input.action === "submit" || input.action === "fail") {
        const candidate = batch!.candidates.find((item) => item.id === input.candidate_id)!;
        candidate.status = input.action === "submit" ? "ready" : "failed";
      }
      if (batch && batch.candidates.every((item) => item.status === "ready" || item.status === "failed")) batch.status = "ready";
      return structuredClone(batch);
    },
  };
  const workspace = {
    workspace_dir: "/workspace", requirements: { selections: { aspect_ratio: "9:16" } },
    outline: { version: 4, status: "confirmed", title: "Deck", items: [original], updated_at: null, confirmed_at: null },
  };
  const agent = {
    runStructuredPrompt: async (_prompt: string, validate: (value: unknown) => unknown) => {
      descriptions++;
      return validate({ descriptions: [{ attachment_index: 1, description: "客观新图描述" }] });
    },
    runHtmlGenerationPrompt: async (prompt: string, options: { attachments?: unknown[] }) => {
      attachments.push(options.attachments);
      const index = calls++;
      prompts.push(prompt);
      active++; maximum = Math.max(maximum, active);
      if (calls === 10) release();
      await allStarted;
      active--;
      if (index === 3) throw new Error("one Session failed");
      return { html: "<!doctype html><html><body>candidate</body></html>" };
    },
  };
  const result = await generatePageAlternatives({
    backend, agent, ai: {}, upload: { uploadFile: async (file: File) => ({ size_bytes: file.size }) },
    workspace, outline: edited, count: 10, onBatch: () => {},
  } as unknown as Parameters<typeof generatePageAlternatives>[0]);
  assert.equal(maximum, 10);
  assert.equal(imageUploads, 2);
  assert.equal(descriptions, 1);
  assert.ok(prompts.every((prompt) => prompt.includes("客观新图描述")));
  assert.ok(attachments.every((value) => value === attachments[0]));
  assert.deepEqual(attachments[0], [{ url: "https://uploads.example/new.png", type: "image/png", filename: undefined, detail: "auto" }]);
  assert.ok(prompts.every((prompt) => prompt.includes('"attachment_index": 1')));
  assert.ok(prompts.every((prompt) => prompt.includes("1080×1920")));
  assert.equal(masterReads, 1);
  assert.equal(result.candidates.filter((item) => item.status === "ready").length, 9);
  assert.equal(result.candidates.filter((item) => item.status === "failed").length, 1);
  assert.ok(prompts.every((prompt) => prompt.includes("新标题") && prompt.includes("新大纲") && prompt.includes("MASTER")));
  assert.ok(actions.every((action) => ["create", "submit", "get", "fail"].includes(action)));
  assert.equal(workspace.outline.items[0].title, "旧标题");
  assert.deepEqual(workspace.outline.items[0].selected_image_ids, []);
  assert.deepEqual(result.outline.selected_image_ids, ["new-image"]);
  assert.ok(prompts.every((prompt) => prompt.includes("/workspace/new.png") && !prompt.includes("/workspace/unused.png")));
});

test("cover alternatives skip the visual master and reuse the selected reference", async () => {
  let batch: PageRegenerationBatch;
  let prompt = "";
  const page = { ...original, page_type: "cover" as const };
  const backend = {
    getSharedResearchContext: async () => ({ image_catalog: { schema_version: 2, assets: [] } }),
    getWorkspaceAestheticReferenceSelections: async () => ({ pages: { [page.page_id!]: { path: "html/cover.html" } } }),
    getWorkspaceTemplateReferenceHtml: async () => ({ path: "html/cover.html", html: "COVER_REFERENCE" }),
    getWorkspaceVisualMasterHtml: async () => { assert.fail("A cover must not read the master"); },
    pageRegeneration: async (input: PageRegenerationInput) => {
      if (input.action === "create") batch = { id: randomUUID(), page_id: page.page_id!, page_index: 0,
        status: "running", outline: page, reference_path: input.reference_path, created_at: "now",
        candidates: [{ id: randomUUID(), status: "generating" }] };
      if (input.action === "submit") { batch.status = "ready"; batch.candidates[0].status = "ready"; }
      return structuredClone(batch);
    },
  };
  await generatePageAlternatives({ backend, agent: { runHtmlGenerationPrompt: async (value: string) => { prompt = value; return { html: "<html></html>" }; } },
    ai: {}, upload: { uploadFile: async (file: File) => ({ size_bytes: file.size }) },
    workspace: { workspace_dir: "/workspace", requirements: { selections: { aspect_ratio: "9:16" } }, outline: { status: "confirmed", title: "Deck", items: [page] } },
    outline: page, count: 1, onBatch: () => {},
  } as unknown as Parameters<typeof generatePageAlternatives>[0]);
  assert.match(prompt, /COVER_REFERENCE/);
  assert.doesNotMatch(prompt, /全局视觉母版/);
});


test("image preparation failures do not create a running batch", async () => {
  for (const unavailable of [false, true]) {
    let created = false;
    const page = { ...original, selected_image_ids: ["missing"] };
    const backend = {
      getWorkspaceAestheticReferenceSelections: async () => ({ pages: { [page.page_id!]: { path: "reference.html" } } }),
      getWorkspaceTemplateReferenceHtml: async () => ({ path: "reference.html", html: "REFERENCE" }),
      getWorkspaceVisualMasterHtml: async () => ({ content: "MASTER" }),
      getSharedResearchContext: async () => { if (!unavailable) throw new Error("Research unavailable"); return { image_catalog: { assets: [] } }; },
      pageRegeneration: async () => { created = true; throw new Error("unexpected creation"); },
    };
    await assert.rejects(generatePageAlternatives({ backend, workspace: { workspace_dir: "/workspace", requirements: { selections: { aspect_ratio: "9:16" } }, outline: { status: "confirmed", title: "Deck", items: [page] } },
      outline: page, count: 1, ai: {}, agent: {}, upload: {}, onBatch: () => {},
    } as unknown as Parameters<typeof generatePageAlternatives>[0]), /unavailable/);
    assert.equal(created, false);
  }
});

test("beautification runs concurrent independent Sessions with the same source and screenshot, without template context", async (t) => {
  const source = '<!doctype html><html><body><div class="slide">原文必须保留</div></body></html>';
  const sourceUrl = "https://uploads.example/source.html";
  const screenshotUrl = "https://uploads.example/source.png";
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, sourceUrl); fetches++;
    return new Response(source);
  });
  let batch: PageRegenerationBatch;
  let calls = 0;
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => { release = resolve; });
  const backend = {
    pageRegeneration: async (input: PageRegenerationInput) => {
      if (input.action === "create") {
        assert.equal(input.mode, "beautify");
        batch = { id: randomUUID(), page_id: original.page_id!, page_index: 0, mode: "beautify", status: "running",
          outline: original, reference_path: "", created_at: "now",
          source_html: source,
          source_screenshot_upload: { url: screenshotUrl, mime_type: "image/png" } as never,
          candidates: Array.from({ length: input.count }, () => ({ id: randomUUID(), status: "generating" })),
        };
      }
      if (input.action === "submit" || input.action === "fail") {
        batch.candidates.find((candidate) => candidate.id === input.candidate_id)!.status = input.action === "submit" ? "ready" : "failed";
        if (batch.candidates.every((candidate) => candidate.status !== "generating")) batch.status = "ready";
      }
      assert.notEqual(input.action, "adopt");
      return structuredClone(batch);
    },
  };
  const agent = {
    runHtmlGenerationPrompt: async (prompt: string, options: any, systemPrompt?: string) => {
      const index = calls++;
      assert.ok(prompt.includes(source));
      assert.match(prompt, /不要改动这页的文字内容/);
      assert.match(prompt, /20px.*18px/);
      assert.match(prompt, /1080×1920/);
      assert.doesNotMatch(prompt, /旧标题|旧大纲|@font-face|MASTER|REFERENCE/);
      assert.equal(systemPrompt, undefined);
      assert.deepEqual(options.attachments, [{ type: "image/png", url: screenshotUrl, filename: `${original.page_id}.png`, detail: "auto" }]);
      if (calls === 10) release();
      await allStarted;
      if (index === 0) throw new Error("one beautification failed");
      return { html: source };
    },
  };
  const result = await generatePageAlternatives({ backend, agent, ai: {}, mode: "beautify",
    upload: { uploadFile: async (file: File) => ({ size_bytes: file.size }) },
    workspace: { workspace_dir: "/workspace", requirements: { selections: { aspect_ratio: "9:16" } }, outline: { status: "confirmed", title: "Deck", items: [original] } },
    outline: original, count: 10, onBatch: () => {},
  } as unknown as Parameters<typeof generatePageAlternatives>[0]);
  assert.equal(calls, 10);
  assert.equal(fetches, 0);
  assert.equal(result.candidates.filter((candidate) => candidate.status === "ready").length, 9);
  assert.equal(result.candidates.filter((candidate) => candidate.status === "failed").length, 1);
});

test("unavailable beautification attachments fail the whole batch without starting Sessions", async () => {
  let batch: PageRegenerationBatch;
  const result = await generatePageAlternatives({ mode: "beautify", ai: {},
    workspace: { workspace_dir: "/workspace", outline: { status: "confirmed", title: "Deck", items: [original] } },
    backend: { pageRegeneration: async (input: PageRegenerationInput) => {
      if (input.action === "create") batch = { id: randomUUID(), page_id: original.page_id!, page_index: 0, mode: "beautify", status: "running",
        outline: original, reference_path: "", created_at: "now", candidates: [{ id: randomUUID(), status: "generating" }] };
      if (input.action === "fail") { batch.status = "ready"; batch.candidates[0].status = "failed"; }
      return structuredClone(batch);
    } },
    agent: { runHtmlGenerationPrompt: async () => assert.fail("must not start without screenshot") }, upload: {},
    outline: original, count: 1, onBatch: () => {},
  } as unknown as Parameters<typeof generatePageAlternatives>[0]);
  assert.equal(result.candidates[0].status, "failed");
});
