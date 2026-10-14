import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateInvokeTools, validateToolManifest } from "../scripts/tool-manifest-validation.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function manifestWithParameter(parameter: Record<string, unknown>) {
  return {
    display_name: "ppt-engine",
    version: "1.0.0",
    tools: [
      {
        name: "example_tool",
        description: "Example tool.",
        parameters: [parameter],
      },
    ],
  };
}

test("current ppt-engine manifest satisfies the SlideForge parameter schema requirements", async () => {
  const manifest = JSON.parse(await readFile(path.join(PROJECT_DIR, "manifest.json"), "utf8"));
  assert.equal(validateToolManifest(manifest), manifest);
});

test("public entries and ordinary business definitions are disjoint and contain no legacy transport", async () => {
  const manifest = JSON.parse(await readFile(path.join(PROJECT_DIR, "manifest.json"), "utf8"));
  const internal = JSON.parse(await readFile(path.join(PROJECT_DIR, "invoke-tools.json"), "utf8"));
  assert.equal(validateInvokeTools(internal), internal);
  const publicNames = manifest.tools.map((tool: any) => tool.name);
  assert.deepEqual(publicNames.sort(), ["app_invoke_transport", "app_invoke_transport_channel", "app_run_export_artifact_publish", "app_run_pdf_export"]);
  const removed = ["app_resolve_host_upload_json_reference", "app_resolve_host_upload_text_reference", "app_upload_host_file_fallback",
    "app_commit_workspace_style_guide_host_upload", "app_commit_workspace_visual_master_html_host_upload",
    "app_commit_workspace_page_html_host_upload", "app_commit_visual_rhythm_host_upload", "app_commit_page_visual_plan_host_upload"];
  const legacyParams = ["brief_upload", "entry_upload", "outline_upload", "task_upload", "batch_upload", "input_upload", "style_guide_upload", "content_upload"];
  for (const tool of internal.tools) {
    assert.ok(!publicNames.includes(tool.name) && !removed.includes(tool.name), tool.name);
    for (const parameter of tool.parameters ?? []) assert.ok(!legacyParams.includes(parameter.name), `${tool.name}.${parameter.name}`);
  }
  for (const [name, parameter] of [["app_create_batch_test_run", "cases"], ["app_append_workspace_log", "entry"],
    ["app_save_workspace_outline_draft", "outline"], ["app_save_manual_page_revision", "html"],
    ["app_save_user_template_html", "content"], ["app_publish_user_template", "metadata"]]) {
    assert.equal(internal.tools.find((tool: any) => tool.name === name)?.parameters.find((p: any) => p.name === parameter)?.required, true);
  }
  // Genuine binary files still have upload references as business inputs.
  for (const name of ["app_save_user_template_source", "app_commit_uploaded_source_host_upload", "app_commit_managed_font_host_upload", "app_commit_manual_page_image"]) {
    assert.ok(internal.tools.find((tool: any) => tool.name === name)?.parameters.some((p: any) => p.name === "host_upload"));
  }
});

test("parameter description is required", () => {
  assert.throws(
    () => validateToolManifest(manifestWithParameter({ name: "workspace_dir", type: "string" })),
    /tools\[0\]\.parameters\[0\]\.description: must be a non-empty string/,
  );
});

test("array parameters require an element type", () => {
  assert.throws(
    () => validateToolManifest(manifestWithParameter({
      name: "page_ids",
      type: "array",
      description: "Page ids.",
    })),
    /tools\[0\]\.parameters\[0\]\.items: array parameters must declare/,
  );
});

test("array parameters accept items.type and items_type", () => {
  assert.doesNotThrow(() => validateToolManifest(manifestWithParameter({
    name: "page_ids",
    type: "array",
    items: { type: "string" },
    description: "Page ids.",
  })));
  assert.doesNotThrow(() => validateToolManifest(manifestWithParameter({
    name: "pages",
    type: "array",
    items_type: "object",
    description: "Pages.",
  })));
});
