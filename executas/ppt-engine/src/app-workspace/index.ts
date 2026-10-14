import { ZipArchive, type ArchiverError } from "archiver";
import { appendDirectoryDiagnosticLog } from "../diagnostics/log.js";
import { writeDirectoryDiagnosticArchive, appendDiagnosticBundleTree, verifyDiagnosticBundleEntry, type DiagnosticBundleEntrySnapshot } from "../diagnostics/archive.js";
import { assertRecoveryFilesUnchanged, captureRecoveryFiles, recoveryHash, selectPageRecoveryCandidate, withPageRecoveryWriteQueue, type PageRecoveryOption } from "../page-html-preview/recovery.js";
import { commitPageUploadedImage, describePageUploadedImage, readPageUploadedImages, resolvePageUploadedImage } from "./page-image-upload.js";
import { IMAGE_ASSET_EXTENSIONS, writeImageAssetFile } from "./image-asset-file.js";
import { readImageCandidateReferences } from "./image-candidates.js";
import { readPagePreviewFallbacks } from "../page-html-preview/fallback.js";
import { appendPreviewRecoveryLog } from "../page-html-preview/recovery-log.js";
import { cleanupGeneratedPageImages } from "../page-html-preview/cleanup.js";
import { fingerprintPageSnapshot } from "../page-html-preview/snapshot.js";
import { getPagePreviewPreparationStatus, submitPagePreviewPreparation } from "../page-html-preview/preparation.js";
import { isStaticPageSource, readWorkspacePageSnapshot, resolveCurrentPageSnapshot } from "../page-html-preview/current-page.js";
import { ensurePageThumbnail, preparePageThumbnail } from "../page-html-preview/thumbnail.js";
import { rewriteHtmlResourceReferences } from "../page-html-preview/resources.js";
import { isDiagnosticLoggingEnabled } from "../diagnostic-logging.js";
import os from "node:os";
import { auditHtmlFile } from "../layout-audit/audit.js";
import { PREVIEW_HTML_MAX_BYTES } from "../page-html-preview/limits.js";
import { batchDirectory, candidateDirectory, fingerprint, latestBatch, publishPageRegenerationFiles, readBatch, recoverPageRegenerationPublication, withBatchLock, writeBatch } from "../page-regeneration/store.js";
import type { PageRegenerationBatch } from "../page-regeneration/types.js";
import { prepareBeautificationSource } from "../page-regeneration/beautification.js";
import path from "node:path";
import { normalizeSlideAspectRatio, slideFormat, slideFormatFromHtml, stampSlideFormat } from "../slide-format.js";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { accessSync, createReadStream, createWriteStream } from "node:fs";
import { appendFile, copyFile, lstat, mkdir, readlink, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import {
  abandonGenerationRun,
  beginGenerationRun,
  cleanupGenerationRun,
  commitGenerationRun,
  copyTree,
  deleteGenerationRunsForWorkspace,
  findGenerationRunForWorkspace,
  listGenerationRunsForWorkspace,
  prepareGenerationRun,
  rebaseTextTree,
  recoverGenerationRunForWorkspace,
  removeWithFilesystemRetry,
  type AppGenerationRunKind,
  type AppGenerationRunTransaction,
  withGenerationWorkspaceLock,
  withActiveGenerationWorkspace,
} from "./generation-run.js";
import sharp from "sharp";
// sharp/libvips loads webp lazily and its operation cache pins the open source
// fd; on Windows that leaves a permanent delete-lock on every derived webp the
// engine reads. Disable the cache so each read releases the fd when finished.
sharp.cache(false);
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import {
  getDiscoveredTemplateGroup,
  listDiscoveredTemplateGroupSummaries,
  type DiscoveredTemplateGroupSummaryInfo,
} from "../discovery/index.js";
import { forkTemplateGroup } from "../fork/fork-template-group.js";
import {
  buildStaticDeckHtml,
} from "../render/build-deck.js";
import {
  buildDeckHtmlFromManifest,
  buildDeckPageScreenshotFromManifest,
} from "../render/build-deck-from-manifest.js";
import { writeSlideScreenshots, writeSlideWebpThumbnail } from "../render/browser-artifacts.js";
import {
  ensureSinglePageSlideShell,
  manualPageRevisionPaths,
  normalizeManualPageResources,
  extractSlideShell,
  publishManualPageIntoDeck,
  publishManualPageRevision,
  readManualPageRevision,
  removeAllManualPageRevisions,
  removeManualPageRevision,
  removePageOwnedManualArtifacts,
  replaceSlideShellAtIndex,
  replaceSinglePageSlideShell,
  sanitizeManualPageHtml,
} from "../manual-page-revisions/index.js";
import { validateThemeTokenRecord } from "../render/theme-tokens.js";
import { resolveLocalModulePath } from "../local-template/loader.js";
import { assertLocalTemplateTypecheck } from "../local-template/typecheck.js";
import {
  createPdfFromSlideHtmlPaths,
} from "./pdf-export.js";
import { selectPdfSlideHtmlPaths } from "./pdf-page-selection.js";
import { convertDeckHtmlToPptx } from "../pptx-export/dom-to-pptx.js";
import { rasterizePptxToImages } from "../pptx-rasterization/index.js";
import {
  ensureWorkspacePersistentElementsReference,
  fingerprintWorkspacePersistentElements,
  prepareWorkspacePageSources,
} from "../authoring-kit-workspace/index.js";
import {
  injectWorkspaceManagedFontCss,
  listManagedFontLibrary,
  listWorkspaceManagedFontLibrary,
  managedFontVariantWarningsForHtml,
  managedFontsUsedByHtml,
} from "../font-library/index.js";
import { getPptWorkspaceRoot } from "../workspace-root.js";
import {
  clearWorkspaceTombstone,
  getWorkspaceTombstone,
  writeWorkspaceTombstone,
} from "./workspace-tombstone.js";
import { validateTemplateHtml } from "../user-templates/index.js";
import { extractUploadedSource } from "../uploaded-source-preflight/extract.js";
import type { PdfOcrPageResult } from "../uploaded-source-preflight/types.js";
import {
  canContinuePartialSource,
  canUseFullContextForPartialSpreadsheet,
  estimateTokens,
  selectOriginalReadingMethod,
} from "../uploaded-source-preflight/routing.js";
import {
  commitWorkspaceSnapshotPublish,
  commitWorkspaceSnapshotRestore,
  classifyWorkspaceSnapshotReconcile,
  extractWorkspaceSnapshotZip,
  getWorkspaceLocalSnapshotFingerprint,
  getWorkspaceSnapshotPublishStatus,
  getWorkspaceSnapshotRestoreStatus,
  getWorkspaceSnapshotSyncState,
  markWorkspaceSnapshotPublishJobInterrupted,
  markWorkspaceSnapshotRestoreJobInterrupted,
  markWorkspaceSnapshotDirty,
  maybePublishWorkspaceSnapshot,
  recordWorkspaceSnapshotRetry,
  readWorkspaceSnapshotInfo,
  regenerateWorkspaceSnapshot,
  verifyWorkspaceSnapshotZip,
  startWorkspaceSnapshotPublish,
  startWorkspaceSnapshotRestore,
  startWorkspaceSnapshotRebuild,
  writeWorkspaceSnapshotRebuild,
  writeWorkspaceSnapshotPublish,
  writeWorkspaceSnapshotRestore,
  type CommitWorkspaceSnapshotPublishInput,
  type CommitWorkspaceSnapshotRestoreInput,
  type ExtractWorkspaceSnapshotZipInput,
  type ExtractWorkspaceSnapshotZipResult,
  type MaybePublishWorkspaceSnapshotResult,
  type ReadWorkspaceSnapshotInfoResult,
  type RecordWorkspaceSnapshotRetryInput,
  type StartWorkspaceSnapshotPublishInput,
  type StartWorkspaceSnapshotRestoreInput,
  type VerifyWorkspaceSnapshotZipInput,
  type VerifyWorkspaceSnapshotZipResult,
  type WorkspaceLocalSnapshotFingerprint,
  type WorkspaceSnapshotReconcileDecision,
  type WorkspaceSnapshotPublishState,
  type WorkspaceSnapshotRestoreState,
  type WorkspaceSnapshotRebuildState,
} from "./snapshot-sync.js";
import type {
  AppendAppWorkspaceLogInput,
  AppendAppWorkspaceLogResult,
  WriteAppResearchTestFileInput,
  WriteAppResearchTestFileResult,
  AppUploadedSourceIndex,
  AppUploadedSourceMaterial,
  IgnoreAppUploadedSourceInput,
  IgnoreAppUploadedSourceResult,
  AppUploadedSourcePreflightResult,
  AppUploadedSourcePdfOcrProgress,
  AppAttachmentBrief,
  AppAttachmentBriefSheetCoverage,
  AppAttachmentContext,
  AppAttachmentBriefPaths,
  AppUploadedSourceAnalysisDraftFingerprint,
  AppUploadedSourceAnalysisPaths,
  AppReferenceSlideImage,
  AppStyleProfileCreationManifest,
  AppStyleProfileCreationPaths,
  AppStyleProfileDraftFingerprint,
  AppStyleProfileIndex,
  AppStyleProfileIndexEntry,
  AppStyleProfileReferenceMaterial,
  AppTemplateGroupSummary,
  AppCreateWorkspaceSetting,
  AppPresentationRequirements,
  AppPresentationRequirementsCandidates,
  AppPresentationRequirementsSelections,
  AppTemplateRecommendation,
  ConfirmAppWorkspaceRequirementsInput,
  ConfirmAppWorkspaceRequirementsResult,
  AppWorkspaceResult,
  AppWorkspaceSummary,
  AppWorkspaceOutline,
  AppWorkspaceOutlineItem,
  AppOutlineAnalysis,
  AppPageProgress,
  AppPageProgressItem,
  ExportAppPdfInput,
  ExportAppPdfResult,
  AppExportArtifactMirror,
  AppExportArtifactMirrorStatus,
  AppExportArtifactInfo,
  AppExportArtifactPublishJob,
  AppExportArtifactPublishStatus,
  StartAppExportArtifactPublishInput,
  AppExportArtifactSnapshot,
  AppWorkspacePages,
  AppWorkspaceTemplateSelection,
  AppTemplatePlanningBlueprint,
  AppTemplatePlanningContext,
  CreateAppWorkspaceInput,
  CreateAppWorkspaceResult,
  DeleteAppWorkspaceInput,
  DuplicateAppWorkspaceInput,
  DuplicateAppWorkspaceResult,
  BackupWorkspaceAsLocalCopyInput,
  BackupWorkspaceAsLocalCopyResult,
  ListAppUploadedSourcesInput,
  ListAppUploadedSourcesResult,
  RunAppUploadedSourcePreflightInput,
  RunAppUploadedSourcePreflightResult,
  ContinueAppUploadedSourcePdfOcrInput,
  ContinueAppUploadedSourcePdfOcrResult,
  GetAppUploadedSourcePreflightStatusInput,
  GetAppUploadedSourcePreflightStatusResult,
  GetAppUploadedSourcePreflightTextInput,
  GetAppUploadedSourcePreflightTextResult,
  GetAppUploadedSourcePreflightChunksInput,
  GetAppUploadedSourcePreflightChunksResult,
  PrepareAppAttachmentBriefInput,
  GetAppAttachmentBriefDraftInput,
  GetAppAttachmentBriefInput,
  RecordAppAttachmentBriefInput,
  ListAppAttachmentBriefsInput,
  ListAppAttachmentBriefsResult,
  WriteAppAttachmentContextInput,
  GetAppAttachmentContextInput,
  ListAppStyleProfilesResult,
  AppStyleProfileReferenceImagePreview,
  GetAppStyleProfileInput,
  GetAppStyleProfilePreviewInput,
  GetAppStyleProfilePreviewResult,
  GetAppStyleProfileResult,
  GetAppStyleProfileCreationContextInput,
  GetAppStyleProfileCreationContextResult,
  GetAppStyleProfileDraftFingerprintInput,
  GetAppStyleProfileDraftInput,
  GetAppStyleProfileDraftResult,
  GetAppWorkspaceStyleProfileInput,
  GetAppWorkspaceStyleProfileResult,
  GetAppUploadedSourceAnalysisDraftFingerprintInput,
  GetAppUploadedSourceAnalysisDraftInput,
  GetAppUploadedSourceAnalysisInput,
  GetAppPageProgressInput,
  GetAppPageEditContextInput,
  GetAppPageEditContextResult,
  SaveAppManualPageRevisionInput,
  SaveAppManualPageRevisionResult,
  RestoreAppPageSourceVersionInput,
  RestoreAppPageSourceVersionResult,
  PrepareAppPageRefinementInput,
  PrepareAppPageRefinementResult,
  CommitAppDeckRefinementInput,
  CommitAppDeckRefinementResult,
  GetAppExportArtifactInput,
  CommitAppExportArtifactMirrorInput,
  GetAppWorkspaceDefaultsResult,
  GetAppTemplateGroupInput,
  GetAppTemplatePlanningContextInput,
  GetAppWorkspaceThemeContextInput,
  GetAppWorkspaceOutlineInput,
  GetAppWorkspaceRequirementsInput,
  GetAppWorkspaceCoverInput,
  GetAppWorkspaceCoverResult,
  GetAppWorkspacePageImageInput,
  GetAppWorkspacePageImageResult,
  GetAppWorkspacePageFileFingerprintsInput,
  GetAppWorkspacePageFileFingerprintsResult,
  ListAppBatchTestRunsResult,
  ListAppTemplateGroupsResult,
  ListAppWorkspacesResult,
  OpenAppWorkspaceInput,
  RemoveAppUploadedSourceInput,
  RemoveAppUploadedSourceResult,
  ClearAppWorkspaceStyleProfileInput,
  ClearAppWorkspaceStyleProfileResult,
  CommitAppUploadedSourceUploadResult,
  CommitAppStyleProfileReferenceUploadInput,
  CommitAppStyleProfileReferenceUploadResult,
  RecordAppUploadedSourceAnalysisDraftInput,
  RecordAppUploadedSourceAnalysisInput,
  PrepareAppWorkspaceDiagnosticBundleInput,
  AppWorkspaceDiagnosticBundleSnapshot,
  AppBatchTestCaseStatus,
  AppBatchTestRunRecord,
  AppBatchTestRunStatus,
  AppBatchTestTargetStage,
  AppBatchTestBundleSnapshot,
  DeleteAppBatchTestRunResult,
  CreateAppBatchTestCaseInput,
  CreateAppBatchTestRunInput,
  CreateAppBatchTestRunResult,
  PrepareAppBatchTestBundleInput,
  UpdateAppBatchTestCaseInput,
  UpdateAppBatchTestRunInput,
  AppPptxExportJob,
  AppResearchPaths,
  AppSharedResearchContextResult,
  AppendAppImageResearchBatchInput,
  AppendAppWebResearchBatchInput,
  ImportAppSharedResearchImageInput,
  ImportAppSharedResearchImageResult,
  ImportAppUploadedSourceImageToResearchInput,
  CopyAppUploadedSourceImageToAssetInput,
  PatchAppSharedResearchProgressInput,
  PatchAppSharedResearchProgressResult,
  PrepareAppSharedResearchWorkspaceInput,
  PublishAppSharedResearchBatchResult,
  RecordAppPageProgressInput,
  RecordAppWorkspaceStyleGuideInput,
  RecordAppWorkspaceStyleGuideResult,
  AppTemplateReferenceCatalog,
  AppTemplateReferenceHtmlPage,
  AppTemplateReferenceSnapshot,
  AppAestheticReferenceSelections,
  RecordAppWorkspaceHtmlInput,
  RecordAppWorkspacePageHtmlInput,
  RecordAppWorkspaceHtmlResult,
  RecordAppAestheticReferenceSelectionInput,
  RecordAppVisualRhythmInput,
  RecordAppVisualRhythmResult,
  GetAppVisualRhythmStatusInput,
  GetAppVisualRhythmStatusResult,
  GetAppVisualRhythmResult,
  RecordAppPageVisualPlanInput,
  RecordAppPageVisualPlanResult,
  GetAppPageVisualPlanStatusInput,
  GetAppPageVisualPlanStatusResult,
  GetAppPageVisualPlanResult,
  GetAppWorkspaceStyleGuideStatusInput,
  GetAppWorkspaceStyleGuideStatusResult,
  GetAppWorkspaceStyleGuideResult,
  GetAppWorkspacePersistentElementsStatusInput,
  GetAppWorkspacePersistentElementsStatusResult,
  InitializeAppPageProgressInput,
  RecordAppWorkspaceThemeTokenInput,
  RecordAppWorkspaceThemeTokenResult,
  RecordAppPdfExportInput,
  PrepareAppUploadedSourceAnalysisWorkspaceInput,
  PrepareAppUploadedSourceAnalysisWorkspaceResult,
  PrepareAppStyleProfileCreationInput,
  PrepareAppStyleProfileCreationResult,
  PatchAppWorkspaceSettingsResult,
  RenderAppWorkspacePagePreviewInput,
  RenderAppWorkspacePagePreviewResult,
  RenderedAppWorkspacePagePreviewResult,
  RenderAppWorkspaceDeckHtmlInput,
  RenderAppWorkspaceDeckHtmlResult,
  SubmitAppWorkspaceDeckHtmlResult,
  SelectAppWorkspaceTemplateInput,
  SelectAppWorkspaceTemplateResult,
  SelectAppWorkspaceStyleProfileInput,
  SelectAppWorkspaceStyleProfileResult,
  StartAppPptxExportInput,
  ConfirmAppWorkspaceOutlineInput,
  ResetAppWorkspaceOutlineInput,
  SaveAppWorkspaceOutlineDraftInput,
  UpdateAppWorkspaceRequirementsInput,
  UpdateAppWorkspaceSettingsInput,
  UpdateAppWorkspaceTitleInput,
  UploadAppUploadedSourceInput,
  UploadAppUploadedSourceResult,
  ValidateAppWorkspaceThemeTokenInput,
  AppWorkspaceThemeContext,
  AppWorkspaceThemeValidationResult,
  PublishAppStyleProfileInput,
  PublishAppStyleProfileResult,
} from "./types.js";
import {
  applySharedResearchProgressOperations,
  createDefaultSharedResearchProgress,
} from "./shared-research-progress.js";

const WORKSPACE_ROOT = getPptWorkspaceRoot();
const WORKSPACE_FORMAT = "html-authoring-v1";
const LEGACY_TASK_ROOT = path.join(WORKSPACE_ROOT, "tasks");
const WORKSPACE_SETTING_PATH = path.join(WORKSPACE_ROOT, "setting.json");
const WORKSPACE_DIR_PATTERN = /^ppt-\d{8}-\d{6}$/;
const DEFAULT_WORKSPACE_TITLE_PATTERN = /^(?:新建工作区|新建任务|New Workspace|New Task)-\d{4}-\d{2}-\d{2}$/;
const PAGE_ID_PATTERN = /^page-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKSPACE_FILE_NAMES = [
  "task.json",
  "requirements.json",
  "outline.json",
  "page-progress.json",
] as const;
const WORKSPACE_LOG_FILE_NAMES = {
  "attachment-preflight": "attachment-preflight.jsonl",
  "ai-requirements": "ai-requirements.jsonl",
  "ai-requirements-interactions": "ai-requirements-interactions.jsonl",
  "ai-outline": "ai-outline.jsonl",
  "ai-outline-interactions": "ai-outline-interactions.jsonl",
  "ai-style-guide": "ai-style-guide.jsonl",
  "ai-style-guide-interactions": "ai-style-guide-interactions.jsonl",
  "ai-persistent-elements": "ai-persistent-elements.jsonl",
  "ai-persistent-elements-interactions": "ai-persistent-elements-interactions.jsonl",
  "ai-visual-rhythm": "ai-visual-rhythm.jsonl",
  "ai-visual-rhythm-interactions": "ai-visual-rhythm-interactions.jsonl",
  "ai-page-visual-plan": "ai-page-visual-plan.jsonl",
  "ai-page-visual-plan-interactions": "ai-page-visual-plan-interactions.jsonl",
  "ai-page-agent": "ai-page-agent.jsonl",
  "ai-page-agent-interactions": "ai-page-agent-interactions.jsonl",
  "ai-page-agent-stream": "ai-page-agent-stream.jsonl",
  "ai-research": "ai-research.jsonl",
  "ai-research-interactions": "ai-research-interactions.jsonl",
  "research-web-interactions": "research-web-interactions.jsonl",
  "ai-theme": "ai-theme.jsonl",
  "ai-theme-interactions": "ai-theme-interactions.jsonl",
  "storage-transport": "storage-transport.jsonl",
} as const;
const RESEARCH_TEST_ROOT = path.join(WORKSPACE_ROOT, "research-test");
const RESEARCH_TEST_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const RESEARCH_TEST_FILE_NAMES = new Set<WriteAppResearchTestFileInput["file_name"]>([
  "input.json",
  "rounds.jsonl",
  "result.md",
  "meta.json",
]);
const PPTX_EXPORT_STATUS_FILE_NAME = "pptx-export.json";
const EXPORT_ARTIFACT_PUBLISH_STATUS_FILE_PREFIX = "export-artifact-publish";
const PPTX_EXPORT_STATUSES: AppPptxExportJob["status"][] = [
  "idle",
  "queued",
  "validating",
  "converting",
  "completed",
  "failed",
];
const UPLOADED_SOURCE_SINGLE_FILE_MAX_BYTES = 25 * 1024 * 1024;
const UPLOADED_SOURCE_ACTIVE_TOTAL_MAX_BYTES = 100 * 1024 * 1024;
// Cap user-uploaded image attachments (engine-side mirror of the Brief page
// limit) so the cap cannot be bypassed by skipping the frontend.
const UPLOADED_SOURCE_IMAGE_MAX_COUNT = 50;
const UPLOADED_SOURCE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const UPLOADED_SOURCE_ALLOWED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".xlsx",
  ".xls",
  ".csv",
  ".doc",
  ".docx",
  ".pptx",
  ".pdf",
  ".txt",
  ".md",
  ".html",
  ".htm",
]);
const UPLOADED_SOURCE_REJECTED_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".dmg",
  ".pkg",
  ".app",
  ".sh",
  ".bat",
  ".cmd",
  ".ps1",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".rar",
  ".7z",
  ".mp3",
  ".wav",
  ".m4a",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
]);
const STYLE_PROFILE_LIBRARY_DIR = path.join(WORKSPACE_ROOT, "style-profiles");
const STYLE_PROFILE_CREATING_DIR = path.join(STYLE_PROFILE_LIBRARY_DIR, "creating");
const STYLE_PROFILE_PROFILES_DIR = path.join(STYLE_PROFILE_LIBRARY_DIR, "profiles");
const STYLE_PROFILE_INDEX_PATH = path.join(STYLE_PROFILE_LIBRARY_DIR, "index.json");
const STYLE_PROFILE_ALLOWED_EXTENSIONS = new Set([".pptx", ".png", ".jpg", ".jpeg", ".webp"]);
const STYLE_PROFILE_SINGLE_FILE_MAX_BYTES = 100 * 1024 * 1024;
const STYLE_PROFILE_DRAFT_MIN_BYTES = 200;
const STYLE_PROFILE_DRAFT_MAX_BYTES = 8 * 1024;
const STYLE_PROFILE_REFERENCE_ANALYSIS_LIMIT = 5;
const BATCH_TEST_ROOT = path.join(WORKSPACE_ROOT, "test");
const BATCH_TEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const BATCH_TEST_CASE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const BATCH_TEST_BRIEF_MAX_CHARS = 100_000;
const BATCH_TEST_ERROR_MAX_CHARS = 4_000;
const BATCH_TEST_RESEARCH_ROUTING_MAX_CASES = 600;
const BATCH_TEST_RESEARCH_ROUTING_PROMPT_MAX_CHARS = 20_000;
const BATCH_TEST_PAGE_REFINEMENT_CLASSIFICATION_MAX_CASES = 600;
const BATCH_TEST_PAGE_REFINEMENT_CLASSIFICATION_PROMPT_MAX_CHARS = 20_000;
const BATCH_TEST_PAGE_REFINEMENT_TASK_TYPES = new Set([
  "exact_text_edit", "content_rewrite", "style_edit", "layout_edit",
  "web_research", "image_research", "mixed", "unclear",
]);
const BATCH_TEST_PAGE_REFINEMENT_EXECUTION_SCOPES = new Set(["local", "regenerate", "uncertain"]);
const BATCH_TEST_CASE_STATUSES = new Set<AppBatchTestCaseStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
const BATCH_TEST_RUN_STATUSES = new Set<AppBatchTestRunStatus>([
  "queued",
  "running",
  "completed",
  "partial_failure",
  "failed",
  "cancelled",
]);
const BATCH_TEST_TERMINAL_RUN_STATUSES = new Set<AppBatchTestRunStatus>([
  "completed",
  "partial_failure",
  "failed",
  "cancelled",
]);
const BATCH_TEST_TARGET_STAGES = new Set<AppBatchTestTargetStage>([
  "template-recommendation-completed",
  "attachment-context-created",
  "requirements-confirmed",
  "research-routing-completed",
  "page-refinement-classification-completed",
  "web-research-completed",
  "outline-confirmed",
  "image-research-completed",
  "pptx-exported",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function formatWorkspaceId(date = new Date()): string {
  return [
    "ppt",
    `${date.getFullYear()}${padDatePart(date.getMonth() + 1)}${padDatePart(date.getDate())}`,
    `${padDatePart(date.getHours())}${padDatePart(date.getMinutes())}${padDatePart(date.getSeconds())}`,
  ].join("-");
}

function formatDefaultWorkspaceTitle(date = new Date()): string {
  return [
    "新建任务",
    `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`,
  ].join("-");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256BufferHex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeFileNamePart(value: string, fallback: string): string {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : fallback;
}

function isWorkspaceDirName(name: string): boolean {
  return WORKSPACE_DIR_PATTERN.test(name);
}

function assertAbsolutePath(value: string, parameterName: string): void {
  if (!path.isAbsolute(value)) {
    throw new Error(`"${parameterName}" must be an absolute path`);
  }
}

function assertWorkspaceUnderRoot(workspaceDir: string): void {
  const relativePath = path.relative(WORKSPACE_ROOT, workspaceDir);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('"task_dir" must be under the default PPT workspace root');
  }
}

function normalizeWorkspaceDir(workspaceDir: string): string {
  assertAbsolutePath(workspaceDir, "workspace_dir");
  const normalizedWorkspaceDir = path.normalize(workspaceDir);
  assertWorkspaceUnderRoot(normalizedWorkspaceDir);
  const workspaceName = path.basename(normalizedWorkspaceDir);
  if (!isWorkspaceDirName(workspaceName)) {
    throw new Error('"workspace_dir" must point to a ppt-YYYYMMDD-HHmmss directory');
  }
  return normalizedWorkspaceDir;
}

function buildWorkspaceFilePaths(workspaceDir: string) {
  return {
    task: path.join(workspaceDir, "task.json"),
    setting: path.join(workspaceDir, "setting.json"),
    requirements: path.join(workspaceDir, "requirements.json"),
    outline: path.join(workspaceDir, "outline.json"),
    manifest: path.join(workspaceDir, "manifest.json"),
    style_guide: path.join(workspaceDir, "style-guide.md"),
    visual_rhythm: path.join(workspaceDir, "visual-rhythm.md"),
    page_visual_plans: path.join(workspaceDir, "page-visual-plans"),
    persistent_elements: path.join(workspaceDir, "persistent-elements.tsx"),
    authoring_kit: path.join(workspaceDir, "authoring-kit"),
    page_progress: path.join(workspaceDir, "page-progress.json"),
    pages: path.join(workspaceDir, "pages.json"),
    template: path.join(workspaceDir, "template.json"),
    visual_master: path.join(workspaceDir, "visual-master.html"),
    aesthetic_reference_selections: path.join(workspaceDir, "aesthetic-reference-selections.json"),
    template_reference: path.join(workspaceDir, "template-reference"),
  };
}

function buildUploadedSourcePaths(workspaceDir: string) {
  const rootDir = path.join(workspaceDir, "uploaded-sources");
  return {
    root_dir: rootDir,
    files_dir: path.join(rootDir, "files"),
    index_path: path.join(rootDir, "index.json"),
    attachment_context_path: path.join(rootDir, "attachment-context.json"),
    asset_dir: path.join(rootDir, "asset"),
    asset_catalog_path: path.join(rootDir, "asset", "catalog.json"),
  };
}

function buildUploadedSourcePreflightPaths(workspaceDir: string, uploadedSourceId: string) {
  const rootDir = path.join(buildUploadedSourcePaths(workspaceDir).root_dir, "preflight");
  return {
    root_dir: rootDir,
    result_path: path.join(rootDir, `${uploadedSourceId}.json`),
    text_path: path.join(rootDir, `${uploadedSourceId}.txt`),
    pdf_ocr_path: path.join(rootDir, `${uploadedSourceId}.pdf-ocr.json`),
    assets_dir: path.join(rootDir, `${uploadedSourceId}.assets`),
  };
}

function buildAttachmentBriefPaths(workspaceDir: string, uploadedSourceId: string): AppAttachmentBriefPaths {
  const analysisDir = path.join(buildUploadedSourcePaths(workspaceDir).root_dir, "analysis", uploadedSourceId);
  return {
    workspace_dir: workspaceDir,
    source_id: uploadedSourceId,
    analysis_dir: analysisDir,
    draft_path: path.join(analysisDir, "attachment-brief-draft.json"),
    json_path: path.join(analysisDir, "attachment-brief.json"),
  };
}

function buildUploadedSourceAnalysisPaths(workspaceDir: string): AppUploadedSourceAnalysisPaths {
  const rootDir = path.join(workspaceDir, "uploaded-sources", "analysis");
  const draftsDir = path.join(rootDir, "drafts");
  return {
    root_dir: rootDir,
    drafts_dir: draftsDir,
    factual_draft_path: path.join(draftsDir, "uploaded-source-factual.json"),
    visual_draft_path: path.join(draftsDir, "uploaded-source-visual.json"),
    analysis_path: path.join(rootDir, "uploaded-source-analysis.json"),
    analysis_md_path: path.join(rootDir, "uploaded-source-analysis.md"),
  };
}

function createDefaultUploadedSourceIndex(workspaceDir: string): AppUploadedSourceIndex {
  return {
    version: 1,
    workspace_dir: workspaceDir,
    active_total_size_bytes: 0,
    materials: [],
    updated_at: new Date().toISOString(),
  };
}

function normalizeUploadedSourceStatus(value: unknown): AppUploadedSourceMaterial["status"] {
  return value === "removed" || value === "ignored" ? value : "active";
}

function normalizeUploadedSourceMaterial(value: unknown): AppUploadedSourceMaterial | null {
  const record = getPlainRecord(value);
  const uploadedSourceId = normalizeString(record.uploaded_source_id);
  const filePath = normalizeString(record.file_path);
  if (!uploadedSourceId || !filePath) return null;
  return {
    uploaded_source_id: uploadedSourceId,
    status: normalizeUploadedSourceStatus(record.status),
    original_filename: normalizeString(record.original_filename),
    display_name: normalizeString(record.display_name) || normalizeString(record.original_filename) || uploadedSourceId,
    mime_type: normalizeString(record.mime_type),
    extension: normalizeString(record.extension),
    size_bytes: typeof record.size_bytes === "number" && Number.isFinite(record.size_bytes)
      ? Math.max(0, Math.floor(record.size_bytes))
      : 0,
    sha256: normalizeString(record.sha256),
    file_path: filePath,
    duplicate_of: normalizeStringArray(record.duplicate_of),
    created_at: normalizeString(record.created_at) || new Date().toISOString(),
    updated_at: normalizeString(record.updated_at) || new Date().toISOString(),
    removed_at: typeof record.removed_at === "string" ? record.removed_at : null,
    ignored_at: typeof record.ignored_at === "string" ? record.ignored_at : null,
    ignored_reason: typeof record.ignored_reason === "string" ? record.ignored_reason : null,
  };
}

function normalizeUploadedSourceIndex(value: unknown, workspaceDir: string): AppUploadedSourceIndex {
  const record = getPlainRecord(value);
  const materials = Array.isArray(record.materials)
    ? record.materials
        .map(normalizeUploadedSourceMaterial)
        .filter((item): item is AppUploadedSourceMaterial => item !== null)
    : [];
  const activeTotalSize = materials
    .filter((item) => item.status === "active")
    .reduce((sum, item) => sum + item.size_bytes, 0);
  return {
    version: 1,
    workspace_dir: workspaceDir,
    active_total_size_bytes: activeTotalSize,
    materials,
    updated_at: normalizeString(record.updated_at) || new Date().toISOString(),
  };
}

async function readUploadedSourceIndex(workspaceDir: string): Promise<AppUploadedSourceIndex> {
  const paths = buildUploadedSourcePaths(workspaceDir);
  const existing = await readJsonFileIfExists(paths.index_path);
  return normalizeUploadedSourceIndex(existing, workspaceDir);
}

async function writeUploadedSourceIndex(workspaceDir: string, index: AppUploadedSourceIndex): Promise<AppUploadedSourceIndex> {
  const normalized = normalizeUploadedSourceIndex(index, workspaceDir);
  await writeJsonFile(buildUploadedSourcePaths(workspaceDir).index_path, normalized);
  return normalized;
}

function sanitizeUploadedSourceDisplayName(value: string): string {
  return sanitizeFileNameBase(value || "uploaded-source");
}

function readUploadedSourceExtension(filename: string): string {
  return path.extname(filename).trim().toLowerCase();
}

function assertAllowedUploadedSourceFile(filename: string, sizeBytes: number): string {
  const extension = readUploadedSourceExtension(filename);
  if (!extension) {
    throw new Error("Uploaded source file must have an allowed extension.");
  }
  if (UPLOADED_SOURCE_REJECTED_EXTENSIONS.has(extension) || !UPLOADED_SOURCE_ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported uploaded source file type: ${extension}`);
  }
  if (sizeBytes <= 0) {
    throw new Error("Uploaded source file must not be empty.");
  }
  if (sizeBytes > UPLOADED_SOURCE_SINGLE_FILE_MAX_BYTES) {
    throw new Error(`Uploaded source file exceeds the single-file limit of ${UPLOADED_SOURCE_SINGLE_FILE_MAX_BYTES} bytes.`);
  }
  return extension;
}

function createUploadedSourceId(now: Date, sha256: string, existingIds: Set<string>): string {
  const datePart = [
    now.getFullYear(),
    padDatePart(now.getMonth() + 1),
    padDatePart(now.getDate()),
    padDatePart(now.getHours()),
    padDatePart(now.getMinutes()),
    padDatePart(now.getSeconds()),
  ].join("");
  const base = `uploaded-source-${datePart}-${sha256.slice(0, 8)}`;
  if (!existingIds.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  throw new Error("Could not create a unique uploaded-source id.");
}

function decodeUploadedSourceBase64(value: string): Buffer {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('"content_base64" must be a non-empty base64 string');
  }
  const base64 = trimmed.includes(",") ? trimmed.slice(trimmed.indexOf(",") + 1) : trimmed;
  return Buffer.from(base64, "base64");
}

function buildResearchPaths(workspaceDir: string): AppResearchPaths {
  const rootDir = path.join(workspaceDir, "research");
  const evidenceDir = path.join(rootDir, "evidence");
  return {
    root_dir: rootDir,
    evidence_dir: evidenceDir,
    evidence_images_dir: path.join(evidenceDir, "images"),
    web_summary_path: path.join(evidenceDir, "web-summary.md"),
    image_catalog_path: path.join(evidenceDir, "image-catalog.json"),
    images_dir: path.join(evidenceDir, "images"),
    progress_path: path.join(rootDir, "web-image-search-progress.json"),
  };
}

function assertPathUnderWorkspace(workspaceDir: string, targetPath: string, parameterName: string): void {
  const relativePath = path.relative(workspaceDir, targetPath);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`"${parameterName}" must stay inside the workspace directory`);
  }
}

function isPathInsideDir(parentDir: string, targetPath: string): boolean {
  const relativePath = path.relative(parentDir, targetPath);
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function buildPptxExportPaths(workspaceDir: string) {
  const outputDir = path.join(workspaceDir, "output");
  return {
    outputDir,
    statusPath: path.join(outputDir, PPTX_EXPORT_STATUS_FILE_NAME),
    pptxPath: path.join(outputDir, "deck.pptx"),
  };
}

function buildExportArtifactPublishPaths(
  workspaceDir: string,
  artifactType: "pptx" | "pdf",
) {
  const outputDir = path.join(workspaceDir, "output");
  return {
    outputDir,
    statusPath: path.join(
      outputDir,
      `${EXPORT_ARTIFACT_PUBLISH_STATUS_FILE_PREFIX}-${artifactType}.json`,
    ),
  };
}

function isPathWithin(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readJsonFileIfExists(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function atomicWriteTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  // Retry handles transient Windows locks (antivirus scans, brief handles) that
  // make the atomic rename throw EPERM.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await writeFile(temporaryPath, content, "utf8");
      await rename(temporaryPath, filePath);
      return;
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (attempt >= 5) throw error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

async function atomicWriteJsonFile(filePath: string, data: unknown): Promise<void> {
  await atomicWriteTextFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function writePageProgressFile(filePath: string, data: unknown): Promise<void> {
  await atomicWriteJsonFile(filePath, data);
}

const pageProgressWriteQueues = new Map<string, Promise<unknown>>();
const uploadedSourceWriteQueues = new Map<string, Promise<unknown>>();
const styleProfileWriteQueues = new Map<string, Promise<unknown>>();
const themeTokenWriteQueues = new Map<string, Promise<unknown>>();
const exportArtifactWriteQueues = new Map<string, Promise<unknown>>();
const manualFinalDeckWriteQueues = new Map<string, Promise<unknown>>();
const sharedResearchWriteQueues = new Map<string, Promise<unknown>>();

function publishWorkspaceSnapshotFromTrigger(workspaceDir: string): void {
  // A trigger follows an authoritative mutation. Record the mutation before
  // attempting the build so a transient packaging failure cannot leave the old
  // "already synced" state claiming that there is nothing to recover.
  void markWorkspaceSnapshotDirty({ workspace_dir: workspaceDir })
    .then(() => maybePublishWorkspaceSnapshot({ workspace_dir: workspaceDir }))
    .then((result) => {
      if (result.status === "generated") {
        process.stderr.write(
          `[snapshot] generated workspace_id=${result.workspace_id} revision=${result.revision} files=${result.file_count} size=${result.snapshot_size_bytes}\n`,
        );
      }
    })
    .catch((error) => {
      process.stderr.write(
        `[snapshot] error workspace_id=${path.basename(workspaceDir)} ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
}

type ActivePageRender = {
  token: symbol;
  sourceSha256: string;
  renderAttempt: number;
};
type ActiveDeckRender = {
  token: symbol;
  sourceFingerprint: string;
};
const activePageRenders = new Map<string, ActivePageRender>();
const activeDeckRenders = new Map<string, ActiveDeckRender>();
let pptxExportQueue = Promise.resolve();
const activePptxExportJobIds = new Set<string>();
const exportArtifactPublishStatusQueues = new Map<string, Promise<unknown>>();
const exportArtifactPublishStartQueues = new Map<string, Promise<unknown>>();

async function withExportArtifactWriteQueue<T>(
  workspaceDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const queueKey = path.normalize(workspaceDir);
  const previous = exportArtifactWriteQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  exportArtifactWriteQueues.set(queueKey, current);
  try {
    return await current;
  } finally {
    if (exportArtifactWriteQueues.get(queueKey) === current) {
      exportArtifactWriteQueues.delete(queueKey);
    }
  }
}

async function withSharedResearchWriteQueue<T>(workspaceDir: string, operation: () => Promise<T>): Promise<T> {
  const queueKey = path.normalize(workspaceDir);
  const previous = sharedResearchWriteQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  sharedResearchWriteQueues.set(queueKey, current);
  try {
    return await current;
  } finally {
    if (sharedResearchWriteQueues.get(queueKey) === current) sharedResearchWriteQueues.delete(queueKey);
  }
}

async function withManualFinalDeckWriteQueue<T>(
  workspaceDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const queueKey = path.normalize(workspaceDir);
  const previous = manualFinalDeckWriteQueues.get(queueKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tail = run.catch(() => undefined);
  manualFinalDeckWriteQueues.set(queueKey, tail);
  try {
    return await run;
  } finally {
    if (manualFinalDeckWriteQueues.get(queueKey) === tail) {
      manualFinalDeckWriteQueues.delete(queueKey);
    }
  }
}

async function withPageProgressWriteQueue<T>(
  workspaceDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const queueKey = path.normalize(workspaceDir);
  const previous = pageProgressWriteQueues.get(queueKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tail = run.catch(() => undefined);
  pageProgressWriteQueues.set(queueKey, tail);

  try {
    return await run;
  } finally {
    if (pageProgressWriteQueues.get(queueKey) === tail) {
      pageProgressWriteQueues.delete(queueKey);
    }
  }
}

async function withUploadedSourceWriteQueue<T>(
  workspaceDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const queueKey = path.normalize(workspaceDir);
  const previous = uploadedSourceWriteQueues.get(queueKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tail = run.catch(() => undefined);
  uploadedSourceWriteQueues.set(queueKey, tail);

  try {
    return await run;
  } finally {
    if (uploadedSourceWriteQueues.get(queueKey) === tail) {
      uploadedSourceWriteQueues.delete(queueKey);
    }
  }
}

async function withStyleProfileWriteQueue<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const queueKey = path.normalize(key);
  const previous = styleProfileWriteQueues.get(queueKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tail = run.catch(() => undefined);
  styleProfileWriteQueues.set(queueKey, tail);

  try {
    return await run;
  } finally {
    if (styleProfileWriteQueues.get(queueKey) === tail) {
      styleProfileWriteQueues.delete(queueKey);
    }
  }
}

function createPptxExportJob(
  workspaceDir: string,
  patch: Partial<AppPptxExportJob> = {},
): AppPptxExportJob {
  const paths = buildPptxExportPaths(workspaceDir);
  const now = new Date().toISOString();

  return {
    version: 2,
    job_id: `${path.basename(workspaceDir)}-${Date.now()}`,
    status: "queued",
    message: "Waiting to export PPTX.",
    percent: 5,
    current_page: null,
    total_pages: null,
    export_phase: null,
    page_numbers: null,
    workspace_dir: workspaceDir,
    status_path: paths.statusPath,
    output_dir: paths.outputDir,
    deck_html_path: "",
    pptx_path: paths.pptxPath,
    started_at: now,
    updated_at: now,
    completed_at: null,
    error: null,
    warnings: [],
    font_embed_warnings: [],
    warning_count: 0,
    ...patch,
  };
}

function normalizePptxExportJob(
  value: unknown,
  workspaceDir: string,
): AppPptxExportJob {
  const existing =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<AppPptxExportJob>)
      : {};
  const paths = buildPptxExportPaths(workspaceDir);
  const status = PPTX_EXPORT_STATUSES.includes(existing.status as AppPptxExportJob["status"])
    ? existing.status as AppPptxExportJob["status"]
    : "idle";

  return createPptxExportJob(workspaceDir, {
    ...existing,
    version: 2,
    job_id: typeof existing.job_id === "string" && existing.job_id.length > 0
      ? existing.job_id
      : `${path.basename(workspaceDir)}-${Date.now()}`,
    status,
    message: typeof existing.message === "string" ? existing.message : "",
    percent: typeof existing.percent === "number" ? existing.percent : 0,
    current_page: Number.isInteger(existing.current_page) && Number(existing.current_page) > 0
      ? Number(existing.current_page)
      : null,
    total_pages: Number.isInteger(existing.total_pages) && Number(existing.total_pages) > 0
      ? Number(existing.total_pages)
      : null,
    export_phase: existing.export_phase === "rendering" || existing.export_phase === "merging"
      ? existing.export_phase
      : null,
    page_numbers: Array.isArray(existing.page_numbers)
      ? existing.page_numbers.filter((pageNumber): pageNumber is number => Number.isInteger(pageNumber) && pageNumber > 0)
      : null,
    workspace_dir: workspaceDir,
    status_path: paths.statusPath,
    output_dir: paths.outputDir,
    deck_html_path: typeof existing.deck_html_path === "string" ? existing.deck_html_path : "",
    pptx_path: typeof existing.pptx_path === "string" ? existing.pptx_path : paths.pptxPath,
    started_at: typeof existing.started_at === "string" ? existing.started_at : null,
    updated_at: typeof existing.updated_at === "string" ? existing.updated_at : null,
    completed_at: typeof existing.completed_at === "string" ? existing.completed_at : null,
    error:
      existing.error && typeof existing.error === "object" && !Array.isArray(existing.error)
        ? existing.error as AppPptxExportJob["error"]
        : null,
    warnings: Array.isArray(existing.warnings)
      ? existing.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    font_embed_warnings: Array.isArray(existing.font_embed_warnings)
      ? existing.font_embed_warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    warning_count: typeof existing.warning_count === "number" ? existing.warning_count : 0,
  });
}

async function writePptxExportJob(job: AppPptxExportJob): Promise<AppPptxExportJob> {
  await writeJsonFile(job.status_path, {
    ...job,
    updated_at: new Date().toISOString(),
  });
  return getAppPptxExportStatus({ workspace_dir: job.workspace_dir });
}

function createDefaultTaskJson(workspaceDir: string, title?: string) {
  const workspaceId = path.basename(workspaceDir);
  const now = new Date().toISOString();
  return {
    id: workspaceId,
    task_id: workspaceId,
    title: title || workspaceId,
    status: "initialized",
    task_dir: workspaceDir,
    workspace_dir: workspaceDir,
    workspace_format: WORKSPACE_FORMAT,
    created_at: now,
    updated_at: now,
    artifacts: {
      task: "task.json",
      requirements: "requirements.json",
      outline: "outline.json",
      page_progress: "page-progress.json",
      manifest: "manifest.json",
      visual_master: "visual-master.html",
      aesthetic_reference_selections: "aesthetic-reference-selections.json",
      template_reference: "template-reference/",
      page_sources: "slides/",
    },
  };
}

function createDefaultSettingJson() {
  return {
    page_generation_concurrency: 5,
    research_image_session_concurrency: 5,
    research_web_max_rounds: 10,
    research_image_max_searches: 10,
  };
}

function normalizePageGenerationConcurrency(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return 5;
  }

  return Math.max(1, Math.min(10, Math.floor(numericValue)));
}

function normalizeResearchImageSessionConcurrency(value: unknown): number {
  return normalizePageGenerationConcurrency(value);
}

/** Research limits allow a wider range than the generation concurrency knobs. */
function normalizeResearchLimit(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return 10;
  }

  return Math.max(1, Math.min(30, Math.floor(numericValue)));
}

function normalizeSettingJson(setting: unknown): Record<string, unknown> {
  const existing =
    setting && typeof setting === "object" && !Array.isArray(setting)
      ? (setting as Record<string, unknown>)
      : {};
  return {
    page_generation_concurrency: normalizePageGenerationConcurrency(
      existing.page_generation_concurrency,
    ),
    research_image_session_concurrency: normalizeResearchImageSessionConcurrency(
      existing.research_image_session_concurrency,
    ),
    research_web_max_rounds: normalizeResearchLimit(existing.research_web_max_rounds),
    research_image_max_searches: normalizeResearchLimit(existing.research_image_max_searches),
    ...(typeof existing.updated_at === "string" ? { updated_at: existing.updated_at } : {}),
  };
}

async function ensureWorkspaceSetting(): Promise<Record<string, unknown>> {
  await mkdir(WORKSPACE_ROOT, { recursive: true });
  const currentSetting = await readJsonFileIfExists(WORKSPACE_SETTING_PATH);
  const currentRecord =
    currentSetting && typeof currentSetting === "object" && !Array.isArray(currentSetting)
      ? (currentSetting as Record<string, unknown>)
      : {};
  const normalizedSetting = normalizeSettingJson({
    ...createDefaultSettingJson(),
    ...currentRecord,
  });
  if (JSON.stringify(currentSetting) !== JSON.stringify(normalizedSetting)) {
    await writeJsonFile(WORKSPACE_SETTING_PATH, normalizedSetting);
  }

  return normalizedSetting;
}

async function readGlobalWorkspaceDefaults(): Promise<Record<string, unknown>> {
  return ensureWorkspaceSetting();
}

export async function getAppWorkspaceDefaults(): Promise<GetAppWorkspaceDefaultsResult> {
  return {
    workspace_root: WORKSPACE_ROOT,
    setting: await readGlobalWorkspaceDefaults(),
  };
}

async function updateGlobalWorkspaceDefaults(
  setting: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const existing = await ensureWorkspaceSetting();
  const nextSetting = {
    ...normalizeSettingJson({
      ...existing,
      ...setting,
    }),
    updated_at: new Date().toISOString(),
  };

  await writeJsonFile(WORKSPACE_SETTING_PATH, nextSetting);
  return nextSetting;
}

function createDefaultOutlineJson() {
  return normalizeOutlineJson(null);
}

const PRESENTATION_REQUIREMENTS_FIELDS = [
  "slide_count",
  "output_language",
] as const;

function createDefaultPresentationRequirements(): AppPresentationRequirements {
  return {
    version: 1,
    status: "empty",
    source: null,
    candidates: {
      slide_count: [],
      output_language: [],
    },
    selections: {
      slide_count: null,
      output_language: null,
      visual_style_preset: null,
    },
    template_recommendation: null,
    research: {
      web: { recommended: null, reason: "", enabled: null },
      images: { recommended: null, reason: "", enabled: null },
    },
    updated_at: null,
    confirmed_at: null,
  };
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string) {
  const keys = Object.keys(record).sort();
  const expectedKeys = [...expected].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function assertUniqueValues(values: unknown[], label: string) {
  const serialized = values.map((value) => JSON.stringify(value));
  if (new Set(serialized).size !== serialized.length) {
    throw new Error(`${label} candidates must be unique`);
  }
}

// 旧需求只在读取边界丢弃已移除的内容目标，不再将它们写入或传给模型。
function omitRetiredRequirementFields(value: Record<string, unknown>): Record<string, unknown> {
  const { audience: _audience, purpose: _purpose, desired_outcome: _outcome, visual_tone: _tone, ...current } = value;
  return current;
}

function parseRequirementsCandidates(input: unknown): AppPresentationRequirementsCandidates {
  if (!isRecord(input)) throw new Error("requirements.candidates must be an object");
  const value = omitRetiredRequirementFields(input);
  assertExactKeys(value, PRESENTATION_REQUIREMENTS_FIELDS, "requirements.candidates");
  if (!Array.isArray(value.slide_count) || value.slide_count.length > 4) {
    throw new Error("requirements.candidates.slide_count must be an array with at most 4 values");
  }
  const slideCount = value.slide_count.map((candidate, index) => {
    if (!Number.isInteger(candidate) || Number(candidate) <= 0) {
      throw new Error(`requirements.candidates.slide_count[${index}] must be a positive integer`);
    }
    return Number(candidate);
  });
  assertUniqueValues(slideCount, "requirements.candidates.slide_count");
  if (!Array.isArray(value.output_language) || value.output_language.length > 4) {
    throw new Error("requirements.candidates.output_language must be an array with at most 4 values");
  }
  const outputLanguage = value.output_language.map((candidate, index) => {
    const language = normalizeString(candidate).trim();
    if (!language || language.toLowerCase() === "auto") {
      throw new Error(`requirements.candidates.output_language[${index}] must be a concrete language`);
    }
    return language;
  });
  assertUniqueValues(outputLanguage, "requirements.candidates.output_language");
  return {
    slide_count: slideCount,
    output_language: outputLanguage,
  };
}

function parseRequirementsSelections(input: unknown): AppPresentationRequirementsSelections {
  if (!isRecord(input)) throw new Error("requirements.selections must be an object");
  const value = omitRetiredRequirementFields(input);
  for (const key of Object.keys(value)) {
    if (!PRESENTATION_REQUIREMENTS_FIELDS.includes(key as (typeof PRESENTATION_REQUIREMENTS_FIELDS)[number]) && key !== "visual_style_preset" && key !== "aspect_ratio") {
      throw new Error(`requirements.selections contains unexpected field ${key}`);
    }
  }
  const slideCount = value.slide_count;
  if (slideCount !== null && (!Number.isInteger(slideCount) || Number(slideCount) <= 0)) {
    throw new Error("requirements.selections.slide_count must be null or a positive integer");
  }
  const outputLanguage = value.output_language;
  if (outputLanguage !== null && (
    typeof outputLanguage !== "string" ||
    !outputLanguage.trim() ||
    outputLanguage.trim().toLowerCase() === "auto"
  )) {
    throw new Error("requirements.selections.output_language must be null or a concrete language");
  }
  const presetValue = value.visual_style_preset;
  const visualStylePreset = presetValue === undefined || presetValue === null
    ? null
    : (() => {
        if (!isRecord(presetValue)) throw new Error("requirements.selections.visual_style_preset must be null or an object");
        assertExactKeys(presetValue, ["id", "version", "name", "description"], "requirements.selections.visual_style_preset");
        const id = normalizeString(presetValue.id).trim();
        const version = presetValue.version;
        const name = normalizeString(presetValue.name).trim();
        const description = normalizeString(presetValue.description).trim();
        if (!id || !Number.isInteger(version) || Number(version) <= 0 || !name || !description) {
          throw new Error("requirements.selections.visual_style_preset must include a positive version, id, name, and description");
        }
        return { id, version: Number(version), name, description };
      })();
  return {
    ...(value.aspect_ratio === undefined ? {} : { aspect_ratio: normalizeSlideAspectRatio(value.aspect_ratio) }),
    slide_count: slideCount === null ? null : Number(slideCount),
    output_language: outputLanguage === null ? null : outputLanguage.trim(),
    visual_style_preset: visualStylePreset,
  };
}

function parsePresentationResearchChoice(value: unknown, label: string) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertExactKeys(value, ["recommended", "reason", "enabled"], label);
  if (value.recommended !== null && typeof value.recommended !== "boolean") {
    throw new Error(`${label}.recommended must be null or boolean`);
  }
  if (typeof value.reason !== "string") throw new Error(`${label}.reason must be a string`);
  if (value.enabled !== null && typeof value.enabled !== "boolean") {
    throw new Error(`${label}.enabled must be null or boolean`);
  }
  return {
    recommended: value.recommended as boolean | null,
    reason: value.reason.trim(),
    enabled: value.enabled as boolean | null,
  };
}

function parsePresentationResearchRequirements(value: unknown) {
  if (!isRecord(value)) throw new Error("requirements.research must be an object");
  assertExactKeys(value, ["web", "images"], "requirements.research");
  return {
    web: parsePresentationResearchChoice(value.web, "requirements.research.web"),
    images: parsePresentationResearchChoice(value.images, "requirements.research.images"),
  };
}

const TEMPLATE_RECOMMENDATION_MATCH_AXES = ["use_case", "industry", "audience", "format", "style"] as const;

function parseTemplateRecommendationPreset(value: unknown, label: string) {
  if (!isRecord(value)) throw new Error(`${label}.preset must be an object`);
  assertExactKeys(value, ["id", "version", "name", "description"], `${label}.preset`);
  const id = normalizeString(value.id).trim();
  const name = normalizeString(value.name).trim();
  const description = normalizeString(value.description).trim();
  if (!id || !Number.isInteger(value.version) || Number(value.version) <= 0 || !name || !description) {
    throw new Error(`${label}.preset must include a positive version, id, name, and description`);
  }
  return { id, version: Number(value.version), name, description };
}

function parseTemplateRecommendation(value: unknown): AppTemplateRecommendation | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error("requirements.template_recommendation must be null or an object");
  assertExactKeys(value, ["selection_required", "confidence", "trigger", "candidates"], "requirements.template_recommendation");
  if (value.selection_required !== true || value.confidence !== "low" || (value.trigger !== "low_signal" && value.trigger !== "rules_fallback")) {
    throw new Error("requirements.template_recommendation must describe a required low-confidence choice");
  }
  const trigger: AppTemplateRecommendation["trigger"] = value.trigger === "low_signal"
    ? "low_signal"
    : "rules_fallback";
  if (!Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > 3) {
    throw new Error("requirements.template_recommendation.candidates must contain one to three candidates");
  }
  const candidates = value.candidates.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`requirements.template_recommendation.candidates[${index}] must be an object`);
    const label = `requirements.template_recommendation.candidates[${index}]`;
    assertExactKeys(candidate, ["preset", "score", "matched_axes"], label);
    if (typeof candidate.score !== "number" || !Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 1) {
      throw new Error(`${label}.score must be a finite number from 0 through 1`);
    }
    if (!Array.isArray(candidate.matched_axes) || candidate.matched_axes.some((axis) => typeof axis !== "string" || !TEMPLATE_RECOMMENDATION_MATCH_AXES.includes(axis as typeof TEMPLATE_RECOMMENDATION_MATCH_AXES[number]))) {
      throw new Error(`${label}.matched_axes must contain only known matching axes`);
    }
    if (new Set(candidate.matched_axes).size !== candidate.matched_axes.length) {
      throw new Error(`${label}.matched_axes must not contain duplicates`);
    }
    return {
      preset: parseTemplateRecommendationPreset(candidate.preset, label),
      score: candidate.score,
      matched_axes: [...candidate.matched_axes] as typeof TEMPLATE_RECOMMENDATION_MATCH_AXES[number][],
    };
  });
  if (new Set(candidates.map((candidate) => candidate.preset.id)).size !== candidates.length) {
    throw new Error("requirements.template_recommendation candidates must have unique preset IDs");
  }
  return { selection_required: true, confidence: "low", trigger, candidates };
}

function normalizePresentationRequirements(value: unknown): AppPresentationRequirements {
  if (!isRecord(value)) throw new Error("requirements.json must contain an object");
  const { template_recommendation: templateRecommendationValue, ...requirementsValue } = value;
  assertExactKeys(
    requirementsValue,
    ["version", "status", "source", "candidates", "selections", "research", "updated_at", "confirmed_at"],
    "requirements.json",
  );
  if (requirementsValue.version !== 1) throw new Error("requirements.version must be 1");
  if (requirementsValue.status !== "empty" && requirementsValue.status !== "draft" && requirementsValue.status !== "confirmed") {
    throw new Error('requirements.status must be "empty", "draft", or "confirmed"');
  }
  const source = requirementsValue.source === null
    ? null
    : (() => {
        if (!isRecord(requirementsValue.source)) throw new Error("requirements.source must be null or an object");
        assertExactKeys(requirementsValue.source, ["brief"], "requirements.source");
        const brief = normalizeString(requirementsValue.source.brief).trim();
        if (!brief) throw new Error("requirements.source.brief must be a non-empty string");
        return { brief };
      })();
  const candidates = parseRequirementsCandidates(requirementsValue.candidates);
  const selections = parseRequirementsSelections(requirementsValue.selections);
  const templateRecommendation = parseTemplateRecommendation(templateRecommendationValue);
  const research = parsePresentationResearchRequirements(requirementsValue.research);
  const updatedAt = requirementsValue.updated_at === null ? null : normalizeString(requirementsValue.updated_at);
  const confirmedAt = requirementsValue.confirmed_at === null ? null : normalizeString(requirementsValue.confirmed_at);

  if (requirementsValue.status === "empty") {
    if (source !== null || PRESENTATION_REQUIREMENTS_FIELDS.some((field) => candidates[field].length > 0) ||
      PRESENTATION_REQUIREMENTS_FIELDS.some((field) => selections[field] !== null) || selections.visual_style_preset !== null ||
      research.web.recommended !== null || research.web.reason || research.web.enabled !== null ||
      research.images.recommended !== null || research.images.reason || research.images.enabled !== null ||
      templateRecommendation !== null) {
      throw new Error("empty requirements cannot include a source, candidates, or selections");
    }
  } else if (!source) {
    throw new Error(`${requirementsValue.status} requirements must include source.brief`);
  }

  if (requirementsValue.status === "confirmed") {
    const missing = PRESENTATION_REQUIREMENTS_FIELDS.filter((field) => selections[field] === null);
    if (missing.length > 0) {
      throw new Error(`confirmed requirements are missing selections: ${missing.join(", ")}`);
    }
    if (typeof research.web.enabled !== "boolean" || typeof research.images.enabled !== "boolean") {
      throw new Error("confirmed requirements must include Web and image research choices");
    }
    if (templateRecommendation && !selections.visual_style_preset) {
      throw new Error("confirmed requirements must resolve the required template recommendation choice");
    }
    if (templateRecommendation && selections.visual_style_preset && !templateRecommendation.candidates.some((candidate) => (
      candidate.preset.id === selections.visual_style_preset!.id
      && candidate.preset.version === selections.visual_style_preset!.version
    ))) {
      throw new Error("confirmed requirements must select one of the template recommendation candidates");
    }
  }

  return {
    version: 1,
    status: requirementsValue.status,
    source,
    candidates,
    selections,
    template_recommendation: templateRecommendation,
    research,
    updated_at: updatedAt || null,
    confirmed_at: confirmedAt || null,
  };
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sanitizeFileNameBase(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  return normalized || "deck";
}

/**
 * 页面内容是一段连续的叙述性文字，可以跨多个自然段。
 * 这里只做行尾空白清理和空行折叠，不改写正文本身。
 */
function normalizeOutlineContentText(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  if (!value.trim()) throw new Error(`${fieldName} must be a non-empty string`);
  return value;
}

function normalizeOutlineLine(value: unknown, fieldName: string): string {
  const normalized = normalizeString(value).trim();
  if (!normalized) throw new Error(`${fieldName} must be a non-empty string`);
  if (/\r|\n/u.test(normalized)) throw new Error(`${fieldName} must be a single line`);
  return normalized;
}

const OUTLINE_SOURCES = new Set(["user", "ai", "research"]);

function normalizeOutlineTextSegments(value: unknown, fieldName: string): AppWorkspaceOutlineItem["title_segments"] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array`);
  }
  return value.map((segment, index) => {
    if (!isRecord(segment)) throw new Error(`${fieldName}[${index}] must be an object`);
    assertExactKeys(segment, ["text", "source", "focus"], `${fieldName}[${index}]`);
    const text = normalizeString(segment.text);
    if (!text.trim()) throw new Error(`${fieldName}[${index}].text must be a non-empty string`);
    if (/\r|\n/u.test(text)) throw new Error(`${fieldName}[${index}].text must be a single line`);
    const source = normalizeString(segment.source).trim();
    if (!OUTLINE_SOURCES.has(source)) {
      throw new Error(`${fieldName}[${index}].source must be user, ai, or research`);
    }
    if (typeof segment.focus !== "boolean") {
      throw new Error(`${fieldName}[${index}].focus must be a boolean`);
    }
    return { text, source: source as "user" | "ai" | "research", focus: segment.focus };
  });
}

function normalizeOutlineResearchDirection(value: unknown, fieldName: string) {
  if (!isRecord(value)) throw new Error(`${fieldName} must be an object or null`);
  assertExactKeys(value, ["directions", "reason"], fieldName);
  if (!Array.isArray(value.directions)) throw new Error(`${fieldName}.directions must be an array`);
  const directions = value.directions.map((direction, index) =>
    normalizeOutlineLine(direction, `${fieldName}.directions[${index}]`),
  );
  const reason = normalizeOutlineLine(value.reason, `${fieldName}.reason`);
  return { directions, reason };
}

function normalizeOutlineResearch(value: unknown, fieldName: string): AppWorkspaceOutlineItem["research"] {
  if (!isRecord(value)) throw new Error(`${fieldName} must be an object`);
  assertExactKeys(value, ["web", "images"], fieldName);
  return {
    web: value.web === null ? null : normalizeOutlineResearchDirection(value.web, `${fieldName}.web`),
    images: value.images === null ? null : normalizeOutlineResearchDirection(value.images, `${fieldName}.images`),
  };
}

function normalizeOutlineAnalysis(value: unknown, fieldName: string): AppOutlineAnalysis {
  if (!isRecord(value)) throw new Error(`${fieldName} must be an object`);
  assertExactKeys(value, [
    "focus",
    "ai_generated_content",
    "web_needed",
    "web_analysis",
    "images_needed",
    "images_analysis",
  ], fieldName);
  const stringFields = ["focus", "ai_generated_content", "web_analysis", "images_analysis"] as const;
  for (const key of stringFields) {
    if (typeof value[key] !== "string") throw new Error(`${fieldName}.${key} must be a string`);
    if (!normalizeString(value[key]).trim()) throw new Error(`${fieldName}.${key} must be a non-empty string`);
  }
  for (const key of ["web_needed", "images_needed"] as const) {
    if (typeof value[key] !== "boolean") throw new Error(`${fieldName}.${key} must be boolean`);
  }
  return {
    focus: normalizeString(value.focus).trim(),
    ai_generated_content: normalizeString(value.ai_generated_content).trim(),
    web_needed: value.web_needed as boolean,
    web_analysis: normalizeString(value.web_analysis).trim(),
    images_needed: value.images_needed as boolean,
    images_analysis: normalizeString(value.images_analysis).trim(),
  };
}

/** 旧工作区缺省为空；不改写用户指令。 */
function normalizeCreationRequirements(value: unknown, fieldName: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`${fieldName} must be a string`);
  return value;
}

function normalizeValidOutlineItem(
  value: unknown,
  index: number,
  options: { require_page_id?: boolean } = {},
): AppWorkspaceOutlineItem {
  if (!isRecord(value)) throw new Error(`outline.items[${index}] must be an object`);
  const allowedKeys = new Set([
    "page_id",
    "page_type",
    "title",
    "core_message", // 兼容旧大纲输入；读取时丢弃，不再校验、保存或传给模型。
    "content",
    "title_segments",
    "research",
    "analysis",
    "copy_rewrite_freedom", // 仅容忍旧大纲字段；读取后丢弃，不再保存或传给模型。
    "creation_requirements",
    "selected_image_ids",
  ]);
  const unsupportedKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unsupportedKeys.length > 0) {
    throw new Error(`outline.items[${index}] has unsupported fields: ${unsupportedKeys.join(", ")}`);
  }
  for (const key of ["page_type", "title", "content"]) {
    if (!(key in value)) throw new Error(`outline.items[${index}] is missing ${key}`);
  }
  if (options.require_page_id && !("page_id" in value)) {
    throw new Error(`outline.items[${index}] is missing page_id`);
  }
  const pageId = options.require_page_id ? normalizeString(value.page_id) : "";
  if (options.require_page_id && !PAGE_ID_PATTERN.test(pageId)) {
    throw new Error(`outline.items[${index}].page_id must be an opaque page UUID`);
  }
  if (value.selected_image_ids !== undefined && (!Array.isArray(value.selected_image_ids)
    || value.selected_image_ids.some((id) => typeof id !== "string" || !id.trim())
    || new Set(value.selected_image_ids).size !== value.selected_image_ids.length)) {
    throw new Error(`outline.items[${index}].selected_image_ids must contain unique nonempty asset ids`);
  }
  const pageType = normalizeString(value.page_type) || "standard";
  if (pageType !== "cover" && pageType !== "standard") {
    throw new Error(`outline.items[${index}].page_type must be \"cover\" or \"standard\"`);
  }
  const creationRequirements = normalizeCreationRequirements(value.creation_requirements, `outline.items[${index}].creation_requirements`);
  const title = normalizeOutlineLine(value.title, `outline.items[${index}].title`);
  const titleSegments = value.title_segments === undefined
    ? undefined
    : normalizeOutlineTextSegments(value.title_segments, `outline.items[${index}].title_segments`);
  if (titleSegments && titleSegments.map((segment) => segment.text).join("").trim() !== title) {
    throw new Error(`outline.items[${index}].title_segments must concatenate to title`);
  }
  const content = normalizeOutlineContentText(value.content, `outline.items[${index}].content`);
  const analysis = value.analysis === undefined
    ? undefined
    : normalizeOutlineAnalysis(value.analysis, `outline.items[${index}].analysis`);
  return {
    ...(pageId ? { page_id: pageId } : {}),
    page_type: pageType,
    title,
    content,
    ...(titleSegments ? { title_segments: titleSegments } : {}),
    ...(value.research === undefined ? {} : { research: normalizeOutlineResearch(value.research, `outline.items[${index}].research`) }),
    ...(analysis ? { analysis } : {}),
    ...(value.selected_image_ids === undefined ? {} : { selected_image_ids: [...value.selected_image_ids as string[]] }),
    ...(creationRequirements.trim() ? { creation_requirements: creationRequirements } : {}),
  };
}

function outlineItemFromLegacyText(titleValue: unknown, textValue: unknown): AppWorkspaceOutlineItem {
  const title = normalizeString(titleValue).trim() || "Untitled Page";
  const lines = normalizeString(textValue).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    page_type: "standard",
    title: title.replace(/\r|\n/gu, " "),
    content: lines.join("\n") || title,
  };
}

function createEmptyOutlineJson(): AppWorkspaceOutline {
  return {
    version: 4,
    status: "empty",
    title: "",
    global_creation_requirements: "",
    items: [],
    updated_at: null,
    confirmed_at: null,
  };
}

function migrateOutlineV3ToV4(outline: Record<string, unknown>): AppWorkspaceOutline {
  // v3 items carry structured `content` segments plus a plain-text `content_text`
  // (and a legacy `required_content` bullet list); v4 keeps only plain-text `content`.
  // Migrate forward so older workspaces/snapshots stay editable instead of being
  // silently replaced by an empty outline.
  const status = outline.status;
  if (status !== "empty" && status !== "draft" && status !== "confirmed") {
    return createEmptyOutlineJson();
  }
  if (status === "empty") return createEmptyOutlineJson();
  const rawItems = Array.isArray(outline.items) ? outline.items : [];
  const items = rawItems.map((item) => {
    if (!isRecord(item)) return item;
    const { required_content: requiredContent, content_text: contentText, content: rawContent, ...rest } = item;
    let content = normalizeString(contentText).trim();
    if (!content && typeof rawContent === "string") {
      content = rawContent.trim();
    }
    if (!content && Array.isArray(rawContent)) {
      content = rawContent
        .map((group) => {
          if (!isRecord(group) || !Array.isArray(group.segments)) return "";
          return group.segments
            .map((segment) => (isRecord(segment) ? normalizeString(segment.text) : ""))
            .join("");
        })
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
    }
    // Older valid v3 entries may contain only the required_content bullet list.
    if (!content) content = normalizeString(requiredContent).trim();
    return { ...rest, content };
  });
  return normalizeOutlineJson({
    version: 4,
    status,
    title: outline.title,
    items,
    updated_at: outline.updated_at,
    confirmed_at: outline.confirmed_at,
  });
}

function normalizeOutlineJson(outline: unknown): AppWorkspaceOutline {
  if (!isRecord(outline)) return createEmptyOutlineJson();
  if (outline.version === 3) return migrateOutlineV3ToV4(outline);
  if (outline.version !== 4) return createEmptyOutlineJson();
  assertExactKeys(
    outline,
    ["version", "status", "title", "items", "updated_at", "confirmed_at", ...("global_creation_requirements" in outline ? ["global_creation_requirements"] : [])],
    "outline.json",
  );
  if (outline.status !== "empty" && outline.status !== "draft" && outline.status !== "confirmed") {
    throw new Error('outline.status must be "empty", "draft", or "confirmed"');
  }
  if (outline.status === "empty") {
    if (outline.title !== "" || !Array.isArray(outline.items) || outline.items.length !== 0 ||
      outline.updated_at !== null || outline.confirmed_at !== null || normalizeCreationRequirements(outline.global_creation_requirements, "outline.global_creation_requirements") !== "") {
      throw new Error("empty outline cannot include content or timestamps");
    }
    return createEmptyOutlineJson();
  }
  const title = normalizeOutlineLine(outline.title, "outline.title");
  if (!Array.isArray(outline.items) || outline.items.length === 0) {
    throw new Error("outline.items must contain at least one page");
  }
  const confirmedItemsHavePageIds = outline.status === "confirmed" && outline.items.every(
    (item) => isRecord(item) && typeof item.page_id === "string" && item.page_id.length > 0,
  );
  const items = outline.items.map((item, index) => normalizeValidOutlineItem(
    item,
    index,
    { require_page_id: confirmedItemsHavePageIds },
  ));
  if (confirmedItemsHavePageIds && new Set(items.map((item) => item.page_id)).size !== items.length) {
    throw new Error("confirmed outline page_id values must be unique");
  }
  const updatedAt = normalizeString(outline.updated_at).trim();
  if (!updatedAt) throw new Error("persisted outline.updated_at must be a non-empty string");
  const confirmedAt = outline.confirmed_at === null ? null : normalizeString(outline.confirmed_at).trim();
  if (outline.status === "confirmed" && !confirmedAt) {
    throw new Error("confirmed outline.confirmed_at must be a non-empty string");
  }
  if (outline.status === "draft" && confirmedAt !== null) {
    throw new Error("draft outline.confirmed_at must be null");
  }
  return {
    version: 4,
    status: outline.status,
    global_creation_requirements: normalizeCreationRequirements(outline.global_creation_requirements, "outline.global_creation_requirements"),
    title,
    items,
    updated_at: updatedAt,
    confirmed_at: confirmedAt,
  };
}

function getPlainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizePageProgressItem(value: unknown): AppPageProgressItem | null {
  const record = getPlainRecord(value);
  const pageId = normalizeString(record.page_id);
  if (!pageId) return null;

  return {
    page_id: pageId,
    status: PAGE_PROGRESS_PAGE_STATUSES.has(normalizeString(record.status))
      ? normalizeString(record.status)
      : "pending",
    render_attempts: typeof record.render_attempts === "number" ? record.render_attempts : 0,
    visual_review_attempts:
      typeof record.visual_review_attempts === "number" ? record.visual_review_attempts : 0,
    agent_failures: typeof record.agent_failures === "number" ? record.agent_failures : 0,
    agent_infrastructure_failures:
      typeof record.agent_infrastructure_failures === "number"
        ? record.agent_infrastructure_failures
        : 0,
    last_html_path: normalizeString(record.last_html_path),
    last_screenshot_path: normalizeString(record.last_screenshot_path),
    last_error: normalizeString(record.last_error),
    render_source_sha256: normalizeString(record.render_source_sha256),
    snapshot_source_sha256: normalizeString(record.snapshot_source_sha256) || normalizeString(record.screenshot_source_sha256),
    visual_review: record.visual_review ?? null,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : null,
  };
}

/**
 * A committed generation can leave absolute artifact paths pointing at the
 * temporary Shadow Workspace (especially after a Windows directory move).
 * Resolve those paths back to the current official Workspace by preserving
 * the artifact's relative suffix.
 */
function normalizeWorkspaceArtifactPath(workspaceDir: string, value: string): string {
  const normalized = normalizeString(value);
  if (!normalized) return "";
  const absolute = path.normalize(normalized);

  const workspaceName = path.basename(workspaceDir);
  // Cloud/remote Agent runs persist the Linux workspace root in page-progress
  // and related manifests. When that Workspace is opened by the local Windows
  // engine, rebase the known `/data/workspace/ppt/<workspace>/...` suffix to
  // the current local Workspace before falling back to the original path.
  const remoteMarker = `${path.sep}data${path.sep}workspace${path.sep}ppt${path.sep}${workspaceName}${path.sep}`;
  const remoteIndex = absolute.lastIndexOf(remoteMarker);
  if (remoteIndex >= 0) {
    const officialPath = path.join(workspaceDir, absolute.slice(remoteIndex + remoteMarker.length));
    if (fileExistsSync(officialPath)) return officialPath;
  }
  const shadowMarker = `${path.sep}shadow${path.sep}${workspaceName}${path.sep}`;
  const markerIndex = absolute.lastIndexOf(shadowMarker);
  if (markerIndex >= 0) {
    const officialPath = path.join(workspaceDir, absolute.slice(markerIndex + shadowMarker.length));
    if (fileExistsSync(officialPath)) return officialPath;
  }
  const previousMarker = `${path.sep}previous${path.sep}${workspaceName}${path.sep}`;
  const previousIndex = absolute.lastIndexOf(previousMarker);
  if (previousIndex >= 0) {
    const officialPath = path.join(workspaceDir, absolute.slice(previousIndex + previousMarker.length));
    if (fileExistsSync(officialPath)) return officialPath;
  }
  return fileExistsSync(absolute) ? absolute : absolute;
}

function fileExistsSync(filePath: string): boolean {
  try {
    accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

const PAGE_PROGRESS_PAGE_STATUSES = new Set([
  "pending",
  "authoring",
  "rendering",
  "rendered",
  "layout_checking",
  "layout_rewriting",
  "layout_check_failed",
  "render_fixing",
  "visual_review",
  "visual_review_fixing",
  "accepted",
  "interrupted",
  "agent_failed",
  "upload_failed",
  "workspace_commit_failed",
  "agent_infrastructure_failed",
  "render_failed",
]);

const PAGE_PROGRESS_RECOVERY_RUN_KINDS = new Set([
  "deck-generation",
  "page-generation-retry",
  "page-refinement",
  "deck-refinement",
  "final-deck-render",
]);

const PAGE_PROGRESS_RECOVERY_STATUSES = new Set([
  "idle",
  "running",
  "interrupted",
  "failed",
  "completed",
]);

const FINAL_DECK_RENDER_STATUSES = new Set([
  "idle",
  "running",
  "completed",
  "failed",
  "interrupted",
]);

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeString(item))
    .filter((item) => item.length > 0);
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  const record = getPlainRecord(value);
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, rawValue]) => [key, normalizeString(rawValue)] as const)
      .filter(([, rawValue]) => rawValue.length > 0),
  );
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized.length > 0 ? normalized : null;
}

function normalizePageProgressRecoveryState(value: unknown): AppPageProgress["recovery"] {
  const record = getPlainRecord(value);
  const runKind = normalizeString(record.run_kind);
  const status = normalizeString(record.status);
  return {
    status: PAGE_PROGRESS_RECOVERY_STATUSES.has(status)
      ? status as AppPageProgress["recovery"]["status"]
      : "idle",
    run_kind: PAGE_PROGRESS_RECOVERY_RUN_KINDS.has(runKind)
      ? runKind as AppPageProgress["recovery"]["run_kind"]
      : null,
    step: normalizeNullableString(record.step),
    target_page_ids: normalizeStringList(record.target_page_ids),
    refinement_request: normalizeNullableString(record.refinement_request ?? record.page_refinement_request),
    page_refinement_reasons: normalizeStringRecord(record.page_refinement_reasons ?? record.page_refinement_requests),
    error: normalizeNullableString(record.error),
    updated_at: typeof record.updated_at === "string" ? record.updated_at : null,
  };
}

function normalizeFinalDeckRenderState(value: unknown): AppPageProgress["final_deck_render"] {
  const record = getPlainRecord(value);
  const status = normalizeString(record.status);
  return {
    status: FINAL_DECK_RENDER_STATUSES.has(status)
      ? status as AppPageProgress["final_deck_render"]["status"]
      : "idle",
    message: normalizeNullableString(record.message),
    error: normalizeNullableString(record.error),
    output_dir: normalizeNullableString(record.output_dir),
    deck_html_path: normalizeNullableString(record.deck_html_path),
    rendered_at: typeof record.rendered_at === "string" ? record.rendered_at : null,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : null,
    source_fingerprint: normalizeNullableString(record.source_fingerprint),
  };
}

const RESEARCH_DISCOVERY_PHASES = new Set([
  "web-decision",
  "web-collection",
  "visual-decision",
  "visual-collection",
]);

const RESEARCH_DISCOVERY_STATES = new Set([
  "waiting",
  "running",
  "completed",
  "warning",
  "skipped",
]);

function normalizeResearchDiscoveryProgress(value: unknown): AppPageProgress["research_discovery"] {
  const record = getPlainRecord(value);
  const status = normalizeString(record.status);
  if (!RESEARCH_DISCOVERY_STATES.has(status) || !Array.isArray(record.records)) {
    return undefined;
  }
  return {
    ...record,
    status,
    summary: getPlainRecord(record.summary),
    records: record.records
      .map((item) => getPlainRecord(item))
      .filter((item) =>
        RESEARCH_DISCOVERY_PHASES.has(normalizeString(item.phase)) &&
        RESEARCH_DISCOVERY_STATES.has(normalizeString(item.state))
      ),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
  };
}

function normalizePageProgressJson(value: unknown): AppPageProgress {
  const record = getPlainRecord(value);
  const pages = Array.isArray(record.pages)
    ? record.pages
        .map(normalizePageProgressItem)
        .filter((item): item is AppPageProgressItem => item !== null)
    : [];

  return {
    version: 1,
    status: normalizeString(record.status) || "idle",
    recovery: normalizePageProgressRecoveryState(record.recovery),
    final_deck_render: normalizeFinalDeckRenderState(record.final_deck_render),
    research_discovery: normalizeResearchDiscoveryProgress(record.research_discovery),
    pages,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : null,
  };
}

function createDefaultPagesJson() {
  return {
    version: 1,
    pages: [],
    updated_at: null,
  };
}

function createDefaultPageProgressJson(): AppPageProgress {
  return {
    version: 1,
    status: "idle",
    recovery: {
      status: "idle",
      run_kind: null,
      step: null,
      target_page_ids: [],
      refinement_request: null,
      page_refinement_reasons: {},
      error: null,
      updated_at: null,
    },
    final_deck_render: {
      status: "idle",
      message: null,
      error: null,
      output_dir: null,
      deck_html_path: null,
      rendered_at: null,
      updated_at: null,
      source_fingerprint: null,
    },
    research_discovery: undefined,
    pages: [],
    updated_at: null,
  };
}

function createDefaultTemplateJson() {
  return {
    version: 1,
    selected_template_group: "",
    selected_template_group_name: "",
    template_dir: "",
    manifest_path: "",
    catalog_json_path: "",
    data_dir_path: "",
    selected_at: null,
  };
}

function createDefaultAestheticReferenceSelections(): AppAestheticReferenceSelections {
  return {
    version: 1,
    visual_master: null,
    pages: {},
    updated_at: null,
  };
}

function readSelectedTemplateManifestPath(workspace: AppWorkspaceResult): string {
  if (getPlainRecord(workspace.task).workspace_format === WORKSPACE_FORMAT) {
    return workspace.files.manifest;
  }
  const template =
    workspace.template && typeof workspace.template === "object" && !Array.isArray(workspace.template)
      ? (workspace.template as Record<string, unknown>)
      : {};
  const manifestPath = typeof template.manifest_path === "string" ? template.manifest_path.trim() : "";

  if (!manifestPath) {
    throw new Error(
      "No task template is selected. Select a template before rendering deck HTML.",
    );
  }

  assertAbsolutePath(manifestPath, "template.manifest_path");
  const normalizedManifestPath = path.normalize(manifestPath);
  const relativePath = path.relative(workspace.workspace_dir, normalizedManifestPath);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('"template.manifest_path" must be inside the task directory');
  }

  return normalizedManifestPath;
}

async function readManifestLocalSlideSourcePath(input: {
  manifestPath: string;
  pageIndex: number;
  allowHtml?: boolean;
}): Promise<{ absolutePath: string; slideId: string } | null> {
  const manifestDir = path.dirname(input.manifestPath);
  const rawValue = JSON.parse(await readFile(input.manifestPath, "utf8")) as unknown;
  if (!isRecord(rawValue)) {
    throw new Error("Selected template manifest root must be a JSON object");
  }

  const slides = Array.isArray(rawValue.slides) ? rawValue.slides : [];
  const slide = slides[input.pageIndex];
  if (!isRecord(slide)) {
    throw new Error(`Manifest does not contain page index ${input.pageIndex}`);
  }

  const source = slide.source;
  const sourcePath = typeof source === "string"
    ? source
    : isRecord(source) && source.type === "local" && typeof source.path === "string"
      ? source.path
      : null;
  if (!sourcePath) {
    return null;
  }

  const absolutePath = input.allowHtml && sourcePath.toLowerCase().endsWith(".html")
    ? path.resolve(manifestDir, sourcePath)
    : await resolveLocalModulePath(
      sourcePath,
      manifestDir,
      `Slide "${normalizeString(slide.id)}"`,
    );
  const relativePath = path.relative(manifestDir, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Slide "${normalizeString(slide.id)}" source must remain inside the Workspace`);
  }
  await readFile(absolutePath, "utf8");
  return {
    absolutePath,
    slideId: normalizeString(slide.id),
  };
}

function readSelectedTemplateDir(workspace: AppWorkspaceResult): string {
  const template =
    workspace.template && typeof workspace.template === "object" && !Array.isArray(workspace.template)
      ? (workspace.template as Record<string, unknown>)
      : {};
  const templateDir = typeof template.template_dir === "string" ? template.template_dir.trim() : "";

  if (!templateDir) {
    throw new Error(
      "No task template is selected. Select a template before using template planning.",
    );
  }

  assertAbsolutePath(templateDir, "template.template_dir");
  const normalizedTemplateDir = path.normalize(templateDir);
  const relativePath = path.relative(workspace.workspace_dir, normalizedTemplateDir);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('"template.template_dir" must be inside the task directory');
  }

  return normalizedTemplateDir;
}

function readSelectedTemplateCatalogPath(workspace: AppWorkspaceResult): string {
  const template =
    workspace.template && typeof workspace.template === "object" && !Array.isArray(workspace.template)
      ? (workspace.template as Record<string, unknown>)
      : {};
  const catalogPath = typeof template.catalog_json_path === "string" ? template.catalog_json_path.trim() : "";

  if (catalogPath) {
    assertAbsolutePath(catalogPath, "template.catalog_json_path");
    return path.normalize(catalogPath);
  }

  return path.join(readSelectedTemplateDir(workspace), "catalog.json");
}

async function ensureWorkspaceFiles(
  workspaceDir: string,
  options: CreateAppWorkspaceInput & { require_format?: boolean } = {},
): Promise<AppWorkspaceResult> {
  const normalizedWorkspaceDir = normalizeWorkspaceDir(workspaceDir);
  recoverPageRegenerationPublication(normalizedWorkspaceDir);
  const workspaceName = path.basename(normalizedWorkspaceDir);

  await mkdir(normalizedWorkspaceDir, { recursive: true });
  const workspaceSettingDefaults = await readGlobalWorkspaceDefaults();
  const files = buildWorkspaceFilePaths(normalizedWorkspaceDir);
  const createdFiles: string[] = [];

  const existingTask = await readJsonFileIfExists(files.task);
  if (existingTask !== null && options.require_format === true) {
    const existingTaskRecord = getPlainRecord(existingTask);
    if (existingTaskRecord.workspace_format !== WORKSPACE_FORMAT) {
      throw new Error(
        `Unsupported Workspace format. Expected "${WORKSPACE_FORMAT}"; legacy Workspace migration is not available.`,
      );
    }
  }

  const defaults = {
    task: createDefaultTaskJson(normalizedWorkspaceDir, options.title),
    requirements: createDefaultPresentationRequirements(),
    outline: createDefaultOutlineJson(),
    page_progress: createDefaultPageProgressJson(),
  };

  for (const [key, defaultValue] of Object.entries(defaults)) {
    const filePath = files[key as keyof typeof defaults];
    if (!(await fileExists(filePath))) {
      await writeJsonFile(filePath, defaultValue);
      createdFiles.push(path.basename(filePath));
    }
  }
  if (!(await fileExists(files.aesthetic_reference_selections))) {
    await writeJsonFile(
      files.aesthetic_reference_selections,
      createDefaultAestheticReferenceSelections(),
    );
    createdFiles.push(path.basename(files.aesthetic_reference_selections));
  }

  const normalizedTaskSetting = normalizeSettingJson(workspaceSettingDefaults);

  const normalizedRequirements = normalizePresentationRequirements(
    await readJsonFileIfExists(files.requirements),
  );

  const currentOutline = await readJsonFileIfExists(files.outline);
  const normalizedOutline = normalizeOutlineJson(currentOutline);
  if (
    getPlainRecord(existingTask).workspace_format === WORKSPACE_FORMAT &&
    normalizedOutline.status === "confirmed" &&
    normalizedOutline.items.some((item) => !item.page_id)
  ) {
    throw new Error("html-authoring-v1 Confirmed Outline entries must all own page_id");
  }
  if (JSON.stringify(currentOutline) !== JSON.stringify(normalizedOutline)) {
    await writeJsonFile(files.outline, normalizedOutline);
  }

  const currentPageProgress = await readJsonFileIfExists(files.page_progress);
  const normalizedPageProgress = normalizePageProgressJson(currentPageProgress);
  normalizedPageProgress.pages = normalizedPageProgress.pages.map((item) => ({
    ...item,
    last_html_path: normalizeWorkspaceArtifactPath(normalizedWorkspaceDir, item.last_html_path),
    last_screenshot_path: normalizeWorkspaceArtifactPath(normalizedWorkspaceDir, item.last_screenshot_path),
  }));
  if (JSON.stringify(currentPageProgress) !== JSON.stringify(normalizedPageProgress)) {
    await writePageProgressFile(files.page_progress, normalizedPageProgress);
  }

  const missingFiles: string[] = [];
  for (const fileName of WORKSPACE_FILE_NAMES) {
    const filePath = path.join(normalizedWorkspaceDir, fileName);
    if (!(await fileExists(filePath))) {
      missingFiles.push(fileName);
    }
  }

  return {
    workspace_root: WORKSPACE_ROOT,
    task_root: WORKSPACE_ROOT,
    workspace_dir: normalizedWorkspaceDir,
    task_dir: normalizedWorkspaceDir,
    workspace_id: workspaceName,
    task_id: workspaceName,
    initialized: missingFiles.length === 0,
    created_files: createdFiles,
    missing_files: missingFiles,
    files,
    task: await readJsonFileIfExists(files.task),
    setting: normalizedTaskSetting,
    requirements: normalizedRequirements,
    outline: normalizedOutline,
    page_progress: normalizedPageProgress,
    pages: await readJsonFileIfExists(files.pages),
    template: await readJsonFileIfExists(files.template),
  };
}

async function touchWorkspaceTask(workspace: AppWorkspaceResult, updatedAt: string): Promise<void> {
  const existing =
    workspace.task && typeof workspace.task === "object" && !Array.isArray(workspace.task)
      ? (workspace.task as Record<string, unknown>)
      : {};

  await writeJsonFile(workspace.files.task, {
    ...existing,
    updated_at: updatedAt,
  });
}

async function getWorkspaceSummary(workspaceDir: string): Promise<AppWorkspaceSummary> {
  const workspaceName = path.basename(workspaceDir);
  const task = await readJsonFileIfExists(path.join(workspaceDir, "task.json"));
  const info = await stat(workspaceDir);
  const taskRecord =
    task && typeof task === "object" && !Array.isArray(task)
      ? (task as Record<string, unknown>)
      : {};
  const progress = normalizePageProgressJson(
    await readJsonFileIfExists(path.join(workspaceDir, "page-progress.json")),
  );
  const deckHtmlPath = progress.final_deck_render.deck_html_path;
  const hasDeckHtml =
    progress.final_deck_render.status === "completed" &&
    typeof deckHtmlPath === "string" &&
    deckHtmlPath.length > 0 &&
    await fileExists(deckHtmlPath);

  return {
    workspace_id: workspaceName,
    task_id: workspaceName,
    workspace_dir: workspaceDir,
    task_dir: workspaceDir,
    title:
      typeof taskRecord.title === "string" && taskRecord.title.length > 0
        ? taskRecord.title
        : workspaceName,
    status:
      typeof taskRecord.status === "string" && taskRecord.status.length > 0
        ? taskRecord.status
        : "unknown",
    updated_at:
      typeof taskRecord.updated_at === "string"
        ? taskRecord.updated_at
        : info.mtime.toISOString(),
    created_at:
      typeof taskRecord.created_at === "string"
        ? taskRecord.created_at
        : info.birthtime.toISOString(),
    has_deck_html: hasDeckHtml,
    generation_completed: progress.status === "completed",
  };
}

export function getDefaultAppWorkspaceRoot(): string {
  return WORKSPACE_ROOT;
}

export async function beginAppGenerationRun(input: {
  workspace_dir: string;
  run_kind: AppGenerationRunKind;
  origin_page_id?: string | null;
}): Promise<AppGenerationRunTransaction> {
  const workspace = await openAppWorkspace({ workspace_dir: input.workspace_dir });
  return beginGenerationRun({
    workspace_root: WORKSPACE_ROOT,
    official_workspace_dir: workspace.workspace_dir,
    workspace_id: workspace.workspace_id,
    run_kind: input.run_kind,
    origin_page_id: input.origin_page_id,
  });
}

export async function prepareAppGenerationRun(input: { run_id: string }): Promise<{
  transaction: AppGenerationRunTransaction;
  workspace: AppWorkspaceResult | null;
}> {
  const transaction = await prepareGenerationRun(WORKSPACE_ROOT, input.run_id);
  return {
    transaction,
    workspace: transaction.state === "active"
      ? await openAppWorkspace({ workspace_dir: transaction.shadow_workspace_dir })
      : null,
  };
}

export async function abandonAppGenerationRun(input: { run_id: string }): Promise<AppGenerationRunTransaction> {
  return abandonGenerationRun(WORKSPACE_ROOT, input.run_id);
}

export async function commitAppGenerationRun(input: { run_id: string }): Promise<{
  transaction: AppGenerationRunTransaction;
  workspace: AppWorkspaceResult;
}> {
  const current = await readGenerationRunForCommit(input.run_id);
  const transaction = await withGenerationWorkspaceLock(
    current.official_workspace_dir,
    () => commitGenerationRun(WORKSPACE_ROOT, input.run_id),
  );
  const workspace = await openAppWorkspace({ workspace_dir: transaction.official_workspace_dir });
  process.stderr.write(
    `[snapshot-trigger] #1 generation-commit workspace_id=${workspace.workspace_id} run_kind=${transaction.run_kind}\n`,
  );
  publishWorkspaceSnapshotFromTrigger(workspace.workspace_dir);
  return { transaction, workspace };
}

async function readGenerationRunForCommit(runId: string) {
  const transactionFile = path.join(WORKSPACE_ROOT, ".generation-runs", runId, "transaction.json");
  return JSON.parse(await readFile(transactionFile, "utf8")) as AppGenerationRunTransaction;
}

export async function cleanupAppGenerationRun(input: { run_id: string }): Promise<{ cleaned: boolean }> {
  const cleaned = await cleanupGenerationRun(WORKSPACE_ROOT, input.run_id);
  return { cleaned };
}

export async function getAppWorkspaceGenerationRun(input: { workspace_dir: string }): Promise<AppGenerationRunTransaction | null> {
  const workspaceDir = normalizeWorkspaceDir(input.workspace_dir);
  return recoverGenerationRunForWorkspace(WORKSPACE_ROOT, path.basename(workspaceDir));
}

export async function listAppWorkspaces(): Promise<ListAppWorkspacesResult> {
  await mkdir(WORKSPACE_ROOT, { recursive: true });
  const roots = [WORKSPACE_ROOT, LEGACY_TASK_ROOT];
  const workspaceDirs = new Set<string>();
  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      entries
        .filter((entry) => entry.isDirectory() && isWorkspaceDirName(entry.name))
        .forEach((entry) => workspaceDirs.add(path.join(root, entry.name)));
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  const workspaces = await Promise.all([...workspaceDirs].map(getWorkspaceSummary));
  workspaces.sort((left, right) => right.updated_at.localeCompare(left.updated_at));

  return {
    workspace_root: WORKSPACE_ROOT,
    task_root: WORKSPACE_ROOT,
    has_workspaces: workspaces.length > 0,
    has_tasks: workspaces.length > 0,
    latest_workspace: workspaces[0] ?? null,
    latest_task: workspaces[0] ?? null,
    workspaces,
    tasks: workspaces,
  };
}

const APP_WORKSPACE_LIST_PAGE_DEFAULT_LIMIT = 40;
const APP_WORKSPACE_LIST_PAGE_MAX_LIMIT = 40;

function readAppWorkspaceListPageOffset(cursor: unknown): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (typeof cursor !== "string" || !/^(?:0|[1-9]\d*)$/.test(cursor)) {
    throw new Error('"cursor" must be an opaque cursor returned by app_list_workspaces.');
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) {
    throw new Error('"cursor" is outside the supported workspace list range.');
  }
  return offset;
}

function readAppWorkspaceListPageLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return APP_WORKSPACE_LIST_PAGE_DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > APP_WORKSPACE_LIST_PAGE_MAX_LIMIT) {
    throw new Error(`"limit" must be an integer between 1 and ${APP_WORKSPACE_LIST_PAGE_MAX_LIMIT}.`);
  }
  return limit;
}

/**
 * Bounded wire representation for app_list_workspaces.
 *
 * The local SlideForge bridge reads one JSON-RPC line at a time and has a ~64 KiB
 * limit. Do not return duplicated legacy task aliases here: callers can page
 * through this canonical workspace list without ever crossing that boundary.
 */
export async function listAppWorkspacesPage(input: {
  limit?: unknown;
  cursor?: unknown;
} = {}): Promise<ListAppWorkspacesResult> {
  const all = await listAppWorkspaces();
  const offset = readAppWorkspaceListPageOffset(input.cursor);
  const limit = readAppWorkspaceListPageLimit(input.limit);
  const workspaces = all.workspaces.slice(offset, offset + limit).map((workspace) => ({
    workspace_id: workspace.workspace_id,
    workspace_dir: workspace.workspace_dir,
    title: workspace.title,
    status: workspace.status,
    updated_at: workspace.updated_at,
    created_at: workspace.created_at,
    has_deck_html: workspace.has_deck_html,
  }));
  const nextOffset = offset + workspaces.length;

  return {
    workspace_root: all.workspace_root,
    task_root: all.task_root,
    has_workspaces: all.has_workspaces,
    latest_workspace: all.latest_workspace
      ? {
          workspace_id: all.latest_workspace.workspace_id,
          workspace_dir: all.latest_workspace.workspace_dir,
          title: all.latest_workspace.title,
          status: all.latest_workspace.status,
          updated_at: all.latest_workspace.updated_at,
          created_at: all.latest_workspace.created_at,
          has_deck_html: all.latest_workspace.has_deck_html,
        }
      : null,
    workspaces,
    ...(nextOffset < all.workspaces.length ? { next_cursor: String(nextOffset) } : {}),
  };
}

export async function createAppWorkspace(
  input: CreateAppWorkspaceInput = {},
): Promise<CreateAppWorkspaceResult> {
  const createdAt = new Date();
  let workspaceId = formatWorkspaceId(createdAt);
  let workspaceDir = path.join(WORKSPACE_ROOT, workspaceId);
  let attempt = 0;
  while (await fileExists(workspaceDir)) {
    attempt += 1;
    workspaceId = formatWorkspaceId(new Date(Date.now() + attempt * 1000));
    workspaceDir = path.join(WORKSPACE_ROOT, workspaceId);
  }

  const title =
    typeof input.title === "string" && input.title.trim().length > 0
      ? input.title.trim()
      : formatDefaultWorkspaceTitle(createdAt);

  const workspace = await ensureWorkspaceFiles(workspaceDir, { title });
  const setting = normalizeSettingJson(workspace.setting);
  const defaults = createDefaultSettingJson();
  const createSetting: AppCreateWorkspaceSetting = {
    page_generation_concurrency: normalizePageGenerationConcurrency(
      setting.page_generation_concurrency,
    ),
    research_image_session_concurrency: normalizeResearchImageSessionConcurrency(
      setting.research_image_session_concurrency,
    ),
    research_web_max_rounds: normalizeResearchLimit(setting.research_web_max_rounds),
    research_image_max_searches: normalizeResearchLimit(setting.research_image_max_searches),
  };

  return {
    version: 1,
    workspace_root: workspace.workspace_root,
    workspace_id: workspace.workspace_id,
    workspace_dir: workspace.workspace_dir,
    title,
    setting: createSetting,
  };
}

function assertBatchTestRoot(rootDir: string): string {
  assertAbsolutePath(rootDir, "root_dir");
  const normalized = path.normalize(rootDir);
  if (!isPathWithin(normalized, BATCH_TEST_ROOT) || normalized === BATCH_TEST_ROOT) {
    throw new Error('"root_dir" must be inside the default PPT test directory');
  }
  if (!BATCH_TEST_ID_PATTERN.test(path.basename(normalized))) {
    throw new Error('"root_dir" must end with a safe batch test id');
  }
  return normalized;
}

function sanitizeBatchTestId(value: string | undefined): string {
  const candidate = (value ?? `batch-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`)
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!BATCH_TEST_ID_PATTERN.test(candidate)) throw new Error('"test_id" is invalid');
  return candidate;
}

function createBatchTestCaseRecord(input: CreateAppBatchTestRunInput["cases"][number], caseDir: string, workspaceDir: string): AppBatchTestRunRecord["cases"][number] {
  return {
    case_id: input.case_id,
    brief_id: input.brief_id,
    brief: input.brief,
    repetition: input.repetition,
    total_repetitions: input.total_repetitions,
    status: "pending",
    case_dir: caseDir,
    workspace_dir: workspaceDir,
    workspace_id: path.basename(workspaceDir),
    performance_dir: path.join(caseDir, "performance"),
    started_at: null,
    ended_at: null,
    error: null,
    pptx_path: null,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.provided_requirements ? { provided_requirements: input.provided_requirements } : {}),
    ...(input.research_routing ? { research_routing: input.research_routing } : {}),
    ...(input.page_refinement_classification ? { page_refinement_classification: input.page_refinement_classification } : {}),
  };
}

function normalizeProvidedOutlineRequirements(value: unknown, caseId: string): AppPresentationRequirements {
  const requirements = normalizePresentationRequirements(value);
  if (requirements.status !== "confirmed" || !requirements.source?.brief.trim()) {
    throw new Error(`Provided outline requirements must be confirmed with source.brief: ${caseId}`);
  }
  if (requirements.research.web.enabled !== false || requirements.research.images.enabled !== false) {
    throw new Error(`Provided outline requirements must disable Web and image research: ${caseId}`);
  }
  return requirements;
}

function assertBatchResearchRoutingCase(value: unknown, caseId: string): void {
  if (!isRecord(value) || typeof value.baseline_id !== "string" || !BATCH_TEST_CASE_ID_PATTERN.test(value.baseline_id) || typeof value.prompt_version !== "string" || !/^v(?:[1-9]|1[01])[a-z]?$/u.test(value.prompt_version) || typeof value.prompt !== "string" || value.prompt.length === 0 || value.prompt.length > BATCH_TEST_RESEARCH_ROUTING_PROMPT_MAX_CHARS || typeof value.prompt_hash !== "string" || !/^[a-f0-9]{64}$/u.test(value.prompt_hash) || typeof value.git_commit !== "string" || !/^[a-f0-9]{7,64}$/u.test(value.git_commit) || (value.requested_model !== undefined && value.requested_model !== null && (typeof value.requested_model !== "string" || value.requested_model.trim().length === 0 || value.requested_model.length > 200)) || !isRecord(value.expected) || typeof value.expected.web !== "boolean" || typeof value.expected.images !== "boolean") {
    throw new Error(`Invalid research routing case: ${caseId}`);
  }
}

function assertBatchPageRefinementClassificationCase(value: unknown, caseId: string): void {
  if (!isRecord(value) || typeof value.prompt_version !== "string" || !/^v(?:[1-9]|10)[a-z]?$/u.test(value.prompt_version) || typeof value.prompt !== "string" || value.prompt.length === 0 || value.prompt.length > BATCH_TEST_PAGE_REFINEMENT_CLASSIFICATION_PROMPT_MAX_CHARS || typeof value.prompt_hash !== "string" || !/^[a-f0-9]{64}$/u.test(value.prompt_hash) || typeof value.git_commit !== "string" || !/^[a-f0-9]{7,64}$/u.test(value.git_commit) || (value.requested_model !== undefined && value.requested_model !== null && (typeof value.requested_model !== "string" || value.requested_model.trim().length === 0 || value.requested_model.length > 200))) {
    throw new Error(`Invalid page refinement classification case: ${caseId}`);
  }
  if (value.expected !== undefined && (!isRecord(value.expected) || typeof value.expected.task_type !== "string" || !BATCH_TEST_PAGE_REFINEMENT_TASK_TYPES.has(value.expected.task_type) || typeof value.expected.execution_scope !== "string" || !BATCH_TEST_PAGE_REFINEMENT_EXECUTION_SCOPES.has(value.expected.execution_scope) || typeof value.expected.web_research !== "boolean" || typeof value.expected.image_research !== "boolean")) {
    throw new Error(`Invalid page refinement classification expectation: ${caseId}`);
  }
}

function normalizeBatchAttachments(value: unknown, caseId: string, requireAttachments: boolean): NonNullable<CreateAppBatchTestCaseInput["attachments"]> {
  if (!Array.isArray(value) || (requireAttachments && value.length === 0)) {
    throw new Error(`Attachment parsing batch cases require at least one attachment: ${caseId}`);
  }
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.filename !== "string" || !item.filename.trim() || typeof item.size_bytes !== "number" || !Number.isInteger(item.size_bytes) || item.size_bytes < 0 || !isRecord(item.host_upload)) {
      throw new Error(`Invalid attachment ${index + 1} for batch test case: ${caseId}`);
    }
    const upload = item.host_upload;
    if (upload.transport !== "host_upload" || typeof upload.r2_key !== "string" || !upload.r2_key.trim()
      || typeof upload.url !== "string" || !upload.url.trim()
      || typeof upload.mime_type !== "string" || !upload.mime_type.trim()
      || typeof upload.size_bytes !== "number" || !Number.isInteger(upload.size_bytes) || upload.size_bytes < 0) {
      throw new Error(`Invalid attachment upload reference for batch test case: ${caseId}`);
    }
    if (item.expected_strategy !== undefined && item.expected_strategy !== "full_context" && item.expected_strategy !== "summarized_context") {
      throw new Error(`Invalid expected attachment strategy for batch test case: ${caseId}`);
    }
    return {
      filename: item.filename.trim(),
      mime_type: typeof item.mime_type === "string" && item.mime_type.trim() ? item.mime_type.trim() : upload.mime_type,
      size_bytes: item.size_bytes,
      host_upload: upload as NonNullable<CreateAppBatchTestCaseInput["attachments"]>[number]["host_upload"],
      ...(item.expected_strategy ? { expected_strategy: item.expected_strategy } : {}),
      ...(typeof item.expected_notes === "string" && item.expected_notes.trim() ? { expected_notes: item.expected_notes.trim() } : {}),
    };
  });
}

async function readBatchTestRun(rootDir: string): Promise<AppBatchTestRunRecord> {
  const normalizedRoot = assertBatchTestRoot(rootDir);
  const value = await readJsonFileIfExists(path.join(normalizedRoot, "batch-test.json"));
  const record = getPlainRecord(value);
  const manifestPath = path.join(normalizedRoot, "batch-test.json");
  if (
    record.version !== 1 ||
    record.test_id !== path.basename(normalizedRoot) ||
    !BATCH_TEST_TARGET_STAGES.has(record.target_stage as AppBatchTestTargetStage) ||
    record.root_dir !== normalizedRoot ||
    record.manifest_path !== manifestPath ||
    !Array.isArray(record.cases)
  ) {
    throw new Error("Invalid batch test manifest");
  }
  const caseIds = new Set<string>();
  for (const item of record.cases) {
    if (!isRecord(item) || typeof item.case_id !== "string" || !BATCH_TEST_CASE_ID_PATTERN.test(item.case_id) || caseIds.has(item.case_id)) {
      throw new Error("Invalid batch test case manifest");
    }
    caseIds.add(item.case_id);
    const caseDir = path.join(normalizedRoot, item.case_id);
    const workspaceParent = path.join(caseDir, "workspace");
    const workspaceDir = typeof item.workspace_dir === "string" ? path.normalize(item.workspace_dir) : "";
    if (
      item.case_dir !== caseDir ||
      item.performance_dir !== path.join(caseDir, "performance") ||
      !isPathWithin(workspaceDir, workspaceParent) ||
      workspaceDir === workspaceParent ||
      !isWorkspaceDirName(path.basename(workspaceDir))
    ) {
      throw new Error("Invalid batch test case paths");
    }
  }
  const run = record as unknown as AppBatchTestRunRecord;
  return {
    ...run,
    started_at: typeof record.started_at === "string"
      ? record.started_at
      : record.status === "queued"
        ? null
        : typeof record.created_at === "string" ? record.created_at : null,
    ended_at: typeof record.ended_at === "string"
      ? record.ended_at
      : BATCH_TEST_TERMINAL_RUN_STATUSES.has(record.status as AppBatchTestRunStatus) && typeof record.updated_at === "string"
        ? record.updated_at
        : null,
  };
}

/**
 * Attachment parsing cases persist HostUploadRef records so an interrupted run
 * can resume. Their pre-signed URLs are large, though, and returning all of
 * them with every batch RPC can exceed the local Executa bridge response
 * budget. The caller retains its imported fixture while a run is active; the
 * persisted case records remain the source of truth for a later resume.
 */
function toBatchTestTransportRun(run: AppBatchTestRunRecord): AppBatchTestRunRecord {
  if (run.target_stage !== "attachment-context-created") return run;
  return {
    ...run,
    cases: run.cases.map(({ attachments: _attachments, ...batchCase }) => batchCase),
  };
}

export async function createAppBatchTestRun(
  input: CreateAppBatchTestRunInput,
): Promise<CreateAppBatchTestRunResult> {
  const maximumCases = input && typeof input === "object" && !Array.isArray(input)
    ? input.target_stage === "research-routing-completed"
      ? BATCH_TEST_RESEARCH_ROUTING_MAX_CASES
      : input.target_stage === "page-refinement-classification-completed"
        ? BATCH_TEST_PAGE_REFINEMENT_CLASSIFICATION_MAX_CASES
        : 200
    : 200;
  if (!isRecord(input) || !Array.isArray(input.cases) || input.cases.length === 0 || input.cases.length > maximumCases) {
    throw new Error(`"cases" must contain between 1 and ${maximumCases} items`);
  }
  if (!BATCH_TEST_TARGET_STAGES.has(input.target_stage)) {
    throw new Error('"target_stage" is not a valid batch test target stage');
  }
  const testId = sanitizeBatchTestId(input.test_id);
  const rootDir = path.join(BATCH_TEST_ROOT, testId);
  if (await fileExists(rootDir)) throw new Error(`Batch test already exists: ${testId}`);
  const seenCaseIds = new Set<string>();
  const workspaceIds = new Set<string>();
  await mkdir(rootDir, { recursive: true });
  const cases: AppBatchTestRunRecord["cases"] = [];
  try {
    for (const item of input.cases) {
      if (!isRecord(item)) throw new Error("Invalid batch test case");
      const caseId = item.case_id;
      const briefId = item.brief_id;
      const brief = item.brief;
      const repetition = item.repetition;
      const totalRepetitions = item.total_repetitions;
      if (typeof caseId !== "string" || !BATCH_TEST_CASE_ID_PATTERN.test(caseId) || typeof briefId !== "string" || !BATCH_TEST_CASE_ID_PATTERN.test(briefId)) {
        throw new Error(`Invalid batch test case id: ${String(caseId)}`);
      }
      if (seenCaseIds.has(caseId)) throw new Error(`Duplicate batch test case id: ${caseId}`);
      seenCaseIds.add(caseId);
      if (typeof brief !== "string" || brief.trim().length === 0 || brief.length > BATCH_TEST_BRIEF_MAX_CHARS) {
        throw new Error(`Batch test case brief must contain 1-${BATCH_TEST_BRIEF_MAX_CHARS} characters: ${caseId}`);
      }
      if (typeof repetition !== "number" || typeof totalRepetitions !== "number" || !Number.isInteger(repetition) || repetition < 1 || !Number.isInteger(totalRepetitions) || totalRepetitions < repetition || totalRepetitions > 200) {
        throw new Error(`Invalid repetition for batch test case: ${caseId}`);
      }
      if (input.target_stage === "research-routing-completed") {
        assertBatchResearchRoutingCase(item.research_routing, caseId);
      } else if (input.target_stage === "page-refinement-classification-completed") {
        assertBatchPageRefinementClassificationCase(item.page_refinement_classification, caseId);
        if (item.research_routing !== undefined) {
          throw new Error(`Research routing metadata is not allowed for page-refinement-classification-completed: ${caseId}`);
        }
      } else if (input.target_stage === "image-research-completed" && item.research_routing !== undefined) {
        // Image-research batches may be ordinary end-to-end fixtures. Validate
        // routing metadata only when the caller explicitly supplies it for a
        // routing-aware Stage 3 evaluation.
        assertBatchResearchRoutingCase(item.research_routing, caseId);
      } else if (item.research_routing !== undefined) {
        throw new Error(`Research routing metadata is only allowed for research-routing-completed or image-research-completed: ${caseId}`);
      }
      if (item.page_refinement_classification !== undefined && input.target_stage !== "page-refinement-classification-completed") {
        throw new Error(`Page refinement classification metadata is only allowed for page-refinement-classification-completed: ${caseId}`);
      }
      if (item.provided_requirements !== undefined && input.target_stage !== "outline-confirmed") {
        throw new Error(`provided_requirements is only allowed for outline-confirmed batch tests: ${caseId}`);
      }
      const providedRequirements = item.provided_requirements === undefined
        ? undefined
        : normalizeProvidedOutlineRequirements(item.provided_requirements, caseId);
      const attachments = item.attachments !== undefined || input.target_stage === "attachment-context-created"
        ? normalizeBatchAttachments(item.attachments, caseId, input.target_stage === "attachment-context-created")
        : undefined;
      const caseDir = path.join(rootDir, caseId);
      const workspaceParent = path.join(caseDir, "workspace");
      await mkdir(workspaceParent, { recursive: true });
      let workspaceDir: string;
      let workspaceId: string;
      let attempt = 0;
      do {
        workspaceId = formatWorkspaceId(new Date(Date.now() + (workspaceIds.size + attempt) * 1000));
        workspaceDir = path.join(workspaceParent, workspaceId);
        attempt += 1;
      } while (workspaceIds.has(workspaceId) || await fileExists(workspaceDir) || await fileExists(path.join(WORKSPACE_ROOT, workspaceId)));
      workspaceIds.add(workspaceId);
      await ensureWorkspaceFiles(workspaceDir, { title: `${briefId} #${repetition}` });
      const record = createBatchTestCaseRecord({
        case_id: caseId,
        brief_id: briefId,
        brief: brief.trim(),
        repetition,
        total_repetitions: totalRepetitions,
        ...(attachments ? { attachments } : {}),
        ...(providedRequirements ? { provided_requirements: providedRequirements } : {}),
        ...(item.research_routing ? { research_routing: item.research_routing } : {}),
        ...(item.page_refinement_classification ? { page_refinement_classification: item.page_refinement_classification } : {}),
      }, caseDir, workspaceDir);
      await writeJsonFile(path.join(caseDir, "case.json"), record);
      cases.push(record);
    }
    const now = new Date().toISOString();
    const run: AppBatchTestRunRecord = {
      version: 1,
      test_id: testId,
      target_stage: input.target_stage,
      status: "queued",
      root_dir: rootDir,
      manifest_path: path.join(rootDir, "batch-test.json"),
      created_at: now,
      started_at: null,
      ended_at: null,
      updated_at: now,
      cases,
    };
    await atomicWriteJsonFile(run.manifest_path, run);
    return { run: toBatchTestTransportRun(run) };
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function updateAppBatchTestCase(
  input: UpdateAppBatchTestCaseInput,
): Promise<AppBatchTestRunRecord> {
  if (!isRecord(input) || typeof input.case_id !== "string" || !BATCH_TEST_CASE_STATUSES.has(input.status)) {
    throw new Error('Invalid batch test case status or id');
  }
  if (input.error !== undefined && input.error !== null && (typeof input.error !== "string" || input.error.length > BATCH_TEST_ERROR_MAX_CHARS)) {
    throw new Error(`Batch test case error must be at most ${BATCH_TEST_ERROR_MAX_CHARS} characters`);
  }
  const run = await readBatchTestRun(input.root_dir);
  const index = run.cases.findIndex((item) => item.case_id === input.case_id);
  if (index < 0) throw new Error(`Unknown batch test case: ${input.case_id}`);
  const current = run.cases[index];
  // A lost RPC response must not let an error handler overwrite a committed success.
  // Completed cases are skipped on resume; reruns use a new batch.
  if (current.status === "completed" && input.status !== "completed") return toBatchTestTransportRun(run);
  const now = new Date().toISOString();
  const next = {
    ...current,
    status: input.status,
    started_at: input.status === "running" ? (current.started_at ?? now) : current.started_at,
    ended_at: ["completed", "failed", "cancelled"].includes(input.status) ? now : current.ended_at,
    error: input.error === undefined ? current.error : input.error,
    pptx_path: input.pptx_path === undefined ? current.pptx_path : input.pptx_path,
    token_usage: input.token_usage === undefined ? current.token_usage : input.token_usage,
    performance_metrics: input.performance_metrics === undefined ? current.performance_metrics : input.performance_metrics,
    research_routing_result: input.research_routing_result === undefined
      ? current.research_routing_result
      : input.research_routing_result,
    page_refinement_classification_result: input.page_refinement_classification_result === undefined
      ? current.page_refinement_classification_result
      : input.page_refinement_classification_result,
    template_recommendation_result: input.template_recommendation_result === undefined
      ? current.template_recommendation_result
      : input.template_recommendation_result,
  };
  if (next.research_routing_result !== null && next.research_routing_result !== undefined) {
    const result = next.research_routing_result;
    if (!current.research_routing || !isRecord(result) || !isRecord(result.actual) || typeof result.actual.web !== "boolean" || typeof result.actual.images !== "boolean" || (result.requested_model !== null && typeof result.requested_model !== "string") || (result.actual_model !== null && typeof result.actual_model !== "string") || typeof result.latency_ms !== "number" || !Number.isFinite(result.latency_ms) || !Number.isInteger(result.json_repair_count) || result.json_repair_count < 0 || !Number.isInteger(result.retry_count) || result.retry_count < 0 || result.retry_count > 3 || !Array.isArray(result.retry_reasons) || result.retry_reasons.length !== result.retry_count || result.retry_reasons.some((reason) => reason !== "invocation" && reason !== "json_format" && reason !== "schema")) {
      throw new Error('Invalid research routing result');
    }
  }
  if (next.page_refinement_classification_result !== null && next.page_refinement_classification_result !== undefined) {
    const result = next.page_refinement_classification_result;
    if (!current.page_refinement_classification || !isRecord(result) || !isRecord(result.actual) || typeof result.actual.task_type !== "string" || !BATCH_TEST_PAGE_REFINEMENT_TASK_TYPES.has(result.actual.task_type) || typeof result.actual.execution_scope !== "string" || !BATCH_TEST_PAGE_REFINEMENT_EXECUTION_SCOPES.has(result.actual.execution_scope) || typeof result.actual.web_research !== "boolean" || typeof result.actual.image_research !== "boolean" || typeof result.actual.reason !== "string" || result.actual.reason.trim().length === 0 || (result.requested_model !== null && typeof result.requested_model !== "string") || (result.actual_model !== null && typeof result.actual_model !== "string") || typeof result.latency_ms !== "number" || !Number.isFinite(result.latency_ms) || !Number.isInteger(result.json_repair_count) || result.json_repair_count < 0 || !Number.isInteger(result.retry_count) || result.retry_count < 0 || result.retry_count > 3 || !Array.isArray(result.retry_reasons) || result.retry_reasons.length !== result.retry_count || result.retry_reasons.some((reason) => reason !== "invocation" && reason !== "json_format" && reason !== "schema")) {
      throw new Error("Invalid page refinement classification result");
    }
  }
  if (next.pptx_path !== null && next.pptx_path !== undefined) {
    assertAbsolutePath(next.pptx_path, "pptx_path");
    const normalizedPptxPath = path.normalize(next.pptx_path);
    if (!isPathWithin(normalizedPptxPath, path.normalize(current.workspace_dir))) {
      throw new Error('"pptx_path" must be inside the batch test case Workspace');
    }
    next.pptx_path = normalizedPptxPath;
  }
  run.cases[index] = next;
  if (input.status === "running") run.started_at ??= now;
  run.updated_at = now;
  await atomicWriteJsonFile(run.manifest_path, run);
  await atomicWriteJsonFile(path.join(current.case_dir, "case.json"), next);
  return toBatchTestTransportRun(run);
}

export async function updateAppBatchTestRun(
  input: UpdateAppBatchTestRunInput,
): Promise<AppBatchTestRunRecord> {
  if (!isRecord(input) || !BATCH_TEST_RUN_STATUSES.has(input.status)) {
    throw new Error("Invalid batch test run status");
  }
  const run = await readBatchTestRun(input.root_dir);
  const now = new Date().toISOString();
  run.status = input.status;
  if (input.performance_metrics !== undefined) run.performance_metrics = input.performance_metrics;
  if (input.status === "running") run.started_at ??= now;
  if (BATCH_TEST_TERMINAL_RUN_STATUSES.has(input.status)) run.ended_at ??= now;
  run.updated_at = now;
  await atomicWriteJsonFile(run.manifest_path, run);
  return toBatchTestTransportRun(run);
}

export async function listAppBatchTestRuns(): Promise<ListAppBatchTestRunsResult> {
  await mkdir(BATCH_TEST_ROOT, { recursive: true });
  const entries = await readdir(BATCH_TEST_ROOT, { withFileTypes: true });
  const runs: AppBatchTestRunRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !BATCH_TEST_ID_PATTERN.test(entry.name)) continue;
    try {
      runs.push(toBatchTestTransportRun(await readBatchTestRun(path.join(BATCH_TEST_ROOT, entry.name))));
    } catch {
      // Ignore incomplete or damaged entries so one failed run cannot hide history.
    }
  }
  runs.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  return { root_dir: BATCH_TEST_ROOT, runs };
}

export async function deleteAppBatchTestRun(
  rootDir: string,
): Promise<DeleteAppBatchTestRunResult> {
  const normalizedRoot = assertBatchTestRoot(rootDir);
  const run = await readBatchTestRun(normalizedRoot);
  if (run.status === "queued" || run.status === "running") {
    throw new Error("Running batch tests cannot be deleted");
  }
  await rm(normalizedRoot, { recursive: true, force: true });
  return {
    deleted: true,
    test_id: run.test_id,
    root_dir: normalizedRoot,
  };
}

export async function openAppWorkspace(
  input: OpenAppWorkspaceInput,
): Promise<AppWorkspaceResult> {
  // Opening only reads workspace metadata; preview preparation belongs to
  // preview/export requests and must not delay opening on browser resources.
  const workspace = await ensureWorkspaceFiles(input.workspace_dir, { require_format: true });
  await cleanupGeneratedPageImages(workspace.workspace_dir, normalizePageProgressJson(workspace.page_progress).pages)
    .catch((error) => console.warn("Deferred generated image cleanup:", error instanceof Error ? error.message : String(error)));
  return workspace;
}

export async function updateAppWorkspaceSettings(
  input: UpdateAppWorkspaceSettingsInput,
): Promise<AppWorkspaceResult> {
  await patchAppWorkspaceSettings(input);
  return ensureWorkspaceFiles(input.workspace_dir);
}

export async function patchAppWorkspaceSettings(
  input: UpdateAppWorkspaceSettingsInput,
): Promise<PatchAppWorkspaceSettingsResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const nextSetting = await updateGlobalWorkspaceDefaults(input.setting);
  return {
    workspace_dir: workspace.workspace_dir,
    setting: nextSetting,
    persisted_as_default: true,
  };
}

export async function patchAppWorkspaceDefaults(input: {
  setting: Record<string, unknown>;
}): Promise<GetAppWorkspaceDefaultsResult> {
  return {
    workspace_root: WORKSPACE_ROOT,
    setting: await updateGlobalWorkspaceDefaults(input.setting),
  };
}

export async function updateAppWorkspaceTitle(
  input: UpdateAppWorkspaceTitleInput,
): Promise<AppWorkspaceResult> {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new Error('"title" must be a non-empty string');
  }

  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const existing =
    workspace.task &&
    typeof workspace.task === "object" &&
    !Array.isArray(workspace.task)
      ? (workspace.task as Record<string, unknown>)
      : {};
  const nextTask = {
    ...existing,
    title,
    updated_at: new Date().toISOString(),
  };

  await writeJsonFile(workspace.files.task, nextTask);
  await markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
  return ensureWorkspaceFiles(input.workspace_dir);
}

/**
 * WORK-005: creates an independent Workspace from an existing one. The copy
 * keeps the source's saved artifacts, export outputs and logs, but does not
 * copy the global Generation Run transaction. An interrupted source therefore
 * becomes a fresh copy of its last saved Workspace state, never a shared or
 * resumable run. The copied tree is rebased onto the new directory and given
 * a fresh Workspace identity.
 */
export async function duplicateAppWorkspace(
  input: DuplicateAppWorkspaceInput,
): Promise<DuplicateAppWorkspaceResult> {
  const sourceDir = normalizeWorkspaceDir(input.workspace_dir);
  const source = await openAppWorkspace({ workspace_dir: sourceDir });
  const sourceId = path.basename(sourceDir);

  return withGenerationWorkspaceLock(sourceDir, async () => {
    const activeRun = await findGenerationRunForWorkspace(WORKSPACE_ROOT, sourceId);
    if (activeRun && ["preparing", "active", "committing"].includes(activeRun.state)) {
      throw new Error("An active generation run must be stopped before duplicating this workspace.");
    }

    const createdAt = new Date();
    let workspaceId = formatWorkspaceId(createdAt);
    let workspaceDir = path.join(WORKSPACE_ROOT, workspaceId);
    let attempt = 0;
    while (await fileExists(workspaceDir)) {
      attempt += 1;
      workspaceId = formatWorkspaceId(new Date(createdAt.getTime() + attempt * 1000));
      workspaceDir = path.join(WORKSPACE_ROOT, workspaceId);
    }

    const sourceTask = getPlainRecord(await readJsonFileIfExists(source.files.task));
    const sourceTitle =
      typeof sourceTask.title === "string" && sourceTask.title.trim().length > 0
        ? sourceTask.title.trim()
        : sourceId;
    const title =
      typeof input.title === "string" && input.title.trim().length > 0
        ? input.title.trim()
        : `${sourceTitle} (Copy)`;

    try {
      await copyTree(sourceDir, workspaceDir);
      await rebaseTextTree(workspaceDir, sourceDir, workspaceDir);

      const now = new Date().toISOString();
      const copiedTask = getPlainRecord(
        await readJsonFileIfExists(path.join(workspaceDir, "task.json")),
      );
      await writeJsonFile(path.join(workspaceDir, "task.json"), {
        ...copiedTask,
        id: workspaceId,
        task_id: workspaceId,
        title,
        task_dir: workspaceDir,
        workspace_dir: workspaceDir,
        duplicated_from: sourceId,
        ...(input.local_conflict_backup_of
          ? { local_conflict_backup: true, backup_of: input.local_conflict_backup_of }
          : {}),
        created_at: now,
        updated_at: now,
      });
    } catch (error) {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    const workspace = await ensureWorkspaceFiles(workspaceDir, { require_format: true });
    // A duplicated Workspace is real work like any other: snapshot it so the
    // copy has an immediate local backup even before the plugin uploads to APS.
    publishWorkspaceSnapshotFromTrigger(workspace.workspace_dir);
    return {
      version: 1,
      workspace_root: workspace.workspace_root,
      source_workspace_id: sourceId,
      source_workspace_dir: sourceDir,
      workspace_id: workspace.workspace_id,
      workspace_dir: workspace.workspace_dir,
      title,
    } satisfies DuplicateAppWorkspaceResult;
  });
}

/**
 * Save the current local tree (including never-synced changes) as a standalone
 * copy Workspace before a cloud-priority restore overwrites the original. The
 * copy is real work like any duplicate: it gets its own identity and a local
 * snapshot, and the caller may upload it to APS so the backup survives even on
 * another device. `duplicateAppWorkspace` throws if an active generation run is
 * holding the source, in which case the caller must abort without overwriting.
 */
export async function backupWorkspaceAsLocalCopy(
  input: BackupWorkspaceAsLocalCopyInput,
): Promise<BackupWorkspaceAsLocalCopyResult> {
  const sourceDir = normalizeWorkspaceDir(input.workspace_dir);
  const source = await openAppWorkspace({ workspace_dir: sourceDir });
  const sourceId = path.basename(sourceDir);

  const sourceTask = getPlainRecord(await readJsonFileIfExists(source.files.task));
  const sourceTitle =
    typeof sourceTask.title === "string" && sourceTask.title.trim().length > 0
      ? sourceTask.title.trim()
      : sourceId;

  const existingTitles = new Set<string>();
  for (const summary of (await listAppWorkspaces()).workspaces) {
    existingTitles.add(summary.title);
  }

  const now = new Date();
  const stamp =
    `${now.getFullYear()}${padDatePart(now.getMonth() + 1)}${padDatePart(now.getDate())}` +
    `-${padDatePart(now.getHours())}${padDatePart(now.getMinutes())}`;
  let title = `${sourceTitle}(本地副本-${stamp})`;
  let suffix = 2;
  while (existingTitles.has(title)) {
    title = `${sourceTitle}(本地副本-${stamp}-${suffix})`;
    suffix += 1;
  }

  const copied = await duplicateAppWorkspace({
    workspace_dir: sourceDir,
    title,
    local_conflict_backup_of: sourceId,
  });

  return {
    version: 1,
    workspace_root: copied.workspace_root,
    source_workspace_id: sourceId,
    source_workspace_dir: sourceDir,
    workspace_id: copied.workspace_id,
    workspace_dir: copied.workspace_dir,
    title: copied.title,
    backup_of: sourceId,
  } satisfies BackupWorkspaceAsLocalCopyResult;
}

export async function deleteAppWorkspace(
  input: DeleteAppWorkspaceInput,
): Promise<{ deleted: true; workspace_id: string; workspace_dir: string; tombstone: { deleted_at: string; lifecycle_epoch: number } }> {
  const workspaceDir = normalizeWorkspaceDir(input.workspace_dir);
  // Deletion must also work for damaged workspaces. Do not open, initialize,
  // or validate their authoring artifacts before removing the directory.
  const workspaceId = path.basename(workspaceDir);
  const activeRun = await findGenerationRunForWorkspace(WORKSPACE_ROOT, workspaceId);
  if (activeRun && ["preparing", "active", "committing"].includes(activeRun.state)) {
    throw new Error("An active generation run must be stopped before deleting this workspace.");
  }
  const sync = await getWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
  // Persist the no-auto-download decision before changing the tree. If the
  // process stops during deletion, keeping the still-present Workspace is safe;
  // recreating it from cloud over a user-deleted tree is not.
  const tombstone = await writeWorkspaceTombstone({
    workspace_id: workspaceId,
    lifecycle_epoch: sync?.lifecycle_epoch,
  });
  // Windows may briefly hold a rendered file (cover/out image) open via a
  // browser or antivirus scan; retry so a transient lock does not fail delete.
  try {
    await removeWithFilesystemRetry(workspaceDir);
  } catch (error) {
    // A normal failure leaves the Workspace intact, so do not silently turn it
    // into a suppressed local copy. A crash between the two operations keeps
    // the conservative tombstone, which is the safer side of this boundary.
    await clearWorkspaceTombstone(workspaceId).catch(() => undefined);
    throw error;
  }
  await deleteGenerationRunsForWorkspace(WORKSPACE_ROOT, workspaceId);
  return {
    deleted: true,
    workspace_id: workspaceId,
    workspace_dir: workspaceDir,
    tombstone: {
      deleted_at: tombstone.deleted_at,
      lifecycle_epoch: tombstone.lifecycle_epoch,
    },
  };
}

export async function getAppWorkspaceTombstone(input: {
  workspace_id: string;
}) {
  return getWorkspaceTombstone(input.workspace_id);
}

export async function writeAppWorkspaceTombstone(input: {
  workspace_id: string;
  lifecycle_epoch?: number;
}) {
  return writeWorkspaceTombstone(input);
}

export async function clearAppWorkspaceTombstone(input: {
  workspace_id: string;
}): Promise<{ cleared: boolean }> {
  return { cleared: await clearWorkspaceTombstone(input.workspace_id) };
}

export async function uploadAppUploadedSource(
  input: UploadAppUploadedSourceInput,
): Promise<UploadAppUploadedSourceResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const bytes = decodeUploadedSourceBase64(input.content_base64);
  return withUploadedSourceWriteQueue(workspace.workspace_dir, () => persistUploadedSourceBytes({
    workspace,
    filename: input.filename,
    mime_type: input.mime_type,
    bytes,
  }));
}

async function persistUploadedSourceBytes(input: {
  workspace: AppWorkspaceResult;
  filename: string;
  mime_type?: string;
  bytes: Buffer;
}): Promise<UploadAppUploadedSourceResult> {
  const originalFilename = sanitizeUploadedSourceDisplayName(input.filename);
  const bytes = input.bytes;
  const sizeBytes = bytes.byteLength;
  const extension = assertAllowedUploadedSourceFile(originalFilename, sizeBytes);
  const sha256 = sha256BufferHex(bytes);
  const now = new Date();
  const updatedAt = now.toISOString();
  const index = await readUploadedSourceIndex(input.workspace.workspace_dir);
  const activeMaterials = index.materials.filter((item) => item.status === "active");
  if (UPLOADED_SOURCE_IMAGE_EXTENSIONS.has(extension.toLowerCase())) {
    const activeImageCount = activeMaterials
      .filter((item) => UPLOADED_SOURCE_IMAGE_EXTENSIONS.has(item.extension.toLowerCase()))
      .length;
    if (activeImageCount + 1 > UPLOADED_SOURCE_IMAGE_MAX_COUNT) {
      throw new Error(`Active uploaded image attachments exceed the limit of ${UPLOADED_SOURCE_IMAGE_MAX_COUNT} images.`);
    }
  }
  const activeTotalWithNew = activeMaterials.reduce((sum, item) => sum + item.size_bytes, 0) + sizeBytes;
  if (activeTotalWithNew > UPLOADED_SOURCE_ACTIVE_TOTAL_MAX_BYTES) {
    throw new Error(`Active uploaded source files exceed the total limit of ${UPLOADED_SOURCE_ACTIVE_TOTAL_MAX_BYTES} bytes.`);
  }

  const existingIds = new Set(index.materials.map((item) => item.uploaded_source_id));
  const uploadedSourceId = createUploadedSourceId(now, sha256, existingIds);
  const storageDir = path.join(buildUploadedSourcePaths(input.workspace.workspace_dir).files_dir, uploadedSourceId);
  const storedFileName = `${sanitizeFileNamePart(path.basename(originalFilename, extension), "source")}${extension}`;
  const filePath = path.join(storageDir, storedFileName);
  assertPathUnderWorkspace(input.workspace.workspace_dir, filePath, "uploaded_source.file_path");
  await mkdir(storageDir, { recursive: true });
  await writeFile(filePath, bytes);

  const duplicateOf = activeMaterials
    .filter((item) => item.sha256 === sha256)
    .map((item) => item.uploaded_source_id);
  const material: AppUploadedSourceMaterial = {
    uploaded_source_id: uploadedSourceId,
    status: "active",
    original_filename: originalFilename,
    display_name: originalFilename,
    mime_type: normalizeString(input.mime_type),
    extension,
    size_bytes: sizeBytes,
    sha256,
    file_path: filePath,
    duplicate_of: duplicateOf,
    created_at: updatedAt,
    updated_at: updatedAt,
    removed_at: null,
  };
  const nextIndex = await writeUploadedSourceIndex(input.workspace.workspace_dir, {
    version: 1,
    workspace_dir: input.workspace.workspace_dir,
    active_total_size_bytes: activeTotalWithNew,
    materials: [...index.materials, material],
    updated_at: updatedAt,
  });
  await touchWorkspaceTask(input.workspace, updatedAt);
  // The source bytes and index now form one committed authoritative change.
  // Do not mark earlier: a publisher must never be invited to package the
  // source directory while its index is still being written.
  await markWorkspaceSnapshotDirty({ workspace_dir: input.workspace.workspace_dir });
  return {
    workspace_dir: input.workspace.workspace_dir,
    material,
    index: nextIndex,
    warnings: duplicateOf.length > 0
      ? [`Duplicate uploaded source content matches: ${duplicateOf.join(", ")}`]
      : [],
  };
}

export async function commitAppUploadedSourceUpload(input: {
  workspace_dir: string;
  upload_id: string;
  filename: string;
  mime_type?: string;
  staging_file_path: string;
  expected_size_bytes: number;
}): Promise<CommitAppUploadedSourceUploadResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const stagingPath = path.normalize(input.staging_file_path);
  const stagingStat = await stat(stagingPath);
  if (!stagingStat.isFile()) {
    throw new Error(`Uploaded source staging path is not a file: ${stagingPath}`);
  }
  if (stagingStat.size !== input.expected_size_bytes) {
    throw new Error(`Uploaded source staging size mismatch: expected ${input.expected_size_bytes} bytes, got ${stagingStat.size} bytes.`);
  }
  const bytes = await readFile(stagingPath);
  const result = await withUploadedSourceWriteQueue(workspace.workspace_dir, () => persistUploadedSourceBytes({
    workspace,
    filename: input.filename,
    mime_type: input.mime_type,
    bytes,
  }));
  return {
    ...result,
    upload_id: input.upload_id,
  };
}

function buildStyleProfileCreationPaths(creationId: string): AppStyleProfileCreationPaths {
  const creationDir = path.join(STYLE_PROFILE_CREATING_DIR, creationId);
  return {
    library_dir: STYLE_PROFILE_LIBRARY_DIR,
    creation_dir: creationDir,
    uploads_dir: path.join(creationDir, "uploads"),
    references_dir: path.join(creationDir, "references"),
    rasterized_dir: path.join(creationDir, "rasterized"),
    draft_dir: path.join(creationDir, "draft"),
    draft_profile_path: path.join(creationDir, "draft", "profile.md"),
    manifest_path: path.join(creationDir, "manifest.json"),
  };
}

function buildStyleProfileStoragePaths(styleProfileId: string) {
  const profileDir = path.join(STYLE_PROFILE_PROFILES_DIR, styleProfileId);
  return {
    profile_dir: profileDir,
    profile_path: path.join(profileDir, "profile.md"),
    metadata_path: path.join(profileDir, "metadata.json"),
    references_dir: path.join(profileDir, "references"),
  };
}

function buildWorkspaceStyleProfilePaths(workspaceDir: string) {
  const profileDir = path.join(workspaceDir, "profile");
  return {
    profile_dir: profileDir,
    profile_path: path.join(profileDir, "style-profile.md"),
    selection_path: path.join(profileDir, "selection.json"),
  };
}

function getImageMimeType(filePath: string): string {
  const extension = path.extname(filePath).trim().toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/png";
}

async function markWorkspaceRenderedPagesStaleIfPresent(
  workspace: AppWorkspaceResult,
  updatedAt: string,
): Promise<void> {
  const pagesRecord = getPlainRecord(await readJsonFileIfExists(workspace.files.pages));
  const pages = Array.isArray(pagesRecord.pages) ? pagesRecord.pages : [];
  if (pages.length === 0) return;
  await writeJsonFile(workspace.files.pages, {
    ...pagesRecord,
    status: "stale",
    updated_at: updatedAt,
  });
}

function assertStyleProfileCreationId(value: string): string {
  const creationId = sanitizeFileNamePart(value, "");
  if (!creationId || creationId !== value || !creationId.startsWith("style-profile-creation-")) {
    throw new Error('"creation_id" must be a valid Style Profile Creation Workspace id.');
  }
  const paths = buildStyleProfileCreationPaths(creationId);
  if (!isPathInsideDir(STYLE_PROFILE_CREATING_DIR, paths.creation_dir)) {
    throw new Error('"creation_id" resolves outside the Style Profile Creation directory.');
  }
  return creationId;
}

function assertStyleProfileId(value: string): string {
  const styleProfileId = sanitizeFileNamePart(value, "");
  if (!styleProfileId || styleProfileId !== value || !styleProfileId.startsWith("style-profile-")) {
    throw new Error('"style_profile_id" must be a valid Style Profile id.');
  }
  const paths = buildStyleProfileStoragePaths(styleProfileId);
  if (!isPathInsideDir(STYLE_PROFILE_PROFILES_DIR, paths.profile_dir)) {
    throw new Error('"style_profile_id" resolves outside the Style Profile Library profiles directory.');
  }
  return styleProfileId;
}

function createStyleProfileCreationId(now: Date): string {
  const datePart = [
    now.getFullYear(),
    padDatePart(now.getMonth() + 1),
    padDatePart(now.getDate()),
    padDatePart(now.getHours()),
    padDatePart(now.getMinutes()),
    padDatePart(now.getSeconds()),
  ].join("");
  return `style-profile-creation-${datePart}-${randomUUID().slice(0, 8)}`;
}

function createStyleProfileId(now: Date, sha256: string, existingIds: Set<string>): string {
  const datePart = [
    now.getFullYear(),
    padDatePart(now.getMonth() + 1),
    padDatePart(now.getDate()),
    padDatePart(now.getHours()),
    padDatePart(now.getMinutes()),
    padDatePart(now.getSeconds()),
  ].join("");
  const base = `style-profile-${datePart}-${sha256.slice(0, 8)}`;
  if (!existingIds.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  throw new Error("Could not create a unique Style Profile id.");
}

function createDefaultStyleProfileIndex(): AppStyleProfileIndex {
  return {
    version: 1,
    library_dir: STYLE_PROFILE_LIBRARY_DIR,
    profiles: [],
    updated_at: new Date().toISOString(),
  };
}

function normalizeStyleProfileIndexEntry(value: unknown): AppStyleProfileIndexEntry | null {
  const record = getPlainRecord(value);
  const styleProfileId = normalizeString(record.style_profile_id);
  const profilePath = normalizeString(record.profile_path);
  const profileDir = normalizeString(record.profile_dir);
  if (!styleProfileId || !profilePath || !profileDir) return null;
  return {
    version: 1,
    style_profile_id: styleProfileId,
    display_name: normalizeString(record.display_name) || styleProfileId,
    profile_dir: profileDir,
    profile_path: profilePath,
    metadata_path: normalizeString(record.metadata_path) || path.join(profileDir, "metadata.json"),
    profile_sha256: normalizeString(record.profile_sha256),
    size_bytes: typeof record.size_bytes === "number" && Number.isFinite(record.size_bytes)
      ? Math.max(0, Math.floor(record.size_bytes))
      : 0,
    reference_count: typeof record.reference_count === "number" && Number.isFinite(record.reference_count)
      ? Math.max(0, Math.floor(record.reference_count))
      : 0,
    source_file_count: typeof record.source_file_count === "number" && Number.isFinite(record.source_file_count)
      ? Math.max(0, Math.floor(record.source_file_count))
      : 0,
    created_at: normalizeString(record.created_at) || new Date().toISOString(),
    updated_at: normalizeString(record.updated_at) || new Date().toISOString(),
  };
}

function normalizeStyleProfileIndex(value: unknown): AppStyleProfileIndex {
  const record = getPlainRecord(value);
  const profiles = Array.isArray(record.profiles)
    ? record.profiles
        .map(normalizeStyleProfileIndexEntry)
        .filter((item): item is AppStyleProfileIndexEntry => item !== null)
    : [];
  profiles.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  return {
    version: 1,
    library_dir: STYLE_PROFILE_LIBRARY_DIR,
    profiles,
    updated_at: normalizeString(record.updated_at) || new Date().toISOString(),
  };
}

async function readStyleProfileIndex(): Promise<AppStyleProfileIndex> {
  const existing = await readJsonFileIfExists(STYLE_PROFILE_INDEX_PATH);
  return normalizeStyleProfileIndex(existing ?? createDefaultStyleProfileIndex());
}

async function writeStyleProfileIndex(index: AppStyleProfileIndex): Promise<AppStyleProfileIndex> {
  const normalized = normalizeStyleProfileIndex(index);
  await writeJsonFile(STYLE_PROFILE_INDEX_PATH, normalized);
  return normalized;
}

function normalizeStyleProfileReferenceMaterial(value: unknown): AppStyleProfileReferenceMaterial | null {
  const record = getPlainRecord(value);
  const referenceId = normalizeString(record.reference_id);
  const filePath = normalizeString(record.file_path);
  if (!referenceId || !filePath) return null;
  return {
    reference_id: referenceId,
    original_filename: normalizeString(record.original_filename) || referenceId,
    display_name: normalizeString(record.display_name) || normalizeString(record.original_filename) || referenceId,
    mime_type: normalizeString(record.mime_type),
    extension: normalizeString(record.extension),
    size_bytes: typeof record.size_bytes === "number" && Number.isFinite(record.size_bytes)
      ? Math.max(0, Math.floor(record.size_bytes))
      : 0,
    sha256: normalizeString(record.sha256),
    file_path: filePath,
    kind: record.kind === "pptx" ? "pptx" : "image",
    created_at: normalizeString(record.created_at) || new Date().toISOString(),
  };
}

function normalizeStyleProfileReferenceImage(value: unknown): AppReferenceSlideImage | null {
  const record = getPlainRecord(value);
  const referenceImageId = normalizeString(record.reference_image_id);
  const sourceReferenceId = normalizeString(record.source_reference_id);
  const filePath = normalizeString(record.file_path);
  if (!referenceImageId || !sourceReferenceId || !filePath) return null;
  return {
    reference_image_id: referenceImageId,
    source_reference_id: sourceReferenceId,
    source_file_path: normalizeString(record.source_file_path),
    page_number: typeof record.page_number === "number" && Number.isFinite(record.page_number)
      ? Math.max(1, Math.floor(record.page_number))
      : null,
    file_path: filePath,
    width: typeof record.width === "number" && Number.isFinite(record.width) ? Math.max(0, Math.floor(record.width)) : null,
    height: typeof record.height === "number" && Number.isFinite(record.height) ? Math.max(0, Math.floor(record.height)) : null,
    selected_for_analysis: record.selected_for_analysis === true,
    order: typeof record.order === "number" && Number.isFinite(record.order) ? Math.max(1, Math.floor(record.order)) : 1,
  };
}

function normalizeStyleProfileCreationManifest(
  value: unknown,
  creationId: string,
  displayName: string,
): AppStyleProfileCreationManifest {
  const record = getPlainRecord(value);
  const referenceMaterials = Array.isArray(record.reference_materials)
    ? record.reference_materials
        .map(normalizeStyleProfileReferenceMaterial)
        .filter((item): item is AppStyleProfileReferenceMaterial => item !== null)
    : [];
  const referenceImages = Array.isArray(record.reference_images)
    ? record.reference_images
        .map(normalizeStyleProfileReferenceImage)
        .filter((item): item is AppReferenceSlideImage => item !== null)
    : [];
  const selectedIds = new Set(normalizeStringArray(record.selected_reference_image_ids));
  return {
    version: 1,
    creation_id: creationId,
    display_name: normalizeString(record.display_name) || displayName,
    status: record.status === "published" ? "published" : referenceMaterials.length > 0 ? "uploaded" : "prepared",
    reference_materials: referenceMaterials,
    reference_images: referenceImages
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((item) => ({
        ...item,
        selected_for_analysis: selectedIds.size > 0
          ? selectedIds.has(item.reference_image_id)
          : item.selected_for_analysis,
      })),
    selected_reference_image_ids: selectedIds.size > 0
      ? Array.from(selectedIds)
      : referenceImages.filter((item) => item.selected_for_analysis).map((item) => item.reference_image_id),
    created_at: normalizeString(record.created_at) || new Date().toISOString(),
    updated_at: normalizeString(record.updated_at) || new Date().toISOString(),
    published_style_profile_id: normalizeString(record.published_style_profile_id) || undefined,
  };
}

async function readStyleProfileCreationManifest(
  creationId: string,
): Promise<AppStyleProfileCreationManifest> {
  const paths = buildStyleProfileCreationPaths(creationId);
  const existing = await readJsonFileIfExists(paths.manifest_path);
  if (!existing) {
    throw new Error(`Style Profile Creation Workspace not found: ${creationId}`);
  }
  return normalizeStyleProfileCreationManifest(existing, creationId, creationId);
}

async function writeStyleProfileCreationManifest(
  manifest: AppStyleProfileCreationManifest,
): Promise<AppStyleProfileCreationManifest> {
  const normalized = normalizeStyleProfileCreationManifest(
    manifest,
    manifest.creation_id,
    manifest.display_name,
  );
  await writeJsonFile(buildStyleProfileCreationPaths(normalized.creation_id).manifest_path, normalized);
  return normalized;
}

export function selectEvenlySpacedReferenceImages<T>(items: T[], limit = STYLE_PROFILE_REFERENCE_ANALYSIS_LIMIT): T[] {
  if (items.length <= limit) return items.slice();
  if (limit <= 1) return [items[0]];
  const selectedIndexes = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    selectedIndexes.add(Math.round(index * (items.length - 1) / (limit - 1)));
  }
  return Array.from(selectedIndexes)
    .sort((left, right) => left - right)
    .map((index) => items[index]);
}

function applyStyleProfileReferenceSelection(
  manifest: AppStyleProfileCreationManifest,
): AppStyleProfileCreationManifest {
  const orderedImages = manifest.reference_images
    .slice()
    .sort((left, right) => left.order - right.order);
  const selectedIds = new Set(
    selectEvenlySpacedReferenceImages(orderedImages, STYLE_PROFILE_REFERENCE_ANALYSIS_LIMIT)
      .map((item) => item.reference_image_id),
  );
  return {
    ...manifest,
    reference_images: orderedImages.map((item) => ({
      ...item,
      selected_for_analysis: selectedIds.has(item.reference_image_id),
    })),
    selected_reference_image_ids: Array.from(selectedIds),
  };
}

function assertAllowedStyleProfileReferenceFile(filename: string, sizeBytes: number): string {
  const extension = path.extname(filename).trim().toLowerCase();
  if (!extension || !STYLE_PROFILE_ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported Style Profile reference file type: ${extension || "(none)"}`);
  }
  if (sizeBytes <= 0) {
    throw new Error("Style Profile reference file must not be empty.");
  }
  if (sizeBytes > STYLE_PROFILE_SINGLE_FILE_MAX_BYTES) {
    throw new Error(`Style Profile reference file exceeds the single-file limit of ${STYLE_PROFILE_SINGLE_FILE_MAX_BYTES} bytes.`);
  }
  return extension;
}

async function readImageDimensions(filePath: string): Promise<{ width: number | null; height: number | null }> {
  const image = sharp(filePath);
  try {
    const metadata = await image.metadata();
    return {
      width: typeof metadata.width === "number" ? metadata.width : null,
      height: typeof metadata.height === "number" ? metadata.height : null,
    };
  } catch {
    return { width: null, height: null };
  } finally {
    image.destroy();
  }
}

function buildReferenceImageId(materialId: string, pageNumber: number | null): string {
  return pageNumber === null
    ? `${materialId}-image`
    : `${materialId}-page-${String(pageNumber).padStart(3, "0")}`;
}

async function materialToReferenceImages(input: {
  paths: AppStyleProfileCreationPaths;
  material: AppStyleProfileReferenceMaterial;
  extension: string;
  nextOrder: number;
}): Promise<AppReferenceSlideImage[]> {
  if (input.extension === ".pptx") {
    const outputDir = path.join(input.paths.rasterized_dir, input.material.reference_id);
    const rasterized = await rasterizePptxToImages({
      pptx_path: input.material.file_path,
      output_dir: outputDir,
      target_height: 720,
      overwrite: false,
    });
    return rasterized.slides.map((slide, index) => ({
      reference_image_id: buildReferenceImageId(input.material.reference_id, slide.page_number),
      source_reference_id: input.material.reference_id,
      source_file_path: input.material.file_path,
      page_number: slide.page_number,
      file_path: slide.image_path,
      width: slide.width,
      height: slide.height,
      selected_for_analysis: false,
      order: input.nextOrder + index,
    }));
  }

  const storedFileName = `${input.material.reference_id}${input.extension}`;
  const referenceImagePath = path.join(input.paths.references_dir, storedFileName);
  await mkdir(input.paths.references_dir, { recursive: true });
  await copyFile(input.material.file_path, referenceImagePath);
  const dimensions = await readImageDimensions(referenceImagePath);
  return [{
    reference_image_id: buildReferenceImageId(input.material.reference_id, null),
    source_reference_id: input.material.reference_id,
    source_file_path: input.material.file_path,
    page_number: null,
    file_path: referenceImagePath,
    width: dimensions.width,
    height: dimensions.height,
    selected_for_analysis: false,
    order: input.nextOrder,
  }];
}

export async function listAppStyleProfiles(): Promise<ListAppStyleProfilesResult> {
  const index = await readStyleProfileIndex();
  return {
    library_dir: STYLE_PROFILE_LIBRARY_DIR,
    index,
    profiles: index.profiles,
  };
}

async function readPublishedStyleProfileEntry(styleProfileId: string): Promise<AppStyleProfileIndexEntry> {
  const normalizedId = assertStyleProfileId(styleProfileId);
  const index = await readStyleProfileIndex();
  const profile = index.profiles.find((item) => item.style_profile_id === normalizedId);
  if (!profile) {
    throw new Error(`Style Profile not found: ${normalizedId}`);
  }
  return profile;
}

async function listStyleProfileReferenceImagePreviews(
  styleProfileId: string,
): Promise<AppStyleProfileReferenceImagePreview[]> {
  const storage = buildStyleProfileStoragePaths(styleProfileId);
  let filenames: string[];
  try {
    filenames = await readdir(storage.references_dir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const previews = await Promise.all(
    filenames
      .filter((filename) => /\.(?:png|jpe?g|webp|gif)$/i.test(filename))
      .sort((left, right) => left.localeCompare(right))
      .map(async (filename, index): Promise<AppStyleProfileReferenceImagePreview | null> => {
        const filePath = path.join(storage.references_dir, filename);
        if (!isPathInsideDir(storage.references_dir, filePath)) return null;
        const imageStat = await stat(filePath).catch(() => null);
        if (!imageStat?.isFile()) return null;
        return {
          reference_image_id: `${styleProfileId}-reference-${String(index + 1).padStart(3, "0")}`,
          file_path: filePath,
          filename,
          mime_type: getImageMimeType(filePath),
          size_bytes: imageStat.size,
          order: index + 1,
        };
      }),
  );
  return previews.filter((item): item is AppStyleProfileReferenceImagePreview => item !== null);
}

export async function getAppStyleProfilePreview(
  input: GetAppStyleProfilePreviewInput,
): Promise<GetAppStyleProfilePreviewResult> {
  const styleProfile = await readPublishedStyleProfileEntry(input.style_profile_id);
  const referenceImages = await listStyleProfileReferenceImagePreviews(styleProfile.style_profile_id);
  return {
    style_profile: styleProfile,
    cover_image: referenceImages[0] ?? null,
  };
}

export async function getAppStyleProfile(
  input: GetAppStyleProfileInput,
): Promise<GetAppStyleProfileResult> {
  const styleProfile = await readPublishedStyleProfileEntry(input.style_profile_id);
  const content = await readFile(styleProfile.profile_path, "utf8");
  const sizeBytes = Buffer.byteLength(content, "utf8");
  const sha256 = sha256Hex(content);
  return {
    style_profile: styleProfile,
    content,
    size_bytes: sizeBytes,
    sha256,
    reference_images: await listStyleProfileReferenceImagePreviews(styleProfile.style_profile_id),
  };
}

export async function prepareAppStyleProfileCreation(
  input: PrepareAppStyleProfileCreationInput = {},
): Promise<PrepareAppStyleProfileCreationResult> {
  const now = new Date();
  const creationId = createStyleProfileCreationId(now);
  const displayName = normalizeString(input.display_name).trim() || `Style Profile ${now.toISOString().slice(0, 10)}`;
  const paths = buildStyleProfileCreationPaths(creationId);
  await Promise.all([
    mkdir(paths.uploads_dir, { recursive: true }),
    mkdir(paths.references_dir, { recursive: true }),
    mkdir(paths.rasterized_dir, { recursive: true }),
    mkdir(paths.draft_dir, { recursive: true }),
  ]);
  const manifest = normalizeStyleProfileCreationManifest(null, creationId, displayName);
  await writeStyleProfileCreationManifest(manifest);
  return {
    ...paths,
    creation_id: creationId,
    display_name: displayName,
    prepared_at: manifest.created_at,
  };
}

export async function commitAppStyleProfileReferenceUpload(
  input: CommitAppStyleProfileReferenceUploadInput,
): Promise<CommitAppStyleProfileReferenceUploadResult> {
  const creationId = assertStyleProfileCreationId(input.creation_id);
  const paths = buildStyleProfileCreationPaths(creationId);
  const originalFilename = sanitizeUploadedSourceDisplayName(input.filename);
  const stagingPath = path.normalize(input.staging_file_path);
  const stagingStat = await stat(stagingPath);
  if (!stagingStat.isFile()) {
    throw new Error(`Style Profile reference staging path is not a file: ${stagingPath}`);
  }
  if (stagingStat.size !== input.expected_size_bytes) {
    throw new Error(`Style Profile reference staging size mismatch: expected ${input.expected_size_bytes} bytes, got ${stagingStat.size} bytes.`);
  }
  const extension = assertAllowedStyleProfileReferenceFile(originalFilename, stagingStat.size);

  return withStyleProfileWriteQueue(creationId, async () => {
    const manifest = await readStyleProfileCreationManifest(creationId);
    const bytes = await readFile(stagingPath);
    const sha256 = sha256BufferHex(bytes);
    const referenceId = `reference-${String(manifest.reference_materials.length + 1).padStart(3, "0")}-${sha256.slice(0, 8)}`;
    const storageDir = path.join(paths.uploads_dir, referenceId);
    const storedFileName = `${sanitizeFileNamePart(path.basename(originalFilename, extension), "reference")}${extension}`;
    const storedPath = path.join(storageDir, storedFileName);
    if (!isPathInsideDir(paths.uploads_dir, storedPath)) {
      throw new Error("Style Profile reference file path escapes uploads directory.");
    }
    await mkdir(storageDir, { recursive: true });
    await copyFile(stagingPath, storedPath);
    const now = new Date().toISOString();
    const material: AppStyleProfileReferenceMaterial = {
      reference_id: referenceId,
      original_filename: originalFilename,
      display_name: originalFilename,
      mime_type: normalizeString(input.mime_type),
      extension,
      size_bytes: stagingStat.size,
      sha256,
      file_path: storedPath,
      kind: extension === ".pptx" ? "pptx" : "image",
      created_at: now,
    };
    const referenceImages = await materialToReferenceImages({
      paths,
      material,
      extension,
      nextOrder: manifest.reference_images.length + 1,
    });
    const nextManifest = await writeStyleProfileCreationManifest(
      applyStyleProfileReferenceSelection({
        ...manifest,
        status: "uploaded",
        reference_materials: [...manifest.reference_materials, material],
        reference_images: [...manifest.reference_images, ...referenceImages],
        updated_at: now,
      }),
    );
    return {
      creation_id: creationId,
      upload_id: input.upload_id,
      material,
      manifest: nextManifest,
      warnings: [],
    };
  });
}

export async function getAppStyleProfileCreationContext(
  input: GetAppStyleProfileCreationContextInput,
): Promise<GetAppStyleProfileCreationContextResult> {
  const creationId = assertStyleProfileCreationId(input.creation_id);
  const paths = buildStyleProfileCreationPaths(creationId);
  const manifest = await readStyleProfileCreationManifest(creationId);
  const selectedIds = new Set(manifest.selected_reference_image_ids);
  const selectedReferenceImages = manifest.reference_images
    .filter((item) => selectedIds.has(item.reference_image_id))
    .sort((left, right) => left.order - right.order);
  return {
    ...paths,
    creation_id: creationId,
    manifest,
    selected_reference_images: selectedReferenceImages,
  };
}

async function fingerprintStyleProfileDraft(creationId: string): Promise<AppStyleProfileDraftFingerprint> {
  const draftPath = buildStyleProfileCreationPaths(creationId).draft_profile_path;
  try {
    const fingerprint = await fingerprintFile(draftPath);
    return {
      creation_id: creationId,
      draft_path: draftPath,
      exists: true,
      sha256: fingerprint.sha256,
      size_bytes: fingerprint.size_bytes,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        creation_id: creationId,
        draft_path: draftPath,
        exists: false,
      };
    }
    throw error;
  }
}

function assertValidStyleProfileDraft(content: string, sizeBytes: number): void {
  if (sizeBytes < STYLE_PROFILE_DRAFT_MIN_BYTES) {
    throw new Error(`Style Profile draft is too short. Expected at least ${STYLE_PROFILE_DRAFT_MIN_BYTES} bytes.`);
  }
  if (sizeBytes > STYLE_PROFILE_DRAFT_MAX_BYTES) {
    throw new Error(`Style Profile draft exceeds the ${STYLE_PROFILE_DRAFT_MAX_BYTES} byte limit.`);
  }
  if (content.trim().length === 0) {
    throw new Error("Style Profile draft must not be empty.");
  }
}

export async function getAppStyleProfileDraftFingerprint(
  input: GetAppStyleProfileDraftFingerprintInput,
): Promise<AppStyleProfileDraftFingerprint> {
  const creationId = assertStyleProfileCreationId(input.creation_id);
  return fingerprintStyleProfileDraft(creationId);
}

export async function getAppStyleProfileDraft(
  input: GetAppStyleProfileDraftInput,
): Promise<GetAppStyleProfileDraftResult> {
  const creationId = assertStyleProfileCreationId(input.creation_id);
  const draftPath = buildStyleProfileCreationPaths(creationId).draft_profile_path;
  const content = await readFile(draftPath, "utf8");
  const sizeBytes = Buffer.byteLength(content, "utf8");
  const sha256 = sha256Hex(content);
  return {
    creation_id: creationId,
    draft_path: draftPath,
    exists: true,
    content,
    size_bytes: sizeBytes,
    sha256,
  };
}

export async function publishAppStyleProfile(
  input: PublishAppStyleProfileInput,
): Promise<PublishAppStyleProfileResult> {
  const creationId = assertStyleProfileCreationId(input.creation_id);
  return withStyleProfileWriteQueue(STYLE_PROFILE_INDEX_PATH, async () => {
    const manifest = await readStyleProfileCreationManifest(creationId);
    const draft = await getAppStyleProfileDraft({ creation_id: creationId });
    assertValidStyleProfileDraft(draft.content, draft.size_bytes);
    const index = await readStyleProfileIndex();
    const now = new Date();
    const updatedAt = now.toISOString();
    const styleProfileId = createStyleProfileId(
      now,
      draft.sha256,
      new Set(index.profiles.map((item) => item.style_profile_id)),
    );
    const storage = buildStyleProfileStoragePaths(styleProfileId);
    await Promise.all([
      mkdir(storage.profile_dir, { recursive: true }),
      mkdir(storage.references_dir, { recursive: true }),
    ]);
    await writeFile(storage.profile_path, draft.content, "utf8");

    const selectedIds = new Set(manifest.selected_reference_image_ids);
    const selectedImages = manifest.reference_images
      .filter((item) => selectedIds.has(item.reference_image_id))
      .sort((left, right) => left.order - right.order);
    for (const image of selectedImages) {
      const extension = path.extname(image.file_path).toLowerCase() || ".png";
      const targetPath = path.join(
        storage.references_dir,
        `reference-${String(image.order).padStart(3, "0")}${extension}`,
      );
      await copyFile(image.file_path, targetPath);
    }

    const displayName = normalizeString(input.display_name).trim() || manifest.display_name || styleProfileId;
    const entry: AppStyleProfileIndexEntry = {
      version: 1,
      style_profile_id: styleProfileId,
      display_name: displayName,
      profile_dir: storage.profile_dir,
      profile_path: storage.profile_path,
      metadata_path: storage.metadata_path,
      profile_sha256: draft.sha256,
      size_bytes: draft.size_bytes,
      reference_count: selectedImages.length,
      source_file_count: manifest.reference_materials.length,
      created_at: updatedAt,
      updated_at: updatedAt,
    };
    await writeJsonFile(storage.metadata_path, entry);
    const nextIndex = await writeStyleProfileIndex({
      version: 1,
      library_dir: STYLE_PROFILE_LIBRARY_DIR,
      profiles: [entry, ...index.profiles],
      updated_at: updatedAt,
    });
    await writeStyleProfileCreationManifest({
      ...manifest,
      status: "published",
      display_name: displayName,
      updated_at: updatedAt,
      published_style_profile_id: styleProfileId,
    });
    return {
      style_profile: entry,
      index: nextIndex,
      profile_path: storage.profile_path,
      reference_count: selectedImages.length,
    };
  });
}

export async function selectAppWorkspaceStyleProfile(
  input: SelectAppWorkspaceStyleProfileInput,
): Promise<SelectAppWorkspaceStyleProfileResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const styleProfileId = assertStyleProfileId(input.style_profile_id);
  const index = await readStyleProfileIndex();
  const profile = index.profiles.find((item) => item.style_profile_id === styleProfileId);
  if (!profile) {
    throw new Error(`Style Profile not found: ${styleProfileId}`);
  }
  const content = await readFile(profile.profile_path, "utf8");
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (content.trim().length === 0) {
    throw new Error(`Style Profile is empty: ${styleProfileId}`);
  }
  const sha256 = sha256Hex(content);
  const paths = buildWorkspaceStyleProfilePaths(workspace.workspace_dir);
  await mkdir(paths.profile_dir, { recursive: true });
  await writeFile(paths.profile_path, content, "utf8");
  const selectedAt = new Date().toISOString();
  const selection = {
    version: 1 as const,
    style_profile_id: styleProfileId,
    display_name: profile.display_name,
    source_profile_path: profile.profile_path,
    workspace_profile_path: paths.profile_path,
    selection_path: paths.selection_path,
    profile_sha256: sha256,
    size_bytes: sizeBytes,
    selected_at: selectedAt,
  };
  await writeJsonFile(paths.selection_path, selection);
  await markWorkspaceRenderedPagesStaleIfPresent(workspace, selectedAt);
  await touchWorkspaceTask(workspace, selectedAt);
  return {
    workspace: await ensureWorkspaceFiles(workspace.workspace_dir),
    selection,
    content,
  };
}

export async function getAppWorkspaceStyleProfile(
  input: GetAppWorkspaceStyleProfileInput,
): Promise<GetAppWorkspaceStyleProfileResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const paths = buildWorkspaceStyleProfilePaths(workspace.workspace_dir);
  const selectionRecord = await readJsonFileIfExists(paths.selection_path);
  const selection = getPlainRecord(selectionRecord);
  const hasSelection = Boolean(normalizeString(selection.style_profile_id));
  const content = await readFile(paths.profile_path, "utf8").catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      if (hasSelection) {
        throw new Error("Selected Style Profile file is missing. Select or clear the workspace Style Profile before generation.");
      }
      return "";
    }
    throw error;
  });
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (hasSelection && content.trim().length === 0) {
    throw new Error("Selected Style Profile file is empty. Select or clear the workspace Style Profile before generation.");
  }
  const sha256 = content ? sha256Hex(content) : "";
  return {
    workspace_dir: workspace.workspace_dir,
    selected: hasSelection,
    profile_path: paths.profile_path,
    selection_path: paths.selection_path,
    selection: hasSelection
      ? {
          version: 1,
          style_profile_id: normalizeString(selection.style_profile_id),
          display_name: normalizeString(selection.display_name),
          source_profile_path: normalizeString(selection.source_profile_path),
          workspace_profile_path: paths.profile_path,
          selection_path: paths.selection_path,
          profile_sha256: normalizeString(selection.profile_sha256),
          size_bytes: typeof selection.size_bytes === "number" && Number.isFinite(selection.size_bytes)
            ? Math.max(0, Math.floor(selection.size_bytes))
            : sizeBytes,
          selected_at: normalizeString(selection.selected_at),
        }
      : null,
    content,
    size_bytes: sizeBytes,
    sha256,
  };
}

export async function clearAppWorkspaceStyleProfile(
  input: ClearAppWorkspaceStyleProfileInput,
): Promise<ClearAppWorkspaceStyleProfileResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const paths = buildWorkspaceStyleProfilePaths(workspace.workspace_dir);
  const existed = await fileExists(paths.profile_path).then(Boolean).catch(() => false);
  const selectionExisted = await fileExists(paths.selection_path).then(Boolean).catch(() => false);
  await Promise.all([
    rm(paths.profile_path, { force: true }),
    rm(paths.selection_path, { force: true }),
  ]);
  if (existed || selectionExisted) {
    const updatedAt = new Date().toISOString();
    await markWorkspaceRenderedPagesStaleIfPresent(workspace, updatedAt);
    await touchWorkspaceTask(workspace, updatedAt);
  }
  return {
    workspace: await ensureWorkspaceFiles(workspace.workspace_dir),
    cleared: existed || selectionExisted,
  };
}

export async function listAppUploadedSources(
  input: ListAppUploadedSourcesInput,
): Promise<ListAppUploadedSourcesResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const index = await readUploadedSourceIndex(workspace.workspace_dir);
  const active = index.materials.filter((item) => item.status === "active");
  const removed = index.materials.filter((item) => item.status === "removed");
  const ignored = index.materials.filter((item) => item.status === "ignored");
  return {
    workspace_dir: workspace.workspace_dir,
    index: {
      ...index,
      materials: input.include_removed === true ? index.materials : active,
    },
    active,
    removed: input.include_removed === true ? removed : [],
    ignored: input.include_removed === true ? ignored : [],
    limits: {
      single_file_max_bytes: UPLOADED_SOURCE_SINGLE_FILE_MAX_BYTES,
      active_total_max_bytes: UPLOADED_SOURCE_ACTIVE_TOTAL_MAX_BYTES,
    },
  };
}

export async function runAppUploadedSourcePreflight(
  input: RunAppUploadedSourcePreflightInput,
): Promise<RunAppUploadedSourcePreflightResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  return withUploadedSourceWriteQueue(workspace.workspace_dir, async () => {
    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    const index = await readUploadedSourceIndex(workspace.workspace_dir);
    const active = index.materials.filter((item) => item.status === "active");
    const staged = [] as Array<{
      material: AppUploadedSourceMaterial;
      result: AppUploadedSourcePreflightResult;
      extractedText: string;
      isSpreadsheet: boolean;
      timing: {
        character_count_ready_ms: number | null;
        full_text_saved_ms: number | null;
        preflight_total_ms: number;
      };
    }>;

    for (const material of active) {
      const itemStarted = performance.now();
      const isPdf = material.extension.toLowerCase() === ".pdf";
      let failedOccurrences = 0;
      let partialOccurrences = 0;
      let extracted;
      const preflightPaths = buildUploadedSourcePreflightPaths(workspace.workspace_dir, material.uploaded_source_id);
      const existing = isPdf ? await readJsonFileIfExists(preflightPaths.result_path) as AppUploadedSourcePreflightResult | null : null;
      if (existing?.pdf_ocr_progress?.status === "processing") {
        let extractedText = "";
        try { extractedText = await readFile(preflightPaths.text_path, "utf8"); } catch { /* The initial extraction is written before the job starts. */ }
        staged.push({
          material,
          result: existing,
          extractedText,
          isSpreadsheet: false,
          timing: { character_count_ready_ms: 0, full_text_saved_ms: 0, preflight_total_ms: 0 },
        });
        continue;
      }
      await rm(preflightPaths.assets_dir, { recursive: true, force: true });
      // Count the observed parse outcomes, rather than the number of retry
      // calls. A failed result can occur up to three times; a second partial
      // result is retained for the deterministic continuation decision below.
      for (;;) {
        try {
          extracted = await extractUploadedSource(material.file_path, material.extension, {
            asset_dir: preflightPaths.assets_dir,
            asset_reference_prefix: `${material.uploaded_source_id}.assets`,
            defer_pdf_ocr: isPdf,
          });
        } catch (error) {
          extracted = {
            text: "",
            parse_status: "failed" as const,
            warnings: [{ code: "parse_failed", message: error instanceof Error ? error.message : "文件无法打开或解析。" }],
            format_metrics: {},
            is_image: [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(material.extension.toLowerCase()),
            is_spreadsheet: [".xlsx", ".xls", ".csv"].includes(material.extension.toLowerCase()),
          };
        }
        if (extracted.parse_status === "ready") break;
        if (extracted.parse_status === "failed") {
          failedOccurrences += 1;
          if (failedOccurrences >= 3) break;
          continue;
        }
        partialOccurrences += 1;
        if (partialOccurrences >= 2) break;
      }
      const characterCount = extracted.is_image ? undefined : extracted.text.length;
      const characterReadyMs = extracted.is_image ? null : Math.round(performance.now() - itemStarted);
      const tokenEstimate = extracted.is_image ? undefined : estimateTokens(extracted.text);
      const result: AppUploadedSourcePreflightResult = {
        source_id: material.uploaded_source_id,
        filename: material.original_filename,
        file_type: material.extension.replace(/^\./, "").toLowerCase(),
        size_bytes: material.size_bytes,
        parse_status: extracted.parse_status,
        ...(characterCount === undefined ? {} : { character_count: characterCount, token_estimate: tokenEstimate }),
        format_metrics: extracted.format_metrics,
        content_strategy: null,
        original_reading_method: null,
        warnings: extracted.warnings,
        ...(extracted.pdf_ocr_deferred ? {
          pdf_ocr_progress: {
            status: "processing" as const,
            total_pages: extracted.format_metrics.total_pages ?? 0,
            candidate_pages: extracted.format_metrics.ocr_candidate_pages ?? 0,
            processed_pages: 0,
            completed_pages: 0,
            failed_pages: 0,
            current_page: null,
          },
        } : {}),
      };
      // Persist the raw extraction immediately. Batch routing needs all token
      // estimates, but it must not make a small file's extraction timing wait
      // for a later, slower file such as a PDF.
      let fullTextSavedMs: number | null = null;
      if (characterCount !== undefined) {
        await mkdir(preflightPaths.root_dir, { recursive: true });
        await writeFile(preflightPaths.text_path, extracted.text, "utf8");
        fullTextSavedMs = Math.round(performance.now() - itemStarted);
      }
      staged.push({
        material,
        extractedText: extracted.text,
        isSpreadsheet: extracted.is_spreadsheet,
        result,
        timing: {
          character_count_ready_ms: characterReadyMs,
          full_text_saved_ms: fullTextSavedMs,
          // Deliberately measured before the later batch-wide routing pass, so
          // a small file's timing does not include waiting for a later source.
          preflight_total_ms: Math.round(performance.now() - itemStarted),
        },
      });
    }

    const results: AppUploadedSourcePreflightResult[] = [];
    for (const item of staged) {
      const paths = buildUploadedSourcePreflightPaths(workspace.workspace_dir, item.material.uploaded_source_id);
      const result = item.result;
      if (result.pdf_ocr_progress?.status === "processing") {
        result.content_strategy = null;
        result.original_reading_method = null;
        await writeJsonFile(paths.result_path, result);
        results.push(result);
        continue;
      }
      result.content_strategy = result.parse_status === "failed"
        ? null
        : result.character_count === undefined
          ? "image_processing"
          : result.parse_status === "partial"
            ? item.isSpreadsheet && canUseFullContextForPartialSpreadsheet({
                text: item.extractedText,
                formatMetrics: result.format_metrics,
                warnings: result.warnings,
              }) ? "full_context"
              : canContinuePartialSource({
                text: item.extractedText,
                formatMetrics: result.format_metrics,
                warnings: result.warnings,
              }) ? "summarized_context" : null
            // Ready text sources start as full-context candidates. The final
            // full/summary decision is made later against the shared 64k
            // user-brief + attachment-context budget.
            : "full_context";
      result.original_reading_method = result.character_count === undefined
        ? null
        : selectOriginalReadingMethod({
            contentStrategy: result.content_strategy === "image_processing" ? null : result.content_strategy,
            isSpreadsheet: item.isSpreadsheet,
          });
      await writeJsonFile(paths.result_path, result);
      results.push(result);
    }
    // `uploaded-sources/preflight` belongs to the ZIP authority set. Mark only
    // after every active source has reached its stable result for this run;
    // individual extraction/OCR progress writes are deliberately not upload
    // triggers.
    if (staged.length > 0) {
      await markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
    }
    const completedAt = new Date().toISOString();
    await appendAppWorkspaceLog({
      workspace_dir: workspace.workspace_dir,
      channel: "attachment-preflight",
      entry: {
        event: "attachment_preflight_completed",
        schema_version: 1,
        run_id: runId,
        started_at: startedAt,
        completed_at: completedAt,
        attachments: staged.map((item) => ({
          source_id: item.result.source_id,
          filename: item.result.filename,
          ...item.timing,
        })),
      },
    });
    return { workspace_dir: workspace.workspace_dir, started_at: startedAt, completed_at: completedAt, results };
  });
}

// Detection is cheap and shares one worker across a wider batch. Recognition
// keeps a small batch so two worst-case pages plus startup remain below the
// host's 65-second tool deadline without imposing a document-wide limit.
const PDF_OCR_DETECTION_PAGES_PER_CONTINUATION = 16;
const PDF_OCR_PAGES_PER_CONTINUATION = 2;

function isPdfOcrPageResult(value: unknown): value is PdfOcrPageResult {
  return Boolean(value)
    && typeof value === "object"
    && Number.isInteger((value as PdfOcrPageResult).page_number)
    && typeof (value as PdfOcrPageResult).native_text === "string"
    && typeof (value as PdfOcrPageResult).ocr_text === "string"
    && ["detected", "skipped", "completed", "failed"].includes((value as PdfOcrPageResult).status)
    && ((value as PdfOcrPageResult).error === undefined || typeof (value as PdfOcrPageResult).error === "string");
}

/**
 * Advances persisted PDF OCR deliberately within this tool invocation. Executa
 * does not guarantee an unawaited Promise survives after a tool response, so
 * each call finishes and saves a small batch before returning.
 */
export async function continueAppUploadedSourcePdfOcr(
  input: ContinueAppUploadedSourcePdfOcrInput,
): Promise<ContinueAppUploadedSourcePdfOcrResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  return withUploadedSourceWriteQueue(workspace.workspace_dir, async () => {
    const index = await readUploadedSourceIndex(workspace.workspace_dir);
    const results: AppUploadedSourcePreflightResult[] = [];
    let persistedAuthoritativeChange = false;

    for (const material of index.materials.filter((item) => item.status === "active")) {
      const paths = buildUploadedSourcePreflightPaths(workspace.workspace_dir, material.uploaded_source_id);
      const raw = await readJsonFileIfExists(paths.result_path);
      if (!raw) continue;
      const current = raw as AppUploadedSourcePreflightResult;
      if (material.extension.toLowerCase() !== ".pdf" || current.pdf_ocr_progress?.status !== "processing") {
        results.push(current);
        continue;
      }

      const persistedRaw = await readJsonFileIfExists(paths.pdf_ocr_path);
      const persistedRecord = getPlainRecord(persistedRaw);
      // Version 3 adds the detected/skipped states used by the layout-analysis
      // gate. Earlier whole-page OCR checkpoints are intentionally rebuilt.
      const usePersistedPages = persistedRecord.version === 3;
      const persistedPages = Object.fromEntries(
        Object.entries(usePersistedPages ? getPlainRecord(persistedRecord.pages) : {})
          .filter(([, page]) => isPdfOcrPageResult(page)),
      ) as Record<string, PdfOcrPageResult>;
      const pageResults = new Map(
        Object.values(persistedPages).map((page) => [page.page_number, page] as const),
      );

      try {
        const extracted = await extractUploadedSource(material.file_path, material.extension, {
          asset_dir: paths.assets_dir,
          asset_reference_prefix: `${material.uploaded_source_id}.assets`,
          pdf_ocr_page_results: pageResults,
          pdf_ocr_detection_page_limit: PDF_OCR_DETECTION_PAGES_PER_CONTINUATION,
          pdf_ocr_page_limit: PDF_OCR_PAGES_PER_CONTINUATION,
          on_pdf_ocr_progress: async (progress) => {
            current.pdf_ocr_progress = { status: "processing", ...progress };
            await writeJsonFile(paths.result_path, current);
            persistedAuthoritativeChange = true;
          },
          on_pdf_ocr_stage: async (stage) => {
            const { status: _previousStatus, ...previousProgress } = current.pdf_ocr_progress ?? {
              status: "processing" as const,
              total_pages: 0,
              candidate_pages: 0,
              processed_pages: 0,
              completed_pages: 0,
              failed_pages: 0,
              current_page: null,
            };
            current.pdf_ocr_progress = {
              status: "processing",
              ...previousProgress,
              diagnostic_stage: stage.stage,
              diagnostic_updated_at: new Date().toISOString(),
            };
            await writeJsonFile(paths.result_path, current);
            persistedAuthoritativeChange = true;
          },
          on_pdf_ocr_page: async (page) => {
            persistedPages[String(page.page_number)] = page;
            await writeJsonFile(paths.pdf_ocr_path, { version: 3, pages: persistedPages });
            persistedAuthoritativeChange = true;
          },
        });

        const completedPages = extracted.format_metrics.ocr_completed_pages ?? 0;
        const failedPages = extracted.format_metrics.ocr_failed_pages ?? 0;
        const skippedPages = extracted.format_metrics.ocr_skipped_pages ?? 0;
        const candidatePages = extracted.format_metrics.ocr_candidate_pages ?? 0;
        if (extracted.pdf_ocr_pending) {
          current.format_metrics = extracted.format_metrics;
          current.warnings = extracted.warnings;
          current.pdf_ocr_progress = {
            status: "processing",
            total_pages: extracted.format_metrics.total_pages ?? 0,
            candidate_pages: candidatePages,
            processed_pages: completedPages + failedPages + skippedPages,
            completed_pages: completedPages,
            failed_pages: failedPages,
            current_page: null,
          };
          await writeJsonFile(paths.result_path, current);
          persistedAuthoritativeChange = true;
          results.push(current);
          continue;
        }

        const result: AppUploadedSourcePreflightResult = {
          ...current,
          parse_status: extracted.parse_status,
          character_count: extracted.text.length,
          token_estimate: estimateTokens(extracted.text),
          format_metrics: extracted.format_metrics,
          content_strategy: "full_context",
          original_reading_method: selectOriginalReadingMethod({ contentStrategy: "full_context", isSpreadsheet: false }),
          warnings: extracted.warnings,
          pdf_ocr_progress: {
            status: "completed",
            total_pages: extracted.format_metrics.total_pages ?? 0,
            candidate_pages: candidatePages,
            processed_pages: candidatePages,
            completed_pages: completedPages,
            failed_pages: failedPages,
            current_page: null,
          },
        };
        await writeFile(paths.text_path, extracted.text, "utf8");
        await writeJsonFile(paths.result_path, result);
        persistedAuthoritativeChange = true;
        results.push(result);
      } catch (error) {
        const progress = current.pdf_ocr_progress;
        current.pdf_ocr_progress = {
          status: "completed",
          total_pages: progress?.total_pages ?? 0,
          candidate_pages: progress?.candidate_pages ?? 0,
          processed_pages: progress?.processed_pages ?? 0,
          completed_pages: progress?.completed_pages ?? 0,
          failed_pages: (progress?.failed_pages ?? 0) + 1,
          current_page: null,
        };
        current.content_strategy = "full_context";
        current.original_reading_method = selectOriginalReadingMethod({ contentStrategy: "full_context", isSpreadsheet: false });
        current.warnings = [...current.warnings, {
          code: "pdf_ocr_continuation_failed",
          message: `PDF OCR continuation did not complete; native text remains available.${error instanceof Error && error.message ? ` Cause: ${error.message}` : ""}`,
        }];
        await writeJsonFile(paths.result_path, current);
        persistedAuthoritativeChange = true;
        results.push(current);
      }
    }
    if (persistedAuthoritativeChange) {
      // An OCR invocation can contain many checkpoint writes. They represent
      // one completed local transaction from the snapshot scheduler's point
      // of view, so advance change_seq once after the queue has settled.
      await markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
    }
    return { workspace_dir: workspace.workspace_dir, results };
  });
}

export async function getAppUploadedSourcePreflightStatus(
  input: GetAppUploadedSourcePreflightStatusInput,
): Promise<GetAppUploadedSourcePreflightStatusResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const index = await readUploadedSourceIndex(workspace.workspace_dir);
  const results = [] as AppUploadedSourcePreflightResult[];
  for (const material of index.materials.filter((item) => item.status === "active")) {
    const raw = await readJsonFileIfExists(buildUploadedSourcePreflightPaths(workspace.workspace_dir, material.uploaded_source_id).result_path);
    if (raw) results.push(raw as AppUploadedSourcePreflightResult);
  }
  return { workspace_dir: workspace.workspace_dir, results };
}

export async function getAppUploadedSourcePreflightText(
  input: GetAppUploadedSourcePreflightTextInput,
): Promise<GetAppUploadedSourcePreflightTextResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const listed = await listAppUploadedSources({ workspace_dir: workspace.workspace_dir });
  const material = listed.active.find((entry) => entry.uploaded_source_id === input.uploaded_source_id);
  if (!material) throw new Error(`Active Uploaded Source Material not found: ${input.uploaded_source_id}`);
  const paths = buildUploadedSourcePreflightPaths(workspace.workspace_dir, material.uploaded_source_id);
  const content = await readFile(paths.text_path, "utf8");
  const maximum = input.attachment_chunk ? ATTACHMENT_BRIEF_CHUNK_MAX_CHARACTERS : 120_000;
  const requestedOffset = input.offset ?? 0;
  const requestedLimit = input.limit ?? maximum;
  if (!Number.isInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > content.length) {
    throw new Error("Preflight text offset must be a non-negative integer within the persisted extraction.");
  }
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error("Preflight text limit must be a positive integer.");
  }
  const limit = Math.min(requestedLimit, maximum);
  let end = Math.min(content.length, requestedOffset + limit);
  // Avoid splitting a surrogate pair at a page boundary.
  if (end < content.length && /[\uD800-\uDBFF]/u.test(content.charAt(end - 1)) && /[\uDC00-\uDFFF]/u.test(content.charAt(end))) {
    end -= 1;
  }
  const nextOffset = end < content.length ? end : null;
  return {
    workspace_dir: workspace.workspace_dir,
    uploaded_source_id: material.uploaded_source_id,
    filename: material.original_filename,
    content: content.slice(requestedOffset, end),
    offset: requestedOffset,
    next_offset: nextOffset,
    total_characters: content.length,
    complete: nextOffset === null,
    truncated: nextOffset !== null,
  };
}

// Keep each source chunk well under the frontend's 400k conservative Complete
// budget after the 1.2 estimation safety multiplier and prompt overhead.
const ATTACHMENT_BRIEF_CHUNK_TARGET_TOKENS = 250_000;
const ATTACHMENT_BRIEF_CHUNK_HARD_LIMIT_TOKENS = 300_000;
// Token approximation underestimates dense opaque strings such as embedded
// Base64. A raw-character ceiling gives every model request a second,
// deterministic safety boundary without format-specific heuristics.
const ATTACHMENT_BRIEF_CHUNK_MAX_CHARACTERS = 300_000;
const ATTACHMENT_BRIEF_FORCED_SPLIT_OVERLAP_TOKENS = 200;

interface PreflightTextBlock {
  text: string;
  start: number;
  end: number;
  headingPath: string[];
  tokenEstimate: number;
}

function headingForPreflightTextBlock(text: string) {
  const match = text.match(/^(#{1,6})\s+(.+)$/m);
  return match ? { level: match[1].length, title: match[2].trim() } : null;
}

function choosePreflightForcedBreak(text: string, start: number, desiredEnd: number) {
  const lower = Math.max(start + 1, Math.floor(start + (desiredEnd - start) * 0.9));
  const candidates = ["\n\n", "\n", ". ", "。", "！", "？", "; "];
  let selected = -1;
  for (const marker of candidates) {
    const found = text.lastIndexOf(marker, desiredEnd);
    if (found >= lower) selected = Math.max(selected, found + marker.length);
  }
  return selected > start ? selected : desiredEnd;
}

function splitOversizedPreflightTextBlock(block: PreflightTextBlock): PreflightTextBlock[] {
  if (
    block.tokenEstimate <= ATTACHMENT_BRIEF_CHUNK_HARD_LIMIT_TOKENS
    && block.text.length <= ATTACHMENT_BRIEF_CHUNK_MAX_CHARACTERS
  ) return [block];
  const parts: PreflightTextBlock[] = [];
  let start = 0;
  while (start < block.text.length) {
    const remainder = block.text.slice(start);
    const remainderTokenEstimate = estimateTokens(remainder);
    if (
      remainderTokenEstimate <= ATTACHMENT_BRIEF_CHUNK_HARD_LIMIT_TOKENS
      && remainder.length <= ATTACHMENT_BRIEF_CHUNK_MAX_CHARACTERS
    ) {
      parts.push({
        ...block,
        text: remainder,
        start: block.start + start,
        end: block.end,
        tokenEstimate: remainderTokenEstimate,
      });
      break;
    }
    let low = start + 1;
    let high = Math.min(block.text.length, start + ATTACHMENT_BRIEF_CHUNK_MAX_CHARACTERS);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (estimateTokens(block.text.slice(start, middle)) <= ATTACHMENT_BRIEF_CHUNK_HARD_LIMIT_TOKENS) low = middle;
      else high = middle - 1;
    }
    const end = choosePreflightForcedBreak(block.text, start, low);
    const text = block.text.slice(start, end);
    parts.push({
      ...block,
      text,
      start: block.start + start,
      end: block.start + end,
      tokenEstimate: estimateTokens(text),
    });
    let nextStart = end;
    while (nextStart > start && estimateTokens(block.text.slice(nextStart, end)) < ATTACHMENT_BRIEF_FORCED_SPLIT_OVERLAP_TOKENS) nextStart -= 1;
    start = Math.max(start + 1, nextStart);
  }
  return parts;
}

function buildPreflightTextBlocks(content: string): PreflightTextBlock[] {
  const rawBlocks: PreflightTextBlock[] = [];
  const headingPath: string[] = [];
  const matcher = /[^\n](?:[\s\S]*?)(?=\n{2,}|$)/g;
  for (const match of content.matchAll(matcher)) {
    const raw = match[0];
    const leading = raw.search(/\S/u);
    if (leading < 0 || match.index === undefined) continue;
    const text = raw.slice(leading).trimEnd();
    const start = match.index + leading;
    const heading = headingForPreflightTextBlock(text);
    if (heading) {
      headingPath.splice(heading.level - 1);
      headingPath[heading.level - 1] = heading.title;
    }
    rawBlocks.push({
      text,
      start,
      end: start + text.length,
      headingPath: [...headingPath],
      tokenEstimate: estimateTokens(text),
    });
  }
  return rawBlocks.flatMap(splitOversizedPreflightTextBlock);
}

export async function getAppUploadedSourcePreflightChunks(
  input: GetAppUploadedSourcePreflightChunksInput,
): Promise<GetAppUploadedSourcePreflightChunksResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const listed = await listAppUploadedSources({ workspace_dir: workspace.workspace_dir });
  const material = listed.active.find((entry) => entry.uploaded_source_id === input.uploaded_source_id);
  if (!material) throw new Error(`Active Uploaded Source Material not found: ${input.uploaded_source_id}`);
  const paths = buildUploadedSourcePreflightPaths(workspace.workspace_dir, material.uploaded_source_id);
  const content = await readFile(paths.text_path, "utf8");
  const planningStartedAt = performance.now();
  const blocks = buildPreflightTextBlocks(content);
  const chunks: GetAppUploadedSourcePreflightChunksResult["chunks"] = [];
  let active: PreflightTextBlock[] = [];
  let activeTokenEstimate = 0;
  const flush = () => {
    if (active.length === 0) return;
    const first = active[0];
    const last = active.at(-1)!;
    const startOffset = first.start;
    const endOffset = last.end;
    chunks.push({
      chunk_id: `chunk-${String(chunks.length + 1).padStart(3, "0")}`,
      heading_path: last.headingPath,
      source_range: `characters:${startOffset}-${endOffset}`,
      start_offset: startOffset,
      end_offset: endOffset,
      token_estimate: activeTokenEstimate,
    });
    active = [];
    activeTokenEstimate = 0;
  };
  for (const block of blocks) {
    const heading = headingForPreflightTextBlock(block.text);
    const startsSpreadsheetSheet = heading?.level === 1 && heading.title.startsWith("Sheet:");
    if (
      active.length > 0
      && (
        startsSpreadsheetSheet
        ||
        activeTokenEstimate + block.tokenEstimate > ATTACHMENT_BRIEF_CHUNK_TARGET_TOKENS
        || block.end - active[0].start > ATTACHMENT_BRIEF_CHUNK_MAX_CHARACTERS
      )
    ) flush();
    active.push(block);
    activeTokenEstimate += block.tokenEstimate;
  }
  flush();
  const planningMs = Math.round(performance.now() - planningStartedAt);
  await appendAppWorkspaceLog({
    workspace_dir: workspace.workspace_dir,
    channel: "attachment-preflight",
    entry: {
      event: "attachment_preflight_chunk_plan_completed",
      schema_version: 1,
      uploaded_source_id: material.uploaded_source_id,
      filename: material.original_filename,
      total_characters: content.length,
      chunk_count: chunks.length,
      planning_ms: planningMs,
    },
  }).catch((error) => {
    // Planning itself remains usable if an optional observability write is
    // temporarily blocked by another local process on Windows.
    console.warn("Failed to record attachment preflight chunk planning telemetry", error);
  });
  return {
    workspace_dir: workspace.workspace_dir,
    uploaded_source_id: material.uploaded_source_id,
    filename: material.original_filename,
    total_characters: content.length,
    planning_ms: planningMs,
    chunk_count: chunks.length,
    chunks,
  };
}

function normalizeAttachmentBrief(value: unknown, input: {
  sourceId: string;
  filename: string;
}): AppAttachmentBrief {
  const record = getPlainRecord(value);
  const contentStrategy = record.content_strategy === "full_context" || record.content_strategy === "summarized_context"
    ? record.content_strategy
    : null;
  const readingMethod = record.original_reading_method === "document_read" || record.original_reading_method === "document_retrieval" || record.original_reading_method === "spreadsheet_read" || record.original_reading_method === "table_query" || record.original_reading_method === "image_multimodal_read"
    ? record.original_reading_method
    : null;
  if (!contentStrategy || !readingMethod) {
    throw new Error("Attachment Brief must have a valid content_strategy and original_reading_method.");
  }
  const keyFacts = Array.isArray(record.key_facts) ? record.key_facts.map(getPlainRecord).map((fact, index) => {
    const evidenceId = normalizeString(fact.evidence_id) || `evidence-${index + 1}`;
    const text = normalizeString(fact.fact);
    const sourceLabel = normalizeString(fact.source_label);
    const excerpt = normalizeString(fact.excerpt);
    if (!text || !sourceLabel || !excerpt) throw new Error(`Attachment Brief key_facts[${index}] is missing fact, source_label, or excerpt.`);
    return { evidence_id: evidenceId, fact: text, source_label: sourceLabel, excerpt };
  }) : [];
  const mustInclude = Array.isArray(record.must_include) ? record.must_include.map(getPlainRecord).map((item, index) => {
    const requirement = normalizeString(item.requirement);
    if (!requirement) throw new Error(`Attachment Brief must_include[${index}] is missing requirement.`);
    return { requirement, evidence_ids: normalizeStringArray(item.evidence_ids) };
  }) : [];
  const relationshipToTask = normalizeString(record.relationship_to_task);
  const useInPpt = readingMethod === "image_multimodal_read" && typeof record.use_in_ppt === "boolean"
    ? record.use_in_ppt
    : undefined;
  const imageUsageReason = readingMethod === "image_multimodal_read"
    ? normalizeString(record.image_usage_reason)
    : "";
  const mainMessage = normalizeString(record.main_message);
  const sheetCoverage = Array.isArray(record.sheet_coverage) ? record.sheet_coverage.map(getPlainRecord).map((item, index) => {
    const sheetName = normalizeString(item.sheet_name);
    const status: AppAttachmentBriefSheetCoverage["status"] | null = item.status === "covered" || item.status === "not_relevant" || item.status === "unreadable"
      ? item.status
      : null;
    if (!sheetName || !status) throw new Error(`Attachment Brief sheet_coverage[${index}] is missing sheet_name or has an invalid status.`);
    const evidenceIds = normalizeStringArray(item.evidence_ids);
    const reason = normalizeString(item.reason);
    if (status === "covered" && evidenceIds.length === 0) {
      throw new Error(`Attachment Brief sheet_coverage[${index}] must reference evidence when status is covered.`);
    }
    if (status !== "covered" && !reason) {
      throw new Error(`Attachment Brief sheet_coverage[${index}] must explain a non-covered Sheet.`);
    }
    return {
      sheet_name: sheetName,
      status,
      ...(reason ? { reason } : {}),
      evidence_ids: evidenceIds,
    };
  }) : [];
  const normalized: AppAttachmentBrief = {
    version: 1,
    source_id: input.sourceId,
    filename: input.filename,
    content_strategy: contentStrategy,
    original_reading_method: readingMethod,
    ...(relationshipToTask ? { relationship_to_task: relationshipToTask } : {}),
    ...(useInPpt !== undefined ? { use_in_ppt: useInPpt } : {}),
    ...(imageUsageReason ? { image_usage_reason: imageUsageReason } : {}),
    ...(mainMessage ? { main_message: mainMessage } : {}),
    ...(contentStrategy === "full_context" ? { content: normalizeString(record.content) } : {}),
    key_facts: keyFacts,
    must_include: mustInclude,
    must_avoid: normalizeStringArray(record.must_avoid),
    recommended_storyline: normalizeStringArray(record.recommended_storyline),
    gaps: normalizeStringArray(record.gaps),
    unread_content: normalizeStringArray(record.unread_content),
    ...(sheetCoverage.length > 0 ? { sheet_coverage: sheetCoverage } : {}),
    updated_at: new Date().toISOString(),
  };
  if (contentStrategy === "full_context" && readingMethod !== "image_multimodal_read" && !normalized.content) {
    throw new Error("Full-context Attachment Brief must preserve the complete extracted content.");
  }
  return normalized;
}

async function requireActiveUploadedSource(workspaceDir: string, sourceId: string) {
  const index = await readUploadedSourceIndex(workspaceDir);
  const material = index.materials.find((item) => item.uploaded_source_id === sourceId && item.status === "active");
  if (!material) throw new Error(`Active Uploaded Source Material not found: ${sourceId}`);
  return material;
}

async function synchronizePreflightRouting(input: {
  workspaceDir: string;
  sourceId: string;
  brief: AppAttachmentBrief;
}) {
  const paths = buildUploadedSourcePreflightPaths(input.workspaceDir, input.sourceId);
  const raw = await readJsonFileIfExists(paths.result_path);
  if (!raw) return;
  const result = raw as AppUploadedSourcePreflightResult;
  result.content_strategy = input.brief.content_strategy;
  result.original_reading_method = input.brief.original_reading_method;
  await writeJsonFile(paths.result_path, result);
}

export async function prepareAppAttachmentBrief(input: PrepareAppAttachmentBriefInput): Promise<AppAttachmentBriefPaths> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  await requireActiveUploadedSource(workspace.workspace_dir, input.uploaded_source_id);
  const paths = buildAttachmentBriefPaths(workspace.workspace_dir, input.uploaded_source_id);
  await mkdir(paths.analysis_dir, { recursive: true });
  return paths;
}

export async function getAppAttachmentBriefDraft(input: GetAppAttachmentBriefDraftInput): Promise<unknown | null> {
  const paths = await prepareAppAttachmentBrief(input);
  return readJsonFileIfExists(paths.draft_path);
}

export async function recordAppAttachmentBrief(input: RecordAppAttachmentBriefInput): Promise<AppAttachmentBrief> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const material = await requireActiveUploadedSource(workspace.workspace_dir, input.uploaded_source_id);
  const paths = await prepareAppAttachmentBrief(input);
  const brief = normalizeAttachmentBrief(input.brief, {
    sourceId: material.uploaded_source_id,
    filename: material.original_filename,
  });
  await writeJsonFile(paths.json_path, brief);
  if (brief.original_reading_method === "image_multimodal_read" && brief.use_in_ppt === false) {
    await withUploadedSourceWriteQueue(workspace.workspace_dir, async () => {
      const catalogPath = buildUploadedSourcePaths(workspace.workspace_dir).asset_catalog_path;
      const raw = await readJsonFileIfExists(catalogPath);
      if (!raw) return;
      const catalog = normalizeImageCatalog(raw);
      const assets = (catalog.assets as Record<string, unknown>[]).filter(
        (asset) => asset.source_url !== `uploaded-source://${material.uploaded_source_id}`,
      );
      // 只取消后续生成的素材资格，保留成稿可能仍在引用的图片文件。
      await atomicWriteJsonFile(catalogPath, { ...catalog, assets });
    });
  }
  // attachment-brief.md was an implementation-only duplicate. Remove any
  // legacy copy when this source is reprocessed; JSON is the sole Brief form.
  await unlink(path.join(paths.analysis_dir, "attachment-brief.md")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await synchronizePreflightRouting({
    workspaceDir: workspace.workspace_dir,
    sourceId: material.uploaded_source_id,
    brief,
  });
  // Brief and routed preflight metadata are persisted together before they can
  // make a snapshot pending.
  await markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
  return brief;
}

export async function getAppAttachmentBrief(input: GetAppAttachmentBriefInput): Promise<AppAttachmentBrief | null> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const material = await requireActiveUploadedSource(workspace.workspace_dir, input.uploaded_source_id);
  const paths = buildAttachmentBriefPaths(workspace.workspace_dir, material.uploaded_source_id);
  const raw = await readJsonFileIfExists(paths.json_path);
  return raw ? normalizeAttachmentBrief(raw, { sourceId: material.uploaded_source_id, filename: material.original_filename }) : null;
}

export async function listAppAttachmentBriefs(input: ListAppAttachmentBriefsInput): Promise<ListAppAttachmentBriefsResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const index = await readUploadedSourceIndex(workspace.workspace_dir);
  const briefs = (await Promise.all(index.materials.filter((item) => item.status === "active").map((material) =>
    getAppAttachmentBrief({ workspace_dir: workspace.workspace_dir, uploaded_source_id: material.uploaded_source_id }),
  ))).filter((brief): brief is AppAttachmentBrief => brief !== null);
  return { workspace_dir: workspace.workspace_dir, briefs };
}

function normalizeAttachmentContext(value: unknown): AppAttachmentContext {
  const record = getPlainRecord(value);
  if (record.version !== 1) throw new Error("Attachment context must have version 1.");
  if (typeof record.user_brief !== "string") throw new Error("Attachment context must preserve user_brief as a string.");
  if (!Array.isArray(record.attachment_context)) throw new Error("Attachment context must contain an attachment_context array.");
  const attachmentContext = record.attachment_context.map((entry, index) => {
    const brief = getPlainRecord(entry);
    const sourceId = normalizeString(brief.source_id);
    const filename = normalizeString(brief.filename);
    if (!sourceId || !filename) throw new Error(`attachment_context[${index}] is missing source_id or filename.`);
    return normalizeAttachmentBrief(brief, { sourceId, filename });
  });
  return {
    version: 1,
    user_brief: record.user_brief,
    attachment_context: attachmentContext,
    updated_at: normalizeString(record.updated_at) || new Date().toISOString(),
  };
}

/**
 * Persist the exact structural input for downstream requirement/outline work.
 * Briefs are read from their per-source JSON records so this artifact cannot
 * drift from the validated Attachment Briefs produced for the current run.
 */
export async function writeAppAttachmentContext(input: WriteAppAttachmentContextInput): Promise<AppAttachmentContext> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  if (typeof input.user_brief !== "string") throw new Error("user_brief must be a string.");
  const listed = await listAppAttachmentBriefs({ workspace_dir: workspace.workspace_dir });
  const context: AppAttachmentContext = {
    version: 1,
    user_brief: input.user_brief,
    attachment_context: listed.briefs,
    updated_at: new Date().toISOString(),
  };
  await writeJsonFile(buildUploadedSourcePaths(workspace.workspace_dir).attachment_context_path, context);
  await markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
  return context;
}

export async function getAppAttachmentContext(input: GetAppAttachmentContextInput): Promise<AppAttachmentContext | null> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const raw = await readJsonFileIfExists(buildUploadedSourcePaths(workspace.workspace_dir).attachment_context_path);
  return raw ? normalizeAttachmentContext(raw) : null;
}


export async function removeAppUploadedSource(
  input: RemoveAppUploadedSourceInput,
): Promise<RemoveAppUploadedSourceResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  return withUploadedSourceWriteQueue(workspace.workspace_dir, async () => {
    const index = await readUploadedSourceIndex(workspace.workspace_dir);
    const updatedAt = new Date().toISOString();
    let removedMaterial: AppUploadedSourceMaterial | null = null;
    const materials = index.materials.map((item) => {
      if (item.uploaded_source_id !== input.uploaded_source_id) return item;
      removedMaterial = {
        ...item,
        status: "removed",
        updated_at: updatedAt,
        removed_at: updatedAt,
      };
      return removedMaterial;
    });
    if (!removedMaterial) {
      throw new Error(`Uploaded Source Material not found: ${input.uploaded_source_id}`);
    }
    const activeTotalSize = materials
      .filter((item) => item.status === "active")
      .reduce((sum, item) => sum + item.size_bytes, 0);
    const nextIndex = await writeUploadedSourceIndex(workspace.workspace_dir, {
      version: 1,
      workspace_dir: workspace.workspace_dir,
      active_total_size_bytes: activeTotalSize,
      materials,
      updated_at: updatedAt,
    });
    await touchWorkspaceTask(workspace, updatedAt);
    await markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
    return {
      workspace_dir: workspace.workspace_dir,
      material: removedMaterial,
      index: nextIndex,
    };
  });
}

export async function ignoreAppUploadedSource(
  input: IgnoreAppUploadedSourceInput,
): Promise<IgnoreAppUploadedSourceResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  return withUploadedSourceWriteQueue(workspace.workspace_dir, async () => {
    const index = await readUploadedSourceIndex(workspace.workspace_dir);
    const updatedAt = new Date().toISOString();
    let ignoredMaterial: AppUploadedSourceMaterial | null = null;
    const materials = index.materials.map((item) => {
      if (item.uploaded_source_id !== input.uploaded_source_id) return item;
      ignoredMaterial = {
        ...item,
        status: "ignored",
        updated_at: updatedAt,
        ignored_at: updatedAt,
        ignored_reason: normalizeString(input.reason) || "Attachment processing failed; user chose to ignore it for this generation.",
      };
      return ignoredMaterial;
    });
    if (!ignoredMaterial) throw new Error(`Uploaded Source Material not found: ${input.uploaded_source_id}`);
    const nextIndex = await writeUploadedSourceIndex(workspace.workspace_dir, {
      version: 1,
      workspace_dir: workspace.workspace_dir,
      active_total_size_bytes: materials.filter((item) => item.status === "active").reduce((sum, item) => sum + item.size_bytes, 0),
      materials,
      updated_at: updatedAt,
    });
    await touchWorkspaceTask(workspace, updatedAt);
    await markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
    return { workspace_dir: workspace.workspace_dir, material: ignoredMaterial, index: nextIndex };
  });
}

function normalizeUploadedSourceAnalysisDraftType(value: string): "factual" | "visual" {
  if (value === "factual" || value === "visual") return value;
  throw new Error('"draft_type" must be either "factual" or "visual"');
}

function normalizeUploadedSourceAnalysisDraftId(value: unknown): string | null {
  const draftId = normalizeString(value);
  if (!draftId) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(draftId)) {
    throw new Error('"draft_id" may only contain letters, numbers, underscores, and hyphens');
  }
  return draftId;
}

function buildUploadedSourceAnalysisDraftPath(
  paths: AppUploadedSourceAnalysisPaths,
  draftType: "factual" | "visual",
  draftId?: string | null,
): string {
  if (!draftId) {
    return draftType === "factual" ? paths.factual_draft_path : paths.visual_draft_path;
  }
  return path.join(paths.drafts_dir, `${draftId}-${draftType}.json`);
}

function normalizeUploadedSourceAnalysisArtifact(value: unknown, fallbackStatus: string): Record<string, unknown> {
  const record = getPlainRecord(value);
  return {
    version: typeof record.version === "number" ? record.version : 1,
    status: normalizeString(record.status) || fallbackStatus,
    ...record,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : new Date().toISOString(),
  };
}

async function ensureUploadedSourceAnalysisDirectories(workspaceDir: string): Promise<AppUploadedSourceAnalysisPaths> {
  const paths = buildUploadedSourceAnalysisPaths(workspaceDir);
  await mkdir(paths.drafts_dir, { recursive: true });
  return paths;
}

export async function prepareAppUploadedSourceAnalysisWorkspace(
  input: PrepareAppUploadedSourceAnalysisWorkspaceInput,
): Promise<PrepareAppUploadedSourceAnalysisWorkspaceResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const paths = await ensureUploadedSourceAnalysisDirectories(workspace.workspace_dir);
  const preparedAt = new Date().toISOString();
  await touchWorkspaceTask(workspace, preparedAt);
  await markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
  return {
    workspace_dir: workspace.workspace_dir,
    uploaded_source_index: await readUploadedSourceIndex(workspace.workspace_dir),
    ...paths,
    prepared_at: preparedAt,
  };
}

export async function recordAppUploadedSourceAnalysisDraft(
  input: RecordAppUploadedSourceAnalysisDraftInput,
): Promise<Record<string, unknown>> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const paths = await ensureUploadedSourceAnalysisDirectories(workspace.workspace_dir);
  const draftType = normalizeUploadedSourceAnalysisDraftType(input.draft_type);
  const draftId = normalizeUploadedSourceAnalysisDraftId(input.draft_id);
  const draftPath = buildUploadedSourceAnalysisDraftPath(paths, draftType, draftId);
  assertPathUnderWorkspace(workspace.workspace_dir, draftPath, "draft_path");
  const updatedAt = new Date().toISOString();
  const next = {
    ...normalizeUploadedSourceAnalysisArtifact(input.draft, "draft"),
    draft_type: draftType,
    ...(draftId ? { draft_id: draftId } : {}),
    draft_path: draftPath,
    updated_at: updatedAt,
  };
  await writeJsonFile(draftPath, next);
  await touchWorkspaceTask(workspace, updatedAt);
  await markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
  return next;
}

export async function getAppUploadedSourceAnalysisDraft(
  input: GetAppUploadedSourceAnalysisDraftInput,
): Promise<Record<string, unknown>> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const paths = await ensureUploadedSourceAnalysisDirectories(workspace.workspace_dir);
  const draftType = normalizeUploadedSourceAnalysisDraftType(input.draft_type);
  const draftId = normalizeUploadedSourceAnalysisDraftId(input.draft_id);
  const draftPath = buildUploadedSourceAnalysisDraftPath(paths, draftType, draftId);
  assertPathUnderWorkspace(workspace.workspace_dir, draftPath, "draft_path");
  const existing = await readJsonFileIfExists(draftPath);
  if (existing === null) {
    return {
      version: 1,
      status: "empty",
      draft_type: draftType,
      ...(draftId ? { draft_id: draftId } : {}),
      draft_path: draftPath,
      updated_at: new Date().toISOString(),
    };
  }
  return normalizeUploadedSourceAnalysisArtifact(existing, "empty");
}

export async function getAppUploadedSourceAnalysisDraftFingerprint(
  input: GetAppUploadedSourceAnalysisDraftFingerprintInput,
): Promise<AppUploadedSourceAnalysisDraftFingerprint> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const paths = await ensureUploadedSourceAnalysisDirectories(workspace.workspace_dir);
  const draftType = normalizeUploadedSourceAnalysisDraftType(input.draft_type);
  const draftId = normalizeUploadedSourceAnalysisDraftId(input.draft_id);
  const draftPath = buildUploadedSourceAnalysisDraftPath(paths, draftType, draftId);
  assertPathUnderWorkspace(workspace.workspace_dir, draftPath, "draft_path");
  try {
    const fingerprint = await fingerprintFile(draftPath);
    return {
      workspace_dir: workspace.workspace_dir,
      draft_type: draftType,
      ...(draftId ? { draft_id: draftId } : {}),
      draft_path: draftPath,
      exists: true,
      sha256: fingerprint.sha256,
      size_bytes: fingerprint.size_bytes,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        workspace_dir: workspace.workspace_dir,
        draft_type: draftType,
        ...(draftId ? { draft_id: draftId } : {}),
        draft_path: draftPath,
        exists: false,
      };
    }
    throw error;
  }
}

export async function recordAppUploadedSourceAnalysis(
  input: RecordAppUploadedSourceAnalysisInput,
): Promise<Record<string, unknown>> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const paths = await ensureUploadedSourceAnalysisDirectories(workspace.workspace_dir);
  const updatedAt = new Date().toISOString();
  const next = {
    ...normalizeUploadedSourceAnalysisArtifact(input.analysis, "ready"),
    analysis_path: paths.analysis_path,
    analysis_md_path: paths.analysis_md_path,
    updated_at: updatedAt,
  };
  await writeJsonFile(paths.analysis_path, next);
  // Persist the internal-only Markdown digest alongside the JSON so downstream
  // flows can read one Markdown file. Absent/empty markdown clears any stale md.
  const analysisMarkdown = typeof input.analysis_markdown === "string" ? input.analysis_markdown : "";
  await atomicWriteTextFile(paths.analysis_md_path, analysisMarkdown);
  await touchWorkspaceTask(workspace, updatedAt);
  await markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
  return next;
}

export async function getAppUploadedSourceAnalysis(
  input: GetAppUploadedSourceAnalysisInput,
): Promise<Record<string, unknown>> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const paths = await ensureUploadedSourceAnalysisDirectories(workspace.workspace_dir);
  const existing = await readJsonFileIfExists(paths.analysis_path);
  if (existing === null) {
    return {
      version: 1,
      status: "empty",
      analysis_path: paths.analysis_path,
      updated_at: new Date().toISOString(),
    };
  }
  return normalizeUploadedSourceAnalysisArtifact(existing, "empty");
}

function readPageIdFromManifestSlide(value: unknown): string {
  return normalizeString(getPlainRecord(value).id);
}

function writeIndexToRecord(record: Record<string, unknown>, index: number): Record<string, unknown> {
  return {
    ...record,
    index,
  };
}

export async function getAppWorkspaceOutline(
  input: GetAppWorkspaceOutlineInput,
): Promise<AppWorkspaceOutline> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  return normalizeOutlineJson(workspace.outline);
}

export async function getAppWorkspaceRequirements(
  input: GetAppWorkspaceRequirementsInput,
): Promise<AppPresentationRequirements> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  return normalizePresentationRequirements(workspace.requirements);
}

async function assertWorkspacePageSizeChangeAllowed(workspace: Awaited<ReturnType<typeof ensureWorkspaceFiles>>, requirements: AppPresentationRequirements) {
  const currentRequirements = normalizePresentationRequirements(workspace.requirements);
  if (normalizeSlideAspectRatio(currentRequirements.selections.aspect_ratio) !== normalizeSlideAspectRatio(requirements.selections.aspect_ratio)) {
    const pages = await readdir(path.join(workspace.workspace_dir, "slides")).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (pages.some((name) => name.endsWith(".html"))) throw new Error("Page size is fixed after generation. Create a new presentation to choose another size.");
  }
}

export async function updateAppWorkspaceRequirements(
  input: UpdateAppWorkspaceRequirementsInput,
): Promise<AppWorkspaceResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const currentRequirements = normalizePresentationRequirements(workspace.requirements);
  const requirements = normalizePresentationRequirements(input.requirements);
  await assertWorkspacePageSizeChangeAllowed(workspace, requirements);
  if (normalizeSlideAspectRatio(currentRequirements.selections.aspect_ratio) !== normalizeSlideAspectRatio(requirements.selections.aspect_ratio)) {
    await rm(workspace.files.visual_master, { force: true });
  }
  const updatedAt = new Date().toISOString();
  const nextRequirements: AppPresentationRequirements = {
    ...requirements,
    updated_at: updatedAt,
    confirmed_at: requirements.status === "confirmed" ? updatedAt : null,
  };
  if (nextRequirements.status === "confirmed" && getSelectedVisualPresetSignature(currentRequirements) !== getSelectedVisualPresetSignature(nextRequirements)) {
    await rm(workspace.files.visual_master, { force: true });
    await writeJsonFile(
      workspace.files.aesthetic_reference_selections,
      createDefaultAestheticReferenceSelections(),
    );
  }
  await writeJsonFile(workspace.files.requirements, nextRequirements);
  await touchWorkspaceTask(workspace, updatedAt);
  await markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
  return ensureWorkspaceFiles(input.workspace_dir);
}

function normalizeTemplateReferenceSnapshot(value: unknown): AppTemplateReferenceSnapshot {
  const record = getPlainRecord(value);
  const visualMasterHtml = normalizeString(record.visual_master_html).trim();
  if (visualMasterHtml) validateTemplateHtml(visualMasterHtml);
  const presetRecord = getPlainRecord(record.preset);
  const preset = {
    id: normalizeString(presetRecord.id).trim(),
    version: Number(presetRecord.version),
    name: normalizeString(presetRecord.name).trim(),
    description: normalizeString(presetRecord.description).trim(),
  };
  if (!preset.id || !Number.isInteger(preset.version) || preset.version < 1 || !preset.name || !preset.description) {
    throw new Error("Template reference snapshot has an invalid preset identity");
  }
  if (!Array.isArray(record.reference_html_pages) || record.reference_html_pages.length === 0) {
    throw new Error("Template reference snapshot must contain reference_html_pages");
  }
  const seen = new Set<string>();
  const referenceHtmlPages = record.reference_html_pages.map((item) => {
    const page = getPlainRecord(item);
    const pagePath = normalizeString(page.path).trim().replaceAll("\\", "/");
    const description = normalizeString(page.description).trim();
    const html = normalizeString(page.html).trim();
    if (!/^html\/[A-Za-z0-9._-]+\.html$/i.test(pagePath) || seen.has(pagePath)) {
      throw new Error(`Invalid or duplicate template reference HTML path: ${pagePath || "(empty)"}`);
    }
    if (!description || !html) {
      throw new Error(`Template reference HTML page is incomplete: ${pagePath}`);
    }
    seen.add(pagePath);
    return { path: pagePath, description, html };
  });
  return {
    version: 1,
    preset,
    reference_html_pages: referenceHtmlPages,
    ...(visualMasterHtml ? { visual_master_html: visualMasterHtml } : {}),
  };
}

function normalizeTemplateReferenceCatalog(value: unknown): AppTemplateReferenceCatalog {
  const record = getPlainRecord(value);
  const presetRecord = getPlainRecord(record.preset);
  const preset = {
    id: normalizeString(presetRecord.id).trim(),
    version: Number(presetRecord.version),
    name: normalizeString(presetRecord.name).trim(),
    description: normalizeString(presetRecord.description).trim(),
  };
  if (!preset.id || !Number.isInteger(preset.version) || preset.version < 1 || !preset.name || !preset.description) {
    throw new Error("Template reference catalog has an invalid preset identity");
  }
  if (!Array.isArray(record.reference_html_pages) || record.reference_html_pages.length === 0) {
    throw new Error("Template reference catalog must contain reference_html_pages");
  }
  const seen = new Set<string>();
  const referenceHtmlPages = record.reference_html_pages.map((item) => {
    const page = getPlainRecord(item);
    const pagePath = normalizeString(page.path).trim().replaceAll("\\", "/");
    const description = normalizeString(page.description).trim();
    if (!/^html\/[A-Za-z0-9._-]+\.html$/i.test(pagePath) || seen.has(pagePath)) {
      throw new Error(`Invalid or duplicate template reference HTML path: ${pagePath || "(empty)"}`);
    }
    if (!description) {
      throw new Error(`Template reference HTML page is incomplete: ${pagePath}`);
    }
    seen.add(pagePath);
    return { path: pagePath, description };
  });
  return {
    version: 1,
    preset,
    reference_html_pages: referenceHtmlPages,
  };
}

function templateReferenceCatalogFromSnapshot(
  snapshot: AppTemplateReferenceSnapshot,
): AppTemplateReferenceCatalog {
  return {
    version: 1,
    preset: snapshot.preset,
    reference_html_pages: snapshot.reference_html_pages.map(({ path: pagePath, description }) => ({
      path: pagePath,
      description,
    })),
  };
}

async function writeTemplateReferenceSnapshot(
  workspace: AppWorkspaceResult,
  stagingPath: string,
  expectedSizeBytes: number,
  expectedPreset: { id: string; version: number },
): Promise<AppTemplateReferenceSnapshot> {
  const bytes = await readFile(stagingPath);
  if (bytes.byteLength !== expectedSizeBytes) {
    throw new Error("Template reference snapshot staging file size mismatch");
  }
  const snapshot = normalizeTemplateReferenceSnapshot(JSON.parse(bytes.toString("utf8")) as unknown);
  if (snapshot.preset.id !== expectedPreset.id || snapshot.preset.version !== expectedPreset.version) {
    throw new Error("Template reference snapshot does not match the selected Visual Style Preset");
  }
  const nextDir = `${workspace.files.template_reference}.next-${randomUUID()}`;
  await mkdir(path.join(nextDir, "html"), { recursive: true });
  try {
    await writeJsonFile(path.join(nextDir, "preset.json"), {
      ...snapshot.preset,
      reference_html_pages: snapshot.reference_html_pages.map(({ path: pagePath, description }) => ({
        path: pagePath,
        description,
      })),
    });
    for (const page of snapshot.reference_html_pages) {
      await writeFile(path.join(nextDir, page.path), page.html, "utf8");
    }
    await rm(workspace.files.template_reference, { recursive: true, force: true });
    await rename(nextDir, workspace.files.template_reference);
  } catch (error) {
    await rm(nextDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return snapshot;
}

export async function listAppWorkspaceTemplateReferences(input: {
  workspace_dir: string;
}): Promise<AppTemplateReferenceCatalog> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const presetPath = path.join(workspace.files.template_reference, "preset.json");
  const presetRecord = getPlainRecord(await readJsonFileIfExists(presetPath));
  return normalizeTemplateReferenceCatalog({
    version: 1,
    preset: presetRecord,
    reference_html_pages: presetRecord.reference_html_pages,
  });
}

export async function getAppWorkspaceTemplateReferenceHtml(input: {
  workspace_dir: string;
  path: string;
}): Promise<AppTemplateReferenceHtmlPage> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const catalog = await listAppWorkspaceTemplateReferences({ workspace_dir: workspace.workspace_dir });
  const reference = catalog.reference_html_pages.find((page) => page.path === input.path);
  if (!reference) {
    throw new Error(`Unknown template reference HTML path: ${input.path}`);
  }
  return {
    ...reference,
    html: await readFile(path.join(workspace.files.template_reference, reference.path), "utf8"),
  };
}

export async function confirmAppWorkspaceRequirements(
  input: ConfirmAppWorkspaceRequirementsInput,
): Promise<ConfirmAppWorkspaceRequirementsResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const requirements = normalizePresentationRequirements(input.requirements);
  if (requirements.status !== "confirmed") {
    throw new Error("Confirmed Presentation Requirements are required");
  }
  if (!requirements.selections.visual_style_preset) {
    throw new Error("Confirmed Presentation Requirements must select a Visual Style Preset");
  }
  if (!input.template_reference_staging_file_path) {
    throw new Error("A template reference snapshot staging file is required");
  }
  await assertWorkspacePageSizeChangeAllowed(workspace, requirements);
  const templateReference = await writeTemplateReferenceSnapshot(
    workspace,
    input.template_reference_staging_file_path,
    Math.floor(input.template_reference_expected_size_bytes ?? 0),
    requirements.selections.visual_style_preset,
  );

  const updatedAt = new Date().toISOString();
  await writeJsonFile(workspace.files.requirements, {
    ...requirements,
    updated_at: updatedAt,
    confirmed_at: updatedAt,
  });
  await resetAppWorkspaceOutline({ workspace_dir: workspace.workspace_dir });
  await writeJsonFile(
    workspace.files.aesthetic_reference_selections,
    createDefaultAestheticReferenceSelections(),
  );
  if (templateReference.visual_master_html && slideFormatFromHtml(templateReference.visual_master_html).aspectRatio === normalizeSlideAspectRatio(requirements.selections.aspect_ratio)) {
    await writeFile(workspace.files.visual_master, templateReference.visual_master_html, "utf8");
  } else {
    await rm(workspace.files.visual_master, { force: true });
  }
  await rm(path.join(workspace.workspace_dir, "research"), { recursive: true, force: true });
  await touchWorkspaceTask(workspace, updatedAt);
  await markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
  return {
    workspace: await ensureWorkspaceFiles(workspace.workspace_dir),
    template_reference: templateReferenceCatalogFromSnapshot(templateReference),
  };
}

export async function appendAppWorkspaceLog(
  input: AppendAppWorkspaceLogInput,
): Promise<AppendAppWorkspaceLogResult> {
  if (input.channel === "preview-recovery") {
    const workspace = await ensureWorkspaceFiles(input.workspace_dir);
    return appendPreviewRecoveryLog(workspace.workspace_dir, input.entry);
  }
  if (!isDiagnosticLoggingEnabled()) {
    return { workspace_dir: input.workspace_dir, log_file: "", appended: false };
  }
  const requestedWorkspaceDir = normalizeWorkspaceDir(input.workspace_dir);
  const generationRun = await findGenerationRunForWorkspace(
    WORKSPACE_ROOT,
    path.basename(requestedWorkspaceDir),
  );
  const logWorkspaceDir = generationRun?.shadow_workspace_dir === requestedWorkspaceDir
    ? generationRun.official_workspace_dir
    : requestedWorkspaceDir;
  const workspace = await ensureWorkspaceFiles(logWorkspaceDir);
  const logFileName = WORKSPACE_LOG_FILE_NAMES[input.channel];
  if (!logFileName) {
    throw new Error('"channel" must be a supported workspace log channel');
  }

  return withGenerationWorkspaceLock(workspace.workspace_dir, () => appendDirectoryDiagnosticLog({
    directory: workspace.workspace_dir,
    channel: input.channel,
    entry: input.entry,
    payload_keys: input.payload_keys,
    inline_payload_max_bytes: input.inline_payload_max_bytes,
  }));
}

export async function writeAppResearchTestFile(
  input: WriteAppResearchTestFileInput,
): Promise<WriteAppResearchTestFileResult> {
  if (!RESEARCH_TEST_RUN_ID_PATTERN.test(input.run_id)) {
    throw new Error('"run_id" must contain only letters, numbers, underscores, or hyphens');
  }
  if (!RESEARCH_TEST_FILE_NAMES.has(input.file_name)) {
    throw new Error('"file_name" must be one of: input.json, rounds.jsonl, result.md, meta.json');
  }
  if (typeof input.content !== "string") {
    throw new Error('"content" must be a string');
  }

  const runDir = path.join(RESEARCH_TEST_ROOT, input.run_id);
  const filePath = path.join(runDir, input.file_name);
  await mkdir(runDir, { recursive: true });
  if (input.append) {
    await appendFile(filePath, input.content, "utf8");
  } else {
    await writeFile(filePath, input.content, "utf8");
  }

  return {
    run_id: input.run_id,
    run_dir: runDir,
    file_path: filePath,
    written: true,
  };
}

async function ensureResearchDirectories(workspaceDir: string): Promise<AppResearchPaths> {
  const paths = buildResearchPaths(workspaceDir);
  await mkdir(paths.evidence_images_dir, { recursive: true });
  return paths;
}

function createDefaultImageCatalog() {
  return { schema_version: 2, assets: [] };
}

function normalizeImageDimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveImageAspectRatio(width: unknown, height: unknown, explicit: unknown): number | null {
  const normalizedWidth = normalizeImageDimension(width);
  const normalizedHeight = normalizeImageDimension(height);
  if (normalizedWidth !== undefined && normalizedHeight !== undefined) {
    return Number((normalizedWidth / normalizedHeight).toFixed(6));
  }
  const normalizedExplicit = normalizeImageDimension(explicit);
  return normalizedExplicit === undefined ? null : Number(normalizedExplicit.toFixed(6));
}

function compactImageCatalogAsset(value: unknown): Record<string, unknown> | null {
  const candidate = getPlainRecord(value);
  if (
    (candidate.use_in_ppt !== true && candidate.selected_by_user !== true)
    || candidate.import_status !== "imported"
    || !normalizeString(candidate.candidate_id)
    || !normalizeString(candidate.file_path)
    || !normalizeString(candidate.sha256)
    || !normalizeString(candidate.mime_type)
    || typeof candidate.bytes_size !== "number"
    || !Number.isFinite(candidate.bytes_size)
    || candidate.bytes_size <= 0
  ) return null;
  const query = normalizeString(candidate.query);
  const matchedQueries = normalizeStringArray(candidate.matched_queries);
  const width = normalizeImageDimension(candidate.width);
  const height = normalizeImageDimension(candidate.height);
  return {
    asset_id: normalizeString(candidate.candidate_id),
    file_path: normalizeString(candidate.file_path),
    sha256: normalizeString(candidate.sha256),
    mime_type: normalizeString(candidate.mime_type),
    bytes_size: candidate.bytes_size,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    aspect_ratio: resolveImageAspectRatio(width, height, candidate.aspect_ratio),
    description: candidate.selected_by_user === true && candidate.use_in_ppt !== true ? "" : normalizeString(candidate.description),
    recommended: candidate.use_in_ppt === true,
    recommendation: ["recommended", "not_recommended", "not_analysed"].includes(String(candidate.recommendation))
      ? candidate.recommendation : candidate.use_in_ppt === true ? "recommended" : "not_analysed",
    reason: normalizeString(candidate.reason),
    matched_queries: matchedQueries.length > 0 ? matchedQueries : query ? [query] : [],
    source_url: normalizeString(candidate.source_url),
    ...(normalizeString(candidate.title) ? { title: normalizeString(candidate.title) } : {}),
    ...(normalizeString(candidate.source_filename) ? { source_filename: normalizeString(candidate.source_filename) } : {}),
  };
}

function normalizeImageCatalogAsset(value: unknown): Record<string, unknown> | null {
  const asset = getPlainRecord(value);
  if (
    !normalizeString(asset.asset_id)
    || !normalizeString(asset.file_path)
    || !normalizeString(asset.sha256)
    || !normalizeString(asset.mime_type)
    || typeof asset.bytes_size !== "number"
    || !Number.isFinite(asset.bytes_size)
    || asset.bytes_size <= 0
  ) return null;
  const width = normalizeImageDimension(asset.width);
  const height = normalizeImageDimension(asset.height);
  return {
    asset_id: normalizeString(asset.asset_id),
    file_path: normalizeString(asset.file_path),
    sha256: normalizeString(asset.sha256),
    mime_type: normalizeString(asset.mime_type),
    bytes_size: asset.bytes_size,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    aspect_ratio: resolveImageAspectRatio(width, height, asset.aspect_ratio),
    description: normalizeString(asset.description),
    ...(typeof asset.recommended === "boolean" ? { recommended: asset.recommended } : {}),
    ...(["recommended", "not_recommended", "not_analysed"].includes(String(asset.recommendation)) ? { recommendation: asset.recommendation } : {}),
    reason: normalizeString(asset.reason),
    matched_queries: normalizeStringArray(asset.matched_queries),
    source_url: normalizeString(asset.source_url),
    ...(normalizeString(asset.title) ? { title: normalizeString(asset.title) } : {}),
    ...(normalizeString(asset.source_filename) ? { source_filename: normalizeString(asset.source_filename) } : {}),
  };
}

function deduplicateImageCatalogAssets(assets: Record<string, unknown>[]) {
  const bySha256 = new Map<string, Record<string, unknown>>();
  for (const asset of assets) {
    const sha256 = normalizeString(asset.sha256);
    const previous = bySha256.get(sha256);
    if (!previous) {
      bySha256.set(sha256, asset);
      continue;
    }
    bySha256.set(sha256, {
      ...previous,
      ...asset,
      asset_id: previous.asset_id,
      description: normalizeString(previous.description) || normalizeString(asset.description),
      matched_queries: [...new Set([
        ...normalizeStringArray(previous.matched_queries),
        ...normalizeStringArray(asset.matched_queries),
      ])],
    });
  }
  return [...bySha256.values()];
}

function normalizeImageCatalog(value: unknown): Record<string, unknown> {
  const record = getPlainRecord(value);
  if (Object.keys(record).length === 0) return createDefaultImageCatalog();
  if (record.schema_version === 2 && Array.isArray(record.assets)) {
    return {
      schema_version: 2,
      assets: deduplicateImageCatalogAssets(record.assets.map(normalizeImageCatalogAsset).filter((asset): asset is Record<string, unknown> => asset !== null)),
    };
  }
  throw new Error("Invalid research/evidence/image-catalog.json");
}

async function ensureSharedResearchFiles(workspaceDir: string, resetProgress: boolean): Promise<AppResearchPaths> {
  const paths = await ensureResearchDirectories(workspaceDir);
  await mkdir(paths.images_dir, { recursive: true });
  if (!(await fileExists(paths.web_summary_path))) {
    await atomicWriteTextFile(paths.web_summary_path, "# Web Research Summary\n");
  }
  if (!(await fileExists(paths.image_catalog_path))) {
    await atomicWriteJsonFile(paths.image_catalog_path, createDefaultImageCatalog());
  } else {
    const currentCatalog = await readJsonFileIfExists(paths.image_catalog_path);
    const normalizedCatalog = normalizeImageCatalog(currentCatalog);
    if (JSON.stringify(currentCatalog) !== JSON.stringify(normalizedCatalog)) {
      await atomicWriteJsonFile(paths.image_catalog_path, normalizedCatalog);
    }
  }
  if (resetProgress || !(await fileExists(paths.progress_path))) {
    await atomicWriteJsonFile(paths.progress_path, createDefaultSharedResearchProgress());
  }
  return paths;
}

async function readActiveUploadedImageCatalog(workspaceDir: string): Promise<Record<string, unknown>> {
  const catalog = normalizeImageCatalog(await readJsonFileIfExists(buildUploadedSourcePaths(workspaceDir).asset_catalog_path));
  const index = await readUploadedSourceIndex(workspaceDir);
  const activeSources = new Set(index.materials.filter((source) => source.status === "active")
    .map((source) => `uploaded-source://${source.uploaded_source_id}`));
  return { ...catalog, assets: [
    ...(catalog.assets as Record<string, unknown>[]).filter((asset) => activeSources.has(String(asset.source_url))),
    ...await readPageUploadedImages(workspaceDir),
  ] };
}

/** Manual illustrations never enter the source-material index or attachment context. */
export async function appPageImageUpload(input: {
  workspace_dir: string; action: "commit" | "list_pending" | "prepare" | "describe";
  asset_id?: string; description?: string; filename?: string; staging_file_path?: string; expected_size_bytes?: number;
}) {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const dir = workspace.workspace_dir;
  if (input.action === "list_pending") return { images: (await readPageUploadedImages(dir)).filter((image) => !image.description) };
  if (input.action === "prepare") return { images: [await resolvePageUploadedImage(dir, input.asset_id ?? "")] };
  return withUploadedSourceWriteQueue(dir, async () => {
    let image;
    if (input.action === "commit") {
      const context = await getAppSharedResearchContext({ workspace_dir: dir });
      image = await commitPageUploadedImage({ workspace_dir: dir, filename: input.filename ?? "",
        staging_file_path: input.staging_file_path ?? "", expected_size_bytes: input.expected_size_bytes ?? 0,
        existing: [...(getPlainRecord(context.uploaded_asset_catalog).assets as Record<string, unknown>[] ?? []),
          ...(getPlainRecord(context.image_catalog).assets as Record<string, unknown>[] ?? [])] });
    } else if (input.action === "describe") {
      image = await describePageUploadedImage(dir, input.asset_id ?? "", input.description ?? "");
    } else throw new Error("Invalid page image upload action");
    await markImageResearchSnapshotDirty(dir);
    return { images: [image] };
  });
}

export async function getAppSharedResearchContext(
  input: { workspace_dir: string },
): Promise<AppSharedResearchContextResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const paths = await ensureSharedResearchFiles(workspace.workspace_dir, false);
  const uploadedSourcePaths = buildUploadedSourcePaths(workspace.workspace_dir);
  const progress = getPlainRecord(await readJsonFileIfExists(paths.progress_path));
  return {
    workspace_dir: workspace.workspace_dir,
    web_summary_path: paths.web_summary_path,
    image_catalog_path: paths.image_catalog_path,
    images_dir: paths.images_dir,
    progress_path: paths.progress_path,
    web_summary: await readFile(paths.web_summary_path, "utf8"),
    image_catalog: normalizeImageCatalog(await readJsonFileIfExists(paths.image_catalog_path)),
    uploaded_asset_catalog_path: uploadedSourcePaths.asset_catalog_path,
    uploaded_asset_catalog: await readActiveUploadedImageCatalog(workspace.workspace_dir),
    image_candidates: await readImageCandidateReferences(workspace.workspace_dir, progress),
    progress,
  };
}

/** Optional visual descriptions share the catalogs' write queues and never change page selection. */
export async function appOutlineImageDescriptions(input: {
  workspace_dir: string; action: "get_run" | "mark_attempted" | "describe";
  run_key?: string; sha256s?: string[]; asset_id?: string; description?: string;
}) {
  const dir = normalizeWorkspaceDir(input.workspace_dir);
  return withActiveGenerationWorkspace(WORKSPACE_ROOT, dir, async (runId) => {
    if (runId && input.run_key && input.run_key !== runId) throw new Error("Image description run identity mismatch");
    return updateAppOutlineImageDescriptions({ ...input, workspace_dir: dir, run_key: runId ?? input.run_key });
  });
}

async function markImageResearchSnapshotDirty(workspaceDir: string) {
  // Shadow changes become authoritative only when the generation is committed.
  if (path.dirname(workspaceDir) === WORKSPACE_ROOT) await markWorkspaceSnapshotDirty({ workspace_dir: workspaceDir });
}

async function updateAppOutlineImageDescriptions(input: {
  workspace_dir: string; action: "get_run" | "mark_attempted" | "describe";
  run_key?: string; sha256s?: string[]; asset_id?: string; description?: string;
}) {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const dir = workspace.workspace_dir;
  if (input.action === "get_run" || input.action === "mark_attempted") {
    if (!input.run_key || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.run_key)) throw new Error("Invalid image description run key");
    return withSharedResearchWriteQueue(dir, async () => {
      const target = path.join(dir, "research", "image-description-preparation.json");
      const current = getPlainRecord(await readJsonFileIfExists(target));
      const attempted = current.run_key === input.run_key ? normalizeStringArray(current.attempted_sha256) : [];
      if (input.action === "mark_attempted") {
        if (!Array.isArray(input.sha256s) || input.sha256s.length > 6 || input.sha256s.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
          throw new Error("Invalid image description identities");
        }
        attempted.push(...input.sha256s);
        await mkdir(path.dirname(target), { recursive: true });
        await atomicWriteJsonFile(target, { run_key: input.run_key, attempted_sha256: [...new Set(attempted)] });
        await markImageResearchSnapshotDirty(dir);
      }
      return { attempted_sha256: [...new Set(attempted)] };
    });
  }
  if (input.action !== "describe" || !input.description?.trim() || input.description.trim().length > 400) {
    throw new Error("Invalid image description");
  }
  const id = input.asset_id ?? "";
  await resolveAppOutlineImage({ workspace_dir: dir, asset_id: id });
  if ((await readPageUploadedImages(dir)).some((image) => image.asset_id === id)) {
    return withUploadedSourceWriteQueue(dir, async () => {
      const existing = (await readPageUploadedImages(dir)).find((image) => image.asset_id === id);
      if (existing?.description) return { image: existing };
      const image = await describePageUploadedImage(dir, id, input.description!);
      await markImageResearchSnapshotDirty(dir);
      return { image };
    });
  }
  const context = await getAppSharedResearchContext({ workspace_dir: dir });
  const uploaded = (getPlainRecord(context.uploaded_asset_catalog).assets as Record<string, unknown>[]).some((image) => image.asset_id === id);
  const write = uploaded ? withUploadedSourceWriteQueue : withSharedResearchWriteQueue;
  return write(dir, async () => {
    const target = uploaded ? buildUploadedSourcePaths(dir).asset_catalog_path : buildResearchPaths(dir).image_catalog_path;
    const catalog = normalizeImageCatalog(await readJsonFileIfExists(target));
    const image = (catalog.assets as Record<string, unknown>[]).find((image) => image.asset_id === id);
    if (!image) throw new Error("Unknown or inactive image asset");
    if (!normalizeString(image.description)) {
      image.description = input.description!.trim();
      await atomicWriteJsonFile(target, catalog);
      await markImageResearchSnapshotDirty(dir);
    }
    return { image };
  });
}

/** Manual selections may reuse images across pages, but not within a page. */
async function validateOutlineImages(workspaceDir: string, items: AppWorkspaceOutlineItem[]) {
  if (!items.some((item) => item.selected_image_ids?.length)) return;
  const context = await getAppSharedResearchContext({ workspace_dir: workspaceDir });
  const assets = [...getPlainRecord(context.uploaded_asset_catalog).assets as Record<string, unknown>[] ?? [],
    ...getPlainRecord(context.image_catalog).assets as Record<string, unknown>[] ?? []];
  const byId = new Map(assets.map((asset) => [asset.asset_id, asset]));
  for (const item of items) {
    const used = new Set<string>();
    for (const id of item.selected_image_ids ?? []) {
      const asset = byId.get(id);
      if (!asset) throw new Error(`Unknown or unavailable outline image: ${id}`);
      const hash = normalizeString(asset.sha256);
      if (used.has(hash)) throw new Error(`An image may only be used once per page: ${id}`);
      used.add(hash);
    }
  }
}

/** Resolve active originals by identity, including real-path containment for agent uploads. */
export async function resolveAppOutlineImage(input: { workspace_dir: string; asset_id: string }) {
  const context = await getAppSharedResearchContext(input);
  const assets = [...getPlainRecord(context.uploaded_asset_catalog).assets as Record<string, unknown>[] ?? [],
    ...getPlainRecord(context.image_catalog).assets as Record<string, unknown>[] ?? []];
  const asset = assets.find((item) => item.asset_id === input.asset_id);
  if (!asset) throw new Error("Unknown or inactive image asset");
  const [root, source] = await Promise.all([realpath(context.workspace_dir), realpath(normalizeString(asset.file_path))]);
  if (!isPathInsideDir(root, source)) throw new Error("Image must belong to this workspace");
  return { file_path: source, mime_type: normalizeString(asset.mime_type) };
}

/** Bounded thumbnail transport; callers supply an asset id, never an arbitrary file path. */
export async function getAppOutlineImagePreview(input: { workspace_dir: string; asset_id: string; size?: "thumbnail" | "large" }): Promise<{ preview_url: string }> {
  if (input.size !== undefined && input.size !== "thumbnail" && input.size !== "large") throw new Error("Invalid image preview size");
  const { file_path: source } = await resolveAppOutlineImage(input);
  // Keep both preview sizes within the existing bounded inline transport.
  const sizes = input.size === "large" ? [1280, 960, 640, 400] : [400];
  let bytes: Buffer = Buffer.alloc(0);
  for (const width of sizes) {
    bytes = await sharp(source).rotate().resize({ width, height: input.size === "large" ? width : 280, fit: "inside", withoutEnlargement: true }).webp({ quality: 65 }).toBuffer();
    if (bytes.length <= 45000) break;
  }
  if (bytes.length > 45000) throw new Error("Image preview exceeds the inline size limit");
  return { preview_url: `data:image/webp;base64,${bytes.toString("base64")}` };
}

export async function prepareAppSharedResearchWorkspace(
  input: PrepareAppSharedResearchWorkspaceInput,
): Promise<AppSharedResearchContextResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  await ensureSharedResearchFiles(workspace.workspace_dir, input.reset_progress === true);
  return getAppSharedResearchContext({ workspace_dir: workspace.workspace_dir });
}

export async function patchAppSharedResearchProgress(
  input: PatchAppSharedResearchProgressInput,
): Promise<PatchAppSharedResearchProgressResult> {
  const serializedBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  const maxPatchBytes = 48 * 1024;
  if (serializedBytes > maxPatchBytes) throw new Error(`Shared research patch is ${serializedBytes} bytes; maximum is ${maxPatchBytes}`);
  if (!Array.isArray(input.operations) || input.operations.length === 0) throw new Error('"operations" must be a non-empty array');
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const paths = await ensureSharedResearchFiles(workspace.workspace_dir, false);
  return withSharedResearchWriteQueue(workspace.workspace_dir, async () => {
    const current = getPlainRecord(await readJsonFileIfExists(paths.progress_path));
    const result = applySharedResearchProgressOperations(current, input.operations);
    if (result.updated) {
      await atomicWriteJsonFile(paths.progress_path, result.progress);
      await markImageResearchSnapshotDirty(workspace.workspace_dir);
    }
    return {
      workspace_dir: workspace.workspace_dir,
      progress_path: paths.progress_path,
      updated: result.updated,
      revision: result.revision,
      updated_at: result.updated_at,
    };
  });
}

async function markPreparedResearchPublished(
  workspaceDir: string,
  kind: "web" | "image",
): Promise<{ progress: Record<string, unknown>; revision: number }> {
  const paths = await ensureSharedResearchFiles(workspaceDir, false);
  const current = getPlainRecord(await readJsonFileIfExists(paths.progress_path));
  const section = getPlainRecord(current[kind]);
  if (!section.prepared_batch) throw new Error(`Prepared ${kind} research batch is not ready`);
  if (section.written === true) return { progress: current, revision: typeof current.revision === "number" ? current.revision : 0 };
  const next = {
    ...current,
    [kind]: { ...section, written: true },
    revision: (typeof current.revision === "number" ? current.revision : 0) + 1,
    updated_at: new Date().toISOString(),
  };
  await atomicWriteJsonFile(paths.progress_path, next);
  return { progress: next, revision: Number(next.revision) };
}

export async function publishPreparedAppWebResearchBatch(
  input: { workspace_dir: string },
): Promise<PublishAppSharedResearchBatchResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  return withSharedResearchWriteQueue(workspace.workspace_dir, async () => {
    const paths = await ensureSharedResearchFiles(workspace.workspace_dir, false);
    const currentProgress = getPlainRecord(await readJsonFileIfExists(paths.progress_path));
    const block = normalizeString(getPlainRecord(currentProgress.web).prepared_batch).trim();
    if (!block) throw new Error("Prepared web research batch is not ready");
    const current = await readFile(paths.web_summary_path, "utf8");
    const alreadyPublished = current.trimEnd().endsWith(block);
    if (!alreadyPublished) await atomicWriteTextFile(paths.web_summary_path, `${current.trimEnd()}\n\n${block}\n`);
    const marked = await markPreparedResearchPublished(workspace.workspace_dir, "web");
    return {
      workspace_dir: workspace.workspace_dir,
      artifact_path: paths.web_summary_path,
      published: !alreadyPublished,
      already_published: alreadyPublished,
      revision: marked.revision,
    };
  });
}

export async function publishPreparedAppImageResearchBatch(
  input: { workspace_dir: string },
): Promise<PublishAppSharedResearchBatchResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  return withSharedResearchWriteQueue(workspace.workspace_dir, async () => {
    const paths = await ensureSharedResearchFiles(workspace.workspace_dir, false);
    const currentProgress = getPlainRecord(await readJsonFileIfExists(paths.progress_path));
    const batch = getPlainRecord(getPlainRecord(currentProgress.image).prepared_batch);
    if (!normalizeString(batch.title) || !Array.isArray(batch.candidates)) throw new Error("Prepared image research batch is not ready");
    const catalog = normalizeImageCatalog(await readJsonFileIfExists(paths.image_catalog_path));
    const assets = Array.isArray(catalog.assets) ? catalog.assets.map(getPlainRecord) : [];
    const nextAssets = deduplicateImageCatalogAssets([
      ...assets,
      ...batch.candidates.map(compactImageCatalogAsset).filter((asset): asset is Record<string, unknown> => asset !== null),
    ]);
    const alreadyPublished = JSON.stringify(assets) === JSON.stringify(nextAssets);
    if (!alreadyPublished) await atomicWriteJsonFile(paths.image_catalog_path, { schema_version: 2, assets: nextAssets });
    const marked = await markPreparedResearchPublished(workspace.workspace_dir, "image");
    if (!alreadyPublished) await markImageResearchSnapshotDirty(workspace.workspace_dir);
    return {
      workspace_dir: workspace.workspace_dir,
      artifact_path: paths.image_catalog_path,
      published: !alreadyPublished,
      already_published: alreadyPublished,
      revision: marked.revision,
    };
  });
}

export async function appendAppWebResearchBatch(
  input: AppendAppWebResearchBatchInput,
): Promise<{ workspace_dir: string; web_summary_path: string; appended: boolean }> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const paths = await ensureSharedResearchFiles(workspace.workspace_dir, false);
  const block = input.markdown.trim();
  if (!block) throw new Error('"markdown" must be non-empty');
  const current = await readFile(paths.web_summary_path, "utf8");
  if (current.trimEnd().endsWith(block)) {
    return { workspace_dir: workspace.workspace_dir, web_summary_path: paths.web_summary_path, appended: false };
  }
  await atomicWriteTextFile(paths.web_summary_path, `${current.trimEnd()}\n\n${block}\n`);
  return { workspace_dir: workspace.workspace_dir, web_summary_path: paths.web_summary_path, appended: true };
}

export async function appPageImageSearch(input: {
  workspace_dir: string; action: string; target_key?: string; owner?: string; task?: unknown;
}): Promise<Record<string, unknown> | null> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  return withSharedResearchWriteQueue(workspace.workspace_dir, async () => {
    const directory = path.join(workspace.workspace_dir, "research", "page-image-search");
    await mkdir(directory, { recursive: true });
    const leasePath = path.join(directory, "lease.json");
    const lease = getPlainRecord(await readJsonFileIfExists(leasePath));
    const live = typeof lease.expires_at === "number" && lease.expires_at > Date.now();
    if (input.action === "get") {
      const names = await readdir(directory);
      const tasks = await Promise.all(names.filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
        .map((name) => readJsonFileIfExists(path.join(directory, name))));
      const task = tasks.map(getPlainRecord).filter((task) => getPlainRecord(task.context).target_key === input.target_key)
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
      if (!task) return null;
      return task.status === "running" && (!live || lease.task_id !== task.id)
        ? { ...task, status: "failed", error: "PAGE_IMAGE_SEARCH_INTERRUPTED" } : task;
    }
    if (!input.owner || !/^[0-9a-f-]{36}$/.test(input.owner)) throw new Error("Invalid page image search owner");
    if (input.action === "acquire") {
      if (live && lease.owner !== input.owner) throw new Error("PAGE_IMAGE_SEARCH_BUSY");
    } else if (lease.owner !== input.owner || !live) throw new Error("PAGE_IMAGE_SEARCH_LEASE_LOST");
    if (input.action === "release") {
      await atomicWriteJsonFile(leasePath, {});
      return null;
    }
    if (input.action === "heartbeat") {
      await atomicWriteJsonFile(leasePath, { ...lease, expires_at: Date.now() + 120_000 });
      return null;
    }
    if (input.action !== "save" && input.action !== "acquire") throw new Error("Invalid page image search action");
    const task = getPlainRecord(input.task);
    const context = getPlainRecord(task.context);
    const checkpoint = getPlainRecord(task.checkpoint);
    const id = normalizeString(task.id);
    if (!/^[0-9a-f-]{36}$/.test(id) || !normalizeString(context.target_key) || !normalizeString(getPlainRecord(context.page).title)
      || checkpoint.schema_version !== 2 || !Number.isInteger(task.max_searches) || Number(task.max_searches) < 1 || Number(task.max_searches) > 30
      || !["running", "completed", "cancelled", "failed"].includes(String(task.status)) || !Array.isArray(task.result_ids)) {
      throw new Error("Invalid page image search task");
    }
    const taskPath = path.join(directory, `${id}.json`);
    const previous = getPlainRecord(await readJsonFileIfExists(taskPath));
    if (previous.id && (JSON.stringify(previous.context) !== JSON.stringify(context) || previous.max_searches !== task.max_searches)) {
      throw new Error("Page image search context and budget are immutable");
    }
    if (input.action === "save" && lease.task_id !== id) throw new Error("PAGE_IMAGE_SEARCH_LEASE_LOST");
    const saved: Record<string, unknown> = { ...(input.action === "acquire" && previous.id ? previous : task),
      ...(input.action === "acquire" ? { status: "running", error: undefined } : {}), updated_at: new Date().toISOString() };
    // Signed URLs are runtime transport, never workspace-owned candidate metadata.
    if (Array.isArray(saved.results)) saved.results = saved.results.map((value) => ({ ...getPlainRecord(value), get_url: "" }));
    await atomicWriteJsonFile(taskPath, saved);
    await markImageResearchSnapshotDirty(workspace.workspace_dir);
    await atomicWriteJsonFile(leasePath, { owner: input.owner, task_id: id, expires_at: Date.now() + 120_000 });
    return input.action === "acquire" ? saved : null;
  });
}

export async function appendAppImageResearchBatch(
  input: AppendAppImageResearchBatchInput,
): Promise<{ workspace_dir: string; image_catalog_path: string; appended: boolean }> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  return withSharedResearchWriteQueue(workspace.workspace_dir, async () => {
    const paths = await ensureSharedResearchFiles(workspace.workspace_dir, false);
    const catalog = normalizeImageCatalog(await readJsonFileIfExists(paths.image_catalog_path));
    const assets = Array.isArray(catalog.assets) ? catalog.assets.map(getPlainRecord) : [];
    const batch = getPlainRecord(input.batch);
    if (!normalizeString(batch.title) || !Array.isArray(batch.candidates)) {
      throw new Error('"batch" must contain title and candidates');
    }
    const nextAssets = deduplicateImageCatalogAssets([
      ...assets,
      ...batch.candidates.map(compactImageCatalogAsset).filter((asset): asset is Record<string, unknown> => asset !== null),
    ]);
    if (JSON.stringify(assets) === JSON.stringify(nextAssets)) {
      return { workspace_dir: workspace.workspace_dir, image_catalog_path: paths.image_catalog_path, appended: false };
    }
    await atomicWriteJsonFile(paths.image_catalog_path, {
      schema_version: 2,
      assets: nextAssets,
    });
    await markImageResearchSnapshotDirty(workspace.workspace_dir);
    return { workspace_dir: workspace.workspace_dir, image_catalog_path: paths.image_catalog_path, appended: true };
  });
}

const SHARED_RESEARCH_IMAGE_EXTENSIONS = IMAGE_ASSET_EXTENSIONS;

export async function importAppSharedResearchImage(
  input: ImportAppSharedResearchImageInput,
): Promise<ImportAppSharedResearchImageResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const paths = await ensureSharedResearchFiles(workspace.workspace_dir, false);
  assertAbsolutePath(input.staging_file_path, "staging_file_path");
  const extension = SHARED_RESEARCH_IMAGE_EXTENSIONS[input.mime_type];
  if (!extension) throw new Error(`Unsupported research image MIME type: ${input.mime_type}`);
  const bytes = await readFile(input.staging_file_path);
  if (bytes.length !== Math.floor(input.expected_size_bytes)) {
    throw new Error(`Research image size mismatch: expected ${Math.floor(input.expected_size_bytes)}, got ${bytes.length}`);
  }
  const sha256 = sha256BufferHex(bytes);
  if (input.expected_sha256 && input.expected_sha256 !== sha256) {
    throw new Error("Research image SHA-256 mismatch");
  }
  const metadata = await sharp(bytes).metadata();
  const width = normalizeImageDimension(metadata.width) ?? null;
  const height = normalizeImageDimension(metadata.height) ?? null;
  const destinationPath = await writeImageAssetFile({ directory: paths.images_dir, bytes, sha256, mimeType: input.mime_type });
  return {
    workspace_dir: workspace.workspace_dir,
    candidate_id: input.candidate_id,
    file_path: destinationPath,
    sha256,
    mime_type: input.mime_type,
    bytes_size: bytes.length,
    width,
    height,
  };
}

function uploadedSourceImageMimeType(material: AppUploadedSourceMaterial): string {
  if (SHARED_RESEARCH_IMAGE_EXTENSIONS[material.mime_type]) return material.mime_type;
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
  }[material.extension.toLowerCase()] ?? "";
}

/**
 * Promote an uploaded image through Engine-owned staging. The public research
 * import endpoint deliberately rejects arbitrary local paths, so callers pass
 * an uploaded_source_id rather than trying to reuse uploaded-sources/files.
 */
export async function importAppUploadedSourceImageToResearch(
  input: ImportAppUploadedSourceImageToResearchInput,
): Promise<ImportAppSharedResearchImageResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const material = await requireActiveUploadedSource(workspace.workspace_dir, input.uploaded_source_id);
  const mimeType = uploadedSourceImageMimeType(material);
  if (!mimeType) throw new Error(`Uploaded source is not a supported image: ${material.original_filename}`);
  const paths = await ensureSharedResearchFiles(workspace.workspace_dir, false);
  const candidateId = sanitizeFileNamePart(input.candidate_id, "image");
  const stagingDir = path.join(paths.images_dir, ".staging", "uploaded-source-images");
  const stagingPath = path.join(stagingDir, `${candidateId}-${randomUUID()}${SHARED_RESEARCH_IMAGE_EXTENSIONS[mimeType]}`);
  await mkdir(stagingDir, { recursive: true });
  try {
    await copyFile(material.file_path, stagingPath);
    return await importAppSharedResearchImage({
      workspace_dir: workspace.workspace_dir,
      candidate_id: input.candidate_id,
      staging_file_path: stagingPath,
      expected_size_bytes: material.size_bytes,
      expected_sha256: material.sha256,
      mime_type: mimeType,
    });
  } finally {
    await unlink(stagingPath).catch(() => undefined);
  }
}

/**
 * Copy a classified uploaded image to the user-asset catalog. Unlike research
 * evidence, this directory is not reset when the presentation requirements
 * are confirmed.
 */
export async function copyAppUploadedSourceImageToAsset(
  input: CopyAppUploadedSourceImageToAssetInput,
): Promise<ImportAppSharedResearchImageResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  return withUploadedSourceWriteQueue(workspace.workspace_dir, async () => {
    const material = await requireActiveUploadedSource(workspace.workspace_dir, input.uploaded_source_id);
    const mimeType = uploadedSourceImageMimeType(material);
    if (!mimeType) throw new Error(`Uploaded source is not a supported image: ${material.original_filename}`);

    const sourcePaths = buildUploadedSourcePaths(workspace.workspace_dir);
    await mkdir(sourcePaths.asset_dir, { recursive: true });
    const bytes = await readFile(material.file_path);
    if (bytes.length !== material.size_bytes || sha256BufferHex(bytes) !== material.sha256) {
      throw new Error(`Uploaded image changed before asset copy: ${material.original_filename}`);
    }
    const metadata = await sharp(bytes).metadata();
    const width = normalizeImageDimension(metadata.width) ?? null;
    const height = normalizeImageDimension(metadata.height) ?? null;
    const destinationPath = await writeImageAssetFile({ directory: sourcePaths.asset_dir, bytes, sha256: material.sha256, mimeType });

    const asset = compactImageCatalogAsset({
      candidate_id: input.candidate_id,
      query: "uploaded-image",
      source_url: `uploaded-source://${material.uploaded_source_id}`,
      source_filename: material.original_filename,
      use_in_ppt: true,
      description: input.description,
      reason: input.reason,
      file_path: destinationPath,
      import_status: "imported",
      sha256: material.sha256,
      mime_type: mimeType,
      bytes_size: bytes.length,
      width,
      height,
    });
    if (!asset) throw new Error("Could not create uploaded image asset catalog entry.");
    const catalog = normalizeImageCatalog(await readJsonFileIfExists(sourcePaths.asset_catalog_path));
    const assets = Array.isArray(catalog.assets) ? catalog.assets.map(getPlainRecord) : [];
    await atomicWriteJsonFile(sourcePaths.asset_catalog_path, {
      schema_version: 2,
      assets: deduplicateImageCatalogAssets([...assets, asset]),
    });
    return {
      workspace_dir: workspace.workspace_dir,
      candidate_id: input.candidate_id,
      file_path: destinationPath,
      sha256: material.sha256,
      mime_type: mimeType,
      bytes_size: bytes.length,
      width,
      height,
    };
  });
}

function buildPersistedOutline(
  outline: SaveAppWorkspaceOutlineDraftInput["outline"],
  status: "draft" | "confirmed",
  updatedAt: string,
): AppWorkspaceOutline {
  const title = normalizeOutlineLine(outline.title, "outline.title");
  if (!Array.isArray(outline.items) || outline.items.length === 0) {
    throw new Error("outline.items must contain at least one page");
  }
  return {
    version: 4,
    status,
    title,
    global_creation_requirements: normalizeCreationRequirements(outline.global_creation_requirements, "outline.global_creation_requirements"),
    items: outline.items.map((item, index) => {
      const normalized = normalizeValidOutlineItem(item, index);
      return status === "confirmed"
        ? { ...normalized, page_id: `page-${randomUUID()}` }
        : normalized;
    }),
    updated_at: updatedAt,
    confirmed_at: status === "confirmed" ? updatedAt : null,
  };
}

function outlineContentSignature(outline: AppWorkspaceOutline): string {
  if (outline.status === "empty") return "";
  const items = outline.items
    .map((item) => JSON.stringify([
      item.title.trim(),
      item.content.trim(),
      item.title_segments ?? null,
      item.research ?? null,
      item.selected_image_ids ?? [],
      item.creation_requirements ?? "",
    ]))
    .sort();
  return JSON.stringify([outline.title.trim(), outline.global_creation_requirements ?? "", items]);
}

function shouldAutoSyncWorkspaceTitle(currentTask: Record<string, unknown>, currentOutline: AppWorkspaceOutline, nextTitle: string) {
  const currentTitle = typeof currentTask.title === "string" ? currentTask.title.trim() : "";
  const previousOutlineTitle = currentOutline.status === "empty" ? "" : currentOutline.title.trim();
  if (!currentTitle || currentTitle === nextTitle) return false;
  if (DEFAULT_WORKSPACE_TITLE_PATTERN.test(currentTitle)) return true;
  return Boolean(previousOutlineTitle && currentTitle === previousOutlineTitle);
}

function getSelectedVisualPresetSignature(requirements: AppPresentationRequirements): string {
  const preset = requirements.selections.visual_style_preset;
  if (preset) return JSON.stringify(["preset", preset.id, preset.version, preset.name, preset.description]);
  return "";
}

async function invalidateWorkspaceStyleGuide(workspace: AppWorkspaceResult): Promise<void> {
  await rm(workspace.files.style_guide, { force: true });
}

async function persistAppWorkspaceOutline(
  input: SaveAppWorkspaceOutlineDraftInput,
  status: "draft" | "confirmed",
): Promise<AppWorkspaceResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const requirements = normalizePresentationRequirements(workspace.requirements);
  if (requirements.status !== "confirmed") {
    throw new Error("Confirmed Presentation Requirements are required before saving an Outline.");
  }
  const updatedAt = new Date().toISOString();
  const nextOutline = buildPersistedOutline(input.outline, status, updatedAt);
  await validateOutlineImages(workspace.workspace_dir, nextOutline.items);
  const nextRequirements: AppPresentationRequirements = {
    ...requirements,
    selections: {
      ...requirements.selections,
      slide_count: nextOutline.items.length,
    },
    updated_at: updatedAt,
    confirmed_at: updatedAt,
  };
  const currentTask = getPlainRecord(workspace.task);
  const currentOutline = normalizeOutlineJson(workspace.outline);
  // A selected preset owns a fixed Workspace Style Guide snapshot. Outline edits
  // only invalidate the LLM-generated guide used by the non-template flow.
  if (!requirements.selections.visual_style_preset && outlineContentSignature(currentOutline) !== outlineContentSignature(nextOutline)) {
    await invalidateWorkspaceStyleGuide(workspace);
  }
  await writeJsonFile(workspace.files.outline, nextOutline);
  await writeJsonFile(workspace.files.requirements, nextRequirements);
  await writeJsonFile(workspace.files.task, {
    ...currentTask,
    ...(shouldAutoSyncWorkspaceTitle(currentTask, currentOutline, nextOutline.title)
      ? { title: nextOutline.title }
      : {}),
    updated_at: updatedAt,
  });
  await markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
  return ensureWorkspaceFiles(input.workspace_dir);
}

export async function resetAppWorkspaceOutline(
  input: ResetAppWorkspaceOutlineInput,
): Promise<AppWorkspaceResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const requirements = normalizePresentationRequirements(workspace.requirements);
  if (requirements.status !== "confirmed") {
    throw new Error("Confirmed Presentation Requirements are required before resetting an Outline.");
  }
  const updatedAt = new Date().toISOString();
  if (!requirements.selections.visual_style_preset) {
    await invalidateWorkspaceStyleGuide(workspace);
  }
  await writeJsonFile(workspace.files.outline, createEmptyOutlineJson());
  await touchWorkspaceTask(workspace, updatedAt);
  await markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
  return ensureWorkspaceFiles(input.workspace_dir);
}

export async function saveAppWorkspaceOutlineDraft(
  input: SaveAppWorkspaceOutlineDraftInput,
): Promise<AppWorkspaceResult> {
  return persistAppWorkspaceOutline(input, "draft");
}

export async function confirmAppWorkspaceOutline(
  input: ConfirmAppWorkspaceOutlineInput,
): Promise<AppWorkspaceResult> {
  return persistAppWorkspaceOutline(input, "confirmed");
}

function normalizePlanningBlueprint(value: unknown): AppTemplatePlanningBlueprint | null {
  const record = getPlainRecord(value);
  const id = normalizeString(record.id);
  const blueprintSource = normalizeString(record.blueprint_source);
  if (!id || !blueprintSource) return null;

  return {
    id,
    name: normalizeString(record.name) || id,
    blueprint_source: blueprintSource,
    example_slide: normalizeString(record.example_slide) || undefined,
    layout_family: normalizeString(record.layout_family) || undefined,
    content_intents: normalizeStringArray(record.content_intents),
    suitable_for: normalizeStringArray(record.suitable_for),
    avoid_for: normalizeStringArray(record.avoid_for),
  };
}

function mapTemplateGroupSummary(
  group: DiscoveredTemplateGroupSummaryInfo,
): AppTemplateGroupSummary {
  return {
    group_id: group.group_id,
    group_name: group.group_name,
    group_description: group.group_description,
    ordered: group.ordered,
    default: group.default,
    group_brief: group.group_brief,
    style_tags: group.style_tags,
    industry_tags: group.industry_tags,
    use_cases: group.use_cases,
    audience_tags: group.audience_tags,
    tone_tags: group.tone_tags,
    cover_layout_id: group.cover_layout_id,
    agenda_layout_id: group.agenda_layout_id,
    closing_layout_id: group.closing_layout_id,
    layout_roles_summary: group.layout_roles_summary,
    content_elements_summary: group.content_elements_summary,
    layout_count: group.layout_count,
  };
}

export async function listAppTemplateGroups(): Promise<ListAppTemplateGroupsResult> {
  const groups = await listDiscoveredTemplateGroupSummaries({ include_builtin: true });
  const mapped = groups.map(mapTemplateGroupSummary);
  return {
    groups: mapped,
    count: mapped.length,
  };
}

export async function getAppTemplateGroup(input: GetAppTemplateGroupInput) {
  const group = await getDiscoveredTemplateGroup({
    group_id: input.group_id,
    include_builtin: true,
  });

  if (!group) {
    throw new Error(`Template group not found: ${input.group_id}`);
  }

  return group;
}

export async function getAppTemplatePlanningContext(
  input: GetAppTemplatePlanningContextInput,
): Promise<AppTemplatePlanningContext> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const templateDir = readSelectedTemplateDir(workspace);
  const manifestPath = readSelectedTemplateManifestPath(workspace);
  const catalogPath = readSelectedTemplateCatalogPath(workspace);
  const catalog = getPlainRecord(JSON.parse(await readFile(catalogPath, "utf8")) as unknown);
  const template =
    workspace.template && typeof workspace.template === "object" && !Array.isArray(workspace.template)
      ? (workspace.template as Record<string, unknown>)
      : {};
  const blueprints = Array.isArray(catalog.blueprints)
    ? catalog.blueprints
        .map(normalizePlanningBlueprint)
        .filter((item): item is AppTemplatePlanningBlueprint => item !== null)
    : [];

  return {
    template_group: normalizeString(catalog.group_id) || normalizeString(template.selected_template_group),
    template_group_name:
      normalizeString(template.selected_template_group_name) || normalizeString(catalog.group_id),
    template_dir: templateDir,
    manifest_path: manifestPath,
    catalog_path: catalogPath,
    blueprints,
    rules: [
      "Choose blueprint_id only from this context.",
      "manifest.json must reference ./slides/*.tsx entries.",
      "blueprints/ and reference-slides/ are read-only.",
      "data/*.json stores content; slides/*.tsx owns layout and component composition.",
    ],
  };
}

function buildWorkspaceThemePaths(templateDir: string) {
  return {
    themeDir: path.join(templateDir, "theme"),
    tokenPath: path.join(templateDir, "theme", "token.json"),
    schemaPath: path.join(templateDir, "theme", "token.schema.json"),
    defaultTokenPath: path.join(templateDir, "theme", "token.default.json"),
    readmePath: path.join(templateDir, "theme", "README.md"),
  };
}

function assertTemplateContainedPath(templateDir: string, filePath: string, fieldName: string): void {
  const normalizedTemplateDir = path.normalize(templateDir);
  const normalizedFilePath = path.normalize(filePath);
  const relativePath = path.relative(normalizedTemplateDir, normalizedFilePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`"${fieldName}" must stay inside the selected template directory`);
  }
}

async function readRequiredThemeJsonFile(filePath: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Selected template is missing ${label}: ${filePath}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label}: ${message}`);
  }
}

async function readRequiredThemeTextFile(filePath: string, label: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Selected template is missing ${label}: ${filePath}`);
    }
    throw error;
  }
}

function formatAjvError(error: ErrorObject): string {
  const pathText = error.instancePath || "/";
  const message = error.message ?? "is invalid";
  const params = Object.keys(error.params ?? {}).length > 0
    ? ` ${JSON.stringify(error.params)}`
    : "";
  return `${pathText} ${message}${params}`;
}

function validateThemeTokenAgainstSchema(
  token: unknown,
  schema: Record<string, unknown>,
  sourcePath: string,
): AppWorkspaceThemeValidationResult {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const schemaOk = validate(token);
  const errors = schemaOk
    ? []
    : (validate.errors ?? []).map(formatAjvError);

  if (schemaOk) {
    try {
      validateThemeTokenRecord(token, sourcePath);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

async function readSelectedTemplateThemeContext(
  workspace: AppWorkspaceResult,
): Promise<Omit<AppWorkspaceThemeContext, "current_token" | "current_token_validation">> {
  const templateDir = readSelectedTemplateDir(workspace);
  const paths = buildWorkspaceThemePaths(templateDir);
  for (const [fieldName, filePath] of Object.entries(paths)) {
    if (fieldName === "themeDir") continue;
    assertTemplateContainedPath(templateDir, filePath, fieldName);
  }

  const schemaValue = await readRequiredThemeJsonFile(paths.schemaPath, "Template Theme Contract schema");
  const schema = getPlainRecord(schemaValue);
  if (Object.keys(schema).length === 0) {
    throw new Error(`Template Theme Contract schema must be a JSON object: ${paths.schemaPath}`);
  }

  const defaultToken = await readRequiredThemeJsonFile(paths.defaultTokenPath, "Template Theme Contract default token");
  const defaultValidation = validateThemeTokenAgainstSchema(defaultToken, schema, paths.defaultTokenPath);
  if (!defaultValidation.ok) {
    throw new Error(
      `Template default theme token does not satisfy its schema: ${defaultValidation.errors.join("; ")}`,
    );
  }

  const readme = await readRequiredThemeTextFile(paths.readmePath, "Template Theme Contract README");

  return {
    workspace_dir: workspace.workspace_dir,
    template_dir: templateDir,
    token_path: paths.tokenPath,
    schema_path: paths.schemaPath,
    default_token_path: paths.defaultTokenPath,
    readme_path: paths.readmePath,
    schema,
    default_token: defaultToken,
    readme,
  };
}

async function readCurrentWorkspaceThemeToken(
  tokenPath: string,
  schema: Record<string, unknown>,
): Promise<Pick<AppWorkspaceThemeContext, "current_token" | "current_token_validation">> {
  if (!(await fileExists(tokenPath))) {
    return {
      current_token: null,
      current_token_validation: null,
    };
  }

  try {
    const token = JSON.parse(await readFile(tokenPath, "utf8")) as unknown;
    return {
      current_token: token,
      current_token_validation: validateThemeTokenAgainstSchema(token, schema, tokenPath),
    };
  } catch (error) {
    return {
      current_token: null,
      current_token_validation: {
        ok: false,
        errors: [error instanceof Error ? error.message : String(error)],
      },
    };
  }
}

async function withThemeTokenWriteQueue<T>(
  workspaceDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const queueKey = path.normalize(workspaceDir);
  const previous = themeTokenWriteQueues.get(queueKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tail = run.catch(() => undefined);
  themeTokenWriteQueues.set(queueKey, tail);

  try {
    return await run;
  } finally {
    if (themeTokenWriteQueues.get(queueKey) === tail) {
      themeTokenWriteQueues.delete(queueKey);
    }
  }
}

export async function getAppWorkspaceThemeContext(
  input: GetAppWorkspaceThemeContextInput,
): Promise<AppWorkspaceThemeContext> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const context = await readSelectedTemplateThemeContext(workspace);
  const current = await readCurrentWorkspaceThemeToken(context.token_path, context.schema);
  return {
    ...context,
    ...current,
  };
}

export async function validateAppWorkspaceThemeToken(
  input: ValidateAppWorkspaceThemeTokenInput,
): Promise<AppWorkspaceThemeValidationResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const context = await readSelectedTemplateThemeContext(workspace);
  return validateThemeTokenAgainstSchema(input.token, context.schema, context.token_path);
}

export async function recordAppWorkspaceThemeToken(
  input: RecordAppWorkspaceThemeTokenInput,
): Promise<RecordAppWorkspaceThemeTokenResult> {
  return withThemeTokenWriteQueue(input.workspace_dir, async () => {
    const workspace = await ensureWorkspaceFiles(input.workspace_dir);
    const context = await readSelectedTemplateThemeContext(workspace);
    const fallbackUsed = input.use_default === true;
    const token = fallbackUsed ? context.default_token : input.token;
    if (token === undefined) {
      throw new Error('"token" is required unless "use_default" is true');
    }

    const validation = validateThemeTokenAgainstSchema(token, context.schema, context.token_path);
    if (validation.ok) {
      await writeJsonFile(context.token_path, token);
      await touchWorkspaceTask(workspace, new Date().toISOString());
    }

    return {
      workspace: await ensureWorkspaceFiles(input.workspace_dir),
      workspace_dir: workspace.workspace_dir,
      token_path: context.token_path,
      fallback_used: fallbackUsed,
      validation,
      token,
    };
  });
}

export async function selectAppWorkspaceTemplate(
  input: SelectAppWorkspaceTemplateInput,
): Promise<SelectAppWorkspaceTemplateResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const templateGroup = input.template_group.trim();
  if (templateGroup.length === 0) {
    throw new Error('"template_group" must be a non-empty string');
  }

  const availableGroups = await listDiscoveredTemplateGroupSummaries({ include_builtin: true });
  const selectedGroup = availableGroups.find((group) => group.group_id === templateGroup);
  if (!selectedGroup) {
    throw new Error(`Template group not found: ${templateGroup}`);
  }

  const title =
    workspace.task &&
    typeof workspace.task === "object" &&
    !Array.isArray(workspace.task) &&
    typeof (workspace.task as { title?: unknown }).title === "string"
      ? (workspace.task as { title: string }).title
      : selectedGroup.group_name;
  const templateDir = path.join(workspace.workspace_dir, "template");
  const forkResult = await forkTemplateGroup({
    templateGroup: selectedGroup.group_id,
    outDir: templateDir,
    manifestTitle: title,
    overwrite: true,
  });
  const selectedAt = new Date().toISOString();
  const selection: AppWorkspaceTemplateSelection = {
    version: 1,
    selected_template_group: selectedGroup.group_id,
    selected_template_group_name: selectedGroup.group_name,
    template_dir: templateDir,
    manifest_path: forkResult.manifestPath,
    catalog_json_path: forkResult.catalogJsonPath,
    data_dir_path: forkResult.dataDirPath,
    selected_at: selectedAt,
  };

  await writeJsonFile(workspace.files.template, selection);
  await touchWorkspaceTask(workspace, selectedAt);

  return {
    workspace: await ensureWorkspaceFiles(input.workspace_dir),
    selection,
  };
}

async function invalidateFinalDeckRender(
  workspace: Awaited<ReturnType<typeof ensureWorkspaceFiles>>,
  updatedAt = new Date().toISOString(),
): Promise<void> {
  const progress = normalizePageProgressJson(workspace.page_progress);
  await writePageProgressFile(workspace.files.page_progress, {
    ...progress,
    final_deck_render: {
      status: "idle",
      message: null,
      error: null,
      output_dir: null,
      deck_html_path: null,
      rendered_at: null,
      updated_at: updatedAt,
      source_fingerprint: null,
    },
    updated_at: updatedAt,
  } satisfies AppPageProgress);
}

export async function getAppPageEditContext(input: GetAppPageEditContextInput): Promise<GetAppPageEditContextResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const outline = normalizeOutlineJson(workspace.outline);
  const pageIndex = outline.items.findIndex((item) => item.page_id === input.page_id);
  if (pageIndex < 0) throw new Error(`Unknown page_id "${input.page_id}"`);
  const existing = await readManualPageRevision(workspace.workspace_dir, input.page_id);
  const progressPage = normalizePageProgressJson(workspace.page_progress).pages.find((item) => item.page_id === input.page_id);
  let current;
  try {
    current = await resolveCurrentPageSnapshot({ workspaceDir: workspace.workspace_dir,
      pageId: input.page_id, snapshotPath: progressPage?.last_html_path });
  } catch (error) {
    if (existing || (progressPage?.last_html_path && (error as NodeJS.ErrnoException).code !== "ENOENT")) throw error;
    const preview = await performAppWorkspacePagePreview({ workspace_dir: workspace.workspace_dir, page_id: input.page_id });
    current = await resolveCurrentPageSnapshot({ workspaceDir: workspace.workspace_dir,
      pageId: input.page_id, snapshotPath: preview.html_path });
  }
  const { htmlPath, html: snapshotHtml } = current;
  const html = await normalizeManualPageResources(workspace.workspace_dir, input.page_id,
    await injectWorkspaceManagedFontCss(workspace.workspace_dir, ensureSinglePageSlideShell(snapshotHtml)), htmlPath);
  const [fontLibrary, workspaceFonts, workspaceFontLibrary] = await Promise.all([
    listManagedFontLibrary(),
    managedFontsUsedByHtml(workspace.workspace_dir, html),
    listWorkspaceManagedFontLibrary(workspace.workspace_dir),
  ]);
  return {
    workspace_dir: workspace.workspace_dir, page_id: input.page_id,
    title: outline.items[pageIndex]?.title ?? input.page_id, page_index: pageIndex,
    revision: existing?.revision ?? 0, manually_edited: Boolean(existing), html_path: htmlPath,
    html, screenshot_path: "", manifest: existing,
    preview_source_fingerprint: await fingerprintPageSnapshot(workspace.workspace_dir, htmlPath, snapshotHtml),
    font_library: fontLibrary.families,
    workspace_font_library: workspaceFontLibrary.families,
    workspace_fonts: workspaceFonts,
  };
}

interface CommitManualPageToFinalDeckResult {
  preview_source_fingerprint: string;
  final_deck_render_updated: boolean;
  final_deck_render_requires_rebuild: boolean;
  deck_html_path: string | null;
  rendered_at: string | null;
  page_progress_updated_at: string;
}

async function commitManualPageToFinalDeck(input: {
  workspace_dir: string;
  page_id: string;
  page_index: number;
  html_path: string;
  screenshot_path: string;
  updated_at: string;
}): Promise<CommitManualPageToFinalDeckResult> {
  return withManualFinalDeckWriteQueue(input.workspace_dir, async () => {
    const workspace = await ensureWorkspaceFiles(input.workspace_dir);
    const progress = normalizePageProgressJson(workspace.page_progress);
    const currentFinalRender = progress.final_deck_render;
    let finalDeckRenderUpdated = false;
    let incrementalError: string | null = null;

    if (
      currentFinalRender.status === "completed" &&
      currentFinalRender.deck_html_path &&
      currentFinalRender.output_dir &&
      isPathWithin(
        path.normalize(currentFinalRender.deck_html_path),
        path.normalize(currentFinalRender.output_dir),
      )
    ) {
      try {
        await publishManualPageIntoDeck({
          deckHtmlPath: currentFinalRender.deck_html_path,
          pageHtmlPath: input.html_path,
          pageIndex: input.page_index,
        });
        finalDeckRenderUpdated = true;
      } catch (error) {
        incrementalError = error instanceof Error ? error.message : String(error);
      }
    } else {
      incrementalError = "No completed Final Deck Render is available for incremental publication.";
    }

    // The saved slides file is authoritative; update only its derived index.
    const savedSourceHash = sha256BufferHex(await readFile(input.html_path));
    const nextPages = progress.pages.map((page) => page.page_id === input.page_id ? {
      ...page, render_source_sha256: savedSourceHash, snapshot_source_sha256: savedSourceHash,
      last_html_path: input.html_path,
      last_screenshot_path: input.screenshot_path,
      updated_at: input.updated_at,
    } : page);
    const nextSourceFingerprint = finalDeckRenderUpdated
      ? await fingerprintAppWorkspaceDeckRender(
        { ...workspace, page_progress: { ...progress, pages: nextPages } },
        readSelectedTemplateManifestPath(workspace),
      )
      : null;
    const nextFinalRender = finalDeckRenderUpdated
      ? {
          ...currentFinalRender,
          status: "completed" as const,
          message: null,
          error: null,
          rendered_at: input.updated_at,
          updated_at: input.updated_at,
          source_fingerprint: nextSourceFingerprint,
        }
      : {
          status: "idle" as const,
          message: "Manual page saved; Final Deck Render requires a rebuild.",
          error: incrementalError,
          output_dir: null,
          deck_html_path: null,
          rendered_at: null,
          updated_at: input.updated_at,
          source_fingerprint: null,
        };
    const nextProgress: AppPageProgress = {
      ...progress,
      final_deck_render: nextFinalRender,
      pages: nextPages,
      updated_at: input.updated_at,
    };
    await writePageProgressFile(workspace.files.page_progress, nextProgress);

    const task = getPlainRecord(workspace.task);
    const artifacts = getPlainRecord(task.artifacts);
    delete artifacts.pptx;
    delete artifacts.pdf;
    await writeJsonFile(workspace.files.task, {
      ...task,
      artifacts,
      updated_at: input.updated_at,
    });

    return {
      preview_source_fingerprint: await fingerprintPageSnapshot(workspace.workspace_dir, input.html_path),
      final_deck_render_updated: finalDeckRenderUpdated,
      final_deck_render_requires_rebuild: !finalDeckRenderUpdated,
      deck_html_path: finalDeckRenderUpdated ? nextFinalRender.deck_html_path : null,
      rendered_at: finalDeckRenderUpdated ? input.updated_at : null,
      page_progress_updated_at: input.updated_at,
    };
  });
}

export async function saveAppManualPageRevision(
  input: SaveAppManualPageRevisionInput,
): Promise<SaveAppManualPageRevisionResult> {
  return withPageRecoveryWriteQueue(input.workspace_dir, () => withBatchLock(input.workspace_dir,
    () => withGenerationWorkspaceLock(input.workspace_dir, () => performSaveAppManualPageRevision(input))));
}

async function performSaveAppManualPageRevision(input: SaveAppManualPageRevisionInput): Promise<SaveAppManualPageRevisionResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  await assertPageRecoveryAvailable(workspace);
  assertAbsolutePath(input.staging_file_path, "staging_file_path");
  const submitted = await readFile(input.staging_file_path);
  if (submitted.length !== Math.floor(input.expected_size_bytes)) {
    throw new Error(`Manual HTML size mismatch: expected ${input.expected_size_bytes}, got ${submitted.length}`);
  }
  const context = await getAppPageEditContext({
    workspace_dir: workspace.workspace_dir,
    page_id: input.page_id,
  });
  if (context.revision !== input.base_revision) {
    throw new Error(`Manual Page Revision conflict: expected ${context.revision}, received ${input.base_revision}`);
  }
  const sourcePath = path.join(workspace.workspace_dir, "slides", `${input.page_id}.html`);
  const sourceBytes = await readFile(sourcePath);
  const baseDocument = context.html;
  const allowedRemoteUrls = new Set<string>();
  await rewriteHtmlResourceReferences(baseDocument, async (url) => {
    if (/^(?:https:)?\/\//i.test(url)) allowedRemoteUrls.add(url);
    return url;
  });
  await rewriteHtmlResourceReferences(submitted.toString("utf8"), async (url) => {
    if (/^(?:https:)?\/\//i.test(url) && !allowedRemoteUrls.has(url)) throw new Error("Manual resource must be restored to its Workspace file before saving");
    return url;
  });
  const submittedSanitized = await sanitizeManualPageHtml(
    workspace.workspace_dir,
    input.page_id,
    submitted.toString("utf8"),
  );
  const submittedShell = extractSlideShell(submittedSanitized.currentHtml).shell
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<(?:link|meta|base)\b[^>]*>/gi, "");
  const restrictedDocument = replaceSinglePageSlideShell(
    ensureSinglePageSlideShell(baseDocument),
    submittedShell,
  );
  const { currentHtml } = await sanitizeManualPageHtml(
    workspace.workspace_dir,
    input.page_id,
    restrictedDocument,
  );
  const pendingDir = path.join(workspace.workspace_dir, "manual-edits", ".pending");
  await mkdir(pendingDir, { recursive: true });
  const pendingHtml = path.join(pendingDir, `${input.page_id}-${Date.now()}.html`);
  const pendingScreenshot = path.join(pendingDir, `${input.page_id}-${Date.now()}.png`);
  await writeFile(pendingHtml, currentHtml, "utf8");
  try {
    await writeSlideScreenshots(
      [{ html: currentHtml, htmlPath: pendingHtml, outputPath: pendingScreenshot }],
      "Manual Page Revision validation",
      { requireTailwind: false, validateManualSlideShell: true, captureScreenshot: false },
    );
    const baseHtml = context.manifest ? await normalizeManualPageResources(workspace.workspace_dir, input.page_id, await readFile(context.manifest.base_html_path, "utf8")) : context.html;
    const manifest = await publishManualPageRevision({
      workspaceDir: workspace.workspace_dir,
      pageId: input.page_id,
      baseRevision: input.base_revision,
      baseHtml,
      currentHtml,

      sourceBytes,
    });
    const finalDeck = await commitManualPageToFinalDeck({
      workspace_dir: workspace.workspace_dir,
      page_id: input.page_id,
      page_index: context.page_index,
      html_path: manifest.current_html_path,
      screenshot_path: manifest.screenshot_path,
      updated_at: manifest.updated_at,
    });
    process.stderr.write(
      `[snapshot-trigger] #2 manual-page-save workspace_id=${path.basename(workspace.workspace_dir)} page_id=${input.page_id} revision=${manifest.revision}\n`,
    );
    publishWorkspaceSnapshotFromTrigger(workspace.workspace_dir);
    return {
      workspace_dir: workspace.workspace_dir,
      page_id: input.page_id,
      manifest,
      ...finalDeck,
    };
  } finally {
    await rm(pendingHtml, { force: true }).catch(() => undefined);
    await rm(pendingScreenshot, { force: true }).catch(() => undefined);
  }
}

async function assertPageRecoveryAvailable(workspace: AppWorkspaceResult) {
  const key = path.normalize(workspace.workspace_dir);
  if (normalizePageProgressJson(workspace.page_progress).status === "running") throw new Error("PAGE_RECOVERY_BUSY");
  if (activeDeckRenders.has(key) || [...activePageRenders.keys()].some((value) => value.startsWith(`${key}\0`))) {
    throw new Error("PAGE_RECOVERY_BUSY");
  }
  const run = await findGenerationRunForWorkspace(WORKSPACE_ROOT, workspace.workspace_id);
  if (run && ["preparing", "active", "committing"].includes(run.state)) throw new Error("PAGE_RECOVERY_BUSY");
  const job = getPlainRecord(await readJsonFileIfExists(buildPptxExportPaths(workspace.workspace_dir).statusPath));
  if (["queued", "validating", "converting"].includes(String(job.status))) throw new Error("PAGE_RECOVERY_BUSY");
}

async function readPageRecoveryPreparation(input: RestoreAppPageSourceVersionInput, sourceOnly = false) {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  await assertPageRecoveryAvailable(workspace);
  const progress = normalizePageProgressJson(workspace.page_progress);
  const manifestPath = readSelectedTemplateManifestPath(workspace);
  const manifestBytes = await readFile(manifestPath);
  const manifest = getPlainRecord(JSON.parse(manifestBytes.toString("utf8")));
  const slides = (Array.isArray(manifest.slides) ? manifest.slides : []).map(getPlainRecord);
  const pageIndex = slides.findIndex((slide) => slide.id === input.page_id);
  const page = progress.pages.find((item) => item.page_id === input.page_id);
  if (!page || pageIndex < 0) throw new Error("PAGE_RECOVERY_UNKNOWN_PAGE");
  for (const item of progress.pages) {
    try { await readManualPageRevision(workspace.workspace_dir, item.page_id); }
    catch (error) { if (item.page_id === input.page_id) throw error; }
  }
  const tracked = [workspace.files.task, workspace.files.outline, workspace.files.page_progress, manifestPath];
  for (const item of progress.pages) {
    const manual = manualPageRevisionPaths(workspace.workspace_dir, item.page_id);
    tracked.push(manual.manifest, manual.currentHtml, manual.baseHtml,
      path.join(workspace.workspace_dir, "slides", `${item.page_id}.html`));
    // Serialized paths from another machine are not part of this Workspace.
    if (item.last_html_path && isPathWithin(path.normalize(item.last_html_path), path.normalize(workspace.workspace_dir))) tracked.push(item.last_html_path);
  }
  const captured = await captureRecoveryFiles(workspace.workspace_dir, tracked);
  for (const [file, value] of [[workspace.files.task, workspace.task], [workspace.files.outline, workspace.outline],
    [workspace.files.page_progress, workspace.page_progress]] as const) {
    if (JSON.stringify(JSON.parse(captured.get(file)!.toString("utf8"))) !== JSON.stringify(value)) throw new Error("PAGE_RECOVERY_CONFLICT");
  }
  if (!captured.get(manifestPath)?.equals(manifestBytes)) throw new Error("PAGE_RECOVERY_CONFLICT");
  const candidate = await selectPageRecoveryCandidate({ workspaceDir: workspace.workspace_dir,
    pageId: input.page_id, snapshotPath: page.last_html_path, sourceOnly });
  if (candidate && !captured.has(candidate.htmlPath)) {
    const extra = await captureRecoveryFiles(workspace.workspace_dir, [candidate.htmlPath]);
    extra.forEach((value, file) => captured.set(file, value));
  }
  const candidateFingerprint = candidate && candidate.source !== "original_source"
    ? await fingerprintPageSnapshot(workspace.workspace_dir, candidate.htmlPath, candidate.html) : null;
  assertRecoveryFilesUnchanged(workspace.workspace_dir, captured);
  const option: PageRecoveryOption = { workspace_dir: workspace.workspace_dir, page_id: input.page_id,
    available: Boolean(candidate), ...(candidate ? { source: candidate.source,
      recovery_token: recoveryHash(JSON.stringify([input.page_id, candidate.source, candidate.htmlPath, candidate.html, candidateFingerprint,
        [...captured].map(([file, value]) => [path.relative(workspace.workspace_dir, file), value ? recoveryHash(value) : null])])) } : {}) };
  return { workspace, progress, slides, pageIndex, candidate, captured, option, manifestBytes };
}

export async function prepareAppPageRecovery(input: RestoreAppPageSourceVersionInput): Promise<PageRecoveryOption> {
  return (await readPageRecoveryPreparation(input)).option;
}

export async function restoreAppPageSourceVersion(
  input: RestoreAppPageSourceVersionInput,
): Promise<RestoreAppPageSourceVersionResult> {
  const workspaceDir = normalizeWorkspaceDir(input.workspace_dir);
  return withPageRecoveryWriteQueue(workspaceDir, () => withBatchLock(workspaceDir,
    () => withGenerationWorkspaceLock(workspaceDir, () => withManualFinalDeckWriteQueue(workspaceDir,
      () => withPageProgressWriteQueue(workspaceDir, async () => {
    // The editor's existing explicit source restore still renders Page Source.
    // Preview recovery must submit the exact option shown in the dialog.
    const prepared = await readPageRecoveryPreparation(input, !input.recovery_token);
    const { workspace, progress, candidate, captured, option, slides, manifestBytes } = prepared;
    if (input.recovery_token && option.recovery_token !== input.recovery_token) throw new Error("PAGE_RECOVERY_CONFLICT");
    if (!candidate) throw new Error("PAGE_RECOVERY_UNAVAILABLE");
    const id = randomUUID();
    const staging = path.join(workspaceDir, "output", "page-recovery", id);
    await mkdir(staging, { recursive: true });
    try {
      let html = candidate.html;
      if (candidate.source === "original_source" && !isStaticPageSource(html)) {
        const rendered = await buildDeckPageScreenshotFromManifest({ manifestPath: readSelectedTemplateManifestPath(workspace),
          outputDir: staging, htmlOutputDir: staging, name: `${workspace.workspace_id}-recovery-${id}`,
          page: prepared.pageIndex + 1, screenshot: false });
        html = await readFile(rendered.htmlPath, "utf8");
      }
      html = ensureSinglePageSlideShell(html);
      // Normalize relative asset URLs before moving the document to its official path.
      // Rebuilding does not change the saved page or reset its edit revision.
      const stagedHtml = path.join(staging, "prepared.html");
      await writeFile(stagedHtml, html);
      const previewFingerprint = await fingerprintPageSnapshot(workspaceDir, stagedHtml, html);
      const updatedAt = new Date().toISOString();
      const sourcePath = path.join(workspaceDir, "slides", `${input.page_id}.html`);
      const sourceBytes = captured.get(sourcePath)!;
      const restoredManual = Boolean(await readManualPageRevision(workspaceDir, input.page_id));
      const htmlPath = isStaticPageSource(candidate.html) ? sourcePath
        : path.join(workspaceDir, "output", "page-preview-html", `${input.page_id}-restored-${id}.html`);
      const files = new Map<string, string | Buffer | null>();
      const put = (file: string, value: string | Buffer | null) => files.set(path.relative(workspaceDir, file), value);
      if (htmlPath !== sourcePath) put(htmlPath, html);
      const nextPages = progress.pages.map((page) => page.page_id === input.page_id ? {
        ...page, last_html_path: htmlPath, last_screenshot_path: "", last_error: "", updated_at: updatedAt,
        render_source_sha256: recoveryHash(sourceBytes), snapshot_source_sha256: recoveryHash(sourceBytes),
        status: hasCompletedDeckBaseline(progress) ? "accepted" as const : page.status,
      } : page);
      let deckHtml: string | null = null;
      let deckFingerprint: string | null = null;
      try {
        const pages = await Promise.all(slides.map(async (slide) => slide.id === input.page_id ? html
          : (await resolveCurrentPageSnapshot({ workspaceDir, pageId: String(slide.id),
            snapshotPath: progress.pages.find((page) => page.page_id === slide.id)?.last_html_path })).html));
        deckHtml = buildStaticDeckHtml({ title: normalizeString(getPlainRecord(workspace.task).title), pages });
        const hash = createHash("sha256").update(manifestBytes);
        pages.forEach((page) => hash.update(page));
        deckFingerprint = hash.digest("hex");
      } catch { /* Another unavailable page must not prevent this page's recovery. */ }
      const outputDir = path.join(workspaceDir, "output", "app-render");
      const deckPath = path.join(outputDir, `${workspace.workspace_id}-review-deck.html`);
      if (deckHtml !== null) put(deckPath, deckHtml);
      const nextProgress: AppPageProgress = { ...progress, pages: nextPages, updated_at: updatedAt, final_deck_render: {
        status: deckHtml !== null ? "completed" : "idle", message: null, error: null,
        output_dir: deckHtml !== null ? outputDir : null, deck_html_path: deckHtml !== null ? deckPath : null,
        rendered_at: deckHtml !== null ? updatedAt : null, updated_at: updatedAt, source_fingerprint: deckFingerprint,
      } };
      const task = getPlainRecord(workspace.task);
      const artifacts = { ...getPlainRecord(task.artifacts) };
      delete artifacts.pptx; delete artifacts.pdf;
      put(workspace.files.page_progress, JSON.stringify(nextProgress, null, 2));
      put(workspace.files.task, JSON.stringify({ ...task, artifacts, updated_at: updatedAt }, null, 2));
      put(path.join(workspaceDir, "output", "pptx-export.json"), null);
      await assertPageRecoveryAvailable(await ensureWorkspaceFiles(workspaceDir));
      if (previewFingerprint !== await fingerprintPageSnapshot(workspaceDir, stagedHtml, html)) throw new Error("PAGE_RECOVERY_CONFLICT");
      assertRecoveryFilesUnchanged(workspaceDir, captured);
      publishPageRegenerationFiles(workspaceDir, files);
      publishWorkspaceSnapshotFromTrigger(workspaceDir);
      void appendPreviewRecoveryLog(workspaceDir, { event: "preview.restored", page_id: input.page_id,
        error_kind: "unknown", source: candidate.source, actual_fingerprint: previewFingerprint }).catch(() => undefined);
      return { workspace_dir: workspaceDir, page_id: input.page_id, restored: true,
        html_path: htmlPath, screenshot_path: "", manually_edited: restoredManual, page_progress: nextProgress,
        preview_source_fingerprint: previewFingerprint, final_deck_render_updated: deckHtml !== null,
        final_deck_render_requires_rebuild: deckHtml === null, deck_html_path: deckHtml !== null ? deckPath : null,
        rendered_at: deckHtml !== null ? updatedAt : null, page_progress_updated_at: updatedAt };
    } finally { await rm(staging, { recursive: true, force: true }).catch(() => undefined); }
  })))));
}

function hasCompletedDeckBaseline(progress: AppPageProgress): boolean {
  return progress.status === "completed" && progress.recovery.status === "completed";
}

/** Repair derived references left by older restore jobs, never user content. */
async function repairCompletedWorkspaceArtifacts(workspace: AppWorkspaceResult): Promise<AppWorkspaceResult> {
  if (!hasCompletedDeckBaseline(normalizePageProgressJson(workspace.page_progress))) return workspace;
  return withManualFinalDeckWriteQueue(workspace.workspace_dir, () =>
    withPageProgressWriteQueue(workspace.workspace_dir, async () => {
      const latest = await ensureWorkspaceFiles(workspace.workspace_dir);
      const progress = normalizePageProgressJson(latest.page_progress);
      if (!hasCompletedDeckBaseline(progress) || activeDeckRenders.has(path.normalize(latest.workspace_dir))) return latest;
      if (progress.pages.some((page) => activePageRenders.has(`${path.normalize(latest.workspace_dir)}\0${page.page_id}`))) return latest;
      const run = await findGenerationRunForWorkspace(WORKSPACE_ROOT, latest.workspace_id);
      if (run && ["preparing", "active", "committing"].includes(run.state)) return latest;
      const exportJob = getPlainRecord(await readJsonFileIfExists(buildPptxExportPaths(latest.workspace_dir).statusPath));
      if (["queued", "validating", "converting"].includes(normalizeString(exportJob.status))) return latest;

      const manifestPath = readSelectedTemplateManifestPath(latest);
      const manifest = getPlainRecord(JSON.parse(await readFile(manifestPath, "utf8")));
      const slides = Array.isArray(manifest.slides) ? manifest.slides.map(getPlainRecord) : [];
      if (slides.length !== progress.pages.length || slides.some((slide, index) => slide.id !== progress.pages[index]?.page_id)) return latest;
      let pages: AppPageProgressItem[];
      try {
        pages = await Promise.all(progress.pages.map(async (page, index) => {
          const current = await resolveCurrentPageSnapshot({ workspaceDir: latest.workspace_dir,
            pageId: page.page_id!, snapshotPath: page.last_html_path });
          const source = await readManifestLocalSlideSourcePath({ manifestPath, pageIndex: index, allowHtml: true });
          const sourceHash = source ? sha256BufferHex(await readFile(source.absolutePath)) : "";
          const recoveredStatus = ["rendered", "interrupted"].includes(page.status) ? "accepted" : page.status;
          return { ...page, last_html_path: current.htmlPath, status: recoveredStatus,
            render_source_sha256: sourceHash, snapshot_source_sha256: sourceHash };
        }));
      } catch (error) {
        // Missing derived artifacts are rebuilt by the restore queue. Leave the
        // old references intact until all current pages can be resolved.
        console.warn("[workspace-current-pages] repair deferred:", error instanceof Error ? error.message : String(error));
        return latest;
      }
      const repaired = { ...latest, page_progress: { ...progress, pages } };
      const sourceFingerprint = await fingerprintAppWorkspaceDeckRender(repaired, manifestPath);
      const previousPaths = await Promise.all(progress.pages.map((page) =>
        realpath(page.last_html_path).catch(() => page.last_html_path)));
      const referencesChanged = pages.some((page, index) => page.last_html_path !== previousPaths[index]);
      const needsDeck = referencesChanged || !progress.final_deck_render.deck_html_path
        || !await fileExists(progress.final_deck_render.deck_html_path) || (progress.final_deck_render.status === "completed"
        && Boolean(progress.final_deck_render.source_fingerprint)
        && progress.final_deck_render.source_fingerprint !== sourceFingerprint);
      const statesChanged = pages.some((page, index) => page.status !== progress.pages[index].status);
      if (!needsDeck && !statesChanged) return latest;
      let final = progress.final_deck_render;
      if (needsDeck) {
        const result = await performAppWorkspaceDeckHtmlRender({ workspace: repaired, manifestPath, expectedSourceFingerprint: sourceFingerprint,
          outputDir: path.join(latest.workspace_dir, "output", "app-render") });
        final = { ...final, status: "completed", message: null, error: null,
          output_dir: result.outputDir, deck_html_path: result.deckHtmlPath,
          source_fingerprint: sourceFingerprint, rendered_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        // Preserve exported files, but no longer advertise the old content as
        // the current export. A user can explicitly export the repaired deck.
        const task = getPlainRecord(await readJsonFileIfExists(latest.files.task));
        const artifacts = { ...getPlainRecord(task.artifacts) };
        delete artifacts.pptx;
        delete artifacts.pdf;
        await writeJsonFile(latest.files.task, { ...task, artifacts });
        await rm(buildPptxExportPaths(latest.workspace_dir).statusPath, { force: true });
      }
      // Repair is derived maintenance, not a user edit: keep task/progress
      // modification timestamps and saved manual revisions unchanged.
      await writePageProgressFile(latest.files.page_progress, { ...progress, pages, final_deck_render: final });
      if (isDiagnosticLoggingEnabled()) {
        try {
          const directory = path.join(latest.workspace_dir, ".log");
          await mkdir(directory, { recursive: true });
          await appendFile(path.join(directory, "preview-recovery.jsonl"), `${JSON.stringify({
            timestamp: new Date().toISOString(), event: "workspace.current-pages.repaired",
            page_ids: pages.filter((page, index) => page.last_html_path !== previousPaths[index]
              || page.status !== progress.pages[index].status).map((page) => page.page_id), deck_rebuilt: needsDeck,
          })}\n`);
        } catch { /* Diagnostic failure does not undo a completed repair. */ }
      }
      return ensureWorkspaceFiles(latest.workspace_dir);
    }));
}

async function fingerprintAppWorkspaceDeckRender(
  workspace: AppWorkspaceResult,
  manifestPath: string,
): Promise<string> {
  const manifest = getPlainRecord(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  const slides = Array.isArray(manifest.slides) ? manifest.slides : [];
  const fingerprint = createHash("sha256").update(await readFile(manifestPath));
  const progress = normalizePageProgressJson(workspace.page_progress);
  const progressById = new Map(progress.pages.map((page) => [page.page_id, page]));
  for (const slideValue of slides) {
    const slide = getPlainRecord(slideValue);
    const pageId = normalizeString(slide.id);
    const page = progressById.get(pageId);
    if (!page) throw new Error(`Deck slide "${pageId}" has no Page Progress`);
    const current = await resolveCurrentPageSnapshot({ workspaceDir: workspace.workspace_dir,
      pageId, snapshotPath: page.last_html_path });
    fingerprint.update(current.html);
  }
  return fingerprint.digest("hex");
}

async function updateFinalDeckRenderIfActive(input: {
  workspaceDir: string;
  token: symbol;
  sourceFingerprint: string;
  patch: Partial<AppPageProgress["final_deck_render"]>;
}): Promise<boolean> {
  return withPageProgressWriteQueue(input.workspaceDir, async () => {
    const active = activeDeckRenders.get(path.normalize(input.workspaceDir));
    if (!active || active.token !== input.token || active.sourceFingerprint !== input.sourceFingerprint) {
      return false;
    }
    const workspace = await ensureWorkspaceFiles(input.workspaceDir);
    const current = normalizePageProgressJson(workspace.page_progress);
    const updatedAt = new Date().toISOString();
    const nextProgress: AppPageProgress = {
      ...current,
      final_deck_render: normalizeFinalDeckRenderState({
        ...current.final_deck_render,
        ...input.patch,
        source_fingerprint: input.sourceFingerprint,
        updated_at: updatedAt,
      }),
      updated_at: updatedAt,
    };
    await writePageProgressFile(workspace.files.page_progress, nextProgress);
    await touchWorkspaceTask(workspace, updatedAt);
    return true;
  });
}

async function performAppWorkspaceDeckHtmlRender(input: {
  workspace: AppWorkspaceResult;
  manifestPath: string;
  outputDir: string;
  expectedSourceFingerprint?: string;
}) {
  const manifestBytes = await readFile(input.manifestPath);
  const manifest = getPlainRecord(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  const slides = Array.isArray(manifest.slides) ? manifest.slides.map(getPlainRecord) : [];
  if (slides.length === 0) throw new Error("manifest.json does not contain slides");
  const progress = normalizePageProgressJson(input.workspace.page_progress);
  const progressById = new Map(progress.pages.map((page) => [page.page_id, page]));
  const pageHtml = await Promise.all(slides.map(async (slide) => {
    const pageId = normalizeString(slide.id).trim();
    const page = progressById.get(pageId);
    if (!page) throw new Error(`Page ${pageId || "(missing id)"} has no Page Progress`);
    return (await resolveCurrentPageSnapshot({ workspaceDir: input.workspace.workspace_dir,
      pageId, snapshotPath: page.last_html_path })).html;
  }));
  await mkdir(input.outputDir, { recursive: true });
  const title = normalizeString(manifest.title).trim() || input.workspace.workspace_id;
  const deckHtml = buildStaticDeckHtml({ title, pages: pageHtml });
  const capturedFingerprint = createHash("sha256").update(manifestBytes);
  for (const html of pageHtml) capturedFingerprint.update(html);
  const capturedVersion = capturedFingerprint.digest("hex");
  if ((input.expectedSourceFingerprint && capturedVersion !== input.expectedSourceFingerprint)
    || capturedVersion !== await fingerprintAppWorkspaceDeckRender(input.workspace, input.manifestPath)) {
    throw new Error("Current pages changed while assembling the Deck");
  }
  const deckHtmlPath = path.join(input.outputDir, `${input.workspace.workspace_id}-review-deck.html`);
  await atomicWriteTextFile(deckHtmlPath, deckHtml);
  return {
    outputDir: input.outputDir,
    deckHtmlPath,
    slideCount: slides.length,
    title,
    manifestPath: input.manifestPath,
  };
}

async function runAppWorkspaceDeckRenderTask(input: {
  workspaceDir: string;
  manifestPath: string;
  outputDir: string;
  sourceFingerprint: string;
  token: symbol;
}): Promise<void> {
  try {
    const workspace = await ensureWorkspaceFiles(input.workspaceDir);
    const result = await performAppWorkspaceDeckHtmlRender({
      workspace,
      manifestPath: input.manifestPath,
      outputDir: input.outputDir,
      expectedSourceFingerprint: input.sourceFingerprint,
    });
    const renderedAt = new Date().toISOString();
    await updateFinalDeckRenderIfActive({
      workspaceDir: input.workspaceDir,
      token: input.token,
      sourceFingerprint: input.sourceFingerprint,
      patch: {
        status: "completed",
        message: null,
        error: null,
        output_dir: result.outputDir,
        deck_html_path: result.deckHtmlPath,
        rendered_at: renderedAt,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateFinalDeckRenderIfActive({
      workspaceDir: input.workspaceDir,
      token: input.token,
      sourceFingerprint: input.sourceFingerprint,
      patch: { status: "failed", message, error: message },
    }).catch(() => undefined);
  } finally {
    const key = path.normalize(input.workspaceDir);
    if (activeDeckRenders.get(key)?.token === input.token) activeDeckRenders.delete(key);
  }
}

export async function renderAppWorkspaceDeckHtml(
  input: RenderAppWorkspaceDeckHtmlInput,
): Promise<SubmitAppWorkspaceDeckHtmlResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const manifestPath = readSelectedTemplateManifestPath(workspace);
  const outputDir = path.join(workspace.workspace_dir, "output", "app-render");
  const sourceFingerprint = await fingerprintAppWorkspaceDeckRender(workspace, manifestPath);
  const key = path.normalize(workspace.workspace_dir);
  const existing = activeDeckRenders.get(key);
  const submittedAt = new Date().toISOString();
  const persistedFinal = normalizePageProgressJson(workspace.page_progress).final_deck_render;
  if (existing?.sourceFingerprint === sourceFingerprint || (
    !existing &&
    persistedFinal.status === "completed" &&
    persistedFinal.source_fingerprint === sourceFingerprint &&
    persistedFinal.deck_html_path &&
    await fileExists(persistedFinal.deck_html_path)
  )) {
    return {
      status: "running",
      already_queued: true,
      workspace_dir: workspace.workspace_dir,
      manifest_path: manifestPath,
      output_dir: outputDir,
      source_fingerprint: sourceFingerprint,
      submitted_at: submittedAt,
    };
  }

  const token = Symbol("deck-render");
  activeDeckRenders.set(key, { token, sourceFingerprint });
  try {
    await updateFinalDeckRenderIfActive({
      workspaceDir: workspace.workspace_dir,
      token,
      sourceFingerprint,
      patch: {
        status: "running",
        message: "Rendering final Deck HTML.",
        error: null,
        output_dir: outputDir,
        deck_html_path: null,
        rendered_at: null,
      },
    });
  } catch (error) {
    if (activeDeckRenders.get(key)?.token === token) activeDeckRenders.delete(key);
    throw error;
  }
  void runAppWorkspaceDeckRenderTask({
    workspaceDir: workspace.workspace_dir,
    manifestPath,
    outputDir,
    sourceFingerprint,
    token,
  });
  return {
    status: "queued",
    already_queued: false,
    workspace_dir: workspace.workspace_dir,
    manifest_path: manifestPath,
    output_dir: outputDir,
    source_fingerprint: sourceFingerprint,
    submitted_at: submittedAt,
  };
}

async function assertExistingFile(filePath: string, label: string): Promise<string> {
  if (!filePath) {
    throw new Error(`${label} is missing`);
  }

  const normalizedPath = path.normalize(filePath);
  let fileStat;
  try {
    fileStat = await stat(normalizedPath);
  } catch {
    throw new Error(`${label} is unavailable: ${normalizedPath}`);
  }
  if (!fileStat.isFile()) {
    throw new Error(`${label} is not a file: ${normalizedPath}`);
  }

  return normalizedPath;
}

/** Resolve only the current rendered artifact; never execute Page Source here. */
export async function getAppWorkspacePageHtml(input: { workspace_dir: string; page_id?: string; batch_id?: string; candidate_id?: string; expected_preview_fingerprint?: string }) {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const progress = normalizePageProgressJson(workspace.page_progress);
  const page = input.page_id ? progress.pages.find((entry) => entry.page_id === input.page_id) : progress.pages[0];
  if (!page) throw new Error("Unknown preview page");
  let snapshot: { htmlPath: string; html: string };
  if (input.batch_id || input.candidate_id) {
    if (!input.batch_id || !input.candidate_id) throw new Error("Candidate preview requires both identities");
    const batch = await readBatch(workspace.workspace_dir, input.batch_id);
    if (batch.page_id !== page.page_id) throw new Error("Candidate page mismatch");
    const candidate = batch.candidates.find((entry) => entry.id === input.candidate_id);
    if (candidate?.status !== "ready" || !candidate.html_path) throw new Error("Candidate preview is not ready");
    snapshot = await readWorkspacePageSnapshot(workspace.workspace_dir, candidate.html_path);
  } else {
    snapshot = await resolveCurrentPageSnapshot({ workspaceDir: workspace.workspace_dir,
      pageId: page.page_id!, snapshotPath: page.last_html_path });
  }
  const { htmlPath: resolved, html } = snapshot;
  const previewFingerprint = await fingerprintPageSnapshot(workspace.workspace_dir, resolved, html);
  if (input.expected_preview_fingerprint && input.expected_preview_fingerprint !== previewFingerprint) throw new Error("Page preview version changed");
  return { workspace_dir: workspace.workspace_dir, page_id: page.page_id!, html_path: resolved, html,
    html_fingerprint: createHash("sha256").update(html).digest("hex"), preview_source_fingerprint: previewFingerprint };
}

export async function getAppWorkspacePageThumbnail(input: {
  workspace_dir: string; page_id?: string; expected_preview_fingerprint?: string;
}) {
  const page = await getAppWorkspacePageHtml(input);
  const thumbnail = await ensurePageThumbnail({ workspaceDir: page.workspace_dir, pageId: page.page_id,
    htmlPath: page.html_path, expectedFingerprint: page.preview_source_fingerprint });
  // A manual revision or candidate adoption may replace the current path while capturing.
  await getAppWorkspacePageHtml({ ...input, expected_preview_fingerprint: thumbnail.preview_source_fingerprint });
  return thumbnail;
}

/** Preview cache work never changes authoring progress or render attempts. */
export async function prepareAppWorkspacePagePreview(input: {
  workspace_dir: string; page_id: string; priority?: "foreground" | "background";
  kind?: "html" | "thumbnail"; retry?: boolean;
}) {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const page = normalizePageProgressJson(workspace.page_progress).pages.find((item) => item.page_id === input.page_id);
  if (!page) throw new Error("Unknown preview page");
  return submitPagePreviewPreparation({ workspaceDir: workspace.workspace_dir, pageId: input.page_id,
    snapshotPath: page.last_html_path, priority: input.priority, kind: input.kind, retry: input.retry });
}

export function getAppWorkspacePagePreviewPreparation(input: { workspace_dir: string; task_id: string }) {
  return getPagePreviewPreparationStatus({ workspaceDir: input.workspace_dir, taskId: input.task_id });
}

export async function* getAppWorkspacePagePreviewFallbacks(input: { workspace_dir: string; page_id: string }) {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const page = normalizePageProgressJson(workspace.page_progress).pages.find((page) => page.page_id === input.page_id);
  if (!page) throw new Error("Unknown preview page");
  yield* readPagePreviewFallbacks({ workspaceDir: workspace.workspace_dir, pageId: input.page_id,
    snapshotPath: page.last_html_path, screenshotPath: page.last_screenshot_path,
    aspectRatio: normalizePresentationRequirements(workspace.requirements).selections.aspect_ratio });
}

export async function getRenderedAppWorkspaceDeckHtml(
  input: RenderAppWorkspaceDeckHtmlInput,
): Promise<RenderAppWorkspaceDeckHtmlResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const manifestPath = readSelectedTemplateManifestPath(workspace);
  const manifestRecord = getPlainRecord(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  const manifestSlides = Array.isArray(manifestRecord.slides)
    ? manifestRecord.slides.map((slide) => getPlainRecord(slide))
    : [];
  const progress = normalizePageProgressJson(workspace.page_progress);
  if ((!input.allow_partial && progress.final_deck_render.status !== "completed") || progress.pages.length === 0) {
    throw new Error("Rendered deck pages are unavailable");
  }
  if (manifestSlides.length !== progress.pages.length) {
    throw new Error("Rendered deck page count does not match the selected template manifest");
  }

  // The review list is metadata. In particular, a restored Workspace may have
  // no output/ at all, and resolving even one snapshot can start Chrome.
  if (input.allow_partial) {
    const slides = progress.pages.map((page, index) => {
      const manifestSlide = manifestSlides[index] ?? {};
      const pageId = page.page_id;
      if (!pageId || pageId !== readPageIdFromManifestSlide(manifestSlide)) {
        throw new Error(`Rendered deck page ${index + 1} does not match the selected template manifest`);
      }
      return {
        slide_id: pageId,
        layout_id: normalizeString(manifestSlide.layout_id),
        title: normalizeString(manifestSlide.title) || pageId,
        html_path: "",
        preview_unavailable: true,
        screenshot_path: "",
        render_source_fingerprint: page.render_source_sha256,
        preview_source_fingerprint: "",
        // This is an invalidation marker, not a claim that a snapshot matches
        // the current source. The page reader computes the real fingerprint.
        preview_version: page.updated_at ?? progress.updated_at ?? "",
        speaker_note: normalizeString(manifestSlide.speaker_note),
        manually_edited: false,
      };
    });
    return {
      workspace_dir: workspace.workspace_dir,
      manifest_path: manifestPath,
      output_dir: progress.final_deck_render.output_dir ?? "",
      deck_html_path: progress.final_deck_render.deck_html_path ?? "",
      slides,
      slide_count: slides.length,
      title: normalizeString(manifestRecord.title),
      rendered_at: progress.final_deck_render.rendered_at ?? progress.updated_at ?? "",
    };
  }

  const slides = await Promise.all(
    progress.pages.map(async (page, index) => {
      const manifestSlide = manifestSlides[index] ?? {};
      const pageId = page.page_id;
      const manifestPageId = readPageIdFromManifestSlide(manifestSlide);
      if (!pageId || pageId !== manifestPageId) {
        throw new Error(`Rendered deck page ${index + 1} does not match the selected template manifest`);
      }

      const current = await resolveCurrentPageSnapshot({ workspaceDir: workspace.workspace_dir,
        pageId, snapshotPath: page.last_html_path }).then(async (snapshot) => ({ ...snapshot,
          fingerprint: await fingerprintPageSnapshot(workspace.workspace_dir, snapshot.htmlPath, snapshot.html)
        })).catch((error) => { if (!input.allow_partial) throw error; return null; });
      return {
        slide_id: pageId,
        layout_id: normalizeString(manifestSlide.layout_id),
        title: normalizeString(manifestSlide.title) || pageId,
        html_path: current?.htmlPath ?? "",
        ...(current ? {} : { preview_unavailable: true }),
        screenshot_path: "",
        render_source_fingerprint: page.render_source_sha256,
        preview_source_fingerprint: current?.fingerprint ?? "",
        speaker_note: normalizeString(manifestSlide.speaker_note),
        manually_edited: Boolean(current?.manual),
      };
    }),
  );

  return {
    workspace_dir: workspace.workspace_dir,
    manifest_path: manifestPath,
    output_dir: progress.final_deck_render.output_dir ?? "",
    deck_html_path: input.allow_partial ? progress.final_deck_render.deck_html_path ?? "" : await assertExistingFile(
      progress.final_deck_render.deck_html_path ?? "",
      "Rendered Deck HTML",
    ),
    slides,
    slide_count: slides.length,
    title: normalizeString(manifestRecord.title),
    rendered_at: progress.final_deck_render.rendered_at ?? progress.updated_at ?? "",
  };
}

async function recordWorkspaceExport(
  workspace: AppWorkspaceResult,
  artifactType: "pptx" | "pdf",
  artifactPath: string,
  extra?: Record<string, unknown>,
): Promise<AppWorkspaceResult> {
  return withExportArtifactWriteQueue(workspace.workspace_dir, async () => {
    const current = await ensureWorkspaceFiles(workspace.workspace_dir);
    const updatedAt = new Date().toISOString();
    const existing =
      current.task && typeof current.task === "object" && !Array.isArray(current.task)
        ? (current.task as Record<string, unknown>)
        : {};
    const existingArtifacts =
      existing.artifacts && typeof existing.artifacts === "object" && !Array.isArray(existing.artifacts)
        ? (existing.artifacts as Record<string, unknown>)
        : {};

    await writeJsonFile(current.files.task, {
      ...existing,
      updated_at: updatedAt,
      artifacts: {
        ...existingArtifacts,
        [artifactType]: {
          path: artifactPath,
          updated_at: updatedAt,
          ...extra,
        },
      },
    });

    return ensureWorkspaceFiles(current.workspace_dir);
  });
}

async function clearCurrentPptxArtifact(workspace: AppWorkspaceResult, pptxPath: string): Promise<void> {
  await rm(pptxPath, { force: true });
  const task = getPlainRecord(workspace.task);
  const artifacts = getPlainRecord(task.artifacts);
  delete artifacts.pptx;
  await writeJsonFile(workspace.files.task, { ...task, artifacts, updated_at: new Date().toISOString() });
}

async function runPptxExportJob(job: AppPptxExportJob): Promise<void> {
  let activeJob = job;
  try {
    const workspace = await ensureWorkspaceFiles(job.workspace_dir);
    const progress = normalizePageProgressJson(workspace.page_progress);
    const deckHtmlPath = progress.final_deck_render.deck_html_path;
    if (!deckHtmlPath) throw new Error("Final Deck Render has no deck.html. Rebuild the Deck before exporting PPTX.");
    const normalizedDeckPath = path.normalize(deckHtmlPath);
    const renderOutputDir = progress.final_deck_render.output_dir;
    if (!renderOutputDir || !isPathWithin(normalizedDeckPath, path.normalize(renderOutputDir))) {
      throw new Error("Recorded deck.html is outside the Final Deck Render output directory");
    }

    const materializedDeckHtml = await injectWorkspaceManagedFontCss(
      workspace.workspace_dir,
      await readFile(normalizedDeckPath, "utf8"),
    );
    await writeFile(normalizedDeckPath, materializedDeckHtml, "utf8");
    const fontWarnings = await managedFontVariantWarningsForHtml(
      workspace.workspace_dir,
      materializedDeckHtml,
    );
    await writePptxExportJob({
      ...job,
      status: "validating",
      message: fontWarnings.length > 0
        ? "Validating Deck HTML. Some managed font variants may be simulated."
        : "Validating Deck HTML.",
      percent: 15,
      deck_html_path: normalizedDeckPath,
      warnings: fontWarnings,
      warning_count: fontWarnings.length,
    });
    activeJob = await writePptxExportJob({
      ...job,
      status: "converting",
      message: fontWarnings.length > 0
        ? "Generating PPTX with managed font variant warnings."
        : "Generating PPTX.",
      percent: 30,
      current_page: null,
      total_pages: job.page_numbers?.length ?? progress.pages.length,
      export_phase: null,
      deck_html_path: normalizedDeckPath,
      warnings: fontWarnings,
      warning_count: fontWarnings.length,
    });
    const summary = await convertDeckHtmlToPptx({
      htmlPath: normalizedDeckPath,
      outputPath: job.pptx_path,
      title: (await getWorkspaceSummary(workspace.workspace_dir)).title,
      expectedSlideCount: progress.pages.length,
      ...(job.page_numbers === null ? {} : { pageNumbers: job.page_numbers }),
      onPageProgress: async (pageProgress) => {
        const percent = pageProgress.phase === "merging"
          ? 92
          : 30 + Math.round(((pageProgress.currentPage - 1) / pageProgress.totalPages) * 60);
        activeJob = await writePptxExportJob({
          ...activeJob,
          status: "converting",
          message: pageProgress.phase === "merging"
            ? `Merging ${pageProgress.totalPages} rendered PPTX pages.`
            : `Rendering page ${pageProgress.currentPage} of ${pageProgress.totalPages}.`,
          percent,
          current_page: pageProgress.currentPage,
          total_pages: pageProgress.totalPages,
          export_phase: pageProgress.phase,
        });
      },
    });
    await rename(summary.outputPath, job.pptx_path);
    await recordWorkspaceExport(await ensureWorkspaceFiles(job.workspace_dir), "pptx", job.pptx_path);
    const fontEmbedWarnings = summary.fontEmbedWarnings;
    await writePptxExportJob({
      ...activeJob,
      status: "completed",
      message: fontEmbedWarnings.length > 0
        ? "PPTX export completed, but some fonts could not be embedded."
        : fontWarnings.length > 0
          ? "PPTX export completed with managed font variant warnings."
          : "PPTX export completed.",
      percent: 100,
      deck_html_path: normalizedDeckPath,
      completed_at: new Date().toISOString(),
      warnings: fontWarnings,
      font_embed_warnings: fontEmbedWarnings,
      warning_count: fontWarnings.length + fontEmbedWarnings.length + summary.warningCount,
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error && error.stack ? error.stack : undefined;
    await writePptxExportJob({
      ...activeJob,
      status: "failed",
      message,
      percent: 100,
      completed_at: new Date().toISOString(),
      error: {
        message,
        ...(stack ? { stack } : {}),
      },
    });
  }
}

export async function startAppPptxExport(
  input: StartAppPptxExportInput,
): Promise<AppPptxExportJob> {
  let workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const current = await getAppPptxExportStatus({
    workspace_dir: workspace.workspace_dir,
  });

  if (["queued", "validating", "converting"].includes(current.status)) {
    return current;
  }
  workspace = await repairCompletedWorkspaceArtifacts(workspace);

  const progress = normalizePageProgressJson(workspace.page_progress);
  const requestedPageNumbers = input.page_numbers === undefined
    ? null
    : [...new Set(input.page_numbers)].sort((left, right) => left - right);
  if (requestedPageNumbers && (
    requestedPageNumbers.length === 0 ||
    requestedPageNumbers.some((pageNumber) => !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > progress.pages.length)
  )) {
    throw new Error('"page_numbers" must contain valid one-based pages from this deck');
  }
  // A view-only backup cannot authorize export of missing current content.
  await Promise.all(progress.pages.filter((_, index) => !requestedPageNumbers || requestedPageNumbers.includes(index + 1))
    .map((page) => resolveCurrentPageSnapshot({ workspaceDir: workspace.workspace_dir,
      pageId: page.page_id!, snapshotPath: page.last_html_path })));
  const deckHtmlPath = progress.final_deck_render.deck_html_path;
  const fontWarnings = deckHtmlPath && await fileExists(deckHtmlPath)
    ? await managedFontVariantWarningsForHtml(
        workspace.workspace_dir,
        await readFile(deckHtmlPath, "utf8"),
      )
    : [];
  const job = createPptxExportJob(workspace.workspace_dir, {
    message: fontWarnings.length > 0
      ? "Waiting to export PPTX. Some managed font variants may be simulated."
      : "Waiting to export PPTX.",
    warnings: fontWarnings,
    warning_count: fontWarnings.length,
    page_numbers: requestedPageNumbers,
    total_pages: requestedPageNumbers?.length ?? progress.pages.length,
  });
  await clearCurrentPptxArtifact(workspace, job.pptx_path);
  activePptxExportJobIds.add(job.job_id);
  const written = await writePptxExportJob(job);

  pptxExportQueue = pptxExportQueue
    .catch(() => undefined)
    .then(() => runPptxExportJob(written))
    .finally(() => activePptxExportJobIds.delete(job.job_id));

  process.stderr.write(`[snapshot-trigger] #3 pptx-export workspace_id=${path.basename(workspace.workspace_dir)}\n`);
  publishWorkspaceSnapshotFromTrigger(workspace.workspace_dir);
  return written;
}

export async function getAppPptxExportStatus(input: {
  workspace_dir: string;
}): Promise<AppPptxExportJob> {
  const workspaceDir = normalizeWorkspaceDir(input.workspace_dir);
  const paths = buildPptxExportPaths(workspaceDir);
  const existing = await readJsonFileIfExists(paths.statusPath);

  if (existing === null) {
    return createPptxExportJob(workspaceDir, {
      job_id: "",
      status: "idle",
      message: "",
      percent: 0,
      started_at: null,
      updated_at: null,
      status_path: paths.statusPath,
      output_dir: paths.outputDir,
      pptx_path: paths.pptxPath,
    });
  }

  const normalized = normalizePptxExportJob(existing, workspaceDir);
  if (
    ["queued", "validating", "converting"].includes(normalized.status)
    && !activePptxExportJobIds.has(normalized.job_id)
  ) {
    const interrupted = {
      ...normalized,
      status: "failed" as const,
      message: "PPTX export was interrupted because the engine process restarted.",
      percent: 100,
      completed_at: new Date().toISOString(),
      error: {
        message: "PPTX export was interrupted because the engine process restarted.",
      },
    };
    await writeJsonFile(paths.statusPath, interrupted);
    await rm(`${paths.pptxPath}.tmp`, { force: true });
    return interrupted;
  }
  return normalized;
}

const EXPORT_ARTIFACT_PUBLISH_STATUSES: AppExportArtifactPublishStatus[] = [
  "idle",
  "queued",
  "preparing",
  "uploading",
  "committing",
  "completed",
  "failed",
];

function createExportArtifactPublishJob(
  workspaceDir: string,
  artifactType: "pptx" | "pdf",
  patch: Partial<AppExportArtifactPublishJob> = {},
): AppExportArtifactPublishJob {
  const paths = buildExportArtifactPublishPaths(workspaceDir, artifactType);
  const now = new Date().toISOString();
  return {
    version: 1,
    job_id: `${path.basename(workspaceDir)}-${artifactType}-${Date.now()}-${randomUUID().slice(0, 8)}`,
    status: "queued",
    message: "Waiting to publish the export artifact.",
    percent: 5,
    workspace_dir: workspaceDir,
    artifact_type: artifactType,
    status_path: paths.statusPath,
    source_updated_at: "",
    source_sha256: "",
    size_bytes: 0,
    started_at: now,
    updated_at: now,
    completed_at: null,
    artifact: null,
    mirror: null,
    error: null,
    ...patch,
  };
}

function normalizeExportArtifactPublishJob(
  value: unknown,
  workspaceDir: string,
  artifactType: "pptx" | "pdf",
): AppExportArtifactPublishJob {
  const existing = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<AppExportArtifactPublishJob>
    : {};
  const paths = buildExportArtifactPublishPaths(workspaceDir, artifactType);
  const status = EXPORT_ARTIFACT_PUBLISH_STATUSES.includes(existing.status as AppExportArtifactPublishStatus)
    ? existing.status as AppExportArtifactPublishStatus
    : "idle";
  const artifactValue = existing.artifact && typeof existing.artifact === "object" && !Array.isArray(existing.artifact)
    ? existing.artifact as unknown as Record<string, unknown>
    : null;
  const artifact = artifactValue &&
      typeof artifactValue.workspace_dir === "string" &&
      typeof artifactValue.workspace_id === "string" &&
      typeof artifactValue.title === "string" &&
      (artifactValue.artifact_type === "pptx" || artifactValue.artifact_type === "pdf") &&
      artifactValue.artifact_type === artifactType &&
      typeof artifactValue.path === "string" &&
      typeof artifactValue.filename === "string" &&
      typeof artifactValue.updated_at === "string"
    ? {
        workspace_dir: artifactValue.workspace_dir,
        workspace_id: artifactValue.workspace_id,
        title: artifactValue.title,
        artifact_type: artifactType,
        path: artifactValue.path,
        filename: artifactValue.filename,
        updated_at: artifactValue.updated_at,
        mirror: normalizeExportArtifactMirror(artifactValue.mirror),
      } satisfies AppExportArtifactInfo
    : null;
  return createExportArtifactPublishJob(workspaceDir, artifactType, {
    ...existing,
    version: 1,
    job_id: typeof existing.job_id === "string" ? existing.job_id : "",
    status,
    message: typeof existing.message === "string" ? existing.message : "",
    percent: typeof existing.percent === "number" ? existing.percent : 0,
    status_path: paths.statusPath,
    source_updated_at: typeof existing.source_updated_at === "string" ? existing.source_updated_at : "",
    source_sha256: typeof existing.source_sha256 === "string" ? existing.source_sha256 : "",
    size_bytes: typeof existing.size_bytes === "number" ? existing.size_bytes : 0,
    started_at: typeof existing.started_at === "string" ? existing.started_at : null,
    updated_at: typeof existing.updated_at === "string" ? existing.updated_at : null,
    completed_at: typeof existing.completed_at === "string" ? existing.completed_at : null,
    artifact,
    mirror: existing.mirror && typeof existing.mirror === "object" && !Array.isArray(existing.mirror)
      ? normalizeExportArtifactMirror(existing.mirror)
      : null,
    error: existing.error && typeof existing.error === "object" && !Array.isArray(existing.error)
      ? existing.error as AppExportArtifactPublishJob["error"]
      : null,
  });
}

async function withExportArtifactPublishStatusQueue<T>(
  workspaceDir: string,
  artifactType: "pptx" | "pdf",
  operation: () => Promise<T>,
): Promise<T> {
  const queueKey = `${path.normalize(workspaceDir)}\0${artifactType}`;
  const previous = exportArtifactPublishStatusQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  exportArtifactPublishStatusQueues.set(queueKey, current);
  try {
    return await current;
  } finally {
    if (exportArtifactPublishStatusQueues.get(queueKey) === current) {
      exportArtifactPublishStatusQueues.delete(queueKey);
    }
  }
}

async function withExportArtifactPublishStartQueue<T>(
  workspaceDir: string,
  artifactType: "pptx" | "pdf",
  operation: () => Promise<T>,
): Promise<T> {
  const queueKey = `${path.normalize(workspaceDir)}\0${artifactType}`;
  const previous = exportArtifactPublishStartQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  exportArtifactPublishStartQueues.set(queueKey, current);
  try {
    return await current;
  } finally {
    if (exportArtifactPublishStartQueues.get(queueKey) === current) {
      exportArtifactPublishStartQueues.delete(queueKey);
    }
  }
}

export async function writeAppExportArtifactPublishJob(
  job: AppExportArtifactPublishJob,
): Promise<AppExportArtifactPublishJob> {
  return withExportArtifactPublishStatusQueue(job.workspace_dir, job.artifact_type, async () => {
    const normalized = normalizeExportArtifactPublishJob(job, job.workspace_dir, job.artifact_type);
    const updated = {
      ...normalized,
      updated_at: new Date().toISOString(),
    };
    await atomicWriteJsonFile(updated.status_path, updated);
    return normalizeExportArtifactPublishJob(updated, updated.workspace_dir, updated.artifact_type);
  });
}

export async function getAppExportArtifactPublishStatus(input: {
  workspace_dir: string;
  artifact_type: "pptx" | "pdf";
}): Promise<AppExportArtifactPublishJob> {
  const workspaceDir = normalizeWorkspaceDir(input.workspace_dir);
  const paths = buildExportArtifactPublishPaths(workspaceDir, input.artifact_type);
  const existing = await readJsonFileIfExists(paths.statusPath);
  if (existing === null) {
    return createExportArtifactPublishJob(workspaceDir, input.artifact_type, {
      job_id: "",
      status: "idle",
      message: "",
      percent: 0,
      started_at: null,
      updated_at: null,
      status_path: paths.statusPath,
    });
  }
  return normalizeExportArtifactPublishJob(existing, workspaceDir, input.artifact_type);
}

export async function markAppExportArtifactPublishJobInterrupted(
  job: AppExportArtifactPublishJob,
): Promise<AppExportArtifactPublishJob> {
  return writeAppExportArtifactPublishJob({
    ...job,
    status: "failed",
    message: "Export artifact publication was interrupted because the engine process restarted.",
    percent: 100,
    completed_at: new Date().toISOString(),
    error: {
      message: "Export artifact publication was interrupted because the engine process restarted.",
      interrupted: true,
    },
  });
}

export async function startAppExportArtifactPublish(
  input: StartAppExportArtifactPublishInput,
): Promise<AppExportArtifactPublishJob> {
  return withExportArtifactPublishStartQueue(input.workspace_dir, input.artifact_type, async () => {
    const workspace = await ensureWorkspaceFiles(input.workspace_dir);
    const current = await getAppExportArtifactPublishStatus({
      workspace_dir: workspace.workspace_dir,
      artifact_type: input.artifact_type,
    });
    if (["queued", "preparing", "uploading", "committing"].includes(current.status)) {
      return current;
    }

    const mirrorStatus = await getAppExportArtifactMirrorStatus({
      workspace_dir: workspace.workspace_dir,
      artifact_type: input.artifact_type,
    });
    if (mirrorStatus.status === "ready" && mirrorStatus.mirror) {
      return writeAppExportArtifactPublishJob(createExportArtifactPublishJob(
        workspace.workspace_dir,
        input.artifact_type,
        {
          status: "completed",
          message: "Export artifact mirror is ready.",
          percent: 100,
          source_updated_at: mirrorStatus.artifact.updated_at,
          source_sha256: mirrorStatus.mirror.source_sha256,
          size_bytes: mirrorStatus.mirror.size_bytes,
          completed_at: mirrorStatus.mirror.published_at,
          artifact: mirrorStatus.artifact,
          mirror: mirrorStatus.mirror,
        },
      ));
    }

    process.stderr.write(
      `[snapshot-trigger] #3 publish workspace_id=${path.basename(workspace.workspace_dir)} artifact_type=${input.artifact_type}\n`,
    );
    publishWorkspaceSnapshotFromTrigger(workspace.workspace_dir);
    const sourceSha256 = await sha256FileHex(mirrorStatus.artifact.path);
    return writeAppExportArtifactPublishJob(createExportArtifactPublishJob(
      workspace.workspace_dir,
      input.artifact_type,
      {
        source_updated_at: mirrorStatus.artifact.updated_at,
        source_sha256: sourceSha256,
        size_bytes: (await stat(mirrorStatus.artifact.path)).size,
        artifact: mirrorStatus.artifact,
        mirror: null,
      },
    ));
  });
}

export async function exportAppPdf(
  input: ExportAppPdfInput,
): Promise<ExportAppPdfResult> {
  const workspace = await repairCompletedWorkspaceArtifacts(await ensureWorkspaceFiles(input.workspace_dir));
  const outputDir = path.join(workspace.workspace_dir, "output");
  const pdfPath = path.join(outputDir, "deck.pdf");
  const exportedAt = new Date().toISOString();
  const pagesRecord =
    workspace.pages && typeof workspace.pages === "object" && !Array.isArray(workspace.pages)
      ? (workspace.pages as Record<string, unknown>)
      : null;
  const existingHtmlPaths = Array.isArray(pagesRecord?.pages)
    ? pagesRecord.pages
        .map((page) =>
          page && typeof page === "object" && !Array.isArray(page) && typeof (page as { html_path?: unknown }).html_path === "string"
            ? (page as { html_path: string }).html_path
            : "",
        )
        .filter((htmlPath): htmlPath is string => htmlPath.length > 0)
    : [];
  const progressPages = normalizePageProgressJson(workspace.page_progress).pages;
  const htmlPaths = progressPages.length > 0
    ? await Promise.all(progressPages.map(async (page) => (await resolveCurrentPageSnapshot({
        workspaceDir: workspace.workspace_dir, pageId: page.page_id!, snapshotPath: page.last_html_path,
      })).htmlPath))
    : existingHtmlPaths;
  if (htmlPaths.length === 0) {
    throw new Error("No rendered page HTML is available for PDF export. Render the pages first.");
  }
  const selectedHtmlPaths = selectPdfSlideHtmlPaths(htmlPaths, input.page_numbers);

  await mkdir(outputDir, { recursive: true });
  await createPdfFromSlideHtmlPaths(selectedHtmlPaths, pdfPath);
  await touchWorkspaceTask(workspace, exportedAt);

  process.stderr.write(`[snapshot-trigger] #3 pdf-export workspace_id=${path.basename(workspace.workspace_dir)}\n`);
  publishWorkspaceSnapshotFromTrigger(workspace.workspace_dir);

  return {
    workspace_dir: workspace.workspace_dir,
    manifest_path: readSelectedTemplateManifestPath(workspace),
    html_path: selectedHtmlPaths[0] ?? "",
    pdf_path: pdfPath,
    output_dir: outputDir,
    exported_at: exportedAt,
  };
}

export async function recordAppPdfExport(
  input: RecordAppPdfExportInput,
): Promise<AppWorkspaceResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  return recordWorkspaceExport(workspace, "pdf", input.pdf_path);
}

export async function getAppExportArtifact(
  input: GetAppExportArtifactInput,
): Promise<AppExportArtifactInfo> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const artifactType = input.artifact_type;
  if (artifactType !== "pptx" && artifactType !== "pdf") {
    throw new Error('"artifact_type" must be "pptx" or "pdf"');
  }

  const task =
    workspace.task && typeof workspace.task === "object" && !Array.isArray(workspace.task)
      ? (workspace.task as Record<string, unknown>)
      : {};
  const artifacts =
    task.artifacts && typeof task.artifacts === "object" && !Array.isArray(task.artifacts)
      ? (task.artifacts as Record<string, unknown>)
      : {};
  const artifact =
    artifacts[artifactType] && typeof artifacts[artifactType] === "object" && !Array.isArray(artifacts[artifactType])
      ? (artifacts[artifactType] as Record<string, unknown>)
      : {};
  const artifactPath = typeof artifact.path === "string" ? path.normalize(artifact.path) : "";

  if (!artifactPath) {
    throw new Error(`No ${artifactType.toUpperCase()} export artifact is recorded for this workspace`);
  }
  assertAbsolutePath(artifactPath, `${artifactType}_path`);
  const artifactStat = await stat(artifactPath);
  if (!artifactStat.isFile()) {
    throw new Error(`${artifactType.toUpperCase()} export artifact is not a file: ${artifactPath}`);
  }

  const workspaceTitle = (await getWorkspaceSummary(workspace.workspace_dir)).title;
  const updatedAt = typeof artifact.updated_at === "string" && artifact.updated_at.length > 0
    ? artifact.updated_at
    : artifactStat.mtime.toISOString();

  return {
    workspace_dir: workspace.workspace_dir,
    workspace_id: workspace.workspace_id,
    title: workspaceTitle,
    artifact_type: artifactType,
    path: artifactPath,
    filename: `${sanitizeFileNameBase(workspaceTitle || workspace.workspace_id)}.${artifactType}`,
    updated_at: updatedAt,
    mirror: normalizeExportArtifactMirror(artifact.mirror),
  };
}

function normalizeExportArtifactMirror(value: unknown): AppExportArtifactMirror | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sizeBytes = Number(record.size_bytes);
  if (
    record.provider !== "aps.files" ||
    record.scope !== "user" ||
    typeof record.path !== "string" ||
    record.path.length === 0 ||
    typeof record.etag !== "string" ||
    !Number.isFinite(sizeBytes) ||
    sizeBytes < 0 ||
    typeof record.content_type !== "string" ||
    record.content_type.length === 0 ||
    typeof record.content_disposition !== "string" ||
    !/^attachment(?:;|$)/i.test(record.content_disposition) ||
    typeof record.source_updated_at !== "string" ||
    record.source_updated_at.length === 0 ||
    typeof record.source_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(record.source_sha256) ||
    typeof record.published_at !== "string" ||
    record.published_at.length === 0
  ) {
    return null;
  }
  return {
    provider: "aps.files",
    scope: "user",
    path: record.path,
    etag: record.etag,
    size_bytes: Math.floor(sizeBytes),
    content_type: record.content_type,
    content_disposition: record.content_disposition,
    source_updated_at: record.source_updated_at,
    source_sha256: record.source_sha256.toLowerCase(),
    published_at: record.published_at,
  };
}

function exportArtifactContentType(artifactType: "pptx" | "pdf"): string {
  return artifactType === "pptx"
    ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    : "application/pdf";
}

async function sha256FileHex(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function sourceFileChanged(
  before: { size: number; mtimeMs: number },
  after: { size: number; mtimeMs: number },
): boolean {
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

async function resolveDiagnosticBundleWorkspace(workspaceDir: string): Promise<{
  workspace_dir: string;
  workspace_id: string;
}> {
  const normalizedWorkspaceDir = normalizeWorkspaceDir(workspaceDir);
  const workspaceInfo = await lstat(normalizedWorkspaceDir);
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) {
    throw new Error('"workspace_dir" must point to a real Workspace directory');
  }

  const [resolvedRoot, resolvedWorkspaceDir] = await Promise.all([
    realpath(WORKSPACE_ROOT),
    realpath(normalizedWorkspaceDir),
  ]);
  const relativePath = path.relative(resolvedRoot, resolvedWorkspaceDir);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    path.basename(resolvedWorkspaceDir) !== path.basename(normalizedWorkspaceDir)
  ) {
    throw new Error('"workspace_dir" must resolve to its named directory under the default PPT workspace root');
  }

  return {
    workspace_dir: resolvedWorkspaceDir,
    workspace_id: path.basename(resolvedWorkspaceDir),
  };
}

/**
 * Idempotently generate a snapshot of the authoritative Workspace sources.
 * Fires from engine-side trigger points directly; also exposed as a tool so the
 * frontend can snapshot on navigation (#4).
 */
export async function publishAppWorkspaceSnapshot(input: {
  workspace_dir: string;
}): Promise<MaybePublishWorkspaceSnapshotResult> {
  return maybePublishWorkspaceSnapshot({ workspace_dir: input.workspace_dir });
}

export async function markAppWorkspaceSnapshotDirty(input: {
  workspace_dir: string;
}): Promise<Awaited<ReturnType<typeof markWorkspaceSnapshotDirty>>> {
  return markWorkspaceSnapshotDirty({ workspace_dir: input.workspace_dir });
}

export async function getAppWorkspaceSnapshotSyncState(input: {
  workspace_dir: string;
}): Promise<Awaited<ReturnType<typeof getWorkspaceSnapshotSyncState>>> {
  return getWorkspaceSnapshotSyncState({ workspace_dir: input.workspace_dir });
}

export async function getAppWorkspaceSnapshotInfo(input: {
  workspace_dir: string;
  revision?: string;
}): Promise<ReadWorkspaceSnapshotInfoResult> {
  return readWorkspaceSnapshotInfo({ workspace_dir: input.workspace_dir, revision: input.revision });
}

export async function recordAppWorkspaceSnapshotRetry(
  input: RecordWorkspaceSnapshotRetryInput,
) {
  return recordWorkspaceSnapshotRetry(input);
}

export async function verifyAppWorkspaceSnapshotZip(
  input: VerifyWorkspaceSnapshotZipInput,
): Promise<VerifyWorkspaceSnapshotZipResult> {
  return verifyWorkspaceSnapshotZip(input);
}

export async function startAppWorkspaceSnapshotPublish(
  input: StartWorkspaceSnapshotPublishInput,
): Promise<WorkspaceSnapshotPublishState> {
  return startWorkspaceSnapshotPublish({ workspace_dir: input.workspace_dir });
}

export async function getAppWorkspaceSnapshotPublishStatus(input: {
  workspace_dir: string;
}): Promise<WorkspaceSnapshotPublishState> {
  return getWorkspaceSnapshotPublishStatus({ workspace_dir: input.workspace_dir });
}

export async function writeAppWorkspaceSnapshotPublish(input: {
  workspace_dir: string;
  publish: WorkspaceSnapshotPublishState;
}): Promise<WorkspaceSnapshotPublishState> {
  return writeWorkspaceSnapshotPublish({ workspace_dir: input.workspace_dir, publish: input.publish });
}

export async function commitAppWorkspaceSnapshotPublish(
  input: CommitWorkspaceSnapshotPublishInput,
): Promise<WorkspaceSnapshotPublishState> {
  return commitWorkspaceSnapshotPublish(input);
}

export async function markAppWorkspaceSnapshotPublishJobInterrupted(input: {
  workspace_dir: string;
}): Promise<WorkspaceSnapshotPublishState> {
  return markWorkspaceSnapshotPublishJobInterrupted({ workspace_dir: input.workspace_dir });
}

export async function regenerateAppWorkspaceSnapshot(input: {
  workspace_dir: string;
}): Promise<WorkspaceSnapshotPublishState> {
  return regenerateWorkspaceSnapshot({ workspace_dir: input.workspace_dir });
}

export async function startAppWorkspaceRestoreSnapshot(
  input: StartWorkspaceSnapshotRestoreInput,
): Promise<WorkspaceSnapshotRestoreState> {
  return startWorkspaceSnapshotRestore(input);
}

export async function getAppWorkspaceLocalSnapshotFingerprint(input: {
  workspace_dir: string;
}): Promise<WorkspaceLocalSnapshotFingerprint> {
  return getWorkspaceLocalSnapshotFingerprint({ workspace_dir: input.workspace_dir });
}

export function classifyAppWorkspaceSnapshotReconcile(input: {
  local_source_sha256: string | null;
  baseline_source_sha256: string | null;
  remote_source_sha256: string | null;
  local_fingerprint_algo?: number | null;
  baseline_fingerprint_algo?: number | null;
  remote_fingerprint_algo?: number | null;
}): WorkspaceSnapshotReconcileDecision {
  return classifyWorkspaceSnapshotReconcile(input);
}

export async function getAppWorkspaceSnapshotRestoreStatus(input: {
  workspace_dir: string;
}): Promise<WorkspaceSnapshotRestoreState> {
  return getWorkspaceSnapshotRestoreStatus({ workspace_dir: input.workspace_dir });
}

export async function backupAppWorkspaceAsLocalCopy(
  input: BackupWorkspaceAsLocalCopyInput,
): Promise<BackupWorkspaceAsLocalCopyResult> {
  return backupWorkspaceAsLocalCopy(input);
}

export async function writeAppWorkspaceSnapshotRestore(input: {
  workspace_dir: string;
  restore: WorkspaceSnapshotRestoreState;
}): Promise<WorkspaceSnapshotRestoreState> {
  return writeWorkspaceSnapshotRestore({ workspace_dir: input.workspace_dir, restore: input.restore });
}

export async function extractAppWorkspaceSnapshotZip(
  input: ExtractWorkspaceSnapshotZipInput,
): Promise<ExtractWorkspaceSnapshotZipResult> {
  return extractWorkspaceSnapshotZip(input);
}

export async function commitAppWorkspaceSnapshotRestore(
  input: CommitWorkspaceSnapshotRestoreInput,
): Promise<WorkspaceSnapshotRestoreState> {
  return commitWorkspaceSnapshotRestore(input);
}

export async function markAppWorkspaceSnapshotRestoreJobInterrupted(input: {
  workspace_dir: string;
}): Promise<WorkspaceSnapshotRestoreState> {
  return markWorkspaceSnapshotRestoreJobInterrupted({ workspace_dir: input.workspace_dir });
}

export async function startAppWorkspaceSnapshotRebuild(input: {
  workspace_dir: string;
  restore_job_id: string;
  lifecycle_epoch: number;
  source_sha256: string;
}): Promise<WorkspaceSnapshotRebuildState> {
  return startWorkspaceSnapshotRebuild(input);
}

export async function writeAppWorkspaceSnapshotRebuild(input: {
  workspace_dir: string;
  rebuild: WorkspaceSnapshotRebuildState;
}): Promise<WorkspaceSnapshotRebuildState> {
  return writeWorkspaceSnapshotRebuild(input);
}

export async function prepareAppWorkspaceDiagnosticBundle(
  input: PrepareAppWorkspaceDiagnosticBundleInput,
): Promise<AppWorkspaceDiagnosticBundleSnapshot> {
  const workspace = await resolveDiagnosticBundleWorkspace(input.workspace_dir);
  const archiveDir = path.join(os.tmpdir(), "ppt-engine-workspace-diagnostic-bundles");
  const archivePath = path.join(
    archiveDir,
    `${workspace.workspace_id}-${randomUUID()}.zip`,
  );
  const filename = `${workspace.workspace_id}-workspace-diagnostics.zip`;
  await mkdir(archiveDir, { recursive: true });

  const generationRuns = await listGenerationRunsForWorkspace(WORKSPACE_ROOT, workspace.workspace_id);
  const result = await writeDirectoryDiagnosticArchive({
    archivePath,
    trees: [
      { directory: workspace.workspace_dir, prefix: workspace.workspace_id },
      ...generationRuns.map((run) => ({ directory: path.dirname(path.dirname(run.shadow_workspace_dir)), prefix: `generation-runs/${run.run_id}` })),
    ],
  });
  return {
    workspace_dir: workspace.workspace_dir,
    workspace_id: workspace.workspace_id,
    archive_path: archivePath,
    filename,
    size_bytes: result.size_bytes,
    content_type: "application/zip",
    aps_path: `workspaces/${workspace.workspace_id}/diagnostics/current-workspace.zip`,
    created_at: new Date().toISOString(),
  };
}

type AttachmentBriefBatchUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  attempts: number;
  retry_count: number;
  elapsed_ms: number | null;
};

function readJsonlEntries(raw: string): unknown[] {
  return raw.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as unknown]; } catch { return []; }
  });
}

function attachmentBriefBatchUsage(entries: unknown[], sourceId: string): AttachmentBriefBatchUsage | null {
  const entry = [...entries].reverse().map(getPlainRecord).find((record) =>
    (record.event === "attachment_brief_complete" || record.event === "attachment_brief_complete_failed")
    && record.source_id === sourceId,
  );
  if (!entry) return null;
  const usage = getPlainRecord(entry.token_usage);
  const attempts = Array.isArray(entry.attempts) ? entry.attempts.length : 0;
  return {
    input_tokens: typeof usage.total_prompt_tokens === "number" ? usage.total_prompt_tokens : 0,
    output_tokens: typeof usage.total_completion_tokens === "number" ? usage.total_completion_tokens : 0,
    total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : 0,
    attempts,
    retry_count: Math.max(0, attempts - 1),
    elapsed_ms: typeof entry.elapsed_ms === "number" ? entry.elapsed_ms : null,
  };
}

function escapeBatchReportHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Materialize a compact attachment-only report from the same Workspace logs
 * and artifacts used by the normal attachment preparation flow. Full text is
 * deliberately left in its persisted .txt artifact instead of duplicating
 * large documents into the report JSON.
 */
async function writeAttachmentParsingBatchReport(rootDir: string, run: AppBatchTestRunRecord): Promise<void> {
  if (run.target_stage !== "attachment-context-created") return;
  const caseDetails = await Promise.all(run.cases.map(async (batchCase) => {
    const sourcePaths = buildUploadedSourcePaths(batchCase.workspace_dir);
    const sourceIndex = getPlainRecord(await readJsonFileIfExists(sourcePaths.index_path));
    const materials = Array.isArray(sourceIndex.materials) ? sourceIndex.materials : [];
    const attachmentContext = getPlainRecord(await readJsonFileIfExists(sourcePaths.attachment_context_path));
    const contextEntries = Array.isArray(attachmentContext.attachment_context) ? attachmentContext.attachment_context : [];
    const logPath = path.join(batchCase.workspace_dir, ".log", WORKSPACE_LOG_FILE_NAMES["attachment-preflight"]);
    const logEntries = readJsonlEntries(await readFile(logPath, "utf8").catch(() => ""));
    const latestPreflight = [...logEntries].reverse().map(getPlainRecord).find((entry) => entry.event === "attachment_preflight_completed") ?? {};
    const timingBySource = new Map(
      (Array.isArray(latestPreflight.attachments) ? latestPreflight.attachments : []).map((item) => {
        const value = getPlainRecord(item);
        return [value.source_id, value] as const;
      }),
    );
    const attachments = await Promise.all(materials.map(async (material) => {
      const source = getPlainRecord(material);
      const sourceId = typeof source.uploaded_source_id === "string" ? source.uploaded_source_id : "";
      if (!sourceId) return null;
      const paths = buildUploadedSourcePreflightPaths(batchCase.workspace_dir, sourceId);
      const preflight = getPlainRecord(await readJsonFileIfExists(paths.result_path));
      const timing = timingBySource.get(sourceId);
      const result = contextEntries.find((entry) => getPlainRecord(entry).source_id === sourceId) ?? null;
      const modelUsage = attachmentBriefBatchUsage(logEntries, sourceId);
      return {
        source_id: sourceId,
        filename: source.original_filename ?? source.display_name ?? sourceId,
        fixture: batchCase.attachments?.find((attachment) => attachment.filename === source.original_filename) ?? null,
        parse: preflight,
        parse_timing: timing ? {
          character_count_ready_ms: timing.character_count_ready_ms ?? null,
          full_text_saved_ms: timing.full_text_saved_ms ?? null,
          preflight_total_ms: timing.preflight_total_ms ?? null,
        } : null,
        full_text_path: paths.text_path,
        final_result: result,
        model_called: modelUsage !== null,
        model: modelUsage ?? {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          attempts: 0,
          retry_count: 0,
          elapsed_ms: null,
        },
      };
    }));
    return {
      case_id: batchCase.case_id,
      brief_id: batchCase.brief_id,
      user_brief: batchCase.brief,
      status: batchCase.status,
      error: batchCase.error,
      attachments: attachments.filter((item): item is NonNullable<typeof item> => item !== null),
      attachment_context_path: sourcePaths.attachment_context_path,
      total_duration_ms: batchCase.started_at && batchCase.ended_at
        ? Math.max(0, Date.parse(batchCase.ended_at) - Date.parse(batchCase.started_at))
        : null,
    };
  }));
  const attachments = caseDetails.flatMap((detail) => detail.attachments);
  const tokenUsage = attachments.reduce((total, attachment) => ({
    input_tokens: total.input_tokens + attachment.model.input_tokens,
    output_tokens: total.output_tokens + attachment.model.output_tokens,
    total_tokens: total.total_tokens + attachment.model.total_tokens,
    retry_count: total.retry_count + attachment.model.retry_count,
  }), { input_tokens: 0, output_tokens: 0, total_tokens: 0, retry_count: 0 });
  const summary = {
    version: 1,
    kind: "attachment-parsing-batch",
    test_id: run.test_id,
    generated_at: new Date().toISOString(),
    case_count: caseDetails.length,
    completed_cases: caseDetails.filter((detail) => detail.status === "completed").length,
    failed_cases: caseDetails.filter((detail) => detail.status !== "completed").length,
    attachment_count: attachments.length,
    parse_status_counts: attachments.reduce<Record<string, number>>((counts, attachment) => {
      const status = typeof attachment.parse.parse_status === "string" ? attachment.parse.parse_status : "unknown";
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {}),
    content_strategy_counts: attachments.reduce<Record<string, number>>((counts, attachment) => {
      const result = getPlainRecord(attachment.final_result);
      const strategy = typeof result.content_strategy === "string"
        ? result.content_strategy
        : typeof attachment.parse.content_strategy === "string" ? attachment.parse.content_strategy : "unknown";
      counts[strategy] = (counts[strategy] ?? 0) + 1;
      return counts;
    }, {}),
    attachment_brief_token_usage: tokenUsage,
  };
  await atomicWriteJsonFile(path.join(rootDir, "attachment-parsing-case-details.json"), caseDetails);
  await atomicWriteJsonFile(path.join(rootDir, "attachment-parsing-summary.json"), summary);
  const report = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeBatchReportHtml(run.test_id)} attachment parsing report</title><style>body{font:14px system-ui;margin:32px}pre{white-space:pre-wrap;word-break:break-word;background:#f6f8fa;padding:16px;border-radius:8px}</style></head><body><h1>${escapeBatchReportHtml(run.test_id)} attachment parsing report</h1><p>Full extracted text remains in each attachment's <code>full_text_path</code> within this bundle.</p><h2>Summary</h2><pre>${escapeBatchReportHtml(JSON.stringify(summary, null, 2))}</pre><h2>Case details</h2><pre>${escapeBatchReportHtml(JSON.stringify(caseDetails, null, 2))}</pre></body></html>`;
  await writeFile(path.join(rootDir, "attachment-parsing-report.html"), report, "utf8");
}

export async function prepareAppBatchTestBundle(
  input: PrepareAppBatchTestBundleInput,
): Promise<AppBatchTestBundleSnapshot> {
  const rootDir = assertBatchTestRoot(input.root_dir);
  const run = await readBatchTestRun(rootDir);
  await writeAttachmentParsingBatchReport(rootDir, run);
  const archiveDir = path.join(os.tmpdir(), "ppt-engine-batch-test-bundles");
  const archivePath = path.join(archiveDir, `${run.test_id}-${randomUUID()}.zip`);
  await mkdir(archiveDir, { recursive: true });

  const output = createWriteStream(archivePath, { flags: "wx" });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const snapshotsByEntryName = new Map<string, DiagnosticBundleEntrySnapshot>();
  const verificationChecks: Promise<void>[] = [];
  let verificationError: unknown = null;
  archive.on("warning", (error: ArchiverError) => archive.destroy(error));
  archive.on("entry", (entry) => {
    const snapshot = snapshotsByEntryName.get(entry.name);
    if (!snapshot) return;
    verificationChecks.push(
      verifyDiagnosticBundleEntry(snapshot).catch((error) => {
        verificationError ??= error;
      }),
    );
  });
  const completed = pipeline(archive, output);
  try {
    await appendDiagnosticBundleTree(archive, rootDir, run.test_id, snapshotsByEntryName);
    await archive.finalize();
    await completed;
    await Promise.all(verificationChecks);
    if (verificationError) throw verificationError;
    const archiveInfo = await stat(archivePath);
    if (!archiveInfo.isFile() || archiveInfo.size <= 0) {
      throw new Error("Batch Test Bundle archive is empty");
    }
    return {
      root_dir: rootDir,
      test_id: run.test_id,
      archive_path: archivePath,
      filename: `${run.test_id}-batch-test.zip`,
      size_bytes: archiveInfo.size,
      content_type: "application/zip",
      aps_path: `tests/${run.test_id}/current-batch-test.zip`,
      created_at: new Date().toISOString(),
    };
  } catch (error) {
    archive.abort();
    output.destroy();
    await completed.catch(() => undefined);
    await unlink(archivePath).catch(() => undefined);
    throw error;
  }
}

export async function createAppExportArtifactSnapshot(
  input: GetAppExportArtifactInput,
): Promise<AppExportArtifactSnapshot> {
  const artifact = await getAppExportArtifact(input);
  const before = await stat(artifact.path);
  const snapshotDir = path.join(os.tmpdir(), "ppt-engine-export-snapshots");
  const snapshotPath = path.join(
    snapshotDir,
    `${artifact.workspace_id}-${artifact.artifact_type}-${randomUUID()}.${artifact.artifact_type}`,
  );
  await mkdir(snapshotDir, { recursive: true });
  try {
    await copyFile(artifact.path, snapshotPath);
    const after = await stat(artifact.path);
    if (sourceFileChanged(before, after)) {
      throw new Error("Export artifact changed while its upload snapshot was being created");
    }
    const [sourceSha256, snapshotStat] = await Promise.all([
      sha256FileHex(snapshotPath),
      stat(snapshotPath),
    ]);
    return {
      ...artifact,
      snapshot_path: snapshotPath,
      source_sha256: sourceSha256,
      size_bytes: snapshotStat.size,
      content_type: exportArtifactContentType(artifact.artifact_type),
      mirror_path: `workspaces/${artifact.workspace_id}/exports/current.${artifact.artifact_type}`,
    };
  } catch (error) {
    await unlink(snapshotPath).catch(() => undefined);
    throw error;
  }
}

export async function commitAppExportArtifactMirror(
  input: CommitAppExportArtifactMirrorInput,
): Promise<AppExportArtifactMirror> {
  return withExportArtifactWriteQueue(input.workspace_dir, async () => {
    const artifact = await getAppExportArtifact(input);
    if (artifact.updated_at !== input.expected_updated_at) {
      throw new Error("Export artifact changed while its APS mirror was being published");
    }
    const sourceSha256 = await sha256FileHex(artifact.path);
    if (sourceSha256 !== input.expected_sha256.toLowerCase()) {
      throw new Error("Export artifact content changed while its APS mirror was being published");
    }
    if (
      input.mirror.provider !== "aps.files" ||
      input.mirror.scope !== "user" ||
      input.mirror.source_updated_at !== input.expected_updated_at ||
      input.mirror.source_sha256.toLowerCase() !== input.expected_sha256.toLowerCase()
    ) {
      throw new Error("Export artifact mirror does not match the expected source version");
    }

    const workspace = await ensureWorkspaceFiles(input.workspace_dir);
    const task = workspace.task && typeof workspace.task === "object" && !Array.isArray(workspace.task)
      ? (workspace.task as Record<string, unknown>)
      : {};
    const artifacts = task.artifacts && typeof task.artifacts === "object" && !Array.isArray(task.artifacts)
      ? (task.artifacts as Record<string, unknown>)
      : {};
    const current = artifacts[input.artifact_type] && typeof artifacts[input.artifact_type] === "object" && !Array.isArray(artifacts[input.artifact_type])
      ? (artifacts[input.artifact_type] as Record<string, unknown>)
      : {};
    if (current.updated_at !== input.expected_updated_at) {
      throw new Error("Export artifact changed before its APS mirror could be recorded");
    }

    const mirror = normalizeExportArtifactMirror(input.mirror);
    if (!mirror) {
      throw new Error("Export artifact mirror is invalid");
    }
    await writeJsonFile(workspace.files.task, {
      ...task,
      artifacts: {
        ...artifacts,
        [input.artifact_type]: {
          ...current,
          mirror,
        },
      },
    });
    return mirror;
  });
}

export async function getAppExportArtifactMirrorStatus(
  input: GetAppExportArtifactInput,
): Promise<AppExportArtifactMirrorStatus> {
  const artifact = await getAppExportArtifact(input);
  if (!artifact.mirror) {
    return {
      status: "missing",
      reason: "mirror_missing",
      artifact,
      mirror: null,
    };
  }
  if (artifact.mirror.source_updated_at !== artifact.updated_at) {
    return {
      status: "stale",
      reason: "artifact_version_changed",
      artifact,
      mirror: artifact.mirror,
    };
  }
  const sourceSha256 = await sha256FileHex(artifact.path);
  if (sourceSha256 !== artifact.mirror.source_sha256) {
    return {
      status: "stale",
      reason: "source_hash_changed",
      artifact,
      mirror: artifact.mirror,
    };
  }
  return {
    status: "ready",
    reason: null,
    artifact,
    mirror: artifact.mirror,
  };
}

function buildBlueprintLookup(context: AppTemplatePlanningContext): Map<string, AppTemplatePlanningBlueprint> {
  return new Map(context.blueprints.map((blueprint) => [blueprint.id, blueprint]));
}

function resolveTemplateRelativePath(templateDir: string, relativePath: string): string {
  const cleanPath = relativePath.replace(/^\.\//, "");
  const absolutePath = path.normalize(path.join(templateDir, cleanPath));
  const relativeToTemplate = path.relative(templateDir, absolutePath);
  if (
    relativeToTemplate.length === 0 ||
    relativeToTemplate.startsWith("..") ||
    path.isAbsolute(relativeToTemplate)
  ) {
    throw new Error(`Template-relative path escapes template directory: ${relativePath}`);
  }
  return absolutePath;
}

async function fingerprintFile(filePath: string) {
  const [bytes, fileStat] = await Promise.all([
    readFile(filePath),
    stat(filePath),
  ]);
  if (!fileStat.isFile()) {
    throw new Error(`Target page file is not a file: ${filePath}`);
  }
  return {
    path: filePath,
    sha256: sha256BufferHex(bytes),
    size_bytes: fileStat.size,
  };
}

export async function getAppWorkspacePageFileFingerprints(
  input: GetAppWorkspacePageFileFingerprintsInput,
): Promise<GetAppWorkspacePageFileFingerprintsResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const manifestPath = readSelectedTemplateManifestPath(workspace);
  const templateDir = path.dirname(manifestPath);
  const slidePath = resolveTemplateRelativePath(templateDir, normalizeString(input.slide_path));
  const dataPath = resolveTemplateRelativePath(templateDir, normalizeString(input.data_path));

  const [slide, data] = await Promise.all([
    fingerprintFile(slidePath),
    fingerprintFile(dataPath),
  ]);

  return {
    workspace_dir: workspace.workspace_dir,
    slide,
    data,
  };
}

export async function prepareAppPageRefinement(
  input: PrepareAppPageRefinementInput,
): Promise<PrepareAppPageRefinementResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const outline = normalizeOutlineJson(workspace.outline);
  if (outline.status !== "confirmed") throw new Error("Confirmed Outline is required for Page Refinement");
  const request = normalizeString(input.refinement_request);
  if (!request) throw new Error('"refinement_request" must be non-empty');
  const pageId = normalizeString(input.page_id);
  if (!outline.items.some((item) => item.page_id === pageId)) throw new Error(`Unknown Page Refinement page_id "${pageId}"`);
  const sourcePath = path.join(workspace.workspace_dir, "slides", `${pageId}.tsx`);
  if (!(await fileExists(sourcePath))) throw new Error(`Page Source is missing for page_id "${pageId}"`);
  const styleGuide = await readFile(workspace.files.style_guide, "utf8").catch(() => "");
  if (!styleGuide.trim()) throw new Error("Workspace Style Guide is required for Page Refinement");
  const current = normalizePageProgressJson(workspace.page_progress);
  const existing = current.pages.find((page) => page.page_id === pageId);
  if (!existing) throw new Error(`Page Progress is missing for page_id "${pageId}"`);
  const updatedAt = new Date().toISOString();
  const progress: AppPageProgress = {
    ...current,
    status: "running",
    recovery: {
      status: "running",
      run_kind: "page-refinement",
      step: "page-authoring",
      target_page_ids: [pageId],
      refinement_request: request,
      page_refinement_reasons: { [pageId]: request },
      error: null,
      updated_at: updatedAt,
    },
    final_deck_render: {
      status: "idle",
      message: null,
      error: null,
      output_dir: null,
      deck_html_path: null,
      rendered_at: null,
      updated_at: updatedAt,
    },
    pages: current.pages.map((page) => page.page_id === pageId ? {
      ...page,
      status: "pending",
      render_attempts: 0,
      visual_review_attempts: 0,
      agent_failures: 0,
      agent_infrastructure_failures: 0,
      last_error: "",
      visual_review: null,
      updated_at: updatedAt,
    } : page),
    updated_at: updatedAt,
  };
  await writePageProgressFile(workspace.files.page_progress, progress);
  await touchWorkspaceTask(workspace, updatedAt);
  return { workspace_dir: workspace.workspace_dir, page_id: pageId, progress };
}

export async function commitAppDeckRefinement(
  input: CommitAppDeckRefinementInput,
): Promise<CommitAppDeckRefinementResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const currentOutline = normalizeOutlineJson(workspace.outline);
  if (currentOutline.status !== "confirmed") throw new Error("Confirmed Outline is required for Deck Refinement");
  const currentRequirements = normalizePresentationRequirements(workspace.requirements);
  if (currentRequirements.status !== "confirmed") throw new Error("Confirmed Presentation Requirements are required for Deck Refinement");
  const request = normalizeString(input.refinement_request);
  if (!request) throw new Error('"refinement_request" must be non-empty');
  const title = normalizeOutlineLine(input.title, "title");
  if (!Array.isArray(input.operations) || input.operations.length === 0) throw new Error("Deck Refinement operations must be non-empty");
  const currentById = new Map(currentOutline.items.map((item) => [item.page_id, item]));
  const seen = new Set<string>();
  const addedPageIds: string[] = [];
  const deletedPageIds: string[] = [];
  const targetPageIds = new Set<string>();
  const reasons: Record<string, string> = {};
  const nextItems: AppWorkspaceOutlineItem[] = [];
  for (const [index, operation] of input.operations.entries()) {
    if (operation.op !== "add") {
      if (!currentById.has(operation.page_id)) throw new Error(`Unknown Deck Refinement page_id "${operation.page_id}"`);
      if (seen.has(operation.page_id)) throw new Error(`Duplicate Deck Refinement page_id "${operation.page_id}"`);
      seen.add(operation.page_id);
    }
    if (operation.op === "delete") {
      deletedPageIds.push(operation.page_id);
      continue;
    }
    if (operation.op === "keep") {
      nextItems.push(currentById.get(operation.page_id)!);
      reasons[operation.page_id] = normalizeString(operation.reason) || request;
      continue;
    }
    const pageId = operation.op === "add" ? `page-${randomUUID()}` : operation.page_id;
    if (operation.op === "add") addedPageIds.push(pageId);
    const item = normalizeValidOutlineItem({
      selected_image_ids: operation.op === "add" ? [] : [...(currentById.get(pageId)?.selected_image_ids ?? [])],
      page_type: operation.page_type,
      title: operation.title,
      content: operation.content,
      creation_requirements: operation.op === "add" ? undefined : currentById.get(pageId)?.creation_requirements,
    }, index);
    nextItems.push({ ...item, page_id: pageId });
    targetPageIds.add(pageId);
    reasons[pageId] = normalizeString(operation.reason) || request;
  }
  for (const pageId of currentById.keys()) {
    if (pageId && !seen.has(pageId)) throw new Error(`Missing Deck Refinement operation for page_id "${pageId}"`);
  }
  if (nextItems.length === 0) throw new Error("Deck Refinement must retain at least one page");
  const languageChanged = input.output_language_change?.changed === true;
  const outputLanguage = normalizeString(input.output_language_change?.output_language);
  if (languageChanged && !outputLanguage) throw new Error("Deck Refinement output language is required when changed");
  if (languageChanged || input.style_guide_action === "regenerate") {
    for (const item of nextItems) if (item.page_id) targetPageIds.add(item.page_id);
  }
  if (input.style_guide_action !== "preserve" && input.style_guide_action !== "regenerate") {
    throw new Error('"style_guide_action" must be preserve or regenerate');
  }
  let replacementStyleGuide: Buffer | null = null;
  if (input.style_guide_action === "regenerate") {
    if (!input.style_guide_staging_file_path) throw new Error("Replacement Workspace Style Guide is required");
    assertAbsolutePath(input.style_guide_staging_file_path, "style_guide_staging_file_path");
    replacementStyleGuide = await readFile(input.style_guide_staging_file_path);
    const expected = Math.floor(input.style_guide_expected_size_bytes ?? 0);
    if (expected <= 0 || replacementStyleGuide.length !== expected || !replacementStyleGuide.toString("utf8").trim()) {
      throw new Error("Replacement Workspace Style Guide validation failed");
    }
  } else {
    const currentStyleGuide = await readFile(workspace.files.style_guide, "utf8").catch(() => "");
    if (!currentStyleGuide.trim()) throw new Error("Workspace Style Guide is required for Deck Refinement");
  }

  const updatedAt = new Date().toISOString();
  const nextOutline: AppWorkspaceOutline = {
    version: 4,
    status: "confirmed",
    title,
    items: nextItems,
    global_creation_requirements: currentOutline.global_creation_requirements ?? "",
    updated_at: updatedAt,
    confirmed_at: updatedAt,
  };
  const nextRequirements: AppPresentationRequirements = {
    ...currentRequirements,
    selections: {
      ...currentRequirements.selections,
      slide_count: nextItems.length,
      ...(languageChanged ? { output_language: outputLanguage } : {}),
    },
    updated_at: updatedAt,
    confirmed_at: updatedAt,
  };
  const currentProgress = normalizePageProgressJson(workspace.page_progress);
  const progressById = new Map(currentProgress.pages.map((page) => [page.page_id, page]));
  const nextProgress: AppPageProgress = {
    ...currentProgress,
    status: "running",
    recovery: {
      status: "running",
      run_kind: "deck-refinement",
      step: targetPageIds.size > 0 ? "page-authoring" : "final-render",
      target_page_ids: Array.from(targetPageIds),
      refinement_request: request,
      page_refinement_reasons: Object.fromEntries(Array.from(targetPageIds).map((pageId) => [pageId, reasons[pageId] || request])),
      error: null,
      updated_at: updatedAt,
    },
    final_deck_render: {
      status: "idle",
      message: null,
      error: null,
      output_dir: null,
      deck_html_path: null,
      rendered_at: null,
      updated_at: updatedAt,
    },
    pages: nextItems.map((item) => {
      const pageId = item.page_id!;
      const existing = progressById.get(pageId);
      if (!targetPageIds.has(pageId) && existing) return existing;
      return {
        page_id: pageId,
        status: "pending",
        render_attempts: 0,
        visual_review_attempts: 0,
        agent_failures: 0,
        agent_infrastructure_failures: 0,
        last_html_path: existing?.last_html_path ?? "",
        last_screenshot_path: existing?.last_screenshot_path ?? "",
        last_error: "",
        visual_review: null,
        updated_at: updatedAt,
      };
    }),
    updated_at: updatedAt,
  };

  const officialPaths = [workspace.files.outline, workspace.files.requirements, workspace.files.task, workspace.files.manifest, workspace.files.page_progress, workspace.files.style_guide];
  const backups = new Map<string, Buffer | null>();
  for (const filePath of officialPaths) backups.set(filePath, await readFile(filePath).catch(() => null));
  try {
    await writeJsonFile(workspace.files.outline, nextOutline);
    await writeJsonFile(workspace.files.requirements, nextRequirements);
    const currentTask = getPlainRecord(workspace.task);
    await writeJsonFile(workspace.files.task, {
      ...currentTask,
      ...(shouldAutoSyncWorkspaceTitle(currentTask, currentOutline, title) ? { title } : {}),
      updated_at: updatedAt,
    });
    if (replacementStyleGuide) await writeFile(workspace.files.style_guide, replacementStyleGuide);
    await prepareWorkspacePageSources({ workspace_dir: workspace.workspace_dir });
    await writePageProgressFile(workspace.files.page_progress, nextProgress);
  } catch (error) {
    for (const [filePath, bytes] of backups) {
      if (bytes) await writeFile(filePath, bytes).catch(() => undefined);
      else await rm(filePath, { force: true }).catch(() => undefined);
    }
    for (const pageId of addedPageIds) {
      await rm(path.join(workspace.workspace_dir, "slides", `${pageId}.tsx`), { force: true }).catch(() => undefined);
    }
    throw error;
  }
  for (const pageId of deletedPageIds) {
    await removePageOwnedManualArtifacts(workspace.workspace_dir, pageId);
  }
  return {
    workspace_dir: workspace.workspace_dir,
    outline: nextOutline,
    progress: nextProgress,
    target_page_ids: Array.from(targetPageIds),
    added_page_ids: addedPageIds,
    deleted_page_ids: deletedPageIds,
  };
}

export async function getAppPageProgress(
  input: GetAppPageProgressInput,
): Promise<AppPageProgress> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const progress = normalizePageProgressJson(workspace.page_progress);
  const workspaceKey = path.normalize(workspace.workspace_dir);
  const interruptedPageIds = progress.pages
    .filter((page) => page.status === "rendering" && !activePageRenders.has(`${workspaceKey}\0${page.page_id}`))
    .map((page) => page.page_id);
  const finalInterrupted = progress.final_deck_render.status === "running" && !activeDeckRenders.has(workspaceKey);
  if (interruptedPageIds.length === 0 && !finalInterrupted) return progress;

  return withPageProgressWriteQueue(workspace.workspace_dir, async () => {
    const latestWorkspace = await ensureWorkspaceFiles(workspace.workspace_dir);
    const latest = normalizePageProgressJson(latestWorkspace.page_progress);
    const updatedAt = new Date().toISOString();
    const next: AppPageProgress = {
      ...latest,
      pages: latest.pages.map((page) => page.status === "rendering" && !activePageRenders.has(`${workspaceKey}\0${page.page_id}`)
        ? { ...page, status: "interrupted", last_error: "Rendering was interrupted because the engine process restarted.", updated_at: updatedAt }
        : page),
      final_deck_render: finalInterrupted && latest.final_deck_render.status === "running"
        ? {
          ...latest.final_deck_render,
          status: "interrupted",
          message: "Final Deck rendering was interrupted because the engine process restarted.",
          error: "Final Deck rendering was interrupted because the engine process restarted.",
          updated_at: updatedAt,
        }
        : latest.final_deck_render,
      updated_at: updatedAt,
    };
    await writePageProgressFile(latestWorkspace.files.page_progress, next);
    return next;
  });
}

async function recordWorkspaceHtml(
  input: RecordAppWorkspaceHtmlInput,
  targetPath: string,
): Promise<RecordAppWorkspaceHtmlResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  assertAbsolutePath(input.staging_file_path, "staging_file_path");
  const expectedSizeBytes = Math.floor(input.expected_size_bytes);
  if (!Number.isFinite(expectedSizeBytes) || expectedSizeBytes <= 0) {
    throw new Error('"expected_size_bytes" must be a positive integer');
  }
  let bytes = await readFile(input.staging_file_path);
  if (bytes.length !== expectedSizeBytes || !bytes.toString("utf8").trim()) {
    throw new Error("Workspace HTML upload validation failed");
  }
  const aspectRatio = normalizeSlideAspectRatio(normalizePresentationRequirements(workspace.requirements).selections.aspect_ratio);
  if (aspectRatio !== "16:9") bytes = Buffer.from(stampSlideFormat(bytes.toString("utf8"), aspectRatio));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, bytes);
  const updatedAt = new Date().toISOString();
  await touchWorkspaceTask(workspace, updatedAt);
  return {
    workspace_dir: workspace.workspace_dir,
    path: targetPath,
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    updated_at: updatedAt,
  };
}

export async function recordAppWorkspaceVisualMasterHtml(
  input: RecordAppWorkspaceHtmlInput,
): Promise<RecordAppWorkspaceHtmlResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  return recordWorkspaceHtml(input, workspace.files.visual_master);
}

export async function getAppWorkspaceVisualMasterHtml(input: {
  workspace_dir: string;
}): Promise<RecordAppWorkspaceHtmlResult & { content: string }> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const bytes = await readFile(workspace.files.visual_master);
  return {
    workspace_dir: workspace.workspace_dir,
    path: workspace.files.visual_master,
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    updated_at: (await stat(workspace.files.visual_master)).mtime.toISOString(),
    content: bytes.toString("utf8"),
  };
}

export async function recordAppWorkspacePageHtml(
  input: RecordAppWorkspacePageHtmlInput,
): Promise<RecordAppWorkspaceHtmlResult> {
  if (!PAGE_ID_PATTERN.test(input.page_id)) throw new Error('"page_id" must be a stable page UUID');
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const outline = normalizeOutlineJson(workspace.outline);
  if (!outline.items.some((item) => item.page_id === input.page_id)) {
    throw new Error(`Unknown page_id "${input.page_id}"`);
  }
  // Promote a legacy edit before replacing its source, so a later read cannot
  // re-apply the old current.html over this newly generated page.
  await readManualPageRevision(workspace.workspace_dir, input.page_id);
  return recordWorkspaceHtml(input, path.join(workspace.workspace_dir, "slides", `${input.page_id}.html`));
}

export async function getAppWorkspaceAestheticReferenceSelections(input: {
  workspace_dir: string;
}): Promise<AppAestheticReferenceSelections> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const value = getPlainRecord(await readJsonFileIfExists(workspace.files.aesthetic_reference_selections));
  return {
    version: 1,
    visual_master: isRecord(value.visual_master) ? value.visual_master as unknown as AppAestheticReferenceSelections["visual_master"] : null,
    pages: isRecord(value.pages) ? value.pages as AppAestheticReferenceSelections["pages"] : {},
    updated_at: typeof value.updated_at === "string" ? value.updated_at : null,
  };
}

export async function recordAppWorkspaceAestheticReferenceSelection(
  input: RecordAppAestheticReferenceSelectionInput,
): Promise<AppAestheticReferenceSelections> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const references = await listAppWorkspaceTemplateReferences({ workspace_dir: workspace.workspace_dir });
  if (!references.reference_html_pages.some((page) => page.path === input.path)) {
    throw new Error(`Unknown template reference HTML path: ${input.path}`);
  }
  if (input.target === "page" && (!input.page_id || !PAGE_ID_PATTERN.test(input.page_id))) {
    throw new Error('Page aesthetic selection requires a stable "page_id"');
  }
  const current = await getAppWorkspaceAestheticReferenceSelections({ workspace_dir: workspace.workspace_dir });
  const updatedAt = new Date().toISOString();
  const selection = {
    target: input.target,
    page_id: input.target === "page" ? input.page_id! : null,
    path: input.path,
    selected_at: updatedAt,
  } as const;
  const next: AppAestheticReferenceSelections = input.target === "visual-master"
    ? { ...current, visual_master: selection, updated_at: updatedAt }
    : { ...current, pages: { ...current.pages, [input.page_id!]: selection }, updated_at: updatedAt };
  await writeJsonFile(workspace.files.aesthetic_reference_selections, next);
  return next;
}

export async function recordAppWorkspaceStyleGuide(
  input: RecordAppWorkspaceStyleGuideInput,
): Promise<RecordAppWorkspaceStyleGuideResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  assertAbsolutePath(input.staging_file_path, "staging_file_path");
  const expectedSizeBytes = Math.floor(input.expected_size_bytes);
  if (!Number.isFinite(expectedSizeBytes) || expectedSizeBytes <= 0) {
    throw new Error('"expected_size_bytes" must be a positive integer');
  }
  const bytes = await readFile(input.staging_file_path);
  if (bytes.length !== expectedSizeBytes) {
    throw new Error(
      `Style Guide size mismatch: expected ${expectedSizeBytes} bytes, got ${bytes.length} bytes`,
    );
  }
  if (bytes.toString("utf8").trim().length === 0) {
    throw new Error("Workspace Style Guide must not be empty");
  }
  await writeFile(workspace.files.style_guide, bytes);
  const updatedAt = new Date().toISOString();
  await touchWorkspaceTask(workspace, updatedAt);
  return {
    workspace_dir: workspace.workspace_dir,
    style_guide_path: workspace.files.style_guide,
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    updated_at: updatedAt,
  };
}

export async function getAppWorkspaceStyleGuideStatus(
  input: GetAppWorkspaceStyleGuideStatusInput,
): Promise<GetAppWorkspaceStyleGuideStatusResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  try {
    const bytes = await readFile(workspace.files.style_guide);
    return {
      workspace_dir: workspace.workspace_dir,
      style_guide_path: workspace.files.style_guide,
      exists: true,
      non_empty: bytes.toString("utf8").trim().length > 0,
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        workspace_dir: workspace.workspace_dir,
        style_guide_path: workspace.files.style_guide,
        exists: false,
        non_empty: false,
        size_bytes: 0,
      };
    }
    throw error;
  }
}

export async function getAppWorkspaceStyleGuide(
  input: GetAppWorkspaceStyleGuideStatusInput,
): Promise<GetAppWorkspaceStyleGuideResult> {
  const status = await getAppWorkspaceStyleGuideStatus(input);
  if (!status.non_empty) throw new Error("Workspace Style Guide is unavailable");
  return { ...status, content: await readFile(status.style_guide_path, "utf8") };
}

async function recordMarkdownArtifact(input: { workspace_dir: string; staging_file_path: string; expected_size_bytes: number; target_path: string; label: string }) {
  assertAbsolutePath(input.staging_file_path, "staging_file_path");
  const expectedSizeBytes = Math.floor(input.expected_size_bytes);
  if (!Number.isFinite(expectedSizeBytes) || expectedSizeBytes <= 0) throw new Error('expected_size_bytes must be a positive integer');
  const bytes = await readFile(input.staging_file_path);
  if (bytes.length !== expectedSizeBytes) throw new Error(`${input.label} size mismatch`);
  if (bytes.toString("utf8").trim().length === 0) throw new Error(`${input.label} must not be empty`);
  await mkdir(path.dirname(input.target_path), { recursive: true });
  await writeFile(input.target_path, bytes);
  return { size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), updated_at: new Date().toISOString() };
}

export async function recordAppVisualRhythm(input: RecordAppVisualRhythmInput): Promise<RecordAppVisualRhythmResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const result = await recordMarkdownArtifact({ ...input, target_path: workspace.files.visual_rhythm, label: "Visual Rhythm" });
  await touchWorkspaceTask(workspace, result.updated_at);
  return { workspace_dir: workspace.workspace_dir, visual_rhythm_path: workspace.files.visual_rhythm, ...result };
}

export async function getAppVisualRhythmStatus(input: GetAppVisualRhythmStatusInput): Promise<GetAppVisualRhythmStatusResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  try { const bytes = await readFile(workspace.files.visual_rhythm); return { workspace_dir: workspace.workspace_dir, visual_rhythm_path: workspace.files.visual_rhythm, exists: true, non_empty: bytes.toString("utf8").trim().length > 0, size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { workspace_dir: workspace.workspace_dir, visual_rhythm_path: workspace.files.visual_rhythm, exists: false, non_empty: false, size_bytes: 0 }; throw error; }
}

export async function getAppVisualRhythm(input: GetAppVisualRhythmStatusInput): Promise<GetAppVisualRhythmResult> {
  const status = await getAppVisualRhythmStatus(input); if (!status.non_empty) throw new Error("Visual Rhythm is unavailable"); return { ...status, content: await readFile(status.visual_rhythm_path, "utf8") };
}

function pageVisualPlanPath(workspace: AppWorkspaceResult, pageId: string) { if (!PAGE_ID_PATTERN.test(pageId)) throw new Error("page_id must be an opaque page UUID"); return path.join(workspace.files.page_visual_plans, `${pageId}.md`); }

export async function recordAppPageVisualPlan(input: RecordAppPageVisualPlanInput): Promise<RecordAppPageVisualPlanResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir); const targetPath = pageVisualPlanPath(workspace, input.page_id);
  const result = await recordMarkdownArtifact({ ...input, target_path: targetPath, label: "Page Visual Plan" }); await touchWorkspaceTask(workspace, result.updated_at);
  return { workspace_dir: workspace.workspace_dir, page_id: input.page_id, page_visual_plan_path: targetPath, ...result };
}

export async function getAppPageVisualPlanStatus(input: GetAppPageVisualPlanStatusInput): Promise<GetAppPageVisualPlanStatusResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir); const targetPath = pageVisualPlanPath(workspace, input.page_id);
  try { const bytes = await readFile(targetPath); return { workspace_dir: workspace.workspace_dir, page_id: input.page_id, page_visual_plan_path: targetPath, exists: true, non_empty: bytes.toString("utf8").trim().length > 0, size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { workspace_dir: workspace.workspace_dir, page_id: input.page_id, page_visual_plan_path: targetPath, exists: false, non_empty: false, size_bytes: 0 }; throw error; }
}

export async function getAppPageVisualPlan(input: GetAppPageVisualPlanStatusInput): Promise<GetAppPageVisualPlanResult> { const status = await getAppPageVisualPlanStatus(input); if (!status.non_empty) throw new Error("Page Visual Plan is unavailable"); return { ...status, content: await readFile(status.page_visual_plan_path, "utf8") }; }

export async function ensureAppWorkspacePersistentElementsReference(input: {
  workspace_dir: string;
  reset_existing?: boolean;
}) {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const result = await ensureWorkspacePersistentElementsReference(input);
  await touchWorkspaceTask(workspace, new Date().toISOString());
  return {
    workspace_dir: workspace.workspace_dir,
    persistent_elements_path: result.path,
    created: result.created,
    sha256: result.sha256,
    size_bytes: result.size_bytes,
  };
}

export async function getAppWorkspacePersistentElementsStatus(
  input: GetAppWorkspacePersistentElementsStatusInput,
): Promise<GetAppWorkspacePersistentElementsStatusResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  try {
    const result = await fingerprintWorkspacePersistentElements(input);
    return {
      workspace_dir: workspace.workspace_dir,
      persistent_elements_path: result.path,
      exists: true,
      non_empty: result.size_bytes > 0,
      size_bytes: result.size_bytes,
      sha256: result.sha256,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        workspace_dir: workspace.workspace_dir,
        persistent_elements_path: workspace.files.persistent_elements,
        exists: false,
        non_empty: false,
        size_bytes: 0,
      };
    }
    throw error;
  }
}

export async function typecheckAppWorkspacePersistentElements(input: {
  workspace_dir: string;
}) {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  await assertLocalTemplateTypecheck({
    entryPath: workspace.files.persistent_elements,
    cwd: workspace.workspace_dir,
    label: "persistent-elements.tsx",
  });
  return getAppWorkspacePersistentElementsStatus(input);
}

export async function initializeAppPageProgress(
  input: InitializeAppPageProgressInput,
): Promise<AppPageProgress> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  await removeAllManualPageRevisions(workspace.workspace_dir);
  const outline = normalizeOutlineJson(workspace.outline);
  if (outline.status !== "confirmed") {
    throw new Error("Confirmed Outline is required before initializing Page Progress");
  }
  const workspaceFormat = normalizeString(getPlainRecord(workspace.task).workspace_format);
  if (workspaceFormat === WORKSPACE_FORMAT) {
    const visualMaster = await readFile(workspace.files.visual_master, "utf8").catch(() => "");
    if (!visualMaster.trim()) {
      throw new Error("Workspace Visual Master is required before initializing Page Progress");
    }
  } else {
    const styleGuide = await readFile(workspace.files.style_guide, "utf8").catch(() => "");
    if (!styleGuide.trim()) {
      throw new Error("Workspace Style Guide is required before initializing Page Progress");
    }
  }
  if (workspaceFormat !== WORKSPACE_FORMAT) {
    for (const item of outline.items) {
      if (!item.page_id) throw new Error("Confirmed Outline item is missing page_id");
      if (!(await fileExists(path.join(workspace.workspace_dir, "slides", `${item.page_id}.tsx`)))) {
        throw new Error(`Page Source is missing for page_id "${item.page_id}"`);
      }
    }
  }
  const updatedAt = new Date().toISOString();
  const progress: AppPageProgress = {
    ...createDefaultPageProgressJson(),
    status: "running",
    pages: outline.items.map((item) => ({
      page_id: item.page_id as string,
      status: "pending",
      render_attempts: 0,
      visual_review_attempts: 0,
      agent_failures: 0,
      agent_infrastructure_failures: 0,
      last_html_path: "",
      last_screenshot_path: "",
      last_error: "",
      visual_review: null,
      updated_at: updatedAt,
    })),
    updated_at: updatedAt,
  };
  await writePageProgressFile(workspace.files.page_progress, progress);
  await touchWorkspaceTask(workspace, updatedAt);
  return progress;
}

export async function recordAppPageProgress(
  input: RecordAppPageProgressInput,
): Promise<AppPageProgress> {
  return withPageProgressWriteQueue(input.workspace_dir, async () => {
    const workspace = await ensureWorkspaceFiles(input.workspace_dir);
    const current = normalizePageProgressJson(workspace.page_progress);
    const updatedAt = new Date().toISOString();
    const pageId = normalizeString(input.page_id);
    const nextPages = current.pages.map((page) => {
      if (!pageId || page.page_id !== pageId) return page;
      return normalizePageProgressItem({
        ...page,
        ...input.patch,
        page_id: page.page_id,
        updated_at: updatedAt,
      }) as AppPageProgressItem;
    });

    if (pageId && !current.pages.some((page) => page.page_id === pageId)) {
      throw new Error(`Unknown page_id "${pageId}" in page-progress.json`);
    }

    const patchRecord = getPlainRecord(input.patch);
    const recoveryPatch = isRecord(patchRecord.recovery) ? patchRecord.recovery : {};
    const finalDeckRenderPatch = isRecord(patchRecord.final_deck_render)
      ? patchRecord.final_deck_render
      : {};
    const researchDiscoveryPatch = isRecord(patchRecord.research_discovery)
      ? normalizeResearchDiscoveryProgress(patchRecord.research_discovery)
      : undefined;
    const recovery = normalizePageProgressRecoveryState({
      ...current.recovery,
      ...recoveryPatch,
      updated_at: Object.keys(recoveryPatch).length > 0 ? updatedAt : current.recovery.updated_at,
    });
    const finalDeckRender = normalizeFinalDeckRenderState({
      ...current.final_deck_render,
      ...finalDeckRenderPatch,
      updated_at: Object.keys(finalDeckRenderPatch).length > 0
        ? updatedAt
        : current.final_deck_render.updated_at,
    });
    const nextProgress: AppPageProgress = {
      version: 1,
      status: normalizeString(input.patch.deck_status) || current.status || "running",
      recovery,
      final_deck_render: finalDeckRender,
      research_discovery: researchDiscoveryPatch ?? current.research_discovery,
      pages: nextPages,
      updated_at: updatedAt,
    };

    await writePageProgressFile(workspace.files.page_progress, nextProgress);
    if (pageId && normalizeString(input.patch.status) === "accepted") {
      await removeManualPageRevision(workspace.workspace_dir, pageId);
    }
    await touchWorkspaceTask(workspace, updatedAt);
    return nextProgress;
  });
}

async function updatePageRenderIfActive(input: {
  workspaceDir: string;
  pageId: string;
  token: symbol;
  sourceSha256: string;
  patch: Partial<AppPageProgressItem>;
}): Promise<boolean> {
  return withPageProgressWriteQueue(input.workspaceDir, async () => {
    const key = `${path.normalize(input.workspaceDir)}\0${input.pageId}`;
    const active = activePageRenders.get(key);
    if (!active || active.token !== input.token || active.sourceSha256 !== input.sourceSha256) return false;
    const workspace = await ensureWorkspaceFiles(input.workspaceDir);
    const current = normalizePageProgressJson(workspace.page_progress);
    const page = current.pages.find((item) => item.page_id === input.pageId);
    if (!page) return false;
    const updatedAt = new Date().toISOString();
    const nextProgress: AppPageProgress = {
      ...current,
      pages: current.pages.map((item) => item.page_id === input.pageId
        ? normalizePageProgressItem({
          ...item,
          ...input.patch,
          page_id: item.page_id,
          render_source_sha256: input.sourceSha256,
          updated_at: updatedAt,
        }) as AppPageProgressItem
        : item),
      updated_at: updatedAt,
    };
    await writePageProgressFile(workspace.files.page_progress, nextProgress);
    await touchWorkspaceTask(workspace, updatedAt);
    return true;
  });
}

async function performAppWorkspacePagePreview(
  input: RenderAppWorkspacePagePreviewInput,
): Promise<RenderedAppWorkspacePagePreviewResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const manifestPath = readSelectedTemplateManifestPath(workspace);
  const manifest = getPlainRecord(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  const slides = Array.isArray(manifest.slides) ? manifest.slides.map(getPlainRecord) : [];
  const pageIndex = slides.findIndex((slide) => normalizeString(slide.id) === input.page_id);
  if (pageIndex < 0) throw new Error(`Unknown page_id "${input.page_id}" in manifest.json`);

  const pageNumber = pageIndex + 1;
  const renderedAt = new Date().toISOString();
  const htmlOutputDir = path.join(workspace.workspace_dir, "output", "page-preview-html");
  const screenshotOutputDir = path.join(workspace.workspace_dir, "output", "screenshots");
  const result = await buildDeckPageScreenshotFromManifest({
    manifestPath,
    outputDir: screenshotOutputDir,
    htmlOutputDir,
    name: `${workspace.workspace_id}-page-preview`,
    page: pageNumber,
    screenshot: false,
    onStaticSlideReady: (htmlPath, element) => preparePageThumbnail(
      { workspaceDir: workspace.workspace_dir, pageId: input.page_id, htmlPath },
      async (slides) => { await writeSlideWebpThumbnail(element, slides[0].outputPath); },
    ),
  });

  return {
    workspace_dir: workspace.workspace_dir,
    manifest_path: result.manifestPath,
    html_path: result.htmlPath,
    screenshot_path: result.screenshotPath,
    page_index: pageIndex,
    page_number: pageNumber,
    slide_id: result.slideId,
    layout_id: result.layoutId,
    title: result.title,
    rendered_at: renderedAt,
  };
}

async function runAppWorkspacePageRenderTask(input: {
  workspaceDir: string;
  pageId: string;
  token: symbol;
  sourceSha256: string;
}): Promise<void> {
  try {
    const result = await performAppWorkspacePagePreview({
      workspace_dir: input.workspaceDir,
      page_id: input.pageId,
    });
    await updatePageRenderIfActive({
      workspaceDir: input.workspaceDir,
      pageId: input.pageId,
      token: input.token,
      sourceSha256: input.sourceSha256,
      patch: {
        status: "rendered",
        last_html_path: result.html_path,
        last_screenshot_path: result.screenshot_path,
        snapshot_source_sha256: input.sourceSha256,
        last_error: "",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updatePageRenderIfActive({
      workspaceDir: input.workspaceDir,
      pageId: input.pageId,
      token: input.token,
      sourceSha256: input.sourceSha256,
      patch: {
        status: "render_failed",
        last_error: message,
      },
    }).catch(() => undefined);
  } finally {
    const key = `${path.normalize(input.workspaceDir)}\0${input.pageId}`;
    if (activePageRenders.get(key)?.token === input.token) activePageRenders.delete(key);
  }
}

/** Audit the rendered snapshot, but supply only the authoritative slides HTML
 * as rewrite context. Never expose the large snapshot as an authoring prompt. */
export async function auditAppWorkspacePageLayout(input: {
  workspace_dir: string;
  page_id: string;
  expected_source_sha256: string;
}) {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const manifestPath = readSelectedTemplateManifestPath(workspace);
  const manifest = getPlainRecord(JSON.parse(await readFile(manifestPath, "utf8")));
  const slides = Array.isArray(manifest.slides) ? manifest.slides.map(getPlainRecord) : [];
  const pageIndex = slides.findIndex((slide) => normalizeString(slide.id) === input.page_id);
  if (pageIndex < 0) throw new Error(`Unknown page_id "${input.page_id}" in manifest.json`);
  const source = await readManifestLocalSlideSourcePath({ manifestPath, pageIndex, allowHtml: true });
  if (!source) throw new Error("Layout audit requires a local HTML Page Source");
  const slidesDir = await realpath(path.join(workspace.workspace_dir, "slides"));
  const sourcePath = await realpath(source.absolutePath);
  const relativeSource = path.relative(slidesDir, sourcePath);
  if (!relativeSource || relativeSource.startsWith("..") || path.isAbsolute(relativeSource) || !sourcePath.endsWith(".html")) {
    throw new Error("Layout rewrite requires an HTML Page Source inside slides/");
  }
  const page = normalizePageProgressJson(workspace.page_progress).pages.find((item) => item.page_id === input.page_id);
  if (!page?.last_html_path) throw new Error("Layout audit requires a rendered HTML snapshot");
  const htmlPath = await realpath(page.last_html_path);
  const outputDir = await realpath(path.join(workspace.workspace_dir, "output"));
  for (const artifact of [htmlPath]) {
    const relative = path.relative(outputDir, artifact);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Layout audit artifact is outside workspace output/");
  }
  const assertCurrent = async () => {
    const current = await getAppPageProgress({ workspace_dir: workspace.workspace_dir });
    const currentPage = current.pages.find((item) => item.page_id === input.page_id);
    if (!input.expected_source_sha256 ||
      sha256BufferHex(await readFile(sourcePath)) !== input.expected_source_sha256 ||
      currentPage?.render_source_sha256 !== input.expected_source_sha256 ||
      currentPage.snapshot_source_sha256 !== input.expected_source_sha256 ||
      currentPage.last_html_path !== page.last_html_path ||
      currentPage.render_attempts !== page.render_attempts) {
      throw new Error("Page source or render changed during layout audit");
    }
  };
  await assertCurrent();
  const { width, height } = slideFormat(normalizePresentationRequirements(workspace.requirements).selections.aspect_ratio);
  const report = await auditHtmlFile({ input: htmlPath, width, height });
  await assertCurrent();
  const reportDir = path.join(outputDir, "layout-audit");
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${pageIndex + 1}-${input.expected_source_sha256}.json`);
  await writeJsonFile(reportPath, report);
  return {
    page_id: input.page_id,
    source_sha256: input.expected_source_sha256,
    error_count: report.summary.errorCount,
    warning_count: report.summary.warningCount,
    report_path: reportPath,
    source_html_path: sourcePath,
    rendered_html_path: htmlPath,
    preview_source_fingerprint: await fingerprintPageSnapshot(workspace.workspace_dir, htmlPath),
  };
}

export async function renderAppWorkspacePagePreview(
  input: RenderAppWorkspacePagePreviewInput,
): Promise<RenderAppWorkspacePagePreviewResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const manifestPath = readSelectedTemplateManifestPath(workspace);
  const manifest = getPlainRecord(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  const slides = Array.isArray(manifest.slides) ? manifest.slides.map(getPlainRecord) : [];
  const pageIndex = slides.findIndex((slide) => normalizeString(slide.id) === input.page_id);
  if (pageIndex < 0) throw new Error(`Unknown page_id "${input.page_id}" in manifest.json`);
  const localSlide = await readManifestLocalSlideSourcePath({
    manifestPath,
    pageIndex,
    allowHtml: normalizeString(getPlainRecord(workspace.task).workspace_format) === WORKSPACE_FORMAT,
  });
  if (!localSlide) throw new Error(`Page Source for "${input.page_id}" must be a local file`);
  const sourceSha256 = sha256BufferHex(await readFile(localSlide.absolutePath));
  const page = normalizePageProgressJson(workspace.page_progress).pages.find((item) => item.page_id === input.page_id);
  if (!page) throw new Error(`Page Progress is missing for page_id "${input.page_id}"`);
  const key = `${path.normalize(workspace.workspace_dir)}\0${input.page_id}`;
  const existing = activePageRenders.get(key);
  const submittedAt = new Date().toISOString();
  if (existing?.sourceSha256 === sourceSha256 || (
    !existing &&
    page.render_source_sha256 === sourceSha256 &&
    ["rendered", "accepted", "visual_review"].includes(page.status) &&
    Boolean(page.last_html_path) &&
    await fileExists(page.last_html_path)
  )) {
    return {
      status: "running",
      already_queued: true,
      workspace_dir: workspace.workspace_dir,
      manifest_path: manifestPath,
      page_index: pageIndex,
      page_number: pageIndex + 1,
      slide_id: input.page_id,
      layout_id: normalizeString(slides[pageIndex]?.layout_id) || input.page_id,
      title: normalizeString(slides[pageIndex]?.title) || input.page_id,
      render_attempt: existing?.renderAttempt ?? page.render_attempts,
      source_sha256: sourceSha256,
      submitted_at: submittedAt,
    };
  }

  const token = Symbol("page-render");
  const renderAttempt = page.render_attempts + 1;
  activePageRenders.set(key, { token, sourceSha256, renderAttempt });
  try {
    const updated = await updatePageRenderIfActive({
      workspaceDir: workspace.workspace_dir,
      pageId: input.page_id,
      token,
      sourceSha256,
      patch: {
        status: "rendering",
        render_attempts: renderAttempt,
        last_error: "",
      },
    });
    if (!updated) throw new Error(`Page render submission was superseded for "${input.page_id}"`);
  } catch (error) {
    if (activePageRenders.get(key)?.token === token) activePageRenders.delete(key);
    throw error;
  }
  void runAppWorkspacePageRenderTask({
    workspaceDir: workspace.workspace_dir,
    pageId: input.page_id,
    token,
    sourceSha256,
  });
  return {
    status: "queued",
    already_queued: false,
    workspace_dir: workspace.workspace_dir,
    manifest_path: manifestPath,
    page_index: pageIndex,
    page_number: pageIndex + 1,
    slide_id: input.page_id,
    layout_id: normalizeString(slides[pageIndex]?.layout_id) || input.page_id,
    title: normalizeString(slides[pageIndex]?.title) || input.page_id,
    render_attempt: renderAttempt,
    source_sha256: sourceSha256,
    submitted_at: submittedAt,
  };
}

export interface PerformAppWorkspacePagePreviewsResult {
  workspace_dir: string;
  pages: Array<{
    page_id: string;
    page_number: number;
    status: "rendered" | "render_failed" | "skipped";
    html_path: string;
    screenshot_path: string;
    last_error: string;
    duration_ms: number;
  }>;
}

/** A cache rebuild has no authority to restart or accept unfinished authoring. */
async function publishRebuiltPageSnapshot(input: {
  workspaceDir: string; pageId: string; sourceSha256: string; htmlPath: string; token?: symbol;
}): Promise<boolean> {
  return withPageProgressWriteQueue(input.workspaceDir, async () => {
    const key = `${path.normalize(input.workspaceDir)}\0${input.pageId}`;
    const active = activePageRenders.get(key);
    if (input.token ? active?.token !== input.token : Boolean(active)) return false;
    const workspace = await ensureWorkspaceFiles(input.workspaceDir);
    const progress = normalizePageProgressJson(workspace.page_progress);
    const page = progress.pages.find((item) => item.page_id === input.pageId);
    if (!page) return false;
    const source = await readFile(path.join(workspace.workspace_dir, "slides", `${input.pageId}.html`));
    if (sha256BufferHex(source) !== input.sourceSha256) return false;
    // A manual save may finish while the source snapshot is being rebuilt.
    const current = await resolveCurrentPageSnapshot({ workspaceDir: workspace.workspace_dir,
      pageId: input.pageId, snapshotPath: input.htmlPath });
    const status = hasCompletedDeckBaseline(progress) && ["accepted", "rendered", "interrupted"].includes(page.status)
      ? "accepted" : page.status;
    const next = { ...page, status, last_html_path: current.htmlPath, last_screenshot_path: "",
      render_source_sha256: input.sourceSha256, snapshot_source_sha256: input.sourceSha256 };
    if (JSON.stringify(next) !== JSON.stringify(page)) {
      await writePageProgressFile(workspace.files.page_progress, { ...progress,
        pages: progress.pages.map((item) => item.page_id === input.pageId ? next : item) });
    }
    return true;
  });
}

export async function performAppWorkspacePagePreviews(input: {
  workspace_dir: string;
}): Promise<PerformAppWorkspacePagePreviewsResult> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  const progress = normalizePageProgressJson(workspace.page_progress);
  const results: PerformAppWorkspacePagePreviewsResult["pages"] = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, progress.pages.length) }, async () => {
    for (;;) {
      const pageIndex = index++;
      const page = progress.pages[pageIndex];
      if (!page) return;
      const started = Date.now();
      const key = `${path.normalize(workspace.workspace_dir)}\0${page.page_id}`;
      const token = Symbol("preview-rebuild");
      try {
        if (activePageRenders.has(key)) throw new Error("Page preview rendering is already in progress");
        await readManualPageRevision(workspace.workspace_dir, page.page_id);
        const sourceSha256 = sha256BufferHex(await readFile(path.join(workspace.workspace_dir, "slides", `${page.page_id}.html`)));
        activePageRenders.set(key, { token, sourceSha256, renderAttempt: page.render_attempts });
        const current = await resolveCurrentPageSnapshot({ workspaceDir: workspace.workspace_dir,
          pageId: page.page_id, snapshotPath: page.last_html_path });
        const published = await publishRebuiltPageSnapshot({ workspaceDir: workspace.workspace_dir,
          pageId: page.page_id, sourceSha256, htmlPath: current.htmlPath, token });
        if (!published) throw new Error("Page changed while rebuilding preview");
        results.push({ page_id: page.page_id, page_number: pageIndex + 1, status: "skipped",
          html_path: current.htmlPath, screenshot_path: "", last_error: "", duration_ms: Date.now() - started });
      } catch (error) {
        results.push({ page_id: page.page_id, page_number: pageIndex + 1, status: "render_failed",
          html_path: "", screenshot_path: "", last_error: error instanceof Error ? error.message : String(error),
          duration_ms: Date.now() - started });
      } finally {
        if (activePageRenders.get(key)?.token === token) activePageRenders.delete(key);
      }
    }
  }));
  return { workspace_dir: workspace.workspace_dir, pages: results.sort((a, b) => a.page_number - b.page_number) };
}

export type {
  AppendAppWorkspaceLogInput,
  AppendAppWorkspaceLogResult,
  AppPageProgress,
  AppPageProgressItem,
  AppExportArtifactInfo,
  AppExportArtifactMirror,
  AppExportArtifactPublishJob,
  AppExportArtifactPublishStatus,
  StartAppExportArtifactPublishInput,
  ExportAppPdfInput,
  ExportAppPdfResult,
  AppTemplatePlanningBlueprint,
  AppTemplatePlanningContext,
  AppTemplateGroupSummary,
  AppCreateWorkspaceSetting,
  AppPresentationRequirements,
  AppPresentationRequirementsCandidates,
  AppPresentationRequirementsSelections,
  AppWorkspaceFiles,
  AppWorkspaceOutline,
  AppWorkspaceOutlineItem,
  AppOutlineSource,
  AppOutlineTextSegment,
  AppOutlineResearchDirection,
  AppOutlineResearchPlan,
  AppWorkspaceResult,
  AppWorkspaceSummary,
  AppWorkspaceTemplateSelection,
  CreateAppWorkspaceInput,
  CreateAppWorkspaceResult,
  GetAppPageProgressInput,
  GetAppPageEditContextInput,
  GetAppPageEditContextResult,
  SaveAppManualPageRevisionInput,
  SaveAppManualPageRevisionResult,
  RestoreAppPageSourceVersionInput,
  RestoreAppPageSourceVersionResult,
  PrepareAppPageRefinementInput,
  PrepareAppPageRefinementResult,
  CommitAppDeckRefinementInput,
  CommitAppDeckRefinementResult,
  GetAppTemplateGroupInput,
  GetAppTemplatePlanningContextInput,
  GetAppWorkspaceThemeContextInput,
  GetAppWorkspaceOutlineInput,
  GetAppWorkspaceRequirementsInput,
  GetAppWorkspaceCoverInput,
  GetAppWorkspaceCoverResult,
  GetAppWorkspacePageImageInput,
  GetAppWorkspacePageImageResult,
  ListAppTemplateGroupsResult,
  ListAppBatchTestRunsResult,
  ListAppWorkspacesResult,
  OpenAppWorkspaceInput,
  PatchAppWorkspaceSettingsResult,
  RecordAppPageProgressInput,
  RecordAppWorkspaceStyleGuideInput,
  RecordAppWorkspaceStyleGuideResult,
  GetAppWorkspaceStyleGuideStatusInput,
  GetAppWorkspaceStyleGuideStatusResult,
  GetAppWorkspaceStyleGuideResult,
  InitializeAppPageProgressInput,
  RecordAppWorkspaceThemeTokenInput,
  RecordAppWorkspaceThemeTokenResult,
  RecordAppPdfExportInput,
  GetAppExportArtifactInput,
  RenderAppWorkspaceDeckHtmlInput,
  RenderAppWorkspaceDeckHtmlResult,
  RenderAppWorkspacePagePreviewInput,
  RenderAppWorkspacePagePreviewResult,
  RenderedAppWorkspacePagePreviewResult,
  SubmitAppWorkspaceDeckHtmlResult,
  SelectAppWorkspaceTemplateInput,
  SelectAppWorkspaceTemplateResult,
  ConfirmAppWorkspaceOutlineInput,
  ResetAppWorkspaceOutlineInput,
  SaveAppWorkspaceOutlineDraftInput,
  UpdateAppWorkspaceRequirementsInput,
  UpdateAppWorkspaceSettingsInput,
  UpdateAppWorkspaceTitleInput,
  ValidateAppWorkspaceThemeTokenInput,
  AppWorkspaceThemeContext,
  AppWorkspaceThemeValidationResult,
} from "./types.js";

// Single-page alternatives deliberately have their own state and artifact paths.
// They never enter Deck Generation or reset the accepted Page Progress.
const activeCandidateRenders = new Set<string>();

async function regenerationBaseline(workspace: AppWorkspaceResult): Promise<string> {
  const outline = normalizeOutlineJson(workspace.outline);
  const progress = normalizePageProgressJson(workspace.page_progress);
  const values = await Promise.all(outline.items.map(async (item) => {
    await readManualPageRevision(workspace.workspace_dir, item.page_id!);
    const page = progress.pages.find((entry) => entry.page_id === item.page_id);
    return [item, fingerprint(await readFile(path.join(workspace.workspace_dir, "slides", `${item.page_id}.html`))),
      page?.last_html_path ? fingerprint(await readFile(page.last_html_path)) : null,
      await readManualPageRevision(workspace.workspace_dir, item.page_id!)];
  }));
  const master = await readFile(workspace.files.visual_master, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return fingerprint(JSON.stringify([outline, workspace.requirements, values, master]));
}

async function assertRegenerationAvailable(workspace: AppWorkspaceResult) {
  const progress = normalizePageProgressJson(workspace.page_progress);
  if (normalizeOutlineJson(workspace.outline).status !== "confirmed" || progress.final_deck_render.status !== "completed"
    || progress.pages.some((page) => page.status !== "accepted")) {
    throw new Error("PAGE_REGENERATION_DECK_NOT_READY");
  }
  const run = await findGenerationRunForWorkspace(WORKSPACE_ROOT, workspace.workspace_id);
  if (run && ["preparing", "active", "committing"].includes(run.state)) throw new Error("PAGE_REGENERATION_WORKSPACE_BUSY");
  const exportJob = await getAppPptxExportStatus({ workspace_dir: workspace.workspace_dir });
  if (["queued", "validating", "converting"].includes(exportJob.status)) throw new Error("PAGE_REGENERATION_WORKSPACE_BUSY");
  if (activeDeckRenders.has(path.normalize(workspace.workspace_dir))) throw new Error("PAGE_REGENERATION_WORKSPACE_BUSY");
}

export async function createAppPageRegeneration(input: {
  workspace_dir: string; page_id: string; count: number; outline: unknown; reference_path: string; owner_id: string; mode?: "regenerate" | "beautify";
}): Promise<PageRegenerationBatch> {
  const workspaceDir = normalizeWorkspaceDir(input.workspace_dir);
  const { workspace, batch } = await withBatchLock(workspaceDir, async () => {
    const workspace = await ensureWorkspaceFiles(workspaceDir);
    await assertRegenerationAvailable(workspace);
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 10) throw new Error("PAGE_REGENERATION_INVALID_COUNT");
    if (input.mode !== undefined && !["regenerate", "beautify"].includes(input.mode)) throw new Error("Invalid page alternatives mode");
    const beautify = input.mode === "beautify";
    if (typeof input.owner_id !== "string" || !/^[0-9a-f-]{36}$/.test(input.owner_id)) throw new Error("Invalid candidate generation owner");
    const outline = normalizeOutlineJson(workspace.outline);
    const pageIndex = outline.items.findIndex((page) => page.page_id === input.page_id);
    if (pageIndex < 0) throw new Error("PAGE_REGENERATION_PAGE_NOT_FOUND");
    const item = beautify ? outline.items[pageIndex] : normalizeValidOutlineItem({ ...getPlainRecord(input.outline), page_id: input.page_id }, pageIndex, { require_page_id: true });
    if (!beautify) await validateOutlineImages(workspace.workspace_dir, [item]);
    if (item.page_type !== outline.items[pageIndex].page_type) throw new Error("Page regeneration cannot change page type");
    if (!beautify) {
      const catalog = await listAppWorkspaceTemplateReferences({ workspace_dir: workspace.workspace_dir });
      if (!catalog.reference_html_pages.some((reference) => reference.path === input.reference_path)) throw new Error("Unknown aesthetic reference");
    }
    const batch: PageRegenerationBatch = {
      id: randomUUID(), page_id: input.page_id, page_index: pageIndex, status: "running", outline: item,
      mode: input.mode ?? "regenerate", reference_path: beautify ? "" : input.reference_path, base_fingerprint: await regenerationBaseline(workspace),
      candidates: Array.from({ length: input.count }, () => ({ id: randomUUID(), status: "generating" })),
      created_at: new Date().toISOString(),
      owner_id: input.owner_id, lease_expires_at: Date.now() + 120_000,
    };
    if (!beautify) await writeBatch(workspace.workspace_dir, batch);
    return { workspace, batch };
  });
  if (batch.mode !== "beautify") return batch;
  // Rendering may wait for the shared browser queue. Keep it outside the batch
  // lock so other batches can submit candidates and renew their execution lease.
  try {
    const page = normalizePageProgressJson(workspace.page_progress).pages.find((page) => page.page_id === batch.page_id)!;
    Object.assign(batch, await prepareBeautificationSource({
      workspaceDir, batchId: batch.id, pageId: batch.page_id, pageIndex: batch.page_index,
      renderedSourceHash: page.render_source_sha256, snapshotSourceHash: page.snapshot_source_sha256,
      snapshotHtmlPath: page.last_html_path,
      manuallyEdited: Boolean(await readManualPageRevision(workspaceDir, batch.page_id)),
      render: (input) => buildDeckPageScreenshotFromManifest({ ...input, screenshot: false }),
    }));
    await withBatchLock(workspaceDir, async () => {
      const current = await ensureWorkspaceFiles(workspaceDir);
      await assertRegenerationAvailable(current);
      if (batch.base_fingerprint !== await regenerationBaseline(current)) throw new Error("PAGE_REGENERATION_CONFLICT");
      batch.lease_expires_at = Date.now() + 120_000;
      await writeBatch(workspaceDir, batch);
    });
    return batch;
  } catch (error) {
    await rm(batchDirectory(workspaceDir, batch.id), { recursive: true, force: true });
    throw error;
  }
}

export async function getAppPageRegeneration(input: {
  workspace_dir: string; batch_id?: string; page_id?: string; owner_id?: string; mode?: "regenerate" | "beautify";
}): Promise<PageRegenerationBatch | null> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  return withBatchLock(workspace.workspace_dir, async () => {
    const batch = input.batch_id ? await readBatch(workspace.workspace_dir, input.batch_id)
      : await latestBatch(workspace.workspace_dir, input.page_id ?? "", input.mode);
    if (!batch) return null;
    let changed = false;
    if (batch.status === "running" && input.owner_id === batch.owner_id && batch.lease_expires_at > Date.now()) {
      batch.lease_expires_at = Date.now() + 120_000;
      changed = true;
    }
    for (const candidate of batch.candidates) {
      if ((candidate.status === "rendering" && !activeCandidateRenders.has(candidate.id))
        || (candidate.status === "generating" && batch.lease_expires_at <= Date.now())) {
        candidate.status = "failed";
        candidate.error = "PAGE_REGENERATION_INTERRUPTED";
        changed = true;
      }
    }
    if (changed) {
      batch.status = batch.candidates.some((candidate) => ["generating", "rendering"].includes(candidate.status)) ? "running" : "ready";
      await writeBatch(workspace.workspace_dir, batch);
    }
    return batch;
  });
}

export async function failAppPageRegenerationCandidate(input: {
  workspace_dir: string; batch_id: string; candidate_id: string; error: string;
}): Promise<PageRegenerationBatch> {
  const workspaceDir = normalizeWorkspaceDir(input.workspace_dir);
  return withBatchLock(workspaceDir, async () => {
    const batch = await readBatch(workspaceDir, input.batch_id);
    const candidate = batch.candidates.find((item) => item.id === input.candidate_id);
    if (!candidate) throw new Error("Unknown regeneration candidate");
    if (batch.status !== "adopted" && candidate.status === "generating") {
      candidate.status = "failed";
      candidate.error = String(input.error).slice(0, 2000);
      batch.status = batch.candidates.some((item) => ["generating", "rendering"].includes(item.status)) ? "running" : "ready";
      await writeBatch(workspaceDir, batch);
    }
    return batch;
  });
}

export async function submitAppPageRegenerationCandidate(input: {
  workspace_dir: string; batch_id: string; candidate_id: string; staging_file_path: string; expected_size_bytes: number;
}): Promise<PageRegenerationBatch> {
  const workspace = await ensureWorkspaceFiles(input.workspace_dir);
  return withBatchLock(workspace.workspace_dir, async () => {
    const batch = await readBatch(workspace.workspace_dir, input.batch_id);
    const candidate = batch.candidates.find((item) => item.id === input.candidate_id);
    if (!candidate || batch.status === "adopted") throw new Error("Unknown or closed regeneration candidate");
    if (candidate.status !== "generating") return batch; // retry-safe submission
    if (!Number.isInteger(input.expected_size_bytes) || input.expected_size_bytes < 1 || input.expected_size_bytes > 16 * 1024 * 1024) throw new Error("Invalid candidate HTML size");
    assertAbsolutePath(input.staging_file_path, "staging_file_path");
    const bytes = await readFile(input.staging_file_path);
    if (bytes.length !== input.expected_size_bytes) throw new Error("Candidate HTML size mismatch");
    const directory = candidateDirectory(workspace.workspace_dir, batch.id, candidate.id);
    await mkdir(path.join(directory, "slides"), { recursive: true });
    candidate.source_path = path.join(directory, "slides", `${batch.page_id}.html`);
    const sourceBytes = Buffer.from(stampSlideFormat(bytes.toString("utf8"), normalizePresentationRequirements(workspace.requirements).selections.aspect_ratio));
    candidate.source_sha256 = fingerprint(sourceBytes);
    await writeFile(candidate.source_path, sourceBytes);
    // The small rendering index preserves the real page number and deck size.
    // Only the selected Page Source is read by the single-page renderer.
    const manifestPath = path.join(directory, "manifest.json");
    await copyFile(path.join(workspace.workspace_dir, "manifest.json"), manifestPath);
    candidate.status = "rendering";
    activeCandidateRenders.add(candidate.id);
    try { await writeBatch(workspace.workspace_dir, batch); }
    catch (error) { activeCandidateRenders.delete(candidate.id); throw error; }
    void (async () => {
      let result: { htmlPath: string; screenshotPath: string } | undefined;
      let errorMessage = "";
      try {
        result = await buildDeckPageScreenshotFromManifest({ manifestPath, outputDir: directory, name: "candidate", page: batch.page_index + 1, screenshot: false });
      } catch (error) { errorMessage = error instanceof Error ? error.message : String(error); }
      try {
        await withBatchLock(workspace.workspace_dir, async () => {
          const latest = await readBatch(workspace.workspace_dir, batch.id);
          const target = latest.candidates.find((item) => item.id === candidate.id)!;
          if (latest.status === "adopted" || target.status !== "rendering") return;
          Object.assign(target, result ? { status: "ready", html_path: result.htmlPath, screenshot_path: result.screenshotPath,
            html_sha256: fingerprint(await readFile(result.htmlPath)) }
            : { status: "failed", error: errorMessage });
          latest.status = latest.candidates.some((item) => ["generating", "rendering"].includes(item.status)) ? "running" : "ready";
          await writeBatch(workspace.workspace_dir, latest);
        });
      } finally { activeCandidateRenders.delete(candidate.id); }
    })().catch((error) => process.stderr.write(`[page-regeneration] ${String(error)}\n`));
    return batch;
  });
}

export async function adoptAppPageRegeneration(input: {
  workspace_dir: string; batch_id: string; candidate_id: string;
}): Promise<PageRegenerationBatch> {
  const workspaceDir = normalizeWorkspaceDir(input.workspace_dir);
  return withBatchLock(workspaceDir, () => withGenerationWorkspaceLock(workspaceDir, async () => {
    const workspace = await ensureWorkspaceFiles(workspaceDir);
    const batch = await readBatch(workspaceDir, input.batch_id);
    if (batch.status === "adopted") {
      if (batch.selected_id !== input.candidate_id) throw new Error("PAGE_REGENERATION_ALREADY_ADOPTED");
      return batch;
    }
    await assertRegenerationAvailable(workspace);
    if (batch.status !== "ready") throw new Error("PAGE_REGENERATION_STILL_RUNNING");
    if (batch.base_fingerprint !== await regenerationBaseline(workspace)) throw new Error("PAGE_REGENERATION_CONFLICT");
    const candidate = batch.candidates.find((item) => item.id === input.candidate_id);
    if (!candidate || candidate.status !== "ready" || !candidate.source_path || !candidate.html_path) throw new Error("PAGE_REGENERATION_NOT_READY");
    const source = await readFile(candidate.source_path);
    const html = await readFile(candidate.html_path, "utf8");
    if (fingerprint(source) !== candidate.source_sha256 || fingerprint(html) !== candidate.html_sha256) throw new Error("PAGE_REGENERATION_CONFLICT");
    const finalDirectory = path.join(workspaceDir, "output", "page-regenerations", batch.page_id, batch.id);
    const htmlPath = path.join(finalDirectory, "page.html");
    const screenshotPath = "";
    const originalDirectory = candidateDirectory(workspaceDir, batch.id, candidate.id);
    const publishedHtml = html.split(originalDirectory).join(finalDirectory);
    const updatedAt = new Date().toISOString();
    const outline = normalizeOutlineJson(workspace.outline);
    const beautify = batch.mode === "beautify";
    const nextOutline = beautify ? outline : { ...outline, items: outline.items.map((item) => item.page_id === batch.page_id ? batch.outline : item), updated_at: updatedAt };
    if (!beautify) await validateOutlineImages(workspaceDir, nextOutline.items);
    const progress = normalizePageProgressJson(workspace.page_progress);
    const nextPages = progress.pages.map((page) => page.page_id === batch.page_id ? {
      ...page, status: "accepted", last_html_path: htmlPath, last_screenshot_path: screenshotPath,
      render_source_sha256: fingerprint(source), snapshot_source_sha256: fingerprint(source),
      last_error: "", visual_review: null, updated_at: updatedAt,
    } : page);
    const pages = await Promise.all(nextOutline.items.map((item) => item.page_id === batch.page_id ? publishedHtml
      : readFile(nextPages.find((page) => page.page_id === item.page_id)!.last_html_path!, "utf8")));
    const manifestPath = path.join(workspaceDir, "manifest.json");
    const sourceFingerprint = createHash("sha256").update(await readFile(manifestPath));
    pages.forEach((page) => sourceFingerprint.update(page));
    const outputDir = path.join(workspaceDir, "output", "app-render");
    const deckHtmlPath = path.join(outputDir, `${workspace.workspace_id}-review-deck.html`);
    const nextProgress = { ...progress, pages: nextPages, updated_at: updatedAt, final_deck_render: {
      status: "completed", message: null, error: null, output_dir: outputDir, deck_html_path: deckHtmlPath,
      rendered_at: updatedAt, updated_at: updatedAt, source_fingerprint: sourceFingerprint.digest("hex"),
    } };
    const task = getPlainRecord(workspace.task);
    const artifacts = { ...getPlainRecord(task.artifacts) };
    delete artifacts.pptx;
    delete artifacts.pdf;
    const adopted: PageRegenerationBatch = { ...batch, status: "adopted", selected_id: candidate.id, candidates: [{
      ...candidate, source_path: path.join(workspaceDir, "slides", `${batch.page_id}.html`), html_path: htmlPath, screenshot_path: screenshotPath,
      html_sha256: fingerprint(publishedHtml),
    }] };
    const files = new Map<string, string | Buffer | null>();
    const put = (absolute: string, value: string | Buffer | null) => files.set(path.relative(workspaceDir, absolute), value);
    put(adopted.candidates[0].source_path!, source);
    put(htmlPath, publishedHtml);
    put(deckHtmlPath, buildStaticDeckHtml({ title: nextOutline.title, pages }));
    if (!beautify) put(workspace.files.outline, JSON.stringify(nextOutline, null, 2));
    put(workspace.files.page_progress, JSON.stringify(nextProgress, null, 2));
    put(workspace.files.task, JSON.stringify({ ...task, artifacts, updated_at: updatedAt }, null, 2));
    if (!beautify) {
      const selections = await getAppWorkspaceAestheticReferenceSelections({ workspace_dir: workspaceDir });
      const nextSelections = { ...selections, pages: { ...selections.pages, [batch.page_id]: {
        target: "page", page_id: batch.page_id, path: batch.reference_path, selected_at: updatedAt,
      } }, updated_at: updatedAt };
      put(workspace.files.aesthetic_reference_selections, JSON.stringify(nextSelections, null, 2));
    }
    put(path.join(workspaceDir, "manual-edits", batch.page_id, "manifest.json"), null);
    put(path.join(workspaceDir, "output", "pptx-export.json"), null);
    put(path.join(batchDirectory(workspaceDir, batch.id), "batch.json"), JSON.stringify(adopted, null, 2));
    // Recheck after preparing all derived files, before any authoritative write.
    await assertRegenerationAvailable(await ensureWorkspaceFiles(workspaceDir));
    if (batch.base_fingerprint !== await regenerationBaseline(await ensureWorkspaceFiles(workspaceDir))) throw new Error("PAGE_REGENERATION_CONFLICT");
    publishPageRegenerationFiles(workspaceDir, files);
    await rm(path.join(batchDirectory(workspaceDir, batch.id), "candidates"), { recursive: true, force: true }).catch(() => undefined);
    await rm(path.join(batchDirectory(workspaceDir, batch.id), "input"), { recursive: true, force: true }).catch(() => undefined);
    await removeManualPageRevision(workspaceDir, batch.page_id).catch(() => undefined);
    // Old generated previews no longer referenced by any accepted page can be
    // removed. Shared assets and other pages' artifacts are never traversed.
    const retained = new Set(nextPages.flatMap((page) => [page.last_html_path, page.last_screenshot_path]));
    const previousPage = progress.pages.find((page) => page.page_id === batch.page_id);
    for (const previousPath of [previousPage?.last_html_path, previousPage?.last_screenshot_path]) {
      if (!previousPath || retained.has(previousPath)) continue;
      const relative = path.relative(path.join(workspaceDir, "output"), previousPath);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        await rm(previousPath, { force: true }).catch(() => undefined);
      }
    }
    publishWorkspaceSnapshotFromTrigger(workspaceDir);
    return adopted;
  }));
}
