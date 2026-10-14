import type { Locale } from "../i18n/locales";
import type { CommitManualPageImageInput, ManualPageImage, RefreshManualPageResourcesInput, ManualPageResource } from "./types";
import type { PageLayoutAuditResult } from "./types";
import type { GetWorkspacePageHtmlInput, WorkspacePageHtml, PagePreviewPreparation } from "./pageHtmlPreview";
import type { GetWorkspacePageThumbnailInput, PageThumbnail } from "./pageThumbnail";
import type { PageRegenerationBatch, PageRegenerationInput } from "./pageRegenerationTypes";
import type {
  AppendWorkspaceLogInput,
  AppendWorkspaceLogResult,
  WriteResearchTestFileResult,
  CreateProjectInput,
  CreateWorkspaceInput,
  CreateWorkspaceResult,
  DeleteWorkspaceResult,
  DuplicateWorkspaceInput,
  DuplicateWorkspaceResult,
  GetExportArtifactDownloadUrlInput,
  GetWorkspacePageFileFingerprintsInput,
  GetWorkspacePageFileFingerprintsResult,
  GetPageEditContextInput,
  GetPageEditContextResult,
  HostUploadRef,
  GetWorkspaceCoverInput,
  GetWorkspaceCoverResult,
  GetWorkspacePageImageInput,
  GetWorkspacePageImageResult,
  GetWorkspaceOutlineInput,
  ListWorkspacesResult,
  AutoRestoreMissingWorkspacesResult,
  ListTemplatesResult,
  PageProgress,
  PptEngineRuntimeInfo,
  PptAgentResourceInfo,
  OpenWorkspaceInput,
  PatchWorkspaceDefaultsInput,
  SharedResearchContextResult,
  SharedResearchImageBatch,
  SharedResearchProgressOperation,
  PatchSharedResearchProgressResult,
  PublishSharedResearchBatchResult,
  ImportSharedResearchImageResult,
  PrepareSharedResearchImageCandidateResult,
  UploadSharedResearchImageCandidateResult,
  CleanupSharedResearchImageStagingResult,
  ProjectResult,
  PptxExportJob,
  ExportPdfInput,
  ExportPdfResult,
  ExportArtifactDownloadUrlResult,
  ExportArtifactPublishJob,
  PrepareWorkspaceDiagnosticBundleInput,
  PrepareWorkspaceDiagnosticBundleResult,
  RecordDeckReviewInput,
  RecordPageProgressInput,
  RecordPdfExportInput,
  RecordRequirementsInput,
  RecordOutlineInput,
  RenderDeckHtmlInput,
  RenderDeckHtmlResult,
  RenderDeckHtmlSubmissionResult,
  RenderWorkspacePagePreviewInput,
  RenderWorkspacePagePreviewSubmissionResult,
  UploadCurrentPageScreenshotInput,
  SaveManualPageRevisionInput,
  SaveManualPageRevisionResult,
  CommitManagedFontUploadInput,
  CommitManagedFontUploadResult,
  ManagedFontRuntimeFamily,
  RestorePageSourceVersionResult,
  RestorePageSourceVersionInput,
  PageRecoveryOption,
  SelectTemplateInput,
  SelectTemplateResult,
  StartPptxExportInput,
  TemplatePlanningContext,
  WorkspaceThemeContext,
  WorkspaceThemeValidationResult,
  RecordWorkspaceThemeTokenResult,
  UpdateWorkspaceSettingsInput,
  UpdateWorkspaceSettingsResult,
  ResetWorkspaceOutlineInput,
  SaveWorkspaceOutlineInput,
  UpdateWorkspaceTitleInput,
  CommitUploadedSourceHostUploadInput,
  CommitUploadedSourceHostUploadResult,
  ClearWorkspaceStyleProfileResult,
  CommitStyleProfileReferenceHostUploadInput,
  CommitStyleProfileReferenceHostUploadResult,
  GetStyleProfilePreviewResult,
  GetStyleProfileResult,
  GetStyleProfileCreationContextResult,
  StyleProfileDraftFingerprint,
  GetStyleProfileDraftResult,
  GetWorkspaceStyleProfileResult,
  ListStyleProfilesResult,
  PrepareStyleProfileCreationInput,
  PrepareStyleProfileCreationResult,
  PublishStyleProfileInput,
  PublishStyleProfileResult,
  SelectWorkspaceStyleProfileResult,
  ListUploadedSourcesResult,
  RemoveUploadedSourceInput,
  RemoveUploadedSourceResult,
  RunUploadedSourcePreflightResult,
  ContinueUploadedSourcePdfOcrResult,
  GetUploadedSourcePreflightStatusResult,
  GetUploadedSourcePreflightTextResult,
  GetUploadedSourcePreflightChunksResult,
  AttachmentBrief,
  AttachmentBriefPaths,
  AttachmentContext,
  ListAttachmentBriefsResult,
  PrepareUploadedSourceAnalysisWorkspaceResult,
  PresentationRequirements,
  UploadedSourceAnalysisDraftFingerprint,
  UploadedSourceAnalysisDraftType,
  WorkspaceOutline,
  WorkspaceDefaultsResult,
  WorkspaceResult
  , WorkspaceAuthoringKitResult
  , PrepareWorkspacePageSourcesResult
  , WorkspacePageSourceFingerprint
  , CommitWorkspaceStyleGuideInput
  , CommitWorkspaceStyleGuideResult
  , ConfirmWorkspaceRequirementsInput
  , ConfirmWorkspaceRequirementsResult
  , WorkspaceStyleGuideStatus
  , WorkspaceStyleGuide
  , CommitWorkspaceHtmlInput
  , CommitWorkspacePageHtmlInput
  , WorkspaceHtmlArtifact
  , TemplateReferenceCatalog
  , TemplateReferenceHtmlPage
  , AestheticReferenceSelections
  , CommitVisualRhythmInput
  , VisualRhythmStatus
  , VisualRhythm
  , CommitPageVisualPlanInput
  , PageVisualPlanStatus
  , PageVisualPlan
  , WorkspacePersistentElementsReferenceStatus
  , PreparePageRefinementInput
  , PreparePageRefinementResult
  , CommitDeckRefinementInput
  , CommitDeckRefinementResult
  , GenerationRunKind
  , GenerationRunTransaction
  , PrepareGenerationRunResult
  , CommitGenerationRunResult
  , PublishWorkspaceSnapshotResult
  , GetWorkspaceSnapshotInfoResult
  , WorkspaceSnapshotPublishState
  , RestoreWorkspaceSnapshotInput
  , WorkspaceSnapshotRestoreState
  , ReconcileWorkspaceWithCloudInput
  , ReconcileWorkspaceWithCloudResult
  , GetWorkspaceSnapshotSyncStateResult
  , ListMyWorkResult
  , PerformanceEvent
  , PerformanceRunSummary
  , ListPerformanceRunsResult
  , FinalizePerformanceRunResult
  , PreparePerformanceReportResult
  , BatchTestCaseInput
  , BatchTestCaseRecord
  , BatchTestRunRecord
  , BatchTestTargetStage
  , DeleteBatchTestRunResult
  , ListBatchTestRunsResult
  , PrepareBatchTestBundleResult
} from "./types";
import { createAnnaPptBackend } from "./annaPptBackend";
import type { UserTemplateBackend } from "../features/user-templates/types";
import { connectAnnaRuntime } from "../runtime/annaRuntime";
import type { AnnaToolJobSnapshot } from "../runtime/annaRuntime";
import { detectRuntimeMode } from "../runtime/runtimeMode";

export interface CreateBatchTestRunInput {
  test_id?: string;
  target_stage: BatchTestTargetStage;
  cases: BatchTestCaseInput[];
}

/**
 * 性能报告语言契约：报告语言跟随界面语言，四语直通（Day 7 起 engine 端已四语化）。
 */
export type PerfReportLocale = "en" | "zh" | "ja" | "de";

export function toPerfReportLocale(locale: Locale): PerfReportLocale {
  return locale;
}

export interface PptBackend extends UserTemplateBackend {
  outlineImageDescriptions(input: { workspace_dir: string } & (
    | { action: "get_run"; run_key: string }
    | { action: "mark_attempted"; run_key: string; sha256s: string[] }
    | { action: "describe"; asset_id: string; description: string }
  )): Promise<{ attempted_sha256?: string[]; image?: import("./types").SharedResearchImageAsset }>;
  pageImageSearch(input: import("./pageImageSearchTypes").PageImageSearchRequest): Promise<import("./pageImageSearchTypes").PageImageSearchTask | null>;
  pageImageUpload(input: import("./pageImageUploadTypes").PageImageUploadRequest): Promise<import("./pageImageUploadTypes").PageImageUploadResult>;
  pageRegeneration(input: PageRegenerationInput): Promise<PageRegenerationBatch | null>;
  getRuntimeInfo(): Promise<PptEngineRuntimeInfo>;
  getAgentResourceInfo(): Promise<PptAgentResourceInfo>;
  listPerformanceRuns(): Promise<ListPerformanceRunsResult>;
  startPerformanceRun(input: { app_version: string; environment?: Record<string, string | number | boolean | null>; initial_settings?: Record<string, unknown> }): Promise<PerformanceRunSummary>;
  appendPerformanceEvents(input: { run_id: string; events: PerformanceEvent[] }): Promise<{ appended: number; run: PerformanceRunSummary }>;
  finalizePerformanceRun(input: { run_id: string; locale: PerfReportLocale; force?: boolean }): Promise<FinalizePerformanceRunResult>;
  regeneratePerformanceReport(input: { run_id: string; locale: PerfReportLocale }): Promise<PerformanceRunSummary>;  abandonPerformanceRun(input: { run_id: string }): Promise<PerformanceRunSummary>;
  deletePerformanceRun(input: { run_id: string }): Promise<{ deleted: true; run_id: string }>;
  preparePerformanceReport(input: { run_id: string }): Promise<PreparePerformanceReportResult>;
  createBatchTestRun(input: CreateBatchTestRunInput): Promise<{ run: BatchTestRunRecord }>;
  listBatchTestRuns(): Promise<ListBatchTestRunsResult>;
  updateBatchTestCase(input: { root_dir: string; case_id: string; status: BatchTestCaseRecord["status"]; error?: string | null; pptx_path?: string | null; token_usage?: BatchTestCaseRecord["token_usage"]; performance_metrics?: BatchTestCaseRecord["performance_metrics"]; research_routing_result?: BatchTestCaseRecord["research_routing_result"]; page_refinement_classification_result?: BatchTestCaseRecord["page_refinement_classification_result"]; template_recommendation_result?: BatchTestCaseRecord["template_recommendation_result"] }): Promise<BatchTestRunRecord>;
  updateBatchTestRun(input: { root_dir: string; status: BatchTestRunRecord["status"]; performance_metrics?: BatchTestRunRecord["performance_metrics"] }): Promise<BatchTestRunRecord>;
  deleteBatchTestRun(input: { root_dir: string }): Promise<DeleteBatchTestRunResult>;
  materializePerformanceRun(input: { run_id: string; destination_dir: string }): Promise<{ run_id: string; destination_dir: string; files: string[] }>;
  prepareBatchTestBundle(input: { root_dir: string }): Promise<PrepareBatchTestBundleResult>;
  beginGenerationRun(input: { workspace_dir: string; run_kind: GenerationRunKind; origin_page_id?: string | null }): Promise<GenerationRunTransaction>;
  prepareGenerationRun(input: { run_id: string }): Promise<PrepareGenerationRunResult>;
  abandonGenerationRun(input: { run_id: string }): Promise<GenerationRunTransaction>;
  commitGenerationRun(input: { run_id: string }): Promise<CommitGenerationRunResult>;
  cleanupGenerationRun(input: { run_id: string }): Promise<{ cleaned: boolean }>;
  getWorkspaceGenerationRun(input: { workspace_dir: string }): Promise<GenerationRunTransaction | null>;
  publishWorkspaceSnapshot(input: { workspace_dir: string }): Promise<PublishWorkspaceSnapshotResult>;
  getWorkspaceSnapshotInfo(input: {
    workspace_dir: string;
    revision?: string;
  }): Promise<GetWorkspaceSnapshotInfoResult>;
  runWorkspaceSnapshotPublishDedicatedInvoke(input: {
    workspace_dir: string;
    trigger: string;
  }): Promise<WorkspaceSnapshotPublishState>;
  getWorkspaceSnapshotPublishStatus(input: { workspace_dir: string }): Promise<WorkspaceSnapshotPublishState>;
  restoreWorkspaceSnapshot(input: RestoreWorkspaceSnapshotInput): Promise<WorkspaceSnapshotRestoreState>;
  getWorkspaceSnapshotRestoreStatus(input: { workspace_dir: string }): Promise<WorkspaceSnapshotRestoreState>;
  reconcileWorkspaceWithCloud(input: ReconcileWorkspaceWithCloudInput): Promise<ReconcileWorkspaceWithCloudResult>;
  getWorkspaceSnapshotSyncState(input: { workspace_dir: string }): Promise<GetWorkspaceSnapshotSyncStateResult>;
  listMyWork(): Promise<ListMyWorkResult>;
  listWorkspaces(): Promise<ListWorkspacesResult>;
  autoRestoreMissingWorkspaces(): Promise<AutoRestoreMissingWorkspacesResult>;
  getWorkspaceDefaults(): Promise<WorkspaceDefaultsResult>;
  patchWorkspaceDefaults(input: PatchWorkspaceDefaultsInput): Promise<WorkspaceDefaultsResult>;
  createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult>;
  openWorkspace(input: OpenWorkspaceInput): Promise<WorkspaceResult>;
  installWorkspaceAuthoringKit(input: { workspace_dir: string }): Promise<WorkspaceAuthoringKitResult>;
  prepareWorkspacePageSources(input: { workspace_dir: string; reset_existing?: boolean }): Promise<PrepareWorkspacePageSourcesResult>;
  reconcileWorkspacePageSources(input: { workspace_dir: string }): Promise<{
    paths: PrepareWorkspacePageSourcesResult["paths"];
    repaired_page_ids: string[];
    manifest: PrepareWorkspacePageSourcesResult["manifest"];
  }>;
  getWorkspacePageSourceFingerprint(input: { workspace_dir: string; page_id: string }): Promise<WorkspacePageSourceFingerprint>;
  commitWorkspaceStyleGuide(input: CommitWorkspaceStyleGuideInput): Promise<CommitWorkspaceStyleGuideResult>;
  commitVisualRhythm(input: CommitVisualRhythmInput): Promise<VisualRhythmStatus>;
  getVisualRhythmStatus(input: { workspace_dir: string }): Promise<VisualRhythmStatus>;
  getVisualRhythm(input: { workspace_dir: string }): Promise<VisualRhythm>;
  commitPageVisualPlan(input: CommitPageVisualPlanInput): Promise<PageVisualPlanStatus>;
  getPageVisualPlanStatus(input: { workspace_dir: string; page_id: string }): Promise<PageVisualPlanStatus>;
  getPageVisualPlan(input: { workspace_dir: string; page_id: string }): Promise<PageVisualPlan>;
  confirmWorkspaceRequirements(input: ConfirmWorkspaceRequirementsInput): Promise<ConfirmWorkspaceRequirementsResult>;
  getWorkspaceStyleGuideStatus(input: { workspace_dir: string }): Promise<WorkspaceStyleGuideStatus>;
  getWorkspaceStyleGuide(input: { workspace_dir: string }): Promise<WorkspaceStyleGuide>;
  commitWorkspaceVisualMasterHtml(input: CommitWorkspaceHtmlInput): Promise<WorkspaceHtmlArtifact>;
  getWorkspaceVisualMasterHtml(input: { workspace_dir: string }): Promise<WorkspaceHtmlArtifact & { content: string }>;
  commitWorkspacePageHtml(input: CommitWorkspacePageHtmlInput): Promise<WorkspaceHtmlArtifact>;
  listWorkspaceTemplateReferences(input: { workspace_dir: string }): Promise<TemplateReferenceCatalog>;
  getWorkspaceTemplateReferenceHtml(input: { workspace_dir: string; path: string }): Promise<TemplateReferenceHtmlPage>;
  getWorkspaceAestheticReferenceSelections(input: { workspace_dir: string }): Promise<AestheticReferenceSelections>;
  recordWorkspaceAestheticReferenceSelection(input: { workspace_dir: string; target: "visual-master" | "page"; page_id?: string; path: string }): Promise<AestheticReferenceSelections>;
  ensureWorkspacePersistentElementsReference(input: { workspace_dir: string; reset_existing?: boolean }): Promise<WorkspacePersistentElementsReferenceStatus & { created: boolean }>;
  getWorkspacePersistentElementsReferenceStatus(input: { workspace_dir: string }): Promise<WorkspacePersistentElementsReferenceStatus>;
  typecheckWorkspacePersistentElements(input: { workspace_dir: string }): Promise<WorkspacePersistentElementsReferenceStatus>;
  initializePageProgress(input: { workspace_dir: string }): Promise<PageProgress>;
  preparePageRefinement(input: PreparePageRefinementInput): Promise<PreparePageRefinementResult>;
  commitDeckRefinement(input: CommitDeckRefinementInput): Promise<CommitDeckRefinementResult>;
  commitUploadedSourceHostUpload(input: CommitUploadedSourceHostUploadInput): Promise<CommitUploadedSourceHostUploadResult>;
  runUploadedSourcePreflight(input: { workspace_dir: string }): Promise<RunUploadedSourcePreflightResult>;
  continueUploadedSourcePdfOcr(input: { workspace_dir: string }): Promise<ContinueUploadedSourcePdfOcrResult>;
  getUploadedSourcePreflightStatus(input: { workspace_dir: string }): Promise<GetUploadedSourcePreflightStatusResult>;
  getUploadedSourcePreflightText(input: { workspace_dir: string; uploaded_source_id: string; offset?: number; limit?: number; attachment_chunk?: boolean }): Promise<GetUploadedSourcePreflightTextResult>;
  getUploadedSourcePreflightChunks(input: { workspace_dir: string; uploaded_source_id: string }): Promise<GetUploadedSourcePreflightChunksResult>;
  prepareAttachmentBrief(input: { workspace_dir: string; uploaded_source_id: string }): Promise<AttachmentBriefPaths>;
  getAttachmentBriefDraft(input: { workspace_dir: string; uploaded_source_id: string }): Promise<unknown | null>;
  recordAttachmentBrief(input: { workspace_dir: string; uploaded_source_id: string; brief: unknown }): Promise<AttachmentBrief>;
  getAttachmentBrief(input: { workspace_dir: string; uploaded_source_id: string }): Promise<AttachmentBrief | null>;
  listAttachmentBriefs(input: { workspace_dir: string }): Promise<ListAttachmentBriefsResult>;
  writeAttachmentContext(input: { workspace_dir: string; user_brief: string }): Promise<AttachmentContext>;
  getAttachmentContext(input: { workspace_dir: string }): Promise<AttachmentContext | null>;
  listStyleProfiles(): Promise<ListStyleProfilesResult>;
  getStyleProfilePreview(input: { style_profile_id: string }): Promise<GetStyleProfilePreviewResult>;
  getStyleProfile(input: { style_profile_id: string }): Promise<GetStyleProfileResult>;
  prepareStyleProfileCreation(input?: PrepareStyleProfileCreationInput): Promise<PrepareStyleProfileCreationResult>;
  commitStyleProfileReferenceHostUpload(input: CommitStyleProfileReferenceHostUploadInput): Promise<CommitStyleProfileReferenceHostUploadResult>;
  getStyleProfileCreationContext(input: { creation_id: string }): Promise<GetStyleProfileCreationContextResult>;
  getStyleProfileDraftFingerprint(input: { creation_id: string }): Promise<StyleProfileDraftFingerprint>;
  getStyleProfileDraft(input: { creation_id: string }): Promise<GetStyleProfileDraftResult>;
  publishStyleProfile(input: PublishStyleProfileInput): Promise<PublishStyleProfileResult>;
  selectWorkspaceStyleProfile(input: { workspace_dir: string; style_profile_id: string }): Promise<SelectWorkspaceStyleProfileResult>;
  getWorkspaceStyleProfile(input: { workspace_dir: string }): Promise<GetWorkspaceStyleProfileResult>;
  clearWorkspaceStyleProfile(input: { workspace_dir: string }): Promise<ClearWorkspaceStyleProfileResult>;
  listUploadedSources(input: { workspace_dir: string; include_removed?: boolean }): Promise<ListUploadedSourcesResult>;
  removeUploadedSource(input: RemoveUploadedSourceInput): Promise<RemoveUploadedSourceResult>;
  uploadUploadedSourceForAgent(input: {
    workspace_dir: string;
    uploaded_source_id: string;
    operation_id: string;
  }): Promise<{ workspace_dir: string; uploaded_source_id: string; host_upload: HostUploadRef }>;
  prepareUploadedSourceAnalysisWorkspace(input: { workspace_dir: string }): Promise<PrepareUploadedSourceAnalysisWorkspaceResult>;
  recordUploadedSourceAnalysisDraft(input: {
    workspace_dir: string;
    draft_type: UploadedSourceAnalysisDraftType;
    draft_id?: string;
    draft: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  getUploadedSourceAnalysisDraft(input: {
    workspace_dir: string;
    draft_type: UploadedSourceAnalysisDraftType;
    draft_id?: string;
  }): Promise<Record<string, unknown>>;
  getUploadedSourceAnalysisDraftFingerprint(input: {
    workspace_dir: string;
    draft_type: UploadedSourceAnalysisDraftType;
    draft_id?: string;
  }): Promise<UploadedSourceAnalysisDraftFingerprint>;
  recordUploadedSourceAnalysis(input: {
    workspace_dir: string;
    analysis: Record<string, unknown>;
    analysis_markdown?: string;
  }): Promise<Record<string, unknown>>;
  getUploadedSourceAnalysis(input: { workspace_dir: string }): Promise<Record<string, unknown>>;
  readonly diagnosticLoggingEnabled?: boolean;
  appendWorkspaceLog(input: AppendWorkspaceLogInput): Promise<AppendWorkspaceLogResult>;
  writeResearchTestFile(input: {
    run_id: string;
    file_name: "input.json" | "rounds.jsonl" | "result.md" | "meta.json";
    content: string;
    append?: boolean;
  }): Promise<WriteResearchTestFileResult>;
  getWorkspaceRequirements(input: { workspace_dir: string }): Promise<PresentationRequirements>;
  updateWorkspaceRequirements(input: {
    workspace_dir: string;
    requirements: PresentationRequirements;
  }): Promise<WorkspaceResult>;
  getWorkspaceOutline(input: GetWorkspaceOutlineInput): Promise<WorkspaceOutline>;
  resetWorkspaceOutline(input: ResetWorkspaceOutlineInput): Promise<WorkspaceResult>;
  saveWorkspaceOutlineDraft(input: SaveWorkspaceOutlineInput): Promise<WorkspaceResult>;
  confirmWorkspaceOutline(input: SaveWorkspaceOutlineInput): Promise<WorkspaceResult>;
  updateWorkspaceSettings(
    input: UpdateWorkspaceSettingsInput
  ): Promise<UpdateWorkspaceSettingsResult>;
  updateWorkspaceTitle(input: UpdateWorkspaceTitleInput): Promise<WorkspaceResult>;
  deleteWorkspace(input: { workspace_dir: string }): Promise<DeleteWorkspaceResult>;
  duplicateWorkspace(input: DuplicateWorkspaceInput): Promise<DuplicateWorkspaceResult>;
  createProject(input: CreateProjectInput): Promise<ProjectResult>;
  getProject(input: { projectDir: string }): Promise<ProjectResult>;
  recordRequirements(input: RecordRequirementsInput): Promise<ProjectResult>;
  listTemplates(): Promise<ListTemplatesResult>;
  selectTemplate(input: SelectTemplateInput): Promise<SelectTemplateResult>;
  getTemplatePlanningContext(input: { workspace_dir: string }): Promise<TemplatePlanningContext>;
  getWorkspaceThemeContext(input: { workspace_dir: string }): Promise<WorkspaceThemeContext>;
  validateWorkspaceThemeToken(input: { workspace_dir: string; token: unknown }): Promise<WorkspaceThemeValidationResult>;
  recordWorkspaceThemeToken(input: { workspace_dir: string; token?: unknown; use_default?: boolean }): Promise<RecordWorkspaceThemeTokenResult>;
  getWorkspacePageFileFingerprints(
    input: GetWorkspacePageFileFingerprintsInput
  ): Promise<GetWorkspacePageFileFingerprintsResult>;
  prepareSharedResearchWorkspace(input: { workspace_dir: string; reset_progress?: boolean }): Promise<SharedResearchContextResult>;
  getOutlineImagePreview(input: { workspace_dir: string; asset_id: string; size?: "thumbnail" | "large" }): Promise<{ preview_url: string }>;
  uploadOutlineImageForAgent(input: { workspace_dir: string; asset_id: string; operation_id: string }): Promise<{ host_upload: HostUploadRef }>;
  getSharedResearchContext(input: { workspace_dir: string }): Promise<SharedResearchContextResult>;
  patchSharedResearchProgress(input: { workspace_dir: string; operations: SharedResearchProgressOperation[] }): Promise<PatchSharedResearchProgressResult>;
  publishPreparedWebResearchBatch(input: { workspace_dir: string }): Promise<PublishSharedResearchBatchResult>;
  publishPreparedImageResearchBatch(input: { workspace_dir: string }): Promise<PublishSharedResearchBatchResult>;
  appendSharedImageResearchBatch(input: {
    workspace_dir: string;
    batch: SharedResearchImageBatch;
  }): Promise<{ workspace_dir: string; image_catalog_path: string; appended: boolean }>;
  prepareSharedResearchImageCandidate(input: {
    workspace_dir: string;
    operation_id: string;
    candidate_id: string;
    source_url: string;
    existing_file_path?: string;
    expected_sha256?: string;
  }): Promise<PrepareSharedResearchImageCandidateResult>;
  uploadSharedResearchImageCandidate(input: {
    workspace_dir: string;
    operation_id: string;
    candidate_id: string;
    local_file_path: string;
    mime_type: string;
  }): Promise<UploadSharedResearchImageCandidateResult>;
  importSharedResearchImageLocal(input: {
    workspace_dir: string;
    candidate_id: string;
    local_file_path: string;
    mime_type: string;
    size_bytes: number;
    sha256: string;
  }): Promise<ImportSharedResearchImageResult>;
  importUploadedSourceImageToResearch(input: {
    workspace_dir: string;
    uploaded_source_id: string;
    candidate_id: string;
  }): Promise<ImportSharedResearchImageResult>;
  copyUploadedSourceImageToAsset(input: {
    workspace_dir: string;
    uploaded_source_id: string;
    candidate_id: string;
    description: string;
    reason: string;
  }): Promise<ImportSharedResearchImageResult>;
  cleanupSharedResearchImageStaging(input: {
    workspace_dir: string;
    operation_id: string;
  }): Promise<CleanupSharedResearchImageStagingResult>;
  getPageProgress(input: { workspace_dir: string }): Promise<PageProgress>;
  recordPageProgress(input: RecordPageProgressInput): Promise<PageProgress>;
  auditWorkspacePageLayout(input: { workspace_dir: string; page_id: string; expected_source_sha256: string }): Promise<PageLayoutAuditResult>;
  renderWorkspacePagePreview(
    input: RenderWorkspacePagePreviewInput
  ): Promise<RenderWorkspacePagePreviewSubmissionResult>;
  uploadCurrentPageScreenshot(input: UploadCurrentPageScreenshotInput): Promise<HostUploadRef>;
  commitManualPageImage(input: CommitManualPageImageInput): Promise<ManualPageImage>;
  refreshManualPageResources(input: RefreshManualPageResourcesInput): Promise<ManualPageResource[]>;
  getPageEditContext(input: GetPageEditContextInput): Promise<GetPageEditContextResult>;
  pinManagedFont(input: { workspace_dir: string; family: string }): Promise<ManagedFontRuntimeFamily>;
  commitManagedFontUpload(input: CommitManagedFontUploadInput): Promise<CommitManagedFontUploadResult>;
  saveManualPageRevision(input: SaveManualPageRevisionInput): Promise<SaveManualPageRevisionResult>;
  preparePageRecovery(input: GetPageEditContextInput): Promise<PageRecoveryOption>;
  restorePageSourceVersion(input: RestorePageSourceVersionInput): Promise<RestorePageSourceVersionResult>;
  recordOutline(input: RecordOutlineInput): Promise<ProjectResult>;
  getRenderedDeckHtml(input: RenderDeckHtmlInput): Promise<RenderDeckHtmlResult>;
  prepareWorkspacePagePreview(input: { workspace_dir: string; page_id: string; priority?: "foreground" | "background";
    kind?: "html" | "thumbnail"; retry?: boolean }): Promise<PagePreviewPreparation>;
  getWorkspacePagePreviewPreparation(input: { workspace_dir: string; task_id: string }): Promise<PagePreviewPreparation>;
  getWorkspacePageHtml(input: GetWorkspacePageHtmlInput): Promise<WorkspacePageHtml>;
  getWorkspacePageThumbnail(input: GetWorkspacePageThumbnailInput): Promise<PageThumbnail>;
  renderDeckHtml(input: RenderDeckHtmlInput): Promise<RenderDeckHtmlSubmissionResult>;
  recordDeckReview(input: RecordDeckReviewInput): Promise<ProjectResult>;
  startPptxExport(input: StartPptxExportInput): Promise<PptxExportJob>;
  getPptxExportStatus(input: { workspace_dir: string }): Promise<PptxExportJob>;
  runPptxExport(input: {
    workspace_dir: string;
    pageNumbers?: number[];
    signal?: AbortSignal;
    onProgress?: (progress: { percent?: number; message?: string; phase?: "rendering" | "merging"; currentPage?: number; totalPages?: number }) => void;
  }): Promise<PptxExportJob>;
  exportPdf(input: ExportPdfInput): Promise<ExportPdfResult>;
  runPdfExport(input: {
    workspace_dir: string;
    pageNumbers?: number[];
    signal?: AbortSignal;
    onProgress?: (progress: { percent?: number; message?: string; phase?: string }) => void;
  }): Promise<ExportPdfResult>;
  recordPdfExport(input: RecordPdfExportInput): Promise<WorkspaceResult>;
  startExportArtifactPublish(
    input: GetExportArtifactDownloadUrlInput
  ): Promise<ExportArtifactPublishJob>;
  getExportArtifactPublishStatus(
    input: GetExportArtifactDownloadUrlInput
  ): Promise<ExportArtifactPublishJob>;
  runExportArtifactPublish(input: GetExportArtifactDownloadUrlInput & {
    signal?: AbortSignal;
    onProgress?: (progress: { percent?: number; message?: string; phase?: string }) => void;
  }): Promise<ExportArtifactPublishJob>;
  listExportJobs(input: {
    workspace_dir: string;
    artifact_type?: "pptx" | "pdf";
  }): Promise<Array<AnnaToolJobSnapshot>>;
  awaitExportJob<T = unknown>(input: {
    job_id: string;
    signal?: AbortSignal;
    onProgress?: (progress: { percent?: number; message?: string; phase?: string }) => void;
  }): Promise<T>;
  cancelExportJob(input: { job_id: string; reason?: string }): Promise<{
    jobId: string;
    state: string;
    cancelled: boolean;
  }>;
  getExportArtifactDownloadUrl(
    input: GetExportArtifactDownloadUrlInput
  ): Promise<ExportArtifactDownloadUrlResult>;
  prepareWorkspaceDiagnosticBundle(
    input: PrepareWorkspaceDiagnosticBundleInput
  ): Promise<PrepareWorkspaceDiagnosticBundleResult>;
}

export async function createPptBackend(): Promise<PptBackend> {
  const mode = detectRuntimeMode();

  if (mode === "anna") {
    return createAnnaPptBackend(await connectAnnaRuntime());
  }

  throw new Error("PptBackend is only available inside Anna runtime.");
}
