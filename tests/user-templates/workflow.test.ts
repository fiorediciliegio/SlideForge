import assert from "node:assert/strict";
import test from "node:test";
import { createPersonalTemplate, parseSelectedTemplatePages, parseTemplateMetadata, validateTemplateFile, validateTemplateFiles, TEMPLATE_FILE_MAX_BYTES } from "../../src/features/user-templates/workflow.ts";
import { appendTemplateStep } from "../../src/features/user-templates/useUserTemplates.ts";
import type { TemplateProgress, TemplateStep, UserTemplate, UserTemplateBackend } from "../../src/features/user-templates/types.ts";
import type { AgentClient, AgentRunOptions } from "../../src/agent/agentClient.ts";
import { AGENT_SESSION_MODEL_PREFERENCE } from "../../src/agent/agentClient.ts";
import type { AppHostUploadClient } from "../../src/runtime/appHostUploadClient.ts";
import type { HostUploadRef } from "../../src/api/types.ts";

test("PPTX and selected-page validation enforce file and page limits", () => {
  assert.equal(validateTemplateFile({ name: "sample.PPTX", size: TEMPLATE_FILE_MAX_BYTES }), true);
  for (const file of [{ name: "a.ppt", size: 1 }, { name: "a.pptx", size: 0 }, { name: "a.pptx", size: TEMPLATE_FILE_MAX_BYTES + 1 }]) assert.equal(validateTemplateFile(file), false);
  assert.deepEqual(parseSelectedTemplatePages({ page_numbers: [91, 2, 70] }), [91, 2, 70]);
  for (const page_numbers of [[], [1, 1], [0], [1.5], ["1"], [1, 2, 3, 4, 5, 6, 7]]) assert.throws(() => parseSelectedTemplatePages({ page_numbers }));
  assert.throws(() => parseSelectedTemplatePages({ error: "doc_read failed" }), /doc_read failed/);
  assert.throws(() => parseTemplateMetadata({ name: "Test", description: "Style", pages: [{ page_number: 2, description: "Cover" }] }, [1]), /每个选中页面/);
  assert.equal(validateTemplateFiles([{ name: "sample.PPTX", type: "", size: 1 }]), "pptx");
  assert.equal(validateTemplateFiles([{ name: "a.png", type: "image/png", size: 1 }, { name: "b.jpg", type: "image/jpeg", size: 2 }]), "images");
  assert.throws(() => validateTemplateFiles([]));
  assert.throws(() => validateTemplateFiles(Array.from({ length: 7 }, (_, i) => ({ name: `${i}.png`, type: "image/png", size: 1 }))));
  assert.throws(() => validateTemplateFiles([{ name: "a.png", type: "image/png", size: 1 }, { name: "b.gif", type: "image/gif", size: 1 }]));
});

test("failed parallel pages resume without redoing analysis, master, or saved pages", async () => {
  let record: UserTemplate = { id: "user-test", version: 1, name: "Test", description: "", filename: "test.pptx", status: "draft", created_at: "", pages: [], master_ready: false, completed_pages: [] };
  let calls = { analyze: 0, master: 0, descriptions: 0, profiles: 0, published: 0, active: 0, maxActive: 0 };
  const pageCalls = new Map<number, number>();
  const selected = [1, 3, 8, 10, 12, 91];
  let failPage = true;
  const textUploads = new Map<string, string>();
  const ref = (url: string, mime_type = "image/png") => ({ url, mime_type, filename: "reference.png", size_bytes: 1 } as HostUploadRef);
  const upload: AppHostUploadClient = { uploadFile: async (file) => {
    const url = `https://uploads.test/${textUploads.size}`;
    textUploads.set(url, await file.text());
    return ref(url, file.type);
  } };
  const backend = {
    createUserTemplate: async () => record,
    saveUserTemplateSource: async () => { record = { ...record, source_ready: true }; return record; },
    getUserTemplate: async () => ({ ...record }),
    getUserTemplateHtml: async () => ({ html: "<html><body>master</body></html>" }),
    selectUserTemplatePages: async ({ page_numbers }) => { record = { ...record, pages: page_numbers.map((page_number) => ({ page_number, description: "" })) }; return record; },
    getUserTemplateAsset: async ({ asset, page_number }) => ref(asset === "master" ? "data:text/html,%3Chtml%3E%3Cbody%3Emaster%3C%2Fbody%3E%3C%2Fhtml%3E" : `https://assets.test/${asset}/${page_number ?? 0}`),
    resolveHostUploadTextReference: async ({ host_upload }) => {
      const url = host_upload.url;
      if (url.startsWith("data:")) return decodeURIComponent(url.slice(url.indexOf(",") + 1));
      throw new Error(`unexpected text resolve in test: ${url}`);
    },
    saveUserTemplateHtml: async ({ page_number }) => {
      if (page_number === undefined) record = { ...record, master_ready: true };
      else record = { ...record, completed_pages: [...record.completed_pages, page_number] };
      return record;
    },
    saveUserTemplateProfile: async ({ profile }) => {
      calls.profiles++;
      assert.equal(profile.colors.length, 2);
      record = { ...record, profile, profile_ready: true };
      return record;
    },
    publishUserTemplate: async () => { calls.published++; return { ...record, status: "ready" as const }; },
  } satisfies Partial<UserTemplateBackend>;
  const agent = {
    runStructuredPrompt: async (prompt: string, validate: (value: unknown) => unknown, options: AgentRunOptions) => {
      if (options.sessionTools?.includes("doc_read")) {
        calls.analyze++;
        assert.match(prompt, /必须使用内置 doc_read/);
        assert.deepEqual(options.sessionTools, ["doc_read"]);
        return validate({ page_numbers: selected });
      }
      if (/design profile/.test(prompt)) {
        assert.equal(options.attachments?.length, 6);
        assert.ok(options.attachments?.every((a) => a.url.includes("/reference/") && a.type === "image/png"));
        return validate({ colors: [{ token: "primary", hex: "#1B4F9C", role: "主色", usage: "标题与强调", source: "封面背景" }, { token: "background", hex: "#FFFFFF", role: "背景色" }] });
      }
      calls.descriptions++;
      assert.equal(options.attachments?.length, 6);
      assert.ok(options.attachments?.every((a) => a.url.includes("/preview/") && a.type === "image/png"));
      return validate({ name: "Test", description: "Style", pages: selected.map((page_number) => ({ page_number, description: "A balanced composition." })) });
    },
    runHtmlGenerationPrompt: async (prompt: string, options: AgentRunOptions) => {
      assert.ok(options.attachments?.every((a) => a.type === "image/png"));
      if (options.attachments?.length === 6) { calls.master++; return { html: "<html><body>master</body></html>" }; }
      const n = Number(options.attachments?.[0].url.split("/").at(-1));
      pageCalls.set(n, (pageCalls.get(n) ?? 0) + 1);
      calls.active++; calls.maxActive = Math.max(calls.active, calls.maxActive);
      await new Promise((resolve) => setTimeout(resolve, 5));
      calls.active--;
      assert.match(prompt, /master/);
      if (n === 3 && failPage) throw new Error("page generation failed");
      return { html: `<html><body>${n}</body></html>` };
    },
  } as unknown as AgentClient;
  let steps: TemplateStep[] = [];
  const run = (templateId?: string) => {
    steps = [];
    return createPersonalTemplate({ backend: backend as UserTemplateBackend, agent, upload, files: templateId ? undefined : [new File(["pptx"], "test.pptx")], templateId, locale: "zh", signal: new AbortController().signal, onCreated: () => {}, onProgress: (next: TemplateProgress) => { steps = appendTemplateStep(steps, next); } });
  };
  await assert.rejects(run(), /page generation failed/);
  assert.equal(calls.published, 0);
  assert.equal(calls.descriptions, 0);
  assert.equal(calls.maxActive, 3);
  assert.equal(record.completed_pages.length, 5);
  // The failed run's timeline stops at page recreation and keeps its details.
  assert.deepEqual(steps.map((step) => step.stage), ["upload", "analyze", "images", "profile", "master", "pages"]);
  assert.deepEqual(steps.find((step) => step.stage === "analyze")?.detail?.page_numbers, selected);
  assert.equal(steps.find((step) => step.stage === "images")?.detail?.images?.length, 6);
  assert.equal(steps.at(-1)?.detail?.pages?.filter((page) => page.status === "done").length, 5);
  failPage = false;
  const result = await run(record.id);
  assert.equal(result.status, "ready");
  // A resumed run reports the same seven steps and the published metadata.
  assert.deepEqual(steps.map((step) => step.stage), ["upload", "analyze", "images", "profile", "master", "pages", "describe"]);
  assert.deepEqual(steps.find((step) => step.stage === "analyze")?.detail?.page_numbers, selected);
  assert.equal(steps.find((step) => step.stage === "profile")?.detail?.profile_colors?.length, 2);
  assert.equal(steps.at(-1)?.detail?.name, "Test");
  assert.ok(steps.find((step) => step.stage === "pages")?.detail?.pages?.every((page) => page.status === "done" && page.preview_url));
  assert.equal(calls.analyze, 1);
  assert.equal(calls.master, 1);
  assert.equal(calls.descriptions, 1);
  assert.equal(calls.profiles, 1);
  assert.equal(record.profile_ready, true);
  assert.equal(calls.published, 1);
  assert.equal(pageCalls.get(3), 2);
  for (const n of selected.filter((n) => n !== 3)) assert.equal(pageCalls.get(n), 1);
});

test("image files create a template without doc_read analysis", async () => {
  let record: UserTemplate = { id: "user-img", version: 1, name: "a", description: "", filename: "a.png, b.png", source_kind: "images", source_files: ["source-1.png", "source-2.png"], status: "draft", created_at: "", pages: [], master_ready: false, completed_pages: [] };
  const calls = { analyze: 0, descriptions: 0, profiles: 0, createdImages: 0, selected: 0, published: 0 };
  const ref = (url: string, mime_type = "image/png") => ({ url, mime_type, filename: "reference.png", size_bytes: 1 } as HostUploadRef);
  const upload: AppHostUploadClient = { uploadFile: async (file) => ref(`https://uploads.test/${file.name}`, file.type) };
  const backend = {
    createImageUserTemplate: async ({ files }) => { calls.createdImages++; assert.equal(files.length, 2); return record; },
    getUserTemplate: async () => ({ ...record }),
    selectUserTemplatePages: async ({ page_numbers }) => { calls.selected++; assert.deepEqual(page_numbers, [1, 2]); record = { ...record, pages: page_numbers.map((page_number) => ({ page_number, description: "" })) }; return record; },
    getUserTemplateAsset: async ({ asset, page_number }) => ref(asset === "master" ? "data:text/html,%3Chtml%3E%3Cbody%3Emaster%3C%2Fbody%3E%3C%2Fhtml%3E" : `https://assets.test/${asset}/${page_number ?? 0}`),
    resolveHostUploadTextReference: async ({ host_upload }) => {
      const url = host_upload.url;
      if (url.startsWith("data:")) return decodeURIComponent(url.slice(url.indexOf(",") + 1));
      throw new Error(`unexpected text resolve in test: ${url}`);
    },
    saveUserTemplateHtml: async ({ page_number }) => {
      if (page_number === undefined) record = { ...record, master_ready: true };
      else record = { ...record, completed_pages: [...record.completed_pages, page_number] };
      return record;
    },
    saveUserTemplateProfile: async ({ profile }) => { calls.profiles++; record = { ...record, profile, profile_ready: true }; return record; },
    publishUserTemplate: async () => { calls.published++; return { ...record, status: "ready" as const }; },
  } satisfies Partial<UserTemplateBackend>;
  const agent = {
    runStructuredPrompt: async (prompt: string, validate: (value: unknown) => unknown, options: AgentRunOptions) => {
      if (options.sessionTools?.includes("doc_read")) { calls.analyze++; return validate({ page_numbers: [1, 2] }); }
      if (/design profile/.test(prompt)) return validate({ colors: [{ token: "primary", hex: "#1B4F9C", role: "主色" }] });
      calls.descriptions++;
      return validate({ name: "Img", description: "Style", pages: [1, 2].map((page_number) => ({ page_number, description: "A page." })) });
    },
    runHtmlGenerationPrompt: async (prompt: string, options: AgentRunOptions) => {
      if (options.attachments?.length === 2) return { html: "<html><body>master</body></html>" };
      return { html: "<html><body>page</body></html>" };
    },
  } as unknown as AgentClient;
  let steps: TemplateStep[] = [];
  const result = await createPersonalTemplate({ backend: backend as UserTemplateBackend, agent, upload, files: [new File(["png"], "a.png", { type: "image/png" }), new File(["jpg"], "b.jpg", { type: "image/jpeg" })], locale: "zh", signal: new AbortController().signal, onCreated: () => {}, onProgress: (next: TemplateProgress) => { steps = appendTemplateStep(steps, next); } });
  assert.equal(result.status, "ready");
  assert.equal(calls.analyze, 0);
  assert.equal(calls.createdImages, 1);
  assert.equal(calls.selected, 1);
  assert.equal(calls.descriptions, 1);
  assert.equal(calls.profiles, 1);
  assert.equal(calls.published, 1);
  assert.deepEqual(steps.map((step) => step.stage), ["upload", "analyze", "images", "profile", "master", "pages", "describe"]);
  assert.deepEqual(steps.find((step) => step.stage === "analyze")?.detail?.page_numbers, [1, 2]);
});

test("profile confirmation gate pauses the workflow and uses the edited profile", async () => {
  let record: UserTemplate = { id: "user-gate", version: 1, name: "Gate", description: "", filename: "gate.pptx", status: "draft", created_at: "", pages: [], master_ready: false, completed_pages: [] };
  const calls = { extracted: 0, saved: [] as string[], published: 0 };
  const ref = (url: string, mime_type = "image/png") => ({ url, mime_type, filename: "reference.png", size_bytes: 1 } as HostUploadRef);
  const upload: AppHostUploadClient = { uploadFile: async (file) => ref(`https://uploads.test/${file.name}`, file.type) };
  const backend = {
    createUserTemplate: async () => record,
    saveUserTemplateSource: async () => record,
    getUserTemplate: async () => ({ ...record }),
    selectUserTemplatePages: async ({ page_numbers }) => { record = { ...record, pages: page_numbers.map((page_number) => ({ page_number, description: "" })) }; return record; },
    getUserTemplateAsset: async ({ asset, page_number }) => ref(asset === "master" ? "data:text/html,%3Chtml%3E%3Cbody%3Emaster%3C%2Fbody%3E%3C%2Fhtml%3E" : `https://assets.test/${asset}/${page_number ?? 0}`),
    getUserTemplateHtml: async () => ({ html: "<html><body>master</body></html>" }),
    saveUserTemplateHtml: async ({ page_number }) => {
      if (page_number === undefined) record = { ...record, master_ready: true };
      else record = { ...record, completed_pages: [...record.completed_pages, page_number] };
      return record;
    },
    saveUserTemplateProfile: async ({ profile }) => { calls.saved.push(profile.colors[0].hex); record = { ...record, profile, profile_ready: true }; return record; },
    publishUserTemplate: async () => { calls.published++; return { ...record, status: "ready" as const }; },
  } satisfies Partial<UserTemplateBackend>;
  const agent = {
    runStructuredPrompt: async (prompt: string, validate: (value: unknown) => unknown, options: AgentRunOptions) => {
      if (options.sessionTools?.includes("doc_read")) return validate({ page_numbers: [1] });
      if (/design profile/.test(prompt)) { calls.extracted++; return validate({ colors: [{ token: "primary", hex: "#0000FF", role: "蓝" }] }); }
      return validate({ name: "Gate", description: "Style", pages: [{ page_number: 1, description: "Cover." }] });
    },
    runHtmlGenerationPrompt: async (prompt: string) => { genPrompts.push(prompt); return { html: "<html><body>x</body></html>" }; },
  } as unknown as AgentClient;
  const genPrompts: string[] = [];
  let gateInput: unknown;
  const reviewed = { colors: [{ token: "primary", hex: "#FF0000", role: "红" }] };
  let steps: TemplateStep[] = [];
  const result = await createPersonalTemplate({
    backend: backend as UserTemplateBackend, agent, upload, files: [new File(["pptx"], "gate.pptx")], locale: "zh", signal: new AbortController().signal,
    confirmProfile: async (record, profile) => {
      gateInput = profile;
      // mirrors the hook contract: the callee persists edits before resolving
      await backend.saveUserTemplateProfile({ id: record.id, profile: reviewed });
      return reviewed;
    },
    onCreated: () => {}, onProgress: (next: TemplateProgress) => { steps = appendTemplateStep(steps, next); },
  });
  assert.equal(result.status, "ready");
  assert.equal(calls.extracted, 1);
  // The gate saw the freshly extracted profile, generation continued with the edited one.
  assert.equal((gateInput as { colors: { hex: string }[] }).colors[0].hex, "#0000FF");
  assert.deepEqual(calls.saved, ["#0000FF", "#FF0000"]);
  assert.equal(calls.published, 1);
  assert.deepEqual(steps.map((step) => step.stage), ["upload", "analyze", "images", "profile", "master", "pages", "describe"]);
  assert.equal(steps.find((step) => step.stage === "profile")?.detail?.profile_colors?.[0], "primary #FF0000");
  // Step 5 injection: both master and page prompts carry the confirmed profile colors.
  assert.equal(genPrompts.length, 2);
  assert.ok(genPrompts[0].includes("#FF0000"), "master prompt must contain the confirmed color");
  assert.ok(genPrompts[1].includes("#FF0000"), "page prompt must contain the confirmed color");
  assert.ok(genPrompts[0].includes("颜色白名单"));
});


test("drifted pages are regenerated once and the final report drops cleared drift", async () => {
  let record: UserTemplate = { id: "user-drift", version: 1, name: "Drift", description: "", filename: "drift.pptx", status: "draft", created_at: "", pages: [], master_ready: false, completed_pages: [] };
  const calls = { pageSaves: 0, driftChecks: 0, published: 0 };
  const ref = (url: string, mime_type = "image/png") => ({ url, mime_type, filename: "reference.png", size_bytes: 1 } as HostUploadRef);
  const upload: AppHostUploadClient = { uploadFile: async (file) => ref(`https://uploads.test/${file.name}`, file.type) };
  const backend = {
    createUserTemplate: async () => record,
    saveUserTemplateSource: async () => record,
    getUserTemplate: async () => ({ ...record }),
    selectUserTemplatePages: async ({ page_numbers }) => { record = { ...record, pages: page_numbers.map((page_number) => ({ page_number, description: "" })) }; return record; },
    getUserTemplateAsset: async ({ asset, page_number }) => ref(asset === "master" ? "data:text/html,%3Chtml%3E%3Cbody%3Emaster%3C%2Fbody%3E%3C%2Fhtml%3E" : `https://assets.test/${asset}/${page_number ?? 0}`),
    getUserTemplateHtml: async () => ({ html: "<html><body>master</body></html>" }),
    saveUserTemplateHtml: async ({ page_number }) => {
      if (page_number !== undefined) calls.pageSaves++;
      else record = { ...record, master_ready: true };
      return record;
    },
    saveUserTemplateProfile: async ({ profile }) => { record = { ...record, profile, profile_ready: true }; return record; },
    publishUserTemplate: async () => { calls.published++; return { ...record, status: "ready" as const }; },
  } satisfies Partial<UserTemplateBackend>;
  const agent = {
    runStructuredPrompt: async (prompt: string, validate: (value: unknown) => unknown, options: AgentRunOptions) => {
      if (options.sessionTools?.includes("doc_read")) return validate({ page_numbers: [1, 2] });
      if (/design profile/.test(prompt)) return validate({ colors: [{ token: "primary", hex: "#0E4D9D", role: "主色" }] });
      return validate({ name: "Drift", description: "Style", pages: [1, 2].map((page_number) => ({ page_number, description: "A page." })) });
    },
    runHtmlGenerationPrompt: async () => ({ html: "<html><body>x</body></html>" }),
  } as unknown as AgentClient;
  const driftCheck = async (page_number: number) => {
    calls.driftChecks++;
    const drifted = calls.driftChecks <= 2 && page_number === 2; // first pass only: page 2 drifts
    return { page_number, drifted, dominant: [], unmatched: drifted ? [{ hex: "#00FF40", coverage: 0.2 }] : [] };
  };
  let steps: TemplateStep[] = [];
  const result = await createPersonalTemplate({
    backend: backend as UserTemplateBackend, agent, upload, files: [new File(["pptx"], "drift.pptx")], locale: "zh", signal: new AbortController().signal,
    driftCheck, onCreated: () => {}, onProgress: (next: TemplateProgress) => { steps = appendTemplateStep(steps, next); },
  });
  assert.equal(result.status, "ready");
  assert.equal(calls.pageSaves, 3, "page 2 regenerated exactly once");
  assert.equal(calls.driftChecks, 4, "two passes over two pages");
  const finalPages = steps.filter((step) => step.stage === "pages").at(-1);
  assert.equal(finalPages?.detail?.drifts?.length ?? 0, 0, "final report carries no drift after retry");
  assert.equal(calls.published, 1);
});

test("the timeline merges repeated stage reports and closes the previous step", () => {
  let steps = appendTemplateStep([], { stage: "analyze" });
  steps = appendTemplateStep(steps, { stage: "analyze", detail: { page_numbers: [1, 4] } });
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0], { stage: "analyze", status: "running", detail: { page_numbers: [1, 4] } });
  steps = appendTemplateStep(steps, { stage: "pages", completed: 0, total: 2 });
  assert.deepEqual(steps.map((step) => step.status), ["done", "running"]);
  // A merge preserves detail keys the newer report does not carry.
  steps = appendTemplateStep(steps, { stage: "pages", completed: 1, total: 2, detail: { pages: [{ page_number: 1, status: "done" }] } });
  steps = appendTemplateStep(steps, { stage: "pages", completed: 2, total: 2 });
  assert.equal(steps.at(-1)?.completed, 2);
  assert.equal(steps.at(-1)?.detail?.pages?.length, 1);
  assert.deepEqual(steps[0].detail?.page_numbers, [1, 4]);
});

test("cancellation prevents a new template from being uploaded or published", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createPersonalTemplate({ backend: {} as UserTemplateBackend, agent: {} as AgentClient, upload: {} as AppHostUploadClient, files: [new File(["pptx"], "test.pptx")], locale: "en", signal: controller.signal, onCreated: () => {}, onProgress: () => {} }), /abort/i);
});

test("a failed run reports diagnostics through onRunLog exactly once", async () => {
  let record: UserTemplate = { id: "user-log", version: 1, name: "", description: "", filename: "log.pptx", status: "draft", created_at: "", pages: [], master_ready: false, completed_pages: [] };
  const ref = (url: string) => ({ url, mime_type: "image/png", filename: "r.png", size_bytes: 1 } as HostUploadRef);
  const upload: AppHostUploadClient = { uploadFile: async (file) => ref(`https://uploads.test/${file.name}`) };
  const backend = {
    createUserTemplate: async () => record,
    saveUserTemplateSource: async () => record,
    getUserTemplate: async () => ({ ...record }),
    selectUserTemplatePages: async ({ page_numbers }) => { record = { ...record, pages: page_numbers.map((page_number) => ({ page_number, description: "" })) }; return record; },
    getUserTemplateAsset: async () => ref("https://assets.test/reference/1"),
    saveUserTemplateHtml: async () => record,
    saveUserTemplateProfile: async ({ profile }) => { record = { ...record, profile, profile_ready: true }; return record; },
    publishUserTemplate: async () => ({ ...record, status: "ready" as const }),
  } satisfies Partial<UserTemplateBackend>;
  const agent = {
    runStructuredPrompt: async (prompt: string, validate: (value: unknown) => unknown, options: AgentRunOptions) => {
      if (options.sessionTools?.includes("doc_read")) return validate({ page_numbers: [1] });
      options.onStreamEvent?.({ type: "activity", message: "doc_read slides/slide1.xml", tool: "doc_read", path: "slides/slide1.xml" });
      options.onDiagnosticStreamEvent?.({ type: "activity", message: "retry scheduled", diagnosticOnly: true });
      options.onRawFrame?.({ event: "sse", data: { choices: [{ delta: { tool_start: { name: "doc_read", input: { path: "slides/slide1.xml" } } } }] }, run_id: "run-1" });
      options.onRawFrame?.({ event: "complete", usage: { input_tokens: 10, output_tokens: 0 } });
      options.onStreamEvent?.({ type: "error", message: "Agent run completed without producing any output", code: "EMPTY_COMPLETION", expired: false });
      throw new Error("Agent run completed without producing any output (no assistant message, no tool calls)");
    },
  } as unknown as AgentClient;
  const logs: import("../../src/features/user-templates/runLog.ts").RunLog[] = [];
  await assert.rejects(createPersonalTemplate({
    backend: backend as UserTemplateBackend, agent, upload, files: [new File(["pptx"], "log.pptx")], locale: "zh", signal: new AbortController().signal,
    onCreated: () => {}, onProgress: () => {}, onRunLog: (log) => logs.push(log),
  }), /without producing any output/);
  assert.equal(logs.length, 1);
  const log = logs[0];
  assert.equal(log.outcome, "error");
  assert.equal(log.template_id, "user-log");
  assert.match(log.error ?? "", /without producing any output/);
  const failed = log.entries.find((entry) => entry.result === "error");
  assert.equal(failed?.stage, "profile");
  assert.match(failed?.detail ?? "", /without producing any output/);
  const analyze = log.entries.find((entry) => entry.stage === "analyze");
  assert.equal(analyze?.result, "ok");
  assert.equal(analyze?.meta?.tool, "doc_read");
  assert.equal(analyze?.meta?.model, AGENT_SESSION_MODEL_PREFERENCE);
  assert.equal(log.model_preference, AGENT_SESSION_MODEL_PREFERENCE);
  assert.equal(log.error_kind, "empty_completion");
  const backendEntries = log.entries.filter((entry) => entry.stage === "backend");
  assert.ok(backendEntries.length >= 1, "backend calls are logged");
  assert.equal(backendEntries[0].label, "createUserTemplate (draft)");
  assert.equal(backendEntries[0].result, "ok");
  const failedEntry = log.entries.find((entry) => entry.result === "error");
  assert.equal(failedEntry?.frames?.length, 5, "activity + diagnostic + 2 raw + error frames recorded");
  const rawFrames = failedEntry?.frames?.filter((frame) => frame.type === "raw") ?? [];
  assert.equal(rawFrames.length, 2);
  assert.match(rawFrames[0].summary, /"event":"sse"/);
  assert.match(rawFrames[1].summary, /"event":"complete"/);
  assert.equal(rawFrames[0].run_id, "run-1");
  assert.match(failedEntry?.frames?.[0].summary ?? "", /doc_read slides\/slide1\.xml/);
  assert.match(failedEntry?.frames?.[1].summary ?? "", /activity\(diagnostic\)/);
  assert.match(failedEntry?.frames?.[4].summary ?? "", /error: code=EMPTY_COMPLETION/);
  const { formatRunLog } = await import("../../src/features/user-templates/runLog.ts");
  assert.match(formatRunLog(log), /\+\d+ms activity: doc_read slides\/slide1\.xml/);
});

test("creation-stage failures still produce a run log (no stale log shown)", async () => {
  const upload: AppHostUploadClient = { uploadFile: async (file) => ({ url: `https://uploads.test/${file.name}`, mime_type: file.type, filename: file.name, size_bytes: 1 }) };
  const backend = {
    createUserTemplate: async () => { throw new Error("Unknown tool: app_create_user_template"); },
  } satisfies Partial<UserTemplateBackend>;
  const logs: import("../../src/features/user-templates/runLog.ts").RunLog[] = [];
  await assert.rejects(createPersonalTemplate({
    backend: backend as UserTemplateBackend, agent: {} as AgentClient, upload, files: [new File(["pptx"], "test.pptx")], locale: "zh", signal: new AbortController().signal,
    onCreated: () => {}, onProgress: () => {}, onRunLog: (log) => logs.push(log),
  }), /Unknown tool/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].outcome, "error");
  assert.match(logs[0].error ?? "", /Unknown tool/);
});

test("upload failure retains the allocated draft and records diagnostics", async () => {
  const order: string[] = [];
  const record: UserTemplate = { id: "user-upload-failed", version: 1, filename: "test.pptx", name: "test", description: "", status: "draft", created_at: "", pages: [], completed_pages: [], master_ready: false, source_ready: false };
  const logs: import("../../src/features/user-templates/runLog.ts").RunLog[] = [];
  const backend = {
    createUserTemplate: async () => { order.push("create"); return record; },
    saveUserTemplateSource: async () => { order.push("save-source"); return record; },
  } as unknown as UserTemplateBackend;
  await assert.rejects(createPersonalTemplate({ backend, agent: {} as AgentClient,
    upload: { uploadFile: async (_file, options) => {
      order.push("upload"); assert.equal(options.metadata?.user_template_id, record.id);
      throw new Error("upload failed");
    } },
    files: [new File(["pptx"], "test.pptx")], locale: "zh", signal: new AbortController().signal,
    onCreated: (created) => { assert.equal(created.id, record.id); order.push("created"); }, onProgress: () => {},
    onRunLog: (log) => logs.push(log),
  }), /upload failed/);
  // Draft-first: the draft is announced before the upload, so a failed upload
  // still leaves a reselectable draft in the UI list.
  assert.deepEqual(order, ["create", "created", "upload"]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].outcome, "error");
  assert.match(logs[0].error ?? "", /upload failed/);
  assert.equal(logs[0].template_id, "user-upload-failed");
});
