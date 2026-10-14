import { encodeToolRequest, decodeToolResponse } from "../helpers/invoke.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

type JsonRpcResponse = {
  id: string | number | null;
  __file_transport?: string;
  __trans_file__?: string;
  result?: {
    success?: boolean;
    data?: Record<string, unknown>;
    version?: string;
    tools?: Array<{ name: string; parameters?: Array<{ name: string; required?: boolean }> }>;
  };
  error?: { message?: string };
};

function getToolParameter(
  manifest: {
    tools: Array<{
      name: string;
      parameters?: Array<{ name: string; required?: boolean; description?: string }>;
    }>;
  },
  toolName: string,
  parameterName: string,
) {
  const tool = manifest.tools.find((item) => item.name === toolName);
  assert.ok(tool, `Missing tool ${toolName}`);
  const parameter = tool.parameters?.find((item) => item.name === parameterName);
  assert.ok(parameter, `Missing parameter ${parameterName} on ${toolName}`);
  return parameter;
}

class PluginProcess {
  private nextId = 1;
  private readonly pending = new Map<string | number, (response: JsonRpcResponse) => void>();
  private readonly lines: Interface;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", async (line) => {
      let response = JSON.parse(line) as JsonRpcResponse;
      const transportPath = response.__file_transport ?? response.__trans_file__;
      if (transportPath) {
        response = JSON.parse(await readFile(transportPath, "utf8")) as JsonRpcResponse;
      }
      const resolve = this.pending.get(response.id ?? "");
      if (resolve) {
        this.pending.delete(response.id ?? "");
        resolve(response);
      }
    });
  }

  async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise<JsonRpcResponse>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.child.stdin.write(`${JSON.stringify(await encodeToolRequest({ jsonrpc: "2.0", id, method, params }))}\n`);
    return promise.then(decodeToolResponse);
  }

  async close() {
    this.lines.close();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill("SIGTERM");
    await exited;
  }
}

async function startPluginProcess(workspaceRoot?: string): Promise<PluginProcess> {
  const child = spawn(process.execPath, ["example_plugin.js"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdio: ["pipe", "pipe", "pipe"],
    ...(workspaceRoot ? { env: { ...process.env, SLIDEFORGE_WORKSPACE_DIR: workspaceRoot } } : {}),
  });
  child.stderr.resume();
  return new PluginProcess(child);
}

test("按页搜索经统一网关保存原始任务并保留租约校验", { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-page-search-inline-"));
  const plugin = await startPluginProcess(root);
  try {
    const created = await plugin.request("invoke", { tool: "app_create_workspace", arguments: { title: "直接保存补图任务" } });
    assert.equal(created.error, undefined);
    const workspaceDir = String(created.result?.data?.workspace_dir);
    const owner = randomUUID();
    const task = { id: randomUUID(), context: { target_key: "draft", page: { title: "当前页" } },
      max_searches: 10, checkpoint: { schema_version: 2, stages: {}, image: { searches: [] } }, status: "running", result_ids: [] as string[] };
    const invoke = (args: Record<string, unknown>) => plugin.request("invoke", {
      tool: "app_page_image_search", arguments: { workspace_dir: workspaceDir, owner, ...args },
    });
    const acquired = await invoke({ action: "acquire", task });
    assert.equal(acquired.error, undefined);
    assert.equal(acquired.result?.data?.id, task.id);
    task.status = "completed";
    task.result_ids = ["image-one"];
    assert.match((await invoke({ action: "save", task, owner: randomUUID() })).error?.message ?? "", /LEASE_LOST/);
    assert.match((await invoke({ action: "save", task: undefined })).error?.message ?? "", /task|任务/i);
    assert.equal((await invoke({ action: "save", task })).error, undefined);
    const stored = JSON.parse(await readFile(path.join(workspaceDir, "research/page-image-search", `${task.id}.json`), "utf8"));
    assert.equal(stored.status, "completed");
    assert.deepEqual(stored.result_ids, ["image-one"]);
    assert.equal((await invoke({ action: "release" })).error, undefined);
  } finally {
    await plugin.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("app_get_runtime_info returns the same version as describe", async () => {
  const plugin = await startPluginProcess();

  try {
    const describe = await plugin.request("describe");
    const runtimeInfo = await plugin.request("invoke", {
      tool: "app_get_runtime_info",
      arguments: {},
    });

    assert.ok(!describe.error, describe.error?.message);
    assert.ok(!runtimeInfo.error, runtimeInfo.error?.message);
    assert.equal(runtimeInfo.result?.data?.ppt_engine_version, describe.result?.version);
  } finally {
    await plugin.close();
  }
});

test("snapshot publication is exposed only through the dedicated invoke", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../invoke-tools.json", import.meta.url), "utf8"),
  ) as { tools: Array<{ name: string }> };
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const toolNames = manifest.tools.map((tool) => tool.name);

  assert.ok(toolNames.includes("app_run_workspace_snapshot_publish_dedicated_invoke"));
  assert.ok(!toolNames.includes("app_run_workspace_snapshot_publish"));
  assert.doesNotMatch(source, /setInterval\(scheduleAutoPublishSweep/);
  assert.doesNotMatch(source, /app_run_workspace_snapshot_publish: toolAppRunWorkspaceSnapshotPublish/);
});

test("diagnostic switch survives plugin restart and never blocks workspace state writes", { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-log-switch-"));
  let plugin = await startPluginProcess(root);
  try {
    const described = await plugin.request("describe");
    for (const tool of described.result?.tools ?? []) {
      if (tool.name.startsWith("app_")) {
        assert.ok(tool.parameters?.some((p) => p.name === "diagnostic_logging_enabled"));
      }
    }
    const created = await plugin.request("invoke", {
      tool: "app_create_workspace", arguments: { title: "日志关闭仍创建作品", diagnostic_logging_enabled: false },
    });
    assert.equal(created.error, undefined);
    const workspaceDir = String(created.result?.data?.workspace_dir);
    assert.ok(path.isAbsolute(workspaceDir));
    await stat(path.join(workspaceDir, "task.json"));
    const args = { workspace_dir: workspaceDir, channel: "ai-outline", entry: { event: "switch-test" } };
    const invoke = (extra: Record<string, unknown>) => plugin.request("invoke", {
      tool: "app_append_workspace_log", arguments: { ...args, ...extra },
    });
    for (const extra of [{}, { diagnostic_logging_enabled: false, entry: undefined }]) {
      const result = await invoke(extra);
      assert.equal(result.error, undefined);
      assert.equal(result.result?.data?.appended, false);
    }
    await assert.rejects(stat(path.join(workspaceDir, ".log")), { code: "ENOENT" });
    const invalid = await invoke({ diagnostic_logging_enabled: "true" });
    assert.match(invalid.error?.message ?? "", /must be a boolean/);
    const enabled = await invoke({ diagnostic_logging_enabled: true });
    assert.equal(enabled.result?.data?.appended, true);
    const logPath = path.join(workspaceDir, ".log", "ai-outline.jsonl");
    const before = await readFile(logPath, "utf8");
    await invoke({ diagnostic_logging_enabled: false });
    assert.equal(await readFile(logPath, "utf8"), before);
    await plugin.close();
    plugin = await startPluginProcess(root);
    assert.equal((await invoke({})).result?.data?.appended, false);
    assert.equal((await invoke({ diagnostic_logging_enabled: true })).result?.data?.appended, true);
    assert.equal((await readFile(logPath, "utf8")).trim().split("\n").length, 2);
  } finally {
    await plugin.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("app_update_workspace_settings plugin wrapper forwards persist_as_default", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");

  assert.match(
    source,
    /persist_as_default:\s*args\.persist_as_default\s*===\s*true/,
  );
});

test("app_patch_workspace_settings is declared and returns settings without a workspace upload", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("../../invoke-tools.json", import.meta.url), "utf8"),
  ) as { tools: Array<{ name: string }> };

  assert.match(source, /app_patch_workspace_settings:\s*toolAppPatchWorkspaceSettings/);
  assert.match(source, /return patchAppWorkspaceSettings\(\{/);
  assert.ok(manifest.tools.some((tool) => tool.name === "app_patch_workspace_settings"));
});

test("template reference tools separate bounded metadata from one HTML page", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("../../invoke-tools.json", import.meta.url), "utf8"),
  ) as { tools: Array<{ name: string; parameters?: Array<{ name: string; required?: boolean }> }> };
  const toolNames = manifest.tools.map((tool) => tool.name);

  assert.match(source, /app_list_workspace_template_references:\s*toolAppListWorkspaceTemplateReferences/);
  assert.match(source, /app_get_workspace_template_reference_html:\s*toolAppGetWorkspaceTemplateReferenceHtml/);
  assert.ok(toolNames.includes("app_list_workspace_template_references"));
  assert.ok(toolNames.includes("app_get_workspace_template_reference_html"));
  assert.equal(toolNames.includes("app_get_workspace_template_reference_snapshot"), false);
  assert.equal(
    manifest.tools
      .find((tool) => tool.name === "app_get_workspace_template_reference_html")
      ?.parameters?.find((parameter) => parameter.name === "path")?.required,
    true,
  );
});

test("app_duplicate_workspace is declared and routed to the Workspace duplication API", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("../../invoke-tools.json", import.meta.url), "utf8"),
  ) as { tools: Array<{ name: string; parameters?: Array<{ name: string; required?: boolean }> }> };

  assert.match(source, /app_duplicate_workspace:\s*toolAppDuplicateWorkspace/);

  const tool = manifest.tools.find((item) => item.name === "app_duplicate_workspace");
  assert.ok(tool);
  assert.equal(tool.parameters?.find((item) => item.name === "workspace_dir")?.required, true);
  assert.equal(tool.parameters?.find((item) => item.name === "title")?.required, false);
});

test("legacy image tools stay retired; HTML and current WebP thumbnails have separate tools", async () => {
  const manifest = JSON.parse(await readFile(path.join(process.cwd(), "invoke-tools.json"), "utf8"));
  assert.equal(manifest.tools.some((tool: { name: string }) => ["app_get_workspace_cover", "app_get_workspace_page_image"].includes(tool.name)), false);
  const html = manifest.tools.find((tool: { name: string }) => tool.name === "app_get_workspace_page_html");
  assert.equal(html.parameters.find((item: { name: string }) => item.name === "page_id").required, false);
  const thumbnail = manifest.tools.find((tool: { name: string }) => tool.name === "app_get_workspace_page_thumbnail");
  assert.ok(thumbnail);
  assert.equal(thumbnail.parameters.find((item: { name: string }) => item.name === "page_id").required, false);
});

test("preview image uploads snapshot local bytes before Host Upload negotiation", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");

  const uploadPreviewImage = source.slice(
    source.indexOf("async function uploadPreviewImage("),
    source.indexOf("function parseRequestLine("),
  );
  const uploadLocalFileToHost = source.slice(
    source.indexOf("async function uploadLocalFileToHost("),
    source.indexOf("async function uploadBufferToHost("),
  );

  assert.match(uploadPreviewImage, /reuseWhileValid:\s*true/);
  assert.match(uploadPreviewImage, /snapshotBeforeNegotiate:\s*true/);
  assert.match(
    uploadLocalFileToHost,
    /snapshotBeforeNegotiate\s*\?\s*await readFile\(normalizedPath\)\s*:\s*null/,
  );
  assert.match(
    uploadLocalFileToHost,
    /body:\s*fileSnapshot\s*\?\?\s*createReadStream\(normalizedPath\)/,
  );
  assert.ok(
    uploadLocalFileToHost.indexOf("const sizeBytes = fileStat.size") <
      uploadLocalFileToHost.indexOf("await readFile(normalizedPath)"),
    "the expected byte size must be initialized before reading and validating the snapshot",
  );
  assert.ok(
    uploadLocalFileToHost.indexOf("await readFile(normalizedPath)") <
      uploadLocalFileToHost.indexOf("await hostUploadClient.negotiate"),
    "preview bytes must be captured before the async Host Upload negotiation",
  );
  assert.match(source, /readCachedHostUpload\(hostUploadCache, cacheKey\)/);
});

test("Workspace Diagnostic Bundle tool is declared and routed through the APS plugin wrapper", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("../../invoke-tools.json", import.meta.url), "utf8"),
  ) as { tools: Array<{ name: string }> };

  assert.match(
    source,
    /app_prepare_workspace_diagnostic_bundle:\s*toolAppPrepareWorkspaceDiagnosticBundle/,
  );
  assert.ok(
    manifest.tools.some((tool) => tool.name === "app_prepare_workspace_diagnostic_bundle"),
  );
});

test("dedicated Outline lifecycle tools are declared and routed", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("../../invoke-tools.json", import.meta.url), "utf8"),
  ) as { tools: Array<{ name: string }> };
  const toolNames = manifest.tools.map((tool) => tool.name);

  assert.match(source, /app_reset_workspace_outline:\s*toolAppResetWorkspaceOutline/);
  assert.match(source, /app_save_workspace_outline_draft:\s*toolAppSaveWorkspaceOutlineDraft/);
  assert.match(source, /app_confirm_workspace_outline:\s*toolAppConfirmWorkspaceOutline/);
  assert.ok(toolNames.includes("app_reset_workspace_outline"));
  assert.ok(toolNames.includes("app_save_workspace_outline_draft"));
  assert.ok(toolNames.includes("app_confirm_workspace_outline"));
  assert.equal(toolNames.includes("app_update_workspace_outline"), false);
});

let patchSettingsInvokeSkip: string | false = false;
try {
  const distIndex = await readFile(new URL("../../dist/index.js", import.meta.url), "utf8");
  if (!distIndex.includes("patchAppWorkspaceSettings")) {
    patchSettingsInvokeSkip = "requires a built dist/index.js with patchAppWorkspaceSettings support";
  }
} catch {
  patchSettingsInvokeSkip = "requires a built dist/index.js";
}

test(
  "app_patch_workspace_settings plugin invoke returns inline settings data",
  { skip: patchSettingsInvokeSkip, timeout: 15_000 },
  async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "presenton-plugin-settings-home-"));
    const workspaceDir = path.join(homeDir, "slideforge-workspace", "ppt", "ppt-20260710-000001");
    const previousHome = process.env.HOME;
    const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
    process.env.HOME = homeDir;
    process.env.SLIDEFORGE_WORKSPACE_DIR = path.join(homeDir, "slideforge-workspace");
    const plugin = await startPluginProcess();

    try {
      const response = await plugin.request("invoke", {
        tool: "app_patch_workspace_settings",
        arguments: {
          workspace_dir: workspaceDir,
          setting: { visual_review_enabled: true },
          persist_as_default: true,
        },
      });

      assert.ok(!response.error, response.error?.message);
      assert.equal(response.result?.data?.workspace_dir, workspaceDir);
      assert.deepEqual(response.result?.data?.setting, {
        page_generation_concurrency: 5,
        research_image_session_concurrency: 5,
        research_web_max_rounds: 10,
        research_image_max_searches: 10,
        updated_at: (response.result?.data?.setting as Record<string, unknown>)?.updated_at,
      });
      assert.equal(response.result?.data?.persisted_as_default, true);
      assert.equal("workspace_upload" in (response.result?.data ?? {}), false);
    } finally {
      await plugin.close();
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
        if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
        else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
      }
      await rm(homeDir, { recursive: true, force: true });
    }
  },
);

test("app_get_workspace_defaults is declared and routed", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("../../invoke-tools.json", import.meta.url), "utf8"),
  ) as { tools: Array<{ name: string }> };

  assert.match(source, /app_get_workspace_defaults:\s*toolAppGetWorkspaceDefaults/);
  assert.ok(manifest.tools.some((tool) => tool.name === "app_get_workspace_defaults"));
});

test("Authoring Kit and Page Source workspace tools are declared and routed", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("../../invoke-tools.json", import.meta.url), "utf8"),
  ) as { tools: Array<{ name: string; parameters?: Array<{ name: string; required?: boolean }> }> };

  for (const [toolName, handlerName] of [
    ["app_install_workspace_authoring_kit", "toolAppInstallWorkspaceAuthoringKit"],
    ["app_ensure_confirmed_outline_page_ids", "toolAppEnsureConfirmedOutlinePageIds"],
    ["app_prepare_workspace_page_sources", "toolAppPrepareWorkspacePageSources"],
    ["app_reconcile_workspace_page_sources", "toolAppReconcileWorkspacePageSources"],
    ["app_commit_workspace_style_guide", "toolAppCommitWorkspaceStyleGuide"],
    ["app_get_workspace_style_guide_status", "toolAppGetWorkspaceStyleGuideStatus"],
    ["app_get_workspace_style_guide", "toolAppGetWorkspaceStyleGuide"],
    ["app_prepare_page_refinement", "toolAppPreparePageRefinement"],
    ["app_commit_deck_refinement", "toolAppCommitDeckRefinement"],
    ["app_initialize_page_progress", "toolAppInitializePageProgress"],
    ["app_rebuild_workspace_deck_manifest", "toolAppRebuildWorkspaceDeckManifest"],
    ["app_get_workspace_page_source_fingerprint", "toolAppGetWorkspacePageSourceFingerprint"],
  ] as const) {
    assert.match(source, new RegExp(`${toolName}:\\s*${handlerName}`));
    assert.ok(manifest.tools.some((tool) => tool.name === toolName), `Missing ${toolName}`);
    assert.equal(getToolParameter(manifest, toolName, "workspace_dir").required, true);
  }

  assert.equal(
    getToolParameter(manifest, "app_get_workspace_page_source_fingerprint", "page_id").required,
    true,
  );
});

test("Refinement plugin wrappers define their required string argument parser", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");

  assert.match(source, /function readRequiredStringArg\(args, parameterName\)/);
  assert.match(source, /page_id:\s*readRequiredStringArg\(args, "page_id"\)/);
  assert.match(source, /style_guide_action: readRequiredStringArg\(args, "style_guide_action"\)/);
});

test("text staging waits for persistence and cleans up after success or failure", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("async function withStagedAppText("), source.indexOf("\nasync function toolAppCommitWorkspaceStyleGuide("));
  const directory = await mkdtemp(path.join(os.tmpdir(), "ppt-text-stage-"));
  const content = "中文 test";
  const size_bytes = Buffer.byteLength(content);
  const stage = new Function("dependencies", `
    const { path, randomUUID, mkdir, writeFile, unlink, STYLE_GUIDE_STAGING_DIR } = dependencies;
    ${code}
    return withStagedAppText;
  `)({ path, randomUUID, mkdir, writeFile, unlink: (file: string) => rm(file),
    STYLE_GUIDE_STAGING_DIR: directory,
  });
  try {
    {
      let stagedFile = "";
      const result = await stage({ content }, "md", async (file: string, bytes: number) => {
        stagedFile = file;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(bytes, size_bytes);
        return readFile(file, "utf8");
      });
      assert.equal(result, content);
      await assert.rejects(stat(stagedFile), { code: "ENOENT" });
      await assert.rejects(stage({ content }, "md", async (file: string) => {
        stagedFile = file;
        throw new Error("persist failed");
      }), /persist failed/);
      await assert.rejects(stat(stagedFile), { code: "ENOENT" });
      await assert.rejects(stage({ content }, "md", () => assert.fail("must reject oversized input"), 1), /limit/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Shared Research Image local import waits for persistence before staging cleanup", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const handler = source.match(
    /async function toolAppImportSharedResearchImageLocal\(args\) \{[\s\S]*?\n\}/,
  )?.[0];

  assert.ok(handler, "Missing Shared Research Image local import handler");
  assert.match(handler, /const result = await importAppSharedResearchImage\(\{/);
  assert.match(handler, /await unlink\(localFilePath\)/);
});

test("app_get_rendered_deck_html is declared, routed, and metadata-only", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("../../invoke-tools.json", import.meta.url), "utf8"),
  ) as { tools: Array<{ name: string }> };

  assert.match(source, /app_get_rendered_deck_html:\s*toolAppGetRenderedDeckHtml/);
  assert.ok(manifest.tools.some((tool) => tool.name === "app_get_rendered_deck_html"));
  assert.ok(manifest.tools.some((tool) => tool.name === "app_prepare_workspace_page_preview"));
  assert.ok(manifest.tools.some((tool) => tool.name === "app_get_workspace_page_preview_preparation"));
  assert.match(source, /app_prepare_workspace_page_preview:\s*toolAppPrepareWorkspacePagePreview/);
  assert.match(source, /app_get_workspace_page_preview_preparation:\s*toolAppGetWorkspacePagePreviewPreparation/);
  const wrapper = source.slice(
    source.indexOf("async function toolAppGetRenderedDeckHtml("),
    source.indexOf("async function toolAppGetWorkspacePageThumbnail("),
  );
  assert.match(wrapper, /getRenderedAppWorkspaceDeckHtml\(\{/);
  assert.doesNotMatch(wrapper, /uploadPreviewImage\(/);
});

test("app_rasterize_pptx_to_images is declared and routed", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("../../invoke-tools.json", import.meta.url), "utf8"),
  ) as { tools: Array<{ name: string; parameters?: Array<{ name: string; required?: boolean }> }> };

  assert.match(source, /app_rasterize_pptx_to_images:\s*toolAppRasterizePptxToImages/);
  assert.match(source, /rasterizePptxToImages\(/);
  assert.equal(getToolParameter(manifest, "app_rasterize_pptx_to_images", "pptx_path").required, true);
  assert.equal(getToolParameter(manifest, "app_rasterize_pptx_to_images", "output_dir").required, true);
  assert.equal(getToolParameter(manifest, "app_rasterize_pptx_to_images", "target_height").required, false);
  assert.equal(getToolParameter(manifest, "app_rasterize_pptx_to_images", "overwrite").required, false);
});

test("style profile app tools are declared and routed", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("../../invoke-tools.json", import.meta.url), "utf8"),
  ) as { tools: Array<{ name: string; parameters?: Array<{ name: string; required?: boolean }> }> };

  for (const [toolName, handlerName] of [
    ["app_list_style_profiles", "toolAppListStyleProfiles"],
    ["app_get_style_profile_preview", "toolAppGetStyleProfilePreview"],
    ["app_get_style_profile", "toolAppGetStyleProfile"],
    ["app_prepare_style_profile_creation", "toolAppPrepareStyleProfileCreation"],
    ["app_commit_style_profile_reference_host_upload", "toolAppCommitStyleProfileReferenceHostUpload"],
    ["app_get_style_profile_creation_context", "toolAppGetStyleProfileCreationContext"],
    ["app_get_style_profile_draft_fingerprint", "toolAppGetStyleProfileDraftFingerprint"],
    ["app_get_style_profile_draft", "toolAppGetStyleProfileDraft"],
    ["app_publish_style_profile", "toolAppPublishStyleProfile"],
    ["app_select_workspace_style_profile", "toolAppSelectWorkspaceStyleProfile"],
    ["app_get_workspace_style_profile", "toolAppGetWorkspaceStyleProfile"],
    ["app_clear_workspace_style_profile", "toolAppClearWorkspaceStyleProfile"],
  ] as const) {
    assert.match(source, new RegExp(`${toolName}:\\s*${handlerName}`));
    assert.ok(manifest.tools.some((tool) => tool.name === toolName), `Missing ${toolName}`);
  }

  assert.equal(
    getToolParameter(manifest, "app_get_style_profile_preview", "style_profile_id").required,
    true,
  );
  assert.equal(
    getToolParameter(manifest, "app_get_style_profile", "style_profile_id").required,
    true,
  );
  assert.match(source, /uploadStyleProfileReferenceImagePreview/);
  assert.match(source, /const\s+\{\s*file_path,\s*\.\.\.publicImage\s*\}\s*=\s*image/);
  assert.match(source, /image_upload:\s*await uploadLocalFileToHost/);

  assert.equal(
    getToolParameter(manifest, "app_commit_style_profile_reference_host_upload", "creation_id").required,
    true,
  );
  assert.equal(
    getToolParameter(manifest, "app_commit_style_profile_reference_host_upload", "host_upload").required,
    true,
  );
  assert.equal(
    getToolParameter(manifest, "app_publish_style_profile", "display_name").required,
    false,
  );
});

test("legacy research tools are no longer declared or routed", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("../../invoke-tools.json", import.meta.url), "utf8"),
  ) as { tools: Array<{ name: string }> };

  const legacyToolNames = [
    "app_prepare_research_workspace",
    "app_record_research_plan",
    "app_get_research_plan",
    "app_append_research_evidence",
    "app_get_research_evidence",
    "app_record_page_evidence_assignment",
    "app_get_page_evidence_assignment",
    "app_finalize_research_visual_assets",
    "app_record_research_curation_draft",
    "app_get_research_curation_draft",
    "app_get_research_curation_draft_fingerprint",
    "app_record_research_status",
    "app_get_research_status",
    "app_get_shared_research_image_download_urls",
    "app_import_shared_research_image_aps",
  ];

  for (const toolName of legacyToolNames) {
    assert.equal(manifest.tools.some((tool) => tool.name === toolName), false, toolName);
    assert.equal(source.includes(`${toolName}:`), false, toolName);
  }
});

test("legacy Template Group preview tool is no longer declared or routed", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("../../invoke-tools.json", import.meta.url), "utf8"),
  ) as { tools: Array<{ name: string }> };

  assert.equal(
    manifest.tools.some((tool) => tool.name === "app_get_template_preview"),
    false,
  );
  assert.equal(source.includes("app_get_template_preview:"), false);
});

test("page preview rendering and current screenshot upload are separate tools", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("../../invoke-tools.json", import.meta.url), "utf8"),
  ) as { tools: Array<{ name: string }> };

  assert.match(source, /app_render_workspace_page_preview:\s*toolAppRenderWorkspacePagePreview/);
  assert.match(source, /app_upload_current_page_screenshot:\s*toolAppUploadCurrentPageScreenshot/);
  assert.ok(manifest.tools.some((tool) => tool.name === "app_upload_current_page_screenshot"));
  assert.match(source, /getAppPageProgress\(\{ workspace_dir: workspaceDir \}\)/);
});

test("workspace theme token tools are declared and routed", async () => {
  const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("../../invoke-tools.json", import.meta.url), "utf8"),
  ) as { tools: Array<{ name: string; parameters?: Array<{ name: string; required?: boolean }> }> };

  for (const [toolName, handlerName] of [
    ["app_get_workspace_theme_context", "toolAppGetWorkspaceThemeContext"],
    ["app_validate_workspace_theme_token", "toolAppValidateWorkspaceThemeToken"],
    ["app_record_workspace_theme_token", "toolAppRecordWorkspaceThemeToken"],
  ] as const) {
    assert.match(source, new RegExp(`${toolName}:\\s*${handlerName}`));
    assert.ok(manifest.tools.some((tool) => tool.name === toolName), `Missing ${toolName}`);
  }

  assert.equal(
    getToolParameter(manifest, "app_record_workspace_theme_token", "use_default").required,
    false,
  );

  assert.match(source, /"ai-theme"/);
  assert.match(source, /"ai-theme-interactions"/);
  assert.match(
    getToolParameter(manifest, "app_append_workspace_log", "channel").description ?? "",
    /ai-theme-interactions/,
  );
});

let pluginInvokeSkip: string | false = false;
try {
  await readFile(new URL("../../dist/index.js", import.meta.url), "utf8");
} catch {
  pluginInvokeSkip = "requires a built dist/index.js";
}

test("first-page HTML cover stays bounded without a screenshot or Host Upload", { skip: pluginInvokeSkip, timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-html-cover-"));
  const workspaceDir = path.join(root, "ppt", "ppt-20260915-000001");
  const outputDir = path.join(workspaceDir, "output");
  await mkdir(outputDir, { recursive: true });
  const htmlPath = path.join(outputDir, "first.html");
  const pageId = "page-11111111-1111-4111-8111-111111111111";
  await writeFile(htmlPath, "<!doctype html><html><body>HTML cover</body></html>");
  await mkdir(path.join(workspaceDir, "slides"));
  await writeFile(path.join(workspaceDir, "slides", `${pageId}.html`),
    '<!doctype html><html><body><div data-presenton-slide-shell="true">HTML cover</div></body></html>');
  await writeFile(path.join(workspaceDir, "outline.json"), JSON.stringify({
    version: 4, title: "Cover", status: "confirmed",
    items: [{ page_id: pageId, page_type: "cover", title: "Cover", content: "HTML cover" }],
    updated_at: "2026-09-18T00:00:00.000Z", confirmed_at: "2026-09-18T00:00:00.000Z",
  }));
  await writeFile(path.join(workspaceDir, "page-progress.json"), JSON.stringify({
    version: 1, pages: [{ page_id: pageId, status: "accepted", last_html_path: htmlPath }],
  }));
  const plugin = await startPluginProcess(root);
  try {
    // No reverse-RPC responder: a small, resource-free cover must stay inline.
    const response = await plugin.request("invoke", {
      tool: "app_get_workspace_page_html", arguments: { workspace_dir: workspaceDir },
    });
    assert.ok(!response.error, response.error?.message);
    assert.equal(response.result?.success, true);
    assert.match(JSON.stringify(response.result?.data), /HTML cover/);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 48 * 1024);
    await assert.rejects(stat(path.join(outputDir, "covers")), { code: "ENOENT" });
  } finally {
    await plugin.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("app_append_workspace_log plugin wrapper accepts attachment, research web, theme, style-guide, and storage log channels", { skip: pluginInvokeSkip }, async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "presenton-plugin-theme-log-home-"));
  const workspaceDir = path.join(homeDir, "slideforge-workspace", "ppt", "ppt-20260701-000002");
  const previousHome = process.env.HOME;
  const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
  process.env.HOME = homeDir;
  process.env.SLIDEFORGE_WORKSPACE_DIR = path.join(homeDir, "slideforge-workspace");
  const plugin = await startPluginProcess();

  try {
    for (const channel of [
      "attachment-preflight",
      "ai-theme",
      "ai-theme-interactions",
      "ai-style-guide",
      "ai-style-guide-interactions",
      "research-web-interactions",
      "storage-transport",
    ] as const) {
      const response = await plugin.request("invoke", {
        tool: "app_append_workspace_log",
        arguments: {
          workspace_dir: workspaceDir,
          channel,
          diagnostic_logging_enabled: true,
          entry: {
            event: `${channel}.test`,
            schema_version: 1,
          },
        },
      });
      assert.ok(!response.error, response.error?.message);
    }

    const attachmentLog = await readFile(path.join(workspaceDir, ".log", "attachment-preflight.jsonl"), "utf8");
    const themeLog = await readFile(path.join(workspaceDir, ".log", "ai-theme.jsonl"), "utf8");
    const themeInteractionLog = await readFile(
      path.join(workspaceDir, ".log", "ai-theme-interactions.jsonl"),
      "utf8",
    );
    const styleGuideLog = await readFile(path.join(workspaceDir, ".log", "ai-style-guide.jsonl"), "utf8");
    const styleGuideInteractionLog = await readFile(
      path.join(workspaceDir, ".log", "ai-style-guide-interactions.jsonl"),
      "utf8",
    );
    const storageLog = await readFile(path.join(workspaceDir, ".log", "storage-transport.jsonl"), "utf8");
    const researchWebLog = await readFile(path.join(workspaceDir, ".log", "research-web-interactions.jsonl"), "utf8");
    assert.match(attachmentLog, /attachment-preflight\.test/);
    assert.match(themeLog, /ai-theme\.test/);
    assert.match(themeInteractionLog, /ai-theme-interactions\.test/);
    assert.match(styleGuideLog, /ai-style-guide\.test/);
    assert.match(styleGuideInteractionLog, /ai-style-guide-interactions\.test/);
    assert.match(researchWebLog, /research-web-interactions\.test/);
    assert.match(storageLog, /storage-transport\.test/);
  } finally {
    await plugin.close();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
      if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
      else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
    }
    await rm(homeDir, { recursive: true, force: true });
  }
});
