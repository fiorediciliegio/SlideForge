import type { OutlineDetail, Slide } from "../../data/mockDeck";
import type {
  ListWorkspacesResult,
  PageProgress,
  PptEngineRuntimeInfo,
  PptAgentResourceInfo,
  GetStyleProfileResult,
  GetStyleProfilePreviewResult,
  StyleProfileIndexEntry,
  RenderDeckHtmlResult,
  TemplateSummary,
  UploadedSourceMaterial,
  UploadedSourcePreflightResult,
  PresentationRequirements,
  WorkspaceStyleProfileSelection,
  WorkspaceResult,
  WorkspaceSettings
  , PerformanceRunSummary, PerformanceRunListItem
  , WorkspaceSnapshotSyncState
  , GetWorkspaceSnapshotInfoResult
  , ListMyWorkEntry
} from "../../api/types";
import type {
  DeckGenerationProgress,
  DeckGenerationStreamSnapshot
} from "../deck-generation";
import type { ActiveGenerationRun, GenerationViewState } from "./generationViewState";
import type { WorkspaceCovers } from "./workspaceCovers";
import type { GenerationPagePreviews } from "./generationPagePreviews";
import type { BatchTestingState } from "../batch-testing/types";
import type { WebResearchLabState } from "../web-research-lab/types";

export type MainStage = "brief" | "requirements" | "web-research" | "uploaded-source-analysis" | "outline" | "generating" | "deck";
export type PageId = "main" | "my-work" | "my-templates" | "batch-testing" | "web-research-lab" | "settings" | "performance-report" | "review" | "refine" | "export" | "style-profile-creation";
export type PanelMode = "visible" | "minimized" | "closed";
export type RefineScope = "deck" | "slide";
export type PreviewMode = "grid" | "organize" | "present";
export type WebResearchStatus = "idle" | "preparing" | "running" | "completed" | "error";
export type LoadingKind =
  | "none"
  | "template"
  | "requirements"
  | "webResearch"
  | "theme"
  | "uploadedSourceAnalysis"
  | "deck"
  | "outline"
  | "outlineRewrite"
  | "deckFromOutline"
  | "upload"
  | "review"
  | "refineDeck"
  | "refineSlide"
  | "export";

export interface DeckReviewRenderState {
  status: "idle" | "loading" | "ready" | "error";
  result: RenderDeckHtmlResult | null;
  error: string;
  renderKey: string;
}

export interface ExportArtifact {
  type: "PPTX" | "PDF";
  path: string;
  fileName?: string;
  updatedAt: string;
  mirrorStatus: "ready" | "missing" | "stale";
  /** APS Files location of the mirror, so the Host can serve it by path. */
  mirrorPath?: string;
  mirrorScope?: string;
}

export interface DownloadLinkState {
  status: "idle" | "preparing" | "ready" | "error";
  message: string;
  href?: string;
  expiresAt?: string | null;
}

export type ExportDownloadState = DownloadLinkState;

export interface ConfirmationDialogRequest {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  closeLabel: string;
  tone: "default" | "warning" | "danger";
  dismissible?: boolean;
}

export type CloudConflictDialogStatus = "conflict_resolved" | "conflict_blocked";

export interface CloudConflictDialogState {
  status: CloudConflictDialogStatus;
  workspaceId: string;
  /** The copy Workspace title, e.g. `<name>(本地副本-<ts>)`, when resolved. */
  backupTitle: string | null;
}

export interface WorkspaceDiagnosticBundleState extends DownloadLinkState {
  workspaceId?: string;
  filename?: string;
  sizeBytes?: number;
  /** ADR-0025: lets the Host save the ZIP without this App handling a signed URL. */
  mirrorPath?: string;
  mirrorScope?: string;
}

export interface PerformanceTestingState {
  enabled: boolean;
  supported: boolean;
  loading: boolean;
  busy: boolean;
  error: string;
  activeRun: PerformanceRunListItem | null;
  runs: PerformanceRunListItem[];
  reportHtml: string;
  reportRunId: string | null;
}

export interface AgentResourceInfoState {
  enabled: boolean;
  loading: boolean;
  error: string;
  info: PptAgentResourceInfo | null;
}

export interface ExportProgressState {
  type: "PPTX" | "PDF" | null;
  mode: "idle" | "determinate" | "indeterminate" | "complete" | "error";
  message: string;
  percent: number;
  active: boolean;
}

export interface ContextRow {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  type?: "text" | "select" | "attachment";
  options?: string[];
  allowCustomValue?: boolean;
}

export interface AttachmentPreparationState {
  phase:
    | "idle"
    | "preflight"
    | "reading"
    | "analyzing"
    | "requirements"
    | "detecting-language"
    | "generating-requirements"
    | "selecting-style"
    | "research-routing";
  filename: string;
  sourceIndex: number;
  sourceCount: number;
  chunkIndex?: number;
  chunkCount?: number;
  insight: string;
  ocrProgress?: {
    processed: number;
    total: number;
    currentPage: number | null;
  };
  /** Per-file progress keeps mixed image and document preparation visible together. */
  sourceStates?: Array<{
    filename: string;
    kind: "image" | "document";
    phase: Exclude<AttachmentPreparationState["phase"], "idle"> | "completed";
  }>;
}

export interface DeckWorkspaceState {
  userTemplates: ReturnType<typeof import("../user-templates/useUserTemplates").useUserTemplates>;
  panelMode: PanelMode;
  page: PageId;
  stage: MainStage;
  toast: string;
  prompt: string;
  globalSettings: WorkspaceSettings;
  contextRows: ContextRow[];
  selectedAspectRatio: import("../../slideFormat").SlideAspectRatio;
  presentationRequirements: PresentationRequirements;
  requirementsProgress: import("../process-progress/model").ProcessStep[];
  outlineCreationProgress: import("../process-progress/model").ProcessStep[];
  requirementsStatus: "idle" | "loading" | "ready" | "error";
  requirementsError: string;
  requirementsErrorDetail: string;
  requirementsSaving: boolean;
  requirementsConfirming: boolean;
  requirementsDirty: boolean;
  requirementsHasSavedDraft: boolean;
  webResearchStatus: WebResearchStatus;
  webResearchProgress: DeckGenerationProgress | null;
  webResearchError: string;
  webResearchErrorDetail: string;
  deckTitle: string;
  deck: Slide[];
  outline: OutlineDetail[];
  outlineDraft: OutlineDetail[];
  outlineDraftTitle: string;
  outlineDraftRequirements: string;
  outlineFeedback: string;
  outlineDirty: boolean;
  outlineSaving: boolean;
  outlineError: string;
  outlineErrorDetail: string;
  generated: boolean;
  currentSlide: number;
  previewMode: PreviewMode;
  reviewRender: DeckReviewRenderState;
  createDeckProgress: DeckGenerationProgress | null;
  uploadedSourceAnalysisProgress: UploadedSourceAnalysisProgress;
  generationHistory: GenerationStreamSnapshot[];
  pageProgress: PageProgress | null;
  refineScope: RefineScope;
  loading: LoadingKind;
  activeGenerationRun: ActiveGenerationRun | null;
  generationViewState: GenerationViewState;
  /** GEN-006: one preview image per page that already rendered during the run. */
  generationPagePreviews: GenerationPagePreviews;
  generationPreviewWorkspaceDir: string;
  pinnedGenerationPreviewPageId: string | null;
  exportProgress: ExportProgressState;
  exportArtifact: ExportArtifact | null;
  exportDownload: ExportDownloadState;
  templateDiagnosticMode: boolean;
  workspaceDiagnosticBundleEnabled: boolean;
  workspaceDiagnosticBundle: WorkspaceDiagnosticBundleState;
  performanceTesting: PerformanceTestingState;
  batchTesting: BatchTestingState;
  webResearchLab: WebResearchLabState;
  currentStatus: string;
  workspaceScan: ListWorkspacesResult | null;
  openingWorkspaceDir: string | null;
  /** WORK-005: the freshly created copy, so My Works can point the user at it. */
  highlightedWorkspaceId: string | null;
  currentWorkspace: WorkspaceResult | null;
  uploadedSources: UploadedSourceMaterial[];
  uploadedSourcePreflights: UploadedSourcePreflightResult[];
  uploadedSourcePreflightRunning: boolean;
  uploadedSourceAnalysisState: UploadedSourceAnalysisViewState;
  workspaceLoading: boolean;
  workspaceError: string;
  workspaceErrorDetail: string;
  workspaceSettingsSaving: boolean;
  runtimeInfo: PptEngineRuntimeInfo | null;
  runtimeInfoError: string;
  agentResourceInfo: AgentResourceInfoState;
  templateGroups: TemplateSummary[];
  selectedVisualStylePresetId: string | null;
  selectedTemplateGroupId: string | null;
  styleProfiles: StyleProfileIndexEntry[];
  styleProfilePreviews: Record<string, GetStyleProfilePreviewResult | undefined>;
  selectedStyleProfile: WorkspaceStyleProfileSelection | null;
  styleProfileLibraryLoading: boolean;
  styleProfileLibraryError: string;
  styleProfileCreation: StyleProfileCreationViewState;
  styleProfileDetail: StyleProfileDetailState;
  confirmationDialog: ConfirmationDialogRequest | null;
  /** Per-workspace cloud snapshot sync state, keyed by workspace_id. */
  workspaceSyncStates: Record<string, WorkspaceSnapshotSyncState | null>;
  /** Workspaces that have a published snapshot in APS (listMyWork). */
  cloudWorkspaces: ListMyWorkEntry[];
  workspaceSnapshotInfo: GetWorkspaceSnapshotInfoResult | null;
  workspaceSnapshotSyncState: WorkspaceSnapshotSyncState | null;
  cloudConflictDialog: CloudConflictDialogState | null;
}

export type { WorkspaceSettings };

export type GenerationStreamSnapshot = DeckGenerationStreamSnapshot;

export type UploadedSourceAnalysisViewStatus =
  | "hidden"
  | "pending"
  | "stale"
  | "analyzing"
  | "ready"
  | "gap"
  | "blocked"
  | "error";

export interface UploadedSourceAnalysisViewState {
  status: UploadedSourceAnalysisViewStatus;
  sourceCount: number;
  factCount: number | null;
  visualAssetCount: number | null;
  gapCount: number | null;
  reason?: string;
}

export type UploadedSourceAnalysisRunStatus =
  | "idle"
  | "skipped"
  | "running"
  | "completed"
  | "blocked"
  | "failed";

export type UploadedSourceAnalysisRecordId = "prepare" | "factual" | "visual" | "merge";

export type UploadedSourceAnalysisRecordState =
  | "pending"
  | "active"
  | "completed"
  | "skipped"
  | "failed";

export interface UploadedSourceAnalysisRecord {
  id: UploadedSourceAnalysisRecordId;
  label: string;
  state: UploadedSourceAnalysisRecordState;
  activities: string[];
  lines: string[];
  summaryLines: string[];
  error?: string;
  started_at?: string;
  updated_at?: string;
}

export interface UploadedSourceAnalysisResultSummary {
  status: "ready" | "gap" | "blocked";
  factCount: number;
  visualAssetCount: number;
  gapCount: number;
  rejectedCount: number;
  reason: string;
}

export interface UploadedSourceAnalysisProgress {
  status: UploadedSourceAnalysisRunStatus;
  sourceCount: number;
  message: string;
  records: UploadedSourceAnalysisRecord[];
  resultSummary?: UploadedSourceAnalysisResultSummary;
}

export type StyleProfileCreationRunStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export type StyleProfileCreationStageId = "prepare" | "analyze" | "publish";

export interface StyleProfileCreationStageRecord {
  id: StyleProfileCreationStageId;
  label: string;
  state: "pending" | "active" | "completed" | "failed" | "stopped";
  summaryLines: string[];
  activities: string[];
  lines: string[];
  error?: string;
}

export interface StyleProfileCreationViewState {
  status: StyleProfileCreationRunStatus;
  displayName: string;
  files: File[];
  creationId: string;
  canRetryAnalysis: boolean;
  message: string;
  stages: StyleProfileCreationStageRecord[];
  createdStyleProfileId: string;
  error: string;
}

export interface StyleProfileDetailState {
  status: "closed" | "loading" | "ready" | "error";
  styleProfileId: string;
  detail: GetStyleProfileResult | null;
  error: string;
}
