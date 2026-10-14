import assert from "node:assert/strict";
import test from "node:test";
import { createAnnaPptBackend } from "../../src/api/hostPptBackend.ts";
import { withOrdinaryInvokeTransport } from "../helpers/invokeRuntime.ts";
import { INVOKE_INLINE_BYTES, jsonBytes } from "../../executas/ppt-engine/invoke-transport.js";

test("business text and JSON calls use ordinary transport without per-feature upload fields", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __BUNDLED_TOOL_IDS__: { "ppt-engine": "engine" } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  const workspace_dir = "/workspace/中文";
  const text = '中文😀"\\\n'.repeat(400_000);
  const smallText = text.slice(0, 100_000);
  let expected: { method: string; input: any; output: any };
  let count = 0;
  const business = withOrdinaryInvokeTransport(async (call) => {
    if (call.method === "app_run_workspace_snapshot_publish_dedicated_invoke") return {};
    count++;
    assert.equal(call.method, expected.method);
    assert.deepEqual(call.args, { ...expected.input, diagnostic_logging_enabled: true });
    return { success: true, data: expected.output };
  });
  const backend = createAnnaPptBackend({ tools: { invoke: async (call: any, options: any) => {
    assert.equal(call.method, "app_invoke_transport");
    assert.ok(jsonBytes(call).length <= INVOKE_INLINE_BYTES);
    return business(call, options);
  } } } as any, { diagnosticLoggingEnabled: true });
  const cases: Array<{ api: string; method: string; input: any; output?: any }> = [
    { api: "appendWorkspaceLog", method: "app_append_workspace_log", input: { workspace_dir, channel: "ai-outline", entry: { text } } },
    { api: "writeResearchTestFile", method: "app_write_research_test_file", input: { run_id: "run", file_name: "large.txt", content: text } },
    { api: "recordAttachmentBrief", method: "app_record_attachment_brief", input: { workspace_dir, brief: { text } } },
    { api: "saveWorkspaceOutlineDraft", method: "app_save_workspace_outline_draft", input: { workspace_dir, outline: { title: "标题", items: [{ title: "页面", content: text }] } } },
    { api: "appendSharedImageResearchBatch", method: "app_append_image_research_batch", input: { workspace_dir, batch: { images: [], metadata: smallText } } },
    { api: "createBatchTestRun", method: "app_create_batch_test_run", input: { target_stage: "research-routing-completed", cases: [{ prompt: smallText }] }, output: { run: { cases: [] } } },
    { api: "commitWorkspaceStyleGuide", method: "app_commit_workspace_style_guide", input: { workspace_dir, content: smallText } },
    { api: "commitWorkspaceVisualMasterHtml", method: "app_commit_workspace_visual_master_html", input: { workspace_dir, content: smallText } },
    { api: "commitWorkspacePageHtml", method: "app_commit_workspace_page_html", input: { workspace_dir, page_id: "page", content: text } },
    { api: "commitVisualRhythm", method: "app_commit_visual_rhythm", input: { workspace_dir, content: smallText } },
    { api: "commitPageVisualPlan", method: "app_commit_page_visual_plan", input: { workspace_dir, page_id: "page", content: smallText } },
    { api: "pageRegeneration", method: "app_page_regeneration", input: { action: "submit", workspace_dir, batch_id: "batch", candidate_id: "candidate", content: smallText } },
    { api: "saveUserTemplateHtml", method: "app_save_user_template_html", input: { id: "template", content: smallText } },
    { api: "publishUserTemplate", method: "app_publish_user_template", input: { id: "template", metadata: { description: smallText } } },
    { api: "confirmWorkspaceRequirements", method: "app_confirm_workspace_requirements", input: { workspace_dir, requirements: {}, template_snapshot: { reference_html_pages: [{ html: smallText }] } }, output: { workspace: { workspace_dir } } },
    { api: "saveManualPageRevision", method: "app_save_manual_page_revision", input: { workspace_dir, page_id: "page", base_revision: 7, html: text } },
    { api: "getPageEditContext", method: "app_get_page_edit_context", input: { workspace_dir, page_id: "page" }, output: { workspace_dir, page_id: "page", html: text, resources: [{ local_url: "file:///图片.png", url: "https://storage.test/image" }], workspace_fonts: [], revision: 7 } },
    { api: "getWorkspacePageHtml", method: "app_get_workspace_page_html", input: { workspace_dir, page_id: "page" }, output: { page_id: "page", html: text, preview_source_fingerprint: "version" } },
    { api: "openWorkspace", method: "app_open_workspace", input: { workspace_dir }, output: { workspace_dir, requirements: { brief: text } } },
    { api: "getSharedResearchContext", method: "app_get_shared_research_context", input: { workspace_dir }, output: { workspace_dir, context: text } },
  ];
  for (const item of cases) {
    expected = { ...item, output: item.output ?? {} };
    assert.deepEqual(await (backend as any)[item.api](item.input), expected.output);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(count, cases.length);
});
