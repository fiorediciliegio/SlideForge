#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import readline from "node:readline";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { appendFile, copyFile, mkdir, open, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { INVOKE_INLINE_BYTES, INVOKE_TRANSPORT_TOOL, INVOKE_CHANNEL_TOOL, jsonBytes, encodeInvokePayload, decodeInvokePayload } from "./invoke-transport.js";
import { createInvokeTransportChannel, downloadInvokeUpload } from "./invoke-transport-server.js";
import { pipeline } from "node:stream/promises";

import { parseHostUploadConfirmation } from "./host-upload-confirmation.js";
import {
  createHostUploadCache,
  hostUploadCacheKey,
  readCachedHostUpload,
  storeHostUpload,
} from "./host-upload-cache.js";
import {
  APS_FILES_DOWNLOAD_SCOPE,
  ApsFilesClient,
  ApsFilesError,
} from "./aps-files-client.js";
import {
  assertStorageResponseOk,
  classifyHostUploadAware,
  runWithStorageRetry,
} from "./storage-retry.js";
import { attachInvokeContext, bindInvoke, getCurrentInvokeId } from "./invoke-context.js";

import {
  auditAppWorkspacePageLayout,
  createAppPageRegeneration,
  getAppPageRegeneration,
  submitAppPageRegenerationCandidate,
  failAppPageRegenerationCandidate,
  adoptAppPageRegeneration,
  appendAppWorkspaceLog,
  isDiagnosticLoggingEnabled,
  runWithDiagnosticLogging,
  runWithRequiredLifecycleLogging,
  createUserTemplateDraft,
  saveUserTemplateSource,
  saveUserTemplateProfileAsset,
  appendUserTemplateLog,
  recordUserTemplateOperation,
  prepareUserTemplateDiagnosticBundle,
  deleteUserTemplate,
  listUserTemplates,
  getUserTemplate,
  getUserTemplateHtmls,
  selectUserTemplatePages,
  saveUserTemplateHtml,
  publishUserTemplate,
  getUserTemplateAsset,
  USER_TEMPLATE_MAX_BYTES,
  PROFILE_ASSET_MAX_BYTES,
  saveUserTemplateProfile,
  validateDesignProfile,
  createImageUserTemplate,
  writeAppResearchTestFile,
  beginAppGenerationRun,
  prepareAppGenerationRun,
  abandonAppGenerationRun,
  commitAppGenerationRun,
  cleanupAppGenerationRun,
  getAppWorkspaceGenerationRun,
  buildDeckHtmlFromManifest,
  createAppWorkspace,
  deleteAppWorkspace,
  getAppWorkspaceTombstone,
  clearAppWorkspaceTombstone,
  duplicateAppWorkspace,
  ensureConfirmedOutlinePageIds,
  createAppExportArtifactSnapshot,
  commitAppExportArtifactMirror,
  getAppExportArtifactMirrorStatus,
  exportAppPdf,
  forkTemplateGroup,
  getAppWorkspaceDefaults,
  getAppTemplateGroup,
  getAppTemplatePlanningContext,
  getAppWorkspaceThemeContext,
  getAppWorkspacePageFileFingerprints,
  getAppPageProgress,
  getAppPageEditContext,
  pinManagedFontToWorkspace,
  commitManagedFontUpload,
  getAppPptxExportStatus,
  startAppExportArtifactPublish,
  getAppExportArtifactPublishStatus,
  writeAppExportArtifactPublishJob,
  markAppExportArtifactPublishJobInterrupted,
  getAppWorkspacePageHtml,
  getAppWorkspacePageThumbnail,
  withTransientPageScreenshot,
  preparePreviewResources,
  normalizeManualPageResources,
  storeManualPageImage,
  createPreviewResourceResolver,
  getAppOutlineImagePreview,
  resolveAppOutlineImage,
  getRenderedAppWorkspaceDeckHtml,
  getAppWorkspacePagePreviewFallbacks,
  fingerprintWorkspacePageSource,
  installWorkspaceAuthoringKit,
  listAppUploadedSources,
  ignoreAppUploadedSource,
  commitAppUploadedSourceUpload,
  appPageImageUpload,
  appOutlineImageDescriptions,
  runAppUploadedSourcePreflight,
  continueAppUploadedSourcePdfOcr,
  getAppUploadedSourcePreflightStatus,
  getAppUploadedSourcePreflightText,
  getAppUploadedSourcePreflightChunks,
  prepareAppAttachmentBrief,
  getAppAttachmentBriefDraft,
  recordAppAttachmentBrief,
  getAppAttachmentBrief,
  listAppAttachmentBriefs,
  writeAppAttachmentContext,
  getAppAttachmentContext,
  getAppUploadedSourceAnalysis,
  getAppUploadedSourceAnalysisDraft,
  getAppUploadedSourceAnalysisDraftFingerprint,
  getAllDiscoveredTemplateGroups,
  getAppWorkspaceOutline,
  getAppWorkspaceRequirements,
  getDiscoveredTemplateGroup,
  listAppWorkspaces,
  listAppWorkspacesPage,
  listAppStyleProfiles,
  getAppStyleProfile,
  getAppStyleProfilePreview,
  prepareAppStyleProfileCreation,
  commitAppStyleProfileReferenceUpload,
  getAppStyleProfileCreationContext,
  getAppStyleProfileDraft,
  getAppStyleProfileDraftFingerprint,
  publishAppStyleProfile,
  selectAppWorkspaceStyleProfile,
  getAppWorkspaceStyleProfile,
  clearAppWorkspaceStyleProfile,
  listAppTemplateGroups,
  listDiscoveredTemplateGroupSummaries,
  openAppWorkspace,
  patchAppWorkspaceSettings,
  patchAppWorkspaceDefaults,
  prepareAppPageRefinement,
  commitAppDeckRefinement,
  prepareAppWorkspaceDiagnosticBundle,
  createAppBatchTestRun,
  listAppBatchTestRuns,
  updateAppBatchTestCase,
  updateAppBatchTestRun,
  deleteAppBatchTestRun,
  prepareAppBatchTestBundle,
  prepareAppUploadedSourceAnalysisWorkspace,
  prepareAppSharedResearchWorkspace,
  getAppSharedResearchContext,
  patchAppSharedResearchProgress,
  publishPreparedAppWebResearchBatch,
  publishPreparedAppImageResearchBatch,
  appendAppWebResearchBatch,
  appendAppImageResearchBatch,
  appPageImageSearch,
  importAppSharedResearchImage,
  importAppUploadedSourceImageToResearch,
  copyAppUploadedSourceImageToAsset,
  downloadResearchImage,
  prepareWorkspacePageSources,
  ensureWorkspacePersistentElementsReference,
  fingerprintWorkspacePersistentElements,
  reconcileWorkspacePageSources,
  recordAppWorkspaceStyleGuide,
  recordAppWorkspaceVisualMasterHtml,
  getAppWorkspaceVisualMasterHtml,
  recordAppWorkspacePageHtml,
  listAppWorkspaceTemplateReferences,
  getAppWorkspaceTemplateReferenceHtml,
  getAppWorkspaceAestheticReferenceSelections,
  recordAppWorkspaceAestheticReferenceSelection,
  recordAppVisualRhythm,
  getAppVisualRhythmStatus,
  getAppVisualRhythm,
  recordAppPageVisualPlan,
  getAppPageVisualPlanStatus,
  getAppPageVisualPlan,
  getAppWorkspaceStyleGuideStatus,
  getAppWorkspaceStyleGuide,
  ensureAppWorkspacePersistentElementsReference,
  getAppWorkspacePersistentElementsStatus,
  typecheckAppWorkspacePersistentElements,
  initializeAppPageProgress,
  recordAppPageProgress,
  recordAppPdfExport,
  recordAppWorkspaceThemeToken,
  rebuildWorkspaceDeckManifest,
  removeAppUploadedSource,
  recordAppUploadedSourceAnalysis,
  recordAppUploadedSourceAnalysisDraft,
  rasterizePptxToImages,
  renderAppWorkspaceDeckHtml,
  renderAppWorkspacePagePreview,
  prepareAppWorkspacePagePreview,
  getAppWorkspacePagePreviewPreparation,
  runExportOnly,
  performAppWorkspacePagePreviews,
  saveAppManualPageRevision,
  publishAppWorkspaceSnapshot,
  markAppWorkspaceSnapshotDirty,
  getAppWorkspaceSnapshotSyncState,
  recordAppWorkspaceSnapshotRetry,
  getDefaultAppWorkspaceRoot,
  getAppWorkspaceSnapshotInfo,
  verifyAppWorkspaceSnapshotZip,
  startAppWorkspaceSnapshotPublish,
  getAppWorkspaceSnapshotPublishStatus,
  writeAppWorkspaceSnapshotPublish,
  commitAppWorkspaceSnapshotPublish,
  markAppWorkspaceSnapshotPublishJobInterrupted,
  regenerateAppWorkspaceSnapshot,
  startAppWorkspaceRestoreSnapshot,
  getAppWorkspaceSnapshotRestoreStatus,
  writeAppWorkspaceSnapshotRestore,
  extractAppWorkspaceSnapshotZip,
  commitAppWorkspaceSnapshotRestore,
  markAppWorkspaceSnapshotRestoreJobInterrupted,
  startAppWorkspaceSnapshotRebuild,
  writeAppWorkspaceSnapshotRebuild,
  getAppWorkspaceLocalSnapshotFingerprint,
  classifyAppWorkspaceSnapshotReconcile,
  backupAppWorkspaceAsLocalCopy,
  restoreAppPageSourceVersion,
  prepareAppPageRecovery,
  selectAppWorkspaceTemplate,
  startAppPptxExport,
  invokeTaskStateMachine,
  confirmAppWorkspaceOutline,
  resetAppWorkspaceOutline,
  saveAppWorkspaceOutlineDraft,
  updateAppWorkspaceRequirements,
  confirmAppWorkspaceRequirements,
  updateAppWorkspaceSettings,
  updateAppWorkspaceTitle,
  validateAppWorkspaceThemeToken,
  abandonPerformanceRun,
  appendPerformanceEvents,
  deletePerformanceRun,
  finalizePerformanceRun,
  getActivePerformanceRun,
  getPerformanceReportPath,
  listPerformanceRuns,
  regeneratePerformanceReport,
  startPerformanceRun,
  getAgentResourceInfo,
  materializePerformanceRun,
} from "./dist/index.js";

const TASK_STATE_MACHINE_TOOL_NAMES = [
  "create_task_project",
  "open_task_project",
  "query_task_state",
  "record_requirements",
  "record_template_selection",
  "record_outline",
  "start_page_iteration",
  "record_page_progress",
  "record_deck_review_feedback",
  "advance_task_state",
  "rewind_task_state",
  "branch_task_project",
  "list_task_checkpoints",
  "recover_task_project",
  "validate_task_project",
];
const FILE_TRANSPORT_DIRNAME = ".executa-file-transport";
const FILE_TRANSPORT_FALLBACK_DIR = path.join(
  os.tmpdir(),
  "presenton-template-engine-executa",
  "file-transport",
);
const MAX_STDOUT_RESPONSE_BYTES = 512 * 1024;
const PROTOCOL_VERSION_V2 = "2.0";
const HOST_UPLOAD_METHOD = "host/uploadFile";
const UPLOAD_ERR_NOT_GRANTED = -32201;
const UPLOAD_ERR_TIMEOUT = -32208;
const UPLOAD_ERR_NOT_NEGOTIATED = -32210;

function readToolManifest() {
  const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
  return {
    ...manifest,
    tools: manifest.tools.map((tool) => {
      if (!tool.name.startsWith("app_")) return tool;
      return {
        ...tool,
        parameters: [
          ...(Array.isArray(tool.parameters) ? tool.parameters : []),
          {
            name: "diagnostic_logging_enabled",
            type: "boolean",
            required: false,
            description: "Whether PPT App diagnostic logs are recorded. Supplied on every call from the frontend build setting; omitted means false.",
          },
          ...(tool.name.includes("performance_") ? [] : [{
            name: "performance_context",
            type: "object",
            required: false,
            description: "Optional bounded Performance Trace context supplied by PPT App; it never becomes a Workspace artifact.",
          }]),
        ],
      };
    }),
  };
}

const MANIFEST = readToolManifest();

function toolAppGetRuntimeInfo() {
  return {
    ppt_engine_version: MANIFEST.version,
    performance_testing: {
      supported: true,
      schema_version: 1,
    },
    uploaded_source_preflight: {
      pdf_ocr_continuation: true,
      pdf_ocr_execution: "isolated-process-v1",
      pdf_ocr_diagnostics: "stage-v1",
    },
  };
}

async function toolAppGetAgentResourceInfo() {
  return getAgentResourceInfo();
}

function readPerformanceContext(args) {
  const value = args?.performance_context;
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('"performance_context" must be an object');
  }
  const required = ["run_id", "trace_id", "span_id"];
  for (const key of required) {
    if (typeof value[key] !== "string" || value[key].length < 8 || value[key].length > 128) {
      throw new Error(`"performance_context.${key}" is invalid`);
    }
  }
  for (const key of ["parent_span_id", "operation_name", "workspace_id"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 160)) {
      throw new Error(`"performance_context.${key}" is invalid`);
    }
  }
  return {
    run_id: value.run_id,
    trace_id: value.trace_id,
    span_id: value.span_id,
    ...(value.parent_span_id ? { parent_span_id: value.parent_span_id } : {}),
    ...(value.operation_name ? { operation_name: value.operation_name } : {}),
    ...(value.workspace_id ? { workspace_id: value.workspace_id } : {}),
  };
}

let performanceSequence = 0;
const PLUGIN_PERFORMANCE_QUEUE_LIMIT = 1_000;
const pluginPerformanceQueue = [];
let pluginPerformanceDrain = null;
let pluginPerformanceDropped = 0;

function createPluginPerformanceEvent(context, eventType, fields = {}) {
  return {
    schema_version: 1,
    event_id: randomUUID(),
    event_type: eventType,
    recorded_at: new Date().toISOString(),
    producer_id: `ppt-engine-${process.pid}`,
    sequence_number: performanceSequence++,
    trace_id: context.trace_id,
    span_id: context.span_id,
    parent_span_id: context.parent_span_id,
    operation_name: context.operation_name,
    workspace_id: context.workspace_id,
    ...fields,
  };
}

function recordToolPerformance(context, event) {
  if (!context) return;
  if (pluginPerformanceQueue.length >= PLUGIN_PERFORMANCE_QUEUE_LIMIT) {
    pluginPerformanceDropped += 1;
    return;
  }
  pluginPerformanceQueue.push({ runId: context.run_id, event });
  void flushPluginPerformanceQueue();
}

async function flushPluginPerformanceQueue() {
  if (pluginPerformanceDrain) return pluginPerformanceDrain;
  pluginPerformanceDrain = (async () => {
    while (pluginPerformanceQueue.length > 0) {
      const runId = pluginPerformanceQueue[0].runId;
      const batch = [];
      while (batch.length < 100 && pluginPerformanceQueue[0]?.runId === runId) {
        batch.push(pluginPerformanceQueue.shift().event);
      }
      if (pluginPerformanceDropped > 0) {
        const dropped = pluginPerformanceDropped;
        pluginPerformanceDropped = 0;
        batch.push({
          schema_version: 1,
          event_id: randomUUID(),
          event_type: "data.loss",
          recorded_at: new Date().toISOString(),
          producer_id: `ppt-engine-${process.pid}`,
          sequence_number: performanceSequence++,
          attributes: { dropped_count: dropped, reason: "backend_queue_overflow" },
        });
      }
      try {
        await appendPerformanceEvents({ run_id: runId, events: batch });
      } catch (error) {
        process.stderr.write(`[performance] failed to append event batch: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  })().finally(() => {
    pluginPerformanceDrain = null;
    if (pluginPerformanceQueue.length > 0) void flushPluginPerformanceQueue();
  });
  return pluginPerformanceDrain;
}

async function toolAppListPerformanceRuns() {
  return listPerformanceRuns();
}

async function toolAppStartPerformanceRun(args) {
  return startPerformanceRun({
    app_version: typeof args?.app_version === "string" ? args.app_version : undefined,
    environment: args?.environment && typeof args.environment === "object" && !Array.isArray(args.environment) ? args.environment : undefined,
    initial_settings: args?.initial_settings && typeof args.initial_settings === "object" && !Array.isArray(args.initial_settings) ? args.initial_settings : undefined,
  });
}

async function toolAppAppendPerformanceEvents(args) {
  return appendPerformanceEvents({ run_id: args?.run_id, events: args?.events });
}

async function toolAppFinalizePerformanceRun(args) {
  await flushPluginPerformanceQueue();
  return finalizePerformanceRun({
    run_id: args?.run_id,
    locale: ["en", "zh", "ja", "de"].includes(args?.locale) ? args.locale : "en",
    force: args?.force === true,
  });
}

async function toolAppRegeneratePerformanceReport(args) {
  return regeneratePerformanceReport({
    run_id: args?.run_id,
    locale: ["en", "zh", "ja", "de"].includes(args?.locale) ? args.locale : "en",
  });
}

async function toolAppAbandonPerformanceRun(args) {
  await flushPluginPerformanceQueue();
  return abandonPerformanceRun({ run_id: args?.run_id });
}

async function toolAppDeletePerformanceRun(args) {
  return deletePerformanceRun({ run_id: args?.run_id });
}

async function toolAppPreparePerformanceReport(args) {
  const result = await getPerformanceReportPath({ run_id: args?.run_id });
  return { run: result.run, report_html: await readFile(result.report_path, "utf8") };
}

function makeResponse(id, result, error) {
  const response = { jsonrpc: "2.0", id };
  if (error !== undefined) {
    response.error = error;
  } else {
    response.result = result;
  }
  return response;
}

function createInvalidParamsError(message) {
  return { code: -32602, message };
}

class HostUploadError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "HostUploadError";
    this.code = code;
    this.data = data;
  }
}

class ExecutaHostUploadClient {
  constructor() {
    this.pending = new Map();
    this.disabledReason = "host/uploadFile has not been negotiated; call initialize with Executa protocol 2.0 first.";
  }

  enable() {
    this.disabledReason = "";
  }

  disable(reason) {
    this.disabledReason = reason || "host/uploadFile is not available.";
  }

  dispatchResponse(message) {
    if (!message || typeof message !== "object" || Array.isArray(message) || "method" in message) {
      return false;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return false;
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new HostUploadError(
        Number.isInteger(message.error.code) ? message.error.code : -32603,
        typeof message.error.message === "string" ? message.error.message : "host/uploadFile failed",
        message.error.data,
      ));
      return true;
    }
    pending.resolve(message.result ?? {});
    return true;
  }

  async negotiate({ filename, mimeType, sizeBytes, purpose, metadata }) {
    return this.call({
      mode: "negotiate",
      filename,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      purpose,
      metadata,
    });
  }

  async confirm(r2Key) {
    return this.call({
      mode: "confirm",
      r2_key: r2Key,
    });
  }

  async call(params, timeoutMs = 120_000) {
    if (this.disabledReason) {
      process.stderr.write(
        `host/uploadFile proceeding without negotiated initialize: ${this.disabledReason}\n`,
      );
    }

    const id = `host-upload-${Date.now()}-${process.pid}-${randomUUID()}`;
    const message = {
      jsonrpc: "2.0",
      id,
      method: HOST_UPLOAD_METHOD,
      params: attachInvokeContext(Object.fromEntries(
        Object.entries(params).filter(([, value]) => value !== undefined),
      )),
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostUploadError(
          UPLOAD_ERR_TIMEOUT,
          `${HOST_UPLOAD_METHOD} timed out after ${timeoutMs}ms`,
        ));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      writeStdoutLine(JSON.stringify(message)).catch((error) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
}

const hostUploadClient = new ExecutaHostUploadClient();
const hostUploadCache = createHostUploadCache();
const apsFilesClient = new ApsFilesClient({
  writeFrame: (message) => writeStdoutLine(JSON.stringify(message)),
});
const activeExportArtifactPublishJobIds = new Set();
const activeExportArtifactPublishJobPromises = new Map();
let exportArtifactPublishQueue = Promise.resolve();
const EXPORT_ASYNC_TIMEOUT_MS = 600_000;
const activeWorkspaceSnapshotPublishJobIds = new Set();
const activeWorkspaceSnapshotPublishJobPromises = new Map();
let workspaceSnapshotPublishQueue = Promise.resolve();
const SNAPSHOT_PUBLISH_ASYNC_TIMEOUT_MS = 600_000;
// Development-only fault-injection gate for exercising the race between an
// already-verified upload N and a later local snapshot N+1. Its control file
// lives beside snapshot-sync.json instead of in the App UI, so test controls
// can never become a product-facing setting.
const SNAPSHOT_UPLOAD_TEST_GATE_FILENAME = "snapshot-upload-test-gate.json";
const SNAPSHOT_UPLOAD_TEST_GATE_POLL_MS = 250;
const activeWorkspaceSnapshotDedicatedPublishInvokeIds = new Set();
const activeWorkspaceSnapshotDedicatedPublishPromises = new Map();
const activeWorkspaceSnapshotRestoreJobIds = new Set();
const activeWorkspaceSnapshotRestoreJobPromises = new Map();
// Keep the two expensive phases independently scheduled.  A restore owns
// download/extract/attachment I/O; a rebuild owns the screenshot/deck render
// pipeline.  Both intentionally remain single-concurrency for now, but their
// separate priority queues prevent a large restore batch from eagerly filling
// the render queue and let an explicitly opened Workspace cut in ahead of
// unattended work.
const AUTO_RESTORE_FIRST_SCREEN_LIMIT = 3;
const SNAPSHOT_QUEUE_PRIORITY = Object.freeze({
  background: 0,
  first_screen: 1,
  user_open: 2,
});
let workspaceSnapshotRestoreQueueSequence = 0;
let workspaceSnapshotRestoreDraining = false;
const pendingWorkspaceSnapshotRestoreJobs = new Map();
let workspacePreviewRegenerationQueueSequence = 0;
let workspacePreviewRegenerationDraining = false;
const pendingWorkspacePreviewRegenerations = new Map();
const SNAPSHOT_RESTORE_ASYNC_TIMEOUT_MS = 600_000;
const workspaceDiagnosticBundleQueues = new Map();

function redactStorageResponse(value) {
  if (Array.isArray(value)) return value.map(redactStorageResponse);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (/(authorization|token|signature|signed[_-]?url|put[_-]?url|download[_-]?url|get[_-]?url)/i.test(key) || key.toLowerCase() === "url") {
      return [key, "[REDACTED]"];
    }
    return [key, redactStorageResponse(child)];
  }));
}

function storageErrorRecord(error) {
  const redactMessage = (message) => String(message).replace(/https?:\/\/\S+/gi, "[REDACTED_URL]");
  return {
    name: error?.name || "Error",
    message: redactMessage(error instanceof Error ? error.message : String(error)),
    ...(Number.isInteger(error?.code) ? { code: error.code } : {}),
    ...(Number.isInteger(error?.status) ? { http_status: error.status } : {}),
    ...(typeof error?.providerCode === "string" ? { provider_code: error.providerCode } : {}),
    ...(error?.data && typeof error.data === "object" ? { data: redactStorageResponse(error.data) } : {}),
  };
}

function createStorageTransferLogger(context = {}) {
  const transferId = `transfer-${randomUUID()}`;
  const workspaceDir = typeof context.workspaceDir === "string" ? context.workspaceDir : "";
  const base = {
    schema_version: 1,
    transfer_id: transferId,
    ...context.diagnosticContext,
    operation_id: context.operationId ?? context.diagnosticContext?.operation_id,
    parent_interaction_id: context.parentInteractionId,
    source: context.source || "ppt-engine-host-upload",
    transport: context.transport || "host_upload",
    filename: context.filename,
    mime_type: context.mimeType,
    size_bytes: context.sizeBytes,
  };
  return {
    log(phase, status, extra = {}) {
      if ((!workspaceDir && !context.templateId) || !isDiagnosticLoggingEnabled()) return;
      const append = context.templateId ? appendUserTemplateLog : appendAppWorkspaceLog;
      void append({
        ...(context.templateId ? { id: context.templateId } : { workspace_dir: workspaceDir }),
        channel: "storage-transport",
        entry: {
          event: status === "failed" ? "storage.transfer.failed" : `storage.transfer.${phase}`,
          ...base,
          phase,
          status,
          ...extra,
        },
      }).catch(() => undefined);
    },
  };
}

function createApsTransferLogger({ workspaceDir, templateId, diagnosticContext, source, filename, mimeType, sizeBytes, path: apsPath, operationId, parentInteractionId }) {
  return createStorageTransferLogger({
    workspaceDir,
    templateId,
    diagnosticContext,
    source,
    filename,
    mimeType,
    sizeBytes,
    transport: "aps_files",
    operationId: operationId || apsPath,
    parentInteractionId,
  });
}

// Per-step wall-clock timing for a cloud restore, emitted to agent stdout and
// appended one-JSON-per-line to <root>/.snapshot-sync/<workspaceId>/
// cloud-restore-timing.jsonl so a full restore can be reviewed phase by phase
// (target resolve → download_url → zip download → extract → commit → preview
// re-render). Each entry carries duration_ms (time since the previous step) and
// elapsed_ms (time since the restore started). The file lives in the snapshot
// sync bookkeeping dir (NOT inside the workspace): the restore commit replaces
// the whole workspace dir, which would wipe an in-workspace log — only
// post-commit lines would survive. autoRestore clears this dir before a restore
// so each restore starts a fresh timeline.
function createRestoreStepTimer(workspaceDir, context = {}) {
  const startedAt = Date.now();
  let lastStepAt = startedAt;
  const logFile = workspaceDir
    ? path.join(path.dirname(workspaceDir), ".snapshot-sync", path.basename(workspaceDir), "cloud-restore-timing.jsonl")
    : null;
  const record = async (entry) => {
    if (!logFile) return;
    try {
      await mkdir(path.dirname(logFile), { recursive: true });
      await writeFile(logFile, `${JSON.stringify(entry)}\n`, { flag: "a" });
    } catch {
      // best-effort: a locked dir or read-only FS must not block the restore
    }
  };
  return {
    started_at: new Date(startedAt).toISOString(),
    step(step, extra = {}) {
      if (!isDiagnosticLoggingEnabled()) return Date.now();
      const now = Date.now();
      const durationMs = now - lastStepAt;
      lastStepAt = now;
      const entry = {
        event: "cloud.restore.step",
        ts: new Date(now).toISOString(),
        workspace_id: path.basename(workspaceDir),
        step,
        duration_ms: durationMs,
        elapsed_ms: now - startedAt,
        ...context,
        ...extra,
      };
      const detail = [
        extra.size_bytes != null ? `size=${extra.size_bytes}B` : null,
        extra.file_count != null ? `files=${extra.file_count}` : null,
        extra.status != null ? `status=${extra.status}` : null,
      ].filter(Boolean).join(" ");
      console.log(
        `[cloud-restore] ${entry.workspace_id} ${step}: ${entry.duration_ms}ms (cum ${entry.elapsed_ms}ms)${detail ? ` ${detail}` : ""}`,
      );
      void record(entry);
      return now;
    },
  };
}

async function withWorkspaceDiagnosticBundleQueue(workspaceDir, operation) {
  const previous = workspaceDiagnosticBundleQueues.get(workspaceDir) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  workspaceDiagnosticBundleQueues.set(workspaceDir, current);
  try {
    return await current;
  } finally {
    if (workspaceDiagnosticBundleQueues.get(workspaceDir) === current) {
      workspaceDiagnosticBundleQueues.delete(workspaceDir);
    }
  }
}

function formatRpcId(id) {
  if (id === null) {
    return "null";
  }

  if (id === undefined) {
    return "undefined";
  }

  return String(id);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function truncateForLog(value, maxLength = 160) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function parseJsonArrayArgument(value) {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeDiscoveryInput(args = {}) {
  const input = {};

  if (args.include_builtin !== undefined) {
    input.include_builtin = Boolean(args.include_builtin);
  }

  if (args.local_roots !== undefined) {
    const localRoots = parseJsonArrayArgument(args.local_roots);
    if (!Array.isArray(localRoots) || localRoots.some((item) => typeof item !== "string")) {
      throw new Error('"local_roots" must be an array of strings');
    }
    localRoots.forEach((item, index) => {
      assertAbsolutePath(item, `local_roots[${index}]`);
    });
    input.local_roots = localRoots;
  }

  if (args.cwd !== undefined) {
    if (typeof args.cwd !== "string" || args.cwd.length === 0) {
      throw new Error('"cwd" must be a non-empty string when provided');
    }
    assertAbsolutePath(args.cwd, "cwd");
    input.cwd = args.cwd;
  }

  return input;
}

function assertAbsolutePath(value, parameterName) {
  if (!path.isAbsolute(value)) {
    throw new Error(`"${parameterName}" must be an absolute path`);
  }
}

function readRequiredAbsolutePathArg(args, parameterName) {
  const value = args?.[parameterName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required parameter: "${parameterName}"`);
  }

  assertAbsolutePath(value, parameterName);
  return path.normalize(value);
}

function readOptionalAbsolutePathArg(args, parameterName) {
  const value = args?.[parameterName];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`"${parameterName}" must be a non-empty string when provided`);
  }

  assertAbsolutePath(value, parameterName);
  return path.normalize(value);
}

function readOptionalStringArg(args, parameterName) {
  const value = args?.[parameterName];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`"${parameterName}" must be a non-empty string when provided`);
  }
  return value;
}

function readRequiredStringArg(args, parameterName) {
  const value = args?.[parameterName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required parameter: "${parameterName}"`);
  }
  return value;
}

const UPLOADED_SOURCE_STAGING_DIR = path.join(
  os.tmpdir(),
  "presenton-template-engine-executa",
  "uploaded-source-staging",
);
const STYLE_PROFILE_REFERENCE_STAGING_DIR = path.join(
  os.tmpdir(),
  "presenton-template-engine-executa",
  "style-profile-reference-staging",
);
const STYLE_GUIDE_STAGING_DIR = path.join(
  os.tmpdir(),
  "presenton-template-engine-executa",
  "style-guide-staging",
);
const MANUAL_PAGE_STAGING_DIR = path.join(
  os.tmpdir(),
  "presenton-template-engine-executa",
  "manual-page-staging",
);
const MANAGED_FONT_STAGING_DIR = path.join(
  os.tmpdir(),
  "presenton-template-engine-executa",
  "managed-font-staging",
);
function assertSafeUploadFilename(filename) {
  if (typeof filename !== "string" || filename.trim().length === 0) {
    throw new Error('"filename" must be a non-empty string');
  }
  const trimmed = filename.trim();
  if (trimmed.includes("/") || trimmed.includes("\\") || path.basename(trimmed) !== trimmed) {
    throw new Error('"filename" must not contain path separators');
  }
  return trimmed;
}

function buildAttachmentContentDisposition(filename) {
  assertSafeUploadFilename(filename);
  const baseName = path.basename(filename);
  const fallback = baseName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(baseName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function readHostUploadRefArg(args, parameterName = "host_upload") {
  const value = args?.[parameterName];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`"${parameterName}" must be a HostUploadRef object`);
  }
  if (value.transport !== "host_upload") {
    throw new Error(`"${parameterName}.transport" must be "host_upload"`);
  }
  if (typeof value.r2_key !== "string" || value.r2_key.trim().length === 0) {
    throw new Error(`"${parameterName}.r2_key" must be a non-empty string`);
  }
  if (typeof value.url !== "string" || value.url.trim().length === 0) {
    throw new Error(`"${parameterName}.url" must be a non-empty string`);
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(value.url);
  } catch {
    throw new Error(`"${parameterName}.url" must be a valid URL`);
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`"${parameterName}.url" must use HTTPS`);
  }
  if (typeof value.mime_type !== "string" || value.mime_type.trim().length === 0) {
    throw new Error(`"${parameterName}.mime_type" must be a non-empty string`);
  }
  const sizeBytes = Number(value.size_bytes);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`"${parameterName}.size_bytes" must be a positive number`);
  }
  return {
    transport: "host_upload",
    r2_key: value.r2_key,
    url: value.url,
    mime_type: value.mime_type,
    size_bytes: Math.floor(sizeBytes),
    filename: typeof value.filename === "string" ? value.filename : undefined,
    expires_at: typeof value.expires_at === "string" ? value.expires_at : undefined,
    expires_in: typeof value.expires_in === "number" ? value.expires_in : undefined,
    mode: "negotiate+confirm",
  };
}

async function downloadHostUploadToStaging({ hostUpload, stagingPath, expectedSizeBytes }) {
  const response = await fetch(hostUpload.url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Host Upload download failed: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Host Upload download returned an empty response body.");
  }

  await mkdir(path.dirname(stagingPath), { recursive: true });
  const handle = await open(stagingPath, "w");
  let receivedBytes = 0;
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.byteLength;
      if (receivedBytes > expectedSizeBytes) {
        throw new Error(
          `Host Upload size mismatch: expected ${expectedSizeBytes} bytes, got more than ${expectedSizeBytes} bytes.`,
        );
      }
      await handle.write(buffer);
    }
  } finally {
    await handle.close();
  }

  if (receivedBytes !== expectedSizeBytes || receivedBytes !== hostUpload.size_bytes) {
    throw new Error(
      `Host Upload size mismatch: expected ${expectedSizeBytes} bytes, got ${receivedBytes} bytes.`,
    );
  }
  return receivedBytes;
}

async function uploadLocalFileToHost({
  filePath,
  filename,
  mimeType,
  purpose,
  workspaceDir,
  templateId,
  diagnosticContext,
  operationId,
  source,
  reuseWhileValid,
  snapshotBeforeNegotiate = false,
}) {
  const normalizedPath = path.normalize(filePath);
  const fileStat = await stat(normalizedPath);
  if (!fileStat.isFile()) {
    throw new Error(`Host Upload source path is not a file: ${normalizedPath}`);
  }
  const cacheKey = reuseWhileValid
    ? hostUploadCacheKey({
        filePath: normalizedPath,
        sizeBytes: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        mimeType,
        purpose: purpose || "user_artifact",
      })
    : null;
  if (cacheKey) {
    // Not a transfer, so it stays out of the storage transfer log by design.
    const cached = readCachedHostUpload(hostUploadCache, cacheKey);
    if (cached) return cached;
  }
  const sizeBytes = fileStat.size;
  // Preview artifacts can move from the Shadow Workspace to the official
  // Workspace while Host Upload negotiation is in flight. Capture their bytes
  // before that async boundary so the PUT does not reopen a stale local path.
  const fileSnapshot = snapshotBeforeNegotiate ? await readFile(normalizedPath) : null;
  if (fileSnapshot && fileSnapshot.byteLength !== sizeBytes) {
    throw new Error(
      `Host Upload source changed while reading ${normalizedPath}: ` +
      `expected ${sizeBytes} bytes, got ${fileSnapshot.byteLength} bytes.`,
    );
  }
  const safeFilename = assertSafeUploadFilename(filename || path.basename(normalizedPath));
  if (typeof mimeType !== "string" || mimeType.trim().length === 0 || mimeType === "application/octet-stream") {
    throw new Error(`Host Upload MIME type must be specific for ${safeFilename}`);
  }
  let currentAttemptLogger;
  const result = await runWithStorageRetry(async ({ attempt, maxAttempts }) => {
    const logger = createStorageTransferLogger({
      workspaceDir,
      templateId,
      diagnosticContext,
      operationId,
      source,
      filename: safeFilename,
      mimeType: mimeType.trim(),
      sizeBytes,
    });
    currentAttemptLogger = logger;
    let currentPhase = "started";
    logger.log("started", "started", {
      purpose: purpose || "user_artifact",
      attempt,
      max_attempts: maxAttempts,
    });
    try {
      currentPhase = "negotiate";
      const negotiated = await hostUploadClient.negotiate({
        filename: safeFilename,
        mimeType: mimeType.trim(),
        sizeBytes,
        purpose: purpose || "user_artifact",
      });
      if (!negotiated || typeof negotiated.put_url !== "string" || typeof negotiated.r2_key !== "string") {
        throw new Error("host/uploadFile negotiate returned an invalid response");
      }
      logger.log("negotiate", "succeeded", { r2_key: negotiated.r2_key, response: redactStorageResponse(negotiated) });
      currentPhase = "put";
      const putResponse = await fetch(negotiated.put_url, {
        method: "PUT",
        headers: {
          ...(negotiated.headers ?? {}),
          "Content-Length": String(sizeBytes),
        },
        body: fileSnapshot ?? createReadStream(normalizedPath),
        duplex: "half",
      });
      await assertStorageResponseOk(putResponse, "Host Upload PUT failed");
      logger.log("put", "succeeded", { http_status: putResponse.status });
      currentPhase = "confirm";
      const confirmed = await hostUploadClient.confirm(negotiated.r2_key);
      logger.log("confirm", "succeeded", { r2_key: negotiated.r2_key, response: redactStorageResponse(confirmed) });
      const confirmedResult = parseHostUploadConfirmation({
        confirmed,
        negotiated,
        mimeType: mimeType.trim(),
        fallbackSizeBytes: sizeBytes,
        filename: safeFilename,
      });
      logger.log("finished", "succeeded", { r2_key: confirmedResult.r2_key, expires_at: confirmedResult.expires_at });
      if (cacheKey) {
        storeHostUpload(hostUploadCache, cacheKey, confirmedResult);
      }
      return confirmedResult;
    } catch (error) {
      const decision = classifyHostUploadAware(error);
      logger.log(currentPhase, "failed", {
        error: storageErrorRecord(error),
        attempt,
        max_attempts: maxAttempts,
        retryable: decision.retryable && attempt < maxAttempts,
        retry_reason: decision.reason,
        retry_exhausted: decision.retryable && attempt >= maxAttempts,
      });
      throw error;
    }
  }, {
    classify: classifyHostUploadAware,
    onRetry: ({ attempt, nextAttempt, maxAttempts, delayMs, reason }) => {
      currentAttemptLogger?.log("retry", "scheduled", {
        attempt,
        next_attempt: nextAttempt,
        max_attempts: maxAttempts,
        delay_ms: delayMs,
        retry_reason: reason,
      });
    },
  });
  return result;
}

async function uploadBufferToHost({ buffer, filename, mimeType, purpose, workspaceDir, operationId, source }) {  const safeFilename = assertSafeUploadFilename(filename);
  if (!Buffer.isBuffer(buffer) || buffer.byteLength <= 0) {
    throw new Error(`Host Upload buffer must not be empty for ${safeFilename}`);
  }
  if (typeof mimeType !== "string" || mimeType.trim().length === 0 || mimeType === "application/octet-stream") {
    throw new Error(`Host Upload MIME type must be specific for ${safeFilename}`);
  }
  let currentAttemptLogger;
  return runWithStorageRetry(async ({ attempt, maxAttempts }) => {
    const logger = createStorageTransferLogger({
      workspaceDir,
      operationId,
      source,
      filename: safeFilename,
      mimeType: mimeType.trim(),
      sizeBytes: buffer.byteLength,
    });
    currentAttemptLogger = logger;
    let currentPhase = "started";
    logger.log("started", "started", {
      purpose: purpose || "user_artifact",
      attempt,
      max_attempts: maxAttempts,
    });
    try {
      currentPhase = "negotiate";
      const negotiated = await hostUploadClient.negotiate({
        filename: safeFilename,
        mimeType: mimeType.trim(),
        sizeBytes: buffer.byteLength,
        purpose: purpose || "user_artifact",
      });
      if (!negotiated || typeof negotiated.put_url !== "string" || typeof negotiated.r2_key !== "string") {
        throw new Error("host/uploadFile negotiate returned an invalid response");
      }
      logger.log("negotiate", "succeeded", { r2_key: negotiated.r2_key, response: redactStorageResponse(negotiated) });
      currentPhase = "put";
      const putResponse = await fetch(negotiated.put_url, {
        method: "PUT",
        headers: {
          ...(negotiated.headers ?? {}),
          "Content-Length": String(buffer.byteLength),
        },
        body: buffer,
      });
      await assertStorageResponseOk(putResponse, "Host Upload PUT failed");
      logger.log("put", "succeeded", { http_status: putResponse.status });
      currentPhase = "confirm";
      const confirmed = await hostUploadClient.confirm(negotiated.r2_key);
      logger.log("confirm", "succeeded", { r2_key: negotiated.r2_key, response: redactStorageResponse(confirmed) });
      const result = parseHostUploadConfirmation({
        confirmed,
        negotiated,
        mimeType: mimeType.trim(),
        fallbackSizeBytes: buffer.byteLength,
        filename: safeFilename,
      });
      logger.log("finished", "succeeded", { r2_key: result.r2_key, expires_at: result.expires_at });
      return result;
    } catch (error) {
      const decision = classifyHostUploadAware(error);
      logger.log(currentPhase, "failed", {
        error: storageErrorRecord(error),
        attempt,
        max_attempts: maxAttempts,
        retryable: decision.retryable && attempt < maxAttempts,
        retry_reason: decision.reason,
        retry_exhausted: decision.retryable && attempt >= maxAttempts,
      });
      throw error;
    }
  }, {
    classify: classifyHostUploadAware,
    onRetry: ({ attempt, nextAttempt, maxAttempts, delayMs, reason }) => {
      currentAttemptLogger?.log("retry", "scheduled", {
        attempt,
        next_attempt: nextAttempt,
        max_attempts: maxAttempts,
        delay_ms: delayMs,
        retry_reason: reason,
      });
    },
  });
}

const PREVIEW_IMAGE_MIME_TYPES = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

async function uploadPreviewImage(imagePath, context = {}) {
  const extension = path.extname(imagePath).toLowerCase();
  const mimeType = PREVIEW_IMAGE_MIME_TYPES[extension];
  if (!mimeType) {
    throw new Error(`Host Upload preview image type is not supported: ${imagePath}`);
  }
  return uploadLocalFileToHost({
    filePath: imagePath,
    filename: `${path.basename(imagePath, extension) || "slide"}${extension}`,
    mimeType,
    // Rendered previews are immutable for a given mtime, so repeat views can
    // reuse the confirmed reference instead of re-uploading the same bytes.
    reuseWhileValid: true,
    ...context,
    purpose: "user_artifact",
    snapshotBeforeNegotiate: true,
  });
}

function parseRequestLine(line) {
  try {
    return {
      request: JSON.parse(line),
      parseErrorResponse: null,
    };
  } catch {
    return {
      request: null,
      parseErrorResponse: makeResponse(null, undefined, {
        code: -32700,
        message: "Parse error",
      }),
    };
  }
}

function summarizeIncomingRequest(request, rawLine) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return `← invalid-json raw=${truncateForLog(rawLine)}`;
  }

  const id = formatRpcId(request.id);
  const method = isNonEmptyString(request.method) ? request.method : "<missing>";

  if (method !== "invoke") {
    return `← method=${method} id=${id}`;
  }

  const tool = isNonEmptyString(request.params?.tool) ? request.params.tool : "<missing>";
  return `← method=invoke id=${id} tool=${tool}`;
}

function summarizeResponse(request, response) {
  const id = formatRpcId(response?.id);

  if (response?.error) {
    return `id=${id} error_code=${response.error.code} error_message=${JSON.stringify(response.error.message)}`;
  }

  if (request?.method === "invoke") {
    const tool = isNonEmptyString(request.params?.tool) ? request.params.tool : "<missing>";
    return `id=${id} tool=${tool} status=success`;
  }

  return `id=${id} status=success`;
}

function shouldUseFileTransport(request) {
  return request?.method === "invoke" && Object.hasOwn(ASYNC_TOOL_DISPATCH, request.params?.tool);
}

async function resolveTransportDirectories(request) {
  const candidates = [];
  const requestedCwd = request?.params?.arguments?.cwd;

  if (isNonEmptyString(requestedCwd)) {
    try {
      assertAbsolutePath(requestedCwd, "cwd");
      const cwdStat = await stat(requestedCwd);
      if (cwdStat.isDirectory()) {
        candidates.push(path.join(path.normalize(requestedCwd), FILE_TRANSPORT_DIRNAME));
      }
    } catch {
      // Ignore invalid or inaccessible cwd and fall back to the plugin temp directory.
    }
  }

  candidates.push(FILE_TRANSPORT_FALLBACK_DIR);
  return [...new Set(candidates)];
}

// Serialize ALL stdout writes: concurrent invokes each awaited their own
// writeStdoutLine, and overlapping process.stdout.write calls interleave at
// the byte level, corrupting JSON-RPC frames - the host then kills the plugin
// ('executa process exited'). A single promise chain makes every frame
// atomic end-to-end. Keep the chain alive across failures so one bad write
// cannot wedge all subsequent responses.
let stdoutWriteChain = Promise.resolve();
async function writeStdoutLine(payload) {
  const result = stdoutWriteChain.then(() => new Promise((resolve, reject) => {
    process.stdout.write(`${payload}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  }));
  stdoutWriteChain = result.then(() => undefined, () => undefined);
  return result;
}

function buildTransportFileName() {
  return `executa-resp-${Date.now()}-${process.pid}-${randomUUID()}.json`;
}

async function writeResponseToTransportFile(serializedResponse, transportDir) {
  await mkdir(transportDir, { recursive: true });
  const transportPath = path.join(transportDir, buildTransportFileName());
  await writeFile(transportPath, serializedResponse, "utf8");
  return transportPath;
}

async function emitResponse(request, response) {
  // Successful frames already fit; also bound errors raised by the transport itself.
  if (request?.method === "invoke" && !shouldUseFileTransport(request)
    && jsonBytes(response).length > INVOKE_INLINE_BYTES) {
    response = makeResponse(response.id ?? request.id, undefined, {
      code: -32603, message: "Invoke transport response exceeds 3 MiB",
    });
  }
  const serializedResponse = JSON.stringify(response);
  const responseBytes = Buffer.byteLength(serializedResponse, "utf8");

  if (!shouldUseFileTransport(request)) {
    await writeStdoutLine(serializedResponse);
    process.stderr.write(`→ stdout ${summarizeResponse(request, response)} bytes=${responseBytes}\n`);
    return;
  }

  try {
    const transportDirectories = await resolveTransportDirectories(request);
    let lastError = null;

    for (const transportDir of transportDirectories) {
      try {
        const transportPath = await writeResponseToTransportFile(serializedResponse, transportDir);
        const pointer = JSON.stringify({
          jsonrpc: "2.0",
          id: response.id ?? null,
          __trans_file__: transportPath,
          __file_transport: transportPath,
        });
        await writeStdoutLine(pointer);
        process.stderr.write(
          `→ file_transport ${summarizeResponse(request, response)} bytes=${responseBytes} path=${transportPath}\n`,
        );
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("No writable transport directory available");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown file transport error";
    const fallbackResponse = responseBytes <= MAX_STDOUT_RESPONSE_BYTES
      ? response
      : makeResponse(response.id ?? null, undefined, {
        code: -32603,
        message: `Failed to write file transport response: ${message}`,
      });
    const fallbackSerialized = JSON.stringify(fallbackResponse);
    const fallbackBytes = Buffer.byteLength(fallbackSerialized, "utf8");

    await writeStdoutLine(fallbackSerialized);
    process.stderr.write(
      `→ stdout_fallback ${summarizeResponse(request, fallbackResponse)} bytes=${fallbackBytes} transport_error=${JSON.stringify(message)}\n`,
    );
  }
}

async function toolListDiscoveredTemplateGroupSummaries(args) {
  const input = normalizeDiscoveryInput(args);
  const groups = await listDiscoveredTemplateGroupSummaries(input);
  return {
    groups,
    count: groups.length,
  };
}

async function toolAppListWorkspaces(args = {}) {
  return listAppWorkspacesPage({
    limit: args?.limit,
    cursor: args?.cursor,
  });
}

async function toolAppGetWorkspaceDefaults() {
  return getAppWorkspaceDefaults();
}

async function toolAppPatchWorkspaceDefaults(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  if (!args.setting || typeof args.setting !== "object" || Array.isArray(args.setting)) {
    throw new Error('"setting" must be an object');
  }
  return patchAppWorkspaceDefaults({ setting: args.setting });
}

async function toolAppCreateWorkspace(args) {
  if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args))) {
    throw new Error("Arguments must be an object");
  }

  const title =
    typeof args?.title === "string" && args.title.trim().length > 0
      ? args.title.trim()
      : undefined;

  return createAppWorkspace({ title });
}

async function toolAppOpenWorkspace(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return await openAppWorkspace({ workspace_dir: workspaceDir });
}

async function toolAppInstallWorkspaceAuthoringKit(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return installWorkspaceAuthoringKit({ workspace_dir: workspaceDir });
}

async function toolAppEnsureConfirmedOutlinePageIds(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return ensureConfirmedOutlinePageIds({ workspace_dir: workspaceDir });
}

async function toolAppPrepareWorkspacePageSources(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return prepareWorkspacePageSources({
    workspace_dir: workspaceDir,
    reset_existing: args?.reset_existing === true,
  });
}

async function toolAppReconcileWorkspacePageSources(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return reconcileWorkspacePageSources({ workspace_dir: workspaceDir });
}

async function withStagedAppText(args, extension, callback, maxBytes = 64 * 1024 * 1024) {
  if (typeof args.content !== "string") throw new Error("Content must be a string");
  const sizeBytes = Buffer.byteLength(args.content, "utf8");
  if (sizeBytes < 1 || sizeBytes > maxBytes) throw new Error("Content exceeds its size limit");
  const stagingPath = path.join(STYLE_GUIDE_STAGING_DIR, `${randomUUID()}.${extension}`);
  try {
    await mkdir(STYLE_GUIDE_STAGING_DIR, { recursive: true });
    await writeFile(stagingPath, args.content, "utf8");
    return await callback(stagingPath, sizeBytes);
  } finally { await unlink(stagingPath).catch(() => undefined); }
}

async function toolAppCommitWorkspaceStyleGuide(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return withStagedAppText(args, "md", (stagingPath, sizeBytes) => recordAppWorkspaceStyleGuide({
    workspace_dir: workspaceDir, staging_file_path: stagingPath, expected_size_bytes: sizeBytes,
  }));
}

async function commitHtmlContent(args, kind, record) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return withStagedAppText(args, "html", (stagingPath, sizeBytes) => record({
    workspace_dir: workspaceDir, page_id: args.page_id, staging_file_path: stagingPath, expected_size_bytes: sizeBytes,
  }), kind === "Page alternative HTML" ? 16 * 1024 * 1024 : 64 * 1024 * 1024);
}

async function toolAppCommitWorkspaceVisualMasterHtml(args) {
  return commitHtmlContent(args, "Visual Master HTML", recordAppWorkspaceVisualMasterHtml);
}

async function toolAppGetWorkspaceVisualMasterHtml(args) {
  return getAppWorkspaceVisualMasterHtml({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") });
}

async function toolAppPageRegeneration(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const input = { ...args, workspace_dir: workspaceDir };
  let batch;
  switch (args.action) {
    case "create": batch = await createAppPageRegeneration(input); break;
    case "get": batch = await getAppPageRegeneration(input); break;
    case "fail": batch = await failAppPageRegenerationCandidate(input); break;
    case "adopt": batch = await adoptAppPageRegeneration(input); break;
    case "submit":
      batch = await commitHtmlContent(args, "Page alternative HTML", (staged) => submitAppPageRegenerationCandidate({ ...input, ...staged }));
      break;
    default: throw new Error("Unknown page regeneration action");
  }
  if (!batch) return null;
  let sourceContext = {};
  if (args.action === "create" && batch.mode === "beautify") {
    try {
      sourceContext = {
        ...({ source_html: await readFile(batch.source_html_path, "utf8") }),
        source_screenshot_upload: await withTransientPageScreenshot(workspaceDir, batch.source_snapshot_html_path, (file) => uploadPreviewImage(file, {
          workspaceDir, source: "ppt-engine.page-beautification-screenshot",
        })),
      };
    } catch (error) {
      for (const candidate of batch.candidates) await failAppPageRegenerationCandidate({
        workspace_dir: workspaceDir, batch_id: batch.id, candidate_id: candidate.id, error: String(error),
      });
      throw error;
    }
  }
  return { ...batch, ...sourceContext, candidates: batch.candidates.map((candidate) => ({
    ...candidate, preview_fingerprint: candidate.html_sha256,
  })) };
}

async function toolAppCommitWorkspacePageHtml(args) {
  if (typeof args?.page_id !== "string" || !args.page_id.trim()) throw new Error('"page_id" must be a non-empty string');
  return commitHtmlContent(args, "Page HTML", recordAppWorkspacePageHtml);
}

async function toolAppListWorkspaceTemplateReferences(args) {
  return listAppWorkspaceTemplateReferences({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") });
}

async function toolAppGetWorkspaceTemplateReferenceHtml(args) {
  if (typeof args?.path !== "string" || !args.path.trim()) throw new Error('"path" must be a non-empty string');
  return getAppWorkspaceTemplateReferenceHtml({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    path: args.path.trim(),
  });
}

async function toolAppGetWorkspaceAestheticReferenceSelections(args) {
  return getAppWorkspaceAestheticReferenceSelections({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") });
}

async function toolAppRecordWorkspaceAestheticReferenceSelection(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return recordAppWorkspaceAestheticReferenceSelection({
    workspace_dir: workspaceDir,
    target: args?.target,
    page_id: args?.page_id,
    path: args?.path,
  });
}

async function commitMarkdownContent(args, record) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return withStagedAppText(args, "md", (stagingPath, sizeBytes) => record({
    workspace_dir: workspaceDir, page_id: args.page_id, staging_file_path: stagingPath, expected_size_bytes: sizeBytes,
  }));
}

async function toolAppCommitVisualRhythm(args) { return commitMarkdownContent(args, recordAppVisualRhythm); }
async function toolAppGetVisualRhythmStatus(args) { return getAppVisualRhythmStatus({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") }); }
async function toolAppGetVisualRhythm(args) { return getAppVisualRhythm({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") }); }
async function toolAppCommitPageVisualPlan(args) {
  if (typeof args?.page_id !== "string" || args.page_id.trim().length === 0) throw new Error('"page_id" must be a non-empty string');
  return commitMarkdownContent(args, recordAppPageVisualPlan);
}
async function toolAppGetPageVisualPlanStatus(args) { return getAppPageVisualPlanStatus({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"), page_id: args.page_id }); }
async function toolAppGetPageVisualPlan(args) { return getAppPageVisualPlan({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"), page_id: args.page_id }); }

async function toolAppGetWorkspaceStyleGuideStatus(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return getAppWorkspaceStyleGuideStatus({ workspace_dir: workspaceDir });
}

async function toolAppGetWorkspaceStyleGuide(args) {
  return getAppWorkspaceStyleGuide({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") });
}

async function toolAppEnsureWorkspacePersistentElementsReference(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return ensureAppWorkspacePersistentElementsReference({
    workspace_dir: workspaceDir,
    reset_existing: args?.reset_existing === true,
  });
}

async function toolAppGetWorkspacePersistentElementsStatus(args) {
  return getAppWorkspacePersistentElementsStatus({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") });
}

async function toolAppTypecheckWorkspacePersistentElements(args) {
  return typecheckAppWorkspacePersistentElements({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") });
}

async function toolAppPreparePageRefinement(args) {
  return prepareAppPageRefinement({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    page_id: readRequiredStringArg(args, "page_id"),
    refinement_request: readRequiredStringArg(args, "refinement_request"),
  });
}

async function toolAppCommitDeckRefinement(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const input = {
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    refinement_request: readRequiredStringArg(args, "refinement_request"),
    title: readRequiredStringArg(args, "title"),
    output_language_change: args.output_language_change ?? { changed: false },
    style_guide_action: readRequiredStringArg(args, "style_guide_action"),
    operations: Array.isArray(args.operations) ? args.operations : [],
  };
  if (input.style_guide_action === "regenerate") {
    return withStagedAppText({ content: args.style_guide_content }, "md", (stagingPath, sizeBytes) => commitAppDeckRefinement({
      ...input, style_guide_staging_file_path: stagingPath, style_guide_expected_size_bytes: sizeBytes,
    }));
  }
  return commitAppDeckRefinement(input);
}

async function toolAppInitializePageProgress(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return initializeAppPageProgress({ workspace_dir: workspaceDir });
}

async function toolAppRebuildWorkspaceDeckManifest(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return rebuildWorkspaceDeckManifest({ workspace_dir: workspaceDir });
}

async function toolAppGetWorkspacePageSourceFingerprint(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  if (typeof args?.page_id !== "string" || args.page_id.length === 0) {
    throw new Error('Missing required parameter: "page_id"');
  }
  return fingerprintWorkspacePageSource({
    workspace_dir: workspaceDir,
    page_id: args.page_id,
  });
}

async function toolAppPageImageUpload(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const action = readRequiredStringArg(args, "action");
  if (action === "list_pending") return appPageImageUpload({ workspace_dir: workspaceDir, action });
  if (action === "describe") return appPageImageUpload({ workspace_dir: workspaceDir, action,
    asset_id: readRequiredStringArg(args, "asset_id"), description: readRequiredStringArg(args, "description") });
  if (action === "prepare") {
    const result = await appPageImageUpload({ workspace_dir: workspaceDir, action, asset_id: readRequiredStringArg(args, "asset_id") });
    const image = result.images[0];
    const hostUpload = await uploadLocalFileToHost({ filePath: image.file_path, filename: image.source_filename,
      mimeType: image.mime_type, purpose: "image_input", workspaceDir, operationId: image.asset_id,
      source: "ppt-engine.page-image-upload", reuseWhileValid: true });
    return { ...result, host_upload: hostUpload };
  }
  if (action !== "commit") throw new Error("Invalid page image upload action");
  const filename = assertSafeUploadFilename(args.filename);
  const hostUpload = readHostUploadRefArg(args, "host_upload");
  const sizeBytes = Number(args.size_bytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > 25 * 1024 * 1024) throw new Error("PAGE_IMAGE_FILE_TOO_LARGE");
  if (sizeBytes !== hostUpload.size_bytes || (hostUpload.filename && filename !== hostUpload.filename)) throw new Error("PAGE_IMAGE_INVALID_FILE");
  const stagingPath = path.join(UPLOADED_SOURCE_STAGING_DIR, `${randomUUID()}.upload`);
  try {
    await downloadHostUploadToStaging({ hostUpload, stagingPath, expectedSizeBytes: sizeBytes });
    return await appPageImageUpload({ workspace_dir: workspaceDir, action, filename,
      staging_file_path: stagingPath, expected_size_bytes: sizeBytes });
  } finally { await unlink(stagingPath).catch(() => undefined); }
}

async function toolAppOutlineImageDescriptions(args) {
  return appOutlineImageDescriptions({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    action: readRequiredStringArg(args, "action"),
    run_key: args.run_key, sha256s: args.sha256s,
    asset_id: args.asset_id, description: args.description,
  });
}

async function toolAppCommitUploadedSourceHostUpload(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const filename = assertSafeUploadFilename(args.filename);
  const hostUpload = readHostUploadRefArg(args, "host_upload");
  const sizeBytes = Number(args.size_bytes);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error('"size_bytes" must be a positive number');
  }
  if (Math.floor(sizeBytes) !== hostUpload.size_bytes) {
    throw new Error(`Host Upload size mismatch: input size_bytes=${Math.floor(sizeBytes)} host_upload.size_bytes=${hostUpload.size_bytes}`);
  }
  const mimeType = typeof args.mime_type === "string" && args.mime_type.trim().length > 0
    ? args.mime_type.trim()
    : hostUpload.mime_type;
  if (mimeType !== hostUpload.mime_type) {
    throw new Error("Host Upload MIME type mismatch.");
  }
  if (filename !== (hostUpload.filename || filename)) {
    throw new Error("Host Upload filename mismatch.");
  }

  const uploadId = randomUUID();
  const stagingPath = path.join(UPLOADED_SOURCE_STAGING_DIR, `${uploadId}.upload`);
  try {
    await downloadHostUploadToStaging({
      hostUpload,
      stagingPath,
      expectedSizeBytes: Math.floor(sizeBytes),
    });
    const result = await commitAppUploadedSourceUpload({
      workspace_dir: workspaceDir,
      upload_id: uploadId,
      filename,
      mime_type: mimeType,
      staging_file_path: stagingPath,
      expected_size_bytes: Math.floor(sizeBytes),
    });
    return {
      ...result,
      host_upload: hostUpload,
    };
  } finally {
    await unlink(stagingPath).catch(() => undefined);
  }
}

// 页面原图按有效素材标识解析，不接受调用方提供的文件路径。
async function toolAppUploadOutlineImageForAgent(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const assetId = readRequiredStringArg(args, "asset_id");
  const operationId = readRequiredStringArg(args, "operation_id");
  const asset = await resolveAppOutlineImage({ workspace_dir: workspaceDir, asset_id: assetId });
  const hostUpload = await uploadLocalFileToHost({
    filePath: asset.file_path,
    filename: `page-image${path.extname(asset.file_path).toLowerCase()}`,
    mimeType: asset.mime_type,
    purpose: "image_input",
    workspaceDir,
    operationId,
    source: "ppt-engine.page-image-agent-attachment",
    reuseWhileValid: true,
  });
  return { host_upload: hostUpload };
}

// Upload an already-committed uploaded source file to Host storage so it can be
// consumed by an analysis agent (purpose "image_input").
// The file path is resolved from the workspace's uploaded-source index by
// uploaded_source_id, never taken from the caller, so a prompt cannot point this
// at an arbitrary local path. Reuses the shared uploadLocalFileToHost base.
async function toolAppUploadUploadedSourceForAgent(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const uploadedSourceId = readRequiredStringArg(args, "uploaded_source_id");
  const operationId = readRequiredStringArg(args, "operation_id");

  const listed = await listAppUploadedSources({
    workspace_dir: workspaceDir,
    include_removed: false,
  });
  const material = listed.active.find(
    (item) => item.uploaded_source_id === uploadedSourceId,
  );
  if (!material) {
    throw new Error(`Active Uploaded Source Material not found: ${uploadedSourceId}`);
  }
  if (typeof material.file_path !== "string" || material.file_path.length === 0) {
    throw new Error(`Uploaded Source Material has no file path: ${uploadedSourceId}`);
  }

  // The Workspace retains original_filename/display_name. The transport name is
  // deliberately ASCII-only: the local Windows bridge may encode upload
  // confirmations with GBK, which cannot represent every user file name.
  const transportExtension = path.extname(material.file_path).toLowerCase();
  const hostUpload = await uploadLocalFileToHost({
    filePath: material.file_path,
    filename: `uploaded-source-${uploadedSourceId}${transportExtension}`,
    mimeType: material.mime_type,
    purpose: "image_input",
    workspaceDir,
    operationId,
    source: "ppt-engine.uploaded-source-agent-attachment",
    reuseWhileValid: true,
  });
  return {
    workspace_dir: workspaceDir,
    uploaded_source_id: uploadedSourceId,
    host_upload: hostUpload,
  };
}

async function toolAppListStyleProfiles() {
  return listAppStyleProfiles();
}

async function toolAppUserTemplateAsset(args) {
  if (!["source", "reference", "preview", "profile_asset"].includes(args.asset)) {
    throw new Error('"asset" must be source, reference, preview or profile_asset; other assets use ordinary business results');
  }
  const asset = await getUserTemplateAsset(args.id, args.asset, args.page_number, args.filename);
  return uploadLocalFileToHost({ filePath: asset.file_path, filename: asset.filename, mimeType: asset.mime_type, purpose: asset.mime_type === "image/png" ? "image_reference" : "user_artifact", templateId: args.id, diagnosticContext: args.diagnostic_context, reuseWhileValid: true });
}

async function toolAppListUserTemplates() {
  // Metadata only: listing must stay a pure disk read so it can never fail on
  // the network. Previews used to be bulk-uploaded to the host here (one
  // upload per ready page, all-or-nothing), which killed the whole list
  // whenever a single upload hit a network blip. The frontend now fetches each
  // cover lazily via app_get_user_template_asset.
  // The design profile is stripped too: it is only needed inside the editor
  // and preview dialogs, which fetch the full record via app_get_user_template.
  // A 17-template list with full profiles was ~69KB - on a slow network that
  // response outlives the host's 90s invoke policy and the connection gets
  // killed mid-transfer ("executa process exited").
  const templates = await listUserTemplates();
  return { templates: templates.map((template) => ({ ...template, preview_images: [], profile: null })) };
}

async function toolAppGetUserTemplateHtml(args) {
  return getUserTemplateHtmls(args.id, args.page_number);
}

async function toolAppCreateUserTemplate(args) {
  const record = await createUserTemplateDraft({ filename: assertSafeUploadFilename(args.filename) });
  await appendUserTemplateLog({ id: record.id, channel: "user-template", entry: {
    event: "template.created", ...args.diagnostic_context, filename: args.filename,
  } }).catch(() => undefined);
  return record;
}

async function toolAppSaveUserTemplateSource(args) {
  const upload = readHostUploadRefArg(args, "host_upload");
  if (upload.mime_type !== "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    || upload.size_bytes <= 0 || upload.size_bytes > USER_TEMPLATE_MAX_BYTES) throw new Error("Invalid user template upload type or size");
  const stagingPath = path.join(STYLE_GUIDE_STAGING_DIR, `${randomUUID()}.upload`);
  const logger = createStorageTransferLogger({ templateId: args.id, diagnosticContext: args.diagnostic_context, source: "ppt-engine.template-source-download", filename: args.filename, sizeBytes: upload.size_bytes, transport: "host_upload_download" });
  logger.log("started", "started");
  try {
    await downloadHostUploadToStaging({ hostUpload: upload, stagingPath, expectedSizeBytes: upload.size_bytes });
    logger.log("download", "succeeded");
    const result = await saveUserTemplateSource({ id: args.id, filename: assertSafeUploadFilename(args.filename), staging_file_path: stagingPath, size_bytes: upload.size_bytes });
    logger.log("finished", "succeeded");
    return result;
  } catch (error) {
    logger.log("failed", "failed", { error: storageErrorRecord(error) });
    throw error;
  } finally { await unlink(stagingPath).catch(() => undefined); }
}

async function toolAppSaveUserTemplateProfile(args) {
  const profile = validateDesignProfile(args.profile);
  return saveUserTemplateProfile(args.id, profile);
}

async function toolAppSaveUserTemplateProfileAsset(args) {
  const upload = readHostUploadRefArg(args, "host_upload");
  if (!["image/png", "image/jpeg", "image/webp"].includes(upload.mime_type)) throw new Error("Only PNG, JPEG or WebP images are supported");
  if (upload.size_bytes <= 0 || upload.size_bytes > PROFILE_ASSET_MAX_BYTES) throw new Error(`Asset must be non-empty and at most ${PROFILE_ASSET_MAX_BYTES} bytes`);
  const stagingPath = path.join(STYLE_GUIDE_STAGING_DIR, `${randomUUID()}.upload`);
  const logger = createStorageTransferLogger({ templateId: args.id, diagnosticContext: args.diagnostic_context, source: "ppt-engine.profile-asset-download", filename: args.filename, sizeBytes: upload.size_bytes, transport: "host_upload_download" });
  logger.log("started", "started");
  try {
    await downloadHostUploadToStaging({ hostUpload: upload, stagingPath, expectedSizeBytes: upload.size_bytes });
    logger.log("download", "succeeded");
    const result = await saveUserTemplateProfileAsset({ id: args.id, filename: assertSafeUploadFilename(args.filename), staging_file_path: stagingPath, size_bytes: upload.size_bytes });
    logger.log("finished", "succeeded");
    return result;
  } catch (error) {
    logger.log("failed", "failed", { error: storageErrorRecord(error) });
    throw error;
  } finally { await unlink(stagingPath).catch(() => undefined); }
}

async function toolAppCreateImageUserTemplate(args) {
  if (!Array.isArray(args.files) || !args.files.length) throw new Error('"files" must be a non-empty array');
  const staged = [];
  try {
    for (const file of args.files) {
      if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("Each file entry must be an object");
      const filename = assertSafeUploadFilename(file.filename);
      const upload = readHostUploadRefArg(file, "host_upload");
      if (!["image/png", "image/jpeg", "image/webp"].includes(upload.mime_type)) throw new Error("Only PNG, JPEG or WebP images are supported");
      if (upload.size_bytes > USER_TEMPLATE_MAX_BYTES) throw new Error("Each image must be at most 20 MB");
      const stagingPath = path.join(STYLE_GUIDE_STAGING_DIR, `${randomUUID()}.upload`);
      await downloadHostUploadToStaging({ hostUpload: upload, stagingPath, expectedSizeBytes: upload.size_bytes });
      staged.push({ filename, staging_file_path: stagingPath, size_bytes: upload.size_bytes });
    }
    return await createImageUserTemplate({ files: staged });
  } finally {
    for (const file of staged) await unlink(file.staging_file_path).catch(() => undefined);
  }
}

const userTemplateOperation = (operation, handler) => (args) => recordUserTemplateOperation({
  id: args.id, operation, request: args,
  diagnostic_context: { operation_id: `operation-${randomUUID()}`, ...args.diagnostic_context, ...(args.page_number !== undefined ? { page_number: args.page_number } : {}) },
}, () => handler(args));

async function toolAppSaveUserTemplateHtml(args) {
  return withStagedAppText(args, "html", (stagingPath) => saveUserTemplateHtml({
    id: args.id, page_number: args.page_number, staging_file_path: stagingPath,
  }), 8 * 1024 * 1024);
}

async function readStyleProfileIdArg(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  if (typeof args.style_profile_id !== "string" || args.style_profile_id.trim().length === 0) {
    throw new Error('"style_profile_id" must be a non-empty string');
  }
  return args.style_profile_id;
}

async function uploadStyleProfileReferenceImagePreview(image) {
  const { file_path, ...publicImage } = image;
  return {
    ...publicImage,
    image_upload: await uploadLocalFileToHost({
      filePath: file_path,
      filename: image.filename,
      mimeType: image.mime_type,
      purpose: "image_reference",
    }),
  };
}

async function toolAppGetStyleProfilePreview(args) {
  const styleProfileId = await readStyleProfileIdArg(args);
  const result = await getAppStyleProfilePreview({ style_profile_id: styleProfileId });
  return {
    ...result,
    cover_image: result.cover_image
      ? await uploadStyleProfileReferenceImagePreview(result.cover_image)
      : null,
  };
}

async function toolAppGetStyleProfile(args) {
  const styleProfileId = await readStyleProfileIdArg(args);
  const result = await getAppStyleProfile({ style_profile_id: styleProfileId });
  return {
    ...result,
    reference_images: await Promise.all(
      result.reference_images.map((image) => uploadStyleProfileReferenceImagePreview(image)),
    ),
  };
}

async function toolAppPrepareStyleProfileCreation(args) {
  if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args))) {
    throw new Error("Arguments must be an object");
  }

  return prepareAppStyleProfileCreation({
    display_name: readOptionalStringArg(args ?? {}, "display_name"),
  });
}

async function toolAppCommitStyleProfileReferenceHostUpload(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  if (typeof args.creation_id !== "string" || args.creation_id.trim().length === 0) {
    throw new Error('"creation_id" must be a non-empty string');
  }
  const creationId = args.creation_id;
  const filename = assertSafeUploadFilename(args.filename);
  const hostUpload = readHostUploadRefArg(args, "host_upload");
  const sizeBytes = Number(args.size_bytes);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error('"size_bytes" must be a positive number');
  }
  if (Math.floor(sizeBytes) !== hostUpload.size_bytes) {
    throw new Error(`Host Upload size mismatch: input size_bytes=${Math.floor(sizeBytes)} host_upload.size_bytes=${hostUpload.size_bytes}`);
  }
  const mimeType = typeof args.mime_type === "string" && args.mime_type.trim().length > 0
    ? args.mime_type.trim()
    : hostUpload.mime_type;
  if (mimeType !== hostUpload.mime_type) {
    throw new Error("Host Upload MIME type mismatch.");
  }
  if (filename !== (hostUpload.filename || filename)) {
    throw new Error("Host Upload filename mismatch.");
  }

  const uploadId = randomUUID();
  const stagingPath = path.join(STYLE_PROFILE_REFERENCE_STAGING_DIR, `${uploadId}.upload`);
  try {
    await downloadHostUploadToStaging({
      hostUpload,
      stagingPath,
      expectedSizeBytes: Math.floor(sizeBytes),
    });
    const result = await commitAppStyleProfileReferenceUpload({
      creation_id: creationId,
      upload_id: uploadId,
      filename,
      mime_type: mimeType,
      staging_file_path: stagingPath,
      expected_size_bytes: Math.floor(sizeBytes),
    });
    return {
      ...result,
      host_upload: hostUpload,
    };
  } finally {
    await unlink(stagingPath).catch(() => undefined);
  }
}

async function toolAppGetStyleProfileCreationContext(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  if (typeof args.creation_id !== "string" || args.creation_id.trim().length === 0) {
    throw new Error('"creation_id" must be a non-empty string');
  }
  return getAppStyleProfileCreationContext({ creation_id: args.creation_id });
}

async function toolAppGetStyleProfileDraftFingerprint(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  if (typeof args.creation_id !== "string" || args.creation_id.trim().length === 0) {
    throw new Error('"creation_id" must be a non-empty string');
  }
  return getAppStyleProfileDraftFingerprint({ creation_id: args.creation_id });
}

async function toolAppGetStyleProfileDraft(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  if (typeof args.creation_id !== "string" || args.creation_id.trim().length === 0) {
    throw new Error('"creation_id" must be a non-empty string');
  }
  return getAppStyleProfileDraft({ creation_id: args.creation_id });
}

async function toolAppPublishStyleProfile(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  if (typeof args.creation_id !== "string" || args.creation_id.trim().length === 0) {
    throw new Error('"creation_id" must be a non-empty string');
  }
  return publishAppStyleProfile({
    creation_id: args.creation_id,
    display_name: readOptionalStringArg(args, "display_name"),
  });
}

async function toolAppSelectWorkspaceStyleProfile(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  if (typeof args.style_profile_id !== "string" || args.style_profile_id.trim().length === 0) {
    throw new Error('"style_profile_id" must be a non-empty string');
  }
  return await selectAppWorkspaceStyleProfile({
    workspace_dir: workspaceDir,
    style_profile_id: args.style_profile_id,
  });
}

async function toolAppGetWorkspaceStyleProfile(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return getAppWorkspaceStyleProfile({ workspace_dir: workspaceDir });
}

async function toolAppClearWorkspaceStyleProfile(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return await clearAppWorkspaceStyleProfile({ workspace_dir: workspaceDir });
}

async function toolAppRasterizePptxToImages(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const pptxPath = readRequiredAbsolutePathArg(args, "pptx_path");
  const outputDir = readRequiredAbsolutePathArg(args, "output_dir");
  const targetHeight = args.target_height === undefined
    ? undefined
    : Number(args.target_height);
  if (
    targetHeight !== undefined
    && (!Number.isInteger(targetHeight) || targetHeight <= 0)
  ) {
    throw new Error('"target_height" must be a positive integer');
  }

  return rasterizePptxToImages({
    pptx_path: pptxPath,
    output_dir: outputDir,
    target_height: targetHeight,
    overwrite: args.overwrite === true,
  });
}

async function toolAppListUploadedSources(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return listAppUploadedSources({
    workspace_dir: workspaceDir,
    include_removed: args.include_removed === true,
  });
}

async function toolAppRunUploadedSourcePreflight(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  return runAppUploadedSourcePreflight({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") });
}

async function toolAppGetUploadedSourcePreflightStatus(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  return getAppUploadedSourcePreflightStatus({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") });
}

async function toolAppContinueUploadedSourcePdfOcr(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  return continueAppUploadedSourcePdfOcr({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") });
}

async function toolAppGetUploadedSourcePreflightText(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const optionalInteger = (name, minimum = 0) => {
    const value = args[name];
    if (value === undefined || value === null) return undefined;
    if (!Number.isInteger(value) || value < minimum) throw new Error(`"${name}" must be an integer no smaller than ${minimum}`);
    return value;
  };
  const result = await getAppUploadedSourcePreflightText({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    uploaded_source_id: readRequiredStringArg(args, "uploaded_source_id"),
    offset: optionalInteger("offset"),
    limit: optionalInteger("limit", 1),
    attachment_chunk: args.attachment_chunk === true,
  });
  return result;
}

async function toolAppGetUploadedSourcePreflightChunks(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  return getAppUploadedSourcePreflightChunks({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    uploaded_source_id: readRequiredStringArg(args, "uploaded_source_id"),
  });
}

async function toolAppIgnoreUploadedSource(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  return ignoreAppUploadedSource({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    uploaded_source_id: readRequiredStringArg(args, "uploaded_source_id"),
    ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
  });
}

async function toolAppPrepareAttachmentBrief(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  return prepareAppAttachmentBrief({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    uploaded_source_id: readRequiredStringArg(args, "uploaded_source_id"),
  });
}

async function toolAppGetAttachmentBriefDraft(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  return getAppAttachmentBriefDraft({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    uploaded_source_id: readRequiredStringArg(args, "uploaded_source_id"),
  });
}

async function toolAppRecordAttachmentBrief(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const brief = args.brief;
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
    throw new Error('"brief" must be a structured object.');
  }
  const result = await recordAppAttachmentBrief({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    uploaded_source_id: readRequiredStringArg(args, "uploaded_source_id"),
    brief,
  });
  return result;
}

async function toolAppGetAttachmentBrief(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const result = await getAppAttachmentBrief({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    uploaded_source_id: readRequiredStringArg(args, "uploaded_source_id"),
  });
  return result;
}

async function toolAppListAttachmentBriefs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const result = await listAppAttachmentBriefs({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") });
  return result;
}

async function toolAppWriteAttachmentContext(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const result = await writeAppAttachmentContext({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    user_brief: readRequiredStringArg(args, "user_brief"),
  });
  return result;
}

async function toolAppGetAttachmentContext(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const result = await getAppAttachmentContext({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") });
  return result;
}


async function toolAppRemoveUploadedSource(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  if (typeof args.uploaded_source_id !== "string" || args.uploaded_source_id.trim().length === 0) {
    throw new Error('"uploaded_source_id" must be a non-empty string');
  }

  return removeAppUploadedSource({
    workspace_dir: workspaceDir,
    uploaded_source_id: args.uploaded_source_id,
  });
}

function readUploadedSourceAnalysisDraftTypeArg(args) {
  const draftType = args.draft_type;
  if (draftType !== "factual" && draftType !== "visual") {
    throw new Error('"draft_type" must be either "factual" or "visual"');
  }
  return draftType;
}

async function toolAppPrepareUploadedSourceAnalysisWorkspace(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return prepareAppUploadedSourceAnalysisWorkspace({ workspace_dir: workspaceDir });
}

async function toolAppRecordUploadedSourceAnalysisDraft(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const draftType = readUploadedSourceAnalysisDraftTypeArg(args);
  if (!args.draft || typeof args.draft !== "object" || Array.isArray(args.draft)) {
    throw new Error('"draft" must be an object');
  }
  return recordAppUploadedSourceAnalysisDraft({
    workspace_dir: workspaceDir,
    draft_type: draftType,
    draft_id: typeof args.draft_id === "string" ? args.draft_id : undefined,
    draft: args.draft,
  });
}

async function toolAppGetUploadedSourceAnalysisDraft(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return getAppUploadedSourceAnalysisDraft({
    workspace_dir: workspaceDir,
    draft_type: readUploadedSourceAnalysisDraftTypeArg(args),
    draft_id: typeof args.draft_id === "string" ? args.draft_id : undefined,
  });
}

async function toolAppGetUploadedSourceAnalysisDraftFingerprint(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return getAppUploadedSourceAnalysisDraftFingerprint({
    workspace_dir: workspaceDir,
    draft_type: readUploadedSourceAnalysisDraftTypeArg(args),
    draft_id: typeof args.draft_id === "string" ? args.draft_id : undefined,
  });
}

async function toolAppRecordUploadedSourceAnalysis(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  if (!args.analysis || typeof args.analysis !== "object" || Array.isArray(args.analysis)) {
    throw new Error('"analysis" must be an object');
  }
  if (args.analysis_markdown !== undefined && typeof args.analysis_markdown !== "string") {
    throw new Error('"analysis_markdown" must be a string');
  }
  return recordAppUploadedSourceAnalysis({
    workspace_dir: workspaceDir,
    analysis: args.analysis,
    ...(typeof args.analysis_markdown === "string" ? { analysis_markdown: args.analysis_markdown } : {}),
  });
}

async function toolAppGetUploadedSourceAnalysis(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return getAppUploadedSourceAnalysis({ workspace_dir: workspaceDir });
}

async function toolAppGetWorkspaceOutline(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return getAppWorkspaceOutline({ workspace_dir: workspaceDir });
}

async function toolAppGetWorkspaceRequirements(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return getAppWorkspaceRequirements({ workspace_dir: workspaceDir });
}

async function toolAppAppendWorkspaceLog(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const channel = args.channel;
  const supportedChannels = [
    "preview-recovery",
    "attachment-preflight",
    "ai-requirements",
    "ai-requirements-interactions",
    "ai-outline",
    "ai-outline-interactions",
    "ai-style-guide",
    "ai-style-guide-interactions",
    "ai-visual-rhythm",
    "ai-visual-rhythm-interactions",
    "ai-page-visual-plan",
    "ai-page-visual-plan-interactions",
    "ai-persistent-elements",
    "ai-persistent-elements-interactions",
    "ai-page-plan",
    "ai-page-plan-interactions",
    "ai-page-agent",
    "ai-page-agent-interactions",
    "ai-page-agent-stream",
    "ai-research",
    "ai-research-interactions",
    "research-web-interactions",
    "ai-theme",
    "ai-theme-interactions",
    "storage-transport",
  ];
  if (!supportedChannels.includes(channel)) {
    throw new Error(`"channel" must be one of: ${supportedChannels.join(", ")}`);
  }

  if (!isDiagnosticLoggingEnabled() && channel !== "preview-recovery") {
    return { workspace_dir: workspaceDir, log_file: "", appended: false };
  }

  const entry = args.entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error('Workspace log entry must be a JSON object');
  }
  const payloadKeys = Array.isArray(args.payload_keys)
    ? args.payload_keys.filter((key) => typeof key === "string" && key.length > 0)
    : undefined;
  const inlinePayloadMaxBytes =
    typeof args.inline_payload_max_bytes === "number"
      ? args.inline_payload_max_bytes
      : undefined;

  return appendAppWorkspaceLog({
    workspace_dir: workspaceDir,
    channel,
    entry,
    payload_keys: payloadKeys,
    inline_payload_max_bytes: inlinePayloadMaxBytes,
  });
}

async function toolAppWriteResearchTestFile(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  if (args.append !== undefined && typeof args.append !== "boolean") throw new Error('"append" must be a boolean');
  if (typeof args.content !== "string") throw new Error('"content" must be a string');
  return writeAppResearchTestFile({
    run_id: readRequiredStringArg(args, "run_id"),
    file_name: readRequiredStringArg(args, "file_name"),
    content: args.content,
    ...(args.append === undefined ? {} : { append: args.append }),
  });
}

function readOutlineInput(args) {
  const outline = args.outline;
  if (!outline || typeof outline !== "object" || Array.isArray(outline)) throw new Error('"outline" must be an object');
  return outline;
}

async function toolAppResetWorkspaceOutline(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return await resetAppWorkspaceOutline({
    workspace_dir: workspaceDir,
  });
}

async function toolAppSaveWorkspaceOutlineDraft(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const outline = await readOutlineInput(args);

  return await saveAppWorkspaceOutlineDraft({
    workspace_dir: workspaceDir,
    outline,
  });
}

async function toolAppConfirmWorkspaceOutline(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const outline = await readOutlineInput(args);

  return await confirmAppWorkspaceOutline({
    workspace_dir: workspaceDir,
    outline,
  });
}

async function toolAppUpdateWorkspaceRequirements(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const requirements = args.requirements;
  if (!requirements || typeof requirements !== "object" || Array.isArray(requirements)) {
    throw new Error('"requirements" must be an object');
  }

  return await updateAppWorkspaceRequirements({
    workspace_dir: workspaceDir,
    requirements,
  });
}

async function toolAppConfirmWorkspaceRequirements(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const requirements = args.requirements;
  if (!requirements || typeof requirements !== "object" || Array.isArray(requirements)) throw new Error('"requirements" must be an object');
  let snapshot = args.template_snapshot;
  if (args.user_template_id !== undefined) {
    if (snapshot !== undefined || args.user_template_id !== requirements.selections?.visual_style_preset?.id) throw new Error("Invalid personal template identity");
    const asset = await getUserTemplateAsset(args.user_template_id, "snapshot");
    snapshot = JSON.parse(await readFile(asset.file_path, "utf8"));
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Template reference snapshot is required");
  return withStagedAppText({ content: JSON.stringify(snapshot) }, "json", (stagingPath, sizeBytes) => confirmAppWorkspaceRequirements({
    workspace_dir: workspaceDir, requirements, template_reference_staging_file_path: stagingPath, template_reference_expected_size_bytes: sizeBytes,
  }));
}

async function toolAppUpdateWorkspaceSettings(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const setting = args.setting;
  if (!setting || typeof setting !== "object" || Array.isArray(setting)) {
    throw new Error('"setting" must be an object');
  }

  return await updateAppWorkspaceSettings({
    workspace_dir: workspaceDir,
    setting,
    persist_as_default: args.persist_as_default === true,
  });
}

async function toolAppPatchWorkspaceSettings(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const setting = args.setting;
  if (!setting || typeof setting !== "object" || Array.isArray(setting)) {
    throw new Error('"setting" must be an object');
  }

  return patchAppWorkspaceSettings({
    workspace_dir: workspaceDir,
    setting,
    persist_as_default: args.persist_as_default === true,
  });
}



async function toolAppUpdateWorkspaceTitle(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  if (typeof args.title !== "string" || args.title.trim().length === 0) {
    throw new Error('"title" must be a non-empty string');
  }

  return await updateAppWorkspaceTitle({
    workspace_dir: workspaceDir,
    title: args.title,
  });
}

async function toolAppDuplicateWorkspace(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  if (args.title !== undefined && typeof args.title !== "string") {
    throw new Error('"title" must be a string');
  }

  const result = await duplicateAppWorkspace({
    workspace_dir: workspaceDir,
    title: typeof args.title === "string" ? args.title : undefined,
  });
  // The frontend immediately starts the duplicate's dedicated publication
  // invoke after this local operation returns.
  return result;
}

async function toolAppDeleteWorkspace(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const result = await deleteAppWorkspace({ workspace_dir: workspaceDir });
  // Local deletion deliberately preserves APS bytes. The tombstone written by
  // the engine prevents automatic restore; a future explicit restore can clear
  // it after the user intentionally chooses to bring this Workspace back.
  return result;
}

async function toolAppListTemplateGroups() {
  return listAppTemplateGroups();
}

async function toolAppGetTemplateGroup(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  if (typeof args.group_id !== "string" || args.group_id.length === 0) {
    throw new Error('Missing required parameter: "group_id"');
  }

  return getAppTemplateGroup({ group_id: args.group_id });
}

async function toolAppSelectWorkspaceTemplate(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  if (typeof args.template_group !== "string" || args.template_group.trim().length === 0) {
    throw new Error('"template_group" must be a non-empty string');
  }

  return await selectAppWorkspaceTemplate({
    workspace_dir: workspaceDir,
    template_group: args.template_group,
  });
}

async function toolAppGetTemplatePlanningContext(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return getAppTemplatePlanningContext({ workspace_dir: workspaceDir });
}

async function toolAppGetWorkspaceThemeContext(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return getAppWorkspaceThemeContext({ workspace_dir: workspaceDir });
}

async function toolAppValidateWorkspaceThemeToken(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  if (args.token === undefined) {
    throw new Error('"token" is required');
  }

  return validateAppWorkspaceThemeToken({
    workspace_dir: workspaceDir,
    token: args.token,
  });
}

async function toolAppRecordWorkspaceThemeToken(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  if (args.use_default !== true && args.token === undefined) {
    throw new Error('"token" is required unless "use_default" is true');
  }

  return await recordAppWorkspaceThemeToken({
    workspace_dir: workspaceDir,
    token: args.token,
    use_default: args.use_default === true,
  });
}





async function toolAppGetWorkspacePageFileFingerprints(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const slidePath = typeof args.slide_path === "string" ? args.slide_path : "";
  const dataPath = typeof args.data_path === "string" ? args.data_path : "";
  if (!slidePath) {
    throw new Error('Missing required parameter: "slide_path"');
  }
  if (!dataPath) {
    throw new Error('Missing required parameter: "data_path"');
  }

  return getAppWorkspacePageFileFingerprints({
    workspace_dir: workspaceDir,
    slide_path: slidePath,
    data_path: dataPath,
  });
}

async function toolAppGetPageProgress(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return getAppPageProgress({ workspace_dir: workspaceDir });
}

async function toolAppPrepareSharedResearchWorkspace(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  return await prepareAppSharedResearchWorkspace({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    reset_progress: args.reset_progress === true,
  });
}

async function toolAppGetSharedResearchContext(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  return await getAppSharedResearchContext({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") });
}

async function toolAppPatchSharedResearchProgress(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  if (!Array.isArray(args.operations) || args.operations.some((operation) => !operation || typeof operation !== "object" || Array.isArray(operation))) {
    throw new Error('"operations" must be an array of objects');
  }
  return patchAppSharedResearchProgress({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    operations: args.operations,
  });
}

async function toolAppPublishPreparedWebResearchBatch(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  return publishPreparedAppWebResearchBatch({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") });
}

async function toolAppPublishPreparedImageResearchBatch(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  return publishPreparedAppImageResearchBatch({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") });
}

async function toolAppAppendWebResearchBatch(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  return appendAppWebResearchBatch({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    markdown: readRequiredStringArg(args, "markdown"),
  });
}

async function toolAppPageImageSearch(args) {
  const result = await appPageImageSearch({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    action: readRequiredStringArg(args, "action"),
    target_key: args.target_key,
    owner: args.owner,
    task: args.task,
  });
  return result;
}

async function toolAppAppendImageResearchBatch(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const batch = args.batch;
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) throw new Error('"batch" must be an object');
  return appendAppImageResearchBatch({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    batch,
  });
}

function researchImageStagingDirectory(imagesDir, operationId) {
  const safeOperationId = operationId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120) || "research";
  return path.join(imagesDir, ".staging", safeOperationId);
}

function assertResearchImageStagingPath(imagesDir, value) {
  assertAbsolutePath(value, "existing_file_path");
  const stagingRoot = path.resolve(imagesDir, ".staging");
  const resolved = path.resolve(value);
  if (resolved !== stagingRoot && !resolved.startsWith(`${stagingRoot}${path.sep}`)) {
    throw new Error('"existing_file_path" must be inside research/evidence/images/.staging');
  }
  return resolved;
}

async function toolAppPrepareSharedResearchImageCandidate(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const operationId = readRequiredStringArg(args, "operation_id");
  const candidateId = assertSafeUploadFilename(readRequiredStringArg(args, "candidate_id"));
  const sourceUrl = readRequiredStringArg(args, "source_url");
  const context = await getAppSharedResearchContext({ workspace_dir: workspaceDir });
  const stagingDir = researchImageStagingDirectory(context.images_dir, operationId);
  const existingFilePath = typeof args.existing_file_path === "string" && args.existing_file_path.length > 0
    ? assertResearchImageStagingPath(context.images_dir, args.existing_file_path)
    : undefined;
  const expectedSha256 = typeof args.expected_sha256 === "string" && /^[a-f0-9]{64}$/i.test(args.expected_sha256)
    ? args.expected_sha256.toLowerCase()
    : undefined;
  const downloadLogger = createStorageTransferLogger({
    workspaceDir,
    operationId,
    source: "ppt-engine.research-image-download",
    transport: "https_download",
    filename: candidateId,
  });
  let sourceOrigin;
  try {
    sourceOrigin = new URL(sourceUrl).origin;
  } catch {
    sourceOrigin = "invalid";
  }
  downloadLogger.log("started", "started", { candidate_id: candidateId, source_origin: sourceOrigin });
  let downloaded;
  try {
    downloaded = await downloadResearchImage({
      url: sourceUrl,
      staging_dir: stagingDir,
      candidate_id: candidateId,
      existing_file_path: existingFilePath,
      expected_sha256: expectedSha256,
      onEvent: (event) => downloadLogger.log(event.phase, event.status, { candidate_id: candidateId, ...event.details }),
    });
    downloadLogger.log("finished", "succeeded", {
      candidate_id: candidateId,
      mime_type: downloaded.mime_type,
      size_bytes: downloaded.bytes_size,
      sha256: downloaded.sha256,
      width: downloaded.width,
      height: downloaded.height,
      redirects: downloaded.redirects,
    });
  } catch (error) {
    downloadLogger.log("download", "failed", { candidate_id: candidateId, error: storageErrorRecord(error) });
    throw error;
  }

  return {
    workspace_dir: workspaceDir,
    candidate_id: candidateId,
    local_file_path: downloaded.file_path,
    final_url: downloaded.final_url,
    mime_type: downloaded.mime_type,
    bytes_size: downloaded.bytes_size,
    sha256: downloaded.sha256,
    width: downloaded.width,
    height: downloaded.height,
  };
}

async function toolAppUploadSharedResearchImageCandidate(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const operationId = readRequiredStringArg(args, "operation_id");
  const candidateId = assertSafeUploadFilename(readRequiredStringArg(args, "candidate_id"));
  const context = await getAppSharedResearchContext({ workspace_dir: workspaceDir });
  const localFilePath = assertResearchImageStagingPath(context.images_dir, readRequiredAbsolutePathArg(args, "local_file_path"));
  const mimeType = readRequiredStringArg(args, "mime_type");
  const hostUpload = await uploadLocalFileToHost({
    filePath: localFilePath,
    filename: path.basename(localFilePath),
    mimeType,
    purpose: "image_input",
    workspaceDir,
    operationId,
    source: "ppt-engine.research-image-session-upload",
    reuseWhileValid: true,
  });
  return { workspace_dir: workspaceDir, candidate_id: candidateId, host_upload: hostUpload };
}

async function toolAppImportSharedResearchImageLocal(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const context = await getAppSharedResearchContext({ workspace_dir: workspaceDir });
  const localFilePath = assertResearchImageStagingPath(context.images_dir, readRequiredAbsolutePathArg(args, "local_file_path"));
  const result = await importAppSharedResearchImage({
    workspace_dir: workspaceDir,
    candidate_id: readRequiredStringArg(args, "candidate_id"),
    staging_file_path: localFilePath,
    expected_size_bytes: Number(args.size_bytes),
    expected_sha256: readRequiredStringArg(args, "sha256"),
    mime_type: readRequiredStringArg(args, "mime_type"),
  });
  await unlink(localFilePath).catch(() => undefined);
  return result;
}

async function toolAppImportUploadedSourceImageToResearch(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return importAppUploadedSourceImageToResearch({
    workspace_dir: workspaceDir,
    uploaded_source_id: readRequiredStringArg(args, "uploaded_source_id"),
    candidate_id: readRequiredStringArg(args, "candidate_id"),
  });
}

async function toolAppCopyUploadedSourceImageToAsset(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return copyAppUploadedSourceImageToAsset({
    workspace_dir: workspaceDir,
    uploaded_source_id: readRequiredStringArg(args, "uploaded_source_id"),
    candidate_id: readRequiredStringArg(args, "candidate_id"),
    description: readRequiredStringArg(args, "description"),
    reason: readRequiredStringArg(args, "reason"),
  });
}

async function toolAppCleanupSharedResearchImageStaging(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const operationId = readRequiredStringArg(args, "operation_id");
  const context = await getAppSharedResearchContext({ workspace_dir: workspaceDir });
  await rm(path.join(context.images_dir, ".staging"), { recursive: true, force: true });
  return { workspace_dir: workspaceDir, operation_id: operationId, cleaned: true };
}

async function toolAppRecordPageProgress(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const pageId = typeof args.page_id === "string" && args.page_id.trim().length > 0
    ? args.page_id
    : undefined;
  if (args.page_id !== undefined && !pageId) {
    throw new Error('"page_id" must be a non-empty string when provided');
  }
  const patch = args.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error('"patch" must be an object');
  }

  return recordAppPageProgress({
    workspace_dir: workspaceDir,
    page_id: pageId,
    patch,
  });
}

async function toolAppRenderWorkspacePagePreview(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const pageId = typeof args.page_id === "string" ? args.page_id.trim() : "";
  if (!pageId) {
    throw new Error('"page_id" must be a non-empty string');
  }

  return renderAppWorkspacePagePreview({
    workspace_dir: workspaceDir,
    page_id: pageId,
  });
}

async function toolAppAuditWorkspacePageLayout(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const pageId = readRequiredStringArg(args, "page_id");
  const result = await auditAppWorkspacePageLayout({
    workspace_dir: workspaceDir,
    page_id: pageId,
    expected_source_sha256: readRequiredStringArg(args, "expected_source_sha256"),
  });
  const { source_html_path, rendered_html_path, ...summary } = result;
  if (result.error_count === 0) return summary;
  const assertSourceCurrent = async () => {
    if (createHash("sha256").update(await readFile(source_html_path)).digest("hex") !== result.source_sha256) {
      throw new Error("Page source changed while preparing layout rewrite attachments");
    }
  };
  await assertSourceCurrent();
  const attachments = {
    ...summary,
    ...({ source_html: await readFile(source_html_path, "utf8") }),
    screenshot_upload: await withTransientPageScreenshot(workspaceDir, rendered_html_path, (file) => uploadPreviewImage(file, {
      workspaceDir, source: "ppt-engine.layout-rewrite-screenshot",
    }), { expectedFingerprint: result.preview_source_fingerprint }),
  };
  await assertSourceCurrent();
  return attachments;
}

async function toolAppUploadCurrentPageScreenshot(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const pageId = typeof args.page_id === "string" ? args.page_id.trim() : "";
  if (!pageId) throw new Error('"page_id" must be a non-empty string');

  const page = await getAppWorkspacePageHtml({ workspace_dir: workspaceDir, page_id: pageId });
  return withTransientPageScreenshot(workspaceDir, page.html_path, (file) => uploadPreviewImage(file, {
    workspaceDir, source: "ppt-engine.current-page-screenshot",
  }), { expectedFingerprint: page.preview_source_fingerprint });
}

async function editorResourceResolver() {
  const defaults = await getAppWorkspaceDefaults();
  return createPreviewResourceResolver({ client: apsFilesClient, indexDirectory: path.join(defaults.workspace_root, ".preview-resource-index") });
}

async function toolAppGetPageEditContext(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const pageId = readRequiredStringArg(args, "page_id");
  if (args.purpose !== undefined && !["editor", "refinement"].includes(args.purpose)) throw new Error("Invalid page context purpose");
  const result = await getAppPageEditContext({ workspace_dir: workspaceDir, page_id: pageId });
  if (args.purpose === "refinement") {
    // Preserve the original authoring baseline for pages without a manual revision.
    const html = result.manually_edited ? result.html : await readFile(path.join(workspaceDir, "slides", `${pageId}.html`), "utf8");
    const screenshotUpload = await withTransientPageScreenshot(workspaceDir, result.html_path, (file) => uploadPreviewImage(file, { workspaceDir, source: "ppt-engine.refinement-context" }), { expectedFingerprint: result.preview_source_fingerprint });
    await getAppWorkspacePageHtml({ workspace_dir: workspaceDir, page_id: pageId, expected_preview_fingerprint: result.preview_source_fingerprint });
    if (!result.manually_edited && await readFile(path.join(workspaceDir, "slides", `${pageId}.html`), "utf8") !== html) {
      throw new Error("Page source changed while preparing refinement context");
    }
    return { ...result, html, resources: [], resources_expires_at: null, workspace_fonts: [], font_library: [], screenshot_upload: screenshotUpload };
  }
  const prepared = await preparePreviewResources({ workspaceDir, htmlPath: result.html_path, html: result.html,
    resolve: await editorResourceResolver() });
  const workspaceFonts = await Promise.all(result.workspace_fonts.map((font) => serializeManagedFontFamily(font, workspaceDir)));
  return { ...result, html: prepared.html, resources: prepared.resources,
    resources_expires_at: prepared.resources_expires_at, workspace_fonts: workspaceFonts };
}

async function toolAppCommitManualPageImage(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const pageId = readRequiredStringArg(args, "page_id");
  // Resolve page ownership before accepting an uploaded asset.
  await getAppPageEditContext({ workspace_dir: workspaceDir, page_id: pageId });
  const hostUpload = readHostUploadRefArg(args, "host_upload");
  if (!Number.isSafeInteger(args.size_bytes) || args.size_bytes < 1 || args.size_bytes > 20 * 1024 * 1024) throw new Error("Invalid image size");
  const stagingPath = path.join(MANUAL_PAGE_STAGING_DIR, `${randomUUID()}.image`);
  try {
    await downloadHostUploadToStaging({ hostUpload, stagingPath, expectedSizeBytes: args.size_bytes });
    const bytes = await readFile(stagingPath);
    const image = await storeManualPageImage(workspaceDir, pageId, bytes, hostUpload.mime_type);
    const resolve = await editorResourceResolver();
    const resource = await resolve({ bytes, mimeType: hostUpload.mime_type, extension: path.extname(new URL(image.local_url).pathname) });
    return { ...image, ...resource };
  } finally { await rm(stagingPath, { force: true }); }
}

async function resolveRuntimeFont(file) {
  const resolved = await (await editorResourceResolver())({ bytes: await readFile(file.file_path), mimeType: file.mime_type, extension: `.${file.format}` });
  return { source_url: resolved.url, expires_at: resolved.expires_at };
}

async function toolAppRefreshManualPageResources(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const pageId = readRequiredStringArg(args, "page_id");
  if (!Array.isArray(args.local_urls) || args.local_urls.some((url) => typeof url !== "string" || !url.startsWith("file://"))) throw new Error("Invalid editor resource request");
  await getAppPageEditContext({ workspace_dir: workspaceDir, page_id: pageId });
  const escape = (url) => url.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const prepared = await preparePreviewResources({ workspaceDir, htmlPath: path.join(workspaceDir, "slides", `${pageId}.html`),
    html: `<html><head></head><body>${args.local_urls.map((url) => `<img src="${escape(url)}">`).join("")}</body></html>`,
    resolve: await editorResourceResolver() });
  return prepared.resources;
}

async function serializeManagedFontFamily(font, workspaceDir) {
  const variants = {};
  for (const [variant, files] of Object.entries(font?.variants || {})) {
    const sources = [];
    for (const file of files || []) {
      if (!file || typeof file.file_path !== "string") continue;
      sources.push({
      format: file.format,
      mime_type: file.mime_type,
      size_bytes: file.size_bytes,
      local_url: pathToFileURL(file.file_path).href,
      unicode_range: file.unicode_range,
      ...await resolveRuntimeFont(file),
      });
    }
    if (sources.length > 0) variants[variant] = { variant, sources };
  }
  return { family: font.family, variants };
}

async function toolAppPinManagedFont(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const family = typeof args.family === "string" ? args.family.trim() : "";
  if (!family) throw new Error('"family" must be a non-empty string');
  return serializeManagedFontFamily(
    await pinManagedFontToWorkspace(workspaceDir, family),
    workspaceDir,
  );
}

async function toolAppCommitManagedFontHostUpload(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const filename = assertSafeUploadFilename(args.filename);
  const expectedSizeBytes = Number(args.size_bytes);
  if (
    !Number.isInteger(expectedSizeBytes) ||
    expectedSizeBytes <= 0 ||
    expectedSizeBytes > 20 * 1024 * 1024
  ) {
    throw new Error('"size_bytes" must be between 1 and 20971520');
  }
  const hostUpload = readHostUploadRefArg(args, "host_upload");
  const stagingPath = path.join(
    MANAGED_FONT_STAGING_DIR,
    `${randomUUID()}${path.extname(filename).toLowerCase()}`,
  );
  try {
    await downloadHostUploadToStaging({
      hostUpload,
      stagingPath,
      expectedSizeBytes,
    });
    const result = await commitManagedFontUpload({
      workspace_dir: workspaceDir,
      staging_file_path: stagingPath,
      filename,
      expected_size_bytes: expectedSizeBytes,
    });
    return {
      library: result.library,
      font: await serializeManagedFontFamily(result.font, workspaceDir),
    };
  } finally {
    await unlink(stagingPath).catch(() => undefined);
  }
}

async function toolAppSaveManualPageRevision(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const pageId = readRequiredStringArg(args, "page_id");
  const baseRevision = Number(args.base_revision);
  if (!Number.isInteger(baseRevision) || baseRevision < 0) throw new Error('"base_revision" must be a non-negative integer');
  return withStagedAppText({ content: args.html }, "html", (stagingPath, sizeBytes) => saveAppManualPageRevision({
    workspace_dir: workspaceDir, page_id: pageId, base_revision: baseRevision,
    staging_file_path: stagingPath, expected_size_bytes: sizeBytes,
  }));
}

async function toolAppPublishWorkspaceSnapshot(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return publishAppWorkspaceSnapshot({ workspace_dir: workspaceDir });
}

async function toolAppGetWorkspaceSnapshotSyncState(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return getAppWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
}

async function toolAppGetWorkspaceSnapshotInfo(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const revision = typeof args.revision === "string" && args.revision.trim()
    ? args.revision.trim()
    : undefined;
  return getAppWorkspaceSnapshotInfo({ workspace_dir: workspaceDir, revision });
}

async function toolAppRestorePageSourceVersion(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const pageId = typeof args.page_id === "string" ? args.page_id.trim() : "";
  if (!pageId) throw new Error('"page_id" must be a non-empty string');
  if (args.recovery_token !== undefined && (typeof args.recovery_token !== "string" || !/^[a-f0-9]{64}$/.test(args.recovery_token))) throw new Error("Invalid recovery token");
  const result = await restoreAppPageSourceVersion({ workspace_dir: workspaceDir, page_id: pageId, recovery_token: args.recovery_token });
  return {
    ...result,
    ...({ html: await readFile(result.html_path, "utf8") }),
  };
}

async function toolAppRenderDeckHtml(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const result = await renderAppWorkspaceDeckHtml({
    workspace_dir: workspaceDir,
  });
  return result;
}

async function toolAppGetRenderedDeckHtml(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const result = await getRenderedAppWorkspaceDeckHtml({
    workspace_dir: workspaceDir, allow_partial: args.allow_partial === true,
  });
  return result;
}

async function toolAppPrepareWorkspacePagePreview(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const pageId = readRequiredStringArg(args, "page_id");
  return prepareAppWorkspacePagePreview({ workspace_dir: workspaceDir, page_id: pageId,
    priority: args.priority === "background" ? "background" : "foreground",
    kind: args.kind === "thumbnail" ? "thumbnail" : "html", retry: args.retry === true });
}

async function toolAppGetWorkspacePagePreviewPreparation(args) {
  return getAppWorkspacePagePreviewPreparation({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    task_id: readRequiredStringArg(args, "task_id"),
  });
}


async function toolAppGetWorkspacePageThumbnail(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const result = await getAppWorkspacePageThumbnail({ workspace_dir: workspaceDir,
    page_id: args.page_id, expected_preview_fingerprint: args.expected_preview_fingerprint });
  const { image_path: imagePath, ...metadata } = result;
  const bytes = await readFile(imagePath);
  return { ...metadata, image_data_url: `data:image/webp;base64,${bytes.toString("base64")}` };
}

async function toolAppGetWorkspacePageHtml(args) {
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const pageId = typeof args.page_id === "string" ? args.page_id.trim() : undefined;
  const target = { workspace_dir: workspaceDir, page_id: pageId, batch_id: args.batch_id, candidate_id: args.candidate_id };
  if (args.fallback_only === true) {
    if (!pageId || args.batch_id || args.candidate_id) throw new Error("Fallback requires an official page identity");
    const defaults = await getAppWorkspaceDefaults();
    for await (const page of getAppWorkspacePagePreviewFallbacks({ workspace_dir: workspaceDir, page_id: pageId })) {
      try {
        if (page.fallback.source === "thumbnail") return { page_id: pageId, html: page.html,
          html_fingerprint: page.html_fingerprint, preview_source_fingerprint: page.preview_source_fingerprint,
          resources_expires_at: null, fallback: page.fallback };
        const prepared = await preparePreviewResources({ workspaceDir, htmlPath: page.html_path, html: page.html,
          resolve: createPreviewResourceResolver({ client: apsFilesClient,
            indexDirectory: path.join(defaults.workspace_root, ".preview-resource-index") }),
        });
        return { page_id: pageId, html: prepared.html, html_fingerprint: page.html_fingerprint,
          preview_source_fingerprint: page.preview_source_fingerprint, resources_expires_at: prepared.resources_expires_at, fallback: page.fallback };
      } catch { /* Try the next same-page backup when its resources cannot be prepared. */ }
    }
    throw new Error("No usable same-page preview backup");
  }
  const page = await getAppWorkspacePageHtml({ ...target,
    expected_preview_fingerprint: args.expected_preview_fingerprint });
  const defaults = await getAppWorkspaceDefaults();
  const logger = createApsTransferLogger({ workspaceDir, source: "ppt-engine.html-preview-resources", filename: pageId, mimeType: "application/octet-stream", sizeBytes: 0 });
  const prepared = await preparePreviewResources({ workspaceDir, htmlPath: page.html_path, html: page.html,
    resolve: createPreviewResourceResolver({ client: apsFilesClient,
      indexDirectory: path.join(defaults.workspace_root, ".preview-resource-index"),
      onEvent: (phase, details) => logger.log(phase, phase.endsWith("failed") ? "failed" : phase.endsWith("started") ? "started" : "succeeded", details),
    }),
  });
  const current = await getAppWorkspacePageHtml({ ...target,
    expected_preview_fingerprint: page.preview_source_fingerprint });
  if (current.html_fingerprint !== page.html_fingerprint) throw new Error("Page preview version changed while resolving resources");
  return { page_id: page.page_id, html: prepared.html, html_fingerprint: page.html_fingerprint,
    preview_source_fingerprint: page.preview_source_fingerprint, resources_expires_at: prepared.resources_expires_at };
}


async function toolAppStartPptxExport(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const pageNumbers = args.page_numbers;
  if (pageNumbers !== undefined && (!Array.isArray(pageNumbers) || pageNumbers.some((pageNumber) => !Number.isInteger(pageNumber)))) {
    throw new Error('"page_numbers" must be an array of integers');
  }
  return startAppPptxExport({
    workspace_dir: workspaceDir,
    ...(pageNumbers === undefined ? {} : { page_numbers: pageNumbers }),
  });
}

async function toolAppGetPptxExportStatus(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return getAppPptxExportStatus({
    workspace_dir: workspaceDir,
  });
}

async function toolAppRunPptxExport(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const pageNumbers = args.page_numbers;
  if (pageNumbers !== undefined && (!Array.isArray(pageNumbers) || pageNumbers.some((pageNumber) => !Number.isInteger(pageNumber)))) {
    throw new Error('"page_numbers" must be an array of integers');
  }
  let job = await startAppPptxExport({
    workspace_dir: workspaceDir,
    ...(pageNumbers === undefined ? {} : { page_numbers: pageNumbers }),
  });
  if (job.status === "completed") return job;
  if (job.status === "failed") {
    throw new Error(job.error?.message || job.message || "PPTX export failed");
  }

  const deadline = Date.now() + EXPORT_ASYNC_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    job = await getAppPptxExportStatus({ workspace_dir: workspaceDir });
    if (job.status === "completed") return job;
    if (job.status === "failed") {
      throw new Error(job.error?.message || job.message || "PPTX export failed");
    }
  }
  throw new Error("PPTX export exceeded the 10-minute Host Async Job deadline.");
}

async function toolAppRunExportOnly(args) {
  return runExportOnly(args);
}

function isExportArtifactPublishJobRunning(job) {
  return job && ["queued", "preparing", "uploading", "committing"].includes(job.status);
}

function exportArtifactInfoFromSnapshot(snapshot) {
  return {
    workspace_dir: snapshot.workspace_dir,
    workspace_id: snapshot.workspace_id,
    title: snapshot.title,
    artifact_type: snapshot.artifact_type,
    path: snapshot.path,
    filename: snapshot.filename,
    updated_at: snapshot.updated_at,
    mirror: snapshot.mirror ?? null,
  };
}

async function uploadApsSnapshotWithRetry({
  snapshot,
  bodyPath,
  workspaceDir,
  templateId,
  source,
  operationId,
  metadata,
}) {
  const contentDisposition = buildAttachmentContentDisposition(snapshot.filename);
  let currentAttemptLogger;
  const result = await runWithStorageRetry(async ({ attempt, maxAttempts }) => {
    const logger = createApsTransferLogger({
      workspaceDir,
      templateId,
      source,
      filename: snapshot.filename,
      mimeType: snapshot.content_type,
      sizeBytes: snapshot.size_bytes,
      path: snapshot.aps_path,
      operationId,
    });
    currentAttemptLogger = logger;
    let currentPhase = "started";
    logger.log("started", "started", {
      aps_path: snapshot.aps_path,
      attempt,
      max_attempts: maxAttempts,
    });
    try {
      currentPhase = "negotiate";
      const upload = await apsFilesClient.uploadBegin({
        path: snapshot.aps_path,
        sizeBytes: snapshot.size_bytes,
        contentType: snapshot.content_type,
        scope: APS_FILES_DOWNLOAD_SCOPE,
        metadata,
      });
      if (!upload || typeof upload.put_url !== "string" || upload.put_url.length === 0) {
        throw new Error("files/upload_begin did not return a valid put_url");
      }
      logger.log("negotiate", "succeeded", { response: redactStorageResponse(upload), aps_path: snapshot.aps_path });
      currentPhase = "put";
      const putResponse = await fetch(upload.put_url, {
        method: "PUT",
        headers: {
          ...(upload.headers ?? {}),
          "Content-Length": String(snapshot.size_bytes),
          "Content-Disposition": contentDisposition,
        },
        body: createReadStream(bodyPath),
        duplex: "half",
      });
      await assertStorageResponseOk(putResponse, "APS Files PUT failed");
      logger.log("put", "succeeded", { http_status: putResponse.status, aps_path: snapshot.aps_path });
      currentPhase = "commit";
      const putEtag = putResponse.headers.get("etag") ?? undefined;
      const completed = await apsFilesClient.uploadComplete({
        path: snapshot.aps_path,
        etag: putEtag,
        sizeBytes: snapshot.size_bytes,
        contentType: snapshot.content_type,
        scope: APS_FILES_DOWNLOAD_SCOPE,
      });
      logger.log("commit", "succeeded", { response: redactStorageResponse(completed), aps_path: snapshot.aps_path });
      logger.log("finished", "succeeded", { aps_path: snapshot.aps_path });
      return { completed, putEtag };
    } catch (error) {
      const decision = classifyHostUploadAware(error);
      logger.log(currentPhase, "failed", {
        aps_path: snapshot.aps_path,
        error: storageErrorRecord(error),
        attempt,
        max_attempts: maxAttempts,
        retryable: decision.retryable && attempt < maxAttempts,
        retry_reason: decision.reason,
        retry_exhausted: decision.retryable && attempt >= maxAttempts,
      });
      throw error;
    }
  }, {
    classify: classifyHostUploadAware,
    onRetry: ({ attempt, nextAttempt, maxAttempts, delayMs, reason }) => {
      currentAttemptLogger?.log("retry", "scheduled", {
        attempt,
        next_attempt: nextAttempt,
        max_attempts: maxAttempts,
        delay_ms: delayMs,
        retry_reason: reason,
        aps_path: snapshot.aps_path,
      });
    },
  });
  return {
    ...result,
    contentDisposition,
  };
}

async function runAppExportArtifactPublishJob(job) {
  let snapshot = null;
  let transferLogger = null;
  try {
    await writeAppExportArtifactPublishJob({
      ...job,
      status: "preparing",
      message: "Preparing the export artifact upload.",
      percent: 15,
      error: null,
    });
    snapshot = await createAppExportArtifactSnapshot({
      workspace_dir: job.workspace_dir,
      artifact_type: job.artifact_type,
    });
    if (
      snapshot.updated_at !== job.source_updated_at ||
      snapshot.source_sha256.toLowerCase() !== job.source_sha256.toLowerCase()
    ) {
      throw new Error("Export artifact changed before its APS mirror upload started");
    }
    transferLogger = createApsTransferLogger({
      workspaceDir: job.workspace_dir,
      source: "ppt-engine.export-artifact-mirror",
      filename: snapshot.filename,
      mimeType: snapshot.content_type,
      sizeBytes: snapshot.size_bytes,
      path: snapshot.mirror_path,
      operationId: `app_run_export_artifact_publish:${job.artifact_type}`,
    });
    transferLogger.log("started", "started", { aps_path: snapshot.mirror_path, artifact_type: job.artifact_type });
    await writeAppExportArtifactPublishJob({
      ...job,
      status: "uploading",
      message: "Uploading the export artifact.",
      percent: 30,
      artifact: exportArtifactInfoFromSnapshot(snapshot),
      size_bytes: snapshot.size_bytes,
      error: null,
    });

    const uploaded = await uploadApsSnapshotWithRetry({
      snapshot: {
        ...snapshot,
        aps_path: snapshot.mirror_path,
      },
      bodyPath: snapshot.snapshot_path,
      workspaceDir: job.workspace_dir,
      source: "ppt-engine.export-artifact-mirror",
      operationId: `app_run_export_artifact_publish:${job.artifact_type}`,
      metadata: {
        workspace_id: snapshot.workspace_id,
        artifact_type: snapshot.artifact_type,
        source_updated_at: snapshot.updated_at,
        source_sha256: snapshot.source_sha256,
      },
    });
    await writeAppExportArtifactPublishJob({
      ...job,
      status: "committing",
      message: "Finalizing the export artifact mirror.",
      percent: 85,
      artifact: exportArtifactInfoFromSnapshot(snapshot),
      size_bytes: snapshot.size_bytes,
      error: null,
    });
    const { completed, putEtag, contentDisposition } = uploaded;
    const mirror = {
      provider: "aps.files",
      scope: APS_FILES_DOWNLOAD_SCOPE,
      path: snapshot.mirror_path,
      etag: typeof completed?.etag === "string" ? completed.etag : putEtag ?? "",
      size_bytes: Number.isFinite(Number(completed?.size_bytes))
        ? Math.floor(Number(completed.size_bytes))
        : snapshot.size_bytes,
      content_type: snapshot.content_type,
      content_disposition: contentDisposition,
      source_updated_at: snapshot.updated_at,
      source_sha256: snapshot.source_sha256,
      published_at: new Date().toISOString(),
    };
    const committed = await commitAppExportArtifactMirror({
      workspace_dir: job.workspace_dir,
      artifact_type: job.artifact_type,
      expected_updated_at: snapshot.updated_at,
      expected_sha256: snapshot.source_sha256,
      mirror,
    });
    transferLogger.log("finished", "succeeded", { aps_path: snapshot.mirror_path, etag: committed.etag });
    await writeAppExportArtifactPublishJob({
      ...job,
      status: "completed",
      message: "Export artifact mirror is ready.",
      percent: 100,
      completed_at: committed.published_at,
      artifact: {
        workspace_dir: snapshot.workspace_dir,
        workspace_id: snapshot.workspace_id,
        title: snapshot.title,
        artifact_type: snapshot.artifact_type,
        path: snapshot.path,
        filename: snapshot.filename,
        updated_at: snapshot.updated_at,
        mirror: committed,
      },
      mirror: committed,
      size_bytes: snapshot.size_bytes,
      error: null,
    });
  } catch (error) {
    transferLogger?.log("unknown", "failed", {
      aps_path: snapshot?.mirror_path,
      error: storageErrorRecord(error),
    });
    await writeAppExportArtifactPublishJob({
      ...job,
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
      percent: 100,
      completed_at: new Date().toISOString(),
      error: {
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      },
    });
  } finally {
    if (snapshot?.snapshot_path) {
      await unlink(snapshot.snapshot_path).catch(() => undefined);
    }
  }
}

function awaitAppExportArtifactPublishJob(job) {
  if (!job || job.status !== "queued") {
    return Promise.resolve(job);
  }
  const existing = activeExportArtifactPublishJobPromises.get(job.job_id);
  if (existing) return existing;

  activeExportArtifactPublishJobIds.add(job.job_id);
  const queued = exportArtifactPublishQueue
    .catch(() => undefined)
    .then(() => runAppExportArtifactPublishJob(job));
  exportArtifactPublishQueue = queued.catch(() => undefined);
  const tracked = queued.finally(() => {
    activeExportArtifactPublishJobIds.delete(job.job_id);
    activeExportArtifactPublishJobPromises.delete(job.job_id);
  });
  activeExportArtifactPublishJobPromises.set(job.job_id, tracked);
  return tracked;
}

async function toolAppRunExportArtifactPublish(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const artifactType = args.artifact_type;
  if (artifactType !== "pptx" && artifactType !== "pdf") {
    throw new Error('"artifact_type" must be "pptx" or "pdf"');
  }

  let current = await getAppExportArtifactPublishStatus({
    workspace_dir: workspaceDir,
    artifact_type: artifactType,
  });
  if (isExportArtifactPublishJobRunning(current) && !activeExportArtifactPublishJobIds.has(current.job_id)) {
    current = await markAppExportArtifactPublishJobInterrupted(current);
  }
  const job = await startAppExportArtifactPublish({
    workspace_dir: workspaceDir,
    artifact_type: artifactType,
  });
  if (job.status === "completed") return job;
  if (job.status === "failed") {
    throw new Error(job.error?.message || job.message || "Export artifact publication failed");
  }

  await awaitAppExportArtifactPublishJob(job);
  const completed = await getAppExportArtifactPublishStatus({
    workspace_dir: workspaceDir,
    artifact_type: artifactType,
  });
  if (completed.status === "completed") return completed;
  throw new Error(completed.error?.message || completed.message || "Export artifact publication failed");
}

async function toolAppStartExportArtifactPublish(args) {
  return toolAppRunExportArtifactPublish(args);
}

async function toolAppGetExportArtifactPublishStatus(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const artifactType = args.artifact_type;
  if (artifactType !== "pptx" && artifactType !== "pdf") {
    throw new Error('"artifact_type" must be "pptx" or "pdf"');
  }
  const current = await getAppExportArtifactPublishStatus({
    workspace_dir: workspaceDir,
    artifact_type: artifactType,
  });
  if (isExportArtifactPublishJobRunning(current) && !activeExportArtifactPublishJobIds.has(current.job_id)) {
    return markAppExportArtifactPublishJobInterrupted(current);
  }
  return current;
}

async function toolAppGetExportArtifactDownloadUrl(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const artifactType = args.artifact_type;
  if (artifactType !== "pptx" && artifactType !== "pdf") {
    throw new Error('"artifact_type" must be "pptx" or "pdf"');
  }

  const status = await getAppExportArtifactMirrorStatus({
    workspace_dir: workspaceDir,
    artifact_type: artifactType,
  });
  if (status.status !== "ready" || !status.mirror) {
    return {
      status: status.status,
      reason: status.reason,
      artifact: status.artifact,
      mirror: status.mirror,
      download_url: null,
      expires_at: null,
    };
  }
  const transferLogger = createApsTransferLogger({
    workspaceDir,
    source: "ppt-engine.export-artifact-download-url",
    filename: status.artifact.filename,
    mimeType: status.mirror.content_type,
    sizeBytes: status.mirror.size_bytes,
    path: status.mirror.path,
    operationId: `app_get_export_artifact_download_url:${artifactType}`,
  });
  transferLogger.log("started", "started", { aps_path: status.mirror.path, artifact_type: artifactType });
  try {
    const download = await apsFilesClient.downloadUrl({
      path: status.mirror.path,
      expiresIn: 600,
      scope: APS_FILES_DOWNLOAD_SCOPE,
    });
    if (!download || typeof download.url !== "string" || download.url.length === 0) {
      throw new Error("files/download_url did not return a valid URL");
    }
    transferLogger.log("download_url", "succeeded", {
      aps_path: status.mirror.path,
      response: redactStorageResponse(download),
    });
    transferLogger.log("finished", "succeeded", { aps_path: status.mirror.path, expires_at: download.expires_at });
    return {
      status: "ready",
      reason: null,
      artifact: status.artifact,
      mirror: status.mirror,
      download_url: download.url,
      expires_at: typeof download.expires_at === "string" ? download.expires_at : null,
    };
  } catch (error) {
    transferLogger.log("download_url", "failed", { aps_path: status.mirror.path, error: storageErrorRecord(error) });
    throw error;
  }
}

function isWorkspaceSnapshotPublishRunning(job) {
  return job && ["queued", "preparing", "uploading", "committing"].includes(job.status);
}

const MAX_SNAPSHOT_VERIFY_ATTEMPTS = 5;

function snapshotVerifyBackoffMs(attempt) {
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function uploadWorkspaceSnapshotZip(job, workspaceId, transferLogger) {
  const upload = await apsFilesClient.uploadBegin({
    path: job.aps_path,
    sizeBytes: job.snapshot_size_bytes,
    contentType: "application/zip",
    scope: APS_FILES_DOWNLOAD_SCOPE,
    metadata: {
      workspace_id: workspaceId,
      artifact_type: "workspace_snapshot",
      revision: job.revision,
      source_updated_at: job.source_updated_at,
      source_sha256: job.source_sha256,
      snapshot_sha256: job.snapshot_sha256,
    },
  });
  if (!upload || typeof upload.put_url !== "string" || upload.put_url.length === 0) {
    throw new Error("files/upload_begin did not return a valid put_url");
  }
  transferLogger.log("negotiate", "succeeded", { response: redactStorageResponse(upload), aps_path: job.aps_path });
  const putResponse = await fetch(upload.put_url, {
    method: "PUT",
    headers: {
      ...(upload.headers ?? {}),
      "Content-Length": String(job.snapshot_size_bytes),
    },
    body: createReadStream(job.snapshot_path),
    duplex: "half",
  });
  if (!putResponse.ok) {
    const message = await putResponse.text().catch(() => "");
    throw new Error(message || `APS Files PUT failed: HTTP ${putResponse.status}`);
  }
  transferLogger.log("put", "succeeded", { http_status: putResponse.status, aps_path: job.aps_path });
  const putEtag = putResponse.headers.get("etag") ?? undefined;
  const completed = await apsFilesClient.uploadComplete({
    path: job.aps_path,
    etag: putEtag,
    sizeBytes: job.snapshot_size_bytes,
    contentType: "application/zip",
    scope: APS_FILES_DOWNLOAD_SCOPE,
  });
  transferLogger.log("commit", "succeeded", { response: redactStorageResponse(completed), aps_path: job.aps_path });
  return { completed, putEtag };
}

function workspaceSnapshotAttachmentPath(workspaceId, contentHash) {
  return `workspaces/${workspaceId}/attachments/${contentHash}`;
}

async function verifyApsAttachmentHash(apsPath, expectedHash, expectedSize) {
  const download = await apsFilesClient.downloadUrl({
    path: apsPath,
    expiresIn: 600,
    scope: APS_FILES_DOWNLOAD_SCOPE,
  });
  if (!download?.url) throw new Error(`files/download_url did not return a URL for attachment ${expectedHash}`);
  const response = await fetch(download.url, { cache: "no-store" });
  if (!response.ok || !response.body) throw new Error(`APS attachment verification download failed: HTTP ${response.status}`);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    const bytes = Buffer.from(chunk);
    hash.update(bytes);
    size += bytes.length;
  }
  if (size !== expectedSize || hash.digest("hex") !== expectedHash) {
    throw new Error(`APS attachment verification mismatch for ${expectedHash}`);
  }
}

async function uploadWorkspaceSnapshotAttachments(job, workspaceId, transferLogger) {
  const uploaded = new Set();
  for (const attachment of job.attachments ?? []) {
    if (!attachment?.content_hash || uploaded.has(attachment.content_hash)) continue;
    const bodyPath = path.join(job.workspace_dir, ...String(attachment.restore_path).split("/"));
    const info = await stat(bodyPath);
    if (!info.isFile() || info.size !== attachment.size_bytes || await sha256File(bodyPath) !== attachment.content_hash) {
      throw new Error(`Frozen snapshot attachment changed or disappeared: ${attachment.restore_path}`);
    }
    const apsPath = workspaceSnapshotAttachmentPath(workspaceId, attachment.content_hash);
    await uploadApsSnapshotWithRetry({
      snapshot: {
        filename: path.basename(attachment.restore_path),
        content_type: "application/octet-stream",
        size_bytes: attachment.size_bytes,
        aps_path: apsPath,
      },
      bodyPath,
      workspaceDir: job.workspace_dir,
      source: "ppt-engine.workspace-snapshot-attachment",
      operationId: `app_run_workspace_snapshot_attachment:${attachment.content_hash}`,
      metadata: {
        workspace_id: workspaceId,
        artifact_type: "workspace_snapshot_attachment",
        content_sha256: attachment.content_hash,
      },
    });
    await verifyApsAttachmentHash(apsPath, attachment.content_hash, attachment.size_bytes);
    transferLogger.log("attachment", "succeeded", { aps_path: apsPath, content_hash: attachment.content_hash });
    uploaded.add(attachment.content_hash);
  }
}

/**
 * Download the just-uploaded snapshot back and verify it against its own
 * manifest. Returns { ok: true, verification } when the package round-tripped
 * intact, or { ok: false, kind, reason } where kind is "transit_corruption"
 * (the uploaded bytes differ from the local zip whose file is intact — re-upload
 * the same zip) or "local_bad" (the zip we built or its file on disk is bad — it
 * must be regenerated before re-uploading). Throws on I/O / network failures.
 */
async function verifyUploadedWorkspaceSnapshotZip(job, workspaceId, transferLogger) {
  const verifyDir = path.join(path.dirname(job.workspace_dir), ".snapshot-verify", workspaceId);
  const verifyZip = path.join(verifyDir, `${job.revision}.zip`);
  try {
    await mkdir(verifyDir, { recursive: true });
    const verifyDownload = await apsFilesClient.downloadUrl({
      path: job.aps_path,
      expiresIn: 600,
      scope: APS_FILES_DOWNLOAD_SCOPE,
    });
    if (!verifyDownload || typeof verifyDownload.url !== "string" || verifyDownload.url.length === 0) {
      throw new Error("files/download_url did not return a valid URL for upload verification");
    }
    const verifyResponse = await fetch(verifyDownload.url, { cache: "no-store" });
    if (!verifyResponse.ok) {
      const message = await verifyResponse.text().catch(() => "");
      throw new Error(message || `APS Files verification download failed: HTTP ${verifyResponse.status}`);
    }
    if (!verifyResponse.body) {
      throw new Error("APS Files verification download returned an empty body");
    }
    await pipeline(Readable.fromWeb(verifyResponse.body), createWriteStream(verifyZip));
    const verification = await verifyAppWorkspaceSnapshotZip({
      zip_path: verifyZip,
      expected_workspace_id: workspaceId,
      expected_source_sha256: typeof job.source_sha256 === "string" ? job.source_sha256 : undefined,
    });
    if (verification.ok) {
      transferLogger.log("verify", "succeeded", {
        file_count: verification.file_count,
        snapshot_sha256: verification.snapshot_sha256,
        all_files_verified: verification.all_files_verified,
      });
      return { ok: true, verification };
    }
    const kind = await classifySnapshotVerifyFailure(job, verification);
    const reason = verification.reason ?? "snapshot failed verification";
    transferLogger.log("verify", "failed", { kind, reason });
    return { ok: false, kind, reason };
  } finally {
    await rm(verifyDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function classifySnapshotVerifyFailure(job, verification) {
  const downloadedSha = typeof verification.snapshot_sha256 === "string" ? verification.snapshot_sha256 : "";
  const recordedSha = typeof job.snapshot_sha256 === "string" ? job.snapshot_sha256 : "";
  if (recordedSha.length > 0 && downloadedSha !== recordedSha) {
    // The uploaded bytes differ from what the engine recorded at build time.
    // Distinguish a mangled round-trip (local zip file intact → re-upload) from
    // a local zip file that diverged from its recorded hash (→ regenerate).
    let localSha = null;
    try {
      localSha = await sha256File(job.snapshot_path);
    } catch {
      localSha = null;
    }
    return localSha === recordedSha ? "transit_corruption" : "local_bad";
  }
  // Bytes match what we built but the structure/schema is broken: re-uploading
  // the same bytes cannot fix it, so the zip must be regenerated.
  return "local_bad";
}

async function regenerateSnapshotZipForJob(job) {
  const refreshed = await regenerateAppWorkspaceSnapshot({ workspace_dir: job.workspace_dir });
  if (!refreshed || refreshed.status === "failed" || !refreshed.snapshot_path || !refreshed.aps_path) {
    throw new Error(
      `Failed to regenerate the local snapshot zip for re-upload${refreshed?.error?.message ? `: ${refreshed.error.message}` : ""}`,
    );
  }
  return { ...job, ...refreshed };
}

function snapshotUploadTestGatePath(workspaceDir) {
  return path.join(
    path.dirname(path.resolve(workspaceDir)),
    ".snapshot-sync",
    path.basename(workspaceDir),
    SNAPSHOT_UPLOAD_TEST_GATE_FILENAME,
  );
}

async function readSnapshotUploadTestGate(workspaceDir) {
  const gatePath = snapshotUploadTestGatePath(workspaceDir);
  let raw;
  try {
    raw = await readFile(gatePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Snapshot upload test gate is not valid JSON: ${gatePath}`);
  }
  if (!value || typeof value !== "object" || !["armed", "paused", "released"].includes(value.status)) {
    throw new Error(`Snapshot upload test gate has an invalid status: ${gatePath}`);
  }
  return value;
}

async function writeSnapshotUploadTestGate(workspaceDir, value) {
  const gatePath = snapshotUploadTestGatePath(workspaceDir);
  await mkdir(path.dirname(gatePath), { recursive: true });
  await writeFile(gatePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function pauseWorkspaceSnapshotUploadForTest(job) {
  const armed = await readSnapshotUploadTestGate(job.workspace_dir);
  if (!armed || armed.status !== "armed") return;

  await writeSnapshotUploadTestGate(job.workspace_dir, {
    ...armed,
    status: "paused",
    job_id: job.job_id,
    paused_at: new Date().toISOString(),
  });
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_UPLOAD_TEST_GATE_POLL_MS));
    const gate = await readSnapshotUploadTestGate(job.workspace_dir);
    // Deleting the control file is the emergency escape hatch; it must never
    // leave a production upload waiting merely because a developer test ended.
    if (!gate || gate.status === "released") return;
  }
}

async function runAppWorkspaceSnapshotPublishJob(job) {
  let transferLogger = null;
  let currentJob = job;
  try {
    await writeAppWorkspaceSnapshotPublish({
      workspace_dir: currentJob.workspace_dir,
      publish: { ...currentJob, status: "preparing", error: null },
    });
    if (!currentJob.snapshot_path || !currentJob.aps_path) {
      throw new Error("Snapshot publication job is missing its snapshot_path or aps_path");
    }
    const workspaceId = path.basename(currentJob.workspace_dir);
    transferLogger = createApsTransferLogger({
      workspaceDir: currentJob.workspace_dir,
      source: "ppt-engine.workspace-snapshot-publish",
      filename: `${currentJob.revision}.zip`,
      mimeType: "application/zip",
      sizeBytes: currentJob.snapshot_size_bytes,
      path: currentJob.aps_path,
      operationId: `app_run_workspace_snapshot_publish_dedicated_invoke:${currentJob.revision}`,
    });
    transferLogger.log("started", "started", { aps_path: currentJob.aps_path, revision: currentJob.revision });

    // The pointer is not allowed to reference a ZIP whose external attachment
    // bodies are absent or corrupt. Upload and verify the frozen blobs first.
    await uploadWorkspaceSnapshotAttachments(currentJob, workspaceId, transferLogger);

    // Upload + verify with retry (design doc §2). The uploaded package is only
    // trusted after it round-trips intact, so meta.json is never flipped to a
    // revision that failed verification. Failures are retried up to
    // MAX_SNAPSHOT_VERIFY_ATTEMPTS with exponential backoff: transit corruption
    // re-uploads the same local zip, a bad local zip is force-regenerated first.
    let verifiedUpload = null;
    for (let attempt = 1; attempt <= MAX_SNAPSHOT_VERIFY_ATTEMPTS; attempt += 1) {
      try {
        await writeAppWorkspaceSnapshotPublish({
          workspace_dir: currentJob.workspace_dir,
          publish: { ...currentJob, status: "uploading", error: null },
        });

        const uploadRound = await uploadWorkspaceSnapshotZip(currentJob, workspaceId, transferLogger);
        const round = await verifyUploadedWorkspaceSnapshotZip(currentJob, workspaceId, transferLogger);
        if (round.ok) {
          verifiedUpload = uploadRound;
          break;
        }
        if (attempt >= MAX_SNAPSHOT_VERIFY_ATTEMPTS) {
          throw new Error(
            `Uploaded snapshot failed verification after ${MAX_SNAPSHOT_VERIFY_ATTEMPTS} attempts (${round.kind}): ${round.reason}`,
          );
        }
        transferLogger.log("verify", "will-retry", { attempt, kind: round.kind, reason: round.reason });
        if (round.kind === "local_bad") {
          // The zip we built (or its file on disk) is bad; re-uploading the same
          // bytes cannot succeed, so regenerate the zip before the next attempt.
          currentJob = await regenerateSnapshotZipForJob(currentJob);
          await uploadWorkspaceSnapshotAttachments(currentJob, workspaceId, transferLogger);
        }
        await new Promise((resolve) => setTimeout(resolve, snapshotVerifyBackoffMs(attempt)));
      } catch (error) {
        transferLogger.log("verify", "failed", { attempt, error: storageErrorRecord(error) });
        if (attempt >= MAX_SNAPSHOT_VERIFY_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, snapshotVerifyBackoffMs(attempt)));
      }
    }
    if (!verifiedUpload) {
      throw new Error("Snapshot publication did not reach a verified upload");
    }
    const { completed, putEtag } = verifiedUpload;

    await pauseWorkspaceSnapshotUploadForTest(currentJob);

    // meta.json (the APS-side workspace pointer) is uploaded before the local
    // commit so a crash can never mark a snapshot synced without its pointer.
    const metaBody = typeof currentJob.meta_json === "string" ? currentJob.meta_json : "";
    const metaBytes = Buffer.byteLength(metaBody, "utf8");
    let metaEtag = "";
    if (metaBytes > 0) {
      const metaUpload = await apsFilesClient.uploadBegin({
        path: currentJob.aps_meta_path,
        sizeBytes: metaBytes,
        contentType: "application/json",
        scope: APS_FILES_DOWNLOAD_SCOPE,
        metadata: {
          workspace_id: workspaceId,
          artifact_type: "workspace_snapshot_meta",
          revision: currentJob.revision,
          source_sha256: currentJob.source_sha256,
          fingerprint_algo: currentJob.fingerprint_algo,
        },
      });
      if (!metaUpload || typeof metaUpload.put_url !== "string" || metaUpload.put_url.length === 0) {
        throw new Error("files/upload_begin did not return a valid put_url for the snapshot meta.json");
      }
      const metaPut = await fetch(metaUpload.put_url, {
        method: "PUT",
        headers: {
          ...(metaUpload.headers ?? {}),
          "Content-Length": String(metaBytes),
          "Content-Type": "application/json",
        },
        body: metaBody,
        duplex: "half",
      });
      if (!metaPut.ok) {
        const message = await metaPut.text().catch(() => "");
        throw new Error(message || `APS Files PUT failed for meta.json: HTTP ${metaPut.status}`);
      }
      const metaPutEtag = metaPut.headers.get("etag") ?? undefined;
      const metaCompleted = await apsFilesClient.uploadComplete({
        path: currentJob.aps_meta_path,
        etag: metaPutEtag,
        sizeBytes: metaBytes,
        contentType: "application/json",
        scope: APS_FILES_DOWNLOAD_SCOPE,
      });
      metaEtag = typeof metaCompleted?.etag === "string" ? metaCompleted.etag : metaPutEtag ?? "";
      transferLogger.log("commit", "succeeded", { response: redactStorageResponse(metaCompleted), aps_path: currentJob.aps_meta_path });
    }

    await writeAppWorkspaceSnapshotPublish({
      workspace_dir: currentJob.workspace_dir,
      publish: { ...currentJob, status: "committing", error: null },
    });
    const mirror = {
      provider: "aps.files",
      scope: APS_FILES_DOWNLOAD_SCOPE,
      path: currentJob.aps_path,
      etag: typeof completed?.etag === "string" ? completed.etag : putEtag ?? "",
      size_bytes: Number.isFinite(Number(completed?.size_bytes))
        ? Math.floor(Number(completed.size_bytes))
        : currentJob.snapshot_size_bytes,
      content_type: "application/zip",
      source_updated_at: currentJob.source_updated_at,
      source_sha256: currentJob.source_sha256,
      fingerprint_algo: currentJob.fingerprint_algo,
      published_at: new Date().toISOString(),
      meta_path: currentJob.aps_meta_path,
      meta_etag: metaEtag,
    };
    const committed = await commitAppWorkspaceSnapshotPublish({
      workspace_dir: currentJob.workspace_dir,
      expected_job_id: currentJob.job_id,
      expected_updated_at: currentJob.source_updated_at,
      expected_sha256: currentJob.source_sha256,
      mirror,
    });

    // Design doc §3: prune old versions only AFTER verify + meta + commit,
    // keeping the current revision and the single most recent previous one (APS
    // always holds 2 packages). Best-effort — a failed delete leaves a harmless
    // extra object that the next publish will prune.
    try {
      await pruneOldWorkspaceSnapshotVersions(currentJob, workspaceId, transferLogger);
    } catch (error) {
      transferLogger.log("prune", "failed", { error: storageErrorRecord(error) });
    }
    transferLogger.log("finished", "succeeded", { aps_path: currentJob.aps_path, revision: currentJob.revision, etag: committed.mirror?.etag ?? mirror.etag });
    return committed;
  } catch (error) {
    // TODO(§4，暂缓): 发布失败时用户提示尚未实现（设计文档「快照上传校验与删除策略」§4）。
    // 预期：非阻塞提示「云端备份失败，编辑已保存至本地」，云端恢复后自动消除；
    // 属 app 前端（useDeckWorkspace.ts / messages.ts），本期只写 publish 状态 + 传输日志。
    transferLogger?.log("unknown", "failed", { aps_path: currentJob.aps_path, error: storageErrorRecord(error) });
    await writeAppWorkspaceSnapshotPublish({
      workspace_dir: currentJob.workspace_dir,
      publish: {
        ...currentJob,
        status: "failed",
        completed_at: new Date().toISOString(),
        error: {
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        },
      },
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * Delete APS snapshot packages older than the current revision plus the single
 * most recent previous one, so the workspace keeps exactly two recoverable
 * packages. Runs strictly after a verified upload + meta pointer + local commit
 * so a crash can never leave the cloud with no valid snapshot. Best-effort.
 */
async function pruneOldWorkspaceSnapshotVersions(currentJob, workspaceId, transferLogger) {
  const prefix = `${APS_MY_WORK_PREFIX}${workspaceId}/snapshots/`;
  const listed = await apsFilesClient.list({ prefix, scope: APS_FILES_DOWNLOAD_SCOPE, limit: 1000 });
  const listedKeys = Array.isArray(listed) ? "array" : typeof listed === "object" && listed ? Object.keys(listed).join(",") : String(typeof listed);
  const rawEntries = Array.isArray(listed?.entries)
    ? listed.entries
    : Array.isArray(listed?.objects)
      ? listed.objects
      : Array.isArray(listed?.items)
        ? listed.items
        : Array.isArray(listed?.files)
          ? listed.files
          : Array.isArray(listed?.data)
            ? listed.data
            : Array.isArray(listed)
              ? listed
              : [];
  transferLogger.log("prune", "listed", { prefix, shape: listedKeys, count: rawEntries.length });
  const snapshotPaths = [];
  for (const entry of rawEntries) {
    const entryPath = entry && (typeof entry === "string" ? entry : (entry.path ?? entry.key ?? entry.name));
    if (typeof entryPath !== "string") continue;
    // Listed paths may carry a leading scope prefix (e.g. "user/workspaces/..."),
    // so locate the "workspaces/" segment instead of anchoring at position 0.
    const idx = entryPath.indexOf(APS_MY_WORK_PREFIX);
    const relative = idx >= 0 ? entryPath.slice(idx) : entryPath;
    const match = /^workspaces\/[^/]+\/snapshots\/([0-9]+)\.zip$/.exec(relative);
    if (!match) continue;
    snapshotPaths.push({ path: entryPath, revision: match[1] });
  }
  snapshotPaths.sort((a, b) => Number(b.revision) - Number(a.revision));
  const currentRevision = typeof currentJob.revision === "string" ? currentJob.revision : null;
  const kept = new Set();
  if (currentRevision) kept.add(currentRevision);
  let keptPrevious = 0;
  for (const snap of snapshotPaths) {
    if (snap.revision === currentRevision) continue;
    if (keptPrevious < 1) {
      kept.add(snap.revision);
      keptPrevious += 1;
      continue;
    }
    break;
  }
  const deleted = [];
  for (const snap of snapshotPaths) {
    if (kept.has(snap.revision)) continue;
    try {
      const result = await apsFilesClient.delete({ path: snap.path, scope: APS_FILES_DOWNLOAD_SCOPE });
      transferLogger.log("prune", "delete", { path: snap.path, response: redactStorageResponse(result) });
      // The host may confirm via "deleted", "ok", or a bare path echo; treat any
      // resolved call as deleted and let the response log tell us the real shape.
      deleted.push(snap.revision);
    } catch (error) {
      transferLogger.log("prune", "delete-failed", { path: snap.path, error: storageErrorRecord(error) });
    }
  }
  transferLogger.log("prune", "succeeded", {
    listed: rawEntries.length,
    found: snapshotPaths.length,
    deleted: deleted.length,
    kept: [...kept],
  });
  return { deleted };
}

function awaitAppWorkspaceSnapshotPublishJob(job) {
  if (!job) return Promise.resolve(job);
  const existing = activeWorkspaceSnapshotPublishJobPromises.get(job.job_id);
  if (existing) return existing;
  if (!isWorkspaceSnapshotPublishRunning(job)) return Promise.resolve(job);

  activeWorkspaceSnapshotPublishJobIds.add(job.job_id);
  const queued = workspaceSnapshotPublishQueue
    .catch(() => undefined)
    .then(() => runAppWorkspaceSnapshotPublishJob(job));
  workspaceSnapshotPublishQueue = queued.catch(() => undefined);
  const tracked = queued
    .then((result) => {
      // A later local snapshot can have been generated while this job carried
      // an older immutable ZIP. Drain the per-workspace backlog immediately
      // after a successful commit; never require another user navigation or a
      // future editor save to discover N+1.
      scheduleAutoPublishSweep({ force: true });
      return result;
    })
    .finally(() => {
      activeWorkspaceSnapshotPublishJobIds.delete(job.job_id);
      activeWorkspaceSnapshotPublishJobPromises.delete(job.job_id);
    });
  activeWorkspaceSnapshotPublishJobPromises.set(job.job_id, tracked);
  return tracked;
}

const SNAPSHOT_TRANSIENT_GENERATION_ERROR = /source (changed|disappeared) while building/i;

async function startAppWorkspaceSnapshotPublishWithTransientRetry(workspaceDir) {
  try {
    return await startAppWorkspaceSnapshotPublish({ workspace_dir: workspaceDir });
  } catch (error) {
    if (error instanceof Error && SNAPSHOT_TRANSIENT_GENERATION_ERROR.test(error.message)) {
      // The source files changed while the zip was being built (e.g. the user
      // saved an edit mid-build), so the engine aborted to avoid an inconsistent
      // snapshot. Re-collecting on a now-stable tree usually succeeds.
      await new Promise((resolve) => setTimeout(resolve, 750));
      return await startAppWorkspaceSnapshotPublish({ workspace_dir: workspaceDir });
    }
    throw error;
  }
}

async function publishWorkspaceSnapshotNow(workspaceDir) {
  let current = await getAppWorkspaceSnapshotPublishStatus({ workspace_dir: workspaceDir });
  if (isWorkspaceSnapshotPublishRunning(current) && !activeWorkspaceSnapshotPublishJobIds.has(current.job_id)) {
    current = await markAppWorkspaceSnapshotPublishJobInterrupted({ workspace_dir: workspaceDir });
  }
  const job = await startAppWorkspaceSnapshotPublishWithTransientRetry(workspaceDir);
  if (job.status === "completed") return job;
  if (job.status === "failed") {
    throw new Error(job.error?.message || "Workspace snapshot publication failed");
  }

  await awaitAppWorkspaceSnapshotPublishJob(job);
  const completed = await getAppWorkspaceSnapshotPublishStatus({ workspace_dir: workspaceDir });
  if (completed.status === "completed") return completed;
  throw new Error(completed.error?.message || "Workspace snapshot publication failed");
}

function publishWorkspaceSnapshotThroughDedicatedInvoke(workspaceDir) {
  const normalizedDir = path.normalize(workspaceDir);
  const existing = activeWorkspaceSnapshotDedicatedPublishPromises.get(normalizedDir);
  if (existing) return existing;
  const started = publishWorkspaceSnapshotNow(workspaceDir);
  const tracked = started.finally(() => {
    if (activeWorkspaceSnapshotDedicatedPublishPromises.get(normalizedDir) === tracked) {
      activeWorkspaceSnapshotDedicatedPublishPromises.delete(normalizedDir);
    }
  });
  activeWorkspaceSnapshotDedicatedPublishPromises.set(normalizedDir, tracked);
  return tracked;
}

// Uses the established publisher and queue, but owns an independent Host
// invoke for its entire lifetime. The legacy automatic publisher stays active
// during rollout.
async function toolAppRunWorkspaceSnapshotPublishDedicatedInvoke(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const trigger = readRequiredStringArg(args, "trigger");
  const lifecycleId = `snapshot-publish-dedicated-invoke-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const invokeId = getCurrentInvokeId();
  const normalizedWorkspaceDir = path.normalize(workspaceDir);
  const reusesDedicatedPublisher = activeWorkspaceSnapshotDedicatedPublishPromises.has(normalizedWorkspaceDir);
  const baseEntry = {
    schema_version: 1,
    source: "ppt-engine.workspace-snapshot-publish-dedicated-invoke",
    lifecycle_id: lifecycleId,
    trigger,
    invoke_context: invokeId ? "bound" : "missing",
    // An opaque Host correlation id, not an authorization token.
    invoke_id: invokeId ?? null,
    reuses_dedicated_publisher: reusesDedicatedPublisher,
    upload_started: true,
  };
  activeWorkspaceSnapshotDedicatedPublishInvokeIds.add(lifecycleId);
  let completed = false;
  let failure = null;
  let publishResult = null;
  try {
    await runWithRequiredLifecycleLogging(() => appendAppWorkspaceLog({
      workspace_dir: workspaceDir,
      channel: "storage-transport",
      entry: {
        ...baseEntry,
        event: "snapshot.publish-dedicated-invoke.started",
        status: "started",
        started_at: startedAt,
      },
    }));
    const result = await publishWorkspaceSnapshotThroughDedicatedInvoke(workspaceDir);
    publishResult = result;
    completed = true;
    return result;
  } catch (error) {
    failure = storageErrorRecord(error);
    throw error;
  } finally {
    activeWorkspaceSnapshotDedicatedPublishInvokeIds.delete(lifecycleId);
    await runWithRequiredLifecycleLogging(() => appendAppWorkspaceLog({
      workspace_dir: workspaceDir,
      channel: "storage-transport",
      entry: {
        ...baseEntry,
        event: "snapshot.publish-dedicated-invoke.finished",
        status: completed ? "completed" : "failed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        invoke_released: true,
        active_dedicated_invoke_count: activeWorkspaceSnapshotDedicatedPublishInvokeIds.size,
        publish_status: publishResult?.status ?? null,
        publish_job_id: publishResult?.job_id ?? null,
        published_revision: publishResult?.revision ?? null,
        ...(failure ? { error: failure } : {}),
      },
    }));
  }
}

// Auto-upload: whenever a snapshot is generated (by any generation trigger),
// sweep every workspace's snapshot-sync state and publish any snapshot that is
// not yet synced to APS. startAppWorkspaceSnapshotPublish already awaits the
// per-workspace generation queue and skips completed+synced. Retry cadence is
// persisted by the engine, rather than being an accidental property of this
// process's sweep cadence.
let lastAutoPublishSweepAt = 0;
const AUTO_PUBLISH_SWEEP_MIN_INTERVAL_MS = 2000;

// Retry accounting is persisted in snapshot-sync.json and keyed by change_seq.
// Timers merely wake this process sooner; after a restart the ten-second sweep
// reads the same next_retry_at and resumes without granting a fresh budget.
const snapshotRetryTimers = new Map();
const activeAutoPublishWorkspaceOperations = new Map();

function scheduleSnapshotRetryWakeup(workspaceId, retry) {
  const existing = snapshotRetryTimers.get(workspaceId);
  if (existing) clearTimeout(existing);
  snapshotRetryTimers.delete(workspaceId);
  if (!retry || retry.exhausted || !retry.next_retry_at) return;
  const retryAt = Date.parse(retry.next_retry_at);
  if (!Number.isFinite(retryAt)) return;
  const timer = setTimeout(() => {
    snapshotRetryTimers.delete(workspaceId);
    scheduleAutoPublishSweep({ force: true });
  }, Math.max(0, retryAt - Date.now()));
  snapshotRetryTimers.set(workspaceId, timer);
}

function snapshotRetryBlocksWork(state) {
  const retry = state?.retry;
  if (!retry) return false;
  if (retry.exhausted) return true;
  if (!retry.next_retry_at) return false;
  const retryAt = Date.parse(retry.next_retry_at);
  return Number.isFinite(retryAt) && retryAt > Date.now();
}

async function recordSnapshotRetry(workspaceId, workspaceDir, phase, error) {
  const retry = await recordAppWorkspaceSnapshotRetry({
    workspace_dir: workspaceDir,
    phase,
    error: error instanceof Error ? error.message : String(error),
  });
  scheduleSnapshotRetryWakeup(workspaceId, retry);
  if (retry.exhausted) {
    console.error(`[snapshot-auto-publish] retry budget exhausted for workspace ${workspaceId}:`, retry.last_error);
  }
  return retry;
}

function beginAutoPublishWorkspaceOperation(workspaceId, operation) {
  if (activeAutoPublishWorkspaceOperations.has(workspaceId)) return false;
  const tracked = Promise.resolve()
    .then(operation)
    .finally(() => activeAutoPublishWorkspaceOperations.delete(workspaceId));
  activeAutoPublishWorkspaceOperations.set(workspaceId, tracked);
  // Each caller owns/report its failure. Attaching this handler ensures an
  // operation begun by a sweep cannot become an unhandled rejection between
  // the sweep tick and that caller's catch handler.
  tracked.catch(() => undefined);
  return true;
}

async function retryPhaseAfterFailure(workspaceDir, fallback) {
  const latest = await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir }).catch(() => null);
  if (latest?.semantic_validation_failed) return "semantic_validation";
  if (Number.isInteger(latest?.pending_change_seq)) return "generation";
  return fallback;
}

async function shouldSpendUploadRetryBudget(workspaceDir, attemptedState) {
  const latest = await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir }).catch(() => null);
  if (!latest) return false;
  // An old N transport can fail after a local N+1 has either been generated
  // or merely marked dirty. That failure must not consume N+1's budget (and
  // must not overwrite an existing N+1 retry record): the next sweep should
  // generate/upload the newer candidate instead.
  return latest.source_sha256 === attemptedState.source_sha256 &&
    latest.generated_change_seq === attemptedState.generated_change_seq &&
    !(Number.isInteger(latest.pending_change_seq) && latest.pending_change_seq > attemptedState.generated_change_seq);
}

function snapshotNeedsUpload(state) {
  if (!state || state.status !== "completed" || !state.revision || !state.snapshot_path) return false;
  // A completed state can still describe the last known-good snapshot while a
  // newer candidate was rejected. Do not publish the stale snapshot as if it
  // represented the current workspace; retry local validation first.
  if (state.semantic_validation_failed) return false;
  // Never publish a workspace whose restore is mid-flight or failed: a broken
  // scaffold (restore failed to populate the dir) must not clobber the good
  // cloud snapshot with an empty shell.
  if (state.restore && isWorkspaceSnapshotRestoreRunning(state.restore)) return false;
  if (state.restore?.status === "failed") return false;
  if (state.synced_baseline?.source_sha256 === state.source_sha256) return false;
  if (isWorkspaceSnapshotPublishRunning(state.publish) && activeWorkspaceSnapshotPublishJobIds.has(state.publish.job_id)) return false;
  return true;
}

async function sweepAutoPublishPendingSnapshots() {
  let workspaceIds;
  try {
    const snapshotRoot = path.join(getDefaultAppWorkspaceRoot(), ".snapshot-sync");
    const entries = await readdir(snapshotRoot, { withFileTypes: true }).catch(() => []);
    workspaceIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    console.error("[snapshot-auto-publish] failed to enumerate snapshot workspaces:", storageErrorRecord(error));
    return;
  }
  for (const workspaceId of workspaceIds) {
    const workspaceDir = path.join(getDefaultAppWorkspaceRoot(), workspaceId);
    try {
      const state = await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
      if (snapshotRetryBlocksWork(state)) {
        scheduleSnapshotRetryWakeup(workspaceId, state.retry);
        continue;
      }
      if (state?.semantic_validation_failed) {
        if (!beginAutoPublishWorkspaceOperation(workspaceId, async () => {
          try {
            // A semantic failure is a rejected candidate, not a reason to
            // upload the prior verified ZIP. Force a fresh candidate only
            // after its persisted retry deadline has arrived.
            await regenerateAppWorkspaceSnapshot({ workspace_dir: workspaceDir });
            scheduleAutoPublishSweep({ force: true });
          } catch (error) {
            console.error(`[snapshot-auto-publish] semantic validation retry failed for workspace ${workspaceId}:`, storageErrorRecord(error));
            await recordSnapshotRetry(workspaceId, workspaceDir, "semantic_validation", error);
          }
        })) continue;
        continue;
      }
      if (Number.isInteger(state?.pending_change_seq)) {
        // A saved mutation has not yet made it into a ZIP. Rebuild locally
        // first; only a state with no pending change can reach the APS path.
        beginAutoPublishWorkspaceOperation(workspaceId, async () => {
          try {
            await publishAppWorkspaceSnapshot({ workspace_dir: workspaceDir });
            scheduleAutoPublishSweep({ force: true });
          } catch (error) {
            const phase = await retryPhaseAfterFailure(workspaceDir, "generation");
            console.error(`[snapshot-auto-publish] local build failed for workspace ${workspaceId}:`, storageErrorRecord(error));
            await recordSnapshotRetry(workspaceId, workspaceDir, phase, error);
          }
        });
        continue;
      }
      if (!snapshotNeedsUpload(state)) continue;
      const attemptedState = {
        source_sha256: state.source_sha256,
        generated_change_seq: state.generated_change_seq,
      };
      beginAutoPublishWorkspaceOperation(workspaceId, async () => {
        try {
          await publishWorkspaceSnapshotNow(workspaceDir);
          // awaitAppWorkspaceSnapshotPublishJob also schedules this, but this
          // covers an already-completed/resumed job without depending on that
          // implementation detail.
          scheduleAutoPublishSweep({ force: true });
        } catch (error) {
          console.error(`[snapshot-auto-publish] upload failed for workspace ${workspaceId}:`, storageErrorRecord(error));
          if (await shouldSpendUploadRetryBudget(workspaceDir, attemptedState)) {
            await recordSnapshotRetry(workspaceId, workspaceDir, "upload", error);
          } else {
            // The failure belongs to an obsolete package. Preserve the newer
            // change's untouched budget and immediately drain that backlog.
            scheduleAutoPublishSweep({ force: true });
          }
        }
      });
    } catch (error) {
      console.error(`[snapshot-auto-publish] sweep error for workspace ${workspaceId}:`, storageErrorRecord(error));
    }
  }
}

function scheduleAutoPublishSweep(options = {}) {
  const now = performance.now();
  if (!options.force && now - lastAutoPublishSweepAt < AUTO_PUBLISH_SWEEP_MIN_INTERVAL_MS) return;
  lastAutoPublishSweepAt = now;
  void sweepAutoPublishPendingSnapshots().catch((error) => {
    console.error("[snapshot-auto-publish] sweep failed:", storageErrorRecord(error));
  });
}

async function toolAppGetWorkspaceSnapshotPublishStatus(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const current = await getAppWorkspaceSnapshotPublishStatus({ workspace_dir: workspaceDir });
  if (isWorkspaceSnapshotPublishRunning(current) && !activeWorkspaceSnapshotPublishJobIds.has(current.job_id)) {
    return markAppWorkspaceSnapshotPublishJobInterrupted({ workspace_dir: workspaceDir });
  }
  return current;
}

// ---------------------------------------------------------------------------
// Workspace snapshot restore (design doc §7). Inbound mirror of the publish
// flow: the engine owns the state machine + extraction + atomic swap, the
// plugin resolves the APS target (explicit revision or latest from meta.json),
// downloads the zip, and drives the job states.
// ---------------------------------------------------------------------------

function isWorkspaceSnapshotRestoreRunning(job) {
  return job && ["queued", "downloading", "extracting", "committing"].includes(job.status);
}

/**
 * Resolve which snapshot to restore. An explicit `revision` maps directly to
 * `workspaces/{id}/snapshots/{revision}.zip`; otherwise the latest published
 * snapshot is read from the APS `meta.json` pointer (cheap, one small object).
 */
async function resolveWorkspaceSnapshotRestoreTarget({ workspaceDir, revision }) {
  const workspaceId = path.basename(workspaceDir);
  if (revision && typeof revision === "string" && revision.length > 0) {
    return {
      revision,
      aps_path: `workspaces/${workspaceId}/snapshots/${revision}.zip`,
      source_sha256: null,
      source_updated_at: null,
      fingerprint_algo: 1,
    };
  }
  const metaPath = `workspaces/${workspaceId}/meta.json`;
  const download = await apsFilesClient.downloadUrl({
    path: metaPath,
    expiresIn: 600,
    scope: APS_FILES_DOWNLOAD_SCOPE,
  });
  if (!download || typeof download.url !== "string" || download.url.length === 0) {
    throw new Error("files/download_url for the snapshot meta.json did not return a valid URL");
  }
  const response = await fetch(download.url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Snapshot meta.json download failed: HTTP ${response.status}`);
  }
  const meta = await response.json();
  const current = meta && typeof meta === "object" && meta.current_snapshot
    ? meta.current_snapshot
    : null;
  if (!current || typeof current.revision !== "string" || typeof current.aps_path !== "string") {
    throw new Error("Snapshot meta.json has no current_snapshot.revision/aps_path");
  }
  return {
    revision: current.revision,
    aps_path: current.aps_path,
    source_sha256: typeof current.source_sha256 === "string" ? current.source_sha256 : null,
    source_updated_at: typeof current.source_updated_at === "string" ? current.source_updated_at : null,
    fingerprint_algo: Number.isSafeInteger(current.fingerprint_algo) ? current.fingerprint_algo : 1,
  };
}

// After a restore, output/ (page previews, cover, deck.html) is gone because it
// is reconstructible and deliberately excluded from snapshots. Re-render page
// previews and the deck so the restored workspace is usable again without
// manual steps. Runs in the background so the restore tool returns promptly;
// the deck is rendered last because it reads each page's regenerated html.
const SNAPSHOT_RERENDER_POLL_INTERVAL_MS = 1000;
const SNAPSHOT_RERENDER_DECK_TIMEOUT_MS = 10 * 60_000;

async function workspacePathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadWorkspaceSnapshotAttachments({ workspaceId, attachments, shadowDir }) {
  const blobDir = path.join(path.dirname(shadowDir), "attachment-blobs");
  await mkdir(blobDir, { recursive: true });
  const downloaded = new Map();
  for (const attachment of attachments ?? []) {
    let blobPath = downloaded.get(attachment.content_hash);
    if (!blobPath) {
      const apsPath = workspaceSnapshotAttachmentPath(workspaceId, attachment.content_hash);
      const download = await apsFilesClient.downloadUrl({
        path: apsPath,
        expiresIn: 600,
        scope: APS_FILES_DOWNLOAD_SCOPE,
      });
      if (!download?.url) throw new Error(`files/download_url did not return a URL for attachment ${attachment.content_hash}`);
      const response = await fetch(download.url, { cache: "no-store" });
      if (!response.ok || !response.body) {
        const error = new Error(`Snapshot is incomplete: attachment ${attachment.content_hash} could not be downloaded`) ;
        error.code = "SNAPSHOT_INCOMPLETE_RESTORE_MISSING_ATTACHMENTS";
        throw error;
      }
      blobPath = path.join(blobDir, attachment.content_hash);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(blobPath));
      const info = await stat(blobPath);
      if (info.size !== attachment.size_bytes || await sha256File(blobPath) !== attachment.content_hash) {
        const error = new Error(`Snapshot attachment verification mismatch: ${attachment.content_hash}`);
        error.code = "SNAPSHOT_INCOMPLETE_RESTORE_MISSING_ATTACHMENTS";
        throw error;
      }
      downloaded.set(attachment.content_hash, blobPath);
    }
    const destination = path.join(shadowDir, ...String(attachment.restore_path).split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(blobPath, destination);
  }
}

async function waitForDeckRenderComplete(workspaceDir) {
  const deadline = Date.now() + SNAPSHOT_RERENDER_DECK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const progress = await getAppPageProgress({ workspace_dir: workspaceDir });
    const final = progress.final_deck_render;
    if (final.status === "completed" && final.deck_html_path && await workspacePathExists(final.deck_html_path)) return;
    if (final.status === "failed" || final.status === "interrupted") {
      throw new Error(`Final Deck render failed: ${final.error || final.message || final.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_RERENDER_POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out after ${SNAPSHOT_RERENDER_DECK_TIMEOUT_MS / 1000}s waiting for Final Deck render`);
}

async function regenerateWorkspacePreviewArtifacts(workspaceDir) {
  const startedAt = Date.now();
  const renderTimer = createRestoreStepTimer(workspaceDir, { revision: null });
  const failures = [];
  try {
    const result = await performAppWorkspacePagePreviews({ workspace_dir: workspaceDir });
    for (const page of result.pages) {
      renderTimer.step(`render_page:${page.page_id}`, {
        status: page.status === "render_failed" ? "failed" : "ok",
        duration_ms: page.duration_ms,
      });
    }
    const failedCount = result.pages.filter((page) => page.status === "render_failed").length;
    if (failedCount > 0) failures.push(new Error(`${failedCount} page preview(s) could not be rebuilt`));
    console.error(`[snapshot-auto-rerender] regenerated ${result.pages.length} page preview(s) in ${Math.round((Date.now() - startedAt) / 1000)}s (${failedCount} failed)`);
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
    console.error(`[snapshot-auto-rerender] page preview regeneration failed for ${workspaceDir}:`, storageErrorRecord(error));
  }
  try {
    await renderAppWorkspaceDeckHtml({ workspace_dir: workspaceDir });
    await waitForDeckRenderComplete(workspaceDir);
    console.error(`[snapshot-auto-rerender] deck HTML regenerated in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    renderTimer.step("render_deck", { status: "ok" });
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
    console.error(`[snapshot-auto-rerender] deck regeneration failed for ${workspaceDir}:`, storageErrorRecord(error));
  }
  return { ok: failures.length === 0, error: failures[0] ?? null };
}

function snapshotQueuePriority(priority) {
  return SNAPSHOT_QUEUE_PRIORITY[priority] ?? SNAPSHOT_QUEUE_PRIORITY.background;
}

function selectNextSnapshotQueueEntry(entries) {
  return [...entries.values()]
    .filter((entry) => entry.state === "pending")
    .sort((a, b) => b.priority - a.priority || a.sequence - b.sequence)[0] ?? null;
}

function queueWorkspacePreviewRegeneration({ workspaceDir, rebuild = null, priority = "background" }) {
  const key = rebuild?.job_id ?? `derived:${workspaceDir}`;
  const existing = pendingWorkspacePreviewRegenerations.get(key);
  if (existing) {
    existing.priority = Math.max(existing.priority, snapshotQueuePriority(priority));
    return existing;
  }
  const entry = {
    key,
    workspaceDir,
    rebuild,
    priority: snapshotQueuePriority(priority),
    sequence: workspacePreviewRegenerationQueueSequence += 1,
    state: "pending",
  };
  pendingWorkspacePreviewRegenerations.set(key, entry);
  void drainWorkspacePreviewRegenerationQueue();
  return entry;
}

async function runWorkspacePreviewRegenerationEntry(entry) {
  let rebuild = entry.rebuild;
  try {
    if (rebuild) {
      rebuild = await writeAppWorkspaceSnapshotRebuild({
        workspace_dir: entry.workspaceDir,
        rebuild: { ...rebuild, status: "running", updated_at: new Date().toISOString(), error: null },
      });
    }
    const result = await regenerateWorkspacePreviewArtifacts(entry.workspaceDir);
    if (rebuild) {
      await writeAppWorkspaceSnapshotRebuild({
        workspace_dir: entry.workspaceDir,
        rebuild: {
          ...rebuild,
          status: result.ok ? "completed" : "failed",
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          error: result.error ? { message: result.error.message, ...(result.error.stack ? { stack: result.error.stack } : {}) } : null,
        },
      });
    }
  } catch (error) {
    if (rebuild) {
      await writeAppWorkspaceSnapshotRebuild({
        workspace_dir: entry.workspaceDir,
        rebuild: {
          ...rebuild,
          status: "failed",
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          error: { message: error instanceof Error ? error.message : String(error), ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) },
        },
      }).catch(() => undefined);
    }
    console.error(`[snapshot-auto-rerender] lifecycle scheduling failed for ${entry.workspaceDir}:`, storageErrorRecord(error));
  }
}

async function drainWorkspacePreviewRegenerationQueue() {
  if (workspacePreviewRegenerationDraining) return;
  workspacePreviewRegenerationDraining = true;
  try {
    for (;;) {
      const entry = selectNextSnapshotQueueEntry(pendingWorkspacePreviewRegenerations);
      if (!entry) return;
      entry.state = "running";
      await runWorkspacePreviewRegenerationEntry(entry);
      pendingWorkspacePreviewRegenerations.delete(entry.key);
    }
  } finally {
    workspacePreviewRegenerationDraining = false;
    if (selectNextSnapshotQueueEntry(pendingWorkspacePreviewRegenerations)) {
      void drainWorkspacePreviewRegenerationQueue();
    }
  }
}

async function enqueuePreviewRegeneration(workspaceDir, restore = null, priority = "background") {
  let rebuild = null;
  if (restore?.job_id && Number.isInteger(restore.lifecycle_epoch) && restore.source_sha256) {
    rebuild = await startAppWorkspaceSnapshotRebuild({
      workspace_dir: workspaceDir,
      restore_job_id: restore.job_id,
      lifecycle_epoch: restore.lifecycle_epoch,
      source_sha256: restore.source_sha256,
    });
    if (rebuild.status === "completed") return;
  }
  queueWorkspacePreviewRegeneration({ workspaceDir, rebuild, priority });
}

function schedulePreviewRegeneration(workspaceDir, restore = null, priority = "background") {
  void enqueuePreviewRegeneration(workspaceDir, restore, priority).catch((error) => {
    console.error(`[snapshot-auto-rerender] could not enqueue ${workspaceDir}:`, storageErrorRecord(error));
  });
}

async function prioritizeWorkspacePreviewRegeneration(workspaceDir) {
  let promoted = false;
  for (const entry of pendingWorkspacePreviewRegenerations.values()) {
    if (entry.workspaceDir !== workspaceDir) continue;
    entry.priority = SNAPSHOT_QUEUE_PRIORITY.user_open;
    promoted = true;
  }
  if (promoted) return;

  // Rebuild state survives an engine restart.  If a user opens a Workspace
  // while that durable state is still pending/running, resume it through this
  // queue instead of leaving it behind the next automatic batch.
  const sync = await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
  const rebuild = sync?.rebuild;
  if (rebuild && (rebuild.status === "pending" || rebuild.status === "running")) {
    queueWorkspacePreviewRegeneration({ workspaceDir, rebuild, priority: "user_open" });
  }
}

async function runAppWorkspaceSnapshotRestoreJob(job, priority = "background") {
  let transferLogger = null;
  try {
    await writeAppWorkspaceSnapshotRestore({
      workspace_dir: job.workspace_dir,
      restore: { ...job, status: "downloading", error: null },
    });
    if (!job.revision || !job.aps_path) {
      throw new Error("Snapshot restore job is missing its revision or aps_path");
    }
    const workspaceId = path.basename(job.workspace_dir);
    transferLogger = createApsTransferLogger({
      workspaceDir: job.workspace_dir,
      source: "ppt-engine.workspace-snapshot-restore",
      filename: `${job.revision}.zip`,
      mimeType: "application/zip",
      sizeBytes: job.snapshot_size_bytes,
      path: job.aps_path,
      operationId: `app_run_workspace_snapshot_restore:${job.revision}`,
    });
    transferLogger.log("started", "started", { aps_path: job.aps_path, revision: job.revision });
    const stepTimer = createRestoreStepTimer(job.workspace_dir, {
      revision: job.revision ?? null,
      aps_path: job.aps_path ?? null,
    });

    const download = await apsFilesClient.downloadUrl({
      path: job.aps_path,
      expiresIn: 600,
      scope: APS_FILES_DOWNLOAD_SCOPE,
    });
    if (!download || typeof download.url !== "string" || download.url.length === 0) {
      throw new Error("files/download_url did not return a valid URL");
    }
    transferLogger.log("download_url", "succeeded", {
      aps_path: job.aps_path,
      response: redactStorageResponse(download),
    });
    stepTimer.step("resolve_download_url", { status: "ok" });

    const stagingDir = path.join(
      path.dirname(job.workspace_dir),
      ".snapshot-restore",
      workspaceId,
      "snapshots",
    );
    const stagingZip = path.join(stagingDir, `${job.revision}.zip`);
    await mkdir(stagingDir, { recursive: true });

    const response = await fetch(download.url, { cache: "no-store" });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || `APS Files download failed: HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error("APS Files download returned an empty response body");
    }
    const downloadEtag = response.headers.get("etag") ?? "";
    await pipeline(Readable.fromWeb(response.body), createWriteStream(stagingZip));
    const downloadedSize = (await stat(stagingZip)).size;
    transferLogger.log("download", "succeeded", {
      http_status: response.status,
      size_bytes: downloadedSize,
      aps_path: job.aps_path,
    });
    stepTimer.step("download_zip", { size_bytes: downloadedSize });

    await writeAppWorkspaceSnapshotRestore({
      workspace_dir: job.workspace_dir,
      restore: { ...job, status: "extracting", snapshot_path: stagingZip, error: null },
    });
    const extracted = await extractAppWorkspaceSnapshotZip({
      workspace_dir: job.workspace_dir,
      zip_path: stagingZip,
      revision: job.revision,
      expected_source_sha256: job.source_sha256 ?? undefined,
      expected_fingerprint_algo: job.fingerprint_algo,
    });
    await downloadWorkspaceSnapshotAttachments({
      workspaceId,
      attachments: extracted.attachments,
      shadowDir: extracted.shadow_dir,
    });
    transferLogger.log("extract", "succeeded", {
      file_count: extracted.file_count,
      snapshot_sha256: extracted.snapshot_sha256,
    });
    stepTimer.step("extract_zip", { file_count: extracted.file_count });

    await writeAppWorkspaceSnapshotRestore({
      workspace_dir: job.workspace_dir,
      restore: {
        ...job,
        status: "committing",
        snapshot_path: stagingZip,
        source_updated_at: extracted.source_updated_at ?? job.source_updated_at,
        source_sha256: extracted.restored_source_sha256,
        fingerprint_algo: extracted.fingerprint_algo,
        snapshot_sha256: extracted.snapshot_sha256,
        snapshot_size_bytes: extracted.snapshot_size_bytes,
        file_count: extracted.file_count,
        attachments: extracted.attachments,
        error: null,
      },
    });

    const mirror = {
      provider: "aps.files",
      scope: "user",
      path: job.aps_path,
      etag: downloadEtag,
      size_bytes: extracted.snapshot_size_bytes,
      content_type: "application/zip",
      source_updated_at: extracted.source_updated_at ?? job.source_updated_at ?? "",
      source_sha256: extracted.restored_source_sha256,
      downloaded_at: new Date().toISOString(),
    };
    const committed = await commitAppWorkspaceSnapshotRestore({
      workspace_dir: job.workspace_dir,
      expected_sha256: extracted.restored_source_sha256,
      mirror,
    });
    transferLogger.log("finished", "succeeded", {
      aps_path: job.aps_path,
      revision: job.revision,
      restored_source_sha256: extracted.restored_source_sha256,
    });
    stepTimer.step("commit", { file_count: extracted.file_count, status: committed?.status ?? "ok" });
    schedulePreviewRegeneration(job.workspace_dir, committed, priority);
    return committed;
  } catch (error) {
    transferLogger?.log("unknown", "failed", {
      aps_path: job.aps_path,
      error: storageErrorRecord(error),
    });
    await writeAppWorkspaceSnapshotRestore({
      workspace_dir: job.workspace_dir,
      restore: {
        ...job,
        status: "failed",
        completed_at: new Date().toISOString(),
        error: {
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        },
      },
    }).catch(() => undefined);
    throw error;
  }
}

function awaitAppWorkspaceSnapshotRestoreJob(job, priority = "background") {
  if (!job || job.status !== "queued") {
    return Promise.resolve(job);
  }
  const existing = activeWorkspaceSnapshotRestoreJobPromises.get(job.job_id);
  if (existing) {
    const queued = pendingWorkspaceSnapshotRestoreJobs.get(job.job_id);
    if (queued) queued.priority = Math.max(queued.priority, snapshotQueuePriority(priority));
    return existing;
  }

  activeWorkspaceSnapshotRestoreJobIds.add(job.job_id);
  const tracked = new Promise((resolve, reject) => {
    pendingWorkspaceSnapshotRestoreJobs.set(job.job_id, {
      job,
      priority: snapshotQueuePriority(priority),
      sequence: workspaceSnapshotRestoreQueueSequence += 1,
      state: "pending",
      resolve,
      reject,
    });
  }).finally(() => {
    activeWorkspaceSnapshotRestoreJobIds.delete(job.job_id);
    activeWorkspaceSnapshotRestoreJobPromises.delete(job.job_id);
  });
  activeWorkspaceSnapshotRestoreJobPromises.set(job.job_id, tracked);
  void drainWorkspaceSnapshotRestoreQueue();
  return tracked;
}

async function drainWorkspaceSnapshotRestoreQueue() {
  if (workspaceSnapshotRestoreDraining) return;
  workspaceSnapshotRestoreDraining = true;
  try {
    for (;;) {
      const entry = selectNextSnapshotQueueEntry(pendingWorkspaceSnapshotRestoreJobs);
      if (!entry) return;
      entry.state = "running";
      try {
        entry.resolve(await runAppWorkspaceSnapshotRestoreJob(entry.job, entry.priority === SNAPSHOT_QUEUE_PRIORITY.user_open
          ? "user_open"
          : entry.priority === SNAPSHOT_QUEUE_PRIORITY.first_screen
            ? "first_screen"
            : "background"));
      } catch (error) {
        entry.reject(error);
      } finally {
        pendingWorkspaceSnapshotRestoreJobs.delete(entry.job.job_id);
      }
    }
  } finally {
    workspaceSnapshotRestoreDraining = false;
    if (selectNextSnapshotQueueEntry(pendingWorkspaceSnapshotRestoreJobs)) {
      void drainWorkspaceSnapshotRestoreQueue();
    }
  }
}

async function toolAppRunWorkspaceSnapshotRestore(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const workspaceId = path.basename(workspaceDir);
  const tombstone = await getAppWorkspaceTombstone({ workspace_id: workspaceId });
  if (tombstone) {
    if (args._automatic_restore === true) {
      return {
        status: "tombstoned_local_delete",
        workspace_id: workspaceId,
        workspace_dir: workspaceDir,
        deleted_at: tombstone.deleted_at,
      };
    }
    // This tool is an explicit restore action. The user's intent wins over a
    // prior local-delete preference; only this path clears the tombstone.
    await clearAppWorkspaceTombstone({ workspace_id: workspaceId });
  }
  const revision = typeof args.revision === "string" && args.revision.length > 0 ? args.revision : null;
  const force = args.force === true;

  const stepTimer = createRestoreStepTimer(workspaceDir, { revision });
  const target = await resolveWorkspaceSnapshotRestoreTarget({ workspaceDir: workspaceDir, revision });
  stepTimer.step("resolve_target", { status: "ok" });
  return runWorkspaceSnapshotRestoreToCompletion({
    workspaceDir: workspaceDir,
    revision: target.revision,
    source_sha256: target.source_sha256 ?? undefined,
    source_updated_at: target.source_updated_at ?? undefined,
    fingerprint_algo: target.fingerprint_algo,
    force,
    priority: args._restore_priority === "first_screen" ? "first_screen" : "user_open",
  });
}

// Shared driver behind app_restore_workspace_snapshot and the conflict branch
// of app_reconcile_workspace_with_cloud: interrupt any stale in-flight job for
// this workspace, start a restore against the resolved target, await it, and
// return the terminal state (completed / failed).
async function runWorkspaceSnapshotRestoreToCompletion({ workspaceDir, revision, source_sha256, source_updated_at, fingerprint_algo, force, priority = "background" }) {
  // The Workspace directory may not exist locally yet (simulating a new
  // device); restore needs a real (empty) directory for the local-changes guard.
  await mkdir(workspaceDir, { recursive: true });

  let current = await getAppWorkspaceSnapshotRestoreStatus({ workspace_dir: workspaceDir });
  if (isWorkspaceSnapshotRestoreRunning(current) && !activeWorkspaceSnapshotRestoreJobIds.has(current.job_id)) {
    current = await markAppWorkspaceSnapshotRestoreJobInterrupted({ workspace_dir: workspaceDir });
  }

  const job = await startAppWorkspaceRestoreSnapshot({
    workspace_dir: workspaceDir,
    revision,
    source_sha256: source_sha256 ?? undefined,
    source_updated_at: source_updated_at ?? undefined,
    fingerprint_algo: fingerprint_algo ?? undefined,
    force: force === true,
  });
  if (job.status === "completed") {
    // Already restored and in sync (idempotent skip). The restore job did not
    // run, so refresh derived previews that output/ dropped or is missing.
    schedulePreviewRegeneration(workspaceDir, null, priority);
    return job;
  }
  if (job.status === "failed") return job;

  await awaitAppWorkspaceSnapshotRestoreJob(job, priority);
  const completed = await getAppWorkspaceSnapshotRestoreStatus({ workspace_dir: workspaceDir });
  if (completed.status === "completed") return completed;
  throw new Error(completed.error?.message || "Workspace snapshot restore failed");
}

// Three-fingerprint reconciliation: L is the live local tree, B is the last
// confirmed local sync baseline, and R is APS meta.json's current snapshot.
// Only a true L/B/R divergence is backed up then force-restored.
async function toolAppReconcileWorkspaceWithCloud(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const workspaceId = path.basename(workspaceDir);
  const tombstone = await getAppWorkspaceTombstone({ workspace_id: workspaceId });
  if (tombstone) {
    return {
      status: "tombstoned_local_delete",
      workspace_id: workspaceId,
      workspace_dir: workspaceDir,
      local: null,
      target: null,
      deleted_at: tombstone.deleted_at,
      error: { message: "This Workspace was deleted locally and is blocked from cloud reconciliation." },
    };
  }
  await mkdir(workspaceDir, { recursive: true });

  const local = await getAppWorkspaceLocalSnapshotFingerprint({ workspace_dir: workspaceDir });
  const syncState = await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
  const semanticFailure = syncState?.semantic_validation_failed;

  // A rejected candidate means this local tree has never been represented by a
  // valid snapshot. Cloud-priority restore is unsafe here: it would replace
  // the user's local bytes with an older remote revision merely because that
  // revision is the only one APS knows about. Keep the workspace in place and
  // let the next successful business commit clear this marker and publish.
  if (semanticFailure && typeof semanticFailure === "object") {
    return {
      status: "local_semantic_validation_failed",
      workspace_id: workspaceId,
      workspace_dir: workspaceDir,
      local,
      target: null,
      error: {
        message: "The local workspace snapshot needs validation before cloud reconciliation; the local version was kept unchanged.",
      },
      semantic_validation_failed: semanticFailure,
    };
  }

  const stepTimer = createRestoreStepTimer(workspaceDir, { revision: null });
  let target;
  try {
    target = await resolveWorkspaceSnapshotRestoreTarget({ workspaceDir: workspaceDir, revision: null });
    stepTimer.step("resolve_target", { status: "ok" });
  } catch (error) {
    // No meta.json / no current_snapshot: nothing to reconcile against.
    return {
      status: "no_cloud_snapshot",
      workspace_id: workspaceId,
      workspace_dir: workspaceDir,
      local,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }

  // Empty local tree (e.g. a new device): nothing local to lose, restore cloud.
  if (!local.has_files) {
    const restore = await runWorkspaceSnapshotRestoreToCompletion({
      workspaceDir: workspaceDir,
      revision: target.revision,
      source_sha256: target.source_sha256 ?? undefined,
      source_updated_at: target.source_updated_at ?? undefined,
      fingerprint_algo: target.fingerprint_algo,
      force: false,
      priority: "user_open",
    });
    return {
      status: restore.status === "completed" ? "restored" : "restore_failed",
      workspace_id: workspaceId,
      workspace_dir: workspaceDir,
      local,
      target,
      restore,
    };
  }

  // Local already matches the cloud snapshot (live fingerprint). No work to
  // lose, nothing to restore. NOTE: do not treat "last synced equals cloud" as
  // in-sync — that would mask local work made after the last sync (e.g. a
  // tampered/edited workspace whose last_synced_sha256 still points at the old
  // cloud snapshot) and skip the backup+restore conflict path entirely.
  if (target.source_sha256 !== null && local.source_sha256 === target.source_sha256) {
    await prioritizeWorkspacePreviewRegeneration(workspaceDir).catch((error) => {
      console.warn(`[cloud-reconcile] could not promote rebuild for ${workspaceId}:`, storageErrorRecord(error));
    });
    return {
      status: "in_sync",
      workspace_id: workspaceId,
      workspace_dir: workspaceDir,
      local,
      target,
    };
  }

  const decision = classifyAppWorkspaceSnapshotReconcile({
    local_source_sha256: local.source_sha256,
    baseline_source_sha256: syncState?.synced_baseline?.source_sha256 ?? null,
    remote_source_sha256: target.source_sha256,
    local_fingerprint_algo: local.fingerprint_algo,
    baseline_fingerprint_algo: syncState?.synced_baseline?.fingerprint_algo ?? null,
    remote_fingerprint_algo: target.fingerprint_algo,
  });

  if (decision === "baseline_missing") {
    // B is the common ancestor that tells us whether local or cloud moved.
    // Do not manufacture a conflict copy or force-restore when it is absent:
    // both alter the user's local state without sufficient evidence.
    return {
      status: "baseline_missing",
      workspace_id: workspaceId,
      workspace_dir: workspaceDir,
      local,
      target,
      error: { message: "Cannot safely reconcile this workspace because its last synchronized baseline is unavailable; the local version was kept unchanged." },
    };
  }

  if (decision === "local_ahead") {
    // The APS pointer still equals B. Keep L intact and nudge the normal A
    // upload pump; no restore or conflict copy is permitted on this branch.
    // Normally A has already recorded/generated this change. If an older client
    // or a direct file edit left L unrepresented, make that durable first so a
    // failed build still survives a close/reopen as pending work.
    const localAlreadyRepresented = syncState?.source_sha256 === local.source_sha256;
    if (!localAlreadyRepresented && !Number.isInteger(syncState?.pending_change_seq)) {
      void markAppWorkspaceSnapshotDirty({ workspace_dir: workspaceDir })
        .then(() => publishAppWorkspaceSnapshot({ workspace_dir: workspaceDir }))
        .then(() => scheduleAutoPublishSweep({ force: true }))
        .catch((error) => {
          console.error(`[cloud-reconcile] could not snapshot local-ahead workspace ${workspaceId}:`, storageErrorRecord(error));
        });
    } else {
      scheduleAutoPublishSweep({ force: true });
    }
    return {
      status: "local_ahead",
      workspace_id: workspaceId,
      workspace_dir: workspaceDir,
      local,
      target,
    };
  }

  if (decision === "cloud_ahead") {
    // L equals B, so R is the only side that advanced. A regular (non-force)
    // restore retains the engine's final local-change guard as a second check.
    const restore = await runWorkspaceSnapshotRestoreToCompletion({
      workspaceDir: workspaceDir,
      revision: target.revision,
      source_sha256: target.source_sha256 ?? undefined,
      source_updated_at: target.source_updated_at ?? undefined,
      fingerprint_algo: target.fingerprint_algo,
      force: false,
      priority: "user_open",
    });
    return {
      status: restore.status === "completed" ? "restored" : "restore_failed",
      workspace_id: workspaceId,
      workspace_dir: workspaceDir,
      local,
      target,
      restore,
    };
  }

  // `diverged`: L and R have both moved away from B in different directions.
  // Copy first, then overwrite — if the copy fails, the original stays intact.
  let backup;
  try {
    backup = await backupAppWorkspaceAsLocalCopy({ workspace_dir: workspaceDir });
  } catch (error) {
    return {
      status: "conflict_blocked",
      workspace_id: workspaceId,
      workspace_dir: workspaceDir,
      local,
      target,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }

  // Best-effort: upload the backup copy to APS so it is recoverable elsewhere.
  // Sweep keeps retrying on failure, so a failure here is not data loss.
  let backupUploadStatus = "failed";
  try {
    const published = await toolAppRunWorkspaceSnapshotPublish({ workspace_dir: backup.workspace_dir });
    backupUploadStatus = published?.status === "completed" ? "uploaded" : "failed";
  } catch (error) {
    backupUploadStatus = "failed";
  }

  // The backup only authorizes force-overwrite of the exact L that was copied.
  // A save while the backup/upload was running creates a new branch; leave it
  // untouched and let the next reconcile use fresh L/B/R evidence.
  const liveAfterBackup = await getAppWorkspaceLocalSnapshotFingerprint({ workspace_dir: workspaceDir });
  if (liveAfterBackup.source_sha256 !== local.source_sha256 ||
    liveAfterBackup.fingerprint_algo !== local.fingerprint_algo) {
    return {
      status: "conflict_recheck_required",
      workspace_id: workspaceId,
      workspace_dir: workspaceDir,
      local,
      live_after_backup: liveAfterBackup,
      target,
      backup_workspace_id: backup.workspace_id,
      backup_workspace_dir: backup.workspace_dir,
      backup_title: backup.title,
      backup_upload_status: backupUploadStatus,
      error: { message: "The local Workspace changed after its conflict backup; cloud overwrite was skipped." },
    };
  }

  const restore = await runWorkspaceSnapshotRestoreToCompletion({
    workspaceDir: workspaceDir,
    revision: target.revision,
    source_sha256: target.source_sha256 ?? undefined,
    source_updated_at: target.source_updated_at ?? undefined,
    fingerprint_algo: target.fingerprint_algo,
    force: true,
    priority: "user_open",
  });

  return {
    status: restore.status === "completed" ? "conflict_resolved" : "conflict_restore_failed",
    workspace_id: workspaceId,
    workspace_dir: workspaceDir,
    local,
    target,
    backup_workspace_id: backup.workspace_id,
    backup_workspace_dir: backup.workspace_dir,
    backup_title: backup.title,
    backup_upload_status: backupUploadStatus,
    restore,
  };
}

async function toolAppGetWorkspaceSnapshotRestoreStatus(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const current = await getAppWorkspaceSnapshotRestoreStatus({ workspace_dir: workspaceDir });
  if (isWorkspaceSnapshotRestoreRunning(current) && !activeWorkspaceSnapshotRestoreJobIds.has(current.job_id)) {
    return markAppWorkspaceSnapshotRestoreJobInterrupted({ workspace_dir: workspaceDir });
  }
  return current;
}

const APS_MY_WORK_PREFIX = "workspaces/";
const APS_MY_WORK_LIST_PAGE_LIMIT = 1000;
const APS_MY_WORK_LIST_MAX_PAGES = 1000;
// Each Workspace costs one host round trip plus one download, so a serial loop
// spends the whole invoke budget waiting on the network once an account holds
// more than a few dozen Workspaces.
const APS_MY_WORK_META_CONCURRENCY = 8;

function apsListEntries(listed) {
  if (Array.isArray(listed?.entries)) return listed.entries;
  if (Array.isArray(listed?.objects)) return listed.objects;
  if (Array.isArray(listed?.items)) return listed.items;
  if (Array.isArray(listed)) return listed;
  return [];
}

function apsListNextCursor(listed) {
  const cursor = listed?.next_cursor ?? listed?.nextCursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}

// APS Files paginates object listings. My Work must consume the complete
// prefix: treating one page as the whole cloud collection silently makes later
// Workspace IDs impossible to restore.
async function listAllApsFiles({ prefix, scope, limit = APS_MY_WORK_LIST_PAGE_LIMIT }) {
  const entries = [];
  const seenCursors = new Set();
  let cursor = null;
  let pages = 0;

  while (true) {
    if (pages >= APS_MY_WORK_LIST_MAX_PAGES) {
      throw new Error(`APS Files listing exceeded ${APS_MY_WORK_LIST_MAX_PAGES} pages for prefix ${prefix}`);
    }
    const listed = await apsFilesClient.list({ prefix, scope, limit, cursor: cursor ?? undefined });
    pages += 1;
    entries.push(...apsListEntries(listed));

    const nextCursor = apsListNextCursor(listed);
    if (!nextCursor) return { entries, pages };
    if (seenCursors.has(nextCursor)) {
      throw new Error(`APS Files listing returned a repeated cursor for prefix ${prefix}`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

function workspaceIdFromApsPath(entryPath) {
  if (typeof entryPath !== "string" || entryPath.length === 0) return null;
  const idx = entryPath.indexOf(APS_MY_WORK_PREFIX);
  const after = idx >= 0 ? entryPath.slice(idx + APS_MY_WORK_PREFIX.length) : entryPath;
  const firstSegment = after.split("/")[0];
  return firstSegment || null;
}

async function fetchApsMetaJson(workspaceId) {
  const metaPath = `${APS_MY_WORK_PREFIX}${workspaceId}/meta.json`;
  const download = await apsFilesClient.downloadUrl({
    path: metaPath,
    expiresIn: 600,
    scope: APS_FILES_DOWNLOAD_SCOPE,
  });
  if (!download || typeof download.url !== "string" || download.url.length === 0) {
    throw new Error(`files/download_url did not return a valid URL for ${metaPath}`);
  }
  const response = await fetch(download.url, { cache: "no-store" });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(message || `meta.json download failed: HTTP ${response.status}`);
  }
  return JSON.parse(await response.text());
}

// Writes each result back by index, so the returned order is the input order no
// matter which worker happened to finish first.
async function mapWithConcurrencyLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function toolAppListMyWork() {
  const listed = await listAllApsFiles({
    prefix: APS_MY_WORK_PREFIX,
    scope: APS_FILES_DOWNLOAD_SCOPE,
  });
  const rawEntries = listed.entries;
  const workspaceIds = [...new Set(
    rawEntries
      .map((entry) => workspaceIdFromApsPath(
        entry && (typeof entry === "string" ? entry : (entry.path ?? entry.key ?? entry.name)),
      ))
      .filter((id) => id),
  )];

  const workspaces = await mapWithConcurrencyLimit(
    workspaceIds,
    APS_MY_WORK_META_CONCURRENCY,
    async (workspaceId) => {
      const entry = { workspace_id: workspaceId };
      try {
        const meta = await fetchApsMetaJson(workspaceId);
        const current = meta?.current_snapshot;
        if (current && typeof current === "object") {
          entry.revision = typeof current.revision === "string" ? current.revision : null;
          entry.aps_path = typeof current.aps_path === "string" ? current.aps_path : null;
          entry.source_sha256 = typeof current.source_sha256 === "string" ? current.source_sha256 : null;
          entry.source_updated_at = typeof current.source_updated_at === "string" ? current.source_updated_at : null;
          entry.size_bytes = typeof current.size_bytes === "number" ? current.size_bytes : null;
          entry.file_count = typeof current.file_count === "number" ? current.file_count : null;
          entry.snapshot_updated_at = typeof current.created_at === "string" ? current.created_at : null;
        }
        entry.meta_updated_at = typeof meta?.updated_at === "string" ? meta.updated_at : null;
        entry.status = typeof meta?.status === "string" ? meta.status : "unknown";
      } catch (error) {
        entry.meta_error = error instanceof Error ? error.message : String(error);
      }
      return entry;
    },
  );

  // Timestamps are not unique: Workspaces that share one, and every Workspace
  // whose meta.json failed to load (no timestamp at all), need a stable tiebreak
  // or the list reshuffles between refreshes.
  workspaces.sort((a, b) =>
    String(b.meta_updated_at ?? b.snapshot_updated_at ?? "").localeCompare(
      String(a.meta_updated_at ?? a.snapshot_updated_at ?? ""),
    ) || a.workspace_id.localeCompare(b.workspace_id),
  );
  return { workspaces };
}

async function deleteApsWorkspaceFiles(workspaceId) {
  const prefix = `${APS_MY_WORK_PREFIX}${workspaceId}/`;
  const listed = await apsFilesClient.list({
    prefix,
    scope: APS_FILES_DOWNLOAD_SCOPE,
  });
  const rawEntries = Array.isArray(listed?.entries)
    ? listed.entries
    : Array.isArray(listed?.objects)
      ? listed.objects
      : Array.isArray(listed?.items)
        ? listed.items
        : Array.isArray(listed)
          ? listed
          : [];
  let deleted = 0;
  for (const entry of rawEntries) {
    const entryPath = entry && (typeof entry === "string" ? entry : (entry.path ?? entry.key ?? entry.name));
    if (typeof entryPath !== "string" || entryPath.length === 0) continue;
    const result = await apsFilesClient.delete({
      path: entryPath,
      scope: APS_FILES_DOWNLOAD_SCOPE,
    });
    if (result?.deleted) deleted += 1;
  }
  return { deleted, files: rawEntries.length };
}

// This audit deliberately lives at the Workspace root rather than under an
// individual Workspace. Auto-restore can only explain why a deleted tree was
// not restored if its decision survives that tree being absent (and survives
// cleanup of .snapshot-sync/<workspace-id> before a later restore attempt).
const AUTO_RESTORE_DECISION_AUDIT_FILENAME = "auto-restore-decisions.jsonl";
const AUTO_RESTORE_DECISION_AUDIT_SCHEMA_VERSION = 1;

function autoRestoreDecisionAuditPath(workspaceRoot) {
  return path.join(workspaceRoot, ".snapshot-restore", AUTO_RESTORE_DECISION_AUDIT_FILENAME);
}

async function appendAutoRestoreDecisionAudit(workspaceRoot, record) {
  const auditPath = autoRestoreDecisionAuditPath(workspaceRoot);
  await mkdir(path.dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify({
    schema_version: AUTO_RESTORE_DECISION_AUDIT_SCHEMA_VERSION,
    recorded_at: new Date().toISOString(),
    ...record,
  })}\n`, "utf8");
}

async function recordAutoRestoreDecision(workspaceRoot, record) {
  try {
    await appendAutoRestoreDecisionAudit(workspaceRoot, record);
  } catch (error) {
    // Diagnostics must never turn a recoverable cloud restore into a failed
    // one. Keep the underlying restore flow authoritative.
    console.warn("[cloud-reconcile] could not persist auto-restore decision:", storageErrorRecord(error));
  }
}

async function toolAppGetAutoRestoreDecisions(args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const defaults = await getAppWorkspaceDefaults();
  const workspaceRoot = defaults?.workspace_root ?? defaults?.task_root ?? null;
  if (!workspaceRoot) return { workspace_root: null, audit_path: null, records: [] };

  const requestedLimit = Number(args.limit);
  const limit = Number.isSafeInteger(requestedLimit) ? Math.min(500, Math.max(1, requestedLimit)) : 100;
  const auditPath = autoRestoreDecisionAuditPath(workspaceRoot);
  let lines;
  try {
    lines = (await readFile(auditPath, "utf8")).split(/\r?\n/u).filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { workspace_root: workspaceRoot, audit_path: auditPath, records: [] };
    }
    throw error;
  }

  const records = [];
  for (const line of lines.slice(-limit)) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) records.push(value);
    } catch {
      // A torn final line (e.g. process exit during append) is diagnostic
      // data only; retain every earlier valid decision record.
    }
  }
  return { workspace_root: workspaceRoot, audit_path: auditPath, records };
}

/**
 * Device-switch reconcile: silently bring back every Workspace that has a
 * published snapshot in APS but no longer exists locally (e.g. after moving to
 * a new machine). Only the newest missing Workspaces that fit the first screen
 * are restored eagerly; the rest remain cloud-only until the user opens one.
 * Each eager restore uses force so a leftover empty directory cannot block it,
 * and the restore job re-renders previews through the separate render queue.
 * Locally deleted Workspaces remain in APS, but their local tombstone makes
 * this automatic path skip them until the user explicitly restores one.
 */
async function toolAppAutoRestoreMissingWorkspaces() {
  const defaults = await getAppWorkspaceDefaults();
  const workspaceRoot = defaults?.workspace_root ?? defaults?.task_root ?? null;
  if (!workspaceRoot) {
    return { workspace_root: null, restored: [], skipped: [], deferred: [], failed: [] };
  }
  const runId = `auto-restore-${Date.now()}-${randomUUID()}`;

  let listed;
  try {
    listed = await toolAppListMyWork();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cloud-reconcile] could not list APS workspaces: ${message}`);
    await recordAutoRestoreDecision(workspaceRoot, {
      event: "cloud.auto_restore.run_completed",
      run_id: runId,
      outcome: "cloud_list_failed",
      error: message,
    });
    return {
      workspace_root: workspaceRoot,
      restored: [],
      skipped: [],
      deferred: [],
      failed: [],
      error: message,
    };
  }

  const restored = [];
  const skipped = [];
  const deferred = [];
  const failed = [];
  let eagerRestoreCount = 0;
  const cloudWorkspaces = listed.workspaces ?? [];
  await recordAutoRestoreDecision(workspaceRoot, {
    event: "cloud.auto_restore.run_started",
    run_id: runId,
    first_screen_limit: AUTO_RESTORE_FIRST_SCREEN_LIMIT,
    cloud_workspace_count: cloudWorkspaces.length,
    // toolAppListMyWork already sorts newest-first. Persist this exact order so
    // a later investigation can prove whether a Workspace was eligible for the
    // first-screen budget without making another cloud request.
    cloud_order: cloudWorkspaces.map((ws, index) => ({
      rank: index + 1,
      workspace_id: ws.workspace_id,
      revision: ws.revision ?? null,
      meta_updated_at: ws.meta_updated_at ?? null,
      snapshot_updated_at: ws.snapshot_updated_at ?? null,
      status: ws.status ?? "unknown",
      has_current_snapshot: Boolean(ws.aps_path || ws.revision),
    })),
  });

  for (const [index, ws] of cloudWorkspaces.entries()) {
    const candidate = {
      run_id: runId,
      cloud_rank: index + 1,
      workspace_id: ws.workspace_id,
      revision: ws.revision ?? null,
      meta_updated_at: ws.meta_updated_at ?? null,
      snapshot_updated_at: ws.snapshot_updated_at ?? null,
    };
    if (!ws.aps_path && !ws.revision) {
      await recordAutoRestoreDecision(workspaceRoot, {
        event: "cloud.auto_restore.decision",
        ...candidate,
        decision: "invalid_remote_snapshot",
      });
      continue;
    }
    const tombstone = await getAppWorkspaceTombstone({ workspace_id: ws.workspace_id });
    if (tombstone) {
      skipped.push({ workspace_id: ws.workspace_id, reason: "tombstoned_local_delete", deleted_at: tombstone.deleted_at });
      await recordAutoRestoreDecision(workspaceRoot, {
        event: "cloud.auto_restore.decision",
        ...candidate,
        decision: "tombstoned_local_delete",
        deleted_at: tombstone.deleted_at,
      });
      continue;
    }
    const workspaceDir = path.join(workspaceRoot, ws.workspace_id);
    let exists = false;
    try {
      const st = await stat(workspaceDir);
      exists = st.isDirectory();
    } catch {
      exists = false;
    }
    if (exists) {
      skipped.push({ workspace_id: ws.workspace_id, reason: "present_locally" });
      await recordAutoRestoreDecision(workspaceRoot, {
        event: "cloud.auto_restore.decision",
        ...candidate,
        decision: "present_locally",
      });
      continue;
    }
    if (eagerRestoreCount >= AUTO_RESTORE_FIRST_SCREEN_LIMIT) {
      deferred.push({ workspace_id: ws.workspace_id, reason: "outside_first_screen" });
      await recordAutoRestoreDecision(workspaceRoot, {
        event: "cloud.auto_restore.decision",
        ...candidate,
        decision: "outside_first_screen",
      });
      continue;
    }
    eagerRestoreCount += 1;
    await recordAutoRestoreDecision(workspaceRoot, {
      event: "cloud.auto_restore.decision",
      ...candidate,
      decision: "restore_selected",
      first_screen_slot: eagerRestoreCount,
    });
    // The local Workspace is gone, so any leftover per-workspace sync/restore
    // bookkeeping is stale: it would make the restore idempotently skip even
    // though there is nothing to resume. Clear it before restoring (best-effort,
    // these derived dirs never hold user content the snapshot does not have).
    try {
      const parent = path.dirname(workspaceDir);
      await rm(path.join(parent, ".snapshot-sync", ws.workspace_id), { recursive: true, force: true });
      await rm(path.join(parent, ".snapshot-restore", ws.workspace_id), { recursive: true, force: true });
    } catch {
      // best-effort: a locked dir must not block the restore
    }
    try {
      const state = await toolAppRunWorkspaceSnapshotRestore({
        workspace_dir: workspaceDir,
        force: true,
        _automatic_restore: true,
        _restore_priority: "first_screen",
      });
      restored.push({
        workspace_id: ws.workspace_id,
        revision: state?.revision ?? ws.revision ?? null,
        status: state?.status ?? "unknown",
      });
      await recordAutoRestoreDecision(workspaceRoot, {
        event: "cloud.auto_restore.decision",
        ...candidate,
        decision: "restore_completed",
        first_screen_slot: eagerRestoreCount,
        restore_status: state?.status ?? "unknown",
        restored_revision: state?.revision ?? ws.revision ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({
        workspace_id: ws.workspace_id,
        error: message,
      });
      await recordAutoRestoreDecision(workspaceRoot, {
        event: "cloud.auto_restore.decision",
        ...candidate,
        decision: "restore_failed",
        first_screen_slot: eagerRestoreCount,
        error: message,
      });
    }
  }
  await recordAutoRestoreDecision(workspaceRoot, {
    event: "cloud.auto_restore.run_completed",
    run_id: runId,
    outcome: failed.length > 0 ? "completed_with_failures" : "completed",
    first_screen_limit: AUTO_RESTORE_FIRST_SCREEN_LIMIT,
    restored: restored.map((entry) => entry.workspace_id),
    skipped,
    deferred,
    failed,
  });
  return {
    workspace_root: workspaceRoot,
    restored,
    skipped,
    deferred,
    failed,
    first_screen_limit: AUTO_RESTORE_FIRST_SCREEN_LIMIT,
  };
}

async function toolAppPrepareWorkspaceDiagnosticBundle(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  return publishDiagnosticBundle({ workspaceDir, prepare: () => prepareAppWorkspaceDiagnosticBundle({ workspace_dir: workspaceDir }) });
}

async function toolAppPrepareUserTemplateDiagnosticBundle(args) {
  return publishDiagnosticBundle({ templateId: args.id, prepare: () => prepareUserTemplateDiagnosticBundle({ id: args.id }) });
}

async function publishDiagnosticBundle({ workspaceDir, templateId, prepare }) {
  return withWorkspaceDiagnosticBundleQueue(templateId ? `user-template:${templateId}` : workspaceDir, async () => {
    const snapshot = await prepare();
    const transferLogger = createApsTransferLogger({
      workspaceDir,
      templateId,
      source: "ppt-engine.workspace-diagnostic-bundle",
      filename: snapshot.filename,
      mimeType: snapshot.content_type,
      sizeBytes: snapshot.size_bytes,
      path: snapshot.aps_path,
      operationId: "app_prepare_workspace_diagnostic_bundle",
    });
    transferLogger.log("started", "started", { aps_path: snapshot.aps_path });
    try {
      const { completed, contentDisposition } = await uploadApsSnapshotWithRetry({
        snapshot,
        bodyPath: snapshot.archive_path,
        workspaceDir,
        templateId,
        source: "ppt-engine.workspace-diagnostic-bundle",
        operationId: "app_prepare_workspace_diagnostic_bundle",
        metadata: {
          workspace_id: snapshot.workspace_id,
          artifact_type: templateId ? "user_template_diagnostic_bundle" : "workspace_diagnostic_bundle",
          created_at: snapshot.created_at,
        },
      });
      const download = await apsFilesClient.downloadUrl({
        path: snapshot.aps_path,
        expiresIn: 600,
        scope: APS_FILES_DOWNLOAD_SCOPE,
      });
      if (!download || typeof download.url !== "string" || download.url.length === 0) {
        throw new Error("files/download_url did not return a valid URL");
      }
      transferLogger.log("download_url", "succeeded", {
        aps_path: snapshot.aps_path,
        response: redactStorageResponse(download),
      });
      transferLogger.log("finished", "succeeded", { aps_path: snapshot.aps_path, expires_at: download.expires_at });

      const sizeBytes = Number.isFinite(Number(completed?.size_bytes))
        ? Math.floor(Number(completed.size_bytes))
        : snapshot.size_bytes;
      return {
        status: "ready",
        workspace_id: snapshot.workspace_id,
        ...(templateId ? { template_id: templateId } : {}),
        filename: snapshot.filename,
        size_bytes: sizeBytes,
        download_url: download.url,
        expires_at: typeof download.expires_at === "string" ? download.expires_at : null,
        // ADR-0025: the Host can save this object itself, which keeps the signed
        // URL out of the App unless the fallback route is needed.
        mirror: {
          provider: "aps.files",
          scope: APS_FILES_DOWNLOAD_SCOPE,
          path: snapshot.aps_path,
          content_type: snapshot.content_type,
          content_disposition: contentDisposition,
          size_bytes: sizeBytes,
        },
      };
    } catch (error) {
      transferLogger.log("unknown", "failed", { aps_path: snapshot.aps_path, error: storageErrorRecord(error) });
      throw error;
    } finally {
      await unlink(snapshot.archive_path).catch(() => undefined);
    }
  });
}

async function toolAppCreateBatchTestRun(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const result = await createAppBatchTestRun({
    test_id: typeof args.test_id === "string" ? args.test_id : undefined,
    target_stage: args.target_stage,
    cases: args.cases,
  });
  return toBatchTestTransportResult(result);
}

async function toolAppListBatchTestRuns(args) {
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    throw new Error("Arguments must be an object");
  }
  const result = await listAppBatchTestRuns();
  return {
    ...result,
    runs: result.runs.map(toBatchTestTransportRun),
  };
}

async function toolAppUpdateBatchTestCase(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const result = await updateAppBatchTestCase({
    root_dir: readRequiredAbsolutePathArg(args, "root_dir"),
    case_id: args.case_id,
    status: args.status,
    error: args.error === undefined ? undefined : args.error,
    pptx_path: args.pptx_path === undefined ? undefined : args.pptx_path,
    token_usage: args.token_usage === undefined ? undefined : args.token_usage,
    performance_metrics: args.performance_metrics === undefined ? undefined : args.performance_metrics,
    research_routing_result: args.research_routing_result === undefined ? undefined : args.research_routing_result,
    template_recommendation_result: args.template_recommendation_result === undefined ? undefined : args.template_recommendation_result,
  });
  return toBatchTestTransportRun(result);
}

async function toolAppUpdateBatchTestRun(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const result = await updateAppBatchTestRun({
    root_dir: readRequiredAbsolutePathArg(args, "root_dir"),
    status: args.status,
    performance_metrics: args.performance_metrics === undefined ? undefined : args.performance_metrics,
  });
  return toBatchTestTransportRun(result);
}

function toBatchTestTransportResult(result) {
  return {
    ...result,
    run: toBatchTestTransportRun(result.run),
  };
}

function toBatchTestTransportRun(run) {
  if (!run || !Array.isArray(run.cases)) {
    return run;
  }
  const hasResearchRoutingFixtures = run.target_stage === "research-routing-completed";
  const hasProvidedRequirementsFixtures = run.cases.some((item) => item?.provided_requirements);
  if (!hasResearchRoutingFixtures && !hasProvidedRequirementsFixtures) return run;
  const firstRouting = run.cases.find((item) => item.research_routing)?.research_routing;
  const runSignature = firstRouting && typeof firstRouting === "object"
    ? JSON.stringify([firstRouting.git_commit, firstRouting.requested_model])
    : undefined;
  return {
    ...run,
    ...(run.performance_metrics ? { performance_metrics: run.performance_metrics } : {}),
    ...(runSignature ? { research_routing_run_signature: runSignature } : {}),
    ...(hasResearchRoutingFixtures ? { research_routing_cases_fingerprint: researchRoutingCasesFingerprint(run.cases) } : {}),
    // A batch of full Requirements fixtures can exceed the local Executa
    // bridge's payload limit. The browser has the imported input while running;
    // it only needs stable IDs, statuses and Workspace locations here.
    cases: run.cases.map((item) => ({
      case_id: item.case_id,
      repetition: item.repetition,
      total_repetitions: item.total_repetitions,
      status: item.status,
      workspace_id: item.workspace_id,
      ...(item.token_usage ? { token_usage: item.token_usage } : {}),
      ...(item.performance_metrics ? { performance_metrics: item.performance_metrics } : {}),
      ...(typeof item.error === "string" && item.error ? { error: item.error.slice(0, 512) } : {}),
    })),
  };
}

function researchRoutingCasesFingerprint(cases) {
  let hash = 0x811c9dc5;
  const source = JSON.stringify(cases.map((item) => [
    item.case_id,
    item.brief_id,
    item.brief,
    item.repetition,
    item.total_repetitions,
    item.research_routing?.prompt_hash,
    item.research_routing?.expected?.web,
    item.research_routing?.expected?.images,
  ]));
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function toolAppDeleteBatchTestRun(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  return deleteAppBatchTestRun(readRequiredAbsolutePathArg(args, "root_dir"));
}

async function toolAppMaterializePerformanceRun(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  return materializePerformanceRun({
    run_id: args.run_id,
    destination_dir: readRequiredAbsolutePathArg(args, "destination_dir"),
  });
}

async function toolAppPrepareBatchTestBundle(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }
  const rootDir = readRequiredAbsolutePathArg(args, "root_dir");
  return withWorkspaceDiagnosticBundleQueue(rootDir, async () => {
    const snapshot = await prepareAppBatchTestBundle({ root_dir: rootDir });
    const transferLogger = createApsTransferLogger({
      // The batch root is a container, not a normal ppt-YYYYMMDD-HHmmss Workspace.
      // Keep its transport events out of the Workspace log contract.
      workspaceDir: undefined,
      source: "ppt-engine.batch-test-bundle",
      filename: snapshot.filename,
      mimeType: snapshot.content_type,
      sizeBytes: snapshot.size_bytes,
      path: snapshot.aps_path,
      operationId: "app_prepare_batch_test_bundle",
    });
    transferLogger.log("started", "started", { aps_path: snapshot.aps_path });
    try {
      const { completed, contentDisposition } = await uploadApsSnapshotWithRetry({
        snapshot,
        bodyPath: snapshot.archive_path,
        workspaceDir: undefined,
        source: "ppt-engine.batch-test-bundle",
        operationId: "app_prepare_batch_test_bundle",
        metadata: {
          test_id: snapshot.test_id,
          artifact_type: "batch_test_bundle",
          created_at: snapshot.created_at,
        },
      });
      const download = await apsFilesClient.downloadUrl({
        path: snapshot.aps_path,
        expiresIn: 600,
        scope: APS_FILES_DOWNLOAD_SCOPE,
      });
      if (!download || typeof download.url !== "string" || download.url.length === 0) {
        throw new Error("files/download_url did not return a valid URL");
      }
      const sizeBytes = Number.isFinite(Number(completed?.size_bytes))
        ? Math.floor(Number(completed.size_bytes))
        : snapshot.size_bytes;
      transferLogger.log("finished", "succeeded", { aps_path: snapshot.aps_path, expires_at: download.expires_at });
      return {
        status: "ready",
        test_id: snapshot.test_id,
        filename: snapshot.filename,
        size_bytes: sizeBytes,
        download_url: download.url,
        expires_at: typeof download.expires_at === "string" ? download.expires_at : null,
        mirror: {
          provider: "aps.files",
          scope: APS_FILES_DOWNLOAD_SCOPE,
          path: snapshot.aps_path,
          content_type: snapshot.content_type,
          content_disposition: contentDisposition,
          size_bytes: sizeBytes,
        },
      };
    } catch (error) {
      transferLogger.log("unknown", "failed", { aps_path: snapshot.aps_path, error: storageErrorRecord(error) });
      throw error;
    } finally {
      await unlink(snapshot.archive_path).catch(() => undefined);
    }
  });
}

async function toolAppBeginGenerationRun(args) {
  return beginAppGenerationRun({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    run_kind: args.run_kind,
    origin_page_id: typeof args.origin_page_id === "string" ? args.origin_page_id : null,
  });
}

async function toolAppPrepareGenerationRun(args) {
  if (typeof args.run_id !== "string" || !args.run_id) throw new Error('Missing required parameter: "run_id"');
  return prepareAppGenerationRun({ run_id: args.run_id });
}

async function toolAppAbandonGenerationRun(args) {
  if (typeof args.run_id !== "string" || !args.run_id) throw new Error('Missing required parameter: "run_id"');
  return abandonAppGenerationRun({ run_id: args.run_id });
}

async function toolAppCommitGenerationRun(args) {
  if (typeof args.run_id !== "string" || !args.run_id) throw new Error('Missing required parameter: "run_id"');
  return commitAppGenerationRun({ run_id: args.run_id });
}

async function toolAppCleanupGenerationRun(args) {
  if (typeof args.run_id !== "string" || !args.run_id) throw new Error('Missing required parameter: "run_id"');
  return cleanupAppGenerationRun({ run_id: args.run_id });
}

async function toolAppGetWorkspaceGenerationRun(args) {
  return getAppWorkspaceGenerationRun({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir") });
}

async function toolAppExportPdf(args) {
  return toolAppRunPdfExport(args);
}

async function toolAppRunPdfExport(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const pageNumbers = args.page_numbers;
  if (pageNumbers !== undefined && (!Array.isArray(pageNumbers) || pageNumbers.some((pageNumber) => !Number.isInteger(pageNumber)))) {
    throw new Error('"page_numbers" must be an array of integers');
  }
  const result = await exportAppPdf({
    workspace_dir: workspaceDir,
    ...(pageNumbers === undefined ? {} : { page_numbers: pageNumbers }),
  });
  await recordAppPdfExport({
    workspace_dir: workspaceDir,
    pdf_path: result.pdf_path,
  });
  return result;
}

async function toolAppRecordPdfExport(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object");
  }

  const workspaceDir = readRequiredAbsolutePathArg(args, "workspace_dir");
  const pdfPath = readRequiredAbsolutePathArg(args, "pdf_path");
  return await recordAppPdfExport({
    workspace_dir: workspaceDir,
    pdf_path: pdfPath,
  });
}

async function toolGetAllDiscoveredTemplateGroups(args) {
  const input = normalizeDiscoveryInput(args);
  const groups = await getAllDiscoveredTemplateGroups(input);
  return {
    groups,
    count: groups.length,
  };
}

async function toolGetDiscoveredTemplateGroup(args) {
  if (!args || typeof args.group_id !== "string" || args.group_id.length === 0) {
    throw new Error('Missing required parameter: "group_id"');
  }

  const group = await getDiscoveredTemplateGroup({
    ...normalizeDiscoveryInput(args),
    group_id: args.group_id,
  });

  return {
    group,
    found: Boolean(group),
  };
}

async function toolBuildDeckHtmlFromManifest(args) {
  if (!args || typeof args !== "object") {
    throw new Error("Arguments must be an object");
  }

  if (args.manifest !== undefined) {
    throw new Error('"manifest" is no longer supported; use "manifest_path"');
  }

  const manifestPath = readRequiredAbsolutePathArg(args, "manifest_path");
  const outputDir = readRequiredAbsolutePathArg(args, "output_dir");
  const cwd = readOptionalAbsolutePathArg(args, "cwd");

  const page = args.page !== undefined ? Number(args.page) : undefined;
  if (args.page !== undefined && !Number.isFinite(page)) {
    throw new Error('"page" must be an integer');
  }

  const result = await buildDeckHtmlFromManifest({
    cwd,
    manifestPath,
    outputDir,
    name: typeof args.name === "string" && args.name.length > 0 ? args.name : undefined,
    singlePage: args.single_page !== undefined ? Boolean(args.single_page) : undefined,
    page,
  });

  return {
    output_dir: result.outputDir,
    deck_output_path: result.deckGenerated ? result.deckOutputPath : null,
    deck_file_name: result.deckGenerated ? result.deckFileName : null,
    deck_generated: result.deckGenerated,
    single_page: result.singlePage,
    page: result.page,
    slide_files: result.slideFiles.map((file) => ({
      file_name: file.fileName,
      output_path: file.outputPath,
      slide_id: file.slideId ?? null,
      layout_id: file.layoutId ?? null,
      kind: file.kind ?? "image",
      mime_type: file.mimeType ?? "image/png",
    })),
    slide_count: result.slideCount,
    title: result.title,
    manifest_path: result.manifestPath,
  };
}

async function toolForkTemplateGroup(args) {
  if (!args || typeof args !== "object") {
    throw new Error("Arguments must be an object");
  }

  const templateGroup = typeof args.template_group === "string"
    ? args.template_group
    : typeof args.templateGroup === "string"
      ? args.templateGroup
      : null;
  if (!templateGroup || templateGroup.length === 0) {
    throw new Error('Missing required parameter: "template_group"');
  }

  const outDirValue = typeof args.out_dir === "string"
    ? args.out_dir
    : typeof args.outDir === "string"
      ? args.outDir
      : null;
  if (!outDirValue || outDirValue.length === 0) {
    throw new Error('Missing required parameter: "out_dir"');
  }

  readOptionalAbsolutePathArg(args, "cwd");
  assertAbsolutePath(outDirValue, "out_dir");
  const outDir = path.normalize(outDirValue);
  const result = await forkTemplateGroup({
    templateGroup,
    outDir,
    manifestTitle: typeof args.manifest_title === "string"
      ? args.manifest_title
      : typeof args.manifestTitle === "string"
        ? args.manifestTitle
        : undefined,
    overwrite: args.overwrite !== undefined ? Boolean(args.overwrite) : undefined,
  });

  return {
    ...result,
    template_group: templateGroup,
    manifest_slide_count: Array.isArray(result.manifest?.slides) ? result.manifest.slides.length : 0,
  };
}

// Ordinary business tools are reachable only through the transport gateway.
const TOOL_DISPATCH = {
  app_get_user_template_html: userTemplateOperation("read-master", toolAppGetUserTemplateHtml),
  app_commit_page_visual_plan: toolAppCommitPageVisualPlan,
  app_commit_visual_rhythm: toolAppCommitVisualRhythm,
  app_commit_workspace_page_html: toolAppCommitWorkspacePageHtml,
  app_commit_workspace_visual_master_html: toolAppCommitWorkspaceVisualMasterHtml,
  app_commit_workspace_style_guide: toolAppCommitWorkspaceStyleGuide,
  app_get_runtime_info: toolAppGetRuntimeInfo,
  app_get_agent_resource_info: toolAppGetAgentResourceInfo,
  app_list_performance_runs: toolAppListPerformanceRuns,
  app_start_performance_run: toolAppStartPerformanceRun,
  app_append_performance_events: toolAppAppendPerformanceEvents,
  app_finalize_performance_run: toolAppFinalizePerformanceRun,
  app_regenerate_performance_report: toolAppRegeneratePerformanceReport,
  app_abandon_performance_run: toolAppAbandonPerformanceRun,
  app_delete_performance_run: toolAppDeletePerformanceRun,
  app_prepare_performance_report: toolAppPreparePerformanceReport,
  app_begin_generation_run: toolAppBeginGenerationRun,
  app_prepare_generation_run: toolAppPrepareGenerationRun,
  app_abandon_generation_run: toolAppAbandonGenerationRun,
  app_commit_generation_run: toolAppCommitGenerationRun,
  app_cleanup_generation_run: toolAppCleanupGenerationRun,
  app_get_workspace_generation_run: toolAppGetWorkspaceGenerationRun,
  app_list_workspaces: toolAppListWorkspaces,
  app_patch_workspace_defaults: toolAppPatchWorkspaceDefaults,
  app_get_workspace_defaults: toolAppGetWorkspaceDefaults,
  app_create_workspace: toolAppCreateWorkspace,
  app_open_workspace: toolAppOpenWorkspace,
  app_install_workspace_authoring_kit: toolAppInstallWorkspaceAuthoringKit,
  app_ensure_confirmed_outline_page_ids: toolAppEnsureConfirmedOutlinePageIds,
  app_prepare_workspace_page_sources: toolAppPrepareWorkspacePageSources,
  app_reconcile_workspace_page_sources: toolAppReconcileWorkspacePageSources,
  app_prepare_page_refinement: toolAppPreparePageRefinement,
  app_commit_deck_refinement: toolAppCommitDeckRefinement,
  app_get_workspace_visual_master_html: toolAppGetWorkspaceVisualMasterHtml,
  app_page_regeneration: toolAppPageRegeneration,
  app_list_workspace_template_references: toolAppListWorkspaceTemplateReferences,
  app_get_workspace_template_reference_html: toolAppGetWorkspaceTemplateReferenceHtml,
  app_get_workspace_aesthetic_reference_selections: toolAppGetWorkspaceAestheticReferenceSelections,
  app_record_workspace_aesthetic_reference_selection: toolAppRecordWorkspaceAestheticReferenceSelection,
  app_get_visual_rhythm_status: toolAppGetVisualRhythmStatus,
  app_get_visual_rhythm: toolAppGetVisualRhythm,
  app_get_page_visual_plan_status: toolAppGetPageVisualPlanStatus,
  app_get_page_visual_plan: toolAppGetPageVisualPlan,
  app_get_workspace_style_guide_status: toolAppGetWorkspaceStyleGuideStatus,
  app_get_workspace_style_guide: toolAppGetWorkspaceStyleGuide,
  app_ensure_workspace_persistent_elements_reference: toolAppEnsureWorkspacePersistentElementsReference,
  app_get_workspace_persistent_elements_status: toolAppGetWorkspacePersistentElementsStatus,
  app_typecheck_workspace_persistent_elements: toolAppTypecheckWorkspacePersistentElements,
  app_initialize_page_progress: toolAppInitializePageProgress,
  app_rebuild_workspace_deck_manifest: toolAppRebuildWorkspaceDeckManifest,
  app_get_workspace_page_source_fingerprint: toolAppGetWorkspacePageSourceFingerprint,
  app_commit_uploaded_source_host_upload: toolAppCommitUploadedSourceHostUpload,
  app_page_image_upload: toolAppPageImageUpload,
  app_outline_image_descriptions: toolAppOutlineImageDescriptions,
  app_upload_uploaded_source_for_agent: toolAppUploadUploadedSourceForAgent,
  app_list_style_profiles: toolAppListStyleProfiles,
  app_list_user_templates: toolAppListUserTemplates,
  app_get_user_template: userTemplateOperation("read-template", (args) => getUserTemplate(args.id)),
  app_create_user_template: toolAppCreateUserTemplate,
  app_save_user_template_source: userTemplateOperation("save-source", toolAppSaveUserTemplateSource),
  app_append_user_template_log: (args) => appendUserTemplateLog(args),
  app_prepare_user_template_diagnostic_bundle: toolAppPrepareUserTemplateDiagnosticBundle,
  app_select_user_template_pages: userTemplateOperation("rasterize-pages", (args) => selectUserTemplatePages(args.id, args.page_numbers)),
  app_save_user_template_html: userTemplateOperation("save-html-and-render-preview", toolAppSaveUserTemplateHtml),
  app_save_user_template_profile: userTemplateOperation("save-profile", toolAppSaveUserTemplateProfile),
  app_create_image_user_template: toolAppCreateImageUserTemplate,
  app_publish_user_template: userTemplateOperation("publish-template", (args) => publishUserTemplate(args.id, args.metadata)),
  app_get_user_template_asset: userTemplateOperation("prepare-asset", toolAppUserTemplateAsset),
  app_save_user_template_profile_asset: userTemplateOperation("save-profile-asset", toolAppSaveUserTemplateProfileAsset),
  app_delete_user_template: (args) => deleteUserTemplate(args.id),
  app_get_style_profile_preview: toolAppGetStyleProfilePreview,
  app_get_style_profile: toolAppGetStyleProfile,
  app_prepare_style_profile_creation: toolAppPrepareStyleProfileCreation,
  app_commit_style_profile_reference_host_upload: toolAppCommitStyleProfileReferenceHostUpload,
  app_get_style_profile_creation_context: toolAppGetStyleProfileCreationContext,
  app_get_style_profile_draft_fingerprint: toolAppGetStyleProfileDraftFingerprint,
  app_get_style_profile_draft: toolAppGetStyleProfileDraft,
  app_publish_style_profile: toolAppPublishStyleProfile,
  app_select_workspace_style_profile: toolAppSelectWorkspaceStyleProfile,
  app_get_workspace_style_profile: toolAppGetWorkspaceStyleProfile,
  app_clear_workspace_style_profile: toolAppClearWorkspaceStyleProfile,
  app_rasterize_pptx_to_images: toolAppRasterizePptxToImages,
  app_list_uploaded_sources: toolAppListUploadedSources,
  app_run_uploaded_source_preflight: toolAppRunUploadedSourcePreflight,
  app_continue_uploaded_source_pdf_ocr: toolAppContinueUploadedSourcePdfOcr,
  app_get_uploaded_source_preflight_status: toolAppGetUploadedSourcePreflightStatus,
  app_get_uploaded_source_preflight_text: toolAppGetUploadedSourcePreflightText,
  app_get_uploaded_source_preflight_chunks: toolAppGetUploadedSourcePreflightChunks,
  app_ignore_uploaded_source: toolAppIgnoreUploadedSource,
  app_prepare_attachment_brief: toolAppPrepareAttachmentBrief,
  app_get_attachment_brief_draft: toolAppGetAttachmentBriefDraft,
  app_record_attachment_brief: toolAppRecordAttachmentBrief,
  app_get_attachment_brief: toolAppGetAttachmentBrief,
  app_list_attachment_briefs: toolAppListAttachmentBriefs,
  app_write_attachment_context: toolAppWriteAttachmentContext,
  app_get_attachment_context: toolAppGetAttachmentContext,
  app_remove_uploaded_source: toolAppRemoveUploadedSource,
  app_prepare_uploaded_source_analysis_workspace: toolAppPrepareUploadedSourceAnalysisWorkspace,
  app_record_uploaded_source_analysis_draft: toolAppRecordUploadedSourceAnalysisDraft,
  app_get_uploaded_source_analysis_draft: toolAppGetUploadedSourceAnalysisDraft,
  app_get_uploaded_source_analysis_draft_fingerprint: toolAppGetUploadedSourceAnalysisDraftFingerprint,
  app_record_uploaded_source_analysis: toolAppRecordUploadedSourceAnalysis,
  app_get_uploaded_source_analysis: toolAppGetUploadedSourceAnalysis,
  app_append_workspace_log: toolAppAppendWorkspaceLog,
  app_write_research_test_file: toolAppWriteResearchTestFile,
  app_get_workspace_requirements: toolAppGetWorkspaceRequirements,
  app_update_workspace_requirements: toolAppUpdateWorkspaceRequirements,
  app_confirm_workspace_requirements: toolAppConfirmWorkspaceRequirements,
  app_get_workspace_outline: toolAppGetWorkspaceOutline,
  app_reset_workspace_outline: toolAppResetWorkspaceOutline,
  app_save_workspace_outline_draft: toolAppSaveWorkspaceOutlineDraft,
  app_confirm_workspace_outline: toolAppConfirmWorkspaceOutline,
  app_update_workspace_settings: toolAppUpdateWorkspaceSettings,
  app_patch_workspace_settings: toolAppPatchWorkspaceSettings,
  app_update_workspace_title: toolAppUpdateWorkspaceTitle,
  app_duplicate_workspace: toolAppDuplicateWorkspace,
  app_delete_workspace: toolAppDeleteWorkspace,
  app_list_template_groups: toolAppListTemplateGroups,
  app_get_template_group: toolAppGetTemplateGroup,
  app_select_workspace_template: toolAppSelectWorkspaceTemplate,
  app_get_template_planning_context: toolAppGetTemplatePlanningContext,
  app_get_workspace_theme_context: toolAppGetWorkspaceThemeContext,
  app_validate_workspace_theme_token: toolAppValidateWorkspaceThemeToken,
  app_record_workspace_theme_token: toolAppRecordWorkspaceThemeToken,
  app_get_workspace_page_file_fingerprints: toolAppGetWorkspacePageFileFingerprints,
  app_get_page_progress: toolAppGetPageProgress,
  app_prepare_shared_research_workspace: toolAppPrepareSharedResearchWorkspace,
  app_get_shared_research_context: toolAppGetSharedResearchContext,
  app_patch_shared_research_progress: toolAppPatchSharedResearchProgress,
  app_publish_prepared_web_research_batch: toolAppPublishPreparedWebResearchBatch,
  app_publish_prepared_image_research_batch: toolAppPublishPreparedImageResearchBatch,
  app_append_web_research_batch: toolAppAppendWebResearchBatch,
  app_page_image_search: toolAppPageImageSearch,
  app_append_image_research_batch: toolAppAppendImageResearchBatch,
  app_prepare_shared_research_image_candidate: toolAppPrepareSharedResearchImageCandidate,
  app_upload_shared_research_image_candidate: toolAppUploadSharedResearchImageCandidate,
  app_import_shared_research_image_local: toolAppImportSharedResearchImageLocal,
  app_import_uploaded_source_image_to_research: toolAppImportUploadedSourceImageToResearch,
  app_copy_uploaded_source_image_to_asset: toolAppCopyUploadedSourceImageToAsset,
  app_cleanup_shared_research_image_staging: toolAppCleanupSharedResearchImageStaging,
  app_record_page_progress: toolAppRecordPageProgress,
  app_render_workspace_page_preview: toolAppRenderWorkspacePagePreview,
  app_audit_workspace_page_layout: toolAppAuditWorkspacePageLayout,
  app_upload_current_page_screenshot: toolAppUploadCurrentPageScreenshot,
  app_get_page_edit_context: toolAppGetPageEditContext,
  app_commit_manual_page_image: toolAppCommitManualPageImage,
  app_refresh_manual_page_resources: toolAppRefreshManualPageResources,
  app_pin_managed_font: toolAppPinManagedFont,
  app_commit_managed_font_host_upload: toolAppCommitManagedFontHostUpload,
  app_save_manual_page_revision: toolAppSaveManualPageRevision,
  app_publish_workspace_snapshot: toolAppPublishWorkspaceSnapshot,
  app_get_workspace_snapshot_sync_state: toolAppGetWorkspaceSnapshotSyncState,
  app_get_workspace_snapshot_info: toolAppGetWorkspaceSnapshotInfo,
  app_run_workspace_snapshot_publish_dedicated_invoke: toolAppRunWorkspaceSnapshotPublishDedicatedInvoke,
  app_get_workspace_snapshot_publish_status: toolAppGetWorkspaceSnapshotPublishStatus,
  app_restore_workspace_snapshot: toolAppRunWorkspaceSnapshotRestore,
  app_get_workspace_snapshot_restore_status: toolAppGetWorkspaceSnapshotRestoreStatus,
  app_reconcile_workspace_with_cloud: toolAppReconcileWorkspaceWithCloud,
  app_list_my_work: toolAppListMyWork,
  app_auto_restore_missing_workspaces: toolAppAutoRestoreMissingWorkspaces,
  app_get_auto_restore_decisions: toolAppGetAutoRestoreDecisions,
  app_prepare_page_recovery: (args) => prepareAppPageRecovery({ workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"), page_id: args.page_id }),
  app_restore_page_source_version: toolAppRestorePageSourceVersion,
  app_get_rendered_deck_html: toolAppGetRenderedDeckHtml,
  app_prepare_workspace_page_preview: toolAppPrepareWorkspacePagePreview,
  app_get_workspace_page_preview_preparation: toolAppGetWorkspacePagePreviewPreparation,
  app_get_outline_image_preview: (args) => getAppOutlineImagePreview({
    workspace_dir: readRequiredAbsolutePathArg(args, "workspace_dir"),
    asset_id: readRequiredStringArg(args, "asset_id"),
    size: args.size,
  }),
  app_upload_outline_image_for_agent: toolAppUploadOutlineImageForAgent,
  app_get_workspace_page_html: toolAppGetWorkspacePageHtml,
  app_get_workspace_page_thumbnail: toolAppGetWorkspacePageThumbnail,
  app_render_deck_html: toolAppRenderDeckHtml,
  app_start_pptx_export: toolAppStartPptxExport,
  app_get_pptx_export_status: toolAppGetPptxExportStatus,
  app_run_pptx_export: toolAppRunPptxExport,
  app_run_export_only: toolAppRunExportOnly,
  app_start_export_artifact_publish: toolAppStartExportArtifactPublish,
  app_get_export_artifact_publish_status: toolAppGetExportArtifactPublishStatus,
  app_get_export_artifact_download_url: toolAppGetExportArtifactDownloadUrl,
  app_prepare_workspace_diagnostic_bundle: toolAppPrepareWorkspaceDiagnosticBundle,
  app_create_batch_test_run: toolAppCreateBatchTestRun,
  app_list_batch_test_runs: toolAppListBatchTestRuns,
  app_update_batch_test_case: toolAppUpdateBatchTestCase,
  app_update_batch_test_run: toolAppUpdateBatchTestRun,
  app_delete_batch_test_run: toolAppDeleteBatchTestRun,
  app_materialize_performance_run: toolAppMaterializePerformanceRun,
  app_prepare_batch_test_bundle: toolAppPrepareBatchTestBundle,
  app_export_pdf: toolAppExportPdf,
  app_record_pdf_export: toolAppRecordPdfExport,
  listDiscoveredTemplateGroupSummaries: toolListDiscoveredTemplateGroupSummaries,
  getAllDiscoveredTemplateGroups: toolGetAllDiscoveredTemplateGroups,
  getDiscoveredTemplateGroup: toolGetDiscoveredTemplateGroup,
  buildDeckHtmlFromManifest: toolBuildDeckHtmlFromManifest,
  forkTemplateGroup: toolForkTemplateGroup,
};

// Host uses the same JSON-RPC method for ordinary and async calls. Restrict
// direct dispatch by tool name; never trust an argument claiming async origin.
const ASYNC_TOOL_DISPATCH = {
  app_run_pdf_export: toolAppRunPdfExport,
  app_run_export_artifact_publish: toolAppRunExportArtifactPublish,
};
const DIRECT_TOOL_DISPATCH = {
  [INVOKE_TRANSPORT_TOOL]: toolAppInvokeTransport,
  [INVOKE_CHANNEL_TOOL]: (args) => invokeTransportChannel.handle(args),
  ...ASYNC_TOOL_DISPATCH,
};

function validateToolRegistry(definition, routedToolNames, label) {
  if (!Array.isArray(definition.tools)) {
    throw new Error(`${label} must include a tools array`);
  }
  const toolNames = definition.tools.map((tool) => {
    if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || tool.name.length === 0) {
      throw new Error(`${label} tools entries must include non-empty name values`);
    }
    return tool.name;
  });
  const names = new Set(toolNames);
  const missingHandlers = toolNames.filter((toolName) => !routedToolNames.has(toolName));
  const missingManifestEntries = Array.from(routedToolNames).filter(
    (toolName) => !names.has(toolName),
  );
  if (names.size !== toolNames.length || missingHandlers.length > 0 || missingManifestEntries.length > 0) {
    throw new Error([
      `${label} tool declarations do not match plugin dispatch.`,
      names.size !== toolNames.length ? "duplicate tool names" : "",
      missingHandlers.length > 0 ? `missing handlers: ${missingHandlers.join(", ")}` : "",
      missingManifestEntries.length > 0 ? `missing manifest entries: ${missingManifestEntries.join(", ")}` : "",
    ].filter(Boolean).join(" "));
  }
  return names;
}

const DIRECT_TOOL_NAMES = validateToolRegistry(MANIFEST, new Set(Object.keys(DIRECT_TOOL_DISPATCH)), "manifest.json");
const INVOKE_TOOL_NAMES = validateToolRegistry(
  JSON.parse(readFileSync(new URL("./invoke-tools.json", import.meta.url), "utf8")),
  new Set([...Object.keys(TOOL_DISPATCH), ...TASK_STATE_MACHINE_TOOL_NAMES]),
  "invoke-tools.json",
);

const invokeTransportChannel = createInvokeTransportChannel({
  directory: path.join(os.tmpdir(), `ppt-invoke-transfers-${process.pid}-${randomUUID()}`),
  uploadFile: uploadLocalFileToHost,
});

async function toolAppInvokeTransport(args, id) {
  const tool = args.tool;
  if (typeof tool !== "string" || !INVOKE_TOOL_NAMES.has(tool)) throw new Error("Invalid invoke transport target");
  const decoded = await decodeInvokePayload(args.payload, { download: downloadInvokeUpload });
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Invoke arguments must be an object");
  return runWithDiagnosticLogging(decoded.diagnostic_logging_enabled === true, async () => {
    const response = TASK_STATE_MACHINE_TOOL_NAMES.includes(tool)
      ? await invokeTaskStateMachine({ jsonrpc: "2.0", id, method: "invoke", params: { tool, arguments: decoded } })
      : await handleInvoke(id, { tool, arguments: decoded });
    const outcome = response.error ? { error: response.error } : { result: response.result };
    return encodeInvokePayload(outcome, {
      fits: (frame) => jsonBytes(makeResponse(id, { success: true, data: frame, tool: INVOKE_TRANSPORT_TOOL })).length <= INVOKE_INLINE_BYTES,
      upload: (bytes) => uploadBufferToHost({ buffer: Buffer.from(bytes), filename: "invoke-response.json", mimeType: "application/json",
        purpose: "user_artifact", workspaceDir: decoded.workspace_dir, source: "ppt-engine.invoke-response" }),
    });
  });
}

async function handleInvoke(id, params = {}, dispatch = TOOL_DISPATCH) {
  const tool = params.tool;
  const args = params.arguments ?? {};

  if (!tool || typeof tool !== "string") {
    return makeResponse(id, undefined, createInvalidParamsError("Missing 'tool' in params"));
  }

  const fn = Object.hasOwn(dispatch, tool) ? dispatch[tool] : undefined;
  if (!fn) {
    return makeResponse(id, undefined, {
      code: -32601,
      message: `Unknown tool: ${tool}`,
      data: { available_tools: Object.keys(dispatch) },
    });
  }

  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return makeResponse(
      id,
      undefined,
      createInvalidParamsError("'arguments' must be an object"),
    );
  }

  if (args.diagnostic_logging_enabled !== undefined && typeof args.diagnostic_logging_enabled !== "boolean") {
    return makeResponse(id, undefined, createInvalidParamsError(
      '"diagnostic_logging_enabled" must be a boolean',
    ));
  }
  return runWithDiagnosticLogging(args.diagnostic_logging_enabled === true, () =>
    executeToolInvoke(id, tool, args, fn));
}

async function executeToolInvoke(id, tool, args, fn) {
  const isPerformanceControl = tool.startsWith("app_") && tool.includes("performance_");
  let performanceContext = null;
  try {
    performanceContext = isPerformanceControl ? null : readPerformanceContext(args);
  } catch (error) {
    return makeResponse(id, undefined, createInvalidParamsError(error instanceof Error ? error.message : String(error)));
  }
  const startedAt = performance.now();
  if (performanceContext) {
    recordToolPerformance(
      performanceContext,
      createPluginPerformanceEvent(performanceContext, "span.started", {
        attributes: { layer: "ppt-engine", tool },
      }),
    );
  }
  try {
    const data = await fn(args, id);
    if (performanceContext) {
      recordToolPerformance(
        performanceContext,
        createPluginPerformanceEvent(performanceContext, "span.finished", {
          duration_ms: performance.now() - startedAt,
          status: "ok",
          attributes: { layer: "ppt-engine", tool, duration_source: "monotonic" },
        }),
      );
    }
    return makeResponse(id, { success: true, data, tool });
  } catch (error) {
    if (performanceContext) {
      recordToolPerformance(
        performanceContext,
        createPluginPerformanceEvent(performanceContext, "span.finished", {
          duration_ms: performance.now() - startedAt,
          status: "error",
          attributes: { layer: "ppt-engine", tool, duration_source: "monotonic" },
        }),
      );
    }
    if (error instanceof HostUploadError || error instanceof ApsFilesError) {
      return makeResponse(id, undefined, {
        code: error.code,
        message: error.message,
        data: error.data,
      });
    }
    const message = error instanceof SyntaxError
      ? `Invalid JSON content: ${error.message}`
      : error instanceof Error
        ? error.message
        : "Tool execution failed";

    const code = /missing required|must be|provide either/i.test(message) ? -32602 : -32603;
    return makeResponse(id, undefined, { code, message });
  }
}

async function handleRequest(request) {
  const { id, method, params = {} } = request;

  switch (method) {
    case "initialize": {
      const protocolVersion = params?.protocolVersion === PROTOCOL_VERSION_V2
        ? PROTOCOL_VERSION_V2
        : params?.protocolVersion === "1.1"
          ? "1.1"
          : PROTOCOL_VERSION_V2;
      if (protocolVersion === PROTOCOL_VERSION_V2) {
        hostUploadClient.enable();
      } else {
        hostUploadClient.disable(
          `host did not negotiate Executa protocol 2.0 (protocolVersion=${JSON.stringify(params?.protocolVersion)})`,
        );
      }
      return makeResponse(id, {
        protocolVersion,
        serverInfo: {
          name: MANIFEST.display_name ?? MANIFEST.name ?? "ppt-engine",
          version: MANIFEST.version,
        },
        client_capabilities: protocolVersion === PROTOCOL_VERSION_V2 ? { upload: {} } : {},
        capabilities: protocolVersion === PROTOCOL_VERSION_V2
          ? { storage: { files: true } }
          : {},
      });
    }
    case "describe": {
      return makeResponse(id, MANIFEST);
    }
    case "invoke":
      return bindInvoke(params, () => handleInvoke(id, params, DIRECT_TOOL_DISPATCH));
    case "health":
      return makeResponse(id, {
        status: "healthy",
        timestamp: new Date().toISOString(),
        version: MANIFEST.version,
        tools_count: MANIFEST.tools.length,
      });
    default:
      return makeResponse(id, undefined, {
        code: -32601,
        message: `Method not found: ${method}`,
      });
  }
}

const rl = readline.createInterface({ input: process.stdin });
let isShuttingDown = false;
let pendingRequests = 0;

function exitWhenDrained() {
  if (isShuttingDown && pendingRequests === 0) {
    process.exit(0);
  }
}

function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  if (signal) {
    process.stderr.write(`Received ${signal}; shutting down\n`);
  }
  rl.close();
}

process.stderr.write("🔌 Presenton template engine Executa plugin started\n");
process.stderr.write(`   Tools: ${[...DIRECT_TOOL_NAMES].join(", ")}\n`);

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed || isShuttingDown) {
    return;
  }

  const { request, parseErrorResponse } = parseRequestLine(trimmed);
  if (!parseErrorResponse && request && typeof request === "object" && !Array.isArray(request) && !("method" in request)) {
    if (!hostUploadClient.dispatchResponse(request) && !apsFilesClient.dispatchResponse(request)) {
      process.stderr.write(`← unmatched-response id=${formatRpcId(request.id)}\n`);
    }
    return;
  }
  process.stderr.write(`${summarizeIncomingRequest(request, trimmed)}\n`);

  pendingRequests += 1;
  try {
    const response = parseErrorResponse ?? await handleRequest(request);
    await emitResponse(request, response);
  } catch (error) {
    const fallbackResponse = makeResponse(null, undefined, {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal error",
      });
    await emitResponse(request, fallbackResponse);
    process.stderr.write(
      `→ error ${summarizeResponse(request, fallbackResponse)} bytes=${Buffer.byteLength(JSON.stringify(fallbackResponse), "utf8")}\n`,
    );
  } finally {
    pendingRequests -= 1;
    exitWhenDrained();
  }
});

rl.on("close", () => {
  isShuttingDown = true;
  exitWhenDrained();
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
