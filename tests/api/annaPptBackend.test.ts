import { withOrdinaryInvokeTransport } from "../helpers/invokeRuntime";
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { createAnnaPptBackend } from "../../src/api/annaPptBackend.ts";
import type {
  CreateWorkspaceResult,
  WorkspaceResult,
} from "../../src/api/types.ts";
import type { AnnaRuntime, AnnaToolInvokeInput } from "../../src/runtime/annaRuntime.ts";

function setToolIds() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __ANNA_TOOL_IDS__: {
        "ppt-engine": "tool-ppt-engine",
      },
    },
  });
}

function createRuntime(result: unknown): AnnaRuntime {
  return {
    tools: {
      invoke: withOrdinaryInvokeTransport(async () => result),
    },
    llm: { complete: async () => ({}) },
    agent: { session: async () => { throw new Error("not used"); } },
  };
}

function createRuntimeWithInvoke(invoke: AnnaRuntime["tools"]["invoke"]): AnnaRuntime {
  return {
    tools: { invoke: withOrdinaryInvokeTransport(invoke) },
    llm: { complete: async () => ({}) },
    agent: { session: async () => { throw new Error("not used"); } },
  };
}

function createWorkspace(patch: Partial<WorkspaceResult> = {}): WorkspaceResult {
  return {
    workspace_root: "/tmp/workspaces",
    workspace_dir: "/tmp/workspaces/demo",
    workspace_id: "demo",
    initialized: true,
    created_files: [],
    missing_files: [],
    files: {
      task: "/tmp/workspaces/demo/task.json",
      setting: "/tmp/workspaces/demo/setting.json",
      requirements: "/tmp/workspaces/demo/requirements.json",
      outline: "/tmp/workspaces/demo/outline.json",
      pages: "/tmp/workspaces/demo/pages.json",
      template: "/tmp/workspaces/demo/template.json",
    },
    task: {},
    setting: {},
    requirements: {
      version: 1,
      status: "empty",
      source: null,
      candidates: { slide_count: [], output_language: [], },
      selections: { slide_count: null, output_language: null, },
      updated_at: null,
      confirmed_at: null,
    },
    outline: {},
    pages: [],
    template: {},
    ...patch,
  };
}

describe("Anna PPT Backend", () => {
  it("records bounded preview recovery warnings even when verbose diagnostics are disabled", async () => {
    setToolIds();
    const calls: AnnaToolInvokeInput[] = [];
    const backend = createAnnaPptBackend(createRuntimeWithInvoke(async (input) => {
      calls.push(input); return { success: true, data: { workspace_dir: "/tmp/workspace", log_file: "preview-recovery.jsonl", appended: true } };
    }), { diagnosticLoggingEnabled: false });
    assert.equal((await backend.appendWorkspaceLog({ workspace_dir: "/tmp/workspace", channel: "storage-transport", entry: {} })).appended, false);
    assert.equal((await backend.appendWorkspaceLog({ workspace_dir: "/tmp/workspace", channel: "preview-recovery",
      entry: { event: "preview.fallback", source: "saved_snapshot", page_id: "page-a", error_kind: "missing_snapshot" } })).appended, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "app_append_workspace_log");
  });

  it("prepares a page recovery token, submits it once, and triggers normal APS persistence", async () => {
    setToolIds();
    const calls: AnnaToolInvokeInput[] = [];
    const input = { workspace_dir: "/tmp/workspace", page_id: "page-a" };
    const token = "a".repeat(64);
    const backend = createAnnaPptBackend(createRuntimeWithInvoke(async (call) => {
      calls.push(call);
      return { success: true, data: call.method === "app_prepare_page_recovery"
        ? { ...input, available: true, source: "manual_base", recovery_token: token }
        : call.method === "app_restore_page_source_version" ? { ...input, restored: true } : {} };
    }));
    const option = await backend.preparePageRecovery(input);
    await backend.restorePageSourceVersion({ ...input, recovery_token: option.recovery_token });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.map((call) => call.method), ["app_prepare_page_recovery", "app_restore_page_source_version", "app_run_workspace_snapshot_publish_dedicated_invoke"]);
    assert.equal((calls[1].args as any).recovery_token, token);
    assert.equal((calls[2].args as any).trigger, "page-restore");
    const wrong = createAnnaPptBackend(createRuntime({ success: true, data: { ...input, available: true, source: "thumbnail", recovery_token: token } }));
    await assert.rejects(wrong.preparePageRecovery(input), /Invalid page recovery option/);
  });

  it("requires explicit view-only permission for fallback HTML", async () => {
    setToolIds();
    const backend = createAnnaPptBackend(createRuntime({ success: true, data: { page_id: "page-a", html: "<html>backup</html>",
      preview_source_fingerprint: "old", html_fingerprint: "old-html", resources_expires_at: null, fallback: { source: "manual_base" } } }));
    await assert.rejects(backend.getWorkspacePageHtml({ workspace_dir: "/tmp/workspace", page_id: "page-a" }), /Unexpected preview fallback/);
    assert.equal((await backend.getWorkspacePageHtml({ workspace_dir: "/tmp/workspace", page_id: "page-a", fallback_only: true })).fallback?.source, "manual_base");
  });
  it("paginates workspace listing below the local Executa line limit and merges every page", async () => {
    setToolIds();
    const calls: AnnaToolInvokeInput[] = [];
    const pages = new Map<string, Record<string, unknown>>([
      ["", {
        workspace_root: "/tmp/workspaces",
        has_workspaces: true,
        latest_workspace: { workspace_id: "newest", workspace_dir: "/tmp/workspaces/newest", title: "Newest", status: "ready", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z", has_deck_html: true },
        workspaces: [{ workspace_id: "newest", workspace_dir: "/tmp/workspaces/newest", title: "Newest", status: "ready", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z", has_deck_html: true }],
        next_cursor: "40",
      }],
      ["40", {
        workspace_root: "/tmp/workspaces",
        has_workspaces: true,
        latest_workspace: { workspace_id: "newest", workspace_dir: "/tmp/workspaces/newest", title: "Newest", status: "ready", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z", has_deck_html: true },
        workspaces: [{ workspace_id: "older", workspace_dir: "/tmp/workspaces/older", title: "Older", status: "ready", created_at: "2025-12-01T00:00:00.000Z", updated_at: "2025-12-02T00:00:00.000Z", has_deck_html: false }],
      }],
    ]);
    const backend = createAnnaPptBackend(createRuntimeWithInvoke(async (input) => {
      calls.push(input);
      const args = input.args as { cursor?: string };
      return { success: true, data: pages.get(args.cursor ?? "") };
    }));

    const result = await backend.listWorkspaces();

    assert.deepEqual(result.workspaces.map((workspace) => workspace.workspace_id), ["newest", "older"]);
    assert.deepEqual(calls.map((call) => call.args), [
      { limit: 40, diagnostic_logging_enabled: false },
      { limit: 40, cursor: "40", diagnostic_logging_enabled: false },
    ]);
  });

  it("skips disabled logs before serialization, upload, or invoke", async () => {
    setToolIds();
    const runtime = createRuntimeWithInvoke(async () => { throw new Error("must not invoke"); });
    runtime.upload = {
      negotiate: async () => { throw new Error("must not upload"); },
      confirm: async () => { throw new Error("must not confirm"); },
    };
    const backend = createAnnaPptBackend(runtime, { diagnosticLoggingEnabled: false });
    const entry: Record<string, unknown> = { output: "x".repeat(100_000) };
    entry.circular = entry;
    assert.deepEqual(await backend.appendWorkspaceLog({
      workspace_dir: "/tmp/disabled", channel: "ai-page-agent-interactions", entry,
    }), { workspace_dir: "/tmp/disabled", log_file: "", appended: false });
  });

  it("resends both switch values on every ordinary and async job call", async () => {
    setToolIds();
    for (const enabled of [false, true]) {
      const calls: Array<{ args: unknown }> = [];
      const runtime = createRuntimeWithInvoke(async (input) => {
        calls.push(input);
        return { success: true, data: {} };
      });
      runtime.tools.invokeAsyncAwait = async (input) => {
        calls.push(input);
        return { success: true, data: {} } as never;
      };
      const backend = createAnnaPptBackend(runtime, { diagnosticLoggingEnabled: enabled });
      await backend.getRuntimeInfo();
      await backend.getRuntimeInfo();
      await backend.runPdfExport({ workspace_dir: "/tmp/demo" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls.length, 4);
      assert.ok(calls.every((call) => (call.args as Record<string, unknown>).diagnostic_logging_enabled === enabled));
    }
  });

  it("reads bounded WebP thumbnails through the backend and forwards version/refresh constraints", async () => {
    setToolIds();
    const calls: AnnaToolInvokeInput[] = [];
    const runtime = createRuntimeWithInvoke(async (input) => {
      calls.push(input);
      return { success: true, data: { version: 1, page_id: "page-a", preview_source_fingerprint: "version-a",
        width: 640, height: 360, size_bytes: 4, generated_at: "2026-09-20T00:00:00Z",
        image_data_url: "data:image/webp;base64,YWJjZA==" } };
    });
    const backend = createAnnaPptBackend(runtime);
    const result = await backend.getWorkspacePageThumbnail({ workspace_dir: "/tmp/workspace", page_id: "page-a",
      expected_preview_fingerprint: "version-a" });
    assert.equal(calls[0].method, "app_get_workspace_page_thumbnail");
    assert.equal((calls[0].args as Record<string, unknown>).force_upload_refresh, undefined);
    assert.equal(result.image_url, "data:image/webp;base64,YWJjZA==");
    await assert.rejects(backend.getWorkspacePageThumbnail({ workspace_dir: "/tmp/workspace", expected_preview_fingerprint: "old" }), /version changed/);
  });

  it("reads first-page HTML and validates explicit page identities", async () => {
    setToolIds();
    const html = "<html>中文封面</html>";
    const calls: AnnaToolInvokeInput[] = [];
    const backend = createAnnaPptBackend(createRuntimeWithInvoke(async (input) => {
      calls.push(input);
      return { success: true, data: { version: 1, page_id: "first", html_fingerprint: "html", preview_source_fingerprint: "version",
        resources_expires_at: null, html } };
    }));
    assert.equal((await backend.getWorkspacePageHtml({ workspace_dir: "/tmp/demo" })).html, html);
    assert.equal(calls[0].method, "app_get_workspace_page_html");
    await assert.rejects(backend.getWorkspacePageHtml({ workspace_dir: "/tmp/demo", page_id: "wrong" }), /identity mismatch/);
    await assert.rejects(backend.getWorkspacePageHtml({ workspace_dir: "/tmp/demo", expected_preview_fingerprint: "old" }), /version changed/);
  });

  it("keeps small workspace log entries inline", async () => {
    setToolIds();
    const calls: AnnaToolInvokeInput[] = [];
    const backend = createAnnaPptBackend(createRuntimeWithInvoke(async (input) => {
      calls.push(input);
      return {
        success: true,
        data: { workspace_dir: "/tmp/workspaces/demo", log_file: "demo.jsonl", appended: true },
      };
    }), { diagnosticLoggingEnabled: true });
    const input = {
      workspace_dir: "/tmp/workspaces/demo",
      channel: "ai-research-interactions" as const,
      entry: { event: "ai.research.interaction.started", request: { text: "small" } },
      payload_keys: ["request"],
    };

    await backend.appendWorkspaceLog(input);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "app_append_workspace_log");
    assert.deepEqual(calls[0]?.args, { ...input, diagnostic_logging_enabled: true });
  });



  it("reads runtime information from the running ppt-engine tool", async () => {
    setToolIds();
    const runtime = createRuntimeWithInvoke(async (input) => {
      assert.deepEqual(input, {
        tool_id: "tool-ppt-engine",
        method: "app_get_runtime_info",
        args: { diagnostic_logging_enabled: false },
      });
      return { success: true, data: { ppt_engine_version: "4.2.4" } };
    });

    const backend = createAnnaPptBackend(runtime);
    assert.deepEqual(await backend.getRuntimeInfo(), { ppt_engine_version: "4.2.4" });
  });


  it("returns bounded create workspace results inline", async () => {
    setToolIds();
    const created: CreateWorkspaceResult = {
      version: 1,
      workspace_root: "/tmp/workspaces",
      workspace_id: "demo",
      workspace_dir: "/tmp/workspaces/demo",
      title: "Demo",
      setting: {
        output_language: "auto",
        text_density: "balanced",
        page_generation_concurrency: 5,
        content_review_enabled: false,
        content_review_failure_limit: 5,
        visual_review_enabled: false,
        visual_review_failure_limit: 2,
        disable_web_research: false,
        disable_image_research: false,
      },
    };
    const originalFetch = globalThis.fetch;
    const fetchMock = mock.fn(async () => new Response(null, { status: 500 }));
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const backend = createAnnaPptBackend(createRuntime({ success: true, data: created }));
      assert.deepEqual(await backend.createWorkspace({ title: "Demo" }), created);
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });



  it("returns inline workspace setting patches without fetching Host Upload JSON", async () => {
    setToolIds();
    const originalFetch = globalThis.fetch;
    const fetchMock = mock.fn(async () => new Response(null, { status: 500 }));
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const backend = createAnnaPptBackend(createRuntime({
        success: true,
        data: {
          workspace_dir: "/tmp/workspaces/demo",
          setting: { visual_review_enabled: true },
          persisted_as_default: true,
        },
      }));

      const result = await backend.updateWorkspaceSettings({
        workspace_dir: "/tmp/workspaces/demo",
        setting: { visual_review_enabled: true },
        persist_as_default: true,
      });

      assert.equal(result.setting.visual_review_enabled, true);
      assert.equal(result.persisted_as_default, true);
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("routes Style Profile preview and detail tools through ppt-engine", async () => {
    setToolIds();
    const calls: Array<{ method?: unknown; args?: unknown; tool_id?: unknown }> = [];
    const backend = createAnnaPptBackend(createRuntimeWithInvoke(async (input) => {
      calls.push(input as { method?: unknown; args?: unknown; tool_id?: unknown });
      return {
        success: true,
        data: {
          style_profile: { style_profile_id: "style-profile-1" },
          cover_image: null,
          reference_images: [],
          content: "",
          size_bytes: 0,
          sha256: "",
        },
      };
    }));

    await backend.getStyleProfilePreview({ style_profile_id: "style-profile-1" });
    await backend.getStyleProfile({ style_profile_id: "style-profile-1" });

    assert.equal(calls[0]?.tool_id, "tool-ppt-engine");
    assert.equal(calls[0]?.method, "app_get_style_profile_preview");
    assert.deepEqual(calls[0]?.args, { diagnostic_logging_enabled: false, style_profile_id: "style-profile-1" });
    assert.equal(calls[1]?.method, "app_get_style_profile");
  });

  it("routes Presentation Requirements reads and writes through ppt-engine", async () => {
    setToolIds();
    const calls: Array<{ method?: unknown; args?: unknown }> = [];
    const requirements = createWorkspace().requirements;
    const backend = createAnnaPptBackend(createRuntimeWithInvoke(async (input) => {
      calls.push(input as { method?: unknown; args?: unknown });
      return {
        success: true,
        data: input.method === "app_get_workspace_requirements"
          ? requirements
          : createWorkspace(),
      };
    }));

    assert.deepEqual(
      await backend.getWorkspaceRequirements({ workspace_dir: "/tmp/workspaces/demo" }),
      requirements,
    );
    await backend.updateWorkspaceRequirements({
      workspace_dir: "/tmp/workspaces/demo",
      requirements,
    });

    assert.equal(calls[0]?.method, "app_get_workspace_requirements");
    assert.equal(calls[1]?.method, "app_update_workspace_requirements");
  });

  it("routes the Outline lifecycle through the dedicated ppt-engine tools", async () => {
    setToolIds();
    const calls: Array<{ method?: unknown; args?: unknown }> = [];
    const backend = createAnnaPptBackend(createRuntimeWithInvoke(async (input) => {
      calls.push(input as { method?: unknown; args?: unknown });
      return { success: true, data: createWorkspace() };
    }));
    const outline = {
      title: "Demo Outline",
      items: [{
        page_type: "cover" as const,
        title: "Opening",
        content: "Establish the context.",
      }],
    };

    await backend.resetWorkspaceOutline({ workspace_dir: "/tmp/workspaces/demo" });
    await backend.saveWorkspaceOutlineDraft({ workspace_dir: "/tmp/workspaces/demo", outline });
    await backend.confirmWorkspaceOutline({ workspace_dir: "/tmp/workspaces/demo", outline });

    assert.deepEqual(calls.map((call) => call.method), [
      "app_reset_workspace_outline",
      "app_save_workspace_outline_draft",
      "app_confirm_workspace_outline",
    ]);
    // 大纲直接按散文透传，不再在 adapter 层翻译成 segment 结构。
    assert.equal((calls[1]?.args as any).outline.items[0].content, "Establish the context.");
  });


  it("routes manual editing through the bounded context and save protocols", async () => {
    setToolIds();
    const calls: AnnaToolInvokeInput[] = [];
    const context = { workspace_dir: "/tmp/workspaces/demo", page_id: "page-01", html: "<html>中文</html>", resources: [] };
    const content = JSON.stringify(context);
    const backend = createAnnaPptBackend(createRuntimeWithInvoke(async (input) => {
      calls.push(input);
      return { success: true, data: input.method === "app_get_page_edit_context"
        ? context : input.method === "app_restore_page_source_version"
          ? { workspace_dir: context.workspace_dir, page_id: context.page_id, restored: true } : {} };
    }));
    assert.deepEqual(await backend.getPageEditContext({ workspace_dir: context.workspace_dir, page_id: context.page_id }), context);
    await backend.saveManualPageRevision({ workspace_dir: context.workspace_dir, page_id: context.page_id, base_revision: 2, html: context.html });
    await backend.restorePageSourceVersion({ workspace_dir: context.workspace_dir, page_id: context.page_id });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.map((call) => call.method), ["app_get_page_edit_context", "app_save_manual_page_revision", "app_run_workspace_snapshot_publish_dedicated_invoke", "app_restore_page_source_version", "app_run_workspace_snapshot_publish_dedicated_invoke"]);
    assert.deepEqual(calls[1]?.args, { diagnostic_logging_enabled: false,
      workspace_dir: context.workspace_dir, page_id: context.page_id, base_revision: 2,
      html: context.html });
    assert.deepEqual(calls[2]?.args, {
      workspace_dir: context.workspace_dir, trigger: "manual-page-save", diagnostic_logging_enabled: false,
    });
  });


  it("refreshes resources through the common transport and rejects duplicate mappings", async () => {
    setToolIds();
    const calls: AnnaToolInvokeInput[] = [];
    let duplicate = false;
    const backend = createAnnaPptBackend(createRuntimeWithInvoke(async (input) => {
      calls.push(input);
      const localUrls = (input.args as { local_urls: string[] }).local_urls;
      const resources = localUrls.map((url) => ({ local_url: url, url: "https://example.test/resource", expires_at: "2099-01-01T00:00:00Z" }));
      if (duplicate) resources[1] = resources[0];
      const content = JSON.stringify(resources);
      return { success: true, data: resources };
    }));
    const localUrls = Array.from({ length: 300 }, (_, i) => `file:///workspace/page-assets/${"x".repeat(180)}-${i}.png`);
    const result = await backend.refreshManualPageResources({ workspace_dir: "/tmp/demo", page_id: "page", local_urls: localUrls });
    assert.equal(calls.length, 1);
    assert.deepEqual(result.map((resource) => resource.local_url), localUrls);
    duplicate = true;
    await assert.rejects(backend.refreshManualPageResources({ workspace_dir: "/tmp/demo", page_id: "page", local_urls: localUrls.slice(0, 2) }), /Invalid editor resource/);
  });

  it("separates asynchronous Export Artifact Mirror publication from download URL minting", async () => {
    setToolIds();
    const calls: Array<{ method?: unknown; args?: unknown }> = [];
    const mirror = {
      provider: "aps.files" as const,
      scope: "user" as const,
      path: "workspaces/demo/exports/current.pptx",
      etag: "etag-1",
      size_bytes: 12,
      content_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      source_updated_at: "2026-07-18T10:00:00Z",
      source_sha256: "a".repeat(64),
      published_at: "2026-07-18T10:00:01Z",
    };
    const artifact = {
      workspace_dir: "/tmp/workspaces/demo",
      workspace_id: "demo",
      title: "Demo",
      artifact_type: "pptx" as const,
      path: "/tmp/workspaces/demo/output/deck.pptx",
      filename: "Demo.pptx",
      updated_at: mirror.source_updated_at,
      mirror,
    };
    const queuedJob = {
      version: 1 as const,
      job_id: "demo-pptx-1",
      status: "queued" as const,
      message: "Waiting to publish the export artifact.",
      percent: 5,
      workspace_dir: artifact.workspace_dir,
      artifact_type: "pptx" as const,
      status_path: "/tmp/workspaces/demo/output/export-artifact-publish-pptx.json",
      source_updated_at: mirror.source_updated_at,
      source_sha256: mirror.source_sha256,
      size_bytes: mirror.size_bytes,
      started_at: mirror.source_updated_at,
      updated_at: mirror.source_updated_at,
      completed_at: null,
      artifact: null,
      mirror: null,
      error: null,
    };
    const backend = createAnnaPptBackend(createRuntimeWithInvoke(async (input) => {
      calls.push(input as { method?: unknown; args?: unknown });
      return {
        success: true,
        data: input.method === "app_start_export_artifact_publish"
          ? queuedJob
          : input.method === "app_get_export_artifact_publish_status"
            ? { ...queuedJob, status: "completed", percent: 100, artifact, mirror }
          : {
              status: "ready",
              reason: null,
              artifact,
              mirror,
              download_url: "https://storage.example/current.pptx",
              expires_at: "soon",
            },
      };
    }));

    await backend.startExportArtifactPublish({
      workspace_dir: artifact.workspace_dir,
      artifact_type: "pptx",
    });
    await backend.getExportArtifactPublishStatus({
      workspace_dir: artifact.workspace_dir,
      artifact_type: "pptx",
    });
    await backend.getExportArtifactDownloadUrl({
      workspace_dir: artifact.workspace_dir,
      artifact_type: "pptx",
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "app_start_export_artifact_publish",
      "app_run_workspace_snapshot_publish_dedicated_invoke",
      "app_get_export_artifact_publish_status",
      "app_get_export_artifact_download_url",
    ]);
    assert.deepEqual(calls[0]?.args, { diagnostic_logging_enabled: false,
      workspace_dir: artifact.workspace_dir,
      artifact_type: "pptx",
    });
  });

  it("prepares a Workspace Diagnostic Bundle through one long-running ppt-engine tool call", async () => {
    setToolIds();
    const calls: Array<{ method?: unknown; args?: unknown; timeoutMs?: unknown }> = [];
    const result = {
      status: "ready" as const,
      workspace_id: "demo",
      filename: "demo-workspace-diagnostics.zip",
      size_bytes: 1024,
      download_url: "https://storage.example/diagnostic.zip",
      expires_at: "2026-07-19T12:00:00Z",
    };
    const backend = createAnnaPptBackend(createRuntimeWithInvoke(async (input) => {
      calls.push(input as { method?: unknown; args?: unknown; timeoutMs?: unknown });
      return { success: true, data: result };
    }));

    assert.deepEqual(await backend.prepareWorkspaceDiagnosticBundle({
      workspace_dir: "/tmp/workspaces/demo",
    }), result);
    assert.equal(calls[0]?.method, "app_prepare_workspace_diagnostic_bundle");
    assert.deepEqual(calls[0]?.args, { diagnostic_logging_enabled: false, workspace_dir: "/tmp/workspaces/demo" });
    assert.equal(calls[0]?.timeoutMs, 600_000);
  });

  it("routes template diagnostics by ID and short-circuits disabled logs", async () => {
    setToolIds();
    const calls: Array<{ method?: unknown; args?: any }> = [];
    const runtime = createRuntimeWithInvoke(async (input) => { calls.push(input); return { success: true, data: { appended: true } }; });
    const disabled = createAnnaPptBackend(runtime, { diagnosticLoggingEnabled: false });
    assert.deepEqual(await disabled.appendUserTemplateLog({ id: "user-test", channel: "user-template", entry: {} }), { appended: false });
    assert.equal(calls.length, 0);
    await disabled.prepareUserTemplateDiagnosticBundle({ id: "user-test" });
    assert.equal(calls[0].method, "app_prepare_user_template_diagnostic_bundle");
    assert.deepEqual(calls[0].args, { id: "user-test", diagnostic_logging_enabled: false });
    const enabled = createAnnaPptBackend(runtime, { diagnosticLoggingEnabled: true });
    await enabled.appendUserTemplateLog({ id: "user-test", channel: "ai-user-template-stream", entry: { frames: [] } });
    assert.equal(calls[1].method, "app_append_user_template_log");
    assert.equal(calls[1].args.diagnostic_logging_enabled, true);
    assert.equal(calls[1].args.workspace_dir, undefined);
  });

  it("uses long-running timeouts for page preview and deck rendering", async () => {
    setToolIds();
    const calls: Array<{ method?: unknown; timeoutMs?: unknown }> = [];
    const backend = createAnnaPptBackend(createRuntimeWithInvoke(async (input) => {
      calls.push(input as { method?: unknown; timeoutMs?: unknown });
      return { success: true, data: {} };
    }));

    await backend.renderWorkspacePagePreview({ workspace_dir: "/tmp/workspaces/demo", page_id: "page-1" });
    await backend.renderDeckHtml({ workspace_dir: "/tmp/workspaces/demo" });

    assert.deepEqual(calls.map((call) => [call.method, call.timeoutMs]), [
      ["app_render_workspace_page_preview", 600_000],
      ["app_render_deck_html", 600_000],
    ]);
  });

  it("routes cloud snapshot sync state reads and My Work listing through ppt-engine", async () => {
    setToolIds();
    const calls: Array<{ method?: unknown; args?: unknown }> = [];
    const syncState = {
      schema_version: 1,
      workspace_id: "demo",
      status: "completed",
      revision: "rev-1",
      source_updated_at: "2026-07-18T10:00:00Z",
      source_sha256: "a".repeat(64),
      snapshot_sha256: "b".repeat(64),
      snapshot_path: "/tmp/workspaces/demo/.snapshot-sync/snapshot.zip",
      snapshot_size_bytes: 1024,
      file_count: 3,
      attachments: [],
      generated_at: "2026-07-18T10:00:00Z",
      created_at: "2026-07-18T10:00:00Z",
      updated_at: "2026-07-18T10:00:00Z",
      error: null,
      publish: null,
      restore: null,
    };
    const backend = createAnnaPptBackend(createRuntimeWithInvoke(async (input) => {
      calls.push(input as { method?: unknown; args?: unknown });
      return {
        success: true,
        data: input.method === "app_list_my_work" ? { workspaces: [] } : syncState,
      };
    }));

    assert.deepEqual(
      await backend.getWorkspaceSnapshotSyncState({ workspace_dir: "/tmp/workspaces/demo" }),
      syncState,
    );
    assert.deepEqual(await backend.listMyWork(), { workspaces: [] });

    assert.deepEqual(calls.map((call) => call.method), [
      "app_get_workspace_snapshot_sync_state",
      "app_list_my_work",
    ]);
    assert.deepEqual(calls[0]?.args, { diagnostic_logging_enabled: false, workspace_dir: "/tmp/workspaces/demo" });
    assert.deepEqual(calls[1]?.args, { diagnostic_logging_enabled: false,});
  });

  it("polls PPTX rendering and merging progress while retaining async PDF and mirror exports", async () => {
    setToolIds();
    const calls: Array<Record<string, unknown>> = [];
    const statuses = [
      { status: "queued", percent: 5, message: "Queued" },
      { status: "converting", percent: 30, message: "Rendering", export_phase: "rendering", current_page: 1, total_pages: 3 },
      { status: "converting", percent: 92, message: "Merging", export_phase: "merging", current_page: 3, total_pages: 3 },
      { status: "completed", percent: 100, message: "Completed" },
    ];
    const reportedProgress: unknown[] = [];
    const runtime = createRuntime({});
    runtime.tools.invoke = withOrdinaryInvokeTransport(async (input) => {
      calls.push(input as unknown as Record<string, unknown>);
      return {
        success: true,
        data: statuses.shift() ?? {},
      };
    });
    runtime.tools.invokeAsyncAwait = async (input) => {
      calls.push(input as unknown as Record<string, unknown>);
      return {
        success: true,
        data: {
          status: "completed",
          artifact_type: "pptx",
          mirror: null,
        },
      };
    };
    const backend = createAnnaPptBackend(runtime);

    await backend.runPptxExport({
      workspace_dir: "/tmp/workspaces/demo",
      pageNumbers: [2, 3, 4],
      onProgress: (progress) => reportedProgress.push(progress),
    });
    await backend.runPdfExport({ workspace_dir: "/tmp/workspaces/demo", pageNumbers: [2, 3] });
    await backend.runExportArtifactPublish({
      workspace_dir: "/tmp/workspaces/demo",
      artifact_type: "pptx",
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    const snapshots = calls.filter((call) => call.method === "app_run_workspace_snapshot_publish_dedicated_invoke");
    const exports = calls.filter((call) => call.method !== "app_run_workspace_snapshot_publish_dedicated_invoke");
    assert.deepEqual(exports.map((call) => [call.method, call.timeoutMs, call.clientTag]), [
      ["app_start_pptx_export", undefined, undefined],
      ["app_get_pptx_export_status", undefined, undefined],
      ["app_get_pptx_export_status", undefined, undefined],
      ["app_get_pptx_export_status", undefined, undefined],
      ["app_run_pdf_export", 600_000, "ppt-export:pdf:demo"],
      ["app_run_export_artifact_publish", 600_000, "ppt-export:mirror:demo:pptx"],
    ]);
    assert.deepEqual(exports[0]?.args, { diagnostic_logging_enabled: false,
      workspace_dir: "/tmp/workspaces/demo", page_numbers: [2, 3, 4],
    });
    assert.ok(calls.every((call) => call.tool_id === "tool-ppt-engine"));
    assert.deepEqual(exports[4]?.args, { diagnostic_logging_enabled: false, workspace_dir: "/tmp/workspaces/demo", page_numbers: [2, 3] });
    assert.ok(snapshots.every((call) => call.timeoutMs === 600_000 && call.clientTag === undefined));
    assert.deepEqual(snapshots.map((call) => call.args), [
      { diagnostic_logging_enabled: false, workspace_dir: "/tmp/workspaces/demo", trigger: "pptx-export" },
      { diagnostic_logging_enabled: false, workspace_dir: "/tmp/workspaces/demo", trigger: "pdf-export" },
      { diagnostic_logging_enabled: false, workspace_dir: "/tmp/workspaces/demo", trigger: "export-artifact:pptx" },
    ]);
    assert.deepEqual(reportedProgress, [
      { percent: 5, message: "Queued" },
      { percent: 30, message: "Rendering", phase: "rendering", currentPage: 1, totalPages: 3 },
      { percent: 92, message: "Merging", phase: "merging", currentPage: 3, totalPages: 3 },
      { percent: 100, message: "Completed" },
    ]);
  });
});

it("routes page layout audits through the bundled engine with a render fingerprint", async () => {
  setToolIds();
  const calls: AnnaToolInvokeInput[] = [];
  const expected = { page_id: "page-1", source_sha256: "source", error_count: 0, warning_count: 3, report_path: "/workspace/output/audit.json" };
  const backend = createAnnaPptBackend(createRuntimeWithInvoke(async (input) => {
    calls.push(input);
    return { success: true, data: expected };
  }));
  const input = { workspace_dir: "/workspace", page_id: "page-1", expected_source_sha256: "source" };
  assert.deepEqual(await backend.auditWorkspacePageLayout(input), expected);
  assert.equal(calls[0].method, "app_audit_workspace_page_layout");
  assert.deepEqual(calls[0].args, { ...input, diagnostic_logging_enabled: false });
});
