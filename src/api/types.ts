import type {
  OutlineContentItem,
  OutlineAnalysis,
  OutlineResearchPlan,
  OutlineTextSegment,
} from "./outlineTypes";

export interface ToolIds {
  pptEngine: string;
}

export interface HostUploadRef {
  transport: "host_upload";
  r2_key: string;
  url: string;
  mime_type: string;
  size_bytes: number;
  filename?: string;
  expires_at?: string;
  expires_in?: number;
  mode?: "negotiate+confirm";
}

export type GenerationRunKind = "deck-generation" | "page-refinement" | "deck-refinement";
export type GenerationRunState = "preparing" | "active" | "committing" | "committed" | "abandoned";
export interface GenerationRunTransaction {
  schema_version: 1;
  run_id: string;
  workspace_id: string;
  run_kind: GenerationRunKind;
  state: GenerationRunState;
  official_workspace_dir: string;
  shadow_workspace_dir: string;
  previous_workspace_dir: string;
  origin_page_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PrepareGenerationRunResult {
  transaction: GenerationRunTransaction;
  workspace: WorkspaceResult | null;
}

export interface CommitGenerationRunResult {
  transaction: GenerationRunTransaction;
  workspace: WorkspaceResult;
}

export interface PublishWorkspaceSnapshotResult {
  workspace_id: string;
  workspace_dir: string;
  status: "generated" | "skipped";
  revision: string | null;
  source_updated_at: string | null;
  source_sha256: string;
  snapshot_path: string | null;
  snapshot_size_bytes: number | null;
  file_count: number;
  generated_at: string | null;
}

export interface WorkspaceSnapshotManifestSnapshot {
  workspace_id: string;
  revision: string;
  source_sha256: string;
  source_updated_at: string | null;
  files: { path: string; sha256: string; size: number }[];
  attachments: { content_hash: string }[];
  created_at: string;
}

export interface WorkspaceSnapshotZipEntry {
  name: string;
  method: number;
  compressed_size: number;
  uncompressed_size: number;
  sha256: string | null;
}

export interface GetWorkspaceSnapshotInfoResult {
  workspace_id: string;
  revision: string;
  snapshot_path: string;
  zip_sha256: string;
  zip_sha256_matches_state: boolean | null;
  manifest: WorkspaceSnapshotManifestSnapshot;
  entries: WorkspaceSnapshotZipEntry[];
  file_count: number;
  missing_files: string[];
  mismatched_files: string[];
  all_files_verified: boolean;
}

export type WorkspaceSnapshotPublishStatus =
  | "idle"
  | "queued"
  | "preparing"
  | "uploading"
  | "committing"
  | "completed"
  | "failed";

export interface WorkspaceSnapshotMirror {
  provider: "aps.files";
  scope: "user";
  path: string;
  etag: string;
  size_bytes: number;
  content_type: string;
  source_updated_at: string;
  source_sha256: string;
  published_at: string;
  meta_path: string;
  meta_etag: string;
}

export interface WorkspaceSnapshotPublishState {
  status: WorkspaceSnapshotPublishStatus;
  job_id: string;
  workspace_dir: string;
  revision: string | null;
  aps_path: string | null;
  aps_meta_path: string | null;
  meta_json: string | null;
  snapshot_path: string | null;
  source_updated_at: string | null;
  source_sha256: string | null;
  snapshot_sha256: string | null;
  snapshot_size_bytes: number | null;
  file_count: number;
  attachments: { content_hash: string }[];
  /** Durable local change sequence represented by this immutable ZIP. */
  change_seq: number;
  last_synced_updated_at: string | null;
  last_synced_sha256: string | null;
  mirror: WorkspaceSnapshotMirror | null;
  started_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  error: { message: string; stack?: string; interrupted?: boolean } | null;
}

export type WorkspaceSnapshotRestoreStatus =
  | "idle"
  | "queued"
  | "downloading"
  | "extracting"
  | "committing"
  | "completed"
  | "failed";

export interface WorkspaceSnapshotRestoreMirror {
  provider: "aps.files";
  scope: "user";
  path: string;
  etag: string;
  size_bytes: number;
  content_type: string;
  source_updated_at: string;
  source_sha256: string;
  downloaded_at: string;
}

export interface WorkspaceSnapshotRestoreState {
  status: WorkspaceSnapshotRestoreStatus;
  job_id: string;
  workspace_dir: string;
  revision: string | null;
  aps_path: string | null;
  snapshot_path: string | null;
  source_updated_at: string | null;
  source_sha256: string | null;
  snapshot_sha256: string | null;
  snapshot_size_bytes: number | null;
  file_count: number;
  attachments: { content_hash: string }[];
  force: boolean;
  mirror: WorkspaceSnapshotRestoreMirror | null;
  last_synced_updated_at: string | null;
  last_synced_sha256: string | null;
  started_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  error: { message: string; code?: string; stack?: string; interrupted?: boolean } | null;
}

export interface RestoreWorkspaceSnapshotInput {
  workspace_dir: string;
  revision?: string;
  force?: boolean;
}

export type WorkspaceSnapshotSyncStatus =
  | "idle"
  | "queued"
  | "preparing"
  | "completed"
  | "failed";

export interface WorkspaceSnapshotSemanticValidationFailure {
  /** Local mutation sequence represented by the rejected snapshot candidate. */
  change_seq: number;
  source_sha256: string;
  source_updated_at: string | null;
  revision: string;
  failed_at: string;
  errors: { code: string; message: string; paths: string[] }[];
}

export interface WorkspaceSnapshotSyncedBaseline {
  revision: string | null;
  source_updated_at: string | null;
  source_sha256: string;
  updated_at: string;
}

export type WorkspaceSnapshotRetryPhase = "generation" | "semantic_validation" | "upload";

/** Persisted bounded retry budget for one local change sequence. */
export interface WorkspaceSnapshotRetryState {
  change_seq: number;
  attempts: number;
  phase: WorkspaceSnapshotRetryPhase | null;
  next_retry_at: string | null;
  exhausted: boolean;
  last_error: string | null;
  updated_at: string;
}

/** Mirror of the engine's WorkspaceSnapshotSyncState (snapshot-sync.ts). */
export interface WorkspaceSnapshotSyncState {
  schema_version: number;
  workspace_id: string;
  status: WorkspaceSnapshotSyncStatus;
  revision: string | null;
  source_updated_at: string | null;
  source_sha256: string | null;
  snapshot_sha256: string | null;
  snapshot_path: string | null;
  snapshot_size_bytes: number | null;
  file_count: number;
  attachments: { content_hash: string }[];
  generated_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  error: { message: string } | null;
  synced_baseline: WorkspaceSnapshotSyncedBaseline | null;
  change_seq: number;
  pending_change_seq: number | null;
  generated_change_seq: number;
  retry: WorkspaceSnapshotRetryState | null;
  semantic_validation_failed: WorkspaceSnapshotSemanticValidationFailure | null;
  publish: WorkspaceSnapshotPublishState | null;
  restore: WorkspaceSnapshotRestoreState | null;
}

export type GetWorkspaceSnapshotSyncStateResult = WorkspaceSnapshotSyncState | null;

/** Entry from app_list_my_work: a Workspace with a published snapshot in APS. */
export interface ListMyWorkEntry {
  workspace_id: string;
  revision: string | null;
  aps_path: string | null;
  source_sha256: string | null;
  source_updated_at: string | null;
  size_bytes: number | null;
  file_count: number | null;
  snapshot_updated_at: string | null;
  meta_updated_at: string | null;
  status: string;
}

export interface ListMyWorkResult {
  workspaces: ListMyWorkEntry[];
}

export interface WorkspaceLocalSnapshotFingerprint {
  workspace_id: string;
  has_files: boolean;
  source_sha256: string | null;
  source_updated_at: string | null;
  revision: string | null;
  file_count: number;
  last_synced_sha256: string | null;
  unsynced: boolean;
}

export type ReconcileWorkspaceWithCloudStatus =
  | "no_cloud_snapshot"
  | "in_sync"
  | "restored"
  | "restore_failed"
  | "conflict_resolved"
  | "conflict_restore_failed"
  | "conflict_blocked"
  | "local_semantic_validation_failed"
  | "local_ahead"
  | "baseline_missing"
  | "tombstoned_local_delete";

export interface ReconcileWorkspaceWithCloudResult {
  status: ReconcileWorkspaceWithCloudStatus;
  workspace_id: string;
  workspace_dir: string;
  local: WorkspaceLocalSnapshotFingerprint | null;
  target: {
    revision: string | null;
    aps_path: string | null;
    source_sha256: string | null;
    source_updated_at: string | null;
  } | null;
  error?: { message: string };
  restore?: WorkspaceSnapshotRestoreState;
  backup_workspace_id?: string;
  backup_workspace_dir?: string;
  backup_title?: string;
  backup_upload_status?: "uploaded" | "failed";
}

export interface ReconcileWorkspaceWithCloudInput {
  workspace_dir: string;
}

export interface WorkspaceSummary {
  workspace_id: string;
  task_id?: string;
  workspace_dir: string;
  task_dir?: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  has_deck_html: boolean;
  generation_completed?: boolean;
}

export interface WorkspaceFiles {
  task: string;
  setting: string;
  requirements: string;
  outline: string;
  manifest: string;
  style_guide: string;
  visual_rhythm: string;
  page_visual_plans: string;
  persistent_elements: string;
  authoring_kit: string;
  page_progress: string;
  pages?: string;
  template?: string;
  visual_master: string;
  aesthetic_reference_selections: string;
  template_reference: string;
}

export interface WorkspaceResult {
  workspace_root: string;
  task_root?: string;
  workspace_dir: string;
  task_dir?: string;
  workspace_id: string;
  task_id?: string;
  initialized?: boolean;
  created_files?: string[];
  missing_files?: string[];
  files?: WorkspaceFiles;
  task: unknown;
  setting: unknown;
  requirements: PresentationRequirements;
  outline: unknown;
  visual_rhythm?: string | null;
  page_visual_plans?: Record<string, string>;
  page_progress?: unknown;
  pages?: unknown;
  template?: unknown;
}

export interface PresentationRequirementsCandidates {
  slide_count: number[];
  output_language: string[];
}

export type PresentationRequirementsGeneratedCandidates = Omit<
  PresentationRequirementsCandidates,
  "output_language"
>;

export interface PresentationRequirementsSelections {
  aspect_ratio?: import("../slideFormat").SlideAspectRatio;
  slide_count: number | null;
  output_language: string | null;
  visual_style_preset?: VisualStylePresetSelection | null;
}

export interface PresentationResearchChoice {
  recommended: boolean | null;
  reason: string;
  enabled: boolean | null;
}

export interface PresentationResearchRequirements {
  web: PresentationResearchChoice;
  images: PresentationResearchChoice;
}

export interface VisualStylePresetPreview {
  url: string;
  alt: string;
}

export interface VisualStylePresetReferencePage {
  path: string;
  description: string;
}

export interface VisualStylePresetReferenceHtmlPage extends VisualStylePresetReferencePage {
  html: string;
}

export type VisualStylePresetTheme = "dark" | "light";

export type VisualStylePresetColor = string;

/** Controls stable catalogue mixing within templates that have the same score. */
export type VisualStylePresetCatalogCohort = "established" | "new";

/** The way a preset maps a palette choice onto its reference HTML. */
export type VisualStylePresetThemeMode = "legacy-distance-v1" | "semantic-v1";

/**
 * Curated, machine-comparable recommendation metadata. This is catalogue
 * data only: it neither changes a preset's visual source nor the immutable
 * Workspace snapshot created at requirements confirmation.
 */
export interface VisualStylePresetRecommendationProfile {
  use_cases?: string[];
  industries?: string[];
  audiences?: string[];
  formats?: string[];
  /** Primary visual language used for positive recommendation scoring. */
  primary_styles?: string[];
  /** Visually salient elements used only to enforce explicit exclusions. */
  visual_traits?: string[];
  /** @deprecated Use primary_styles. Retained for older and user-owned presets. */
  styles?: string[];
}

/**
 * An optional palette choice for a single Visual Style Preset.  The source
 * template remains one HTML file; the selected palette is resolved into that
 * HTML only when it is previewed or snapshotted for generation.
 */
export interface VisualStylePresetColorVariant {
  id: string;
  name: string;
  /** Small chips shown in the template picker. */
  swatches: string[];
  /** Palette values, keyed by either legacy anchors or the semantic-v1 role schema. */
  roles: Record<string, string>;
}

export interface VisualStylePreset {
  source?: "user";
  id: string;
  version: number;
  ppt_number: number;
  score?: number;
  /** New presets are interleaved with established presets within the same score group. */
  catalog_cohort?: VisualStylePresetCatalogCohort;
  theme: VisualStylePresetTheme;
  color: VisualStylePresetColor[];
  name: string;
  description: string;
  user: string;
  use_case: string;
  industry: string;
  recommendation_profile?: VisualStylePresetRecommendationProfile;
  /** Omitted presets retain the original nearest-colour migration behaviour. */
  theme_mode?: VisualStylePresetThemeMode;
  /** Legacy source-colour anchors for distance-based variants. */
  color_role_anchors?: Record<string, string>;
  color_variants?: VisualStylePresetColorVariant[];
  /** Present on a runtime-resolved palette selection; never required in preset.json. */
  base_preset_id?: string;
  selected_color_variant?: VisualStylePresetColorVariant;
  preview_images: VisualStylePresetPreview[];
  reference_html_pages: VisualStylePresetReferencePage[];
}

export type VisualStylePresetSelection = Pick<VisualStylePreset, "id" | "version" | "name" | "description">;

/** Why the normal automatic template decision was deferred to the user. */
export type PresentationRequirementsTemplateRecommendationTrigger = "low_signal" | "rules_fallback";

/** A deterministic matching dimension that can be shown as a candidate reason. */
export type PresentationRequirementsTemplateRecommendationMatchAxis =
  | "use_case"
  | "industry"
  | "audience"
  | "format"
  | "style";

export interface PresentationRequirementsTemplateRecommendationCandidate {
  preset: VisualStylePresetSelection;
  /** Local weighted score, retained for traceability rather than presented as a probability. */
  score: number;
  matched_axes: PresentationRequirementsTemplateRecommendationMatchAxis[];
}

/** A persisted, low-confidence recommendation choice shown during Requirements Review. */
export interface PresentationRequirementsTemplateRecommendation {
  selection_required: true;
  confidence: "low";
  trigger: PresentationRequirementsTemplateRecommendationTrigger;
  candidates: PresentationRequirementsTemplateRecommendationCandidate[];
}

export interface PresentationRequirements {
  version: 1;
  status: "empty" | "draft" | "confirmed";
  source: { brief: string } | null;
  candidates: PresentationRequirementsCandidates;
  selections: PresentationRequirementsSelections;
  template_recommendation?: PresentationRequirementsTemplateRecommendation | null;
  research: PresentationResearchRequirements;
  updated_at: string | null;
  confirmed_at: string | null;
}

export type UploadedSourceStatus = "active" | "removed";

export interface UploadedSourceMaterial {
  uploaded_source_id: string;
  status: UploadedSourceStatus;
  original_filename: string;
  display_name: string;
  mime_type: string;
  extension: string;
  size_bytes: number;
  sha256: string;
  file_path: string;
  duplicate_of: string[];
  created_at: string;
  updated_at: string;
  removed_at?: string | null;
}

export interface UploadedSourceIndex {
  version: 1;
  workspace_dir: string;
  active_total_size_bytes: number;
  materials: UploadedSourceMaterial[];
  updated_at: string;
}

export interface UploadUploadedSourceResult {
  workspace_dir: string;
  material: UploadedSourceMaterial;
  index: UploadedSourceIndex;
  warnings: string[];
}

export interface CommitUploadedSourceHostUploadInput {
  workspace_dir: string;
  filename: string;
  mime_type?: string;
  size_bytes: number;
  host_upload: HostUploadRef;
}

export interface CommitUploadedSourceHostUploadResult extends UploadUploadedSourceResult {
  upload_id: string;
  host_upload: HostUploadRef;
}

export type UploadedSourceParseStatus = "ready" | "partial" | "failed";
export type UploadedSourceContentStrategy = "full_context" | "summarized_context" | "image_processing" | null;
export type UploadedSourceOriginalReadingMethod = "document_read" | "document_retrieval" | "spreadsheet_read" | "table_query" | "image_multimodal_read" | null;

export interface UploadedSourcePreflightWarning {
  code: string;
  message: string;
  locations?: string[];
}

export interface UploadedSourcePdfOcrProgress {
  status: "processing" | "completed";
  total_pages: number;
  candidate_pages: number;
  processed_pages: number;
  completed_pages: number;
  failed_pages: number;
  current_page: number | null;
  diagnostic_stage?: string;
  diagnostic_updated_at?: string;
}

export interface UploadedSourcePreflightResult {
  source_id: string;
  filename: string;
  file_type: string;
  size_bytes: number;
  parse_status: UploadedSourceParseStatus;
  character_count?: number;
  token_estimate?: number;
  format_metrics: Record<string, number>;
  content_strategy: UploadedSourceContentStrategy;
  original_reading_method: UploadedSourceOriginalReadingMethod;
  warnings: UploadedSourcePreflightWarning[];
  pdf_ocr_progress?: UploadedSourcePdfOcrProgress;
}

export interface GetUploadedSourcePreflightStatusResult {
  workspace_dir: string;
  results: UploadedSourcePreflightResult[];
}

export interface ContinueUploadedSourcePdfOcrResult {
  workspace_dir: string;
  results: UploadedSourcePreflightResult[];
}

export interface GetUploadedSourcePreflightTextResult {
  workspace_dir: string;
  uploaded_source_id: string;
  filename: string;
  content: string;
  offset: number;
  next_offset: number | null;
  total_characters: number;
  complete: boolean;
  truncated: boolean;
}

export interface UploadedSourcePreflightTextChunk {
  chunk_id: string;
  heading_path: string[];
  source_range: string;
  start_offset: number;
  end_offset: number;
  token_estimate: number;
}

export interface GetUploadedSourcePreflightChunksResult {
  workspace_dir: string;
  uploaded_source_id: string;
  filename: string;
  total_characters: number;
  planning_ms: number;
  chunk_count: number;
  chunks: UploadedSourcePreflightTextChunk[];
}

export interface AttachmentBriefEvidence {
  evidence_id: string;
  fact: string;
  source_label: string;
  excerpt: string;
}

export interface AttachmentBriefSheetCoverage {
  sheet_name: string;
  status: "covered" | "not_relevant" | "unreadable";
  reason?: string;
  evidence_ids: string[];
}

export interface AttachmentBrief {
  version: 1;
  source_id: string;
  filename: string;
  content_strategy: "full_context" | "summarized_context";
  original_reading_method: "document_read" | "document_retrieval" | "spreadsheet_read" | "table_query" | "image_multimodal_read";
  relationship_to_task?: string;
  /** Present only for image attachments after multimodal classification. */
  use_in_ppt?: boolean;
  /** Short, evidence-grounded rationale for the image classification. */
  image_usage_reason?: string;
  main_message?: string;
  content?: string;
  key_facts: AttachmentBriefEvidence[];
  must_include: Array<{ requirement: string; evidence_ids: string[] }>;
  must_avoid: string[];
  recommended_storyline: string[];
  gaps: string[];
  unread_content: string[];
  /** Present for summarized spreadsheet sources; proves every readable Sheet was considered. */
  sheet_coverage?: AttachmentBriefSheetCoverage[];
  updated_at: string;
}

export interface AttachmentContext {
  version: 1;
  user_brief: string;
  attachment_context: AttachmentBrief[];
  updated_at: string;
}

export interface AttachmentBriefPaths {
  workspace_dir: string;
  source_id: string;
  analysis_dir: string;
  draft_path: string;
  json_path: string;
}

export interface ListAttachmentBriefsResult {
  workspace_dir: string;
  briefs: AttachmentBrief[];
}

export interface RunUploadedSourcePreflightResult {
  workspace_dir: string;
  started_at: string;
  completed_at: string;
  results: UploadedSourcePreflightResult[];
}

export interface StyleProfileIndexEntry {
  version: 1;
  style_profile_id: string;
  display_name: string;
  profile_dir: string;
  profile_path: string;
  metadata_path: string;
  profile_sha256: string;
  size_bytes: number;
  reference_count: number;
  source_file_count: number;
  created_at: string;
  updated_at: string;
}

export interface StyleProfileIndex {
  version: 1;
  library_dir: string;
  profiles: StyleProfileIndexEntry[];
  updated_at: string;
}

export interface ListStyleProfilesResult {
  library_dir: string;
  index: StyleProfileIndex;
  profiles: StyleProfileIndexEntry[];
}

export interface StyleProfileReferenceImagePreview {
  reference_image_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  order: number;
  image_upload: HostUploadRef;
}

export interface GetStyleProfilePreviewResult {
  style_profile: StyleProfileIndexEntry;
  cover_image: StyleProfileReferenceImagePreview | null;
}

export interface GetStyleProfileResult {
  style_profile: StyleProfileIndexEntry;
  content: string;
  size_bytes: number;
  sha256: string;
  reference_images: StyleProfileReferenceImagePreview[];
}

export interface PrepareStyleProfileCreationInput {
  display_name?: string;
}

export interface StyleProfileCreationPaths {
  library_dir: string;
  creation_dir: string;
  uploads_dir: string;
  references_dir: string;
  rasterized_dir: string;
  draft_dir: string;
  draft_profile_path: string;
  manifest_path: string;
}

export interface PrepareStyleProfileCreationResult extends StyleProfileCreationPaths {
  creation_id: string;
  display_name: string;
  prepared_at: string;
}

export interface StyleProfileReferenceMaterial {
  reference_id: string;
  original_filename: string;
  display_name: string;
  mime_type: string;
  extension: string;
  size_bytes: number;
  sha256: string;
  file_path: string;
  kind: "pptx" | "image";
  created_at: string;
}

export interface ReferenceSlideImage {
  reference_image_id: string;
  source_reference_id: string;
  source_file_path: string;
  page_number: number | null;
  file_path: string;
  width: number | null;
  height: number | null;
  selected_for_analysis: boolean;
  order: number;
}

export interface StyleProfileCreationManifest {
  version: 1;
  creation_id: string;
  display_name: string;
  status: "prepared" | "uploaded" | "published";
  reference_materials: StyleProfileReferenceMaterial[];
  reference_images: ReferenceSlideImage[];
  selected_reference_image_ids: string[];
  created_at: string;
  updated_at: string;
  published_style_profile_id?: string;
}

export interface CommitStyleProfileReferenceUploadResult {
  creation_id: string;
  upload_id: string;
  material: StyleProfileReferenceMaterial;
  manifest: StyleProfileCreationManifest;
  warnings: string[];
}

export interface CommitStyleProfileReferenceHostUploadInput {
  creation_id: string;
  filename: string;
  mime_type?: string;
  size_bytes: number;
  host_upload: HostUploadRef;
}

export interface CommitStyleProfileReferenceHostUploadResult extends CommitStyleProfileReferenceUploadResult {
  host_upload: HostUploadRef;
}

export interface GetStyleProfileCreationContextResult extends StyleProfileCreationPaths {
  creation_id: string;
  manifest: StyleProfileCreationManifest;
  selected_reference_images: ReferenceSlideImage[];
}

export interface StyleProfileDraftFingerprint {
  creation_id: string;
  draft_path: string;
  exists: boolean;
  sha256?: string;
  size_bytes?: number;
}

export interface GetStyleProfileDraftResult {
  creation_id: string;
  draft_path: string;
  exists: boolean;
  content: string;
  size_bytes: number;
  sha256: string;
}

export interface PublishStyleProfileInput {
  creation_id: string;
  display_name?: string;
}

export interface PublishStyleProfileResult {
  style_profile: StyleProfileIndexEntry;
  index: StyleProfileIndex;
  profile_path: string;
  reference_count: number;
}

export interface WorkspaceStyleProfileSelection {
  version: 1;
  style_profile_id: string;
  display_name: string;
  source_profile_path: string;
  workspace_profile_path: string;
  selection_path: string;
  profile_sha256: string;
  size_bytes: number;
  selected_at: string;
}

export interface SelectWorkspaceStyleProfileResult {
  workspace: WorkspaceResult;
  selection: WorkspaceStyleProfileSelection;
  content: string;
}

export interface GetWorkspaceStyleProfileResult {
  workspace_dir: string;
  selected: boolean;
  profile_path: string;
  selection_path: string;
  selection: WorkspaceStyleProfileSelection | null;
  content: string;
  size_bytes: number;
  sha256: string;
}

export interface ClearWorkspaceStyleProfileResult {
  workspace: WorkspaceResult;
  cleared: boolean;
}

export interface ListUploadedSourcesResult {
  workspace_dir: string;
  index: UploadedSourceIndex;
  active: UploadedSourceMaterial[];
  removed: UploadedSourceMaterial[];
  limits: {
    single_file_max_bytes: number;
    active_total_max_bytes: number;
  };
}

export interface RemoveUploadedSourceInput {
  workspace_dir: string;
  uploaded_source_id: string;
}

export interface RemoveUploadedSourceResult {
  workspace_dir: string;
  material: UploadedSourceMaterial;
  index: UploadedSourceIndex;
}

export interface UploadedSourceAnalysisPaths {
  root_dir: string;
  drafts_dir: string;
  factual_draft_path: string;
  visual_draft_path: string;
  analysis_path: string;
}

export interface PrepareUploadedSourceAnalysisWorkspaceResult extends UploadedSourceAnalysisPaths {
  workspace_dir: string;
  uploaded_source_index: UploadedSourceIndex;
  prepared_at: string;
}

export type UploadedSourceAnalysisDraftType = "factual" | "visual";

export interface UploadedSourceAnalysisDraftFingerprint {
  workspace_dir: string;
  draft_type: UploadedSourceAnalysisDraftType;
  draft_id?: string;
  draft_path: string;
  exists: boolean;
  sha256?: string;
  size_bytes?: number;
}

export interface WorkspaceSettings {
  /** Legacy isolated setting; not persisted by authoring-kit-v1 Workspaces. */
  output_language?: string;
  /** Legacy isolated setting; not persisted by authoring-kit-v1 Workspaces. */
  text_density?: string;
  page_generation_concurrency?: number;
  research_image_session_concurrency?: number;
  /** Maximum Web research Agent rounds (search, fetch or finish actions). */
  research_web_max_rounds?: number;
  /** Maximum image research Agent search actions. */
  research_image_max_searches?: number;
  updated_at?: string;
  [key: string]: unknown;
}

export type CreatedWorkspaceSetting = Required<
  Pick<
    WorkspaceSettings,
    | "page_generation_concurrency"
    | "research_image_session_concurrency"
    | "research_web_max_rounds"
    | "research_image_max_searches"
  >
>;

export interface CreateWorkspaceResult {
  version: 1;
  workspace_root: string;
  workspace_id: string;
  workspace_dir: string;
  title: string;
  setting: CreatedWorkspaceSetting;
}

export type OutlinePageType = "cover" | "standard";

export interface WorkspaceOutlineItem {
  /** 当前页选中的素材标识；空数组表示不配图。 */
  selected_image_ids?: string[];
  page_id?: string;
  page_type: OutlinePageType;
  title: string;
  /** 这一页的完整内容；默认散文，用户指定的形式和原文优先。 */
  content: string;
  title_segments?: OutlineTextSegment[];
  research?: OutlineResearchPlan;
  analysis?: OutlineAnalysis;
  /** 用户明确提出的本页创作要求；无要求时省略。 */
  creation_requirements?: string;
}

export interface WorkspaceOutline {
  /** 用户明确提出的全局创作要求；旧大纲缺省按空字符串读取。 */
  global_creation_requirements?: string;
  version: 4;
  title: string;
  status: "empty" | "draft" | "confirmed";
  items: WorkspaceOutlineItem[];
  updated_at: string | null;
  confirmed_at: string | null;
  /** Temporary in-memory compatibility for downstream stages that have not been refactored yet. */
  output_language?: string;
  /** Temporary in-memory compatibility for downstream stages that have not been refactored yet. */
  source?: {
    prompt: string;
    context: unknown[];
    task_context?: unknown[];
    setting: Record<string, unknown>;
    kind?: string;
    uploaded_source_analysis?: UploadedSourceAnalysisDependency;
  };
}

export interface UploadedSourceAnalysisDependency {
  status: "ready" | "blocked" | "gap";
  updated_at: string;
  active_uploaded_sources: Array<{
    uploaded_source_id: string;
    sha256: string;
    size_bytes: number;
    file_path?: string;
  }>;
}

export interface WorkspacePageItem {
  page_id: string;
  index: number;
  title: string;
  layout_id: string;
  html_path: string;
  screenshot_path?: string;
  speaker_note: string;
}

export interface WorkspacePages {
  version: 1;
  status?: "rendered" | string;
  title?: string;
  manifest_path?: string;
  output_dir?: string;
  rendered_at?: string;
  pages: WorkspacePageItem[];
  source?: {
    kind?: string;
  };
  updated_at?: string | null;
}

export interface ListWorkspacesResult {
  workspace_root: string;
  task_root?: string;
  has_workspaces: boolean;
  has_tasks?: boolean;
  latest_workspace: WorkspaceSummary | null;
  latest_task?: WorkspaceSummary | null;
  workspaces: WorkspaceSummary[];
  tasks?: WorkspaceSummary[];
  /** Opaque pagination cursor used only between backend transport calls. */
  next_cursor?: string | null;
}

export interface AutoRestoreMissingWorkspacesResult {
  workspace_root: string | null;
  restored: Array<{ workspace_id: string; revision: string | null; status: string }>;
  skipped: Array<{ workspace_id: string; reason: string }>;
  /** Cloud-only workspaces deliberately left for on-demand restore. */
  deferred?: Array<{ workspace_id: string; reason: "outside_first_screen" }>;
  failed: Array<{ workspace_id: string; error: string }>;
  first_screen_limit?: number;
  error?: string | null;
}

export interface CreateWorkspaceInput {
  title?: string;
}

export interface OpenWorkspaceInput {
  workspace_dir: string;
}

export interface UpdateWorkspaceSettingsInput {
  workspace_dir: string;
  setting: WorkspaceSettings;
  persist_as_default?: boolean;
}

export interface UpdateWorkspaceSettingsResult {
  workspace_dir: string;
  setting: WorkspaceSettings;
  persisted_as_default: boolean;
}

export interface WorkspaceDefaultsResult {
  workspace_root: string;
  setting: WorkspaceSettings;
}

export interface PptEngineRuntimeInfo {
  ppt_engine_version: string;
  performance_testing?: {
    supported: boolean;
    schema_version: number;
  };
  uploaded_source_preflight?: {
    pdf_ocr_continuation?: boolean;
    pdf_ocr_execution?: "isolated-process-v1";
    pdf_ocr_diagnostics?: "stage-v1";
  };
}

export type AgentResourceLimitSource = "cgroup" | "system" | "unknown";

export interface PptAgentResourceInfo {
  sampled_at: string;
  sample_duration_ms: number;
  environment: {
    platform: string;
    arch: string;
    node_version: string;
  };
  cpu: {
    system_usage_percent: number | null;
    configured_cores: number;
    visible_cores: number;
    limit_source: AgentResourceLimitSource;
    load_average: number[] | null;
  };
  memory: {
    used_bytes: number;
    available_bytes: number;
    total_bytes: number;
    usage_percent: number | null;
    limit_source: AgentResourceLimitSource;
  };
  process: {
    pid: number;
    cpu_usage_percent: number | null;
    rss_bytes: number;
    heap_used_bytes: number;
    heap_total_bytes: number;
    external_bytes: number;
    uptime_seconds: number;
  };
}

export type PerformanceRunStatus = "recording" | "finalizing" | "completed" | "finalization_failed" | "abandoned";
export type TokenUsageSource = "session" | "llm";

export interface TokenUsageBucket {
  available: boolean;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  estimated_cost: number | null;
}

export interface TokenUsageSummary {
  session: TokenUsageBucket;
  llm: TokenUsageBucket;
  total: TokenUsageBucket;
}

export interface PerformanceContext {
  run_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  operation_name?: string;
  workspace_id?: string;
}
export interface PerformanceEvent {
  schema_version: 1;
  event_id: string;
  event_type: "span.started" | "span.finished" | "button.interaction" | "token.usage" | "data.loss";
  recorded_at: string;
  producer_id: string;
  sequence_number: number;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  operation_name?: string;
  workspace_id?: string;
  duration_ms?: number;
  interaction_delay_ms?: number;
  feedback_delay_ms?: number;
  status?: "ok" | "error" | "interrupted";
  attributes?: Record<string, string | number | boolean | null>;
}
export interface PerformanceRunSummary {
  schema_version: 1;
  run_id: string;
  status: PerformanceRunStatus;
  data_integrity: "complete" | "degraded";
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  report_locale: "en" | "zh" | "ja" | "de" | null;
  report_status: "not_generated" | "generated" | "failed";
  report_error: string | null;
  app_version: string;
  environment: Record<string, string | number | boolean | null>;
  initial_settings: Record<string, unknown>;
  event_count: number;
  dropped_event_count: number;
  token_usage?: TokenUsageSummary;
  operation_metrics?: PerformanceOperationMetric[];
  run_dir: string;
  report_available: boolean;
}
export interface PerformanceOperationMetric {
  operation_name: string;
  count: number;
  wall_clock_ms: number;
  total_duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  calls: number;
}
export interface PerformanceRunListItem {
  run_id: string;
  status: PerformanceRunStatus;
  started_at: string;
  event_count: number;
  report_available: boolean;
}
export interface ListPerformanceRunsResult {
  root_dir: string;
  active_run: PerformanceRunListItem | null;
  runs: PerformanceRunListItem[];
}
export interface FinalizePerformanceRunResult {
  run: PerformanceRunSummary;
  requires_force: boolean;
  active_span_count: number;
}
export interface PreparePerformanceReportResult {
  run: PerformanceRunSummary;
  report_html: string;
}

export type BatchTestCaseStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type BatchTestRunStatus = "queued" | "running" | "completed" | "partial_failure" | "failed" | "cancelled";
export type BatchTestTargetStage =
  | "template-recommendation-completed"
  | "attachment-context-created"
  | "requirements-confirmed"
  | "research-routing-completed"
  | "page-refinement-classification-completed"
  | "web-research-completed"
  | "outline-confirmed"
  | "image-research-completed"
  | "pptx-exported";

export interface BatchResearchRoutingPromptInput {
  prompt_version: string;
  prompt: string;
  prompt_hash: string;
}

export interface BatchResearchRoutingCaseInput {
  baseline_id: string;
  prompt_version: string;
  prompt: string;
  prompt_hash: string;
  git_commit: string;
  requested_model?: string | null;
  expected: {
    web: boolean;
    images: boolean;
  };
}

export interface BatchResearchRoutingResult {
  actual: {
    web: boolean;
    images: boolean;
  };
  requested_model: string | null;
  actual_model: string | null;
  latency_ms: number;
  token_usage: unknown;
  json_repair_count: number;
  retry_count: number;
  retry_reasons: Array<"invocation" | "json_format" | "schema">;
}

export interface BatchPageRefinementClassificationPromptInput {
  prompt_version: string;
  prompt: string;
  prompt_hash: string;
}

export interface BatchPageRefinementClassificationCaseInput {
  prompt_version: string;
  prompt: string;
  prompt_hash: string;
  git_commit: string;
  requested_model?: string | null;
  expected?: {
    task_type: "exact_text_edit" | "content_rewrite" | "style_edit" | "layout_edit" | "web_research" | "image_research" | "mixed" | "unclear";
    execution_scope: "local" | "regenerate" | "uncertain";
    web_research: boolean;
    image_research: boolean;
  };
}

export interface BatchPageRefinementClassificationResult {
  actual: NonNullable<BatchPageRefinementClassificationCaseInput["expected"]> & { reason: string };
  requested_model: string | null;
  actual_model: string | null;
  latency_ms: number;
  token_usage: unknown;
  json_repair_count: number;
  retry_count: number;
  retry_reasons: Array<"invocation" | "json_format" | "schema">;
}

export interface BatchTestCaseInput {
  case_id: string;
  brief_id: string;
  brief: string;
  repetition: number;
  total_repetitions: number;
  attachments?: BatchTestAttachmentInput[];
  /** Used only by outline-only batch evaluations to bypass Requirements generation. */
  provided_requirements?: PresentationRequirements;
  research_routing?: BatchResearchRoutingCaseInput;
  page_refinement_classification?: BatchPageRefinementClassificationCaseInput;
}

export interface BatchTemplateRecommendationResult {
  preset: VisualStylePresetSelection;
  trace: import("../features/templates/visualStylePresetRecommendation").VisualStylePresetRecommendationTrace;
}

export interface BatchTestAttachmentInput {
  filename: string;
  mime_type: string;
  size_bytes: number;
  host_upload: HostUploadRef;
  expected_strategy?: "full_context" | "summarized_context";
  expected_notes?: string;
}

export interface BatchTestCaseRecord extends BatchTestCaseInput {
  status: BatchTestCaseStatus;
  case_dir: string;
  workspace_dir: string;
  workspace_id: string;
  performance_dir: string;
  started_at: string | null;
  ended_at: string | null;
  error: string | null;
  pptx_path: string | null;
  token_usage?: TokenUsageSummary | null;
  performance_metrics?: PerformanceOperationMetric[] | null;
  research_routing_result?: BatchResearchRoutingResult | null;
  page_refinement_classification_result?: BatchPageRefinementClassificationResult | null;
  template_recommendation_result?: BatchTemplateRecommendationResult | null;
  /** Compact transport-only identity used to safely resume research-routing runs. */
  research_routing_signature?: string;
}

export interface BatchTestRunRecord {
  version: 1;
  test_id: string;
  target_stage: BatchTestTargetStage;
  status: BatchTestRunStatus;
  root_dir: string;
  manifest_path: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string;
  cases: BatchTestCaseRecord[];
  performance_metrics?: PerformanceOperationMetric[] | null;
  /** Compact transport-only identity used to safely resume research-routing runs. */
  research_routing_run_signature?: string;
  /** Compact transport-only fingerprint of the imported research-routing cases. */
  research_routing_cases_fingerprint?: string;
}

export interface CreateBatchTestRunResult {
  run: BatchTestRunRecord;
}

export interface ListBatchTestRunsResult {
  root_dir: string;
  runs: BatchTestRunRecord[];
}

export interface DeleteBatchTestRunResult {
  deleted: true;
  test_id: string;
  root_dir: string;
}

export interface PrepareBatchTestBundleResult {
  status: "ready";
  test_id: string;
  filename: string;
  size_bytes: number;
  download_url: string;
  expires_at: string | null;
  mirror?: {
    provider?: string;
    scope?: string;
    path?: string;
    content_type?: string;
    content_disposition?: string;
    size_bytes?: number;
  };
}

export interface PatchWorkspaceDefaultsInput {
  setting: WorkspaceSettings;
}

export interface UpdateWorkspaceTitleInput {
  workspace_dir: string;
  title: string;
}

export interface DeleteWorkspaceResult {
  deleted: true;
  workspace_id: string;
  workspace_dir: string;
  tombstone: {
    deleted_at: string;
    lifecycle_epoch: number;
  };
}

export interface DuplicateWorkspaceInput {
  workspace_dir: string;
  title?: string;
}

export interface DuplicateWorkspaceResult {
  version: 1;
  workspace_root: string;
  source_workspace_id: string;
  source_workspace_dir: string;
  workspace_id: string;
  workspace_dir: string;
  title: string;
  snapshot?: WorkspaceSnapshotPublishState | null;
  snapshot_error?: string | null;
}


export interface GetWorkspaceOutlineInput {
  workspace_dir: string;
}

export interface ResetWorkspaceOutlineInput {
  workspace_dir: string;
}

export interface SaveWorkspaceOutlineInput {
  workspace_dir: string;
  outline: {
    global_creation_requirements?: string;
    title: string;
    items: WorkspaceOutlineItem[];
  };
}

export interface AppendWorkspaceLogInput {
  workspace_dir: string;
  channel:
    | "attachment-preflight"
    | "ai-requirements"
    | "ai-requirements-interactions"
    | "ai-outline"
    | "ai-outline-interactions"
    | "ai-style-guide"
    | "ai-style-guide-interactions"
    | "ai-persistent-elements"
    | "ai-persistent-elements-interactions"
    | "ai-visual-rhythm"
    | "ai-visual-rhythm-interactions"
    | "ai-page-visual-plan"
    | "ai-page-visual-plan-interactions"
    | "ai-page-agent"
    | "ai-page-agent-interactions"
    | "ai-page-agent-stream"
    | "ai-research"
    | "ai-research-interactions"
    | "research-web-interactions"
    | "ai-theme"
    | "ai-theme-interactions"
    | "storage-transport"
    | "preview-recovery";
  entry: Record<string, unknown>;
  payload_keys?: string[];
  inline_payload_max_bytes?: number;
}

export interface AppendWorkspaceLogResult {
  workspace_dir: string;
  log_file: string;
  appended: boolean;
}

export interface WriteResearchTestFileResult {
  run_id: string;
  run_dir: string;
  file_path: string;
  written: true;
}

export interface CreateProjectInput {
  projectDir: string;
  title: string;
  initialRequest?: string;
}

export interface ProjectResult {
  projectDir: string;
  state: unknown;
  nextStep?: string;
}

export interface RecordRequirementsInput {
  projectDir: string;
  requirements: string;
}

export interface TemplateSummary {
  group_id: string;
  group_name: string;
  group_description: string;
  ordered: boolean;
  default: boolean;
  group_brief?: string;
  style_tags?: string[];
  industry_tags?: string[];
  use_cases?: string[];
  audience_tags?: string[];
  tone_tags?: string[];
  cover_layout_id?: string;
  agenda_layout_id?: string;
  closing_layout_id?: string;
  layout_roles_summary?: string[];
  content_elements_summary?: string[];
  layout_count: number;
}

export interface ListTemplatesResult {
  templates: TemplateSummary[];
  count: number;
}

export interface SelectTemplateInput {
  workspace_dir: string;
  template_group: string;
}

export interface WorkspaceTemplateSelection {
  version: 1;
  selected_template_group: string;
  selected_template_group_name: string;
  template_dir: string;
  manifest_path: string;
  catalog_json_path?: string;
  data_dir_path?: string;
  selected_at: string;
}

export interface SelectTemplateResult {
  workspace: WorkspaceResult;
  selection: WorkspaceTemplateSelection;
}

export interface TemplatePlanningBlueprint {
  id: string;
  name: string;
  blueprint_source: string;
  example_slide?: string;
  layout_family?: string;
  content_intents: string[];
  suitable_for: string[];
  avoid_for: string[];
}

export interface TemplatePlanningContext {
  template_group: string;
  template_group_name: string;
  template_dir: string;
  manifest_path: string;
  catalog_path: string;
  blueprints: TemplatePlanningBlueprint[];
  rules: string[];
}

export interface WorkspaceThemeValidationResult {
  ok: boolean;
  errors: string[];
}

export interface WorkspaceThemeContext {
  workspace_dir: string;
  template_dir: string;
  token_path: string;
  schema_path: string;
  default_token_path: string;
  readme_path: string;
  schema: Record<string, unknown>;
  default_token: unknown;
  current_token: unknown | null;
  current_token_validation: WorkspaceThemeValidationResult | null;
  readme: string;
}

export interface RecordWorkspaceThemeTokenResult {
  workspace: WorkspaceResult;
  workspace_dir: string;
  token_path: string;
  fallback_used: boolean;
  validation: WorkspaceThemeValidationResult;
  token: unknown;
}


export interface PageFileFingerprint {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface GetWorkspacePageFileFingerprintsInput {
  workspace_dir: string;
  slide_path: string;
  data_path: string;
}

export interface GetWorkspacePageFileFingerprintsResult {
  workspace_dir: string;
  slide: PageFileFingerprint;
  data: PageFileFingerprint;
}

export type SharedResearchStageState = "waiting" | "running" | "completed" | "skipped" | "warning";

export interface SharedResearchImageCandidate {
  candidate_id: string;
  query: string;
  dedup_key?: string;
  representative_occurrence_id?: string;
  matched_occurrence_ids?: string[];
  matched_queries?: string[];
  image_url: string;
  thumbnail_url?: string | null;
  source_url: string;
  title?: string | null;
  width?: number | null;
  height?: number | null;
  use_in_ppt: boolean;
  /** User adoption does not rewrite the original Agent recommendation. */
  selected_by_user?: boolean;
  description: string;
  reason: string;
  aps_path?: string;
  aps_fetch_status?: "pending" | "running" | "completed" | "failed";
  aps_fetch_error?: string;
  aps_quota_consumed?: number;
  local_download_status?: "pending" | "running" | "completed" | "failed";
  local_download_error?: string;
  upload_status?: "pending" | "running" | "completed" | "failed" | "skipped";
  upload_r2_key?: string;
  upload_expires_at?: string;
  analysis_status?: "pending" | "running" | "completed" | "failed" | "skipped";
  file_path?: string;
  local_file_path?: string;
  import_status: "pending" | "imported" | "failed" | "skipped";
  sha256?: string;
  mime_type?: string;
  bytes_size?: number;
  final_url?: string;
  content_duplicate_of?: string;
  error?: string;
}

export interface SharedResearchImageBatch {
  title: string;
  status: SharedResearchStageState;
  queries: Array<{
    query: string;
    status: SharedResearchStageState;
    candidate_count: number;
    message?: string;
  }>;
  candidates: SharedResearchImageCandidate[];
  gaps: string[];
  statistics?: {
    queries: number;
    candidates: number;
    raw_candidates?: number;
    unique_url_candidates?: number;
    duplicate_url_occurrences?: number;
    downloaded?: number;
    uploaded?: number;
    aps_fetched?: number;
    unique_content_candidates?: number;
    download_failed?: number;
    upload_failed?: number;
    aps_fetch_failed?: number;
    selected: number;
    imported: number;
    unique_content_imported?: number;
    failed: number;
    gaps: number;
  };
}

export interface SharedResearchImageAsset {
  title?: string;
  asset_id: string;
  file_path: string;
  sha256: string;
  mime_type: string;
  bytes_size: number;
  width?: number;
  height?: number;
  aspect_ratio: number | null;
  description: string;
  recommended?: boolean;
  recommendation?: "recommended" | "not_recommended" | "not_analysed";
  reason: string;
  matched_queries: string[];
  source_url: string;
  /** Original user filename when the asset came from an uploaded attachment. */
  source_filename?: string;
}

export interface SharedResearchImageCatalog {
  schema_version: 2;
  assets: SharedResearchImageAsset[];
}

export interface SharedResearchContextResult {
  workspace_dir: string;
  web_summary_path: string;
  image_catalog_path: string;
  images_dir: string;
  progress_path: string;
  web_summary: string;
  image_catalog: SharedResearchImageCatalog;
  image_candidates?: ImageCandidateReference[];
  /** Persistent visual assets explicitly supplied by the user, outside research evidence. */
  uploaded_asset_catalog_path?: string;
  uploaded_asset_catalog?: SharedResearchImageCatalog;
  progress: Record<string, unknown>;
}

/** Stable, fetched APS original; signed preview/download URLs never belong here. */
export interface ImageCandidateReference {
  candidate_id: string;
  aps_path: string;
  aps_paths?: string[];
  sha256: string;
  mime_type: string;
  bytes_size: number;
  image_url: string;
  source_url: string;
  source_urls: string[];
  matched_queries: string[];
  title?: string;
  width?: number;
  height?: number;
  description: string;
  use_in_ppt: boolean;
  recommendation: "recommended" | "not_recommended" | "not_analysed";
}

export type SharedResearchStage =
  | "web_decision"
  | "web_research"
  | "image_decision"
  | "image_research"
  | "image_search"
  | "image_deduplication"
  | "image_prefetch"
  | "image_analysis"
  | "image_import";

export type SharedResearchProgressOperation =
  | { op: "set_stage"; stage: SharedResearchStage; state: SharedResearchStageState }
  | { op: "set_web_decision"; decision: Record<string, unknown> }
  | { op: "upsert_web_search"; query: string; search: Record<string, unknown> }
  | { op: "set_web_fetch_result_ids"; result_ids: string[] }
  | { op: "upsert_web_fetched_page"; url: string; page: Record<string, unknown> }
  | { op: "set_web_prepared_batch"; markdown: string }
  | { op: "set_web_diagnostics"; gaps: string[]; diagnostic_errors: string[] }
  | { op: "set_image_decision"; decision: Record<string, unknown> }
  | { op: "upsert_image_search"; query: string; search: Record<string, unknown> }
  | { op: "set_image_work_status"; field: "search_status" | "prepare_status" | "analysis_status" | "import_status"; state: "waiting" | "running" | "completed" | "warning" }
  | { op: "upsert_image_deduplication_entry"; candidate_id: string; group: Record<string, unknown>; candidate: Record<string, unknown> }
  | { op: "set_image_deduplication_summary"; strategy: Record<string, unknown>; statistics: Record<string, unknown> }
  | { op: "upsert_image_analysis_batch"; batch_id: string; batch: Record<string, unknown>; candidates: Array<{ candidate_id: string; candidate: Record<string, unknown> }> }
  | { op: "upsert_image_candidate"; candidate_id: string; candidate: Record<string, unknown> }
  | { op: "set_image_diagnostics"; gaps: string[]; diagnostic_errors: string[] }
  | { op: "set_image_content_deduplication"; value: Record<string, unknown> }
  | { op: "finalize_image_research"; title: string; status: SharedResearchStageState; queries: Array<Record<string, unknown>>; gaps: string[]; statistics: Record<string, unknown> }
  | { op: "finalize_shared_research" };

export interface PatchSharedResearchProgressResult {
  workspace_dir: string;
  progress_path: string;
  updated: boolean;
  revision: number;
  updated_at: string;
}

export interface PublishSharedResearchBatchResult {
  workspace_dir: string;
  artifact_path: string;
  published: boolean;
  already_published: boolean;
  revision: number;
}

export interface ImportSharedResearchImageResult {
  workspace_dir: string;
  candidate_id: string;
  file_path: string;
  sha256: string;
  mime_type: string;
  bytes_size: number;
  width: number | null;
  height: number | null;
}

export interface PrepareSharedResearchImageCandidateResult {
  candidate_id: string;
  local_file_path: string;
  final_url: string;
  mime_type: string;
  bytes_size: number;
  sha256: string;
  width: number;
  height: number;
}

export interface UploadSharedResearchImageCandidateResult {
  workspace_dir: string;
  candidate_id: string;
  host_upload: HostUploadRef;
}

export interface CleanupSharedResearchImageStagingResult {
  workspace_dir: string;
  operation_id: string;
  cleaned: boolean;
}

export interface PageProgressItem {
  page_id: string;
  status: string;
  render_attempts: number;
  visual_review_attempts: number;
  agent_failures: number;
  agent_infrastructure_failures: number;
  last_html_path: string;
  last_screenshot_path: string;
  last_error: string;
  render_source_sha256?: string;
  /** Source hash of the last successfully persisted static HTML. Unlike
   * render_source_sha256, it does not advance when a render is only submitted. */
  snapshot_source_sha256?: string;
  visual_review?: unknown | null;
  updated_at: string | null;
}

export type PageProgressRecoveryRunKind =
  | "deck-generation"
  | "page-generation-retry"
  | "page-refinement"
  | "deck-refinement"
  | "final-deck-render";

export type PageProgressRecoveryStatus =
  | "idle"
  | "running"
  | "interrupted"
  | "failed"
  | "completed";

export interface PageProgressRecoveryState {
  status: PageProgressRecoveryStatus;
  run_kind: PageProgressRecoveryRunKind | null;
  step: string | null;
  target_page_ids: string[];
  refinement_request: string | null;
  page_refinement_reasons: Record<string, string>;
  error: string | null;
  updated_at: string | null;
}

export interface PreparePageRefinementInput {
  workspace_dir: string;
  page_id: string;
  refinement_request: string;
}

export interface PreparePageRefinementResult {
  workspace_dir: string;
  page_id: string;
  progress: PageProgress;
}

export type CommitDeckRefinementOperation =
  | { op: "keep"; page_id: string; reason: string }
  | { op: "update"; page_id: string; page_type: OutlinePageType; title: string; content: string; reason: string }
  | { op: "add"; page_type: OutlinePageType; title: string; content: string; reason: string }
  | { op: "delete"; page_id: string; reason: string };

export interface CommitDeckRefinementInput {
  workspace_dir: string;
  refinement_request: string;
  title: string;
  output_language_change: { changed: boolean; output_language?: string };
  style_guide_action: "preserve" | "regenerate";
  operations: CommitDeckRefinementOperation[];
  style_guide_content?: string;
}

export interface CommitDeckRefinementResult {
  workspace_dir: string;
  outline: WorkspaceOutline;
  progress: PageProgress;
  target_page_ids: string[];
  added_page_ids: string[];
  deleted_page_ids: string[];
}

export type FinalDeckRenderStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export interface FinalDeckRenderState {
  status: FinalDeckRenderStatus;
  message: string | null;
  error: string | null;
  output_dir: string | null;
  deck_html_path: string | null;
  rendered_at: string | null;
  updated_at: string | null;
  source_fingerprint?: string | null;
}

export type ResearchDiscoveryProgressPhase =
  | "web-decision"
  | "web-collection"
  | "visual-decision"
  | "visual-collection";

export type ResearchDiscoveryProgressState =
  | "waiting"
  | "running"
  | "completed"
  | "warning"
  | "skipped";

export interface ResearchDiscoveryProgressSource {
  snippet?: string;
  title?: string;
  url?: string;
}

export interface ResearchDiscoveryProgressQuery {
  kind: "web" | "visual";
  query: string;
  status: "running" | "collected" | "gap" | "error" | "skipped_duplicate";
  resultCount?: number;
  fetchCount?: number;
  downloadCount?: number;
  message?: string;
  sources?: ResearchDiscoveryProgressSource[];
  images?: ResearchDiscoveryProgressVisualAsset[];
}

export interface ResearchDiscoveryProgressVisualAsset {
  title?: string;
  state?: "candidate" | "selected" | "available" | "rejected" | "unavailable" | "duplicate";
  id: string;
  filePath?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  pageUrl?: string;
  reason?: string;
  visualSummary?: string;
}

export interface ResearchDiscoveryProgressSummary {
  facts: number;
  derivedInsights: number;
  visualAssets: number;
  gaps: number;
  rejectedMaterial: number;
}

export type ResearchDiscoveryProgressActivityKind =
  | "web-decision"
  | "web-search"
  | "web-fetch-selection"
  | "web-fetch"
  | "web-synthesis"
  | "web-publish"
  | "web-complete"
  | "web-skipped"
  | "image-decision"
  | "image-search"
  | "image-deduplication"
  | "image-download"
  | "image-prepare"
  | "image-analysis"
  | "image-import"
  | "image-publish"
  | "image-complete"
  | "image-skipped";

export interface ResearchDiscoveryProgressActivity {
  kind: ResearchDiscoveryProgressActivityKind;
  completed?: number;
  total?: number;
  count?: number;
  selected?: number;
  failed?: number;
}

export interface ResearchLiveRound {
  id: string;
  text: string;
  state: "running" | "completed" | "failed";
  startedAt: number;
  endedAt?: number;
}

export interface ResearchDiscoveryProgressPhaseRecord {
  /** View-only detail. Never include in page-progress persistence. */
  liveRounds?: ResearchLiveRound[];
  fetchedPages?: Array<import("./researchWebClient").ResearchWebFetchPage & { pending?: boolean }>;
  report?: string;
  phase: ResearchDiscoveryProgressPhase;
  state: ResearchDiscoveryProgressState;
  iteration?: number;
  rationale?: string;
  queries?: ResearchDiscoveryProgressQuery[];
  sources?: ResearchDiscoveryProgressSource[];
  visualAssets?: ResearchDiscoveryProgressVisualAsset[];
  activity?: ResearchDiscoveryProgressActivity;
  activities?: string[];
  lines?: string[];
  gaps?: string[];
  rejectedReasons?: string[];
  counts?: Partial<ResearchDiscoveryProgressSummary>;
  updatedAt?: string;
}

export interface ResearchDiscoveryProgress {
  status: ResearchDiscoveryProgressState;
  records: ResearchDiscoveryProgressPhaseRecord[];
  summary: ResearchDiscoveryProgressSummary;
  updatedAt?: string;
}

export interface PageProgress {
  version: 1;
  status: string;
  recovery?: PageProgressRecoveryState;
  final_deck_render?: FinalDeckRenderState;
  research_discovery?: ResearchDiscoveryProgress;
  pages: PageProgressItem[];
  updated_at: string | null;
}

export interface RecordPageProgressInput {
  workspace_dir: string;
  page_id?: string;
  patch: Record<string, unknown>;
}

export interface RenderWorkspacePagePreviewInput {
  workspace_dir: string;
  page_id: string;
}

export interface WorkspaceAuthoringKitResult {
  workspace_dir: string;
  authoring_kit_dir: string;
  manifest_path: string;
  slides_dir: string;
  installed: boolean;
}

export interface PrepareWorkspacePageSourcesResult {
  paths: Omit<WorkspaceAuthoringKitResult, "installed">;
  outline: WorkspaceOutline;
  manifest: { title: string; slides: Array<{ id: string; source: string }> };
  created_page_ids: string[];
}

export interface WorkspacePageSourceFingerprint {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface CommitWorkspaceStyleGuideInput {
  workspace_dir: string;
  content: string;
}

export interface WorkspaceHtmlArtifact {
  workspace_dir: string;
  path: string;
  size_bytes: number;
  sha256: string;
  updated_at: string;
  content?: string;
}

export interface CommitWorkspaceHtmlInput {
  workspace_dir: string;
  content: string;
}

export interface CommitWorkspacePageHtmlInput extends CommitWorkspaceHtmlInput {
  page_id: string;
}

export interface TemplateReferencePage {
  path: string;
  description: string;
}

export interface TemplateReferenceHtmlPage extends TemplateReferencePage {
  html: string;
}

export interface TemplateReferenceCatalog {
  version: 1;
  preset: VisualStylePresetSelection;
  reference_html_pages: TemplateReferencePage[];
}

export interface AestheticReferenceSelection {
  target: "visual-master" | "page";
  page_id: string | null;
  path: string;
  selected_at: string;
}

export interface AestheticReferenceSelections {
  version: 1;
  visual_master: AestheticReferenceSelection | null;
  pages: Record<string, AestheticReferenceSelection>;
  updated_at: string | null;
}

export interface ConfirmWorkspaceRequirementsInput {
  workspace_dir: string;
  requirements: PresentationRequirements;
  template_snapshot?: { version: number; preset: VisualStylePresetSelection; reference_html_pages: Array<{ path: string; html: string }> };
  user_template_id?: string;
}

export interface ConfirmWorkspaceRequirementsResult {
  workspace: WorkspaceResult;
  template_reference: TemplateReferenceCatalog | null;
}

export interface CommitWorkspaceStyleGuideResult {
  workspace_dir: string;
  style_guide_path: string;
  size_bytes: number;
  sha256: string;
  updated_at: string;
}

export interface WorkspaceStyleGuideStatus {
  workspace_dir: string;
  style_guide_path: string;
  exists: boolean;
  non_empty: boolean;
  size_bytes: number;
  sha256?: string;
}

export interface WorkspaceStyleGuide extends WorkspaceStyleGuideStatus {
  content: string;
}

export interface CommitVisualRhythmInput {
  workspace_dir: string;
  content: string;
}

export interface VisualRhythmStatus {
  workspace_dir: string;
  visual_rhythm_path: string;
  exists: boolean;
  non_empty: boolean;
  size_bytes: number;
}

export interface VisualRhythm extends VisualRhythmStatus { content: string; }

export interface CommitPageVisualPlanInput {
  workspace_dir: string;
  page_id: string;
  content: string;
}

export interface PageVisualPlanStatus {
  workspace_dir: string;
  page_id: string;
  page_visual_plan_path: string;
  exists: boolean;
  non_empty: boolean;
  size_bytes: number;
}

export interface PageVisualPlan extends PageVisualPlanStatus { content: string; }

export interface WorkspacePersistentElementsReferenceStatus {
  workspace_dir: string;
  persistent_elements_path: string;
  exists: boolean;
  non_empty: boolean;
  size_bytes: number;
  sha256?: string;
}

export interface RenderWorkspacePagePreviewSubmissionResult {
  status: "queued" | "running";
  already_queued: boolean;
  workspace_dir: string;
  manifest_path: string;
  page_index: number;
  page_number: number;
  slide_id: string;
  layout_id: string;
  title: string;
  render_attempt: number;
  source_sha256: string;
  submitted_at: string;
}

export interface RenderWorkspacePagePreviewResult {
  workspace_dir: string;
  manifest_path: string;
  html_path: string;
  screenshot_path: string;
  page_index: number;
  page_number: number;
  slide_id: string;
  layout_id: string;
  title: string;
  rendered_at: string;
}

export interface UploadCurrentPageScreenshotInput {
  workspace_dir: string;
  page_id: string;
}

export type ManagedFontVariant = "regular" | "bold" | "italic" | "boldItalic";
export type ManagedFontFormat = "ttf" | "otf" | "woff" | "woff2";

export interface ManagedFontFamilySummary {
  family: string;
  variants: ManagedFontVariant[];
  source: "cloud" | "uploaded";
  cached: boolean;
}

export interface ManagedFontRuntimeVariant {
  variant: ManagedFontVariant;
  sources: ManagedFontRuntimeSource[];
}

/** A face may comprise several Unicode subsets (notably CJK Google Fonts). */
export interface ManagedFontRuntimeSource {
  format: ManagedFontFormat;
  mime_type: string;
  size_bytes: number;
  source_url: string;
  expires_at: string;
  local_url: string;
  unicode_range?: string;
}

export interface ManagedFontRuntimeFamily {
  family: string;
  variants: Partial<Record<ManagedFontVariant, ManagedFontRuntimeVariant>>;
}

export interface CommitManagedFontUploadInput {
  workspace_dir: string;
  filename: string;
  size_bytes: number;
  host_upload: HostUploadRef;
}

export interface CommitManagedFontUploadResult {
  library: {
    families: ManagedFontFamilySummary[];
  };
  font: ManagedFontRuntimeFamily;
}

export interface ManualPageRevisionManifest {
  version: 1;
  source_authority?: "slides";
  page_id: string;
  revision: number;
  manually_edited: true;
  base_source_sha256: string;
  base_html_sha256: string;
  current_html_sha256: string;
  base_html_path: string;
  current_html_path: string;
  screenshot_path: string;
  updated_at: string;
}

export interface ManualPageResource {
  local_url: string;
  url: string;
  expires_at: string;
}

export interface GetPageEditContextInput {
  workspace_dir: string;
  page_id: string;
  purpose?: "editor" | "refinement";
}

export interface GetPageEditContextResult {
  workspace_dir: string;
  page_id: string;
  title: string;
  page_index: number;
  revision: number;
  manually_edited: boolean;
  html_path: string;
  html: string;
  screenshot_path: string;
  screenshot_upload?: HostUploadRef;
  resources: ManualPageResource[];
  resources_expires_at: string | null;
  manifest: ManualPageRevisionManifest | null;
  font_library: ManagedFontFamilySummary[];
  workspace_font_library: ManagedFontFamilySummary[];
  workspace_fonts: ManagedFontRuntimeFamily[];
}

export interface CommitManualPageImageInput {
  workspace_dir: string;
  page_id: string;
  size_bytes: number;
  host_upload: HostUploadRef;
}
export interface ManualPageImage extends ManualPageResource { width: number; height: number }
export interface RefreshManualPageResourcesInput {
  workspace_dir: string;
  page_id: string;
  local_urls: string[];
}
export interface SaveManualPageRevisionInput {
  workspace_dir: string;
  page_id: string;
  base_revision: number;
  html: string;
  /** Identifies the user-visible action that initiated the save. */
  save_source?: "explicit" | "switch-confirm" | "exit-confirm" | "shortcut";
}

export interface SaveManualPageRevisionResult {
  preview_source_fingerprint: string;
  workspace_dir: string;
  page_id: string;
  manifest: ManualPageRevisionManifest;
  final_deck_render_updated: boolean;
  final_deck_render_requires_rebuild: boolean;
  deck_html_path: string | null;
  rendered_at: string | null;
  page_progress_updated_at: string;
}

export interface PageRecoveryOption {
  workspace_dir: string;
  page_id: string;
  available: boolean;
  source?: "original_source" | "manual_base" | "saved_snapshot";
  recovery_token?: string;
}

export interface RestorePageSourceVersionInput extends GetPageEditContextInput {
  recovery_token?: string;
}

export interface RestorePageSourceVersionResult {
  page_progress?: PageProgress;
  manually_edited?: boolean;
  preview_source_fingerprint: string;
  workspace_dir: string;
  page_id: string;
  restored: true;
  html_path: string;
  screenshot_path: string;
  html: string;
  final_deck_render_updated: boolean;
  final_deck_render_requires_rebuild: boolean;
  deck_html_path: string | null;
  rendered_at: string | null;
  page_progress_updated_at: string;
}

export interface RecordOutlineInput {
  projectDir: string;
  outline: unknown;
}

export interface RenderDeckHtmlInput {
  workspace_dir: string;
  /** UI metadata only; generation and export must use strict reads. */
  allow_partial?: boolean;
}

export interface RenderDeckHtmlSubmissionResult {
  status: "queued" | "running";
  already_queued: boolean;
  workspace_dir: string;
  manifest_path: string;
  output_dir: string;
  source_fingerprint: string;
  submitted_at: string;
}

export interface RenderDeckHtmlResult {
  workspace_dir: string;
  manifest_path: string;
  output_dir: string;
  deck_html_path: string;
  slides: Array<{
    slide_id: string;
    layout_id: string;
    title: string;
    html_path: string;
    preview_unavailable?: boolean;
    screenshot_path?: string;
    render_source_fingerprint?: string;
    preview_source_fingerprint?: string;
    /** Monotonic per-save marker so preview caches key off every manual save. */
    preview_version?: string;
    screenshot_upload?: HostUploadRef;
    speaker_note: string;
    manually_edited?: boolean;
  }>;
  slide_count: number;
  title: string;
  rendered_at: string;
  diagnostics?: unknown;
}

export interface GetWorkspaceCoverInput {
  workspace_dir: string;
}

export interface GetWorkspaceCoverResult {
  version: 1;
  workspace_dir: string;
  page_id: string;
  source_path: string;
  cover_path: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  generated_at: string;
  /** Display-ready URL, normalized by PptBackend from inline or uploaded transport. */
  cover_url: string;
}

export type WorkspaceCoverTransport = Omit<GetWorkspaceCoverResult, "cover_url"> & (
  | { cover_data_url: string; cover_upload?: never }
  | { cover_upload: HostUploadRef; cover_data_url?: never }
);

export interface GetWorkspacePageImageInput {
  workspace_dir: string;
  page_id: string;
  width?: number;
  force_upload_refresh?: boolean;
}

export interface GetWorkspacePageImageResult {
  version: 1;
  workspace_dir: string;
  page_id: string;
  page_index: number;
  page_status: string;
  source_path: string;
  preview_source_fingerprint: string;
  image_path: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  generated_at: string;
  image_upload: HostUploadRef;
}

export interface RecordDeckReviewInput {
  projectDir: string;
  approved: boolean;
  feedback?: string;
}

export type PptxExportStatus =
  | "idle"
  | "queued"
  | "validating"
  | "converting"
  | "completed"
  | "failed";

export interface PptxExportJob {
  version: 2;
  job_id: string;
  status: PptxExportStatus;
  message: string;
  percent: number;
  current_page?: number | null;
  total_pages?: number | null;
  export_phase?: "rendering" | "merging" | null;
  page_numbers?: number[] | null;
  workspace_dir: string;
  status_path: string;
  output_dir: string;
  deck_html_path: string;
  pptx_path: string;
  started_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  error: {
    message: string;
    stack?: string;
  } | null;
  /** Managed font families whose bold or italic variant will be simulated. */
  warnings: string[];
  /** Font families that could not be embedded; the viewer substitutes them. */
  font_embed_warnings?: string[];
  warning_count: number;
}

export interface StartPptxExportInput {
  workspace_dir: string;
  page_numbers?: number[];
}

export interface ExportPdfInput {
  workspace_dir: string;
  page_numbers?: number[];
}

export interface ExportPdfResult {
  pdfPath: string;
  htmlPath: string;
  outputDir: string;
}

export interface RecordPdfExportInput {
  workspace_dir: string;
  pdfPath: string;
}

export interface GetExportArtifactDownloadUrlInput {
  workspace_dir: string;
  artifact_type: "pptx" | "pdf";
}

export interface ExportArtifactMirror {
  provider: "aps.files";
  scope: "user";
  path: string;
  etag: string;
  size_bytes: number;
  content_type: string;
  content_disposition: string;
  source_updated_at: string;
  source_sha256: string;
  published_at: string;
}

export interface ExportArtifactInfo {
  workspace_dir: string;
  workspace_id: string;
  title: string;
  artifact_type: "pptx" | "pdf";
  path: string;
  filename: string;
  updated_at: string;
  mirror: ExportArtifactMirror | null;
}

export type ExportArtifactPublishStatus =
  | "idle"
  | "queued"
  | "preparing"
  | "uploading"
  | "committing"
  | "completed"
  | "failed";

export interface ExportArtifactPublishJob {
  version: 1;
  job_id: string;
  status: ExportArtifactPublishStatus;
  message: string;
  percent: number;
  workspace_dir: string;
  artifact_type: "pptx" | "pdf";
  status_path: string;
  source_updated_at: string;
  source_sha256: string;
  size_bytes: number;
  started_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  artifact: ExportArtifactInfo | null;
  mirror: ExportArtifactMirror | null;
  error: { message: string; stack?: string; interrupted?: boolean } | null;
}

export type ExportArtifactDownloadUrlResult =
  | {
      status: "ready";
      reason: null;
      artifact: ExportArtifactInfo;
      mirror: ExportArtifactMirror;
      download_url: string;
      expires_at: string | null;
    }
  | {
      status: "missing" | "stale";
      reason: "mirror_missing" | "artifact_version_changed" | "source_hash_changed";
      artifact: ExportArtifactInfo;
      mirror: ExportArtifactMirror | null;
      download_url: null;
      expires_at: null;
    };

export interface PrepareWorkspaceDiagnosticBundleInput {
  workspace_dir: string;
}

export interface PrepareWorkspaceDiagnosticBundleResult {
  status: "ready";
  workspace_id: string;
  filename: string;
  size_bytes: number;
  download_url: string;
  expires_at: string | null;
  /** Object reference the Host can download directly; absent on older engines. */
  mirror?: {
    provider?: string;
    scope?: string;
    path?: string;
    content_type?: string;
    content_disposition?: string;
    size_bytes?: number;
  };
}

export interface PageLayoutAuditResult {
  page_id: string;
  source_sha256: string;
  error_count: number;
  warning_count: number;
  report_path: string;
  source_html?: string;
  screenshot_upload?: HostUploadRef;
}
