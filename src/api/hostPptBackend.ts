import { createInvokeTransport } from "../runtime/invokeTransport";
import { decodePageThumbnail, type PageThumbnailTransport } from "./pageThumbnail";

import type { ManualPageImage, ManualPageResource } from "./types";
import { isDiagnosticLoggingEnabled } from "../runtime/diagnosticLogging";
import type { PageLayoutAuditResult } from "./types";
import type { PageRegenerationBatch } from "./pageRegenerationTypes";
import type { WorkspacePageHtml } from "./pageHtmlPreview";
import type {
  HostRuntime,
  ToolJobProgress,
  ToolJobSnapshot,
} from "../runtime/hostRuntime";

import type { CreateBatchTestRunInput, PptBackend } from "./pptBackend";
import type { ProfileAssetMeta } from "../features/user-templates/types";
import type {
  AppendWorkspaceLogResult,
  WriteResearchTestFileResult,
  ExportPdfInput,
  ExportArtifactDownloadUrlResult,
  ExportArtifactPublishJob,
  ExportPdfResult,
  GetWorkspacePageFileFingerprintsResult,
  GetPageEditContextResult,
  SaveManualPageRevisionResult,
  CommitManagedFontUploadResult,
  ManagedFontRuntimeFamily,
  RestorePageSourceVersionResult,
  PageRecoveryOption,
  PageProgress,
  TemplateSummary,
  WorkspaceOutline,
  ListWorkspacesResult,
  AutoRestoreMissingWorkspacesResult,
  ProjectResult,
  PptxExportJob,
  PptEngineRuntimeInfo,
  PptAgentResourceInfo,
  RenderDeckHtmlResult,
  RenderDeckHtmlSubmissionResult,
  RenderWorkspacePagePreviewSubmissionResult,
  RecordPdfExportInput,
  SelectTemplateResult,
  TemplatePlanningContext,
  WorkspaceThemeContext,
  WorkspaceThemeValidationResult,
  RecordWorkspaceThemeTokenResult,
  WorkspaceDefaultsResult,
  PatchWorkspaceDefaultsInput,
  DeleteWorkspaceResult,
  DuplicateWorkspaceResult,
  WorkspaceResult,
  ClearWorkspaceStyleProfileResult,
  CommitUploadedSourceHostUploadResult,
  RunUploadedSourcePreflightResult,
  ContinueUploadedSourcePdfOcrResult,
  GetUploadedSourcePreflightStatusResult,
  GetUploadedSourcePreflightTextResult,
  GetUploadedSourcePreflightChunksResult,
  AttachmentBrief,
  AttachmentBriefPaths,
  AttachmentContext,
  ListAttachmentBriefsResult,
  CreateWorkspaceResult,
  CommitStyleProfileReferenceHostUploadResult,
  GetStyleProfileCreationContextResult,
  GetStyleProfileDraftResult,
  GetStyleProfilePreviewResult,
  GetStyleProfileResult,
  GetWorkspaceStyleProfileResult,
  ListStyleProfilesResult,
  PrepareStyleProfileCreationResult,
  HostUploadRef,
  CleanupSharedResearchImageStagingResult,
  ListUploadedSourcesResult,
  PublishStyleProfileResult,
  SelectWorkspaceStyleProfileResult,
  StyleProfileDraftFingerprint,
  RemoveUploadedSourceResult,
  PrepareUploadedSourceAnalysisWorkspaceResult,
  PresentationRequirements,
  UploadedSourceAnalysisDraftFingerprint,
  UpdateWorkspaceSettingsResult,
  WorkspaceAuthoringKitResult,
  PrepareWorkspacePageSourcesResult,
  PrepareWorkspaceDiagnosticBundleResult,
  WorkspacePageSourceFingerprint,
  CommitWorkspaceStyleGuideResult,
  ConfirmWorkspaceRequirementsResult,
  WorkspaceStyleGuideStatus,
  WorkspaceStyleGuide,
  WorkspaceHtmlArtifact,
  TemplateReferenceCatalog,
  TemplateReferenceHtmlPage,
  AestheticReferenceSelections,
  CommitVisualRhythmInput,
  VisualRhythmStatus,
  VisualRhythm,
  CommitPageVisualPlanInput,
  PageVisualPlanStatus,
  PageVisualPlan,
  PreparePageRefinementResult,
  CommitDeckRefinementResult,
  GenerationRunTransaction,
  PrepareGenerationRunResult,
  CommitGenerationRunResult,
  PublishWorkspaceSnapshotResult,
  GetWorkspaceSnapshotInfoResult,
  WorkspaceSnapshotPublishState,
  RestoreWorkspaceSnapshotInput,
  WorkspaceSnapshotRestoreState,
  ReconcileWorkspaceWithCloudInput,
  ReconcileWorkspaceWithCloudResult,
  GetWorkspaceSnapshotSyncStateResult,
  ListMyWorkResult,
  SharedResearchContextResult,
  PrepareSharedResearchImageCandidateResult,
  UploadSharedResearchImageCandidateResult,
  PatchSharedResearchProgressResult,
  PublishSharedResearchBatchResult,
  ImportSharedResearchImageResult,
  FinalizePerformanceRunResult,
  ListPerformanceRunsResult,
  PerformanceRunSummary,
  PreparePerformanceReportResult,
  BatchTestCaseRecord,
  BatchTestRunRecord,
  DeleteBatchTestRunResult,
  ListBatchTestRunsResult,
  PrepareBatchTestBundleResult,
} from "./types";

import { resolvePptBundledToolIds } from "./bundledToolIds";

import {
  beginPerformanceSpan,
  configurePerformanceEventSink,
  flushPerformanceEvents,
  getActivePerformanceRunId,
  setActivePerformanceRun,
} from "../performance/performanceRecorder";

export const EXPORT_ASYNC_TIMEOUT_MS = 600_000;
const LONG_RUNNING_TOOL_TIMEOUT_MS = EXPORT_ASYNC_TIMEOUT_MS;
function unwrapToolResult<T>(result: unknown): T {
  if (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    (result as { success?: unknown }).success === true &&
    "data" in result
  ) {
    return (result as { data: T }).data;
  }

  return result as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return "";
}

function normalizeExportPdfResult(value: unknown): ExportPdfResult {
  const record = isRecord(value) ? value : {};

  return {
    pdfPath: readString(record, "pdfPath", "pdf_path"),
    htmlPath: readString(record, "htmlPath", "html_path"),
    outputDir: readString(record, "outputDir", "output_dir"),
  };
}

export function createAnnaPptBackend(
  runtime: HostRuntime,
  options: { diagnosticLoggingEnabled?: boolean } = {},
): PptBackend {
  const diagnosticLoggingEnabled = options.diagnosticLoggingEnabled ?? isDiagnosticLoggingEnabled();
  const toolIds = resolvePptBundledToolIds();
  const transportInvoke = createInvokeTransport(runtime);
  const performanceControlMethods = new Set([
    "app_get_agent_resource_info",
    "app_list_performance_runs",
    "app_start_performance_run",
    "app_append_performance_events",
    "app_finalize_performance_run",
    "app_regenerate_performance_report",
    "app_abandon_performance_run",
    "app_delete_performance_run",
    "app_prepare_performance_report",
  ]);
  const performanceOperationNames: Record<string, string> = {
    app_get_runtime_info: "app.initialize",
    app_list_workspaces: "workspace.list",
    app_create_workspace: "workspace.create",
    app_open_workspace: "workspace.open",
    app_duplicate_workspace: "workspace.duplicate",
    app_delete_workspace: "workspace.delete",
    app_patch_workspace_settings: "workspace.settings.save",
    app_commit_uploaded_source_host_upload: "uploaded_source.upload",
    app_prepare_uploaded_source_analysis_workspace: "uploaded_source.analysis",
    app_update_workspace_requirements: "requirements.save",
    app_confirm_workspace_requirements: "requirements.confirm",
    app_save_workspace_outline_draft: "outline.save",
    app_confirm_workspace_outline: "outline.confirm",
    app_install_workspace_authoring_kit: "authoring_kit.install",
    app_prepare_workspace_page_sources: "page_sources.prepare",
    app_render_workspace_page_preview: "page.render",
    app_render_deck_html: "final_deck_render",
    app_prepare_page_refinement: "page_refinement.run",
    app_commit_deck_refinement: "deck_refinement.commit",
    app_get_page_edit_context: "manual_page.load",
    app_pin_managed_font: "manual_page.font.pin",
    app_commit_managed_font_host_upload: "manual_page.font.upload",
    app_save_manual_page_revision: "manual_page.save",
    app_restore_page_source_version: "manual_page.restore",
    app_start_pptx_export: "pptx_export.run",
    app_get_pptx_export_status: "pptx_export.status",
    app_run_pptx_export: "pptx_export.async",
    app_export_pdf: "pdf_export.run",
    app_run_pdf_export: "pdf_export.async",
    app_start_export_artifact_publish: "export_download.prepare",
    app_get_export_artifact_publish_status: "export_download.status",
    app_run_export_artifact_publish: "export_download.async",
    app_get_export_artifact_download_url: "export_download.prepare",
  };
  async function invokeRaw<T>(toolId: string, method: string, args: object, options?: { timeoutMs?: number }) {
    args = { ...args, diagnostic_logging_enabled: diagnosticLoggingEnabled };
    return transportInvoke<T>(toolId, method, args, options);
  }
  async function invokeAsyncAwaitRaw<T>(
    toolId: string,
    method: string,
    args: object,
    clientTag: string,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      onProgress?: (progress: ToolJobProgress) => void;
    } = {},
  ): Promise<T> {
    if (!runtime.tools.invokeAsyncAwait) {
      throw new Error(
        "SlideForge Host Async Job API is unavailable. Upgrade the SlideForge runtime before exporting.",
      );
    }
    const result = await runtime.tools.invokeAsyncAwait<T>(
      {
        tool_id: toolId,
        method,
        args: { ...args, diagnostic_logging_enabled: diagnosticLoggingEnabled },
        timeoutMs: options.timeoutMs ?? EXPORT_ASYNC_TIMEOUT_MS,
        clientTag,
      },
      {
        ...options,
        timeoutMs: options.timeoutMs ?? EXPORT_ASYNC_TIMEOUT_MS,
      },
    );
    return unwrapToolResult<T>(result);
  }
  function exportClientTag(
    workspaceDir: string,
    kind: "pptx" | "pdf" | "mirror",
    artifactType?: "pptx" | "pdf",
  ): string {
    const workspaceId = workspaceDir.split(/[\\/]/).filter(Boolean).at(-1) ?? workspaceDir;
    return artifactType
      ? `ppt-export:${kind}:${workspaceId}:${artifactType}`
      : `ppt-export:${kind}:${workspaceId}`;
  }
  function normalizeAsyncJobSnapshot(value: unknown): ToolJobSnapshot {
    const record = isRecord(value) ? value : {};
    const jobId = readString(record, "jobId", "job_id");
    const state = readString(record, "state", "status") as ToolJobSnapshot["state"];
    return {
      ...(record as Partial<ToolJobSnapshot>),
      jobId,
      clientTag: readString(record, "clientTag", "client_tag") || undefined,
      state,
    };
  }
  configurePerformanceEventSink((runId, events) => invokeRaw(
    toolIds.pptEngine,
    "app_append_performance_events",
    { run_id: runId, events },
  ).then(() => undefined));
  async function invoke<T>(
    toolId: string,
    method: string,
    args: object,
    options?: { timeoutMs?: number }
  ): Promise<T> {
    if (performanceControlMethods.has(method) || !getActivePerformanceRunId()) {
      return invokeRaw<T>(toolId, method, args, options);
    }
    const operationName = performanceOperationNames[method] ?? `tool.${method.replace(/^app_/, "")}`;
    const workspaceId = isRecord(args) && typeof args.workspace_dir === "string"
      ? args.workspace_dir.split(/[\\/]/).filter(Boolean).at(-1)
      : undefined;
    const span = beginPerformanceSpan({
      operationName: `${operationName}.roundtrip`,
      workspaceId,
      attributes: { layer: "ppt-backend", tool: method },
    });
    const performanceContext = span?.childContext(`${operationName}.backend`);
    try {
      const result = await invokeRaw<T>(toolId, method, performanceContext ? { ...args, performance_context: performanceContext } : args, options);
      span?.finish("ok");
      return result;
    } catch (error) {
      span?.finish("error");
      throw error;
    }
  }
  const invokeWorkspaceResult = (
    method: string,
    args: object,
    options?: { timeoutMs?: number }
  ) => invoke<WorkspaceResult>(toolIds.pptEngine, method, args, options);

  async function invokeOutlineWorkspaceResult(
    method: "app_save_workspace_outline_draft" | "app_confirm_workspace_outline",
    input: { workspace_dir: string; outline: object },
    options?: { timeoutMs?: number },
  ): Promise<WorkspaceResult> {
    return invokeWorkspaceResult(method, input, options);
  }

  async function listAllWorkspaces(): Promise<ListWorkspacesResult> {
    const pageSize = 40;
    const first = await invoke<ListWorkspacesResult>(
      toolIds.pptEngine,
      "app_list_workspaces",
      { limit: pageSize },
    );
    const workspaces = [...(first.workspaces ?? first.tasks ?? [])];
    let cursor = first.next_cursor;
    let pagesRead = 1;

    // A loop guard turns a malformed plugin cursor into a clear client error
    // rather than an unbounded sequence of tool invocations.
    while (cursor) {
      if (pagesRead >= 10_000) {
        throw new Error("Workspace listing exceeded the pagination safety limit.");
      }
      const page = await invoke<ListWorkspacesResult>(
        toolIds.pptEngine,
        "app_list_workspaces",
        { limit: pageSize, cursor },
      );
      workspaces.push(...(page.workspaces ?? page.tasks ?? []));
      cursor = page.next_cursor;
      pagesRead += 1;
    }

    const { next_cursor: _nextCursor, tasks: _tasks, ...complete } = first;
    return { ...complete, workspaces };
  }

  // Fire-and-forget by design: this dedicated Host invoke owns the snapshot
  // upload's storage authorization, while a failure must not turn the already
  // completed user action into an error. This is the sole upload entry point.
  function runDedicatedSnapshotPublishInvoke(workspaceDir: string, trigger: string): void {
    void invoke<WorkspaceSnapshotPublishState>(
      toolIds.pptEngine,
      "app_run_workspace_snapshot_publish_dedicated_invoke",
      { workspace_dir: workspaceDir, trigger },
      { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS },
    ).then((result) => {
      console.info("[snapshot-publish-dedicated-invoke] completed", result);
    }).catch((error) => {
      console.warn("[snapshot-publish-dedicated-invoke] failed", error);
    });
  }

  // The Engine deliberately omits repeated prompt metadata, aggregate token
  // usage and deterministic filesystem paths from research-routing batch RPC
  // responses. Keeping those responses compact prevents the local Executa
  // bridge from restarting partway through a large experiment. The complete
  // record remains on disk for its downloadable batch bundle.
  const joinBatchPath = (rootDir: string, ...segments: string[]) => {
    const separator = rootDir.includes("\\") ? "\\" : "/";
    return [rootDir.replace(/[\\/]+$/u, ""), ...segments].join(separator);
  };
  const hydrateBatchTransportRun = (run: BatchTestRunRecord): BatchTestRunRecord => {
    const requiresPathHydration = run.cases.some((item) =>
      !item.case_dir || !item.workspace_dir || !item.performance_dir,
    );
    if (!requiresPathHydration) return run;
    return {
      ...run,
      cases: run.cases.map((item) => {
        const caseDir = item.case_dir || joinBatchPath(run.root_dir, item.case_id);
        return {
          ...item,
          case_dir: caseDir,
          workspace_dir: item.workspace_dir || joinBatchPath(caseDir, "workspace", item.workspace_id),
          performance_dir: item.performance_dir || joinBatchPath(caseDir, "performance"),
        };
      }),
    };
  };
  return {
    diagnosticLoggingEnabled,
    getRuntimeInfo: () =>
      invoke<PptEngineRuntimeInfo>(toolIds.pptEngine, "app_get_runtime_info", {}),
    getAgentResourceInfo: () =>
      invoke<PptAgentResourceInfo>(toolIds.pptEngine, "app_get_agent_resource_info", {}),
    listPerformanceRuns: async () => {
      const result = await invoke<ListPerformanceRunsResult>(toolIds.pptEngine, "app_list_performance_runs", {});
      setActivePerformanceRun(result.active_run?.run_id ?? null);
      return result;
    },
    startPerformanceRun: async (input) => {
      const result = await invoke<PerformanceRunSummary>(toolIds.pptEngine, "app_start_performance_run", input);
      setActivePerformanceRun(result.run_id);
      return result;
    },
    appendPerformanceEvents: (input) =>
      invoke(toolIds.pptEngine, "app_append_performance_events", input),
    finalizePerformanceRun: async (input) => {
      await flushPerformanceEvents({ throwOnError: true });
      const result = await invoke<FinalizePerformanceRunResult>(toolIds.pptEngine, "app_finalize_performance_run", input);
      if (result.run.status === "completed") setActivePerformanceRun(null);
      return result;
    },
    regeneratePerformanceReport: (input) =>
      invoke<PerformanceRunSummary>(toolIds.pptEngine, "app_regenerate_performance_report", input),
    abandonPerformanceRun: async (input) => {
      await flushPerformanceEvents({ throwOnError: true });
      const result = await invoke<PerformanceRunSummary>(toolIds.pptEngine, "app_abandon_performance_run", input);
      setActivePerformanceRun(null);
      return result;
    },
    deletePerformanceRun: (input) =>
      invoke(toolIds.pptEngine, "app_delete_performance_run", input),
    preparePerformanceReport: (input) =>
      invoke<PreparePerformanceReportResult>(toolIds.pptEngine, "app_prepare_performance_report", input),
    createBatchTestRun: (input: CreateBatchTestRunInput) =>
      invoke<{ run: BatchTestRunRecord }>(toolIds.pptEngine, "app_create_batch_test_run", input)
        .then((result) => ({ ...result, run: hydrateBatchTransportRun(result.run) })),
    listBatchTestRuns: () =>
      invoke<ListBatchTestRunsResult>(toolIds.pptEngine, "app_list_batch_test_runs", {})
        .then((result) => ({ ...result, runs: result.runs.map(hydrateBatchTransportRun) })),
    updateBatchTestCase: (input: { root_dir: string; case_id: string; status: BatchTestCaseRecord["status"]; error?: string | null; pptx_path?: string | null; token_usage?: BatchTestCaseRecord["token_usage"]; performance_metrics?: BatchTestCaseRecord["performance_metrics"]; research_routing_result?: BatchTestCaseRecord["research_routing_result"]; page_refinement_classification_result?: BatchTestCaseRecord["page_refinement_classification_result"]; template_recommendation_result?: BatchTestCaseRecord["template_recommendation_result"] }) =>
      invoke<BatchTestRunRecord>(toolIds.pptEngine, "app_update_batch_test_case", input).then(hydrateBatchTransportRun),
    updateBatchTestRun: (input: { root_dir: string; status: BatchTestRunRecord["status"]; performance_metrics?: BatchTestRunRecord["performance_metrics"] }) =>
      invoke<BatchTestRunRecord>(toolIds.pptEngine, "app_update_batch_test_run", input).then(hydrateBatchTransportRun),
    deleteBatchTestRun: (input: { root_dir: string }) =>
      invoke<DeleteBatchTestRunResult>(toolIds.pptEngine, "app_delete_batch_test_run", input),
    materializePerformanceRun: (input: { run_id: string; destination_dir: string }) =>
      invoke<{ run_id: string; destination_dir: string; files: string[] }>(toolIds.pptEngine, "app_materialize_performance_run", input),
    prepareBatchTestBundle: (input: { root_dir: string }) =>
      invoke<PrepareBatchTestBundleResult>(toolIds.pptEngine, "app_prepare_batch_test_bundle", input, { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS }),
    beginGenerationRun: (input) =>
      invoke<GenerationRunTransaction>(toolIds.pptEngine, "app_begin_generation_run", input),
    prepareGenerationRun: (input) =>
      invoke<PrepareGenerationRunResult>(toolIds.pptEngine, "app_prepare_generation_run", input, { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS }),
    abandonGenerationRun: (input) =>
      invoke<GenerationRunTransaction>(toolIds.pptEngine, "app_abandon_generation_run", input),
    commitGenerationRun: async (input) => {
      const result = await invoke<CommitGenerationRunResult>(toolIds.pptEngine, "app_commit_generation_run", input, { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS });
      runDedicatedSnapshotPublishInvoke(result.workspace.workspace_dir, "generation-commit");
      return result;
    },
    cleanupGenerationRun: (input) =>
      invoke<{ cleaned: boolean }>(toolIds.pptEngine, "app_cleanup_generation_run", input),
    getWorkspaceGenerationRun: (input) =>
      invoke<GenerationRunTransaction | null>(toolIds.pptEngine, "app_get_workspace_generation_run", input),
    publishWorkspaceSnapshot: async (input) => {
      const result = await invoke<PublishWorkspaceSnapshotResult>(toolIds.pptEngine, "app_publish_workspace_snapshot", input);
      runDedicatedSnapshotPublishInvoke(input.workspace_dir, "manual-snapshot-publish");
      return result;
    },
    getWorkspaceSnapshotInfo: (input) =>
      invoke<GetWorkspaceSnapshotInfoResult>(toolIds.pptEngine, "app_get_workspace_snapshot_info", input),
    runWorkspaceSnapshotPublishDedicatedInvoke: (input) =>
      invoke<WorkspaceSnapshotPublishState>(toolIds.pptEngine, "app_run_workspace_snapshot_publish_dedicated_invoke", input, { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS }),
    getWorkspaceSnapshotPublishStatus: (input) =>
      invoke<WorkspaceSnapshotPublishState>(toolIds.pptEngine, "app_get_workspace_snapshot_publish_status", input),
    restoreWorkspaceSnapshot: (input: RestoreWorkspaceSnapshotInput) =>
      invoke<WorkspaceSnapshotRestoreState>(toolIds.pptEngine, "app_restore_workspace_snapshot", input, { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS }),
    getWorkspaceSnapshotRestoreStatus: (input: { workspace_dir: string }) =>
      invoke<WorkspaceSnapshotRestoreState>(toolIds.pptEngine, "app_get_workspace_snapshot_restore_status", input),
    reconcileWorkspaceWithCloud: (input: ReconcileWorkspaceWithCloudInput) =>
      invoke<ReconcileWorkspaceWithCloudResult>(toolIds.pptEngine, "app_reconcile_workspace_with_cloud", input, { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS }),
    getWorkspaceSnapshotSyncState: (input: { workspace_dir: string }) =>
      invoke<GetWorkspaceSnapshotSyncStateResult>(toolIds.pptEngine, "app_get_workspace_snapshot_sync_state", input),
    listMyWork: () =>
      invoke<ListMyWorkResult>(toolIds.pptEngine, "app_list_my_work", {}),
    listWorkspaces: () => listAllWorkspaces(),
    autoRestoreMissingWorkspaces: () =>
      invoke<AutoRestoreMissingWorkspacesResult>(
        toolIds.pptEngine,
        "app_auto_restore_missing_workspaces",
        {},
        { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS },
      ),
    getWorkspaceDefaults: () =>
      invoke<WorkspaceDefaultsResult>(toolIds.pptEngine, "app_get_workspace_defaults", {}),
    patchWorkspaceDefaults: (input: PatchWorkspaceDefaultsInput) =>
      invoke<WorkspaceDefaultsResult>(toolIds.pptEngine, "app_patch_workspace_defaults", input),
    createWorkspace: (input) =>
      invoke<CreateWorkspaceResult>(toolIds.pptEngine, "app_create_workspace", input),
    openWorkspace: (input) =>
      invokeWorkspaceResult("app_open_workspace", input),
    installWorkspaceAuthoringKit: (input) =>
      invoke<WorkspaceAuthoringKitResult>(
        toolIds.pptEngine,
        "app_install_workspace_authoring_kit",
        input,
      ),
    prepareWorkspacePageSources: (input) =>
      invoke<PrepareWorkspacePageSourcesResult>(
        toolIds.pptEngine,
        "app_prepare_workspace_page_sources",
        input,
      ),
    reconcileWorkspacePageSources: (input) =>
      invoke(
        toolIds.pptEngine,
        "app_reconcile_workspace_page_sources",
        input,
      ),
    getWorkspacePageSourceFingerprint: (input) =>
      invoke<WorkspacePageSourceFingerprint>(
        toolIds.pptEngine,
        "app_get_workspace_page_source_fingerprint",
        input,
      ),
    commitWorkspaceStyleGuide: (input) =>
      invoke<CommitWorkspaceStyleGuideResult>(
        toolIds.pptEngine,
        "app_commit_workspace_style_guide",
        input,
      ),
    commitVisualRhythm: (input: CommitVisualRhythmInput) =>
      invoke<VisualRhythmStatus>(toolIds.pptEngine, "app_commit_visual_rhythm", input),
    getVisualRhythmStatus: (input) => invoke<VisualRhythmStatus>(toolIds.pptEngine, "app_get_visual_rhythm_status", input),
    getVisualRhythm: (input) => invoke<VisualRhythm>(toolIds.pptEngine, "app_get_visual_rhythm", input),
    commitPageVisualPlan: (input: CommitPageVisualPlanInput) =>
      invoke<PageVisualPlanStatus>(toolIds.pptEngine, "app_commit_page_visual_plan", input),
    getPageVisualPlanStatus: (input) => invoke<PageVisualPlanStatus>(toolIds.pptEngine, "app_get_page_visual_plan_status", input),
    getPageVisualPlan: (input) => invoke<PageVisualPlan>(toolIds.pptEngine, "app_get_page_visual_plan", input),
    confirmWorkspaceRequirements: (input) =>
      invoke<ConfirmWorkspaceRequirementsResult>(
        toolIds.pptEngine,
        "app_confirm_workspace_requirements",
        input,
      ),
    getWorkspaceStyleGuideStatus: (input) =>
      invoke<WorkspaceStyleGuideStatus>(
        toolIds.pptEngine,
        "app_get_workspace_style_guide_status",
        input,
      ),
    getWorkspaceStyleGuide: (input) =>
      invoke<WorkspaceStyleGuide>(toolIds.pptEngine, "app_get_workspace_style_guide", input),
    commitWorkspaceVisualMasterHtml: (input) =>
      invoke<WorkspaceHtmlArtifact>(toolIds.pptEngine, "app_commit_workspace_visual_master_html", input),
    getWorkspaceVisualMasterHtml: (input) =>
      invoke<WorkspaceHtmlArtifact & { content: string }>(toolIds.pptEngine, "app_get_workspace_visual_master_html", input),
    commitWorkspacePageHtml: (input) =>
      invoke<WorkspaceHtmlArtifact>(toolIds.pptEngine, "app_commit_workspace_page_html", input),
    outlineImageDescriptions: (input) => invoke(toolIds.pptEngine, "app_outline_image_descriptions", input),
    pageImageUpload: (input) => invoke(toolIds.pptEngine, "app_page_image_upload", input),
    pageImageSearch: async (input) => {
      const result = await invoke<import("./pageImageSearchTypes").PageImageSearchTask | null>(toolIds.pptEngine, "app_page_image_search", input);
      return isRecord(result) && Object.keys(result).length === 0 ? null : result;
    },
    pageRegeneration: (input) =>
      invoke<PageRegenerationBatch | null>(toolIds.pptEngine, "app_page_regeneration", input),
    listWorkspaceTemplateReferences: (input) =>
      invoke<TemplateReferenceCatalog>(toolIds.pptEngine, "app_list_workspace_template_references", input),
    getWorkspaceTemplateReferenceHtml: (input) =>
      invoke<TemplateReferenceHtmlPage>(toolIds.pptEngine, "app_get_workspace_template_reference_html", input),
    getWorkspaceAestheticReferenceSelections: (input) =>
      invoke<AestheticReferenceSelections>(toolIds.pptEngine, "app_get_workspace_aesthetic_reference_selections", input),
    recordWorkspaceAestheticReferenceSelection: (input) =>
      invoke<AestheticReferenceSelections>(toolIds.pptEngine, "app_record_workspace_aesthetic_reference_selection", input),
    ensureWorkspacePersistentElementsReference: (input) =>
      invoke(toolIds.pptEngine, "app_ensure_workspace_persistent_elements_reference", input),
    getWorkspacePersistentElementsReferenceStatus: (input) =>
      invoke(toolIds.pptEngine, "app_get_workspace_persistent_elements_status", input),
    typecheckWorkspacePersistentElements: (input) =>
      invoke(toolIds.pptEngine, "app_typecheck_workspace_persistent_elements", input),
    initializePageProgress: (input) =>
      invoke<PageProgress>(toolIds.pptEngine, "app_initialize_page_progress", input),
    preparePageRefinement: (input) =>
      invoke<PreparePageRefinementResult>(toolIds.pptEngine, "app_prepare_page_refinement", input),
    commitDeckRefinement: (input) =>
      invoke<CommitDeckRefinementResult>(toolIds.pptEngine, "app_commit_deck_refinement", input),
    listUserTemplates: () => invoke(toolIds.pptEngine, "app_list_user_templates", {}, { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS }),
    getUserTemplate: (input) => invoke(toolIds.pptEngine, "app_get_user_template", input),
    createUserTemplate: (input) => invoke(toolIds.pptEngine, "app_create_user_template", input),
    createImageUserTemplate: (input) => invoke(toolIds.pptEngine, "app_create_image_user_template", input, { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS }),
    saveUserTemplateSource: (input) => invoke(toolIds.pptEngine, "app_save_user_template_source", input, { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS }),
    appendUserTemplateLog: (input) => diagnosticLoggingEnabled
      ? invoke(toolIds.pptEngine, "app_append_user_template_log", input)
      : Promise.resolve({ appended: false }),
    prepareUserTemplateDiagnosticBundle: (input) => invoke(toolIds.pptEngine, "app_prepare_user_template_diagnostic_bundle", input, { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS }),
    selectUserTemplatePages: (input) => invoke(toolIds.pptEngine, "app_select_user_template_pages", input, { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS }),
    saveUserTemplateHtml: (input) => invoke(toolIds.pptEngine, "app_save_user_template_html", input, { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS }),
    saveUserTemplateProfile: (input) => invoke(toolIds.pptEngine, "app_save_user_template_profile", input),
    saveUserTemplateProfileAsset: (input) => invoke<ProfileAssetMeta>(toolIds.pptEngine, "app_save_user_template_profile_asset", input, { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS }),
    publishUserTemplate: (input) => invoke(toolIds.pptEngine, "app_publish_user_template", input),
    getUserTemplateHtml: (input) => invoke(toolIds.pptEngine, "app_get_user_template_html", input),
    getUserTemplateAsset: (input) => invoke(toolIds.pptEngine, "app_get_user_template_asset", input),
    deleteUserTemplate: (input) => invoke(toolIds.pptEngine, "app_delete_user_template", input),
    listStyleProfiles: () =>
      invoke<ListStyleProfilesResult>(
        toolIds.pptEngine,
        "app_list_style_profiles",
        {}
      ),
    getStyleProfilePreview: (input) =>
      invoke<GetStyleProfilePreviewResult>(
        toolIds.pptEngine,
        "app_get_style_profile_preview",
        input
      ),
    getStyleProfile: (input) =>
      invoke<GetStyleProfileResult>(
        toolIds.pptEngine,
        "app_get_style_profile",
        input
      ),
    prepareStyleProfileCreation: (input = {}) =>
      invoke<PrepareStyleProfileCreationResult>(
        toolIds.pptEngine,
        "app_prepare_style_profile_creation",
        input
      ),
    commitStyleProfileReferenceHostUpload: (input) =>
      invoke<CommitStyleProfileReferenceHostUploadResult>(
        toolIds.pptEngine,
        "app_commit_style_profile_reference_host_upload",
        {
          creation_id: input.creation_id,
          filename: input.filename,
          mime_type: input.mime_type,
          size_bytes: input.size_bytes,
          host_upload: input.host_upload,
        }
      ),
    getStyleProfileCreationContext: (input) =>
      invoke<GetStyleProfileCreationContextResult>(
        toolIds.pptEngine,
        "app_get_style_profile_creation_context",
        input
      ),
    getStyleProfileDraftFingerprint: (input) =>
      invoke<StyleProfileDraftFingerprint>(
        toolIds.pptEngine,
        "app_get_style_profile_draft_fingerprint",
        input
      ),
    getStyleProfileDraft: (input) =>
      invoke<GetStyleProfileDraftResult>(
        toolIds.pptEngine,
        "app_get_style_profile_draft",
        input
      ),
    publishStyleProfile: (input) =>
      invoke<PublishStyleProfileResult>(
        toolIds.pptEngine,
        "app_publish_style_profile",
        input
      ),
    selectWorkspaceStyleProfile: (input) =>
      invoke<SelectWorkspaceStyleProfileResult>(
        toolIds.pptEngine,
        "app_select_workspace_style_profile",
        input
      ),
    getWorkspaceStyleProfile: (input) =>
      invoke<GetWorkspaceStyleProfileResult>(
        toolIds.pptEngine,
        "app_get_workspace_style_profile",
        input
      ),
    clearWorkspaceStyleProfile: (input) =>
      invoke<ClearWorkspaceStyleProfileResult>(
        toolIds.pptEngine,
        "app_clear_workspace_style_profile",
        input
      ),
    commitUploadedSourceHostUpload: (input) =>
      invoke<CommitUploadedSourceHostUploadResult>(
        toolIds.pptEngine,
        "app_commit_uploaded_source_host_upload",
        {
          workspace_dir: input.workspace_dir,
          filename: input.filename,
          mime_type: input.mime_type,
          size_bytes: input.size_bytes,
          host_upload: input.host_upload,
        }
      ),
    runUploadedSourcePreflight: (input) =>
      invoke<RunUploadedSourcePreflightResult>(toolIds.pptEngine, "app_run_uploaded_source_preflight", input),
    continueUploadedSourcePdfOcr: (input) =>
      invoke<ContinueUploadedSourcePdfOcrResult>(toolIds.pptEngine, "app_continue_uploaded_source_pdf_ocr", input),
    getUploadedSourcePreflightStatus: (input) =>
      invoke<GetUploadedSourcePreflightStatusResult>(toolIds.pptEngine, "app_get_uploaded_source_preflight_status", input),
    getUploadedSourcePreflightText: (input) =>
      invoke<GetUploadedSourcePreflightTextResult>(toolIds.pptEngine, "app_get_uploaded_source_preflight_text", input),
    getUploadedSourcePreflightChunks: (input) =>
      invoke<GetUploadedSourcePreflightChunksResult>(toolIds.pptEngine, "app_get_uploaded_source_preflight_chunks", input),
    prepareAttachmentBrief: (input) =>
      invoke<AttachmentBriefPaths>(toolIds.pptEngine, "app_prepare_attachment_brief", input),
    getAttachmentBriefDraft: (input) =>
      invoke<unknown | null>(toolIds.pptEngine, "app_get_attachment_brief_draft", input),
    recordAttachmentBrief: (input) => invoke<AttachmentBrief>(toolIds.pptEngine, "app_record_attachment_brief", input),
    getAttachmentBrief: (input) =>
      invoke<AttachmentBrief | null>(toolIds.pptEngine, "app_get_attachment_brief", input),
    listAttachmentBriefs: (input) =>
      invoke<ListAttachmentBriefsResult>(toolIds.pptEngine, "app_list_attachment_briefs", input),
    writeAttachmentContext: (input) =>
      invoke<AttachmentContext>(toolIds.pptEngine, "app_write_attachment_context", input),
    getAttachmentContext: (input) =>
      invoke<AttachmentContext | null>(toolIds.pptEngine, "app_get_attachment_context", input),
    listUploadedSources: (input) =>
      invoke<ListUploadedSourcesResult>(
        toolIds.pptEngine,
        "app_list_uploaded_sources",
        input
      ),
    removeUploadedSource: (input) =>
      invoke<RemoveUploadedSourceResult>(
        toolIds.pptEngine,
        "app_remove_uploaded_source",
        input
      ),
    uploadUploadedSourceForAgent: (input) =>
      invoke<{ workspace_dir: string; uploaded_source_id: string; host_upload: HostUploadRef }>(
        toolIds.pptEngine,
        "app_upload_uploaded_source_for_agent",
        input
      ),
    prepareUploadedSourceAnalysisWorkspace: (input) =>
      invoke<PrepareUploadedSourceAnalysisWorkspaceResult>(
        toolIds.pptEngine,
        "app_prepare_uploaded_source_analysis_workspace",
        input
      ),
    recordUploadedSourceAnalysisDraft: (input) =>
      invoke<Record<string, unknown>>(
        toolIds.pptEngine,
        "app_record_uploaded_source_analysis_draft",
        input
      ),
    getUploadedSourceAnalysisDraft: (input) =>
      invoke<Record<string, unknown>>(
        toolIds.pptEngine,
        "app_get_uploaded_source_analysis_draft",
        input
      ),
    getUploadedSourceAnalysisDraftFingerprint: (input) =>
      invoke<UploadedSourceAnalysisDraftFingerprint>(
        toolIds.pptEngine,
        "app_get_uploaded_source_analysis_draft_fingerprint",
        input
      ),
    recordUploadedSourceAnalysis: (input) =>
      invoke<Record<string, unknown>>(
        toolIds.pptEngine,
        "app_record_uploaded_source_analysis",
        input
      ),
    getUploadedSourceAnalysis: (input) =>
      invoke<Record<string, unknown>>(
        toolIds.pptEngine,
        "app_get_uploaded_source_analysis",
        input
      ),
    appendWorkspaceLog: async (input) => {
      if (!diagnosticLoggingEnabled && input.channel !== "preview-recovery") {
        return { workspace_dir: input.workspace_dir, log_file: "", appended: false };
      }
      return invoke<AppendWorkspaceLogResult>(toolIds.pptEngine, "app_append_workspace_log", input);
    },
    writeResearchTestFile: (input) => invoke<WriteResearchTestFileResult>(toolIds.pptEngine, "app_write_research_test_file", input),
    getWorkspaceRequirements: (input) =>
      invoke<PresentationRequirements>(
        toolIds.pptEngine,
        "app_get_workspace_requirements",
        input
      ),
    updateWorkspaceRequirements: (input) =>
      invokeWorkspaceResult("app_update_workspace_requirements", input),
    getWorkspaceOutline: (input) =>
      invoke<WorkspaceOutline>(
        toolIds.pptEngine,
        "app_get_workspace_outline",
        input
      ),
    resetWorkspaceOutline: (input) =>
      invokeWorkspaceResult("app_reset_workspace_outline", input),
    saveWorkspaceOutlineDraft: (input) =>
      invokeOutlineWorkspaceResult("app_save_workspace_outline_draft", input),
    confirmWorkspaceOutline: (input) =>
      invokeOutlineWorkspaceResult("app_confirm_workspace_outline", input),
    updateWorkspaceSettings: (input) =>
      invoke<UpdateWorkspaceSettingsResult>(
        toolIds.pptEngine,
        "app_patch_workspace_settings",
        input
      ),
    updateWorkspaceTitle: (input) =>
      invokeWorkspaceResult("app_update_workspace_title", input),
    deleteWorkspace: (input) =>
      invoke<DeleteWorkspaceResult>(toolIds.pptEngine, "app_delete_workspace", input),
    duplicateWorkspace: async (input) => {
      const result = await invoke<DuplicateWorkspaceResult>(toolIds.pptEngine, "app_duplicate_workspace", input, { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS });
      runDedicatedSnapshotPublishInvoke(result.workspace_dir, "workspace-duplicate");
      return result;
    },
    createProject: (input) =>
      invoke<ProjectResult>(toolIds.pptEngine, "app_create_project", input),
    getProject: (input) =>
      invoke<ProjectResult>(toolIds.pptEngine, "app_get_project", input),
    recordRequirements: (input) =>
      invoke<ProjectResult>(
        toolIds.pptEngine,
        "app_record_requirements",
        input
      ),
    listTemplates: () =>
      invoke<{ groups?: TemplateSummary[]; count?: number }>(
        toolIds.pptEngine,
        "app_list_template_groups",
        {}
      ).then((result) => ({
        templates: result.groups ?? [],
        count: result.count ?? result.groups?.length ?? 0,
      })),
    selectTemplate: (input) =>
      invoke<SelectTemplateResult>(
        toolIds.pptEngine,
        "app_select_workspace_template",
        input
      ),
    getTemplatePlanningContext: (input) =>
      invoke<TemplatePlanningContext>(
        toolIds.pptEngine,
        "app_get_template_planning_context",
        input
      ),
    getWorkspaceThemeContext: (input) =>
      invoke<WorkspaceThemeContext>(
        toolIds.pptEngine,
        "app_get_workspace_theme_context",
        input
      ),
    validateWorkspaceThemeToken: (input) =>
      invoke<WorkspaceThemeValidationResult>(
        toolIds.pptEngine,
        "app_validate_workspace_theme_token",
        input
      ),
    recordWorkspaceThemeToken: (input) =>
      invoke<RecordWorkspaceThemeTokenResult>(
        toolIds.pptEngine,
        "app_record_workspace_theme_token",
        input
      ),
    getWorkspacePageFileFingerprints: (input) =>
      invoke<GetWorkspacePageFileFingerprintsResult>(
        toolIds.pptEngine,
        "app_get_workspace_page_file_fingerprints",
        input,
      ),
    prepareSharedResearchWorkspace: (input) =>
      invoke<SharedResearchContextResult>(toolIds.pptEngine, "app_prepare_shared_research_workspace", input),
    getOutlineImagePreview: (input) => invoke<{ preview_url: string }>(toolIds.pptEngine, "app_get_outline_image_preview", input),
    uploadOutlineImageForAgent: (input) => invoke<{ host_upload: HostUploadRef }>(toolIds.pptEngine, "app_upload_outline_image_for_agent", input),
    getSharedResearchContext: (input) =>
      invoke<SharedResearchContextResult>(toolIds.pptEngine, "app_get_shared_research_context", input),
    patchSharedResearchProgress: (input) =>
      invoke<PatchSharedResearchProgressResult>(toolIds.pptEngine, "app_patch_shared_research_progress", input),
    publishPreparedWebResearchBatch: (input) =>
      invoke<PublishSharedResearchBatchResult>(toolIds.pptEngine, "app_publish_prepared_web_research_batch", input),
    publishPreparedImageResearchBatch: (input) =>
      invoke<PublishSharedResearchBatchResult>(toolIds.pptEngine, "app_publish_prepared_image_research_batch", input),
    appendSharedImageResearchBatch: (input) => invoke<{ workspace_dir: string; image_catalog_path: string; appended: boolean }>(
      toolIds.pptEngine, "app_append_image_research_batch", input),
    prepareSharedResearchImageCandidate: (input) =>
      invoke<PrepareSharedResearchImageCandidateResult>(toolIds.pptEngine, "app_prepare_shared_research_image_candidate", input),
    uploadSharedResearchImageCandidate: (input) =>
      invoke<UploadSharedResearchImageCandidateResult>(toolIds.pptEngine, "app_upload_shared_research_image_candidate", input),
    importSharedResearchImageLocal: (input) =>
      invoke<ImportSharedResearchImageResult>(toolIds.pptEngine, "app_import_shared_research_image_local", input),
    importUploadedSourceImageToResearch: (input) =>
      invoke<ImportSharedResearchImageResult>(
        toolIds.pptEngine,
        "app_import_uploaded_source_image_to_research",
        input,
      ),
    copyUploadedSourceImageToAsset: (input) =>
      invoke<ImportSharedResearchImageResult>(
        toolIds.pptEngine,
        "app_copy_uploaded_source_image_to_asset",
        input,
      ),
    cleanupSharedResearchImageStaging: (input) =>
      invoke<CleanupSharedResearchImageStagingResult>(toolIds.pptEngine, "app_cleanup_shared_research_image_staging", input),
    getPageProgress: (input) =>
      invoke<PageProgress>(toolIds.pptEngine, "app_get_page_progress", input),
    recordPageProgress: (input) =>
      invoke<PageProgress>(
        toolIds.pptEngine,
        "app_record_page_progress",
        input
      ),
    auditWorkspacePageLayout: (input) =>
      invoke<PageLayoutAuditResult>(toolIds.pptEngine, "app_audit_workspace_page_layout", input, { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS }),
    renderWorkspacePagePreview: (input) =>
      invoke<RenderWorkspacePagePreviewSubmissionResult>(
        toolIds.pptEngine,
        "app_render_workspace_page_preview",
        input,
        { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS },
      ),
    uploadCurrentPageScreenshot: (input) =>
      invoke<HostUploadRef>(
        toolIds.pptEngine,
        "app_upload_current_page_screenshot",
        input,
      ),
    getPageEditContext: async (input) => {
      const result = await invoke<GetPageEditContextResult>(toolIds.pptEngine, "app_get_page_edit_context", input);
      if ((input.page_id && result.page_id !== input.page_id) || result.workspace_dir !== input.workspace_dir || typeof result.html !== "string" || !Array.isArray(result.resources)) throw new Error("Invalid page editing context");
      return result;
    },
    commitManualPageImage: (input) => invoke<ManualPageImage>(toolIds.pptEngine, "app_commit_manual_page_image", input),
    refreshManualPageResources: async (input) => {
      const localUrls = [...new Set(input.local_urls)];
      const resources = await invoke<ManualPageResource[]>(toolIds.pptEngine, "app_refresh_manual_page_resources", { ...input, local_urls: localUrls });
      if (!Array.isArray(resources) || resources.some((item) => !localUrls.includes(item.local_url) || !item.url.startsWith("https://") || !Number.isFinite(Date.parse(item.expires_at)))
        || resources.length !== localUrls.length || new Set(resources.map((item) => item.local_url)).size !== localUrls.length) throw new Error("Invalid editor resource response");
      return resources;
    },
    pinManagedFont: (input) =>
      invoke<ManagedFontRuntimeFamily>(toolIds.pptEngine, "app_pin_managed_font", input),
    commitManagedFontUpload: (input) =>
      invoke<CommitManagedFontUploadResult>(
        toolIds.pptEngine,
        "app_commit_managed_font_host_upload",
        input,
      ),
    saveManualPageRevision: async (input) => {
      const result = await invoke<SaveManualPageRevisionResult>(toolIds.pptEngine, "app_save_manual_page_revision", input);
      runDedicatedSnapshotPublishInvoke(input.workspace_dir, "manual-page-save");
      return result;
    },
    preparePageRecovery: async (input) => {
      const option = await invoke<PageRecoveryOption>(toolIds.pptEngine, "app_prepare_page_recovery", input);
      if (option.workspace_dir !== input.workspace_dir || option.page_id !== input.page_id) throw new Error("Preview page identity mismatch");
      if (option.available && (!/^[a-f0-9]{64}$/.test(option.recovery_token ?? "")
        || !["original_source", "manual_base", "saved_snapshot"].includes(option.source ?? ""))) throw new Error("Invalid page recovery option");
      return option;
    },
    restorePageSourceVersion: async (input) => {
      const result = await invoke<RestorePageSourceVersionResult>(toolIds.pptEngine, "app_restore_page_source_version", input,
        { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS });
      if (result.workspace_dir !== input.workspace_dir || result.page_id !== input.page_id || result.restored !== true) throw new Error("Preview page identity mismatch");
      runDedicatedSnapshotPublishInvoke(input.workspace_dir, "page-restore");
      return result;
    },
    getRenderedDeckHtml: (input) =>
      invoke<RenderDeckHtmlResult>(
        toolIds.pptEngine,
        "app_get_rendered_deck_html",
        input
      ),
    prepareWorkspacePagePreview: (input) => invoke(toolIds.pptEngine,
      "app_prepare_workspace_page_preview", input),
    getWorkspacePagePreviewPreparation: (input) => invoke(toolIds.pptEngine,
      "app_get_workspace_page_preview_preparation", input),
    getWorkspacePageHtml: async (input) => {
      const result = await invoke<WorkspacePageHtml>(toolIds.pptEngine, "app_get_workspace_page_html", input);
      if (input.page_id && result.page_id !== input.page_id) throw new Error("Preview page identity mismatch");
      if (input.expected_preview_fingerprint && result.preview_source_fingerprint !== input.expected_preview_fingerprint) throw new Error("Page preview version changed");
      if (result.fallback && !input.fallback_only) throw new Error("Unexpected preview fallback");
      if (input.fallback_only && !result.fallback) throw new Error("Preview fallback metadata is missing");
      if (typeof result.html !== "string") throw new Error("Page HTML is missing");
      return result;
    },
    getWorkspacePageThumbnail: async (input) => decodePageThumbnail(
      await invoke<PageThumbnailTransport>(toolIds.pptEngine, "app_get_workspace_page_thumbnail", input,
        { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS }), input),
    recordOutline: (input) =>
      invoke<ProjectResult>(toolIds.pptEngine, "app_record_outline", input),
    renderDeckHtml: (input) =>
      invoke<RenderDeckHtmlSubmissionResult>(
        toolIds.pptEngine,
        "app_render_deck_html",
        input,
        { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS },
      ),
    recordDeckReview: (input) =>
      invoke<ProjectResult>(
        toolIds.pptEngine,
        "app_record_deck_review",
        input
      ),
    startPptxExport: async (input) => {
      const result = await invoke<PptxExportJob>(
        toolIds.pptEngine,
        "app_start_pptx_export",
        input
      );
      runDedicatedSnapshotPublishInvoke(input.workspace_dir, "pptx-export");
      return result;
    },
    getPptxExportStatus: (input) =>
      invoke<PptxExportJob>(
        toolIds.pptEngine,
        "app_get_pptx_export_status",
        input
      ),
    runPptxExport: async (input) => {
      let lastProgress = "";
      const reportProgress = (status: PptxExportJob) => {
        const fingerprint = `${status.status}:${status.percent}:${status.export_phase ?? ""}:${status.current_page ?? ""}:${status.total_pages ?? ""}:${status.message}`;
        if (fingerprint === lastProgress) return;
        lastProgress = fingerprint;
        input.onProgress?.({
          percent: status.percent,
          message: status.message,
          ...(status.export_phase ? { phase: status.export_phase } : {}),
          ...(status.current_page && status.total_pages
            ? { currentPage: status.current_page, totalPages: status.total_pages }
            : {}),
        });
      };
      let job = await invoke<PptxExportJob>(
        toolIds.pptEngine,
        "app_start_pptx_export",
        {
          workspace_dir: input.workspace_dir,
          ...(input.pageNumbers === undefined ? {} : { page_numbers: input.pageNumbers }),
        },
      );
      const deadline = Date.now() + EXPORT_ASYNC_TIMEOUT_MS;
      while (true) {
        reportProgress(job);
        if (job.status === "completed") {
          runDedicatedSnapshotPublishInvoke(input.workspace_dir, "pptx-export");
          return job;
        }
        if (job.status === "failed") {
          throw new Error(job.error?.message || job.message || "PPTX export failed");
        }
        if (Date.now() >= deadline) {
          throw new Error("PPTX export exceeded the 10-minute deadline.");
        }
        if (input.signal?.aborted) {
          throw new DOMException("Export job was cancelled.", "AbortError");
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        job = await invoke<PptxExportJob>(
          toolIds.pptEngine,
          "app_get_pptx_export_status",
          { workspace_dir: input.workspace_dir },
        );
      }
    },
    exportPdf: async (input: ExportPdfInput) => {
      const result = await invoke<ExportPdfResult>(toolIds.pptEngine, "app_export_pdf", input);
      runDedicatedSnapshotPublishInvoke(input.workspace_dir, "pdf-export");
      return normalizeExportPdfResult(result);
    },
    runPdfExport: async (input) => {
      const result = await invokeAsyncAwaitRaw<ExportPdfResult>(
        toolIds.pptEngine,
        "app_run_pdf_export",
        {
          workspace_dir: input.workspace_dir,
          ...(input.pageNumbers === undefined ? {} : { page_numbers: input.pageNumbers }),
        },
        exportClientTag(input.workspace_dir, "pdf"),
        {
          signal: input.signal,
          onProgress: input.onProgress,
        },
      );
      runDedicatedSnapshotPublishInvoke(input.workspace_dir, "pdf-export");
      return normalizeExportPdfResult(result);
    },
    recordPdfExport: (input: RecordPdfExportInput) =>
      invokeWorkspaceResult("app_record_pdf_export", {
        workspace_dir: input.workspace_dir,
        pdf_path: input.pdfPath,
      }),
    startExportArtifactPublish: async (input) => {
      const result = await invoke<ExportArtifactPublishJob>(
        toolIds.pptEngine,
        "app_start_export_artifact_publish",
        {
          workspace_dir: input.workspace_dir,
          artifact_type: input.artifact_type,
        },
      );
      runDedicatedSnapshotPublishInvoke(input.workspace_dir, `export-artifact:${input.artifact_type}`);
      return result;
    },
    getExportArtifactPublishStatus: (input) =>
      invoke<ExportArtifactPublishJob>(
        toolIds.pptEngine,
        "app_get_export_artifact_publish_status",
        {
          workspace_dir: input.workspace_dir,
          artifact_type: input.artifact_type,
        },
      ),
    runExportArtifactPublish: async (input) => {
      const result = await invokeAsyncAwaitRaw<ExportArtifactPublishJob>(
        toolIds.pptEngine,
        "app_run_export_artifact_publish",
        {
          workspace_dir: input.workspace_dir,
          artifact_type: input.artifact_type,
        },
        exportClientTag(input.workspace_dir, "mirror", input.artifact_type),
        {
          signal: input.signal,
          onProgress: input.onProgress,
        },
      );
      runDedicatedSnapshotPublishInvoke(input.workspace_dir, `export-artifact:${input.artifact_type}`);
      return result;
    },
    listExportJobs: async (input) => {
      if (!runtime.tools.listJobs) {
        throw new Error(
          "SlideForge Host job recovery API is unavailable. Upgrade the SlideForge runtime before refreshing export tasks.",
        );
      }
      const clientTags = input.artifact_type
        ? [exportClientTag(input.workspace_dir, "mirror", input.artifact_type)]
        : [
            exportClientTag(input.workspace_dir, "pptx"),
            exportClientTag(input.workspace_dir, "pdf"),
            exportClientTag(input.workspace_dir, "mirror", "pptx"),
            exportClientTag(input.workspace_dir, "mirror", "pdf"),
          ];
      const responses = await Promise.all(
        clientTags.map(async (clientTag) => ({
          clientTag,
          response: await runtime.tools.listJobs!({
            tool_id: toolIds.pptEngine,
            clientTag,
            state: ["queued", "running"],
            limit: 10,
          }),
        })),
      );
      return responses.flatMap(({ clientTag, response }) =>
        (Array.isArray(response.jobs) ? response.jobs : []).map((job) => {
          const normalized = normalizeAsyncJobSnapshot(job);
          return normalized.clientTag ? normalized : { ...normalized, clientTag };
        }),
      );
    },
    awaitExportJob: async <T>(input: {
      job_id: string;
      signal?: AbortSignal;
      onProgress?: (progress: ToolJobProgress) => void;
    }) => {
      if (!runtime.tools.getJob) {
        throw new Error(
          "SlideForge Host job recovery API is unavailable. Upgrade the SlideForge runtime before refreshing export tasks.",
        );
      }
      const deadline = Date.now() + EXPORT_ASYNC_TIMEOUT_MS;
      let sinceSeq = 0;
      while (Date.now() < deadline) {
        if (input.signal?.aborted) {
          if (runtime.tools.cancelJob) {
            await runtime.tools.cancelJob({ jobId: input.job_id, reason: "user_cancelled" }).catch(() => undefined);
          }
          throw new DOMException("Export job was cancelled.", "AbortError");
        }
        const snapshot = normalizeAsyncJobSnapshot(await runtime.tools.getJob<T>({
          jobId: input.job_id,
          sinceSeq,
          limit: 100,
        }));
        for (const progress of snapshot.progress ?? []) {
          input.onProgress?.(progress);
          sinceSeq = Math.max(sinceSeq, progress.seq);
        }
        if (snapshot.state === "succeeded") {
          return unwrapToolResult<T>(snapshot.result);
        }
        if (snapshot.state === "failed" || snapshot.state === "cancelled" || snapshot.state === "expired") {
          throw new Error(snapshot.error?.message || `Export Host job ended in state ${snapshot.state}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Export Host job exceeded the 10-minute deadline.");
    },
    cancelExportJob: async (input) => {
      if (!runtime.tools.cancelJob) {
        throw new Error(
          "SlideForge Host job cancellation API is unavailable. Upgrade the SlideForge runtime before cancelling export tasks.",
        );
      }
      return runtime.tools.cancelJob({ jobId: input.job_id, reason: input.reason });
    },
    getExportArtifactDownloadUrl: (input) =>
      invoke<ExportArtifactDownloadUrlResult>(
        toolIds.pptEngine,
        "app_get_export_artifact_download_url",
        {
          workspace_dir: input.workspace_dir,
          artifact_type: input.artifact_type,
        }
      ),
    prepareWorkspaceDiagnosticBundle: (input) =>
      invoke<PrepareWorkspaceDiagnosticBundleResult>(
        toolIds.pptEngine,
        "app_prepare_workspace_diagnostic_bundle",
        { workspace_dir: input.workspace_dir },
        { timeoutMs: LONG_RUNNING_TOOL_TIMEOUT_MS }
      )
  };
}
