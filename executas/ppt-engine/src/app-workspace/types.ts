import type {
  ManagedFontFamily,
  ManagedFontFamilySummary,
} from "../font-library/index.js";
import type { PerformanceTokenUsageSummary } from "../performance-runs/index.js";

export interface AppWorkspaceSummary {
  workspace_id: string;
  /** Legacy aliases are kept only for internal callers that still need them. */
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

export interface AppWorkspaceFiles {
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
  pages: string;
  template: string;
  visual_master: string;
  aesthetic_reference_selections: string;
  template_reference: string;
}

export interface AppPresentationRequirementsCandidates {
  slide_count: number[];
  output_language: string[];
}

export interface AppPresentationRequirementsSelections {
  aspect_ratio?: import("../slide-format.js").SlideAspectRatio;
  slide_count: number | null;
  output_language: string | null;
  visual_style_preset: AppVisualStylePresetSelection | null;
}

export interface AppPresentationResearchChoice {
  recommended: boolean | null;
  reason: string;
  enabled: boolean | null;
}

export interface AppPresentationResearchRequirements {
  web: AppPresentationResearchChoice;
  images: AppPresentationResearchChoice;
}

export interface AppVisualStylePresetSelection {
  id: string;
  version: number;
  name: string;
  description: string;
}

export type AppTemplateRecommendationTrigger = "low_signal" | "rules_fallback";
export type AppTemplateRecommendationMatchAxis = "use_case" | "industry" | "audience" | "format" | "style";

export interface AppTemplateRecommendationCandidate {
  preset: AppVisualStylePresetSelection;
  score: number;
  matched_axes: AppTemplateRecommendationMatchAxis[];
}

export interface AppTemplateRecommendation {
  selection_required: true;
  confidence: "low";
  trigger: AppTemplateRecommendationTrigger;
  candidates: AppTemplateRecommendationCandidate[];
}

export interface AppPresentationRequirements {
  version: 1;
  status: "empty" | "draft" | "confirmed";
  source: { brief: string } | null;
  candidates: AppPresentationRequirementsCandidates;
  selections: AppPresentationRequirementsSelections;
  template_recommendation?: AppTemplateRecommendation | null;
  research: AppPresentationResearchRequirements;
  updated_at: string | null;
  confirmed_at: string | null;
}

export interface AppWorkspaceOutlineItem {
  /** 当前页选中的素材标识；空数组表示不配图。 */
  selected_image_ids?: string[];
  page_id?: string;
  page_type: "cover" | "standard";
  title: string;
  /** 这一页的完整内容，一段连续的叙述性文字。 */
  content: string;
  title_segments?: AppOutlineTextSegment[];
  research?: AppOutlineResearchPlan;
  analysis?: AppOutlineAnalysis;
  creation_requirements?: string;
}

export type AppOutlineSource = "user" | "ai" | "research";

export interface AppOutlineTextSegment {
  text: string;
  source: AppOutlineSource;
  focus: boolean;
}

export interface AppOutlineResearchDirection {
  directions: string[];
  reason: string;
}

export interface AppOutlineResearchPlan {
  web: AppOutlineResearchDirection | null;
  images: AppOutlineResearchDirection | null;
}

export interface AppOutlineAnalysis {
  focus: string;
  ai_generated_content: string;
  web_needed: boolean;
  web_analysis: string;
  images_needed: boolean;
  images_analysis: string;
}

export interface AppWorkspaceOutline {
  /** 用户明确提出的全局创作要求；旧大纲缺省按空字符串读取。 */
  global_creation_requirements?: string;
  version: 4;
  title: string;
  status: "empty" | "draft" | "confirmed";
  items: AppWorkspaceOutlineItem[];
  updated_at: string | null;
  confirmed_at: string | null;
}

export interface AppWorkspaceResult {
  workspace_root: string;
  task_root: string;
  workspace_dir: string;
  task_dir: string;
  workspace_id: string;
  task_id: string;
  initialized: boolean;
  created_files: string[];
  missing_files: string[];
  files: AppWorkspaceFiles;
  task: unknown;
  setting: unknown;
  requirements: unknown;
  outline: unknown;
  page_progress: unknown;
  pages: unknown;
  template: unknown;
}

export interface AppWorkspaceSettings {
  audience?: string;
  goal?: string;
  style_notes?: string;
  output_language?: string;
  text_density?: string;
  visual_tone?: string;
  theme_id?: string;
  page_generation_concurrency?: number;
  research_image_session_concurrency?: number;
  research_web_max_rounds?: number;
  research_image_max_searches?: number;
  updated_at?: string;
  [key: string]: unknown;
}

export interface AppCreateWorkspaceSetting {
  page_generation_concurrency: number;
  research_image_session_concurrency: number;
  research_web_max_rounds: number;
  research_image_max_searches: number;
}

export interface CreateAppWorkspaceResult {
  version: 1;
  workspace_root: string;
  workspace_id: string;
  workspace_dir: string;
  title: string;
  setting: AppCreateWorkspaceSetting;
}

export type AppUploadedSourceStatus = "active" | "ignored" | "removed";

export interface AppUploadedSourceMaterial {
  uploaded_source_id: string;
  status: AppUploadedSourceStatus;
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
  ignored_at?: string | null;
  ignored_reason?: string | null;
}

export interface AppUploadedSourceIndex {
  version: 1;
  workspace_dir: string;
  active_total_size_bytes: number;
  materials: AppUploadedSourceMaterial[];
  updated_at: string;
}

export interface UploadAppUploadedSourceInput {
  workspace_dir: string;
  filename: string;
  mime_type?: string;
  content_base64: string;
}

export interface UploadAppUploadedSourceResult {
  workspace_dir: string;
  material: AppUploadedSourceMaterial;
  index: AppUploadedSourceIndex;
  warnings: string[];
}

export interface BeginAppUploadedSourceUploadInput {
  workspace_dir: string;
  filename: string;
  mime_type?: string;
  size_bytes: number;
}

export interface BeginAppUploadedSourceUploadResult {
  workspace_dir: string;
  upload_id: string;
  upload_url: string;
  expires_at: string;
  size_bytes: number;
}

export interface CommitAppUploadedSourceUploadInput {
  workspace_dir: string;
  upload_id: string;
}

export interface CommitAppUploadedSourceUploadResult extends UploadAppUploadedSourceResult {
  upload_id: string;
}

export interface ListAppUploadedSourcesInput {
  workspace_dir: string;
  include_removed?: boolean;
}

export interface ListAppUploadedSourcesResult {
  workspace_dir: string;
  index: AppUploadedSourceIndex;
  active: AppUploadedSourceMaterial[];
  removed: AppUploadedSourceMaterial[];
  ignored: AppUploadedSourceMaterial[];
  limits: {
    single_file_max_bytes: number;
    active_total_max_bytes: number;
  };
}

export type AppUploadedSourceParseStatus = "ready" | "partial" | "failed";
export type AppUploadedSourceContentStrategy =
  | "full_context"
  | "summarized_context"
  | "image_processing"
  | null;

export type AppUploadedSourceOriginalReadingMethod =
  | "document_read"
  | "document_retrieval"
  | "spreadsheet_read"
  /** Legacy value retained only when opening older Attachment Brief artifacts. */
  | "table_query"
  | "image_multimodal_read"
  | null;

export interface AppUploadedSourcePreflightWarning {
  code: string;
  message: string;
  locations?: string[];
}

export interface AppUploadedSourcePdfOcrProgress {
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

export interface AppUploadedSourcePreflightResult {
  source_id: string;
  filename: string;
  file_type: string;
  size_bytes: number;
  parse_status: AppUploadedSourceParseStatus;
  character_count?: number;
  token_estimate?: number;
  format_metrics: Record<string, number>;
  content_strategy: AppUploadedSourceContentStrategy;
  original_reading_method: AppUploadedSourceOriginalReadingMethod;
  warnings: AppUploadedSourcePreflightWarning[];
  pdf_ocr_progress?: AppUploadedSourcePdfOcrProgress;
}

export interface RunAppUploadedSourcePreflightInput {
  workspace_dir: string;
}

export interface RunAppUploadedSourcePreflightResult {
  workspace_dir: string;
  started_at: string;
  completed_at: string;
  results: AppUploadedSourcePreflightResult[];
}

export interface GetAppUploadedSourcePreflightStatusInput {
  workspace_dir: string;
}

export interface GetAppUploadedSourcePreflightStatusResult {
  workspace_dir: string;
  results: AppUploadedSourcePreflightResult[];
}

/** Advance each active PDF's persisted OCR checkpoint by a small safe batch. */
export interface ContinueAppUploadedSourcePdfOcrInput {
  workspace_dir: string;
}

export interface ContinueAppUploadedSourcePdfOcrResult {
  workspace_dir: string;
  results: AppUploadedSourcePreflightResult[];
}

export interface GetAppUploadedSourcePreflightTextInput {
  workspace_dir: string;
  uploaded_source_id: string;
  offset?: number;
  limit?: number;
  attachment_chunk?: boolean;
}

export interface GetAppUploadedSourcePreflightTextResult {
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

export interface AppUploadedSourcePreflightTextChunk {
  chunk_id: string;
  heading_path: string[];
  source_range: string;
  start_offset: number;
  end_offset: number;
  token_estimate: number;
}

export interface GetAppUploadedSourcePreflightChunksInput {
  workspace_dir: string;
  uploaded_source_id: string;
}

export interface GetAppUploadedSourcePreflightChunksResult {
  workspace_dir: string;
  uploaded_source_id: string;
  filename: string;
  total_characters: number;
  planning_ms: number;
  chunk_count: number;
  chunks: AppUploadedSourcePreflightTextChunk[];
}

export interface AppAttachmentBriefEvidence {
  evidence_id: string;
  fact: string;
  source_label: string;
  excerpt: string;
}

export interface AppAttachmentBriefSheetCoverage {
  sheet_name: string;
  status: "covered" | "not_relevant" | "unreadable";
  reason?: string;
  evidence_ids: string[];
}

export interface AppAttachmentBrief {
  version: 1;
  source_id: string;
  filename: string;
  content_strategy: "full_context" | "summarized_context";
  original_reading_method: "document_read" | "document_retrieval" | "spreadsheet_read" | "table_query" | "image_multimodal_read";
  relationship_to_task?: string;
  use_in_ppt?: boolean;
  image_usage_reason?: string;
  main_message?: string;
  content?: string;
  key_facts: AppAttachmentBriefEvidence[];
  must_include: Array<{ requirement: string; evidence_ids: string[] }>;
  must_avoid: string[];
  recommended_storyline: string[];
  gaps: string[];
  unread_content: string[];
  sheet_coverage?: AppAttachmentBriefSheetCoverage[];
  updated_at: string;
}

export interface AppAttachmentContext {
  version: 1;
  user_brief: string;
  attachment_context: AppAttachmentBrief[];
  updated_at: string;
}

export interface AppAttachmentBriefPaths {
  workspace_dir: string;
  source_id: string;
  analysis_dir: string;
  draft_path: string;
  json_path: string;
}

export interface PrepareAppAttachmentBriefInput {
  workspace_dir: string;
  uploaded_source_id: string;
}

export interface GetAppAttachmentBriefDraftInput extends PrepareAppAttachmentBriefInput {}
export interface GetAppAttachmentBriefInput extends PrepareAppAttachmentBriefInput {}

export interface RecordAppAttachmentBriefInput extends PrepareAppAttachmentBriefInput {
  brief: unknown;
}

export interface ListAppAttachmentBriefsInput {
  workspace_dir: string;
}

export interface ListAppAttachmentBriefsResult {
  workspace_dir: string;
  briefs: AppAttachmentBrief[];
}

export interface WriteAppAttachmentContextInput {
  workspace_dir: string;
  user_brief: string;
}

export interface GetAppAttachmentContextInput {
  workspace_dir: string;
}

export interface RemoveAppUploadedSourceInput {
  workspace_dir: string;
  uploaded_source_id: string;
}

export interface RemoveAppUploadedSourceResult {
  workspace_dir: string;
  material: AppUploadedSourceMaterial;
  index: AppUploadedSourceIndex;
}

export interface IgnoreAppUploadedSourceInput {
  workspace_dir: string;
  uploaded_source_id: string;
  reason?: string;
}

export interface IgnoreAppUploadedSourceResult {
  workspace_dir: string;
  material: AppUploadedSourceMaterial;
  index: AppUploadedSourceIndex;
}

export interface AppUploadedSourceAnalysisPaths {
  root_dir: string;
  drafts_dir: string;
  factual_draft_path: string;
  visual_draft_path: string;
  analysis_path: string;
  analysis_md_path: string;
}

export interface PrepareAppUploadedSourceAnalysisWorkspaceInput {
  workspace_dir: string;
}

export interface PrepareAppUploadedSourceAnalysisWorkspaceResult extends AppUploadedSourceAnalysisPaths {
  workspace_dir: string;
  uploaded_source_index: AppUploadedSourceIndex;
  prepared_at: string;
}

export interface RecordAppUploadedSourceAnalysisDraftInput {
  workspace_dir: string;
  draft_type: "factual" | "visual";
  draft_id?: string;
  draft: unknown;
}

export interface GetAppUploadedSourceAnalysisDraftInput {
  workspace_dir: string;
  draft_type: "factual" | "visual";
  draft_id?: string;
}

export interface GetAppUploadedSourceAnalysisDraftFingerprintInput {
  workspace_dir: string;
  draft_type: "factual" | "visual";
  draft_id?: string;
}

export interface AppUploadedSourceAnalysisDraftFingerprint {
  workspace_dir: string;
  draft_type: "factual" | "visual";
  draft_id?: string;
  draft_path: string;
  exists: boolean;
  sha256?: string;
  size_bytes?: number;
}

export interface RecordAppUploadedSourceAnalysisInput {
  workspace_dir: string;
  analysis: unknown;
  // Internal-only Markdown digest rendered from the analysis. Persisted next to
  // the JSON so downstream flows can read one Markdown file. Optional to stay
  // backward compatible with callers that only send the structured analysis.
  analysis_markdown?: string;
}

export interface GetAppUploadedSourceAnalysisInput {
  workspace_dir: string;
}

export interface AppStyleProfileIndexEntry {
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

export interface AppStyleProfileIndex {
  version: 1;
  library_dir: string;
  profiles: AppStyleProfileIndexEntry[];
  updated_at: string;
}

export interface ListAppStyleProfilesResult {
  library_dir: string;
  index: AppStyleProfileIndex;
  profiles: AppStyleProfileIndexEntry[];
}

export interface AppStyleProfileReferenceImagePreview {
  reference_image_id: string;
  file_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  order: number;
}

export interface GetAppStyleProfilePreviewInput {
  style_profile_id: string;
}

export interface GetAppStyleProfilePreviewResult {
  style_profile: AppStyleProfileIndexEntry;
  cover_image: AppStyleProfileReferenceImagePreview | null;
}

export interface GetAppStyleProfileInput {
  style_profile_id: string;
}

export interface GetAppStyleProfileResult {
  style_profile: AppStyleProfileIndexEntry;
  content: string;
  size_bytes: number;
  sha256: string;
  reference_images: AppStyleProfileReferenceImagePreview[];
}

export interface PrepareAppStyleProfileCreationInput {
  display_name?: string;
}

export interface AppStyleProfileCreationPaths {
  library_dir: string;
  creation_dir: string;
  uploads_dir: string;
  references_dir: string;
  rasterized_dir: string;
  draft_dir: string;
  draft_profile_path: string;
  manifest_path: string;
}

export interface PrepareAppStyleProfileCreationResult extends AppStyleProfileCreationPaths {
  creation_id: string;
  display_name: string;
  prepared_at: string;
}

export interface AppStyleProfileReferenceMaterial {
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

export interface AppReferenceSlideImage {
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

export interface AppStyleProfileCreationManifest {
  version: 1;
  creation_id: string;
  display_name: string;
  status: "prepared" | "uploaded" | "published";
  reference_materials: AppStyleProfileReferenceMaterial[];
  reference_images: AppReferenceSlideImage[];
  selected_reference_image_ids: string[];
  created_at: string;
  updated_at: string;
  published_style_profile_id?: string;
}

export interface CommitAppStyleProfileReferenceUploadInput {
  creation_id: string;
  upload_id: string;
  filename: string;
  mime_type?: string;
  staging_file_path: string;
  expected_size_bytes: number;
}

export interface CommitAppStyleProfileReferenceUploadResult {
  creation_id: string;
  upload_id: string;
  material: AppStyleProfileReferenceMaterial;
  manifest: AppStyleProfileCreationManifest;
  warnings: string[];
}

export interface GetAppStyleProfileCreationContextInput {
  creation_id: string;
}

export interface GetAppStyleProfileCreationContextResult extends AppStyleProfileCreationPaths {
  creation_id: string;
  manifest: AppStyleProfileCreationManifest;
  selected_reference_images: AppReferenceSlideImage[];
}

export interface AppStyleProfileDraftFingerprint {
  creation_id: string;
  draft_path: string;
  exists: boolean;
  sha256?: string;
  size_bytes?: number;
}

export interface GetAppStyleProfileDraftInput {
  creation_id: string;
}

export interface GetAppStyleProfileDraftFingerprintInput {
  creation_id: string;
}

export interface GetAppStyleProfileDraftResult {
  creation_id: string;
  draft_path: string;
  exists: boolean;
  content: string;
  size_bytes: number;
  sha256: string;
}

export interface PublishAppStyleProfileInput {
  creation_id: string;
  display_name?: string;
}

export interface PublishAppStyleProfileResult {
  style_profile: AppStyleProfileIndexEntry;
  index: AppStyleProfileIndex;
  profile_path: string;
  reference_count: number;
}

export interface SelectAppWorkspaceStyleProfileInput {
  workspace_dir: string;
  style_profile_id: string;
}

export interface AppWorkspaceStyleProfileSelection {
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

export interface SelectAppWorkspaceStyleProfileResult {
  workspace: AppWorkspaceResult;
  selection: AppWorkspaceStyleProfileSelection;
  content: string;
}

export interface GetAppWorkspaceStyleProfileInput {
  workspace_dir: string;
}

export interface GetAppWorkspaceStyleProfileResult {
  workspace_dir: string;
  selected: boolean;
  profile_path: string;
  selection_path: string;
  selection: AppWorkspaceStyleProfileSelection | null;
  content: string;
  size_bytes: number;
  sha256: string;
}

export interface ClearAppWorkspaceStyleProfileInput {
  workspace_dir: string;
}

export interface ClearAppWorkspaceStyleProfileResult {
  workspace: AppWorkspaceResult;
  cleared: boolean;
}

export interface ListAppWorkspacesResult {
  workspace_root: string;
  task_root: string;
  has_workspaces: boolean;
  has_tasks?: boolean;
  latest_workspace: AppWorkspaceSummary | null;
  latest_task?: AppWorkspaceSummary | null;
  workspaces: AppWorkspaceSummary[];
  tasks?: AppWorkspaceSummary[];
  /** Opaque cursor for the next bounded list page. */
  next_cursor?: string | null;
}

export interface CreateAppWorkspaceInput {
  title?: string;
}

export interface OpenAppWorkspaceInput {
  workspace_dir: string;
}

export interface UpdateAppWorkspaceSettingsInput {
  workspace_dir: string;
  setting: AppWorkspaceSettings;
  persist_as_default?: boolean;
}

export interface PatchAppWorkspaceSettingsResult {
  workspace_dir: string;
  setting: AppWorkspaceSettings;
  persisted_as_default: boolean;
}

export interface GetAppWorkspaceDefaultsResult {
  workspace_root: string;
  setting: Record<string, unknown>;
}

export interface UpdateAppWorkspaceTitleInput {
  workspace_dir: string;
  title: string;
}

export interface DeleteAppWorkspaceInput {
  workspace_dir: string;
}

export interface DuplicateAppWorkspaceInput {
  workspace_dir: string;
  title?: string;
  /**
   * When set, the copy's task.json is stamped as a local-conflict backup of the
   * source (`local_conflict_backup: true`, `backup_of: <this id>`) in the SAME
   * write that rebases the copy identity — before the copy's own snapshot
   * trigger fires, so the marker is never racy with the snapshot build.
   */
  local_conflict_backup_of?: string;
}

export interface DuplicateAppWorkspaceResult {
  version: 1;
  workspace_root: string;
  source_workspace_id: string;
  source_workspace_dir: string;
  workspace_id: string;
  workspace_dir: string;
  title: string;
}

export interface BackupWorkspaceAsLocalCopyInput {
  workspace_dir: string;
}

export interface BackupWorkspaceAsLocalCopyResult {
  version: 1;
  workspace_root: string;
  source_workspace_id: string;
  source_workspace_dir: string;
  workspace_id: string;
  workspace_dir: string;
  title: string;
  backup_of: string;
}

export interface GetAppWorkspaceOutlineInput {
  workspace_dir: string;
}

export interface GetAppWorkspaceRequirementsInput {
  workspace_dir: string;
}

export interface UpdateAppWorkspaceRequirementsInput {
  workspace_dir: string;
  requirements: unknown;
}

export interface ConfirmAppWorkspaceRequirementsInput {
  workspace_dir: string;
  requirements: unknown;
  template_reference_staging_file_path?: string;
  template_reference_expected_size_bytes?: number;
}

export interface ConfirmAppWorkspaceRequirementsResult {
  workspace: AppWorkspaceResult;
  template_reference: AppTemplateReferenceCatalog | null;
}

export interface AppTemplateReferencePage {
  path: string;
  description: string;
}

export interface AppTemplateReferenceHtmlPage extends AppTemplateReferencePage {
  html: string;
}

export interface AppTemplateReferenceCatalog {
  version: 1;
  preset: AppVisualStylePresetSelection;
  reference_html_pages: AppTemplateReferencePage[];
}

export interface AppTemplateReferenceSnapshot {
  version: 1;
  visual_master_html?: string;
  preset: AppVisualStylePresetSelection;
  reference_html_pages: AppTemplateReferenceHtmlPage[];
}

export interface AppAestheticReferenceSelection {
  target: "visual-master" | "page";
  page_id: string | null;
  path: string;
  selected_at: string;
}

export interface AppAestheticReferenceSelections {
  version: 1;
  visual_master: AppAestheticReferenceSelection | null;
  pages: Record<string, AppAestheticReferenceSelection>;
  updated_at: string | null;
}

export interface RecordAppWorkspaceHtmlInput {
  workspace_dir: string;
  staging_file_path: string;
  expected_size_bytes: number;
}

export interface RecordAppWorkspacePageHtmlInput extends RecordAppWorkspaceHtmlInput {
  page_id: string;
}

export interface RecordAppWorkspaceHtmlResult {
  workspace_dir: string;
  path: string;
  size_bytes: number;
  sha256: string;
  updated_at: string;
}

export interface RecordAppAestheticReferenceSelectionInput {
  workspace_dir: string;
  target: "visual-master" | "page";
  page_id?: string;
  path: string;
}

export interface ResetAppWorkspaceOutlineInput {
  workspace_dir: string;
}

export interface SaveAppWorkspaceOutlineDraftInput {
  workspace_dir: string;
  outline: {
    global_creation_requirements?: string;
    title: string;
    items: unknown;
  };
}

export interface ConfirmAppWorkspaceOutlineInput extends SaveAppWorkspaceOutlineDraftInput {}


export interface AppendAppWorkspaceLogInput {
  workspace_dir: string;
  channel:
    | "attachment-preflight"
    | "ai-requirements"
    | "ai-requirements-interactions"
    | "ai-outline"
    | "ai-outline-interactions"
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
    | "ai-persistent-elements"
    | "ai-persistent-elements-interactions"
    | "storage-transport"
    | "preview-recovery";
  entry: Record<string, unknown>;
  payload_keys?: string[];
  inline_payload_max_bytes?: number;
}

export interface AppendAppWorkspaceLogResult {
  workspace_dir: string;
  log_file: string;
  appended: boolean;
}

export interface WriteAppResearchTestFileInput {
  run_id: string;
  file_name: "input.json" | "rounds.jsonl" | "result.md" | "meta.json";
  content: string;
  append?: boolean;
}

export interface WriteAppResearchTestFileResult {
  run_id: string;
  run_dir: string;
  file_path: string;
  written: true;
}

export interface AppResearchPaths {
  root_dir: string;
  evidence_dir: string;
  evidence_images_dir: string;
  web_summary_path: string;
  image_catalog_path: string;
  images_dir: string;
  progress_path: string;
}

export interface PrepareAppSharedResearchWorkspaceInput {
  workspace_dir: string;
  reset_progress?: boolean;
}

export interface AppSharedResearchContextResult {
  workspace_dir: string;
  web_summary_path: string;
  image_catalog_path: string;
  images_dir: string;
  progress_path: string;
  web_summary: string;
  image_catalog: Record<string, unknown>;
  image_candidates?: import("./image-candidates.js").ImageCandidateReference[];
  uploaded_asset_catalog_path?: string;
  uploaded_asset_catalog?: Record<string, unknown>;
  progress: Record<string, unknown>;
}

export type AppSharedResearchStage =
  | "web_decision"
  | "web_research"
  | "image_decision"
  | "image_research"
  | "image_search"
  | "image_deduplication"
  | "image_prefetch"
  | "image_analysis"
  | "image_import";

export type AppSharedResearchStageState = "waiting" | "running" | "completed" | "skipped" | "warning";

export type AppSharedResearchProgressOperation =
  | { op: "set_stage"; stage: AppSharedResearchStage; state: AppSharedResearchStageState }
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
  | { op: "finalize_image_research"; title: string; status: AppSharedResearchStageState; queries: Array<Record<string, unknown>>; gaps: string[]; statistics: Record<string, unknown> }
  | { op: "finalize_shared_research" };

export interface PatchAppSharedResearchProgressInput {
  workspace_dir: string;
  operations: AppSharedResearchProgressOperation[];
}

export interface PatchAppSharedResearchProgressResult {
  workspace_dir: string;
  progress_path: string;
  updated: boolean;
  revision: number;
  updated_at: string;
}

export interface PublishAppSharedResearchBatchResult {
  workspace_dir: string;
  artifact_path: string;
  published: boolean;
  already_published: boolean;
  revision: number;
}

export interface AppendAppWebResearchBatchInput {
  workspace_dir: string;
  markdown: string;
}

export interface AppendAppImageResearchBatchInput {
  workspace_dir: string;
  batch: unknown;
}

export interface ImportAppSharedResearchImageInput {
  workspace_dir: string;
  candidate_id: string;
  staging_file_path: string;
  expected_size_bytes: number;
  expected_sha256?: string;
  mime_type: string;
}

export interface ImportAppSharedResearchImageResult {
  workspace_dir: string;
  candidate_id: string;
  file_path: string;
  sha256: string;
  mime_type: string;
  bytes_size: number;
  width: number | null;
  height: number | null;
}

/** Import an already-validated Workspace upload without exposing its path to callers. */
export interface ImportAppUploadedSourceImageToResearchInput {
  workspace_dir: string;
  uploaded_source_id: string;
  candidate_id: string;
}

/** Copy one classified uploaded image into the persistent uploaded-source asset catalog. */
export interface CopyAppUploadedSourceImageToAssetInput {
  workspace_dir: string;
  uploaded_source_id: string;
  candidate_id: string;
  description: string;
  reason: string;
}

export interface AppTemplateGroupSummary {
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

export interface ListAppTemplateGroupsResult {
  groups: AppTemplateGroupSummary[];
  count: number;
}

export interface GetAppTemplateGroupInput {
  group_id: string;
}

export interface SelectAppWorkspaceTemplateInput {
  workspace_dir: string;
  template_group: string;
}

export interface AppWorkspaceTemplateSelection {
  version: 1;
  selected_template_group: string;
  selected_template_group_name: string;
  template_dir: string;
  manifest_path: string;
  catalog_json_path?: string;
  data_dir_path?: string;
  selected_at: string;
}

export interface SelectAppWorkspaceTemplateResult {
  workspace: AppWorkspaceResult;
  selection: AppWorkspaceTemplateSelection;
}

export interface RenderAppWorkspaceDeckHtmlInput {
  workspace_dir: string;
  /** UI metadata only; generation and export must use strict reads. */
  allow_partial?: boolean;
}

export interface GetAppWorkspaceCoverInput {
  workspace_dir: string;
}

export interface GetAppWorkspaceCoverResult {
  version: 1;
  workspace_dir: string;
  page_id: string;
  source_path: string;
  cover_path: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  generated_at: string;
}

export interface GetAppWorkspacePageImageInput {
  workspace_dir: string;
  page_id: string;
  width?: number;
}

export interface GetAppWorkspacePageImageResult {
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
}

export interface AppTemplatePlanningBlueprint {
  id: string;
  name: string;
  blueprint_source: string;
  example_slide?: string;
  layout_family?: string;
  content_intents: string[];
  suitable_for: string[];
  avoid_for: string[];
}

export interface AppTemplatePlanningContext {
  template_group: string;
  template_group_name: string;
  template_dir: string;
  manifest_path: string;
  catalog_path: string;
  blueprints: AppTemplatePlanningBlueprint[];
  rules: string[];
}

export interface GetAppTemplatePlanningContextInput {
  workspace_dir: string;
}

export interface GetAppWorkspaceThemeContextInput {
  workspace_dir: string;
}

export interface AppWorkspaceThemeValidationResult {
  ok: boolean;
  errors: string[];
}

export interface AppWorkspaceThemeContext {
  workspace_dir: string;
  template_dir: string;
  token_path: string;
  schema_path: string;
  default_token_path: string;
  readme_path: string;
  schema: Record<string, unknown>;
  default_token: unknown;
  current_token: unknown | null;
  current_token_validation: AppWorkspaceThemeValidationResult | null;
  readme: string;
}

export interface ValidateAppWorkspaceThemeTokenInput {
  workspace_dir: string;
  token: unknown;
}

export interface RecordAppWorkspaceThemeTokenInput {
  workspace_dir: string;
  token?: unknown;
  use_default?: boolean;
}

export interface RecordAppWorkspaceThemeTokenResult {
  workspace: AppWorkspaceResult;
  workspace_dir: string;
  token_path: string;
  fallback_used: boolean;
  validation: AppWorkspaceThemeValidationResult;
  token: unknown;
}


export interface GetAppWorkspacePageFileFingerprintsInput {
  workspace_dir: string;
  slide_path: string;
  data_path: string;
}

export interface AppWorkspacePageFileFingerprint {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface GetAppWorkspacePageFileFingerprintsResult {
  workspace_dir: string;
  slide: AppWorkspacePageFileFingerprint;
  data: AppWorkspacePageFileFingerprint;
}

export interface AppPageProgressItem {
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

export type AppPageProgressRecoveryRunKind =
  | "deck-generation"
  | "page-generation-retry"
  | "page-refinement"
  | "deck-refinement"
  | "final-deck-render";

export type AppPageProgressRecoveryStatus =
  | "idle"
  | "running"
  | "interrupted"
  | "failed"
  | "completed";

export interface AppPageProgressRecoveryState {
  status: AppPageProgressRecoveryStatus;
  run_kind: AppPageProgressRecoveryRunKind | null;
  step: string | null;
  target_page_ids: string[];
  refinement_request: string | null;
  page_refinement_reasons: Record<string, string>;
  error: string | null;
  updated_at: string | null;
}

export interface PrepareAppPageRefinementInput {
  workspace_dir: string;
  page_id: string;
  refinement_request: string;
}

export interface PrepareAppPageRefinementResult {
  workspace_dir: string;
  page_id: string;
  progress: AppPageProgress;
}

export type AppDeckRefinementOperation =
  | { op: "keep"; page_id: string; reason: string }
  | { op: "update"; page_id: string; page_type: "cover" | "standard"; title: string; content: string; reason: string }
  | { op: "add"; page_type: "cover" | "standard"; title: string; content: string; reason: string }
  | { op: "delete"; page_id: string; reason: string };

export interface CommitAppDeckRefinementInput {
  workspace_dir: string;
  refinement_request: string;
  title: string;
  output_language_change: { changed: boolean; output_language?: string };
  style_guide_action: "preserve" | "regenerate";
  style_guide_staging_file_path?: string;
  style_guide_expected_size_bytes?: number;
  operations: AppDeckRefinementOperation[];
}

export interface CommitAppDeckRefinementResult {
  workspace_dir: string;
  outline: AppWorkspaceOutline;
  progress: AppPageProgress;
  target_page_ids: string[];
  added_page_ids: string[];
  deleted_page_ids: string[];
}

export type AppFinalDeckRenderStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export interface AppFinalDeckRenderState {
  status: AppFinalDeckRenderStatus;
  message: string | null;
  error: string | null;
  output_dir: string | null;
  deck_html_path: string | null;
  rendered_at: string | null;
  updated_at: string | null;
  source_fingerprint?: string | null;
}

export interface AppPageProgress {
  version: 1;
  status: string;
  recovery: AppPageProgressRecoveryState;
  final_deck_render: AppFinalDeckRenderState;
  research_discovery?: unknown;
  pages: AppPageProgressItem[];
  updated_at: string | null;
}

export interface GetAppPageProgressInput {
  workspace_dir: string;
}

export interface RecordAppPageProgressInput {
  workspace_dir: string;
  page_id?: string;
  patch: Record<string, unknown>;
}

export interface RenderAppWorkspacePagePreviewInput {
  workspace_dir: string;
  page_id: string;
}

export interface RenderAppWorkspacePagePreviewResult {
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

export interface RenderedAppWorkspacePagePreviewResult {
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

export interface AppManualPageRevisionManifest {
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

export interface GetAppPageEditContextInput {
  workspace_dir: string;
  page_id: string;
}

export interface GetAppPageEditContextResult {
  preview_source_fingerprint: string;
  workspace_dir: string;
  page_id: string;
  title: string;
  page_index: number;
  revision: number;
  manually_edited: boolean;
  html_path: string;
  html: string;
  screenshot_path: string;
  manifest: AppManualPageRevisionManifest | null;
  font_library: ManagedFontFamilySummary[];
  workspace_font_library: ManagedFontFamilySummary[];
  workspace_fonts: ManagedFontFamily[];
}

export interface SaveAppManualPageRevisionInput {
  workspace_dir: string;
  page_id: string;
  base_revision: number;
  staging_file_path: string;
  expected_size_bytes: number;
}

export interface SaveAppManualPageRevisionResult {
  preview_source_fingerprint: string;
  workspace_dir: string;
  page_id: string;
  manifest: AppManualPageRevisionManifest;
  final_deck_render_updated: boolean;
  final_deck_render_requires_rebuild: boolean;
  deck_html_path: string | null;
  rendered_at: string | null;
  page_progress_updated_at: string;
}

export interface RestoreAppPageSourceVersionInput {
  recovery_token?: string;
  workspace_dir: string;
  page_id: string;
}

export interface RestoreAppPageSourceVersionResult {
  page_progress?: AppPageProgress;
  manually_edited?: boolean;
  preview_source_fingerprint: string;
  workspace_dir: string;
  page_id: string;
  restored: true;
  html_path: string;
  screenshot_path: string;
  final_deck_render_updated: boolean;
  final_deck_render_requires_rebuild: boolean;
  deck_html_path: string | null;
  rendered_at: string | null;
  page_progress_updated_at: string;
}

export interface RecordAppWorkspaceStyleGuideInput {
  workspace_dir: string;
  staging_file_path: string;
  expected_size_bytes: number;
}

export interface RecordAppWorkspaceStyleGuideResult {
  workspace_dir: string;
  style_guide_path: string;
  size_bytes: number;
  sha256: string;
  updated_at: string;
}

export interface GetAppWorkspaceStyleGuideStatusInput {
  workspace_dir: string;
}

export interface GetAppWorkspacePersistentElementsStatusInput {
  workspace_dir: string;
}

export interface GetAppWorkspacePersistentElementsStatusResult {
  workspace_dir: string;
  persistent_elements_path: string;
  exists: boolean;
  non_empty: boolean;
  size_bytes: number;
  sha256?: string;
}

export interface GetAppWorkspaceStyleGuideStatusResult {
  workspace_dir: string;
  style_guide_path: string;
  exists: boolean;
  non_empty: boolean;
  size_bytes: number;
  sha256?: string;
}

export interface GetAppWorkspaceStyleGuideResult extends GetAppWorkspaceStyleGuideStatusResult {
  content: string;
}

export interface RecordAppVisualRhythmInput { workspace_dir: string; staging_file_path: string; expected_size_bytes: number; }
export interface RecordAppVisualRhythmResult { workspace_dir: string; visual_rhythm_path: string; size_bytes: number; sha256: string; updated_at: string; }
export interface GetAppVisualRhythmStatusInput { workspace_dir: string; }
export interface GetAppVisualRhythmStatusResult { workspace_dir: string; visual_rhythm_path: string; exists: boolean; non_empty: boolean; size_bytes: number; sha256?: string; }
export interface GetAppVisualRhythmResult extends GetAppVisualRhythmStatusResult { content: string; }
export interface RecordAppPageVisualPlanInput { workspace_dir: string; page_id: string; staging_file_path: string; expected_size_bytes: number; }
export interface RecordAppPageVisualPlanResult { workspace_dir: string; page_id: string; page_visual_plan_path: string; size_bytes: number; sha256: string; updated_at: string; }
export interface GetAppPageVisualPlanStatusInput { workspace_dir: string; page_id: string; }
export interface GetAppPageVisualPlanStatusResult { workspace_dir: string; page_id: string; page_visual_plan_path: string; exists: boolean; non_empty: boolean; size_bytes: number; sha256?: string; }
export interface GetAppPageVisualPlanResult extends GetAppPageVisualPlanStatusResult { content: string; }

export interface InitializeAppPageProgressInput {
  workspace_dir: string;
}

export interface AppWorkspacePageItem {
  page_id: string;
  index: number;
  title: string;
  layout_id: string;
  html_path: string;
  screenshot_path?: string;
  speaker_note: string;
}

export interface AppWorkspacePages {
  version: 1;
  status: "rendered";
  title: string;
  manifest_path: string;
  output_dir: string;
  rendered_at: string;
  pages: AppWorkspacePageItem[];
  source: {
    kind: "template-manifest";
  };
  updated_at: string;
}

export interface RenderAppWorkspaceDeckHtmlResult {
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
    screenshot_path: string;
    render_source_fingerprint?: string;
    preview_source_fingerprint: string;
    preview_version?: string;
    screenshot_url?: string;
    preview_url?: string;
    speaker_note: string;
    manually_edited?: boolean;
  }>;
  slide_count: number;
  title: string;
  rendered_at: string;
}

export interface SubmitAppWorkspaceDeckHtmlResult {
  status: "queued" | "running";
  already_queued: boolean;
  workspace_dir: string;
  manifest_path: string;
  output_dir: string;
  source_fingerprint: string;
  submitted_at: string;
}

export type AppPptxExportStatus =
  | "idle"
  | "queued"
  | "validating"
  | "converting"
  | "completed"
  | "failed";

export interface AppPptxExportJob {
  version: 2;
  job_id: string;
  status: AppPptxExportStatus;
  message: string;
  percent: number;
  /** One-based page currently being rendered in this export selection. */
  current_page: number | null;
  /** Number of pages selected for this export. */
  total_pages: number | null;
  /** Stable export stage for page-level progress reporting. */
  export_phase: "rendering" | "merging" | null;
  /** Selected one-based source pages; null means the complete deck. */
  page_numbers: number[] | null;
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
  /**
   * Font families the converter could not embed into the PPTX. Kept apart
   * from `warnings` because the user-facing meaning differs: these render
   * with a viewer substitute rather than a simulated weight.
   */
  font_embed_warnings: string[];
  warning_count: number;
}

export type AppExportArtifactPublishStatus =
  | "idle"
  | "queued"
  | "preparing"
  | "uploading"
  | "committing"
  | "completed"
  | "failed";

export interface AppExportArtifactPublishJob {
  version: 1;
  job_id: string;
  status: AppExportArtifactPublishStatus;
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
  artifact: AppExportArtifactInfo | null;
  mirror: AppExportArtifactMirror | null;
  error: {
    message: string;
    stack?: string;
    interrupted?: boolean;
  } | null;
}

export interface StartAppExportArtifactPublishInput {
  workspace_dir: string;
  artifact_type: "pptx" | "pdf";
}

export interface StartAppPptxExportInput {
  workspace_dir: string;
  page_numbers?: number[];
}

export interface ExportAppPdfInput {
  workspace_dir: string;
  /** Optional one-based source pages. Omit for the complete deck. */
  page_numbers?: number[];
}

export interface ExportAppPdfResult {
  workspace_dir: string;
  manifest_path: string;
  html_path: string;
  pdf_path: string;
  output_dir: string;
  exported_at: string;
}

export interface RecordAppPdfExportInput {
  workspace_dir: string;
  pdf_path: string;
}

export interface GetAppExportArtifactInput {
  workspace_dir: string;
  artifact_type: "pptx" | "pdf";
}

export interface AppExportArtifactMirror {
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

export interface AppExportArtifactInfo {
  workspace_dir: string;
  workspace_id: string;
  title: string;
  artifact_type: "pptx" | "pdf";
  path: string;
  filename: string;
  updated_at: string;
  mirror: AppExportArtifactMirror | null;
}

export interface AppExportArtifactSnapshot extends AppExportArtifactInfo {
  snapshot_path: string;
  source_sha256: string;
  size_bytes: number;
  content_type: string;
  mirror_path: string;
}

export interface CommitAppExportArtifactMirrorInput {
  workspace_dir: string;
  artifact_type: "pptx" | "pdf";
  expected_updated_at: string;
  expected_sha256: string;
  mirror: AppExportArtifactMirror;
}

export interface AppExportArtifactMirrorStatus {
  status: "ready" | "missing" | "stale";
  reason: "mirror_missing" | "artifact_version_changed" | "source_hash_changed" | null;
  artifact: AppExportArtifactInfo;
  mirror: AppExportArtifactMirror | null;
}

export interface PrepareAppWorkspaceDiagnosticBundleInput {
  workspace_dir: string;
}

export type AppBatchTestCaseStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type AppBatchTestRunStatus = "queued" | "running" | "completed" | "partial_failure" | "failed" | "cancelled";
export type AppBatchTestTargetStage =
  | "template-recommendation-completed"
  | "attachment-context-created"
  | "requirements-confirmed"
  | "research-routing-completed"
  | "page-refinement-classification-completed"
  | "web-research-completed"
  | "outline-confirmed"
  | "image-research-completed"
  | "pptx-exported";

export interface CreateAppBatchTestCaseInput {
  case_id: string;
  brief_id: string;
  brief: string;
  repetition: number;
  total_repetitions: number;
  attachments?: Array<{
    filename: string;
    mime_type: string;
    size_bytes: number;
    host_upload: { transport: "host_upload"; r2_key: string; url: string; mime_type: string; size_bytes: number; filename?: string; expires_at?: string; expires_in?: number; mode?: "negotiate+confirm" };
    expected_strategy?: "full_context" | "summarized_context";
    expected_notes?: string;
  }>;
  /** Confirmed Requirements fixture for an outline-only batch evaluation. */
  provided_requirements?: AppPresentationRequirements;
  research_routing?: {
    baseline_id: string;
    prompt_version: string;
    prompt: string;
    prompt_hash: string;
    git_commit: string;
    requested_model?: string | null;
    expected: { web: boolean; images: boolean };
  };
  page_refinement_classification?: {
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
  };
}

export interface CreateAppBatchTestRunInput {
  test_id?: string;
  target_stage: AppBatchTestTargetStage;
  cases: CreateAppBatchTestCaseInput[];
}

export interface AppBatchTestCaseRecord extends CreateAppBatchTestCaseInput {
  status: AppBatchTestCaseStatus;
  case_dir: string;
  workspace_dir: string;
  workspace_id: string;
  performance_dir: string;
  started_at: string | null;
  ended_at: string | null;
  error: string | null;
  pptx_path: string | null;
  token_usage?: PerformanceTokenUsageSummary | null;
  performance_metrics?: Array<{ operation_name: string; count: number; wall_clock_ms: number; total_duration_ms: number; input_tokens: number; output_tokens: number; total_tokens: number; calls: number }> | null;
  research_routing_result?: {
    actual: { web: boolean; images: boolean };
    requested_model: string | null;
    actual_model: string | null;
    latency_ms: number;
    token_usage: unknown;
    json_repair_count: number;
    retry_count: number;
    retry_reasons: Array<"invocation" | "json_format" | "schema">;
  } | null;
  page_refinement_classification_result?: {
    actual: {
      task_type: "exact_text_edit" | "content_rewrite" | "style_edit" | "layout_edit" | "web_research" | "image_research" | "mixed" | "unclear";
      execution_scope: "local" | "regenerate" | "uncertain";
      web_research: boolean;
      image_research: boolean;
      reason: string;
    };
    requested_model: string | null;
    actual_model: string | null;
    latency_ms: number;
    token_usage: unknown;
    json_repair_count: number;
    retry_count: number;
    retry_reasons: Array<"invocation" | "json_format" | "schema">;
  } | null;
  template_recommendation_result?: {
    preset: { id: string; version: number; name: string; description: string };
    trace: unknown;
  } | null;
}

export interface AppBatchTestRunRecord {
  version: 1;
  test_id: string;
  target_stage: AppBatchTestTargetStage;
  status: AppBatchTestRunStatus;
  root_dir: string;
  manifest_path: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string;
  cases: AppBatchTestCaseRecord[];
  performance_metrics?: Array<{ operation_name: string; count: number; wall_clock_ms: number; total_duration_ms: number; input_tokens: number; output_tokens: number; total_tokens: number; calls: number }> | null;
}

export interface ListAppBatchTestRunsResult {
  root_dir: string;
  runs: AppBatchTestRunRecord[];
}

export interface DeleteAppBatchTestRunResult {
  deleted: true;
  test_id: string;
  root_dir: string;
}

export interface CreateAppBatchTestRunResult {
  run: AppBatchTestRunRecord;
}

export interface UpdateAppBatchTestCaseInput {
  root_dir: string;
  case_id: string;
  status: AppBatchTestCaseStatus;
  error?: string | null;
  pptx_path?: string | null;
  token_usage?: PerformanceTokenUsageSummary | null;
  performance_metrics?: Array<{ operation_name: string; count: number; wall_clock_ms: number; total_duration_ms: number; input_tokens: number; output_tokens: number; total_tokens: number; calls: number }> | null;
  research_routing_result?: AppBatchTestCaseRecord["research_routing_result"];
  page_refinement_classification_result?: AppBatchTestCaseRecord["page_refinement_classification_result"];
  template_recommendation_result?: AppBatchTestCaseRecord["template_recommendation_result"];
}

export interface UpdateAppBatchTestRunInput {
  root_dir: string;
  status: AppBatchTestRunStatus;
  performance_metrics?: AppBatchTestRunRecord["performance_metrics"];
}

export interface MaterializeAppPerformanceRunInput {
  run_id: string;
  destination_dir: string;
}

export interface MaterializeAppPerformanceRunResult {
  run_id: string;
  destination_dir: string;
  files: string[];
}

export interface PrepareAppBatchTestBundleInput {
  root_dir: string;
}

export interface AppBatchTestBundleSnapshot {
  root_dir: string;
  test_id: string;
  archive_path: string;
  filename: string;
  size_bytes: number;
  content_type: "application/zip";
  aps_path: string;
  created_at: string;
}

export interface AppWorkspaceDiagnosticBundleSnapshot {
  workspace_dir: string;
  workspace_id: string;
  archive_path: string;
  filename: string;
  size_bytes: number;
  content_type: "application/zip";
  aps_path: string;
  created_at: string;
}
