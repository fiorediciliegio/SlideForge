import { useTemplateDiagnosticBundle } from "../../user-templates/useTemplateDiagnosticBundle";
import { normalizeSlideAspectRatio, type SlideAspectRatio } from "../../../slideFormat";
import { useProcessProgress } from "../../process-progress/useProcessProgress";
import { attachmentPreparationInsight, attachmentPreparationLabel } from "../../requirements/attachmentPreparationProgress";
import { createImageAttachmentBriefClient, type ImageAttachmentBriefClient } from "../../../ai/imageAttachmentBriefTest";
import { assignOutlineImages } from "../../outline/imageAssignment";
import { availableOutlineImages, type OutlineImageAsset } from "../../outline/images";
import { createOutlineImageLibraryService, type OutlineImageLibraryService } from "../../outline/imageLibrary";
import { isMainWorkflowAttachmentSource } from "../../../ai/attachmentBriefPolicy";
import { createPageImageSearchService, type PageImageSearchService } from "../../page-image-search/service";
import { usePageRegeneration } from "../../page-regeneration/usePageRegeneration";
import { createPageImageUploadService, type PageImageUploadService } from "../../page-image-upload/service";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import appManifest from "../../../../src/appMeta";
import { createAgentClient, type AgentClient } from "../../../agent/agentClient";
import { resolveAgentToolAccessPolicy } from "../../../agent/agentToolAccessPolicy";
import { createAiClient, type AiAttemptLog, type AiClient, type LlmContextRow } from "../../../ai/aiClient";
import { formatWebResearchRequirements } from "../../../ai/requirementsFormatting";
import {
  createAttachmentBriefCompletionClient,
  type AttachmentBriefCompletionClient,
} from "../../../ai/attachmentBriefCompletion";
import { createResearchAiClient, type ResearchAiClient } from "../../../ai/researchAiClient";
import { createPageRefinementClassifier, type PageRefinementClassifier } from "../../../ai/pageRefinementClassifier";
import {
  createAiInteractionLogger,
  type AiOperationLogContext,
} from "../../../ai/interactionLog";
import { createPptBackend, toPerfReportLocale, type PptBackend } from "../../../api/pptBackend";
import { createResearchWebClient, type ResearchWebClient } from "../../../api/researchWebClient";
import { startBrowserDownload } from "../browserDownload";
import { hasActiveDownloadUrl } from "../downloadUrl";
import { connectHostRuntime } from "../../../runtime/hostRuntime";
import {
  createAppHostFileDownloadClient,
  type AppHostFileDownloadClient,
} from "../../../runtime/appHostFileDownload";
import {
  createAppHostUploadClient,
  type AppHostUploadClient,
} from "../../../runtime/appHostUploadClient";
import type {
  ListWorkspacesResult,
  RenderDeckHtmlResult,
  PageProgress,
  PresentationRequirements,
  PresentationRequirementsSelections,
  PresentationResearchRequirements,
  PptEngineRuntimeInfo,
  RestorePageSourceVersionResult,
  SaveManualPageRevisionResult,
  GetStyleProfilePreviewResult,
  PptxExportJob,
  ExportArtifactPublishJob,
  StyleProfileIndexEntry,
  TemplateSummary,
  UploadedSourceAnalysisDependency,
  UploadedSourceIndex,
  UploadedSourceMaterial,
  UploadedSourcePreflightResult,
  AttachmentContext,
  WorkspaceResult,
  WorkspaceSummary,
  WorkspaceOutline,
  WorkspaceOutlineItem,
  WorkspacePageItem,
  WorkspaceSnapshotSyncState,
  GetWorkspaceSnapshotInfoResult,
  ListMyWorkEntry,
  WorkspacePages,
  WorkspaceStyleProfileSelection,
  WorkspaceSettings,
  GenerationRunTransaction,
  PerformanceRunSummary, PerformanceRunListItem,
  BatchTestCaseRecord,
} from "../../../api/types";
import {
  createLocalProjectDeck,
  initialDeck,
  outlineDetails,
  type OutlineDetail,
  type Slide
} from "../../../data/mockDeck";
import { formatMessage, type Locale, type Messages } from "../../../i18n/messages";
import { pickLocale } from "../../../i18n/locales";
import {
  deckReadyStatus,
  hasDownstreamArtifacts,
  isWorkspaceDeckStale,
} from "../utils";
import {
  normalizeSlideCountContextValue,
  SLIDE_COUNT_CONTEXT_OPTIONS,
} from "../contextSuggestion";
import {
  createDeckGenerationStreamSnapshot,
  runDeckGeneration,
  runDeckRefinement,
  runParallelSharedResearch,
  runPageGenerationRetry,
  type DeckGenerationCompletion,
  type DeckGenerationError,
  type DeckGenerationProgress,
} from "../../deck-generation";
import { ensureWorkspaceThemeToken as generateWorkspaceThemeToken } from "../../deck-generation/themeTokenWorkflow";
import {
  AttachmentPreflightBlockedError,
  ensureAttachmentBriefs,
  type AttachmentBriefProgress,
} from "../../deck-generation/attachmentBriefWorkflow";
import {
  ensureFreshUploadedSourceAnalysis,
  type UploadedSourceAnalysisWorkflowEvent,
} from "../../deck-generation/uploadedSourceAnalysisWorkflow";
import {
  compactUploadedSourceAnalysisForPrompt,
  createUploadedSourceAnalysisDependency,
  renderUploadedSourceAnalysisMarkdown,
  uploadedSourceAnalysisMatchesActiveSet,
  uploadedSourceDependencyMatchesAnalysis,
  type UploadedSourceAnalysis,
} from "../../deck-generation/uploadedSourceAnalysis";
import {
  createStyleProfile,
  isStyleProfileCreationCancelledError,
  type CreateStyleProfileWorkflowEvent,
} from "../../deck-generation/styleProfileWorkflow";
import { reconcileInterruptedPageProgress } from "../../deck-generation/interruptedReconciliation";
import { waitForFinalDeckRender } from "../../deck-generation/renderPolling";
import {
  createArtifactExportProgress,
  createExportDownloadPreparingProgress,
  createExportErrorProgress,
  createExportStartProgress,
  createIdleExportProgress,
  createPptxJobExportProgress,
  createExportArtifactPublishProgress,
} from "../exportProgressDisplay";
import {
  completedDeckIsAvailable,
  normalizeWorkspacePageProgress,
  restoreDeckGenerationProgress,
} from "../workspaceRecovery";
import { resolveRefineSlideIndex } from "../refineNavigation";
import {
  cloneOutlineItems,
  normalizeValidOutline,
  outlinesEqual,
  type EditableOutline,
} from "../../outline";
import { createWorkspaceReviewRenderKey } from "../workspaceReviewRenderKey";
import { createInitialWorkspaceSnapshot } from "../createdWorkspace";
import {
  mapWithConcurrencyLimit,
  WORKSPACE_COVER_CONCURRENCY,
} from "../workspaceCovers";
import {
  createRunGenerationPagePreviews,
  reconcileGenerationPagePreviews,
  releaseAwaitingGenerationPagePreviews,
  selectGenerationPagePreviewSources,
  type GenerationPagePreviews,
} from "../generationPagePreviews";
import { assembleReviewRender } from "../reviewRenderAssembly";
import { reconcileReviewRender, withOutlineTitles } from "../reviewRenderReconciliation";
import { resolveGenerationAbandonLanding } from "../generationAbandonLanding";
import { resolveDeckBackStage } from "../stageBackNavigation";
import { publishMyWorkTiming } from "../myWorkTiming";
import { loadMyWork } from "../loadMyWork";
import { invokeTimeoutSummary, isInvokeTimeout, summarizeUserFacingError } from "../userFacingError";
import type {
  ContextRow,
  ConfirmationDialogRequest,
  DeckReviewRenderState,
  DeckWorkspaceState,
  ExportProgressState,
  ExportArtifact,
  ExportDownloadState,
  WorkspaceDiagnosticBundleState,
  GenerationStreamSnapshot,
  LoadingKind,
  MainStage,
  PageId,
  PanelMode,
  PreviewMode,
  RefineScope,
  UploadedSourceAnalysisProgress,
  WebResearchStatus,
  StyleProfileCreationStageRecord,
  StyleProfileCreationViewState,
  StyleProfileDetailState,
  UploadedSourceAnalysisViewState,
  AttachmentPreparationState,
  CloudConflictDialogState
} from "../types";

import {
  buildGenerationViewState,
  type ActiveGenerationRun,
  type ActiveGenerationRunKind,
} from "../generationViewState";
import { generationInFlight, preparationInFlight } from "../generationNavigationGuard";
import { createOperationScopedProgressHandler } from "../generationProgressGuard";
import { isSelectableTemplateGroup } from "../templateSelectionPolicy";
import {
  applyUploadedSourceAnalysisWorkflowEvent,
  createCompletedUploadedSourceAnalysisProgress,
  createSkippedUploadedSourceAnalysisProgress,
  createUploadedSourceAnalysisProgress,
  failUploadedSourceAnalysisProgress,
} from "../uploadedSourceAnalysisProgress";
import {
  confirmedRequirementsAllowOutline,
  createEmptyPresentationRequirements,
  createManualRequirementsDraft,
  applyImageResearchFlag,
  createRequirementsDraft,
  requirementsOwnedRecoveryStage,
  requirementsAreComplete,
  requirementsAreCompleteWithoutVisualSelection,
  requiresTemplateRecommendationChoice,
} from "../../requirements";
import {
  findVisualStylePreset as findBuiltInVisualStylePreset,
  loadVisualStylePresetReferenceHtmlPages,
  toVisualStylePresetSelection,
  VISUAL_STYLE_PRESETS,
} from "../../templates/visualStylePresets";
import {
  recommendVisualStylePresetWithIntent,
} from "../../templates/visualStylePresetRecommendation";
import { useUserTemplates } from "../../user-templates/useUserTemplates";
import { beginPerformanceSpan, installPerformanceButtonCollector } from "../../../performance/performanceRecorder";
import { runBatchTestWorkflow } from "../../batch-testing/workflow";
import {
  createIdleBatchTestCaseDetail,
  createIdleBatchTestingState,
  type BatchTestInput,
} from "../../batch-testing/types";
import {
  runWebResearchLab as executeWebResearchLab,
  type WebResearchLabEvent,
} from "../../web-research-lab/webResearchLabWorkflow";
import type { WebResearchLabState } from "../../web-research-lab/types";
import {
  WEB_RESEARCH_AGENT_MODEL,
  WEB_RESEARCH_AGENT_SYSTEM_PROMPT,
} from "../../../ai/webResearchAgent";

const DEFAULT_TEMPLATE_GROUP_ID = "red-finance-canvas";
const AGENT_TOOL_ACCESS_POLICY = resolveAgentToolAccessPolicy(
  import.meta.env.VITE_AGENT_TOOL_ACCESS_POLICY,
  { warn: (message) => console.warn(message) },
);
const AGENT_CANCELLATION_WAIT_MS = 3_000;
// C-line (uploaded-source analysis) runs on the blocking path before the
// outline. Bound its cost so the pre-outline wait can't stall for the shared
// ~30-min worst case: a smaller per-draft repair budget than the shared
// LOCAL_GATE_REPAIR_LIMIT, plus an overall wall-clock deadline after which we
// cancel the C-line agent and generate the outline without attachment context.
const UPLOADED_SOURCE_ANALYSIS_REPAIR_LIMIT = 2;
const UPLOADED_SOURCE_ANALYSIS_DEADLINE_MS = 360_000;
const PERFORMANCE_TESTING_ENABLED = import.meta.env.VITE_PERFORMANCE_TESTING_ENABLED === "true";
const AGENT_RESOURCE_INFO_ENABLED = import.meta.env.VITE_AGENT_RESOURCE_INFO_ENABLED === "true";
const BATCH_TESTING_ENABLED = import.meta.env.VITE_BATCH_TESTING_ENABLED === "true";
const WEB_RESEARCH_LAB_ENABLED = import.meta.env.VITE_WEB_RESEARCH_LAB_ENABLED === "true";
const WORKSPACE_DIAGNOSTIC_BUNDLE_ENABLED = import.meta.env.VITE_WORKSPACE_DIAGNOSTIC_BUNDLE_ENABLED === "true";
const STOP_AFTER_IMAGE_RESEARCH = import.meta.env.VITE_STOP_AFTER_IMAGE_RESEARCH === "true";
const MY_WORK_SYNC_POLL_INTERVAL_MS = 10_000;
// Reopening My Work is common and the cloud listing walks every Workspace, so a
// visit that follows a recent listing is served from the one already on screen.
const MY_WORK_CLOUD_LIST_TTL_MS = 60_000;

async function measurePerformanceOperation<T>(operationName: string, workspaceDir: string, task: () => Promise<T>): Promise<T> {
  const span = beginPerformanceSpan({
    operationName,
    workspaceId: workspaceDir.split(/[\\/]/).filter(Boolean).at(-1),
    attributes: { layer: "workflow" },
  });
  try {
    const result = await task();
    span?.finish("ok");
    return result;
  } catch (error) {
    span?.finish("error");
    throw error;
  }
}

async function assembleMeasuredReviewRender(input: Parameters<typeof assembleReviewRender>[0]) {
  const span = beginPerformanceSpan({
    operationName: "review.preview_handoff",
    workspaceId: input.workspaceDir.split(/[\\/]/).filter(Boolean).at(-1),
    attributes: {
      layer: "review-assembly",
      page_count: input.metadata.slide_count,
    },
  });
  try {
    const assembled = await assembleReviewRender(input);
    span?.finish("ok", {
      cache_hit_page_count:
        input.metadata.slide_count - assembled.fetchedPageIds.length - assembled.failedPageIds.length,
      uploaded_page_count: assembled.fetchedPageIds.length,
      failed_page_count: assembled.failedPageIds.length,
    });
    return assembled;
  } catch (error) {
    span?.finish("error");
    throw error;
  }
}

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

function formatWorkspaceDate(date = new Date()) {
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate())
  ].join("-");
}

function clampSlideIndex(index: number, slideCount: number) {
  const maxIndex = Math.max(0, slideCount - 1);
  return Math.min(Math.max(0, index), maxIndex);
}

function uploadedSourceDependencyMatchesActiveSources(input: {
  dependency?: UploadedSourceAnalysisDependency;
  uploadedSources: UploadedSourceMaterial[];
}) {
  const { dependency, uploadedSources } = input;
  if (!dependency) return false;
  if (dependency.active_uploaded_sources.length !== uploadedSources.length) return false;
  const dependencyById = new Map(
    dependency.active_uploaded_sources.map((source) => [source.uploaded_source_id, source])
  );
  return uploadedSources.every((source) => {
    const dependencySource = dependencyById.get(source.uploaded_source_id);
    return dependencySource !== undefined &&
      dependencySource.sha256 === source.sha256 &&
      dependencySource.size_bytes === source.size_bytes;
  });
}

function readWorkspaceUploadedSourceDependency(
  workspace: WorkspaceResult | null,
): UploadedSourceAnalysisDependency | undefined {
  void workspace;
  return undefined;
}

function createEmptyUploadedSourceAnalysisViewState(): UploadedSourceAnalysisViewState {
  return {
    status: "hidden",
    sourceCount: 0,
    factCount: null,
    visualAssetCount: null,
    gapCount: null,
  };
}

function defaultStyleProfileName(date = new Date()) {
  return `风格画像-${formatWorkspaceDate(date)}`;
}

function createStyleProfileCreationStages(): StyleProfileCreationStageRecord[] {
  return [
    { id: "prepare", label: "准备参考资料", state: "pending", summaryLines: [], activities: [], lines: [] },
    { id: "analyze", label: "分析视觉风格", state: "pending", summaryLines: [], activities: [], lines: [] },
    { id: "publish", label: "发布风格画像", state: "pending", summaryLines: [], activities: [], lines: [] },
  ];
}

function createIdleStyleProfileCreationState(): StyleProfileCreationViewState {
  return {
    status: "idle",
    displayName: defaultStyleProfileName(),
    files: [],
    creationId: "",
    canRetryAnalysis: false,
    message: "上传 PPTX 或图片参考资料后开始分析。",
    stages: createStyleProfileCreationStages(),
    createdStyleProfileId: "",
    error: "",
  };
}

function updateStyleProfileStage(
  stages: StyleProfileCreationStageRecord[],
  id: StyleProfileCreationStageRecord["id"],
  patch: Partial<StyleProfileCreationStageRecord>,
) {
  return stages.map((stage) => stage.id === id ? { ...stage, ...patch } : stage);
}

function appendBounded(items: string[], value: string, limit: number) {
  const trimmed = value.trim();
  if (!trimmed) return items;
  return [...items, trimmed].slice(-limit);
}

function appendStreamText(lines: string[], text: string) {
  if (!text) return lines;
  const current = lines.length > 0 ? lines.slice() : [""];
  const parts = text.split(/\r?\n/);
  current[current.length - 1] = `${current[current.length - 1]}${parts[0] ?? ""}`;
  for (const part of parts.slice(1)) current.push(part);
  return current.slice(-80);
}

function applyStyleProfileCreationEvent(
  current: StyleProfileCreationViewState,
  event: CreateStyleProfileWorkflowEvent,
): StyleProfileCreationViewState {
  if (event.type === "creation-prepared") {
    return {
      ...current,
      creationId: event.creationId,
      displayName: event.displayName,
    };
  }
  if (event.type === "phase-start") {
    return {
      ...current,
      message: event.message,
      stages: updateStyleProfileStage(current.stages, event.phase, {
        state: "active",
        error: "",
        summaryLines: appendBounded(
          current.stages.find((stage) => stage.id === event.phase)?.summaryLines ?? [],
          event.message,
          6,
        ),
      }),
    };
  }
  if (event.type === "phase-complete") {
    return {
      ...current,
      message: event.message,
      stages: updateStyleProfileStage(current.stages, event.phase, {
        state: "completed",
        summaryLines: appendBounded(
          current.stages.find((stage) => stage.id === event.phase)?.summaryLines ?? [],
          event.message,
          6,
        ),
      }),
    };
  }
  if (event.type === "phase-error") {
    return {
      ...current,
      status: "failed",
      canRetryAnalysis: event.phase === "analyze" || event.phase === "publish",
      message: event.message,
      error: event.message,
      stages: updateStyleProfileStage(current.stages, event.phase, {
        state: "failed",
        error: event.message,
      }),
    };
  }
  if (event.type === "attempt") {
    const analyze = current.stages.find((stage) => stage.id === "analyze");
    return {
      ...current,
      message: event.message,
      stages: updateStyleProfileStage(current.stages, "analyze", {
        state: "active",
        activities: appendBounded(analyze?.activities ?? [], `${event.message}（第 ${event.attempt} 次）`, 20),
      }),
    };
  }
  const analyze = current.stages.find((stage) => stage.id === "analyze");
  if (event.event.type === "content") {
    return {
      ...current,
      stages: updateStyleProfileStage(current.stages, "analyze", {
        lines: appendStreamText(analyze?.lines ?? [], event.event.text),
      }),
    };
  }
  if (event.event.type === "activity") {
    return {
      ...current,
      stages: updateStyleProfileStage(current.stages, "analyze", {
        activities: appendBounded(analyze?.activities ?? [], event.event.message, 20),
      }),
    };
  }
  if (event.event.type === "error") {
    return {
      ...current,
      stages: updateStyleProfileStage(current.stages, "analyze", {
        activities: appendBounded(analyze?.activities ?? [], event.event.message, 20),
      }),
    };
  }
  return {
    ...current,
    stages: updateStyleProfileStage(current.stages, "analyze", {
      activities: appendBounded(analyze?.activities ?? [], "Agent run completed", 20),
    }),
  };
}

export interface DeckWorkspaceActions {
  pageImageSearch: PageImageSearchService | null;
  pageImageUpload: PageImageUploadService | null;
  imageLibrary: OutlineImageLibraryService | null;
  loadOutlineImages: () => Promise<OutlineImageAsset[]>;
  loadOutlineImagePreview: (assetId: string, size?: "thumbnail" | "large") => Promise<string>;
  setPanelMode: (mode: PanelMode) => void;
  setPrompt: (value: string) => void;
  setDeckTitle: (value: string) => void;
  setCurrentSlide: (index: number) => void;
  setOutlineFeedback: (value: string) => void;
  setPreviewMode: (mode: PreviewMode) => void;
  setRefineScope: (scope: RefineScope) => void;
  showToast: (message: string) => void;
  cancelGenerateDeck: (options?: { landOnMyWork?: boolean }) => Promise<void>;
  navigate: (page: PageId) => Promise<void>;
  navigateFromHeader: (page: PageId) => Promise<void>;
  goHomeFromHeader: () => Promise<void>;
  navigateMain: (stage: MainStage) => Promise<void>;
  goBack: () => Promise<void>;
  openBatchTesting: () => Promise<void>;
  exitBatchTesting: () => Promise<void>;
  openWebResearchLab: () => Promise<void>;
  exitWebResearchLab: () => Promise<void>;
  runWebResearchLab: (input: { systemPrompt: string; userPrompt: string; modelPreference: string }) => Promise<void>;
  stopWebResearchLab: () => Promise<void>;
  showBatchTestHistory: () => void;
  showNewBatchTest: () => void;
  refreshBatchTestHistory: () => Promise<void>;
  openBatchTestRun: (run: import("../../../api/types").BatchTestRunRecord) => void;
  deleteBatchTestRun: (run: import("../../../api/types").BatchTestRunRecord) => Promise<void>;
  loadBatchTestCaseDetail: (caseId: string) => Promise<void>;
  resolveConfirmation: (confirmed: boolean) => void;
  refreshPerformanceRuns: () => Promise<void>;
  refreshAgentResourceInfo: () => Promise<void>;
  startPerformanceRun: () => Promise<void>;
  finalizePerformanceRun: () => Promise<void>;
  abandonPerformanceRun: () => Promise<void>;
  deletePerformanceRun: (run: PerformanceRunListItem) => Promise<void>;
  openPerformanceReport: (run: PerformanceRunListItem) => Promise<void>;
  regeneratePerformanceReport: (run: PerformanceRunListItem) => Promise<void>;
  startBatchTest: (input: BatchTestInput) => Promise<void>;
  stopBatchTest: () => Promise<void>;
  downloadBatchTestBundle: (run?: import("../../../api/types").BatchTestRunRecord) => Promise<void>;
  addContextRow: (row: ContextRow) => void;
  updateContextRow: (id: string, value: string) => void;
  removeContextRow: (id: string) => void;
  addStyleRow: () => void;
  generateDeck: () => Promise<void>;
  setSelectedAspectRatio: (value: SlideAspectRatio) => void;
  generatePresentationRequirements: () => Promise<void>;
  retryPresentationRequirements: () => Promise<void>;
  selectVisualStylePreset: (presetId: string | null) => Promise<void>;
  useManualPresentationRequirements: () => Promise<void>;
  selectPresentationRequirement: <K extends keyof PresentationRequirementsSelections>(
    field: K,
    value: PresentationRequirementsSelections[K],
  ) => void;
  selectPresentationResearch: (kind: keyof PresentationResearchRequirements, enabled: boolean) => void;
  returnToBriefFromRequirements: () => Promise<void>;
  savePresentationRequirements: () => Promise<void>;
  confirmPresentationRequirements: () => Promise<void>;
  retryWebResearch: () => Promise<void>;
  returnToRequirementsFromWebResearch: () => void;
  createDeckFromOutline: () => Promise<void>;
  applyOutlineFeedback: () => Promise<EditableOutline | undefined>;
  retryOutlineCreation: () => Promise<void>;
  returnToRequirementsFromOutline: () => void;
  saveOutlineDraft: (value?: EditableOutline) => Promise<boolean>;
  setOutlineDraftTitle: (value: string) => void;
  setOutlineDraftRequirements: (value: string) => void;
  updateOutlineDraftItem: (index: number, patch: Partial<WorkspaceOutlineItem>) => void;
  replaceOutlineDraftItems: (items: OutlineDetail[]) => void;
  openLocalProject: (projectName: string) => void;
  openWorkspace: (workspaceDir: string) => Promise<void>;
  scanWorkspaces: () => Promise<void>;
  showWorkspacePicker: () => Promise<void>;
  startNewPresentation: () => Promise<void>;
  refreshMyWork: (options?: { force?: boolean }) => Promise<void>;
  useLatestWorkspace: () => Promise<void>;
  createWorkspace: () => Promise<void>;
  uploadUploadedSource: (file: File) => Promise<void>;
  removeUploadedSource: (uploadedSourceId: string) => Promise<void>;
  openStyleProfileCreation: () => void;
  setStyleProfileCreationName: (value: string) => void;
  setStyleProfileCreationFiles: (files: File[]) => void;
  startStyleProfileCreation: () => Promise<void>;
  retryStyleProfileAnalysis: () => Promise<void>;
  stopStyleProfileCreation: () => void;
  resetStyleProfileCreation: () => void;
  refreshStyleProfiles: () => Promise<void>;
  loadStyleProfilePreview: (styleProfileId: string) => Promise<void>;
  openStyleProfileDetail: (styleProfileId: string) => Promise<void>;
  closeStyleProfileDetail: () => void;
  selectStyleProfile: (styleProfileId: string) => Promise<void>;
  clearStyleProfile: () => Promise<void>;
  saveWorkspaceSettings: (setting: WorkspaceSettings) => Promise<void>;
  saveWorkspaceTitle: (title: string) => Promise<void>;
  renameWorkspace: (workspaceDir: string, title: string) => Promise<void>;
  deleteWorkspace: (workspaceDir: string, title: string) => Promise<void>;
  duplicateWorkspace: (workspaceDir: string, sourceTitle: string) => Promise<void>;
  dismissCloudConflictDialog: () => void;
  refreshWorkspaceSnapshotInfo: () => Promise<void>;
  selectTemplate: (groupId: string) => Promise<void>;
  openRefineDeck: () => Promise<void>;
  openRefineSlide: (index?: number) => Promise<void>;
  refineDeck: (instruction: string) => Promise<void>;
  refineSlide: (instruction: string) => Promise<void>;
  rewriteCurrentSlide: () => Promise<void>;
  changeCurrentSlideLayout: (mode: "simpler" | "visual" | "comparison" | "process" | "report") => Promise<void>;
  renderDeckHtml: () => Promise<void>;
  refreshReviewPageImage: (pageId: string) => Promise<void>;
  applyManualPageUpdate: (result: SaveManualPageRevisionResult | RestorePageSourceVersionResult) => void;
  exitManualEditor: (workspaceDir: string, pageId: string | undefined, requiresDeckRender: boolean) => Promise<void>;
  exportFile: (selection: { type: "PPTX" | "PDF"; pageNumbers?: number[] }) => Promise<void>;
  downloadExportArtifact: () => Promise<void>;
  downloadWorkspaceDiagnosticBundle: () => Promise<void>;
  resetWorkspaceDiagnosticBundle: () => void;
  selectGenerationPreviewPage: (pageId: string | null) => void;
  returnToOutlineFromGeneration: () => void;
  backFromGeneration: () => Promise<void>;
  backFromDeck: () => Promise<void>;
  returnToBriefFromUploadedSourceAnalysis: () => void;
  regenerateDeck: () => Promise<void>;
  resumeDeckGeneration: () => Promise<void>;
  retryPageGeneration: (pageId: string) => Promise<void>;
  retryUploadedSourceAnalysis: () => Promise<void>;
}

export function useDeckWorkspace(t: Messages, locale: Locale) {
  const [panelMode, setPanelMode] = useState<PanelMode>("visible");
  const [page, setPage] = useState<PageId>("main");
  const [stage, setStage] = useState<MainStage>("brief");
  const [history, setHistory] = useState<PageId[]>(["main"]);
  const [toast, setToast] = useState("");
  const [prompt, setPrompt] = useState("");
  const [selectedAspectRatio, setSelectedAspectRatio] = useState<SlideAspectRatio>("16:9");
  const [globalSettings, setGlobalSettings] = useState<WorkspaceSettings>({});
  const globalSettingsRef = useRef<WorkspaceSettings>(globalSettings);
  globalSettingsRef.current = globalSettings;
  const [contextRows, setContextRows] = useState<ContextRow[]>([]);
  const [presentationRequirements, setPresentationRequirements] =
    useState<PresentationRequirements>(() => createEmptyPresentationRequirements());
  const requirementsProcess = useProcessProgress();
  const outlineProcess = useProcessProgress();
  const outlineRewriteRequestRef = useRef<string | null>(null);
  const [requirementsStatus, setRequirementsStatus] =
    useState<"idle" | "loading" | "ready" | "error">("idle");
  const [requirementsError, setRequirementsError] = useState("");
  const [requirementsErrorDetail, setRequirementsErrorDetail] = useState("");
  const [requirementsRetryMode, setRequirementsRetryMode] = useState<"generate" | "select">("generate");
  const [requirementsSaving, setRequirementsSaving] = useState(false);
  const [requirementsConfirming, setRequirementsConfirming] = useState(false);
  const [requirementsDirty, setRequirementsDirty] = useState(false);
  const [requirementsHasSavedDraft, setRequirementsHasSavedDraft] = useState(false);
  const [webResearchStatus, setWebResearchStatus] =
    useState<WebResearchStatus>("idle");
  // Session-only research history survives workspace refreshes and later deck generation.
  const [webResearchProgress, setWebResearchProgress] = useState<DeckGenerationProgress | null>(null);
  const webResearchRunRef = useRef(0);
  const [webResearchError, setWebResearchError] = useState("");
  const [webResearchErrorDetail, setWebResearchErrorDetail] = useState("");
  const [deckTitle, setDeckTitle] = useState(t.deck.title);
  const [deck, setDeck] = useState<Slide[]>(initialDeck);
  const [outline, setOutline] = useState(outlineDetails);
  const [outlineDraft, setOutlineDraft] = useState(outlineDetails);
  const [outlineDraftTitle, setOutlineDraftTitle] = useState(t.deck.title);
  const [outlineRequirements, setOutlineRequirements] = useState("");
  const [outlineDraftRequirements, setOutlineDraftRequirements] = useState("");
  const [outlineSaving, setOutlineSaving] = useState(false);
  const [outlineError, setOutlineError] = useState("");
  const [outlineErrorDetail, setOutlineErrorDetail] = useState("");
  const [generated, setGenerated] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [outlineFeedback, setOutlineFeedback] = useState("");
  const outlineDirty = useMemo(
    () => !outlinesEqual(
      { title: deckTitle, global_creation_requirements: outlineRequirements, items: outline },
      { title: outlineDraftTitle, global_creation_requirements: outlineDraftRequirements, items: outlineDraft },
    ),
    [deckTitle, outline, outlineDraft, outlineDraftTitle, outlineRequirements, outlineDraftRequirements],
  );
  useEffect(() => {
    const dirty = (stage === "requirements" && requirementsDirty) || (stage === "outline" && outlineDirty);
    if (!dirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [outlineDirty, requirementsDirty, stage]);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("grid");
  const [reviewRender, setReviewRender] = useState<DeckReviewRenderState>({
    status: "idle",
    result: null,
    error: "",
    renderKey: ""
  });
  const reviewRenderRef = useRef(reviewRender);
  reviewRenderRef.current = reviewRender;
  const reviewLoadRequestRef = useRef(0);
  const reviewPublicationRef = useRef(0);
  const [createDeckProgress, setCreateDeckProgress] =
    useState<DeckGenerationProgress | null>(null);
  const [uploadedSourceAnalysisProgress, setUploadedSourceAnalysisProgress] =
    useState<UploadedSourceAnalysisProgress>(() => createUploadedSourceAnalysisProgress(t));
  const [generationHistory, setGenerationHistory] = useState<GenerationStreamSnapshot[]>([]);
  const [pageProgress, setPageProgress] = useState<PageProgress | null>(null);
  const [refineScope, setRefineScope] = useState<RefineScope>("deck");
  const [loading, setLoading] = useState<LoadingKind>("none");
  // React state updates are asynchronous. Keep a synchronous guard as well
  // so a retry button cannot start a second page run during that short gap.
  const generationRetryInFlightRef = useRef(false);
  const [confirmationDialog, setConfirmationDialog] =
    useState<ConfirmationDialogRequest | null>(null);
  const [activeGenerationRun, setActiveGenerationRun] =
    useState<ActiveGenerationRun | null>(null);
  const [generationPagePreviews, setGenerationPagePreviews] =
    useState<GenerationPagePreviews>({});
  const [pinnedGenerationPreviewPageId, setPinnedGenerationPreviewPageId] =
    useState<string | null>(null);
  const generationPagePreviewsRef = useRef<GenerationPagePreviews>({});
  const generationPagePreviewSessionRef = useRef(0);
  // A page is put on hold once per run. Without this the next progress poll
  // would keep re-arming the hold and the preview could never come back.
  const generationPreviewHeldPageIdsRef = useRef(new Set<string>());
  const reviewPageImageRefreshAttemptsRef = useRef(new Set<string>());
  const [generationPreparing, setGenerationPreparing] = useState(false);
  const [generationTransaction, setGenerationTransaction] =
    useState<GenerationRunTransaction | null>(null);
  const [generationUnresumable, setGenerationUnresumable] = useState(false);
  const [generationResumeAllowed, setGenerationResumeAllowed] = useState(true);
  const [exportProgress, setExportProgress] = useState<ExportProgressState>(
    () => createIdleExportProgress(t)
  );
  const [exportArtifact, setExportArtifact] = useState<ExportArtifact | null>(null);
  const [exportDownload, setExportDownload] = useState<ExportDownloadState>({
    status: "idle",
    message: "",
  });
  const [templateDiagnosticMode, setTemplateDiagnosticMode] = useState(false);
  const [workspaceDiagnosticBundle, setWorkspaceDiagnosticBundle] =
    useState<WorkspaceDiagnosticBundleState>({
      status: "idle",
      message: "",
    });
  const [performanceTesting, setPerformanceTesting] = useState<DeckWorkspaceState["performanceTesting"]>({
    enabled: PERFORMANCE_TESTING_ENABLED,
    supported: false,
    loading: PERFORMANCE_TESTING_ENABLED,
    busy: false,
    error: "",
    activeRun: null,
    runs: [],
    reportHtml: "",
    reportRunId: null,
  });
  const [batchTesting, setBatchTesting] = useState(() => createIdleBatchTestingState(BATCH_TESTING_ENABLED));
  const [webResearchLab, setWebResearchLab] = useState<WebResearchLabState>(() => ({
    enabled: WEB_RESEARCH_LAB_ENABLED,
    status: "idle",
    systemPrompt: WEB_RESEARCH_AGENT_SYSTEM_PROMPT,
    userPrompt: "",
    modelPreference: WEB_RESEARCH_AGENT_MODEL,
    events: [],
    rounds: [],
    resultMarkdown: "",
    runId: "",
    runDir: "",
    error: "",
  }));
  const batchTestingRef = useRef(batchTesting);
  batchTestingRef.current = batchTesting;
  const webResearchLabAbortRef = useRef<AbortController | null>(null);
  const workspaceDiagnosticBundleRequestRef = useRef(0);
  const exportInFlightRef = useRef(false);
  const exportArtifactPublishInFlightRef = useRef(false);
  const [backend, setBackend] = useState<PptBackend | null>(null);
  const [hostUploadClient, setHostUploadClient] = useState<AppHostUploadClient | null>(null);
  const [hostFileDownloadClient, setHostFileDownloadClient] =
    useState<AppHostFileDownloadClient | null>(null);
  const [aiClient, setAiClient] = useState<AiClient | null>(null);
  const [imageBriefClient, setImageBriefClient] = useState<ImageAttachmentBriefClient | null>(null);
  const [attachmentBriefCompletionClient, setAttachmentBriefCompletionClient] =
    useState<AttachmentBriefCompletionClient | null>(null);
  const [researchAiClient, setResearchAiClient] = useState<ResearchAiClient | null>(null);
  const [pageRefinementClassifier, setPageRefinementClassifier] = useState<PageRefinementClassifier | null>(null);
  const [researchWebClient, setResearchWebClient] = useState<ResearchWebClient | null>(null);
  const [webResearchLabWebClient, setWebResearchLabWebClient] = useState<ResearchWebClient | null>(null);
  const [agentClient, setAgentClient] = useState<AgentClient | null>(null);
  // Declared before the preset state so the hook order stays stable; a confirmed
  // Workspace keeps its own preset snapshot, so only a draft selection is cleared.
  const clearDeletedVisualStylePresetRef = useRef<(id: string) => void>(() => {});
  const userTemplates = useUserTemplates({
    backend, agent: agentClient, upload: hostUploadClient, locale, t,
    onDeleted: (id) => clearDeletedVisualStylePresetRef.current(id),
  });
  const templateDiagnosticBundle = useTemplateDiagnosticBundle({
    backend, hostDownload: hostFileDownloadClient, t, enabled: templateDiagnosticMode && page === "settings",
    templateId: userTemplates.templates.some((item) => item.id === userTemplates.selectedId) ? userTemplates.selectedId : "",
  });
  function findVisualStylePreset(id: string | null | undefined) {
    return userTemplates.presets.find((preset) => preset.id === id) ?? findBuiltInVisualStylePreset(id);
  }
  const cancelCreateDeckRef = useRef(false);
  const batchTestAbortRef = useRef<AbortController | null>(null);
  const batchTestCaseDetailRequestsRef = useRef(new Map<string, Promise<void>>());
  const batchTestAutoLoadedCaseIdsRef = useRef(new Set<string>());
  const cancelCreateDeckAbortRef = useRef<AbortController | null>(null);
  const generationOperationRef = useRef(0);
  const generationSignalOperationsRef = useRef(new WeakMap<AbortSignal, number>());
  const confirmationResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const pendingUploadedSourceAnalysisActionRef = useRef<(() => Promise<void>) | null>(null);
  const forceUploadedSourceAnalysisRefreshRef = useRef(false);
  // C-line kickoff started at the generate click so its work overlaps the
  // requirements-drafting + review think-time; the pre-outline gate awaits it.
  const uploadedSourceAnalysisKickoffRef =
    useRef<Promise<UploadedSourceAnalysis | null> | null>(null);
  const requirementsOperationRef = useRef(0);
  const attachmentPreparationOperationRef = useRef(0);
  const outlineOperationRef = useRef(0);
  const myWorkOperationRef = useRef(0);
  const workspaceSyncStateOperationRef = useRef(0);
  /** One background cloud reconcile per session; no local refresh waits for it. */
  const cloudReconcileDoneRef = useRef(false);
  const cloudReconcileRequestRef = useRef<ReturnType<PptBackend["autoRestoreMissingWorkspaces"]> | null>(null);
  /** The in-flight My Work refresh, so overlapping triggers share one listing. */
  const myWorkRefreshRef = useRef<Promise<void> | null>(null);
  const myWorkRefreshGenerationRef = useRef(0);
  const myWorkRefreshRerunRef = useRef(false);
  const myWorkCloudListFetchedAtRef = useRef(0);
  const [workspaceScan, setWorkspaceScan] = useState<ListWorkspacesResult | null>(null);
  const [workspaceSyncStates, setWorkspaceSyncStates] = useState<Record<string, WorkspaceSnapshotSyncState | null>>({});
  const [cloudWorkspaces, setCloudWorkspaces] = useState<ListMyWorkEntry[]>([]);
  const [workspaceSnapshotInfo, setWorkspaceSnapshotInfo] = useState<GetWorkspaceSnapshotInfoResult | null>(null);
  const [workspaceSnapshotSyncState, setWorkspaceSnapshotSyncState] = useState<WorkspaceSnapshotSyncState | null>(null);
  const [cloudConflictDialog, setCloudConflictDialog] = useState<CloudConflictDialogState | null>(null);
  const [openingWorkspaceDir, setOpeningWorkspaceDir] = useState<string | null>(null);
  const openingWorkspaceDirRef = useRef<string | null>(openingWorkspaceDir);
  openingWorkspaceDirRef.current = openingWorkspaceDir;
  const [highlightedWorkspaceId, setHighlightedWorkspaceId] = useState<string | null>(null);
  const [currentWorkspace, setCurrentWorkspace] = useState<WorkspaceResult | null>(null);
  const currentWorkspaceRef = useRef<WorkspaceResult | null>(currentWorkspace);
  // A multi-file selection starts every upload in the same event loop turn.
  // Until the first createWorkspace RPC resolves, currentWorkspaceRef is still
  // empty, so this promise is the single-flight guard for that initial window.
  const workspaceCreationPromiseRef = useRef<Promise<WorkspaceResult | null> | null>(null);
  currentWorkspaceRef.current = currentWorkspace;
  const [uploadedSources, setUploadedSources] = useState<UploadedSourceMaterial[]>([]);
  const [uploadedSourcePreflights, setUploadedSourcePreflights] =
    useState<UploadedSourcePreflightResult[]>([]);
  const [uploadedSourcePreflightRunning, setUploadedSourcePreflightRunning] = useState(false);
  const [currentUploadedSourceAnalysis, setCurrentUploadedSourceAnalysis] =
    useState<UploadedSourceAnalysis | null>(null);
  const [uploadedSourceAnalysisError, setUploadedSourceAnalysisError] = useState("");
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceErrorDetail, setWorkspaceErrorDetail] = useState("");
  const [workspaceSettingsSaving, setWorkspaceSettingsSaving] = useState(false);
  // Brief-page controls update independently but share the same persisted
  // Workspace settings record. Serialize their writes so a slow Cloud response
  // can never make an earlier response overwrite a later click.
  const briefSettingsSaveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const briefSettingsMutationRef = useRef(0);
  const [runtimeInfo, setRuntimeInfo] = useState<PptEngineRuntimeInfo | null>(null);
  const [runtimeInfoError, setRuntimeInfoError] = useState("");
  const [agentResourceInfo, setAgentResourceInfo] = useState<DeckWorkspaceState["agentResourceInfo"]>({
    enabled: AGENT_RESOURCE_INFO_ENABLED,
    loading: AGENT_RESOURCE_INFO_ENABLED,
    error: "",
    info: null,
  });
  const [templateGroups, setTemplateGroups] = useState<TemplateSummary[]>([]);
  const [selectedVisualStylePresetId, setSelectedVisualStylePresetId] = useState<string | null>(null);
  clearDeletedVisualStylePresetRef.current = (id) => setSelectedVisualStylePresetId((current) => current === id ? null : current);
  const [selectedTemplateGroupId, setSelectedTemplateGroupId] = useState<string | null>(DEFAULT_TEMPLATE_GROUP_ID);
  const [styleProfiles, setStyleProfiles] = useState<StyleProfileIndexEntry[]>([]);
  const [styleProfilePreviews, setStyleProfilePreviews] =
    useState<Record<string, GetStyleProfilePreviewResult | undefined>>({});
  const [selectedStyleProfile, setSelectedStyleProfile] =
    useState<WorkspaceStyleProfileSelection | null>(null);
  const [styleProfileLibraryLoading, setStyleProfileLibraryLoading] = useState(false);
  const [styleProfileLibraryError, setStyleProfileLibraryError] = useState("");
  const [styleProfileCreation, setStyleProfileCreation] =
    useState<StyleProfileCreationViewState>(() => createIdleStyleProfileCreationState());
  const [styleProfileDetail, setStyleProfileDetail] = useState<StyleProfileDetailState>({
    status: "closed",
    styleProfileId: "",
    detail: null,
    error: "",
  });
  const styleProfileCreationAbortRef = useRef<AbortController | null>(null);
  const aiLogger = useMemo(() => backend ? createAiInteractionLogger(backend) : null, [backend]);

  useEffect(() => {
    if (!PERFORMANCE_TESTING_ENABLED) return;
    return installPerformanceButtonCollector();
  }, []);

  function invalidateWorkspaceDiagnosticBundle() {
    workspaceDiagnosticBundleRequestRef.current += 1;
    setWorkspaceDiagnosticBundle({ status: "idle", message: "" });
  }

  useEffect(() => {
    invalidateWorkspaceDiagnosticBundle();
  }, [currentWorkspace?.workspace_id]);

  function getDefaultWorkspaceTitle(date = new Date()) {
    return formatMessage(t.library.defaultWorkspaceTitle, {
      date: formatWorkspaceDate(date)
    });
  }

  function buildAiLogContext(
    workspace: WorkspaceResult,
    domain: "requirements" | "outline" | "visual_rhythm" | "page_visual_plan" | "page_agent" | "theme",
    operation: string,
    extra: {
      page_id?: string;
      page_index?: number;
      kind?: string;
      operation_id?: string;
    } = {}
  ) {
    if (!aiLogger) return undefined;
    return {
      logger: aiLogger,
      workspace_dir: workspace.workspace_dir,
      domain,
      operation,
      provider: "host",
      runtime_mode: "host",
      ...extra,
    };
  }

  function workspaceOutlineToState(workspaceOutline: unknown): OutlineDetail[] {
    const outlineRecord =
      workspaceOutline && typeof workspaceOutline === "object" && !Array.isArray(workspaceOutline)
        ? (workspaceOutline as Partial<WorkspaceOutline>)
        : null;
    const items = Array.isArray(outlineRecord?.items) ? outlineRecord.items : [];

    return items
      .filter(
        (item): item is WorkspaceOutlineItem =>
          item !== null &&
          typeof item === "object" &&
          typeof (item as WorkspaceOutlineItem).title === "string"
      )
      .map((item) => ({
        page_type: item.page_type === "cover" ? "cover" : "standard",
        title: item.title,
        content: typeof item.content === "string" ? item.content : "",
        ...(typeof item.creation_requirements === "string" && item.creation_requirements.trim() ? { creation_requirements: item.creation_requirements } : {}),
        ...(Array.isArray(item.title_segments) ? { title_segments: item.title_segments.map((segment) => ({ ...segment })) } : {}),
        ...(item.research && typeof item.research === "object" ? { research: structuredClone(item.research) } : {}),
        ...(item.analysis && typeof item.analysis === "object" ? { analysis: { ...item.analysis } } : {}),
        selected_image_ids: [...(item.selected_image_ids ?? [])],
      }));
  }

  function normalizeWorkspacePage(value: unknown): WorkspacePageItem | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const record = value as Partial<WorkspacePageItem>;
    const pageId = typeof record.page_id === "string" ? record.page_id : "";
    const title = typeof record.title === "string" ? record.title : pageId;
    const layoutId = typeof record.layout_id === "string" ? record.layout_id : "";
    const htmlPath = typeof record.html_path === "string" ? record.html_path : "";
    const speakerNote =
      typeof record.speaker_note === "string" ? record.speaker_note : "";
    const index = typeof record.index === "number" ? record.index : 0;

    if (!pageId && !title && !layoutId && !htmlPath) {
      return null;
    }

    return {
      page_id: pageId,
      index,
      title,
      layout_id: layoutId,
      html_path: htmlPath,
      screenshot_path: "",
      speaker_note: speakerNote
    };
  }

  function workspacePagesToState(workspacePages: unknown) {
    const pagesRecord =
      workspacePages && typeof workspacePages === "object" && !Array.isArray(workspacePages)
        ? (workspacePages as Partial<WorkspacePages>)
        : null;
    const pages = Array.isArray(pagesRecord?.pages)
      ? pagesRecord.pages
          .map(normalizeWorkspacePage)
          .filter((page): page is WorkspacePageItem => page !== null)
          .sort((left, right) => left.index - right.index)
      : [];

    if (pages.length === 0) return null;

    return {
      title: typeof pagesRecord?.title === "string" ? pagesRecord.title : "",
      deck: pages.map((page) => ({
        title: page.title,
        subtitle: ""
      })),
      outline: pages.map((page) => ({
        page_type: "standard" as const,
        title: page.title,
        content: page.speaker_note || "Page content",
      }))
    };
  }

  async function reconcileWorkspaceInterruptedPages(workspace: WorkspaceResult): Promise<WorkspaceResult> {
    if (!backend) return workspace;
    const progress = normalizeWorkspacePageProgress(workspace.page_progress);
    if (!progress) return workspace;

    const reconciliation = reconcileInterruptedPageProgress(progress);
    if (reconciliation.patches.length === 0) return workspace;

    let persistedProgress = reconciliation.progress;
    for (const patch of reconciliation.patches) {
      persistedProgress = await backend.recordPageProgress({
        workspace_dir: workspace.workspace_dir,
        page_id: patch.pageId,
        patch: patch.patch,
      });
    }

    return {
      ...workspace,
      page_progress: persistedProgress,
    };
  }

  function sleep(ms: number) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function uploadUploadedSourceFile(workspace: WorkspaceResult, file: File) {
    if (!backend || !hostUploadClient) {
      throw new Error("Host Upload is not available.");
    }
    const hostUpload = await hostUploadClient.uploadFile(file, {
      purpose: "user_artifact",
      filename: file.name,
      mimeType: file.type || undefined,
      metadata: {
        source: "ppt-app.uploaded-source",
        workspace_dir: workspace.workspace_dir,
      },
    });
    return backend.commitUploadedSourceHostUpload({
      workspace_dir: workspace.workspace_dir,
      filename: file.name,
      mime_type: hostUpload.mime_type,
      size_bytes: file.size,
      host_upload: hostUpload,
    });
  }

  async function refreshUploadedSources(workspace: WorkspaceResult | null = currentWorkspace) {
    if (!backend || !workspace) {
      setUploadedSources([]);
      setUploadedSourcePreflights([]);
      setUploadedSourcePreflightRunning(false);
      setCurrentUploadedSourceAnalysis(null);
      setUploadedSourceAnalysisError("");
      setUploadedSourceAnalysisProgress(createSkippedUploadedSourceAnalysisProgress(t));
      return;
    }
    try {
      const result = await backend.listUploadedSources({
        workspace_dir: workspace.workspace_dir,
        include_removed: false,
      });
      setUploadedSources(result.active);
      await refreshUploadedSourceAnalysisSnapshot(workspace, result.index);
    } catch (error) {
      console.warn(
        "Failed to refresh uploaded sources",
        error instanceof Error ? error.message : error
      );
      setUploadedSources([]);
      setUploadedSourcePreflights([]);
      setUploadedSourcePreflightRunning(false);
      setCurrentUploadedSourceAnalysis(null);
    }
  }

  async function refreshUploadedSourceAnalysisSnapshot(
    workspace: WorkspaceResult,
    uploadedSourceIndex: UploadedSourceIndex,
  ) {
    if (uploadedSourceIndex.materials.filter((item) => item.status === "active").length === 0) {
      setCurrentUploadedSourceAnalysis(null);
      setUploadedSourceAnalysisError("");
      setUploadedSourceAnalysisProgress(createSkippedUploadedSourceAnalysisProgress(t));
      return;
    }
    try {
      const analysis = await backend!.getUploadedSourceAnalysis({
        workspace_dir: workspace.workspace_dir,
      });
      const status = typeof analysis.status === "string" ? analysis.status : "";
      if (
        (status === "ready" || status === "gap" || status === "blocked") &&
        uploadedSourceAnalysisMatchesActiveSet({ analysis, uploadedSourceIndex })
      ) {
        const typedAnalysis = analysis as unknown as UploadedSourceAnalysis;
        setCurrentUploadedSourceAnalysis(typedAnalysis);
        setUploadedSourceAnalysisProgress(createCompletedUploadedSourceAnalysisProgress(
          t,
          uploadedSourceIndex.materials.filter((item) => item.status === "active").length,
          typedAnalysis,
        ));
        setUploadedSourceAnalysisError("");
        return;
      }
      setCurrentUploadedSourceAnalysis(null);
      setUploadedSourceAnalysisProgress(createUploadedSourceAnalysisProgress(t, {
        sourceCount: uploadedSourceIndex.materials.filter((item) => item.status === "active").length,
      }));
    } catch (error) {
      console.warn(
        "Failed to refresh uploaded source analysis",
        error instanceof Error ? error.message : error
      );
      setCurrentUploadedSourceAnalysis(null);
    }
  }

  function assertPptxExportPath(value: string, name: string) {
    if (!value) {
      throw new Error(formatMessage(t.errors.exportStatusMissing, { name }));
    }
  }

  /**
   * EXPORT-001: reopening the export page reattaches to whatever job the
   * backend still has for this deck instead of showing an idle panel.
   */
  async function resumePptxExportJob() {
    const workspaceDir = currentWorkspaceRef.current?.workspace_dir;
    if (!backend || !workspaceDir || exportInFlightRef.current) return;

    const workspaceId = workspaceDir.split(/[\\/]/).filter(Boolean).at(-1) ?? workspaceDir;
    const jobs = await backend.listExportJobs({ workspace_dir: workspaceDir }).catch(() => []);
    const job = jobs.find((item) => item.clientTag === `ppt-export:pptx:${workspaceId}`);
    if (!job) {
      void resumeExportArtifactPublishJob();
      return;
    }

    exportInFlightRef.current = true;
    setLoading("export");
    showToast(t.exportPage.resumedJob);
    try {
      const completed = await backend.awaitExportJob<PptxExportJob>({ job_id: job.jobId });
      setExportProgress(createPptxJobExportProgress(t, completed));
      if (completed.status === "completed") {
        const updatedWorkspace = await backend.openWorkspace({ workspace_dir: workspaceDir });
        applyWorkspace(updatedWorkspace);
        const artifact = readWorkspaceExportArtifactPath(updatedWorkspace);
        if (artifact) {
          await publishExportArtifact(updatedWorkspace, artifact);
        }
      }
    } catch (error) {
      const { summary } = summarizeUserFacingError(t, error, t.exportPage.exportFailedSummary);
      setExportProgress((current) => createExportErrorProgress(summary, "PPTX", current.percent));
    } finally {
      exportInFlightRef.current = false;
      setLoading("none");
    }
  }

  async function resumeExportArtifactPublishJob() {
    const workspace = currentWorkspaceRef.current;
    if (!backend || !workspace || exportArtifactPublishInFlightRef.current) return;
    const artifact = readWorkspaceExportArtifactPath(workspace);
    if (!artifact) return;
    const workspaceId = workspace.workspace_dir.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace.workspace_dir;
    const jobs = await backend.listExportJobs({
      workspace_dir: workspace.workspace_dir,
      artifact_type: artifact.type.toLowerCase() as "pptx" | "pdf",
    }).catch(() => []);
    const job = jobs.find((item) => item.clientTag === `ppt-export:mirror:${workspaceId}:${artifact.type.toLowerCase()}`);
    if (!job) return;

    exportArtifactPublishInFlightRef.current = true;
    if (!exportInFlightRef.current) setLoading("export");
    showToast(t.exportPage.resumedJob);
    try {
      const completed = await backend.awaitExportJob<ExportArtifactPublishJob>({ job_id: job.jobId });
      setExportProgress(createExportArtifactPublishProgress(t, completed));
      if (completed.status === "completed") {
        const updatedWorkspace = await backend.openWorkspace({ workspace_dir: workspace.workspace_dir });
        applyWorkspace(updatedWorkspace);
        setExportArtifact(readWorkspaceExportArtifactPath(updatedWorkspace));
        setExportDownload({ status: "idle", message: t.exportPage.downloadNotPrepared });
      }
    } catch (error) {
      const { summary } = summarizeUserFacingError(t, error, t.exportPage.exportFailedSummary);
      setExportProgress((current) => createExportErrorProgress(summary, artifact.type, current.percent));
    } finally {
      exportArtifactPublishInFlightRef.current = false;
      if (!exportInFlightRef.current) setLoading("none");
    }
  }

  function workspaceSettingsToState(workspace: WorkspaceResult | null): WorkspaceSettings {
    if (!workspace?.setting || typeof workspace.setting !== "object" || Array.isArray(workspace.setting)) {
      return {};
    }

    const setting = { ...(workspace.setting as WorkspaceSettings) };
    delete setting.audience;
    delete setting.goal;
    delete setting.style_notes;
    delete setting.slide_count;
    return setting;
  }

  function workspaceOutlineForDownstream(workspace: WorkspaceResult): WorkspaceOutline {
    const outline = workspace.outline as WorkspaceOutline;
    const outputLanguage = workspace.requirements.selections.output_language ?? "中文";
    return {
      ...outline,
      output_language: outputLanguage,
      source: {
        prompt: workspace.requirements.source?.brief ?? "",
        context: [],
        setting: {
          ...workspaceSettingsToState(workspace),
          output_language: outputLanguage,
        },
      },
    };
  }

  function applyWorkspaceSetting(setting: WorkspaceSettings) {
    globalSettingsRef.current = setting;
    setGlobalSettings(setting);
    setCurrentWorkspace((workspace) => workspace ? { ...workspace, setting } : workspace);
  }

  function workspaceContextRowsToState(workspace: WorkspaceResult): {
    rows: ContextRow[];
    shouldSync: boolean;
  } {
    void workspace;
    return { rows: [], shouldSync: false };
  }

  const workspaceReviewRenderKey = createWorkspaceReviewRenderKey;

  function setExportArtifactWithProgress(artifact: ExportArtifact | null) {
    setExportArtifact(artifact);
    setExportProgress(createArtifactExportProgress(t, artifact));
    setExportDownload(artifact
      ? {
          status: "idle",
          message: t.exportPage.downloadNotPrepared,
        }
      : { status: "idle", message: "" });
  }

  function buildLlmContextRows(
    rows: Array<{ id: string; value: string }> = contextRows
  ): LlmContextRow[] {
    return rows
      .map((row) => {
        const id = row.id.trim();
        const value =
          id === "slides" ? normalizeSlideCountContextValue(row.value) : row.value.trim();
        return id && value ? { id, value } : null;
      })
      .filter((row): row is LlmContextRow => row !== null);
  }

  async function ensureUploadedSourceAnalysisForOutline(
    workspace: WorkspaceResult,
    pendingAction?: () => Promise<void>
  ): Promise<UploadedSourceAnalysis | null> {
    if (!backend) return null;
    if (pendingAction) {
      pendingUploadedSourceAnalysisActionRef.current = pendingAction;
    }
    const uploadedSourceList = await backend.listUploadedSources({
      workspace_dir: workspace.workspace_dir,
      include_removed: false,
    });
    setUploadedSources(uploadedSourceList.active);
    if (uploadedSourceList.active.length === 0) {
      setCurrentUploadedSourceAnalysis(null);
      setUploadedSourceAnalysisError("");
      setUploadedSourceAnalysisProgress(createSkippedUploadedSourceAnalysisProgress(t));
      pendingUploadedSourceAnalysisActionRef.current = null;
      forceUploadedSourceAnalysisRefreshRef.current = false;
      return null;
    }
    // Non-preemptive: this runs either as a background kickoff at the generate
    // click (stage stays "requirements") or on the blocking pre-outline gate
    // (stage stays "outline", loading="outline" so the outline skeleton shows).
    // It must NOT set its own stage/page/loading — the removed
    // setStage("uploaded-source-analysis") had no render body in App.tsx and
    // blanked the screen. Progress is surfaced only via the analysis state.
    setUploadedSourceAnalysisProgress(createUploadedSourceAnalysisProgress(t, {
      status: "running",
      sourceCount: uploadedSourceList.active.length,
      message: t.uploadedSourceAnalysis.messages.prepare,
    }));
    if (!agentClient) {
      const message = t.errors.uploadedSourceAnalysisUnavailable;
      setUploadedSourceAnalysisError(message);
      setUploadedSourceAnalysisProgress((current) =>
        failUploadedSourceAnalysisProgress(t, current, message)
      );
      throw new Error(message);
    }
    setUploadedSourceAnalysisError("");
    const forceRefresh = forceUploadedSourceAnalysisRefreshRef.current;
    forceUploadedSourceAnalysisRefreshRef.current = false;
    function recordUploadedSourceAnalysisProgress(event: UploadedSourceAnalysisWorkflowEvent) {
      setUploadedSourceAnalysisProgress((current) =>
        applyUploadedSourceAnalysisWorkflowEvent(t, current, event)
      );
    }
    try {
      const analysis = await ensureFreshUploadedSourceAnalysis({
        backend,
        agentClient,
        aiLogger,
        workspace,
        forceRefresh,
        onProgress: recordUploadedSourceAnalysisProgress,
        repairLimit: UPLOADED_SOURCE_ANALYSIS_REPAIR_LIMIT,
      });
      if (!analysis) {
        setUploadedSourceAnalysisProgress(createSkippedUploadedSourceAnalysisProgress(t));
        pendingUploadedSourceAnalysisActionRef.current = null;
        return null;
      }
      setCurrentUploadedSourceAnalysis(analysis);
      if (analysis.status === "blocked" || !analysis.continuation_decision.can_continue) {
        const message = `${t.errors.uploadedSourceAnalysisBlocked}: ${analysis.continuation_decision.reason}`;
        setUploadedSourceAnalysisError(message);
        setUploadedSourceAnalysisProgress((current) => ({
          ...failUploadedSourceAnalysisProgress(t, current, message),
          status: "blocked",
          resultSummary: current.resultSummary,
        }));
        throw new Error(message);
      }
      pendingUploadedSourceAnalysisActionRef.current = null;
      return analysis;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUploadedSourceAnalysisError(message);
      setUploadedSourceAnalysisProgress((current) =>
        current.status === "blocked"
          ? current
          : failUploadedSourceAnalysisProgress(t, current, message)
      );
      throw error;
    }
  }

  // Start the C-line in the background at the generate click. Fire-and-forget:
  // never awaited here, so the requirements page renders normally while the
  // attachment analysis runs. The promise is parked on a ref for the pre-outline
  // gate to await. Swallows errors into null so no unhandled rejection escapes;
  // the gate re-derives the authoritative result (and surfaces failures) later.
  function startUploadedSourceAnalysisKickoff(workspace: WorkspaceResult) {
    // Attachment Context is now prepared before Requirements; do not start the
    // legacy Agent-based attachment analysis in parallel.
    void workspace;
    return;
    /*
    if (uploadedSourceAnalysisKickoffRef.current) return;
    uploadedSourceAnalysisKickoffRef.current = ensureUploadedSourceAnalysisForOutline(workspace)
      .catch((error) => {
        console.warn(
          "Uploaded source analysis kickoff failed (will retry at outline gate)",
          error instanceof Error ? error.message : error,
        );
        return null;
      });
    */
  }

  // Blocking pre-outline gate, bounded by an overall wall-clock deadline. On
  // deadline the C-line agent runs are cancelled and we return null so the
  // outline is generated without attachment context — never an unbounded hang.
  // Returns the analysis, or null when there are no attachments / it timed out.
  async function awaitUploadedSourceAnalysisForOutline(
    workspace: WorkspaceResult,
  ): Promise<UploadedSourceAnalysis | null> {
    // Requirements has already consumed Attachment Context. Outline no longer
    // waits for the retired Agent analysis route.
    void workspace;
    return null;
    /*
    const resolveAnalysis = async () => {
      const kickoff = uploadedSourceAnalysisKickoffRef.current;
      uploadedSourceAnalysisKickoffRef.current = null;
      // Serialize with the in-flight kickoff (started at the generate click) to
      // avoid running two analyses concurrently. Its result is intentionally
      // ignored: the authoritative ensure() below re-validates against the
      // CURRENT attachment set via its reuse-check — instant when the set is
      // unchanged, a fresh run when the user changed attachments meanwhile.
      if (kickoff) await kickoff.catch(() => null);
      return ensureUploadedSourceAnalysisForOutline(workspace);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"__timeout__">((resolve) => {
      timer = setTimeout(() => resolve("__timeout__"), UPLOADED_SOURCE_ANALYSIS_DEADLINE_MS);
    });
    try {
      const outcome = await Promise.race([
        resolveAnalysis().then((analysis) => ({ analysis }), (error) => ({ error })),
        deadline,
      ]);
      if (outcome === "__timeout__") {
        await agentClient?.cancelActiveRuns().catch(() => undefined);
        const message = t.errors.uploadedSourceAnalysisUnavailable;
        setUploadedSourceAnalysisError(message);
        setUploadedSourceAnalysisProgress((current) =>
          failUploadedSourceAnalysisProgress(t, current, message)
        );
        showToast(t.status.analyzingUploadedSource);
        return null;
      }
      if ("error" in outcome) throw outcome.error;
      return outcome.analysis;
    } finally {
      if (timer) clearTimeout(timer);
    }
    */
  }

  /**
   * Fixed-code extraction and Attachment Brief preparation happen before
   * Requirements. The older Agent analysis path remains in the repository for
   * compatibility, but is no longer invoked by this default generation flow.
   */
  async function prepareAttachmentContextForRequirements(
    workspace: WorkspaceResult,
    userBrief: string,
    options: {
      onPreflightComplete?: (results: UploadedSourcePreflightResult[]) => void;
      onProgress?: (state: AttachmentPreparationState) => void;
    } = {},
  ): Promise<AttachmentContext | null> {
    if (!backend) throw new Error("PPT backend is unavailable.");
    const active = (await backend.listUploadedSources({
      workspace_dir: workspace.workspace_dir,
      include_removed: false,
    })).active.filter(isMainWorkflowAttachmentSource);
    if (active.length === 0) return null;
    if (!attachmentBriefCompletionClient) throw new Error(t.errors.uploadedSourceAnalysisUnavailable);

    let sourceStates: NonNullable<AttachmentPreparationState["sourceStates"]> = active.map((source) => ({
      filename: source.display_name || source.original_filename,
      kind: [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(source.extension.toLowerCase())
        ? "image" as const
        : "document" as const,
      phase: "preflight" as const,
    }));
    const reportAttachmentProgress = (state: AttachmentPreparationState) => {
      if (state.phase === "requirements") {
        sourceStates = sourceStates.map((item) => ({ ...item, phase: "completed" as const }));
      } else if (state.sourceIndex >= 1 && state.sourceIndex <= sourceStates.length) {
        sourceStates = sourceStates.map((item, index) => index === state.sourceIndex - 1
          ? { ...item, phase: state.phase === "idle" ? "preflight" : state.phase }
          : item);
      }
      options.onProgress?.({ ...state, sourceStates });
    };

    reportAttachmentProgress({
      phase: "preflight",
      filename: "",
      sourceIndex: 0,
      sourceCount: active.length,
      insight: "",
    });
    setUploadedSourceAnalysisProgress(createUploadedSourceAnalysisProgress(t, {
      status: "running",
      sourceCount: active.length,
      message: t.status.analyzingUploadedSource,
    }));
    let preflightRun = await backend.runUploadedSourcePreflight({ workspace_dir: workspace.workspace_dir });
    options.onPreflightComplete?.(preflightRun.results);
    if (preflightRun.results.some((result) => result.pdf_ocr_progress?.status === "processing")) {
      const runtimeInfo = await backend.getRuntimeInfo();
      if (!runtimeInfo.uploaded_source_preflight?.pdf_ocr_continuation) {
        throw new Error(t.errors.pdfOcrContinuationUnsupported);
      }
    }
    while (preflightRun.results.some((result) => result.pdf_ocr_progress?.status === "processing")) {
      const processing = preflightRun.results.find((result) => result.pdf_ocr_progress?.status === "processing")!;
      const progress = processing.pdf_ocr_progress!;
      const sourceIndex = Math.max(1, active.findIndex((source) => source.uploaded_source_id === processing.source_id) + 1);
      reportAttachmentProgress({
        phase: "preflight",
        filename: processing.filename,
        sourceIndex,
        sourceCount: active.length,
        insight: "",
        ocrProgress: {
          processed: progress.processed_pages,
          total: progress.candidate_pages,
          currentPage: progress.current_page,
        },
      });
      await sleep(750);
      let continuationFinished = false;
      const statusPolling = (async () => {
        while (!continuationFinished) {
          await sleep(1_000);
          if (continuationFinished) break;
          const status = await backend.getUploadedSourcePreflightStatus({ workspace_dir: workspace.workspace_dir });
          if (continuationFinished) break;
          preflightRun = { ...preflightRun, results: status.results, completed_at: new Date().toISOString() };
          options.onPreflightComplete?.(status.results);
          const latest = status.results.find((result) => result.pdf_ocr_progress?.status === "processing");
          const latestProgress = latest?.pdf_ocr_progress;
          if (latest && latestProgress) {
            reportAttachmentProgress({
              phase: "preflight",
              filename: latest.filename,
              sourceIndex: Math.max(1, active.findIndex((source) => source.uploaded_source_id === latest.source_id) + 1),
              sourceCount: active.length,
              insight: "",
              ocrProgress: {
                processed: latestProgress.processed_pages,
                total: latestProgress.candidate_pages,
                currentPage: latestProgress.current_page,
              },
            });
          }
        }
      })().catch(() => undefined);
      let ocrContinuation;
      try {
        ocrContinuation = await backend.continueUploadedSourcePdfOcr({ workspace_dir: workspace.workspace_dir });
      } finally {
        continuationFinished = true;
        void statusPolling;
      }
      preflightRun = { ...preflightRun, results: ocrContinuation.results, completed_at: new Date().toISOString() };
      options.onPreflightComplete?.(preflightRun.results);
    }
    await ensureAttachmentBriefs({
      backend,
      completionClient: attachmentBriefCompletionClient,
      imageBriefClient,
      aiLogger,
      workspace,
      userBrief,
      preflightRun,
      onProgress: (event: AttachmentBriefProgress) => {
        reportAttachmentProgress({
          phase: event.phase === "completed"
            ? (event.insight ? "analyzing" : "reading")
            : event.phase,
          filename: event.filename,
          sourceIndex: event.sourceIndex,
          sourceCount: event.sourceCount,
          chunkIndex: event.chunkIndex,
          chunkCount: event.chunkCount,
          insight: event.insight ?? "",
        });
      },
    });
    reportAttachmentProgress({
      phase: "requirements",
      filename: "",
      sourceIndex: active.length,
      sourceCount: active.length,
      insight: "",
    });
    const context = await backend.getAttachmentContext({ workspace_dir: workspace.workspace_dir });
    if (!context || context.attachment_context.length !== active.length) {
      throw new Error("Attachment Context was not available after attachment processing.");
    }
    return context;
  }

  function applyRenderedDeck(
    result: RenderDeckHtmlResult,
    outlineItems?: WorkspaceOutlineItem[],
    options: { activateDeck?: boolean; preserveCurrentSlide?: boolean } = {},
  ) {
    const workspace = currentWorkspaceRef.current;
    const workspaceOutline = workspace?.outline as Partial<WorkspaceOutline> | null;
    const rendered = withOutlineTitles(result, outlineItems ?? (
      workspace?.workspace_dir === result.workspace_dir && Array.isArray(workspaceOutline?.items)
        ? workspaceOutline.items : []
    ));
    setGenerated(true);
    setDeckTitle(rendered.title);
    setDeck(
      rendered.slides.map((slide) => ({
        title: slide.title,
        subtitle: ""
      }))
    );
    if (outlineItems) setOutline(cloneOutlineItems(outlineItems));
    if (!options.preserveCurrentSlide) setCurrentSlide(0);
    if (options.activateDeck !== false) setStage("deck");
  }

  function applyWorkspace(
    workspace: WorkspaceResult,
    options: {
      syncEmptyContextRows?: boolean;
      preserveCurrentSlide?: boolean;
      reviewRenderResult?: RenderDeckHtmlResult;
    } = {}
  ) {
    if (currentWorkspaceRef.current?.workspace_dir !== workspace.workspace_dir) reviewPublicationRef.current += 1;
    const publication = reviewPublicationRef.current;
    currentWorkspaceRef.current = workspace;
    setCurrentWorkspace(workspace);
    setPresentationRequirements(workspace.requirements);
    setSelectedAspectRatio(normalizeSlideAspectRatio(workspace.requirements.selections.aspect_ratio));
    setSelectedVisualStylePresetId(workspace.requirements.selections.visual_style_preset?.id ?? null);
    setRequirementsStatus(workspace.requirements.status === "empty" ? "idle" : "ready");
    setRequirementsError("");
    setRequirementsErrorDetail("");
    setRequirementsDirty(false);
    setRequirementsHasSavedDraft(workspace.requirements.status !== "empty");
    if (workspace.requirements.source?.brief) {
      setPrompt(workspace.requirements.source.brief);
    }
    if (!exportInFlightRef.current) {
      setExportArtifactWithProgress(readWorkspaceExportArtifactPath(workspace));
    }
    const renderKey = workspaceReviewRenderKey(workspace);
    if (!options.reviewRenderResult) setReviewRender((current) =>
      current.renderKey === renderKey
        ? current
        : {
            status: "idle",
            result: null,
            error: "",
            renderKey
          }
    );
    setDeckTitle(getWorkspaceTitle(workspace));
    const workspaceOutline = workspaceOutlineToState(workspace.outline);
    const outlineRecord = workspace.outline && typeof workspace.outline === "object" && !Array.isArray(workspace.outline)
      ? workspace.outline as Partial<WorkspaceOutline>
      : null;
    const outlineStatus = outlineRecord?.status ?? "empty";
    const outlineTitle = typeof outlineRecord?.title === "string" && outlineRecord.title.trim()
      ? outlineRecord.title
      : getWorkspaceTitle(workspace);
    setOutlineDraftTitle(outlineTitle);
    setOutlineRequirements(outlineRecord?.global_creation_requirements ?? "");
    setOutlineDraftRequirements(outlineRecord?.global_creation_requirements ?? "");
    setOutlineError("");
    setOutlineErrorDetail("");
    if (workspaceOutline.length === 0) {
      setOutline([]);
      setOutlineDraft([]);
      setOutlineRequirements("");
      setOutlineDraftRequirements("");
    }
    const staleDeck = isWorkspaceDeckStale(workspace);
    const workspacePageProgress = normalizeWorkspacePageProgress(workspace.page_progress);
    const generationPageProgress = workspacePageProgress && workspacePageProgress.pages.length > 0
      ? workspacePageProgress
      : null;
    const completedDeckAvailable = completedDeckIsAvailable(staleDeck, generationPageProgress);
    // An old, incomplete snapshot can retain the rendered page manifest and
    // progress table while losing outline.json. Do not synthesize or write an
    // outline here: that would hide the inconsistency and could overwrite the
    // user's original outline. The completed pages are still useful for a
    // read-only recovery view, so give the deck navigator stable placeholder
    // labels until rendered metadata supplies the real titles.
    const recoveredDeck = generationPageProgress?.pages.map((page, index) => ({
      title: pickLocale(locale, {
        zh: `第 ${index + 1} 页`,
        en: `Slide ${index + 1}`,
        ja: `${index + 1} ページ目`,
        de: `Folie ${index + 1}`,
      }),
      subtitle: "",
    })) ?? [];
    setPageProgress(workspacePageProgress);
    setCreateDeckProgress(
      restoreDeckGenerationProgress({
        staleDeck,
        pageProgress: generationPageProgress,
        locale,
        outline: outlineRecord?.status === "confirmed" ? outlineRecord as WorkspaceOutline : null,
      })
    );
    if (completedDeckAvailable) {
      setDeck(
        workspaceOutline.length > 0
          ? workspaceOutline.map((item) => ({ title: item.title, subtitle: "" }))
          : recoveredDeck,
      );
      if (options.reviewRenderResult) {
        applyRenderedDeck(options.reviewRenderResult, undefined, {
          activateDeck: false, preserveCurrentSlide: options.preserveCurrentSlide,
        });
        setReviewRender({
          status: "ready",
          result: options.reviewRenderResult,
          error: "",
          renderKey,
        });
      } else {
        setReviewRender({
          status: "loading",
          result: null,
          error: "",
          renderKey,
        });
      }
    }
    if (completedDeckAvailable && backend && !options.reviewRenderResult) {
      void (async () => {
        try {
          const metadata = withOutlineTitles(
            await backend.getRenderedDeckHtml({ workspace_dir: workspace.workspace_dir, allow_partial: true }),
            Array.isArray(outlineRecord?.items) ? outlineRecord.items : workspaceOutline,
          );
          if (currentWorkspaceRef.current?.workspace_dir !== workspace.workspace_dir ||
            reviewPublicationRef.current !== publication ||
            workspaceReviewRenderKey(currentWorkspaceRef.current) !== renderKey) return;
          applyRenderedDeck(metadata, undefined, { activateDeck: false, preserveCurrentSlide: true });
          setReviewRender({ status: "ready", result: metadata, error: "", renderKey });
          const firstPageId = metadata.slides[0]?.slide_id;
          const firstPage = await assembleMeasuredReviewRender({
            backend,
            metadata,
            workspaceDir: workspace.workspace_dir,
            previews: generationPagePreviewsRef.current,
            pageIds: firstPageId ? [firstPageId] : undefined,
          });
          if (
            currentWorkspaceRef.current?.workspace_dir !== workspace.workspace_dir ||
            reviewPublicationRef.current !== publication ||
            workspaceReviewRenderKey(currentWorkspaceRef.current) !== renderKey
          ) return;
          generationPagePreviewsRef.current = firstPage.previews;
          setGenerationPagePreviews(firstPage.previews);
          applyRenderedDeck(firstPage.result, undefined, { activateDeck: false, preserveCurrentSlide: true });
          setReviewRender({
            status: "ready",
            result: firstPage.result,
            error: "",
            renderKey,
          });
        } catch (error) {
          if (
            currentWorkspaceRef.current?.workspace_dir !== workspace.workspace_dir ||
            reviewPublicationRef.current !== publication ||
            workspaceReviewRenderKey(currentWorkspaceRef.current) !== renderKey
          ) return;
          setReviewRender({
            status: "error",
            result: null,
            error: error instanceof Error ? error.message : t.review.renderFailed,
            renderKey,
          });
        }
      })();
    }
    setGenerated(completedDeckAvailable);
    if (!options.preserveCurrentSlide) setCurrentSlide(0);
    if (staleDeck) {
      setStage("outline");
    }
    if (workspaceOutline.length > 0) {
      setOutline(workspaceOutline);
      setOutlineDraft(cloneOutlineItems(workspaceOutline));
      if (completedDeckAvailable) {
        setStage("deck");
      } else if (generationPageProgress && !staleDeck) {
        setStage("generating");
      } else {
        setStage("outline");
      }
      if (outlineStatus === "draft") setStage("outline");
    }
    const templateRecord =
      workspace.template && typeof workspace.template === "object" && !Array.isArray(workspace.template)
        ? (workspace.template as { selected_template_group?: unknown })
        : null;
    const selectedTemplate =
      typeof templateRecord?.selected_template_group === "string" && templateRecord.selected_template_group
        ? templateRecord.selected_template_group
        : DEFAULT_TEMPLATE_GROUP_ID;
    if (selectedTemplate) {
      setSelectedTemplateGroupId(selectedTemplate);
      if (workspaceOutline.length === 0) {
        setStage(
          workspace.requirements.status === "empty"
            ? "brief"
            : workspace.requirements.status === "draft"
              ? "requirements"
              : "outline"
        );
      }
    }

    const requirementsRecoveryStage = requirementsOwnedRecoveryStage(workspace.requirements);
    if (requirementsRecoveryStage) setStage(requirementsRecoveryStage);

    const persistedContextRows = workspaceContextRowsToState(workspace);
    if (persistedContextRows.shouldSync || options.syncEmptyContextRows) {
      setContextRows(persistedContextRows.rows);
    }
  }

  function applyCreatedWorkspace(
    result: Awaited<ReturnType<PptBackend["createWorkspace"]>>,
    options: { preserveWorkflowState?: boolean } = {},
  ): WorkspaceResult {
    const preserveWorkflowState = options.preserveWorkflowState === true;
    const workspace = createInitialWorkspaceSnapshot(result);
    // The first multi-file selection retains the callback from the render where
    // there was no Workspace yet. Update the ref synchronously so each later
    // file in that same selection reuses this Workspace instead of creating a
    // separate one before React has rendered the state update.
    currentWorkspaceRef.current = workspace;
    setCurrentWorkspace(workspace);
    setUploadedSources([]);
    setUploadedSourcePreflights([]);
    setUploadedSourcePreflightRunning(false);
    setCurrentUploadedSourceAnalysis(null);
    setUploadedSourceAnalysisError("");
    setUploadedSourceAnalysisProgress(createSkippedUploadedSourceAnalysisProgress(t));
    setSelectedStyleProfile(null);
    setExportArtifactWithProgress(null);
    setReviewRender({
      status: "idle",
      result: null,
      error: "",
      renderKey: createWorkspaceReviewRenderKey(workspace),
    });
    if (!preserveWorkflowState) setPrompt("");
    setContextRows([]);
    if (!preserveWorkflowState) {
      setPresentationRequirements(workspace.requirements);
      setRequirementsStatus("idle");
      setSelectedAspectRatio(normalizeSlideAspectRatio(workspace.requirements.selections.aspect_ratio));
      setRequirementsError("");
      setRequirementsErrorDetail("");
    }
    setRequirementsSaving(false);
    setRequirementsDirty(false);
    setRequirementsHasSavedDraft(false);
    resetWebResearchProgress();
    setDeckTitle(result.title);
    setDeck([]);
    setOutline([]);
    setOutlineDraft([]);
    setOutlineRequirements("");
    setOutlineDraftRequirements("");
    setOutlineDraftTitle(result.title);
    setOutlineError("");
    setOutlineErrorDetail("");
    setOutlineFeedback("");
    setGenerated(false);
    setCurrentSlide(0);
    setPageProgress(null);
    setCreateDeckProgress(null);
    setGenerationHistory([]);
    setActiveGenerationRun(null);
    resetGenerationPagePreviews();
    setSelectedTemplateGroupId(DEFAULT_TEMPLATE_GROUP_ID);
    if (!preserveWorkflowState) setStage("brief");
    resetGenerationUiState();

    return workspace;
  }

  useEffect(() => {
    let cancelled = false;
    let nextAgentClient: AgentClient | null = null;

    async function initializeClients() {
      try {
        const [nextBackend, runtime] = await Promise.all([
          createPptBackend(),
          connectHostRuntime()
        ]);
        // Start the cheap, user-visible workspace scan before Agent client
        // setup. The My Works list should not wait for unrelated AI plumbing.
        const initialWorkspaceScan = nextBackend.listWorkspaces();
        nextAgentClient = await createAgentClient(runtime, {
          toolAccessPolicy: AGENT_TOOL_ACCESS_POLICY,
          locale,
        });
        const nextAiClient = await createAiClient(runtime, nextAgentClient);
        const nextHostUploadClient = createAppHostUploadClient(runtime, {
          appendWorkspaceLog: (event) => event.user_template_id
            ? nextBackend.appendUserTemplateLog({ id: event.user_template_id, channel: "storage-transport", entry: event.entry })
            : nextBackend.appendWorkspaceLog({
            workspace_dir: event.workspace_dir,
            channel: "storage-transport",
            entry: event.entry,
          }),
        });
        const nextResearchAiClient = createResearchAiClient(runtime);
        const nextPageRefinementClassifier = createPageRefinementClassifier(runtime);
        const nextResearchWebClient = createResearchWebClient(runtime, {
          appendWorkspaceLog: (input) => nextBackend.appendWorkspaceLog(input),
        });
        const nextWebResearchLabWebClient = createResearchWebClient(runtime, {
          appendWorkspaceLog: async () => ({
            workspace_dir: "",
            log_file: "",
            appended: true as const,
          }),
        });
        if (cancelled) return;
        setBackend(nextBackend);
        setHostUploadClient(nextHostUploadClient);
        setHostFileDownloadClient(createAppHostFileDownloadClient(runtime));
        setAiClient(nextAiClient);
        setAttachmentBriefCompletionClient(createAttachmentBriefCompletionClient(runtime));
        setImageBriefClient(createImageAttachmentBriefClient(runtime));
        setResearchAiClient(nextResearchAiClient);
        setPageRefinementClassifier(nextPageRefinementClassifier);
        setResearchWebClient(nextResearchWebClient);
        setWebResearchLabWebClient(nextWebResearchLabWebClient);
        setAgentClient(nextAgentClient);
        if (PERFORMANCE_TESTING_ENABLED) {
          void nextBackend.listPerformanceRuns().then((result) => {
            if (!cancelled) {
              setPerformanceTesting((current) => ({
                ...current,
                supported: true,
                loading: false,
                error: "",
                activeRun: result.active_run,
                runs: result.runs,
              }));
            }
          }).catch((error) => {
            if (!cancelled) {
              setPerformanceTesting((current) => ({
                ...current,
                supported: false,
                loading: false,
                error: error instanceof Error ? error.message : t.performance.unavailable,
              }));
            }
          });
        }
        void nextBackend.getRuntimeInfo().then((result) => {
          if (!cancelled) {
            setRuntimeInfo(result);
            setRuntimeInfoError("");
          }
        }).catch((error) => {
          if (!cancelled) {
            setRuntimeInfo(null);
            setRuntimeInfoError(error instanceof Error ? error.message : "Failed to read runtime version.");
          }
        });
        if (AGENT_RESOURCE_INFO_ENABLED) {
          void nextBackend.getAgentResourceInfo().then((result) => {
            if (!cancelled) {
              setAgentResourceInfo({ enabled: true, loading: false, error: "", info: result });
            }
          }).catch((error) => {
            if (!cancelled) {
              setAgentResourceInfo((current) => ({
                ...current,
                loading: false,
                error: error instanceof Error ? error.message : t.library.agentResourceInfoUnavailable,
              }));
            }
          });
        }
        const scan = await initialWorkspaceScan;
        if (cancelled) return;
        setWorkspaceScan(scan);
        // The workspace list is the first usable shell. Do not keep the whole
        // application in its loading state while unrelated settings hydrate.
        setWorkspaceLoading(false);
        const defaults = await nextBackend.getWorkspaceDefaults();
        if (cancelled) return;
        setGlobalSettings(defaults.setting);
      } catch (error) {
        if (!cancelled) {
          setWorkspaceError(
            error instanceof Error ? error.message : "Failed to scan tasks."
          );
        }
      } finally {
        if (!cancelled) {
          setWorkspaceLoading(false);
        }
      }
    }

    void initializeClients();

    return () => {
      cancelled = true;
      // close() is a no-op (sessions are run-scoped); cancelActiveRuns() is what
      // actually aborts in-flight agent runs. On unmount/refresh this kills any
      // orphaned C-line (or generation) session so it can't keep running and
      // timing out in the background after the page is gone.
      void nextAgentClient?.cancelActiveRuns()
        .catch(() => undefined)
        .finally(() => { void nextAgentClient?.close(); });
    };
  }, []);

  /**
   * Page screenshots live in whichever Workspace the run writes to, which is the
   * Shadow Workspace while a run is in flight and the official Workspace once it
   * committed. Reading it from the run keeps the preview working mid-run, when
   * the official Workspace has no rendered pages yet.
   */
  const generationPreviewWorkspaceDir =
    activeGenerationRun?.shadowWorkspaceDir ?? currentWorkspace?.workspace_dir ?? "";

  function resetGenerationPagePreviews() {
    generationPagePreviewSessionRef.current += 1;
    generationPagePreviewsRef.current = {};
    generationPreviewHeldPageIdsRef.current = new Set();
    setGenerationPagePreviews({});
    setPinnedGenerationPreviewPageId(null);
  }

  /**
   * The panel opens as the whole deck rather than just the pages in flight:
   * untouched pages keep the image the user is already looking at, and the
   * pages the run will rewrite hold a placeholder over theirs.
   */
  function showRefinementLoadingPreviews(
    scope: RefineScope,
    items: readonly WorkspaceOutlineItem[],
    targetPageId: string | undefined,
  ) {
    const pages = items.flatMap((item, pageIndex) => {
      const pageId = item.page_id?.trim() ?? "";
      if (!pageId) return [];
      return [{ pageId, pageIndex, title: item.title }];
    });
    // A deck refinement only knows which pages it rewrites once its plan
    // commits, so nothing is held back until the run reports its targets.
    const targetPageIds = scope === "slide" && targetPageId ? [targetPageId] : [];
    const previews = createRunGenerationPagePreviews({
      pages,
      targetPageIds,
      slides: reviewRender.result?.slides,
      previous: generationPagePreviewsRef.current,
    });
    generationPagePreviewSessionRef.current += 1;
    generationPagePreviewsRef.current = previews;
    generationPreviewHeldPageIdsRef.current = new Set(targetPageIds);
    setGenerationPagePreviews(previews);
    setPinnedGenerationPreviewPageId(targetPageId ?? pages[0]?.pageId ?? null);
  }

  function releaseGenerationPagePreviewHolds() {
    const released = releaseAwaitingGenerationPagePreviews(generationPagePreviewsRef.current);
    if (released === generationPagePreviewsRef.current) return;
    generationPagePreviewsRef.current = released;
    setGenerationPagePreviews(released);
  }

  useEffect(() => {
    if (!backend || !generationPreviewWorkspaceDir) return;
    // Starting a Shadow Workspace and publishing its first progress snapshot
    // are separate async steps. Keep the seeded refinement previews during
    // that gap; reconciling `null` as an empty page list would discard the
    // target page's hold and let the next snapshot fetch its old screenshot.
    if (!createDeckProgress) return;

    const sources = selectGenerationPagePreviewSources(createDeckProgress);
    const held = generationPreviewHeldPageIdsRef.current;
    const lockPageIds = (createDeckProgress?.targetPageIds ?? []).filter(
      (pageId) => !held.has(pageId),
    );
    const { previews, pending, changed } = reconcileGenerationPagePreviews(
      generationPagePreviewsRef.current,
      sources,
      lockPageIds,
    );
    for (const pageId of lockPageIds) held.add(pageId);
    if (!changed) return;

    // Ready here means a current snapshot exists. Components own its loading.
    for (const source of pending) {
      const entry = previews[source.pageId];
      if (entry) previews[source.pageId] = { ...entry, status: "ready" };
    }
    generationPagePreviewsRef.current = previews;
    setGenerationPagePreviews(previews);
  }, [backend, createDeckProgress, generationPreviewWorkspaceDir]);

  function recordGenerationProgress(progress: DeckGenerationProgress) {
    setCreateDeckProgress(progress);
    const snapshot: GenerationStreamSnapshot =
      createDeckGenerationStreamSnapshot(progress, locale);
    setGenerationHistory((items) => {
      const existingIndex = items.findIndex((item) => item.id === snapshot.id);
      if (existingIndex === -1) return [...items, snapshot];
      return items.map((item, index) => (index === existingIndex ? snapshot : item));
    });
  }

  function resetGenerationProgress(options: { preservePagePreviews?: boolean } = {}) {
    setCreateDeckProgress(null);
    setGenerationHistory([]);
    if (!options.preservePagePreviews) resetGenerationPagePreviews();
    resetGenerationUiState();
  }

  function generationProgressHandler(signal: AbortSignal) {
    return createOperationScopedProgressHandler(
      signal,
      ownsGenerationOperation,
      recordGenerationProgress,
    );
  }

  function resetGenerationUiState() {
    setGenerationPreparing(false);
    setGenerationUnresumable(false);
    setGenerationResumeAllowed(true);
  }

  function beginCancellableGeneration() {
    cancelCreateDeckRef.current = false;
    cancelCreateDeckAbortRef.current?.abort();
    const controller = new AbortController();
    cancelCreateDeckAbortRef.current = controller;
    const operationId = generationOperationRef.current + 1;
    generationOperationRef.current = operationId;
    generationSignalOperationsRef.current.set(controller.signal, operationId);
    return controller.signal;
  }

  function ownsGenerationOperation(signal: AbortSignal) {
    return generationSignalOperationsRef.current.get(signal) === generationOperationRef.current;
  }

  function beginActiveGenerationRun(kind: ActiveGenerationRunKind, transaction: GenerationRunTransaction) {
    setGenerationUnresumable(false);
    setGenerationResumeAllowed(kind === "deck-generation");
    setActiveGenerationRun({
      kind,
      runId: transaction.run_id,
      officialWorkspaceDir: transaction.official_workspace_dir,
      shadowWorkspaceDir: transaction.shadow_workspace_dir,
      stopping: false,
      committing: false,
    });
    setGenerationTransaction(transaction);
  }

  async function prepareShadowGenerationRun(
    workspace: WorkspaceResult,
    kind: ActiveGenerationRunKind,
    originPageId?: string | null,
    onStarted?: (transaction: GenerationRunTransaction) => void,
  ) {
    if (!backend) throw new Error("PptBackend is not available.");
    const transaction = await backend.beginGenerationRun({
      workspace_dir: workspace.workspace_dir,
      run_kind: kind,
      origin_page_id: originPageId,
    });
    if (cancelCreateDeckRef.current) {
      // Abandoned while this call was in flight. Nothing has been prepared yet,
      // so fence the run instead of adopting it into the UI. The transaction is
      // retained with any partial shadow content for a later diagnostic bundle.
      await backend.abandonGenerationRun({ run_id: transaction.run_id }).catch(() => undefined);
      throw new Error(
        kind === "deck-generation"
          ? t.generating.abandon.generationStopped
          : t.generating.abandon.refinementStopped,
      );
    }
    onStarted?.(transaction);
    beginActiveGenerationRun(kind, transaction);
    let prepared;
    try {
      prepared = await backend.prepareGenerationRun({ run_id: transaction.run_id });
    } catch (error) {
      await backend.abandonGenerationRun({ run_id: transaction.run_id }).catch(() => undefined);
      setGenerationTransaction(null);
      throw error;
    }
    if (prepared.transaction.state === "abandoned" || !prepared.workspace) {
      // GEN-008: resolved at throw time so the message follows the active locale.
      throw new Error(
        kind === "deck-generation"
          ? t.generating.abandon.generationStopped
          : t.generating.abandon.refinementStopped,
      );
    }
    setGenerationPreparing(false);
    return { transaction: prepared.transaction, workspace: prepared.workspace };
  }

  function rebaseCompletion<T>(value: T, from: string, to: string): T {
    return JSON.parse(JSON.stringify(value).split(from).join(to)) as T;
  }

  async function commitShadowGenerationRun(transaction: GenerationRunTransaction) {
    if (!backend) throw new Error("PptBackend is not available.");
    setGenerationTransaction({ ...transaction, state: "committing" });
    setActiveGenerationRun((current) => current ? { ...current, committing: true } : current);
    try {
      const operationName = transaction.run_kind === "deck-generation"
        ? "generation.commit"
        : "deck_refinement.commit";
      return await measurePerformanceOperation(
        operationName,
        transaction.shadow_workspace_dir,
        () => backend.commitGenerationRun({ run_id: transaction.run_id }),
      );
    } catch (error) {
      const { summary } = summarizeUserFacingError(t, error, t.generating.commitFailed.body);
      await requestConfirmation({
        title: t.generating.commitFailed.title,
        body: `${summary}\n\n${t.generating.commitFailed.restored}`,
        confirmLabel: t.generating.commitFailed.confirm,
        tone: "warning",
      });
      const official = await backend.openWorkspace({ workspace_dir: transaction.official_workspace_dir });
      applyWorkspace(official, { preserveCurrentSlide: true });
      setGenerationTransaction(null);
      throw error;
    }
  }

  async function finishActiveGenerationRun(options: {
    workspaceDir?: string;
    reconcileInterrupted?: boolean;
  } = {}) {
    setActiveGenerationRun(null);
    if (!options.reconcileInterrupted || !backend) return;
    const workspaceDir = options.workspaceDir ?? currentWorkspace?.workspace_dir;
    if (!workspaceDir) return;
    try {
      const refreshedWorkspace = await backend.openWorkspace({
        workspace_dir: workspaceDir,
      });
      const reconciledWorkspace = await reconcileWorkspaceInterruptedPages(refreshedWorkspace);
      applyWorkspace(reconciledWorkspace);
    } catch (error) {
      console.warn(
        "Failed to reconcile interrupted pages after generation finished",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const generationViewState = useMemo(
    () =>
      buildGenerationViewState({
        loading,
        progress: createDeckProgress,
        activeRun: activeGenerationRun,
        preparing: generationPreparing,
        unresumable: generationUnresumable,
        resumeAllowed: generationResumeAllowed,
      }),
    [activeGenerationRun, createDeckProgress, generationPreparing, generationResumeAllowed, generationUnresumable, loading],
  );

  function isGenerationInFlight() {
    return generationInFlight({
      activeRun: activeGenerationRun,
      hasTransaction: generationTransaction !== null,
      preparing: generationPreparing,
      loading,
    });
  }

  const currentStatus = useMemo(() => {
    if (loading === "template") return t.template.loading;
    if (loading === "requirements") return t.requirements.loadingTitle;
    if (loading === "webResearch") {
      return webResearchStatus === "preparing"
        ? t.webResearch.preparing
        : webResearchProgress?.message ?? t.webResearch.running;
    }
    if (loading === "theme") {
      return t.status.customizingTheme;
    }
    if (loading === "uploadedSourceAnalysis") return t.status.analyzingUploadedSource;
    if (loading === "outline") return t.status.creatingOutline;
    if (loading === "outlineRewrite") return t.outline.rewritingTitle;
    if (generationViewState.status === "preparing") {
      return t.generating.preparingTitle;
    }
    if (generationViewState.status === "running") {
      return t.status.creatingDeck;
    }
    if (generationViewState.status === "stopping") return t.generating.cancelling;
    if (stage === "generating" && generationViewState.status === "interrupted") {
      return t.generating.interruptedTitle;
    }
    if (stage === "generating" && generationViewState.status === "unresumable") {
      return t.generating.unresumableTitle;
    }
    if (loading === "review") return t.review.rendering;
    if (loading === "refineDeck") return t.status.refiningDeck;
    if (loading === "refineSlide") return t.status.refiningSlide;
    if (loading === "export") return t.status.exporting;
    if (stage === "uploaded-source-analysis") return uploadedSourceAnalysisProgress.message;
    if (stage === "web-research") {
      if (webResearchStatus === "idle") return t.webResearch.noHistory;
      if (webResearchStatus === "preparing") return t.webResearch.preparing;
      if (webResearchStatus === "running") return webResearchProgress?.message ?? t.webResearch.running;
      if (webResearchStatus === "error") return t.webResearch.errorTitle;
      return t.webResearch.completed;
    }
    if (stage === "generating") return createDeckProgress?.message ?? t.status.creatingDeck;
    if (stage === "outline") return t.status.outlineReady;
    if (generated) return deckReadyStatus(t, deck.length);
    return "";
  }, [createDeckProgress?.message, deck.length, generated, generationViewState.status, loading, locale, stage, t, uploadedSourceAnalysisProgress.message, webResearchProgress?.message, webResearchStatus]);

  const uploadedSourceAnalysisState = useMemo<UploadedSourceAnalysisViewState>(() => {
    if (uploadedSources.length === 0) {
      return createEmptyUploadedSourceAnalysisViewState();
    }
    if (loading === "uploadedSourceAnalysis") {
      return {
        status: "analyzing",
        sourceCount: uploadedSources.length,
        factCount: null,
        visualAssetCount: null,
        gapCount: null,
      };
    }
    if (uploadedSourceAnalysisError) {
      return {
        status: "error",
        sourceCount: uploadedSources.length,
        factCount: null,
        visualAssetCount: null,
        gapCount: null,
        reason: uploadedSourceAnalysisError,
      };
    }

    if (currentUploadedSourceAnalysis) {
      const currentDependency = createUploadedSourceAnalysisDependency(currentUploadedSourceAnalysis);
      if (uploadedSourceDependencyMatchesActiveSources({
        dependency: currentDependency,
        uploadedSources,
      })) {
        const blocked =
          currentUploadedSourceAnalysis.status === "blocked" ||
          !currentUploadedSourceAnalysis.continuation_decision.can_continue;
        return {
          status: blocked ? "blocked" : currentUploadedSourceAnalysis.status,
          sourceCount: uploadedSources.length,
          factCount: currentUploadedSourceAnalysis.facts.length,
          visualAssetCount: currentUploadedSourceAnalysis.visual_assets.length,
          gapCount: currentUploadedSourceAnalysis.gaps.length,
          reason: blocked ? currentUploadedSourceAnalysis.continuation_decision.reason : undefined,
        };
      }
      return {
        status: "stale",
        sourceCount: uploadedSources.length,
        factCount: null,
        visualAssetCount: null,
        gapCount: null,
      };
    }

    const outlineDependency = readWorkspaceUploadedSourceDependency(currentWorkspace);
    if (outlineDependency) {
      return {
        status: uploadedSourceDependencyMatchesActiveSources({
          dependency: outlineDependency,
          uploadedSources,
        }) ? outlineDependency.status : "stale",
        sourceCount: uploadedSources.length,
        factCount: null,
        visualAssetCount: null,
        gapCount: null,
      };
    }

    return {
      status: "pending",
      sourceCount: uploadedSources.length,
      factCount: null,
      visualAssetCount: null,
      gapCount: null,
    };
  }, [
    currentUploadedSourceAnalysis,
    currentWorkspace,
    loading,
    uploadedSourceAnalysisError,
    uploadedSources,
  ]);

  function showToast(message: string) {
    setToast(invokeTimeoutSummary(t, message, message));
    window.setTimeout(() => setToast(""), 2400);
  }

  function resolveConfirmation(confirmed: boolean) {
    const resolve = confirmationResolverRef.current;
    confirmationResolverRef.current = null;
    setConfirmationDialog(null);
    resolve?.(confirmed);
  }

  function requestConfirmation(request: Omit<ConfirmationDialogRequest, "closeLabel">) {
    confirmationResolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      confirmationResolverRef.current = resolve;
      setConfirmationDialog({
        ...request,
        closeLabel: t.controls.close,
      });
    });
  }

  useEffect(() => () => {
    confirmationResolverRef.current?.(false);
    confirmationResolverRef.current = null;
  }, []);

  async function canLeaveCurrentEditor() {
    const dirty = (stage === "requirements" && requirementsDirty) || (stage === "outline" && outlineDirty);
    if (!dirty) return true;
    return requestConfirmation({
      title: t.dialogs.discardChanges.title,
      body: t.dialogs.discardChanges.body,
      cancelLabel: t.dialogs.discardChanges.cancel,
      confirmLabel: t.dialogs.discardChanges.confirm,
      tone: "danger",
    });
  }

  async function refreshWorkspaceSnapshotSyncStateForCard(workspaceDir: string) {
    if (!backend) return;
    try {
      const syncState = await backend.getWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
      const workspaceId = syncState?.workspace_id
        ?? (currentWorkspaceRef.current?.workspace_dir === workspaceDir
          ? currentWorkspaceRef.current.workspace_id
          : null);
      if (workspaceId) {
        setWorkspaceSyncStates((current) => ({
          ...current,
          [workspaceId]: syncState,
        }));
      }
      if (currentWorkspaceRef.current?.workspace_dir === workspaceDir) {
        setWorkspaceSnapshotSyncState(syncState);
      }
    } catch (error) {
      // The card is deliberately best-effort. A status read must never turn a
      // completed user action into a user-facing notification.
      console.warn("[snapshot-publish-dedicated-invoke] status refresh failed", error);
    }
  }

  function publishSnapshotFromNav(trigger: string) {
    if (!backend || !currentWorkspace) return;
    const workspaceDir = currentWorkspace.workspace_dir;
    const publish = backend.runWorkspaceSnapshotPublishDedicatedInvoke({
      workspace_dir: workspaceDir,
      trigger,
    });
    // The engine persists queued/uploading/failed/completed state locally.
    // Read it for the My Works card, rather than showing the old transient
    // bottom-right retry notice. A second read below catches the terminal
    // state after this invoke releases its storage authorization.
    void refreshWorkspaceSnapshotSyncStateForCard(workspaceDir);
    void publish.then((result) => {
      console.info("[snapshot-publish-dedicated-invoke] completed", result);
      return refreshWorkspaceSnapshotSyncStateForCard(workspaceDir);
    }).catch((error) => {
      console.warn("[snapshot-publish-dedicated-invoke] failed", error);
      return refreshWorkspaceSnapshotSyncStateForCard(workspaceDir);
    });
  }

  async function navigate(nextPage: PageId) {
    if (batchTesting.busy) return;
    if (isGenerationInFlight()) return;
    if (nextPage !== page && !await canLeaveCurrentEditor()) return;
    if (!generated && nextPage !== "main" && nextPage !== "my-work" && nextPage !== "my-templates" && nextPage !== "batch-testing" && nextPage !== "web-research-lab" && nextPage !== "settings" && nextPage !== "performance-report") {
      showToast(t.toasts.createDeckFirst);
      return;
    }

    if (nextPage === "settings" && page !== "settings") {
      invalidateWorkspaceDiagnosticBundle();
      templateDiagnosticBundle.reset();
      setTemplateDiagnosticMode(page === "my-templates");
    }
    setPage(nextPage);
    if (nextPage === "my-templates") void userTemplates.refresh();
    console.log(`[snapshot-trigger] #4 nav ${page} -> ${nextPage}`);
    publishSnapshotFromNav(`navigation:${page}->${nextPage}`);
    setHistory((items) =>
      items.at(-1) === nextPage ? items : [...items, nextPage]
    );
    if (nextPage === "my-work") {
      // Publish the page immediately; covers continue to hydrate independently.
      void refreshMyWork();
    }
    if (nextPage === "export") {
      void resumePptxExportJob();
    }
    if (nextPage === "review") {
      const renderKey = currentWorkspace ? workspaceReviewRenderKey(currentWorkspace) : "";
      const hasCurrentRender =
        reviewRender.status === "ready" &&
        reviewRender.result !== null &&
        reviewRender.renderKey === renderKey;
      if (!hasCurrentRender && currentWorkspace) {
        void loadDeckHtmlForWorkspace(currentWorkspace, "review");
      }
    }
  }

  /**
   * GEN-003: the header entries stay clickable during a run. Confirming reuses
   * the Generation Abandonment flow, which per ADR-0041 restores the
   * pre-generation Outline, and then lands on My Works whichever entry was
   * clicked, so the restored Workspace is visible instead of half-open.
   */
  async function navigateFromHeader(nextPage: PageId) {
    if (batchTesting.busy) return;
    if (isGenerationInFlight()) {
      await cancelGenerateDeck({ landOnMyWork: true });
      return;
    }
    if (preparationInFlight(loading) && !await abandonPreparation()) return;
    await navigate(nextPage);
  }

  /**
   * The home entry starts a new deck, which would silently strand a run that is
   * still going. Whichever page it is clicked from, work in flight has to be
   * abandoned through the confirmation first, worded for leaving rather than for
   * the stop entry.
   */
  async function goHomeFromHeader() {
    console.log("[snapshot-trigger] #4 exit-home");
    publishSnapshotFromNav("header-home");
    if (batchTesting.busy) return;
    if (isGenerationInFlight()) {
      await cancelGenerateDeck({ landOnMyWork: true, copy: "home" });
      return;
    }
    if (preparationInFlight(loading) && !await abandonPreparation()) return;
    await startNewPresentation();
  }

  /**
   * Requirements analysis, Outline creation and uploaded source analysis have no
   * durable run to abandon, but they do write Workspace state and stage when they
   * land, which used to drag the user back onto the step they had left. Bumping
   * the operation epochs makes those late landings no-ops.
   */
  async function abandonPreparation() {
    const home = t.generating.abandon.home;
    const confirmed = await requestConfirmation({
      title: home.preparationTitle,
      body: home.preparationBody,
      cancelLabel: home.preparationCancel,
      confirmLabel: home.confirm,
      tone: "danger",
    });
    if (!confirmed) return false;
    requirementsOperationRef.current += 1;
    outlineOperationRef.current += 1;
    pendingUploadedSourceAnalysisActionRef.current = null;
    // Drop any parked C-line kickoff so it can't block a fresh one on the next deck.
    uploadedSourceAnalysisKickoffRef.current = null;
    setLoading("none");
    return true;
  }

  async function openRefineDeck() {
    if (!generated) {
      showToast(t.toasts.createDeckFirst);
      return;
    }

    setRefineScope("deck");
    setPage("refine");
    setHistory((items) =>
      items.at(-1) === "refine" ? items : [...items, "refine"]
    );

    if (!currentWorkspace) return;
    const renderKey = workspaceReviewRenderKey(currentWorkspace);
    const hasCurrentRender =
      reviewRender.status === "ready" &&
      reviewRender.result !== null &&
      reviewRender.renderKey === renderKey;
    if (hasCurrentRender) return;
    await loadDeckHtmlForWorkspace(currentWorkspace, "review");
  }

  async function openRefineSlide(index: unknown = currentSlide) {
    if (!generated) {
      showToast(t.toasts.createDeckFirst);
      return;
    }

    const targetIndex = resolveRefineSlideIndex(index, currentSlide, deck.length);
    setCurrentSlide(targetIndex);
    setRefineScope("slide");
    setPage("refine");
    setHistory((items) =>
      items.at(-1) === "refine" ? items : [...items, "refine"]
    );

    if (!currentWorkspace) return;

    const renderKey = workspaceReviewRenderKey(currentWorkspace);
    const hasCurrentSlidePreview =
      reviewRender.status === "ready" &&
      reviewRender.result !== null &&
      reviewRender.renderKey === renderKey &&
      Boolean(reviewRender.result.slides[targetIndex]?.html_path);
    if (hasCurrentSlidePreview) return;

    const rendered = await loadDeckHtmlForWorkspace(currentWorkspace, "review");
    if (rendered) {
      setCurrentSlide(targetIndex);
    }
  }

  async function navigateMain(nextStage: MainStage) {
    if (batchTesting.busy) return;
    if (isGenerationInFlight()) return;
    if (nextStage !== stage && !await canLeaveCurrentEditor()) return;
    if (stage === "requirements" && requirementsStatus === "loading" && nextStage !== "requirements") {
      requirementsOperationRef.current += 1;
      setLoading("none");
    }
    if (nextStage === "requirements" && presentationRequirements.status === "empty") {
      showToast(t.toasts.promptRequired);
      return;
    }
    if (nextStage === "uploaded-source-analysis" && uploadedSources.length === 0) {
      setUploadedSourceAnalysisProgress(createSkippedUploadedSourceAnalysisProgress(t));
    }
    if (nextStage === "web-research" && currentWorkspace?.requirements.status !== "confirmed") {
      showToast(t.toasts.confirmRequirementsFirst);
      return;
    }
    if (nextStage === "outline") {
      if (!confirmedRequirementsAllowOutline(currentWorkspace?.requirements)) {
        showToast(t.toasts.confirmRequirementsFirst);
        return;
      }
      if (outline.length === 0) {
        showToast(t.toasts.createOutlineFirst);
        return;
      }
    }
    if (nextStage === "generating" && !createDeckProgress) {
      showToast(t.toasts.createDeckFirst);
      return;
    }
    if (nextStage === "deck" && !generated) {
      showToast(t.toasts.createDeckFirst);
      return;
    }
    setPage("main");
    setStage(nextStage);
    setHistory((items) => (items.at(-1) === "main" ? items : [...items, "main"]));
  }

  async function goBack() {
    if (batchTesting.busy) return;
    if (isGenerationInFlight()) return;
    if (!await canLeaveCurrentEditor()) return;
    setHistory((items) => {
      const next = items.slice(0, -1);
      const previous = next.at(-1) ?? "main";
      setPage(previous);
      return next.length > 0 ? next : ["main"];
    });
  }

  function addContextRow(row: ContextRow) {
    setContextRows((rows) => {
      if (rows.some((item) => item.id === row.id)) return rows;
      return [...rows, row];
    });
  }

  function updateContextRow(id: string, value: string) {
    setContextRows((rows) =>
      rows.map((row) => (row.id === id ? { ...row, value } : row))
    );
  }

  function removeContextRow(id: string) {
    setContextRows((rows) => rows.filter((row) => row.id !== id));
  }

  function addStyleRow() {
    addContextRow({
      id: "style",
      label: t.brief.contextLabels.styleNotes,
      value: "",
      placeholder: t.brief.contextPlaceholders.styleNotes
    });
  }

  async function autoSelectVisualStylePreset(brief: string, logContext?: AiOperationLogContext) {
    const recommendation = await recommendVisualStylePresetWithIntent({
      brief,
      presets: VISUAL_STYLE_PRESETS,
      analyzeIntent: async () => {
        if (!aiClient) throw new Error("AI client is unavailable for template recommendation.");
        return aiClient.analyzeVisualStylePresetRecommendationIntent({ brief, logContext });
      },
    });
    return recommendation;
  }

  async function generatePresentationRequirements(presetIdOverride?: string | null) {
    if (!backend || !aiClient || !researchAiClient) return;
    const brief = prompt.trim();
    if (!brief) {
      showToast(t.toasts.promptRequired);
      return;
    }

    const operation = requirementsOperationRef.current + 1;
    requirementsOperationRef.current = operation;
    const attachmentOperation = attachmentPreparationOperationRef.current + 1;
    attachmentPreparationOperationRef.current = attachmentOperation;
    setUploadedSourcePreflights([]);
    setUploadedSourcePreflightRunning(false);
    setPage("main");
    setStage("requirements");
    setRequirementsStatus("loading");
    setRequirementsRetryMode("generate");
    setRequirementsError("");
    setRequirementsErrorDetail("");
    setLoading("requirements");
    const progress = requirementsProcess.start([
      { id: "attachments", label: t.processProgress.attachments },
      { id: "language", label: t.processProgress.language },
      { id: "requirements", label: t.processProgress.requirements },
      { id: "template", label: t.processProgress.template },
      { id: "research", label: t.processProgress.research },
      { id: "save", label: t.processProgress.save },
    ], () => requirementsOperationRef.current === operation);
    progress.begin("attachments");

    try {
      const initialWorkspace = await ensureCurrentWorkspace({ preserveWorkflowState: true });
      if (!initialWorkspace || requirementsOperationRef.current !== operation) return;
      const workspace = initialWorkspace.requirements.status === "empty" && normalizeSlideAspectRatio(initialWorkspace.requirements.selections.aspect_ratio) !== selectedAspectRatio
        ? await backend.updateWorkspaceRequirements({ workspace_dir: initialWorkspace.workspace_dir,
          requirements: { ...initialWorkspace.requirements, selections: { ...initialWorkspace.requirements.selections, aspect_ratio: selectedAspectRatio } } })
        : initialWorkspace;
      if (requirementsOperationRef.current !== operation) return;
      setCurrentWorkspace(workspace);
      setUploadedSourcePreflightRunning(true);
      const attachmentContextForRequirements = await prepareAttachmentContextForRequirements(workspace, brief, {
        onPreflightComplete: (results) => {
          if (requirementsOperationRef.current === operation) setUploadedSourcePreflights(results);
        },
        onProgress: (attachmentProgress) => {
          if (
            requirementsOperationRef.current === operation &&
            attachmentPreparationOperationRef.current === attachmentOperation
          ) {
            progress.patch("attachments", { summary: [attachmentPreparationLabel(t, attachmentProgress), attachmentProgress.filename, attachmentPreparationInsight(t, attachmentProgress)].filter(Boolean).join(" · "),
              files: attachmentProgress.sourceStates?.map((source) => ({ name: source.filename, state: source.phase === "completed" ? "completed" : "running" })),
            });
          }
        },
      });
      if (requirementsOperationRef.current !== operation) return;
      progress.complete("attachments", { summary: attachmentContextForRequirements ? t.processProgress.completed : t.processProgress.noAttachments });
      progress.begin("language");
      setPrompt(brief);
      const selectedPreset = findVisualStylePreset(presetIdOverride === undefined ? selectedVisualStylePresetId : presetIdOverride);
      const { candidates, updatedWorkspace, selectedPresetId } = await measurePerformanceOperation("requirements.create", workspace.workspace_dir, async () => {
        const outputLanguage = await aiClient.detectOutputLanguage({
          brief,
          logContext: buildAiLogContext(workspace, "requirements", "detect_output_language"),
        });
        if (requirementsOperationRef.current !== operation) return Promise.reject(new Error("Requirements generation cancelled"));
        progress.complete("language", { summary: outputLanguage.output_language, fields: [{ label: t.requirements.fields.output_language, value: outputLanguage.output_language }] });
        progress.begin("requirements");
        const generatedCandidates = await aiClient.generatePresentationRequirements({
          brief,
          outputLanguage: outputLanguage.output_language,
          attachmentContext: attachmentContextForRequirements,
          logContext: buildAiLogContext(workspace, "requirements", "generate_requirements"),
        });
        if (requirementsOperationRef.current !== operation) throw new Error("Requirements generation was cancelled.");
        progress.complete("requirements", { text: JSON.stringify(generatedCandidates, null, 2), fields: Object.entries(generatedCandidates).map(([field, values]) => ({
          label: t.requirements.fields[field as keyof typeof t.requirements.fields] ?? field,
          value: (values as Array<string | number | { label: string; description: string }>).map((value) => typeof value === "object" ? `${value.label} — ${value.description}` : String(value)).join("\n"),
        })) });
        progress.begin("template");
        const candidatesWithLanguage = {
          ...generatedCandidates,
          output_language: [outputLanguage.output_language],
        };
        const automaticRecommendation = selectedPreset ? null : await autoSelectVisualStylePreset(
          brief,
          buildAiLogContext(workspace, "requirements", "analyze_template_recommendation_intent"),
        );
        const resolvedPreset = selectedPreset ?? automaticRecommendation!.preset;
        if (requirementsOperationRef.current !== operation) throw new Error("Requirements generation cancelled");
        progress.complete("template", { summary: resolvedPreset.name, previews: resolvedPreset.preview_images.slice(0, 3), fields: [{ label: selectedPreset ? t.processProgress.userTemplate : t.processProgress.recommendTemplate, value: `${resolvedPreset.name}\n${resolvedPreset.description}` }] });
        progress.begin("research");
        const draftForRecommendation = createRequirementsDraft(
          brief,
          candidatesWithLanguage,
          automaticRecommendation?.user_choice ? null : toVisualStylePresetSelection(resolvedPreset),
          undefined,
          automaticRecommendation?.user_choice ?? null,
        );
        draftForRecommendation.selections.aspect_ratio = selectedAspectRatio;
        const research = applyImageResearchFlag(await researchAiClient.recommendResearch({
          brief,
          requirements: draftForRecommendation,
          attachmentContext: attachmentContextForRequirements,
          locale,
          logContext: buildAiLogContext(workspace, "requirements", "recommend_research"),
        }));
        if (requirementsOperationRef.current !== operation) throw new Error("Requirements generation cancelled");
        progress.complete("research", { fields: (["web", "images"] as const).map((kind) => ({
          label: kind === "web" ? t.processProgress.web : t.processProgress.image,
          value: `${research[kind].recommended ? t.processProgress.enabled : t.processProgress.disabled}\n${research[kind].reason}`,
        })) });
        progress.begin("save");
        const draft = { ...draftForRecommendation, research };
        const persistedWorkspace = await backend.updateWorkspaceRequirements({
          workspace_dir: workspace.workspace_dir,
          requirements: draft,
        });
        progress.complete("save", { summary: t.processProgress.saved });
        return {
          candidates: candidatesWithLanguage,
          updatedWorkspace: persistedWorkspace,
          selectedPresetId: automaticRecommendation?.user_choice ? null : resolvedPreset.id,
        };
      });
      if (requirementsOperationRef.current !== operation) return;
      setSelectedVisualStylePresetId(selectedPresetId);
      setPresentationRequirements(updatedWorkspace.requirements);
      setCurrentWorkspace(updatedWorkspace);
      setRequirementsStatus("ready");
      setRequirementsRetryMode("generate");
      setRequirementsDirty(false);
      setRequirementsHasSavedDraft(true);
      await backend.appendWorkspaceLog({
        workspace_dir: workspace.workspace_dir,
        channel: "ai-requirements",
        entry: {
          event: "ai.requirements.generated",
          status: "succeeded",
          candidate_counts: Object.fromEntries(
            Object.entries(candidates).map(([field, values]) => [field, values.length]),
          ),
          updated_at: updatedWorkspace.requirements.updated_at,
        },
      }).catch(() => undefined);
    } catch (error) {
      if (requirementsOperationRef.current !== operation) return;
      progress.fail();
      if (error instanceof AttachmentPreflightBlockedError) {
        setUploadedSourcePreflights(error.results);
        setRequirementsStatus("idle");
        setStage("brief");
        showToast(t.toasts.attachmentProcessFailed);
        return;
      }
      const { summary, detail } = summarizeUserFacingError(t, error, t.requirements.errorBody);
      setRequirementsError(summary);
      setRequirementsErrorDetail(detail);
      setRequirementsStatus("error");
    } finally {
      if (requirementsOperationRef.current === operation) {
        setUploadedSourcePreflightRunning(false);
        setLoading("none");
      }
    }
  }

  async function selectVisualStylePreset(presetId: string | null) {
    const previousId = selectedVisualStylePresetId;
    if (previousId === presetId) return;
    const hasExistingRequirements = Boolean(presentationRequirements.source?.brief);
    if (hasExistingRequirements && typeof window !== "undefined") {
      const confirmed = await requestConfirmation({
        title: t.dialogs.regenerateRequirements.title,
        body: t.dialogs.regenerateRequirements.body,
        cancelLabel: t.dialogs.regenerateRequirements.cancel,
        confirmLabel: t.dialogs.regenerateRequirements.confirm,
        tone: "warning",
      });
      if (!confirmed) return;
    }
    setSelectedVisualStylePresetId(presetId);
    if (hasExistingRequirements) {
      const brief = presentationRequirements.source?.brief ?? prompt;
      setPrompt(brief);
      window.setTimeout(() => void generatePresentationRequirements(presetId), 0);
    }
  }

  async function useManualPresentationRequirements() {
    const brief = presentationRequirements.source?.brief ?? prompt.trim();
    if (!brief) return;
    requirementsOperationRef.current += 1;
    const draft = createManualRequirementsDraft(brief);
    draft.selections.aspect_ratio = selectedAspectRatio;
    draft.selections.visual_style_preset = toVisualStylePresetSelection(findVisualStylePreset(selectedVisualStylePresetId));
    setPresentationRequirements(draft);
    setRequirementsStatus("ready");
    setRequirementsRetryMode("generate");
    setRequirementsError("");
    setRequirementsErrorDetail("");
    setRequirementsDirty(false);
    setRequirementsHasSavedDraft(false);
  }

  function selectPresentationRequirement<K extends keyof PresentationRequirementsSelections>(
    field: K,
    value: PresentationRequirementsSelections[K],
  ) {
    setPresentationRequirements((current) => {
      const next: PresentationRequirements = {
        ...current,
        status: "draft",
        selections: { ...current.selections, [field]: value },
        updated_at: new Date().toISOString(),
        confirmed_at: null,
      };
      setRequirementsDirty(true);
      return next;
    });
  }

  function selectPresentationResearch(kind: keyof PresentationResearchRequirements, enabled: boolean) {
    setPresentationRequirements((current) => ({
      ...current,
      status: "draft",
      research: {
        ...current.research,
        [kind]: { ...current.research[kind], enabled },
      },
      updated_at: new Date().toISOString(),
      confirmed_at: null,
    }));
    setRequirementsDirty(true);
  }

  async function returnToBriefFromRequirements() {
    if (requirementsDirty && !await canLeaveCurrentEditor()) return;
    requirementsOperationRef.current += 1;
    setLoading("none");
    setPage("main");
    setStage("brief");
  }

  async function savePresentationRequirements() {
    if (!backend || !currentWorkspace || !presentationRequirements.source) return;
    const draft: PresentationRequirements = {
      ...presentationRequirements,
      status: "draft",
      candidates: presentationRequirements.candidates,
      updated_at: new Date().toISOString(),
      confirmed_at: null,
    };
    setRequirementsSaving(true);
    try {
      const workspace = await backend.updateWorkspaceRequirements({
        workspace_dir: currentWorkspace.workspace_dir,
        requirements: draft,
      });
      setPresentationRequirements(workspace.requirements);
      setSelectedAspectRatio(normalizeSlideAspectRatio(workspace.requirements.selections.aspect_ratio));
      setCurrentWorkspace(workspace);
      setRequirementsDirty(false);
      setRequirementsHasSavedDraft(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      setRequirementsSaving(false);
    }
  }

  async function confirmPresentationRequirements() {
    if (!backend) return;
    const operation = requirementsOperationRef.current;
    if (!requirementsAreComplete(presentationRequirements) && !requirementsAreCompleteWithoutVisualSelection(presentationRequirements)) return;
    if (requiresTemplateRecommendationChoice(presentationRequirements)) return;
    setRequirementsConfirming(true);
    const previousOutline = cloneOutlineItems(outline);
    const previousOutlineDraft = cloneOutlineItems(outlineDraft);
    const previousOutlineDraftTitle = outlineDraftTitle;
    const previousOutlineRequirements = outlineRequirements;
    const previousOutlineDraftRequirements = outlineDraftRequirements;
    const previousOutlineError = outlineError;
    const previousOutlineErrorDetail = outlineErrorDetail;
    const restoreRequirementsReview = () => {
      setPage("main");
      setStage("requirements");
      setOutline(previousOutline);
      setOutlineDraft(previousOutlineDraft);
      setOutlineDraftTitle(previousOutlineDraftTitle);
      setOutlineRequirements(previousOutlineRequirements);
      setOutlineDraftRequirements(previousOutlineDraftRequirements);
      setOutlineError(previousOutlineError);
      setOutlineErrorDetail(previousOutlineErrorDetail);
      setLoading("none");
    };
    // Confirmation can include LLM selection, Host Upload and backend work, so
    // move to the next workflow surface before those asynchronous steps finish.
    setPage("main");
    // Web and image research run in parallel before Outline Creation, so the
    // confirmed research choice decides which surface comes next. Showing the
    // outline skeleton here would claim outline work while confirmation, preset
    // selection and research are still running.
    resetWebResearchProgress();
    const researchEnabled = presentationRequirements.research.web.enabled === true
      || presentationRequirements.research.images.enabled === true;
    if (researchEnabled) {
      setStage("web-research");
      setWebResearchStatus("preparing");
      setWebResearchError("");
      setWebResearchErrorDetail("");
      setLoading("webResearch");
    } else {
      setStage("outline");
      setLoading("outline");
    }
    setOutline([]);
    setOutlineDraft([]);
    setOutlineRequirements("");
    setOutlineDraftRequirements("");
    setOutlineError("");
    setOutlineErrorDetail("");
    setOutlineFeedback("");
    let workspace: WorkspaceResult | null = null;
    let requirementsCommitted = false;
    try {
      workspace = currentWorkspace ?? await ensureCurrentWorkspace();
      if (!workspace) throw new Error(t.errors.summaryUnknown);
      let workingRequirements = presentationRequirements;
      if (!workingRequirements.selections.visual_style_preset) {
        const recommendation = await autoSelectVisualStylePreset(
          workingRequirements.source?.brief ?? prompt.trim(),
          buildAiLogContext(workspace, "requirements", "analyze_template_recommendation_intent"),
        );
        if (requirementsOperationRef.current !== operation) return;
        if (recommendation.user_choice) {
          // Manual/legacy drafts also require an explicit choice when automatic
          // selection is deferred. Persist the candidates without confirming.
          workingRequirements = {
            ...workingRequirements,
            status: "draft",
            template_recommendation: recommendation.user_choice,
            updated_at: new Date().toISOString(),
            confirmed_at: null,
          };
          const updated = await backend.updateWorkspaceRequirements({
            workspace_dir: workspace.workspace_dir,
            requirements: workingRequirements,
          });
          if (requirementsOperationRef.current !== operation) return;
          setCurrentWorkspace(updated);
          setPresentationRequirements(updated.requirements);
          setRequirementsDirty(false);
          setRequirementsHasSavedDraft(true);
          setRequirementsStatus("ready");
          setRequirementsError("");
          setRequirementsErrorDetail("");
          restoreRequirementsReview();
          return;
        }
        const preset = recommendation.preset;
        workingRequirements = {
          ...workingRequirements,
          selections: {
            ...workingRequirements.selections,
            visual_style_preset: toVisualStylePresetSelection(preset)!,
          },
          updated_at: new Date().toISOString(),
          confirmed_at: null,
        };
        setPresentationRequirements(workingRequirements);
        setSelectedVisualStylePresetId(preset.id);
      }
      if (!requirementsAreComplete(workingRequirements)) {
        throw new Error("Presentation Requirements are incomplete after Visual Style Preset selection.");
      }
      const confirmed: PresentationRequirements = {
        ...workingRequirements,
        status: "confirmed",
        updated_at: new Date().toISOString(),
        confirmed_at: new Date().toISOString(),
      };
      const preset = findVisualStylePreset(confirmed.selections.visual_style_preset?.id);
      const templateInput = preset?.source === "user" ? { user_template_id: preset.id }
        : preset ? { template_snapshot: {
          version: 1, preset: toVisualStylePresetSelection(preset)!,
          reference_html_pages: await loadVisualStylePresetReferenceHtmlPages(preset),
        } } : {};
      const result = await backend.confirmWorkspaceRequirements({
        workspace_dir: workspace.workspace_dir,
        requirements: confirmed,
        ...templateInput,
      });
      requirementsCommitted = true;
      const resetWorkspace = result.workspace;
      setPresentationRequirements(confirmed);
      setSelectedVisualStylePresetId(confirmed.selections.visual_style_preset?.id ?? null);
      setCurrentWorkspace(resetWorkspace);
      setRequirementsStatus("ready");
      setRequirementsRetryMode("generate");
      setRequirementsDirty(false);
      setRequirementsHasSavedDraft(true);
      setDeckTitle(getWorkspaceTitle(resetWorkspace));
      setOutline([]);
      setOutlineDraft([]);
      setOutlineRequirements("");
      setOutlineDraftRequirements("");
      setOutlineDraftTitle(getWorkspaceTitle(resetWorkspace));
      setOutlineError("");
      setOutlineErrorDetail("");
      setOutlineFeedback("");
      // Web 研究前置：只有研究成功（或用户关闭 Web 研究）后才创建大纲。
      if (confirmed.research.web.enabled === true || confirmed.research.images.enabled === true) {
        await runWebResearchBeforeOutline(resetWorkspace, false);
      }
      await createOutlineFromConfirmedRequirements(resetWorkspace);
    } catch (error) {
      if (requirementsOperationRef.current !== operation) return;
      const { summary, detail } = summarizeUserFacingError(
        t,
        error,
        requirementsCommitted ? t.toasts.createOutlineFirst : t.requirements.errorBody,
      );
      if (requirementsCommitted) {
        setOutlineError(summary);
        setOutlineErrorDetail(detail);
        setLoading("none");
      } else {
        restoreRequirementsReview();
        setRequirementsError(summary);
        setRequirementsErrorDetail(detail);
        setRequirementsRetryMode("select");
        setRequirementsStatus("error");
        setLoading("none");
      }
    } finally {
      if (requirementsOperationRef.current === operation) setRequirementsConfirming(false);
    }
  }

  function resetWebResearchProgress() {
    webResearchRunRef.current += 1;
    setWebResearchProgress(null);
    setWebResearchStatus("idle");
    setWebResearchError("");
    setWebResearchErrorDetail("");
  }

  async function runWebResearchBeforeOutline(workspace: WorkspaceResult, resume: boolean) {
    const operation = requirementsOperationRef.current;
    resetWebResearchProgress();
    const run = webResearchRunRef.current;
    const isCurrent = () => webResearchRunRef.current === run
      && requirementsOperationRef.current === operation
      && currentWorkspaceRef.current?.workspace_dir === workspace.workspace_dir;
    setPage("main");
    setStage("web-research");
    setLoading("webResearch");
    setWebResearchStatus("running");
    setWebResearchError("");
    setWebResearchErrorDetail("");
    if (!backend || !aiClient || !researchWebClient || !agentClient) {
      const error = new Error("Web research dependencies are unavailable.");
      const { summary, detail } = summarizeUserFacingError(t, error, t.webResearch.errorBody);
      setWebResearchError(summary);
      setWebResearchErrorDetail(detail);
      setWebResearchStatus("error");
      setLoading("none");
      throw error;
    }
    try {
      let progress = await backend.getPageProgress({ workspace_dir: workspace.workspace_dir });
      const outlineContext = workspaceOutlineForDownstream(workspace);
      let uploadedSourceAnalysisContext: string | undefined;
      try {
        const analysis = await awaitUploadedSourceAnalysisForOutline(workspace);
        if (analysis) uploadedSourceAnalysisContext = renderUploadedSourceAnalysisMarkdown(analysis);
      } catch (analysisError) {
        console.warn("Uploaded source analysis unavailable for Web research", analysisError);
      }
      await runParallelSharedResearch({
        backend,
        aiClient,
        researchWebClient,
        agentClient,
        hostUploadClient,
        aiLogger,
        workspace,
        confirmedOutline: {
          ...outlineContext,
          items: Array.isArray(outlineContext.items) ? outlineContext.items : [],
        },
        locale,
        onProgress: (nextProgress) => {
          if (isCurrent()) setWebResearchProgress(nextProgress);
        },
        isCancelled: () => !isCurrent(),
        activeStreams: new Map(),
        getProgress: () => progress,
        setProgress: (nextProgress) => {
          progress = nextProgress;
        },
      }, {
        resume,
        webEnabled: workspace.requirements.research.web.enabled === true,
        imageEnabled: workspace.requirements.research.images.enabled === true,
        publishToPageProgress: false,
        webBrief: workspace.requirements.source?.brief ?? prompt.trim(),
        webRequirementsText: formatWebResearchRequirements(workspace.requirements),
        webUploadedSourceAnalysis: uploadedSourceAnalysisContext,
      });
      if (!isCurrent()) throw new Error("Research operation is no longer current.");
      setWebResearchStatus("completed");
      setWebResearchError("");
      setWebResearchErrorDetail("");
      setLoading("none");
    } catch (error) {
      if (!isCurrent()) throw error;
      console.warn("Web research failed", error);
      const { summary, detail } = summarizeUserFacingError(t, error, t.webResearch.errorBody);
      setWebResearchError(summary);
      setWebResearchErrorDetail(detail);
      setWebResearchStatus("error");
      setLoading("none");
      throw error;
    }
  }

  function returnToRequirementsFromWebResearch() {
    if (webResearchStatus === "preparing" || webResearchStatus === "running") return;
    setPage("main");
    setStage("requirements");
  }

  async function retryWebResearch() {
    const operation = requirementsOperationRef.current;
    let run = webResearchRunRef.current;
    try {
      const workspace = currentWorkspace ?? await refreshCurrentWorkspaceSnapshot();
      if (!workspace) throw new Error(t.errors.summaryUnknown);
      const research = runWebResearchBeforeOutline(workspace, true);
      run = webResearchRunRef.current;
      await research;
      await createOutlineFromConfirmedRequirements(workspace);
    } catch (error) {
      if (requirementsOperationRef.current !== operation || webResearchRunRef.current !== run) return;
      const { summary, detail } = summarizeUserFacingError(t, error, t.webResearch.errorBody);
      setWebResearchError(summary);
      setWebResearchErrorDetail(detail);
      setWebResearchStatus("error");
      setLoading("none");
    }
  }

  async function retryPresentationRequirements() {
    if (requirementsRetryMode === "select") {
      await confirmPresentationRequirements();
      return;
    }
    await generatePresentationRequirements();
  }

  function isUnresumableDeckGenerationError(error: DeckGenerationError) {
    return error.type === "stale_artifacts" || error.type === "invalid_confirmed_outline";
  }

  async function applyDeckGenerationCompletion(
    completion: DeckGenerationCompletion,
    workspace: WorkspaceResult,
    options: { resumeAllowedOnRecoverableStop?: boolean; returnPageId?: string; changedPageIds?: readonly string[] } = {},
  ) {
    const resumeAllowedOnRecoverableStop =
      options.resumeAllowedOnRecoverableStop !== false;

    if (completion.status === "cancelled") {
      releaseGenerationPagePreviewHolds();
      setGenerationResumeAllowed(resumeAllowedOnRecoverableStop);
      const latestWorkspace = backend
        ? await backend.openWorkspace({ workspace_dir: workspace.workspace_dir })
        : workspace;
      const reconciledWorkspace = await reconcileWorkspaceInterruptedPages(latestWorkspace);
      applyWorkspace(reconciledWorkspace);
      setStage("generating");
      setPage("main");
      return;
    }

    if (completion.status === "failed") {
      releaseGenerationPagePreviewHolds();
      if (completion.progress) {
        setCreateDeckProgress(completion.progress);
      }
      setGenerationUnresumable(isUnresumableDeckGenerationError(completion.error));
      setGenerationResumeAllowed(
        resumeAllowedOnRecoverableStop &&
          !isUnresumableDeckGenerationError(completion.error)
      );
      setStage("generating");
      setPage("main");
      showToast(summarizeUserFacingError(t, completion.error.message).summary);
      return;
    }

    if (completion.status === "research-completed") {
      releaseGenerationPagePreviewHolds();
      const confirmedOutline = workspaceOutlineForDownstream(workspace);
      applyWorkspace(workspace);
      setDeckTitle(confirmedOutline.title);
      setOutline(cloneOutlineItems(confirmedOutline.items));
      setOutlineDraft(cloneOutlineItems(confirmedOutline.items));
      setOutlineDraftTitle(confirmedOutline.title);
      setOutlineRequirements(confirmedOutline.global_creation_requirements ?? "");
      setOutlineDraftRequirements(confirmedOutline.global_creation_requirements ?? "");
      resetGenerationProgress();
      setGenerationUnresumable(false);
      setGenerationResumeAllowed(false);
      setStage("outline");
      setPage("main");
      showToast(t.generating.imageResearchTestStopped);
      return;
    }

    // Completion owns the committed outline/progress, even if the accompanying
    // Workspace snapshot briefly lags the Final Deck Render.
    const result = publishDeckResult({
      ...workspace, outline: completion.result.outline, page_progress: completion.result.progress,
    }, completion.result.rendered, {
      changedPageIds: options.changedPageIds ?? [],
      returnTo: { pageId: options.returnPageId ?? null },
    });
    if (!result) return;
    setGenerationUnresumable(false);
    setGenerationResumeAllowed(false);
    setDeckTitle(completion.result.outline.title);
    setHistory((items) => (items.at(-1) === "main" ? items : [...items, "main"]));
    const isCurrent = captureReviewResultGuard(workspace.workspace_dir);

    if (backend) {
      try {
        const assembled = await assembleMeasuredReviewRender({
          backend,
          metadata: result,
          workspaceDir: workspace.workspace_dir,
          previews: generationPagePreviewsRef.current,
        });
        if (!isCurrent()) return;
        generationPagePreviewsRef.current = assembled.previews;
        setGenerationPagePreviews(assembled.previews);
      } catch (error) {
        console.warn("Failed to assemble optional completed Deck previews", error);
      }
    }
  }

  async function createOutlineFromConfirmedRequirements(
    workspaceOverride: WorkspaceResult | null = null,
    resumeProgress = false,
  ) {
    if (!backend || !aiClient) return;
    outlineRewriteRequestRef.current = null;
    let workspace: WorkspaceResult | null = workspaceOverride;
    const operation = outlineOperationRef.current + 1;
    outlineOperationRef.current = operation;
    setPage("main");
    setStage("outline");
    setLoading("outline");
    const progress = outlineProcess.start([
      { id: "prepare", label: t.processProgress.prepare },
      { id: "outline", label: t.processProgress.generating },
      { id: "images", label: t.processProgress.assign },
      { id: "save", label: t.processProgress.save },
    ], () => outlineOperationRef.current === operation, resumeProgress);
    progress.begin("prepare");
    setOutlineError("");
    setOutlineErrorDetail("");
    try {
      workspace = workspace ?? await refreshCurrentWorkspaceSnapshot();
      if (!workspace || outlineOperationRef.current !== operation) return;
      if (workspace.requirements.status !== "confirmed") {
        throw new Error("请先确认演示需求，再创建大纲。");
      }
      const activeWorkspace = workspace;
      if (workspace.requirements.research.web.enabled || workspace.requirements.research.images.enabled) {
        const research = await backend.getSharedResearchContext({ workspace_dir: workspace.workspace_dir });
        const web = research.progress.web as { written?: boolean } | undefined;
        const images = research.progress.image as { written?: boolean } | undefined;
        if ((workspace.requirements.research.web.enabled && !web?.written)
          || (workspace.requirements.research.images.enabled && !images?.written)) {
          await runWebResearchBeforeOutline(workspace, true);
          if (outlineOperationRef.current !== operation) return;
        }
      }
      // C-line blocking gate: wait for uploaded-attachment analysis (kicked off
      // at the generate click) to finish before creating the outline. The
      // completed analysis is also supplied to the Web Research prompt.
      // Non-preemptive:
      // stage stays "outline" and loading stays "outline", so the outline
      // loading skeleton shows the whole time (no blank screen). Bounded by a
      // wall-clock deadline inside the helper; on timeout/failure we cancel the
      // C-line agent and generate the outline without attachment context rather
      // than hang. When there are no attachments the helper returns null and the
      // flow is unchanged.
      let uploadedSourceAnalysisContext: string | null = null;
      try {
        // Surface the analysis wait honestly in the status bar ("正在分析上传
        // 资料...") while keeping the outline loading skeleton (OutlinePage
        // treats this loading value as "creating" too, so no blank screen).
        setLoading("uploadedSourceAnalysis");
        const analysis = await awaitUploadedSourceAnalysisForOutline(activeWorkspace);
        if (analysis) {
          const markdown = renderUploadedSourceAnalysisMarkdown(analysis);
          uploadedSourceAnalysisContext = markdown.trim().length > 0 ? markdown : null;
        }
      } catch (analysisError) {
        console.warn("Uploaded source analysis skipped for outline (degraded, non-blocking)", analysisError);
        setUploadedSourceAnalysisError("");
      }
      if (outlineOperationRef.current !== operation) return;
      setStage("outline");
      setLoading("outline");
      const outlineLogContext = buildAiLogContext(activeWorkspace, "outline", "generate_outline");
      const sharedResearch = await backend.getSharedResearchContext({ workspace_dir: activeWorkspace.workspace_dir });
      const attachmentContext = await backend.getAttachmentContext({ workspace_dir: activeWorkspace.workspace_dir }).catch(() => null);
      const { result, normalized, updatedWorkspace } = await measurePerformanceOperation("outline.create", activeWorkspace.workspace_dir, async () => {
        progress.complete("prepare", { summary: t.processProgress.prepared });
        progress.begin("outline");
        const generated = await aiClient.generateOutline({
          onStreamEvent: progress.stream("outline"),
          onAttemptStart: (info) => progress.beginRound("outline", info),
          onAttemptEnd: (result) => progress.endRound("outline", result),
          isCancelled: () => outlineOperationRef.current !== operation,
          requirements: activeWorkspace.requirements,
          attachmentContext,
          uploadedSourceAnalysisContext: uploadedSourceAnalysisContext ?? undefined,
          webResearchSummary: sharedResearch.web_summary,
          logContext: outlineLogContext,
        });
        if (outlineOperationRef.current !== operation) throw new Error("Outline creation cancelled");
        progress.complete("outline", { summary: generated.outline.title });
        progress.begin("images");
        const nextOutline = await assignOutlineImages({
          agent: agentClient!, requirements: activeWorkspace.requirements,
          outline: normalizeValidOutline(generated.outline),
          assets: availableOutlineImages(sharedResearch),
          options: { onStreamEvent: progress.stream("images"), logContext: buildAiLogContext(activeWorkspace, "outline", "assign_images"),
            isCancelled: () => outlineOperationRef.current !== operation },
        });
        if (outlineOperationRef.current !== operation) throw new Error("Outline creation cancelled");
        progress.complete("images", { summary: availableOutlineImages(sharedResearch).length ? t.processProgress.imagesAssigned : t.processProgress.noImages });
        progress.begin("save");
        const persistedWorkspace = await backend.saveWorkspaceOutlineDraft({
          workspace_dir: activeWorkspace.workspace_dir,
          outline: nextOutline,
        });
        progress.complete("save", { summary: t.processProgress.saved });
        return { result: generated, normalized: nextOutline, updatedWorkspace: persistedWorkspace };
      });
      if (outlineOperationRef.current !== operation) return;
      await appendOutlineAiAttemptLogs(workspace, result.attempts, outlineLogContext);
      // The user may have walked away while the Outline was being written, and
      // landing here would drag them back onto a stage they left.
      if (outlineOperationRef.current !== operation) return;
      applyWorkspace(updatedWorkspace);
      setDeckTitle(normalized.title);
      setOutline(cloneOutlineItems(normalized.items));
      setOutlineDraft(cloneOutlineItems(normalized.items));
      setOutlineDraftTitle(normalized.title);
      setOutlineRequirements(normalized.global_creation_requirements ?? "");
      setOutlineDraftRequirements(normalized.global_creation_requirements ?? "");
      setOutlineError("");
      setOutlineErrorDetail("");
      setStage("outline");
      setWorkspaceScan(await backend.listWorkspaces());
      showToast(t.status.outlineReady);
    } catch (error) {
      if (outlineOperationRef.current !== operation) return;
      progress.fail();
      await appendOutlineErrorLog(workspace, "generateOutline", error);
      const { summary, detail } = summarizeUserFacingError(t, error, t.toasts.createOutlineFirst);
      setOutlineError(summary);
      setOutlineErrorDetail(detail);
    } finally {
      if (outlineOperationRef.current === operation) setLoading("none");
    }
  }

  async function generateDeck() {
    await createOutlineFromConfirmedRequirements();
  }

  async function landAfterGenerationAbandon(runKind: ActiveGenerationRunKind, fromHeader: boolean) {
    const landing = resolveGenerationAbandonLanding({ runKind, fromHeader });
    setStage(landing.stage);
    setPage(landing.page);
    if (landing.page === "my-work") {
      setHistory((items) => (items.at(-1) === "my-work" ? items : [...items, "my-work"]));
      await refreshMyWork({ force: true });
    }
  }

  async function cancelGenerateDeck(
    options: { landOnMyWork?: boolean; copy?: "stop" | "home" } = {},
  ) {
    if (!backend || !isGenerationInFlight()) return;
    const targetRun = activeGenerationRun ?? (generationTransaction ? {
      kind: generationTransaction.run_kind,
      runId: generationTransaction.run_id,
      officialWorkspaceDir: generationTransaction.official_workspace_dir,
      shadowWorkspaceDir: generationTransaction.shadow_workspace_dir,
      stopping: false,
      committing: false,
    } : null);
    const runKind: ActiveGenerationRunKind = targetRun?.kind
      ?? (loading === "refineDeck" ? "deck-refinement" : loading === "refineSlide" ? "page-refinement" : "deck-generation");
    const isGeneration = runKind === "deck-generation";
    // GEN-008: resolved from the active locale at call time so the dialog never
    // renders copy captured in an earlier language.
    const abandon = t.generating.abandon;
    const confirmed = await requestConfirmation({
      title: options.copy === "home"
        ? (isGeneration ? abandon.home.generationTitle : abandon.home.refinementTitle)
        : (isGeneration ? abandon.generationTitle : abandon.refinementTitle),
      body: options.copy === "home"
        ? (isGeneration ? abandon.home.generationBody : abandon.home.refinementBody)
        : (isGeneration ? abandon.generationBody : abandon.refinementBody),
      cancelLabel: isGeneration ? abandon.generationCancel : abandon.refinementCancel,
      confirmLabel: options.copy === "home" ? abandon.home.confirm : abandon.confirm,
      tone: "danger",
    });
    if (!confirmed) return;
    console.log(`[snapshot-trigger] #4 exit-cancel copy=${options.copy ?? "stop"}`);
    publishSnapshotFromNav(`generation-abandon:${options.copy ?? "default"}`);
    // Invalidate the old operation before any awaited backend work. The agent may
    // still emit a final progress frame while the run is being abandoned.
    generationOperationRef.current += 1;
    cancelCreateDeckRef.current = true;
    cancelCreateDeckAbortRef.current?.abort();
    if (!targetRun) {
      // Abandoned before `beginGenerationRun` came back, so there is nothing to
      // abandon on the backend yet. `prepareShadowGenerationRun` discards the
      // run once it arrives; here only the local run state has to be unwound.
      setGenerationPreparing(false);
      setGenerationTransaction(null);
      setLoading("none");
      await landAfterGenerationAbandon(runKind, options.landOnMyWork === true);
      showToast(isGeneration ? abandon.generationStopped : abandon.refinementStopped);
      return;
    }
    setActiveGenerationRun((current) => current ? { ...current, stopping: true } : current);
    try {
      await backend.abandonGenerationRun({ run_id: targetRun.runId });
      if (agentClient) {
        let cancellationTimedOut = false;
        let cancellationTimeoutId: number | undefined;
        await Promise.race([
          agentClient.cancelActiveRuns().catch((error) => {
            console.warn("Failed to cancel active Agent Session runs", error);
          }),
          new Promise<void>((resolve) => {
            cancellationTimeoutId = window.setTimeout(() => {
              cancellationTimedOut = true;
              resolve();
            }, AGENT_CANCELLATION_WAIT_MS);
          }),
        ]);
        if (cancellationTimeoutId !== undefined) {
          window.clearTimeout(cancellationTimeoutId);
        }
        if (cancellationTimedOut) {
          console.warn("Timed out waiting for active Agent Session cancellation");
        }
      }
      const official = await backend.openWorkspace({ workspace_dir: targetRun.officialWorkspaceDir });
      applyWorkspace(official);
      setGenerationPreparing(false);
      setActiveGenerationRun(null);
      setGenerationTransaction(null);
      setLoading("none");
      await landAfterGenerationAbandon(targetRun.kind, options.landOnMyWork === true);
      showToast(isGeneration ? abandon.generationStopped : abandon.refinementStopped);
    } catch (error) {
      setActiveGenerationRun((current) => current ? { ...current, stopping: false } : current);
      showToast(summarizeUserFacingError(t, error, abandon.failed).summary);
    }
  }

  async function createDeckFromOutline() {
    if (!backend || !aiClient || !researchWebClient || !hostUploadClient) return;
    if (!agentClient) {
      if (uploadedSources.length > 0) {
        showToast(t.errors.uploadedSourceAnalysisUnavailable);
      }
      return;
    }

    let activeRunWorkspaceDir: string | undefined;
    let shouldReconcileActiveRun = false;
    let outlineConfirmed = false;
    let generationRun: GenerationRunTransaction | null = null;
    const cancelSignal = beginCancellableGeneration();
    resetGenerationProgress();
    try {
      const normalized = normalizeValidOutline({
        title: outlineDraftTitle,
        global_creation_requirements: outlineDraftRequirements,
        items: outlineDraft,
      });
      setLoading("deck");
      setCreateDeckProgress({
        step: "prepare",
        message: t.generating.confirmingOutline,
        messageKey: "confirmingOutline",
        currentPageIndex: null,
        totalPages: normalized.items.length,
        pages: [],
      });
      setGenerationPreparing(true);
      setStage("generating");
      setPage("main");

      const workspace = await refreshCurrentWorkspaceSnapshot();
      if (!workspace) {
        setStage("outline");
        return;
      }
      if (!confirmedRequirementsAllowOutline(workspace.requirements)) {
        showToast(t.toasts.confirmRequirementsFirst);
        setPage("main");
        setStage("requirements");
        return;
      }
      const draftWorkspace = await backend.saveWorkspaceOutlineDraft({
        workspace_dir: workspace.workspace_dir,
        outline: normalized,
      });
      setCurrentWorkspace(draftWorkspace);
      const shadowRun = await prepareShadowGenerationRun(draftWorkspace, "deck-generation", null, (transaction) => { generationRun = transaction; });
      generationRun = shadowRun.transaction;
      const confirmedWorkspace = await backend.confirmWorkspaceOutline({
        workspace_dir: shadowRun.workspace.workspace_dir,
        outline: normalized,
      });
      outlineConfirmed = true;
      setDeckTitle(normalized.title);
      setOutline(cloneOutlineItems(normalized.items));
      setOutlineDraft(cloneOutlineItems(normalized.items));
      setOutlineDraftTitle(normalized.title);
      setOutlineRequirements(normalized.global_creation_requirements ?? "");
      setOutlineDraftRequirements(normalized.global_creation_requirements ?? "");
      activeRunWorkspaceDir = confirmedWorkspace.workspace_dir;
      shouldReconcileActiveRun = true;

      const completion = await measurePerformanceOperation("generation.run", confirmedWorkspace.workspace_dir, () => runDeckGeneration({
        backend,
        aiClient,
        researchWebClient,
        agentClient,
        hostUploadClient,
        aiLogger,
        workspace: confirmedWorkspace,
        generationRunId: shadowRun.transaction.run_id,
        confirmedOutline: workspaceOutlineForDownstream(confirmedWorkspace),
        locale,
        startMode: "new",
        onProgress: generationProgressHandler(cancelSignal),
        isCancelled: () => cancelCreateDeckRef.current,
        cancelSignal,
        stopAfterImageResearch: STOP_AFTER_IMAGE_RESEARCH,
      }));
      if (!ownsGenerationOperation(cancelSignal)) return;
      if (completion.status === "completed" || completion.status === "research-completed") {
        const committed = await commitShadowGenerationRun(generationRun);
        setGenerationTransaction(null);
        const rebasedCompletion = rebaseCompletion(
          completion,
          generationRun.shadow_workspace_dir,
          generationRun.official_workspace_dir,
        );
        await applyDeckGenerationCompletion(rebasedCompletion, committed.workspace);
      } else if (!cancelCreateDeckRef.current) {
        await applyDeckGenerationCompletion(completion, confirmedWorkspace);
      }
      shouldReconcileActiveRun = false;
    } catch (error) {
      if (!ownsGenerationOperation(cancelSignal)) return;
      setGenerationPreparing(false);
      if (!outlineConfirmed) {
        setStage("outline");
        setPage("main");
      }
      showToast(error instanceof Error ? error.message : t.toasts.createDeckFirst);
    } finally {
      if (ownsGenerationOperation(cancelSignal)) {
        setGenerationPreparing(false);
        setLoading("none");
        await finishActiveGenerationRun({
          workspaceDir: activeRunWorkspaceDir,
          reconcileInterrupted: shouldReconcileActiveRun && !generationRun,
        });
      }
      if (generationRun) {
        void backend.cleanupGenerationRun({ run_id: generationRun.run_id }).catch((error) =>
          console.warn("Failed to clean generation run", error)
        );
      }
    }
  }

  async function saveOutlineDraft(value?: EditableOutline): Promise<boolean> {
    if (!backend) return false;
    setOutlineSaving(true);
    try {
      const workspace = await ensureCurrentWorkspace();
      if (!workspace) return false;
      if (!confirmedRequirementsAllowOutline(workspace.requirements)) {
        setOutlineDraft(cloneOutlineItems(outline));
        setOutlineDraftTitle(deckTitle);
        setOutlineDraftRequirements(outlineRequirements);
        showToast(t.toasts.confirmRequirementsFirst);
        setPage("main");
        setStage("requirements");
        return false;
      }
      setLoading("outline");
      // 显式快照让抽屉及 AI 预览先保存、再替换草稿，失败时保留原内容。
      const normalized = normalizeValidOutline(value ?? { title: outlineDraftTitle, global_creation_requirements: outlineDraftRequirements, items: outlineDraft });
      const updatedWorkspace = await backend.saveWorkspaceOutlineDraft({
        workspace_dir: workspace.workspace_dir,
        outline: normalized,
      });
      setOutlineError("");
      setOutlineErrorDetail("");
      setCurrentWorkspace(updatedWorkspace);
      setDeckTitle(normalized.title);
      setOutline(cloneOutlineItems(normalized.items));
      setOutlineDraft(cloneOutlineItems(normalized.items));
      setOutlineDraftTitle(normalized.title);
      setOutlineRequirements(normalized.global_creation_requirements ?? "");
      setOutlineDraftRequirements(normalized.global_creation_requirements ?? "");
      const scan = await backend.listWorkspaces().catch(() => null);
      if (scan) setWorkspaceScan(scan);
      showToast(t.toasts.outlineUpdated);
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : t.toasts.createOutlineFirst);
      return false;
    } finally {
      setLoading("none");
      setOutlineSaving(false);
    }
  }

  async function applyOutlineFeedback(): Promise<EditableOutline | undefined> {
    if (!backend || !aiClient) return;
    const feedback = outlineFeedback.trim();
    if (!feedback) return;

    const requestKey = JSON.stringify([currentWorkspace?.workspace_dir, outlineDraftTitle, outlineDraftRequirements, outlineDraft, feedback]);
    const resumeProgress = Boolean(outlineError) && outlineRewriteRequestRef.current === requestKey;
    outlineRewriteRequestRef.current = requestKey;
    const operation = outlineOperationRef.current + 1;
    outlineOperationRef.current = operation;
    setLoading("outlineRewrite");
    setOutlineError("");
    setOutlineErrorDetail("");
    const isCancelled = () => outlineOperationRef.current !== operation;
    const progress = outlineProcess.start([
      { id: "prepare", label: t.processProgress.prepare },
      { id: "outline", label: t.processProgress.revising },
      { id: "images", label: t.processProgress.assign },
    ], () => !isCancelled(), resumeProgress);
    progress.begin("prepare");
    let workspace: WorkspaceResult | null = null;
    try {
      workspace = await ensureCurrentWorkspace();
      if (!workspace || outlineOperationRef.current !== operation) return;
      if (!confirmedRequirementsAllowOutline(workspace.requirements)) {
        throw new Error("请先确认演示需求，再调整大纲。");
      }

      const activeWorkspace = workspace;
      const uploadedSourceAnalysisContext = currentUploadedSourceAnalysis && uploadedSources.length > 0
        && uploadedSourceDependencyMatchesActiveSources({
          dependency: createUploadedSourceAnalysisDependency(currentUploadedSourceAnalysis),
          uploadedSources,
        })
        ? renderUploadedSourceAnalysisMarkdown(currentUploadedSourceAnalysis)
        : undefined;
      const outlineLogContext = buildAiLogContext(activeWorkspace, "outline", "revise_outline");
      const sharedResearch = await backend.getSharedResearchContext({ workspace_dir: activeWorkspace.workspace_dir });
      const attachmentContext = await backend.getAttachmentContext({ workspace_dir: activeWorkspace.workspace_dir }).catch(() => null);
      if (isCancelled()) return;
      const assets = availableOutlineImages(sharedResearch);
      const { result, preview } = await measurePerformanceOperation(
        "outline.rewrite",
        activeWorkspace.workspace_dir,
        async () => {
          progress.complete("prepare", { summary: t.processProgress.prepared });
          progress.begin("outline");
          const revised = await aiClient.reviseOutline({
            onStreamEvent: progress.stream("outline"),
            onAttemptStart: (info) => progress.beginRound("outline", info),
            onAttemptEnd: (result) => progress.endRound("outline", result),
            isCancelled,
            title: outlineDraftTitle,
            global_creation_requirements: outlineDraftRequirements,
            outline: outlineDraft,
            feedback,
            requirements: activeWorkspace.requirements,
            attachmentContext,
            uploadedSourceAnalysisContext,
            webResearchSummary: sharedResearch.web_summary,
            logContext: outlineLogContext,
          });
          if (isCancelled()) throw new Error("Outline rewrite cancelled");
          progress.complete("outline", { summary: revised.outline.title });
          progress.begin("images");
          const normalized = await assignOutlineImages({
            agent: agentClient!, requirements: activeWorkspace.requirements,
            outline: normalizeValidOutline(revised.outline), assets,
            previousOutline: { title: outlineDraftTitle, global_creation_requirements: outlineDraftRequirements, items: outlineDraft }, rewriteRequest: feedback,
            options: { onStreamEvent: progress.stream("images"), logContext: buildAiLogContext(activeWorkspace, "outline", "reassign_images"),
              isCancelled },
          });
          if (isCancelled()) throw new Error("Outline rewrite cancelled");
          progress.complete("images", { summary: assets.length ? t.processProgress.imagesAssigned : t.processProgress.noImages });
          return { result: revised, preview: normalized };
        },
      );
      if (outlineOperationRef.current !== operation) return;
      await appendOutlineAiAttemptLogs(workspace, result.attempts, outlineLogContext);
      if (outlineOperationRef.current !== operation) return;
      // 预览只返回给弹窗；应用时才经 saveOutlineDraft 持久化。
      return preview;
    } catch (error) {
      if (outlineOperationRef.current !== operation) return;
      progress.fail();
      await appendOutlineErrorLog(workspace, "reviseOutline", error);
      if (isCancelled()) return;
      const { summary, detail } = summarizeUserFacingError(t, error, t.outline.rewriteError);
      setOutlineError(summary);
      setOutlineErrorDetail(detail);
    } finally {
      if (outlineOperationRef.current === operation) setLoading("none");
    }
  }

  function updateOutlineDraftItem(index: number, patch: Partial<WorkspaceOutlineItem>) {
    setOutlineDraft((items) =>
      items.map((item, itemIndex) =>
        itemIndex === index
          ? {
              ...item,
              ...patch,
              ...(Object.keys(patch).some((key) => [
                "title",
                "title_segments",
                "content",
              ].includes(key)) ? { analysis: undefined } : {}),
            }
          : item
      )
    );
  }

  function replaceOutlineDraftItems(items: OutlineDetail[]) {
    setOutlineDraft(cloneOutlineItems(items));
  }

  async function retryOutlineCreation() {
    if (presentationRequirements.status !== "confirmed") {
      await confirmPresentationRequirements();
      return;
    }
    await createOutlineFromConfirmedRequirements(null, true);
  }

  function returnToRequirementsFromOutline() {
    if (!confirmedRequirementsAllowOutline(currentWorkspace?.requirements)) {
      setOutlineDraft(cloneOutlineItems(outline));
      setOutlineDraftTitle(deckTitle);
      setOutlineDraftRequirements(outlineRequirements);
      setPage("main");
      setStage("requirements");
      return;
    }
    navigateMain("requirements");
  }


  function openLocalProject(projectName: string) {
    const nextDeck = createLocalProjectDeck(projectName);
    setDeckTitle(projectName);
    setDeck(nextDeck);
    setOutline(
      nextDeck.map((slide) => ({
        page_type: "standard" as const,
        title: slide.title,
        content: slide.subtitle,
      }))
    );
    setGenerated(true);
    setCurrentSlide(0);
    setStage("deck");
    setPage("main");
  }

  function getWorkspaceTitle(workspace: WorkspaceResult) {
    return typeof workspace.task === "object" &&
      workspace.task !== null &&
      typeof (workspace.task as { title?: unknown }).title === "string"
      ? (workspace.task as { title: string }).title
      : workspace.task_id ?? workspace.workspace_id;
  }

  function readWorkspaceExportArtifactPath(workspace: WorkspaceResult): ExportArtifact | null {
    if (!workspace.task || typeof workspace.task !== "object" || Array.isArray(workspace.task)) {
      return null;
    }

    const task = workspace.task as {
      artifacts?: {
        pptx?: {
          path?: unknown;
          updated_at?: unknown;
          mirror?: unknown;
        };
        pdf?: { path?: unknown; updated_at?: unknown; mirror?: unknown };
      };
    };
    const pptx = task.artifacts?.pptx;
    const pdf = task.artifacts?.pdf;
    const candidates = [
      {
        type: "PPTX" as const,
        path: typeof pptx?.path === "string" ? pptx.path : "",
        updatedAt: typeof pptx?.updated_at === "string" ? pptx.updated_at : "",
        mirror: pptx?.mirror,
      },
      {
        type: "PDF" as const,
        path: typeof pdf?.path === "string" ? pdf.path : "",
        updatedAt: typeof pdf?.updated_at === "string" ? pdf.updated_at : "",
        mirror: pdf?.mirror,
      }
    ].filter((item) => item.path);

    if (candidates.length === 0) {
      return null;
    }

    const latest = [...candidates].sort((left, right) => {
      if (left.updatedAt === right.updatedAt) return 0;
      if (!left.updatedAt) return 1;
      if (!right.updatedAt) return -1;
      return right.updatedAt.localeCompare(left.updatedAt);
    })[0];

    const mirror = latest.mirror && typeof latest.mirror === "object" && !Array.isArray(latest.mirror)
      ? latest.mirror as {
          provider?: unknown;
          scope?: unknown;
          path?: unknown;
          content_disposition?: unknown;
          source_updated_at?: unknown;
        }
      : null;
    const mirrorStatus = !mirror ||
      mirror.provider !== "aps.files" ||
      mirror.scope !== "user" ||
      typeof mirror.content_disposition !== "string" ||
      !/^attachment(?:;|$)/i.test(mirror.content_disposition)
      ? "missing"
      : mirror.source_updated_at === latest.updatedAt
        ? "ready"
        : "stale";

    return {
      type: latest.type,
      path: latest.path,
      updatedAt: latest.updatedAt,
      mirrorStatus,
      mirrorPath: typeof mirror?.path === "string" ? mirror.path : undefined,
      mirrorScope: typeof mirror?.scope === "string" ? mirror.scope : undefined,
    };
  }

  function formatExportDownloadError(error: unknown) {
    const detail = error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
    if (!detail) return t.errors.exportDownloadFailed;
    return formatMessage(t.errors.exportDownloadFailedWithDetail, { detail });
  }

  function artifactFromPublishedJob(
    job: ExportArtifactPublishJob,
    fallback: ExportArtifact,
  ): ExportArtifact {
    const mirror = job.mirror;
    return {
      type: fallback.type,
      path: job.artifact?.path ?? fallback.path,
      fileName: job.artifact?.filename ?? fallback.fileName,
      updatedAt: job.artifact?.updated_at ?? fallback.updatedAt,
      mirrorStatus: "ready",
      mirrorPath: mirror?.path ?? fallback.mirrorPath,
      mirrorScope: mirror?.scope ?? fallback.mirrorScope,
    };
  }

  async function publishExportArtifact(workspace: WorkspaceResult, artifact: ExportArtifact): Promise<ExportArtifact> {
    if (!backend) {
      throw new Error("PptBackend is not available.");
    }
    const completed = await backend.runExportArtifactPublish({
      workspace_dir: workspace.workspace_dir,
      artifact_type: artifact.type.toLowerCase() as "pptx" | "pdf",
      onProgress: (progress) => {
        setExportProgress((current) => ({
          ...current,
          active: true,
          percent: typeof progress.percent === "number" ? progress.percent : current.percent,
          message: progress.message || current.message,
        }));
      },
    });
    const published = artifactFromPublishedJob(completed, artifact);
    setExportArtifact(published);
    return published;
  }

  async function ensureCurrentWorkspace(
    options: { preserveWorkflowState?: boolean; refreshWorkspaceScan?: boolean } = {},
  ) {
    if (!backend) return null;
    const existingWorkspace = currentWorkspaceRef.current;
    if (existingWorkspace) return existingWorkspace;

    const pendingCreation = workspaceCreationPromiseRef.current;
    if (pendingCreation) return pendingCreation;

    const creation = (async (): Promise<WorkspaceResult> => {
      const created = await backend.createWorkspace({
        title: getDefaultWorkspaceTitle(),
      });
      const workspace = applyCreatedWorkspace(created, options);
      if (options.refreshWorkspaceScan === false) {
        // Uploading the first attachment should not wait on the unrelated
        // workspace-library refresh before it can start its host upload.
        void backend.listWorkspaces()
          .then(setWorkspaceScan)
          .catch((error) => console.warn("Failed to refresh workspace list after workspace creation", error));
      } else {
        setWorkspaceScan(await backend.listWorkspaces());
      }
      return workspace;
    })();
    workspaceCreationPromiseRef.current = creation;

    try {
      return await creation;
    } finally {
      if (workspaceCreationPromiseRef.current === creation) {
        workspaceCreationPromiseRef.current = null;
      }
    }
  }

  async function uploadUploadedSource(file: File) {
    if (!backend) return;
    setLoading("upload");
    try {
      // The first attachment may be what creates the Workspace. Keep the
      // composer state while that happens: applying a newly-created workspace
      // normally clears the prompt, which made the first upload erase Brief.
      const workspace = await ensureCurrentWorkspace({
        preserveWorkflowState: true,
        refreshWorkspaceScan: false,
      });
      if (!workspace) return;
      const result = await uploadUploadedSourceFile(workspace, file);
      const activeSources = result.index.materials.filter((item) => item.status === "active");
      setUploadedSources(activeSources);
      setUploadedSourcePreflights([]);
      setCurrentUploadedSourceAnalysis(null);
      setUploadedSourceAnalysisError("");
      setUploadedSourceAnalysisProgress(createUploadedSourceAnalysisProgress(t, {
        sourceCount: activeSources.length,
      }));
      showToast(
        result.warnings.length > 0
          ? result.warnings[0]
          : t.toasts.attachmentAdded
      );
      // These are diagnostics/navigation refreshes, not prerequisites for
      // editing the Brief or using the newly committed attachment.
      void backend.appendWorkspaceLog({
        workspace_dir: workspace.workspace_dir,
        channel: "ai-research",
        entry: {
          event: "uploaded_source.uploaded",
          schema_version: 1,
          uploaded_source_id: result.material.uploaded_source_id,
          filename: result.material.original_filename,
          extension: result.material.extension,
          size_bytes: result.material.size_bytes,
          sha256: result.material.sha256,
          duplicate_of: result.material.duplicate_of ?? null,
          warnings: result.warnings,
          updated_at: new Date().toISOString(),
        },
      }).catch((error) => {
        console.warn("Failed to append uploaded source upload log", error);
      });
      void backend.listWorkspaces()
        .then(setWorkspaceScan)
        .catch((error) => console.warn("Failed to refresh workspace list after source upload", error));
    } catch (error) {
      // Backend errors can include internal paths and byte counts. The Brief
      // keeps a persistent localised attachment error while the technical
      // detail remains available in runtime logs.
      showToast(t.toasts.attachmentUploadFailed);
      throw error;
    } finally {
      setLoading("none");
    }
  }

  async function removeUploadedSource(uploadedSourceId: string) {
    if (!backend) return;
    const workspace = await ensureCurrentWorkspace();
    if (!workspace) return;
    const workspaceDir = workspace.workspace_dir;
    setLoading("upload");
    try {
      const result = await backend.removeUploadedSource({
        workspace_dir: workspaceDir,
        uploaded_source_id: uploadedSourceId,
      });
      // Navigation may have opened or created another workspace while the
      // removal RPC was in flight. Never repopulate that new Brief with the
      // old workspace's attachment index.
      if (currentWorkspaceRef.current?.workspace_dir !== workspaceDir) return;
      await backend.appendWorkspaceLog({
        workspace_dir: workspaceDir,
        channel: "ai-research",
        entry: {
          event: "uploaded_source.removed",
          schema_version: 1,
          uploaded_source_id: uploadedSourceId,
          filename: result.material.original_filename,
          active_count: result.index.materials.filter((item) => item.status === "active").length,
          updated_at: new Date().toISOString(),
        },
      }).catch((error) => {
        console.warn("Failed to append uploaded source remove log", error);
      });
      const activeSources = result.index.materials.filter((item) => item.status === "active");
      setUploadedSources(activeSources);
      setUploadedSourcePreflights([]);
      setCurrentUploadedSourceAnalysis(null);
      setUploadedSourceAnalysisError("");
      setUploadedSourceAnalysisProgress(
        activeSources.length === 0
          ? createSkippedUploadedSourceAnalysisProgress(t)
          : createUploadedSourceAnalysisProgress(t, { sourceCount: activeSources.length })
      );
      setWorkspaceScan(await backend.listWorkspaces());
      showToast(t.toasts.attachmentRemoved);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t.toasts.attachmentRemoved);
    } finally {
      setLoading("none");
    }
  }

  async function refreshCurrentWorkspaceSnapshot() {
    if (!backend) return null;
    const workspace = await ensureCurrentWorkspace();
    if (!workspace) return null;
    const isCurrent = captureReviewResultGuard(workspace.workspace_dir);
    const refreshedWorkspace = await backend.openWorkspace({
      workspace_dir: workspace.workspace_dir,
    });
    const workspaceSnapshot = activeGenerationRun
      ? refreshedWorkspace
      : await reconcileWorkspaceInterruptedPages(refreshedWorkspace);
    if (!isCurrent()) return null;
    currentWorkspaceRef.current = workspaceSnapshot;
    setCurrentWorkspace(workspaceSnapshot);
    return workspaceSnapshot;
  }

  function readSelectedTemplateGroup(workspace: WorkspaceResult | null) {
    const templateRecord =
      workspace?.template && typeof workspace.template === "object" && !Array.isArray(workspace.template)
        ? (workspace.template as { selected_template_group?: unknown })
        : null;
    return typeof templateRecord?.selected_template_group === "string"
      ? templateRecord.selected_template_group
      : "";
  }

  async function ensureWorkspaceThemeTokenForGeneration(
    workspace: WorkspaceResult,
    rows: ContextRow[] = contextRows,
    options: {
      runKind?: "deck-generation" | "deck-refinement";
      refinementRequest?: string;
      brief?: string;
    } = {},
  ) {
    if (!backend || !aiClient) return workspace;
    setLoading("theme");
    const result = await generateWorkspaceThemeToken({
      backend,
      aiClient,
      aiLogger,
      workspace,
      prompt: options.brief ?? prompt,
      contextRows: buildLlmContextRows(rows),
      locale,
      runKind: options.runKind ?? "deck-generation",
      refinementRequest: options.refinementRequest,
    });
    applyWorkspace(result.workspace);
    setWorkspaceScan(await backend.listWorkspaces());
    if (result.fallbackUsed) {
      showToast(t.toasts.themeFallbackUsed);
    }
    return result.workspace;
  }

  async function ensureWorkspaceTemplate(workspace: WorkspaceResult) {
    if (!backend) return workspace;

    const groupId = selectedTemplateGroupId ?? DEFAULT_TEMPLATE_GROUP_ID;
    if (readSelectedTemplateGroup(workspace) === groupId) {
      return workspace;
    }

    const result = await backend.selectTemplate({
      workspace_dir: workspace.workspace_dir,
      template_group: groupId
    });
    applyWorkspace(result.workspace);
    setSelectedTemplateGroupId(result.selection.selected_template_group);
    setWorkspaceScan(await backend.listWorkspaces());
    return result.workspace;
  }

  async function appendOutlineAiLog(
    workspace: WorkspaceResult | null,
    entry: Record<string, unknown>
  ) {
    if (!backend || !workspace) return;

    try {
      await backend.appendWorkspaceLog({
        workspace_dir: workspace.workspace_dir,
        channel: "ai-outline",
        entry
      });
    } catch (error) {
      console.warn(
        "Failed to append outline AI log",
        error instanceof Error ? error.message : error
      );
    }
  }

  async function appendOutlineAiAttemptLogs(
    workspace: WorkspaceResult | null,
    attempts: AiAttemptLog[],
    logContext?: AiOperationLogContext
  ) {
    for (const attempt of attempts) {
      await appendOutlineAiLog(workspace, {
        event: `ai.outline.${attempt.operation}.attempt`,
        schema_version: 1,
        operation_id: logContext?.operation_id,
        interaction_ids: logContext?.interaction_ids ?? [],
        operation: attempt.operation,
        attempt: attempt.attempt,
        status: attempt.status,
        validation: attempt.validation,
        session_attempt: attempt.sessionAttempt,
        stage: attempt.stage,
        page_range: attempt.pageRange,
        error: attempt.error,
      });
    }
  }

  async function appendOutlineErrorLog(
    workspace: WorkspaceResult | null,
    operation: AiAttemptLog["operation"],
    error: unknown
  ) {
    const attempts =
      error &&
      typeof error === "object" &&
      "attempts" in error &&
      Array.isArray((error as { attempts?: unknown }).attempts)
        ? ((error as { attempts: AiAttemptLog[] }).attempts)
        : [];

    if (attempts.length > 0) {
      await appendOutlineAiAttemptLogs(workspace, attempts);
      return;
    }

    await appendOutlineAiLog(workspace, {
      event: `ai.outline.${operation}.error`,
      operation,
      status: "error",
      error: {
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }

  async function scanWorkspaces() {
    if (!backend) return;

    setWorkspaceLoading(true);
    setWorkspaceError("");
    try {
      setWorkspaceScan(await backend.listWorkspaces());
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : "Failed to scan tasks."
      );
    } finally {
      setWorkspaceLoading(false);
    }
  }

  /**
   * Read-only status refresh for the My Work cloud pill. It deliberately does
   * not list cloud workspaces, load covers, start a restore, or request an
   * upload; the card only reflects the engine's already-persisted state.
   */
  const refreshWorkspaceSyncStates = useCallback(async (workspaces: WorkspaceSummary[]) => {
    if (!backend) return;
    const operationId = workspaceSyncStateOperationRef.current + 1;
    workspaceSyncStateOperationRef.current = operationId;
    const isCurrent = () => workspaceSyncStateOperationRef.current === operationId;
    const syncStates: Record<string, WorkspaceSnapshotSyncState | null> = {};

    await mapWithConcurrencyLimit(workspaces, WORKSPACE_COVER_CONCURRENCY, async (item) => {
      if (!isCurrent()) return;
      let state: WorkspaceSnapshotSyncState | null = null;
      try {
        state = await backend.getWorkspaceSnapshotSyncState({
          workspace_dir: item.task_dir ?? item.workspace_dir,
        });
      } catch {
        // A per-card status read is informational. Retain the neutral state
        // rather than letting one unavailable Workspace block the list.
      }
      if (isCurrent()) syncStates[item.workspace_id] = state;
    });

    if (isCurrent()) setWorkspaceSyncStates(syncStates);
  }, [backend]);

  /**
   * WORK-001: the list is published as soon as `listWorkspaces()` resolves.
   * Covers then load per card behind a concurrency limit, and every write is
   * guarded by an operation id so a late response from a previous visit cannot
   * overwrite a newer list.
   *
   * Overlapping triggers share one listing: a second invoke would only queue on
   * the same engine and push the first closer to its timeout. `force` marks a
   * trigger that raced a write, so the listing already in flight cannot answer it.
   */
  async function refreshMyWork(options: { force?: boolean } = {}) {
    if (!backend) return;

    if (myWorkRefreshRef.current) {
      // Opening a Workspace bumps the same counter, which discards the in-flight
      // listing's writes: a trigger arriving after that needs a fresh run.
      if (options.force || myWorkRefreshGenerationRef.current !== myWorkOperationRef.current) {
        myWorkRefreshRerunRef.current = true;
      }
      return myWorkRefreshRef.current;
    }

    const skipCloudList = !options.force
      && Date.now() - myWorkCloudListFetchedAtRef.current < MY_WORK_CLOUD_LIST_TTL_MS;
    if (!skipCloudList) myWorkCloudListFetchedAtRef.current = Date.now();

    const run = (async () => {
      // Establish ownership before launching independent background requests.
      setHighlightedWorkspaceId(null);
      const operationId = myWorkOperationRef.current + 1;
      myWorkOperationRef.current = operationId;
      myWorkRefreshGenerationRef.current = operationId;
      const isCurrent = () => myWorkOperationRef.current === operationId;

      setWorkspaceLoading(true);
      setWorkspaceError("");
      setWorkspaceErrorDetail("");

      if (!cloudReconcileDoneRef.current) {
        cloudReconcileDoneRef.current = true;
        cloudReconcileRequestRef.current = backend.autoRestoreMissingWorkspaces()
          .finally(() => { cloudReconcileRequestRef.current = null; });
      }

      await loadMyWork({
        backend,
        restoration: cloudReconcileRequestRef.current,
        isCurrent,
        skipCloudList,
        onList: (scan) => {
          setWorkspaceScan(scan);
          setWorkspaceLoading(false);
          setWorkspaceSyncStates({});
        },
        onListError: (error) => {
          const { summary, detail } = summarizeUserFacingError(t, error);
          setWorkspaceError(summary);
          setWorkspaceErrorDetail(detail);
          setWorkspaceLoading(false);
        },
        onCloudWorkspaces: setCloudWorkspaces,
        onSyncState: (id, state) => setWorkspaceSyncStates((current) => ({ ...current, [id]: state })),
        onRestored: (count) => {
          showToast(formatMessage(t.myWork.cloudRestored, { count }));
          // Refresh after restoration, including if a newer visit joined the
          // in-flight restore. Now local, the restored Workspace must drop out of
          // the cloud section, so this cannot be served by the current listing.
          void refreshMyWork({ force: true });
        },
        onTiming: publishMyWorkTiming,
        onBackgroundError: (source, error) => {
          // A listing that never arrived is not fresh, or the next visit would
          // serve nothing from the TTL instead of retrying.
          if (source === "cloud-sync") myWorkCloudListFetchedAtRef.current = 0;
          console.error(`[${source}] My Work background request failed`, error);
        },
      });
    })();

    myWorkRefreshRef.current = run;
    try {
      await run;
    } finally {
      myWorkRefreshRef.current = null;
      if (myWorkRefreshRerunRef.current) {
        myWorkRefreshRerunRef.current = false;
        await refreshMyWork({ force: true });
      }
    }
  }

  useEffect(() => {
    if (page !== "my-work" || !backend || !workspaceScan) return;
    const workspaces = workspaceScan.tasks ?? workspaceScan.workspaces ?? [];
    if (workspaces.length === 0) return;

    const interval = window.setInterval(() => {
      void refreshWorkspaceSyncStates(workspaces);
    }, MY_WORK_SYNC_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      // Ignore any status reads still in flight after leaving My Work.
      workspaceSyncStateOperationRef.current += 1;
    };
  }, [backend, page, refreshWorkspaceSyncStates, workspaceScan]);

  async function useLatestWorkspace() {
    const latestTask = workspaceScan?.latest_task ?? workspaceScan?.latest_workspace;
    if (!backend || !latestTask) return;

    await openWorkspace(latestTask.task_dir ?? latestTask.workspace_dir);
  }


  async function showWorkspacePicker() {
    resetWebResearchProgress();
    requirementsOperationRef.current += 1;
    attachmentPreparationOperationRef.current += 1;
    requirementsProcess.clear();
    outlineProcess.clear();
    resetGenerationUiState();
    invalidateWorkspaceDiagnosticBundle();
    currentWorkspaceRef.current = null;
    setCurrentWorkspace(null);
    setUploadedSources([]);
    setUploadedSourcePreflights([]);
    setUploadedSourcePreflightRunning(false);
    setCurrentUploadedSourceAnalysis(null);
    setUploadedSourceAnalysisError("");
    setUploadedSourceAnalysisProgress(createSkippedUploadedSourceAnalysisProgress(t));
    setPage("main");
    setStage("brief");
    setHistory((items) => (items.at(-1) === "main" ? items : [...items, "main"]));
    await scanWorkspaces();
  }

  async function startNewPresentation() {
    resetWebResearchProgress();
    requirementsProcess.clear();
    outlineProcess.clear();
    requirementsOperationRef.current += 1;
    attachmentPreparationOperationRef.current += 1;
    outlineOperationRef.current += 1;
    resetGenerationUiState();
    invalidateWorkspaceDiagnosticBundle();
    currentWorkspaceRef.current = null;
    setCurrentWorkspace(null);
    setUploadedSources([]);
    setUploadedSourcePreflights([]);
    setUploadedSourcePreflightRunning(false);
    setCurrentUploadedSourceAnalysis(null);
    setUploadedSourceAnalysisError("");
    setUploadedSourceAnalysisProgress(createSkippedUploadedSourceAnalysisProgress(t));
    setPrompt("");
    setPresentationRequirements(createEmptyPresentationRequirements());
    setSelectedAspectRatio("16:9");
    setRequirementsStatus("idle");
    setRequirementsError("");
    setRequirementsErrorDetail("");
    setRequirementsDirty(false);
    setRequirementsHasSavedDraft(false);
    setSelectedVisualStylePresetId(null);
    setDeckTitle(t.deck.title);
    setDeck([]);
    setOutline([]);
    setOutlineDraft([]);
    setOutlineRequirements("");
    setOutlineDraftRequirements("");
    setOutlineDraftTitle(t.deck.title);
    setOutlineError("");
    setOutlineErrorDetail("");
    setOutlineFeedback("");
    setGenerated(false);
    setCurrentSlide(0);
    setPageProgress(null);
    setCreateDeckProgress(null);
    setGenerationHistory([]);
    setActiveGenerationRun(null);
    resetGenerationPagePreviews();
    setStage("brief");
    setPage("main");
    setHistory(["main"]);
    await scanWorkspaces();
  }

  /**
   * WORK-008: only the card being opened shows progress, and a failure keeps the
   * list on screen with a plain-language reason instead of a raw RPC payload.
   */
  async function openWorkspace(workspaceDir: string) {
    // WORK-008: repeated clicks on the same card must not start a second open.
    if (!backend || openingWorkspaceDirRef.current) return;
    openingWorkspaceDirRef.current = workspaceDir;
    const operationId = myWorkOperationRef.current + 1;
    myWorkOperationRef.current = operationId;
    const isCurrent = () => myWorkOperationRef.current === operationId;

    setOpeningWorkspaceDir(workspaceDir);
    setWorkspaceError("");
    setWorkspaceErrorDetail("");

    try {
      // Cloud-priority conflict resolution: compare this Workspace against its
      // APS current_snapshot before opening. When they differ with never-synced
      // local work, the plugin saves that work as a copy Workspace first, then
      // force-restores the cloud snapshot over the original. Best-effort: any
      // transport/network failure just opens the local version as-is.
      let reconcileToast: string | null = null;
      try {
        const reconcileResult = await backend.reconcileWorkspaceWithCloud({ workspace_dir: workspaceDir });
        if (!isCurrent()) return;
        if (reconcileResult.status === "restore_failed") {
          // Empty local tree and the cloud snapshot could not be restored: there
          // is nothing useful to open. Keep the card on screen for a retry.
          setWorkspaceError(
            reconcileResult.error?.message ?? formatMessage(t.toasts.reconcileRestoreFailed, {}),
          );
          return;
        }
        if (reconcileResult.status === "restored") {
          reconcileToast = formatMessage(t.toasts.reconcileRestored, { id: reconcileResult.workspace_id });
        } else if (reconcileResult.status === "local_semantic_validation_failed") {
          reconcileToast = formatMessage(t.toasts.reconcileLocalSnapshotValidationFailed, {});
        } else if (reconcileResult.status === "conflict_resolved") {
          // Cloud-priority won and the local work was saved as a copy: surface
          // the outcome as a prominent dialog instead of a short-lived toast.
          setCloudConflictDialog({
            status: "conflict_resolved",
            workspaceId: reconcileResult.workspace_id,
            backupTitle: reconcileResult.backup_title ?? null,
          });
        } else if (reconcileResult.status === "conflict_blocked") {
          // The backup copy failed, so the cloud was NOT overwritten: the local
          // version is intact and safe to open, but the conflict stays unresolved.
          setCloudConflictDialog({
            status: "conflict_blocked",
            workspaceId: reconcileResult.workspace_id,
            backupTitle: null,
          });
        } else if (reconcileResult.status === "conflict_restore_failed") {
          reconcileToast = formatMessage(t.toasts.reconcileRestoreFailed, {});
        }
      } catch {
        // Reconcile is best-effort: never block opening on a transport error.
      }

      const openedWorkspace = await backend.openWorkspace({ workspace_dir: workspaceDir });
      if (!isCurrent()) return;

      requirementsOperationRef.current += 1;
      resetGenerationUiState();
      invalidateWorkspaceDiagnosticBundle();

      const workspace = await reconcileWorkspaceInterruptedPages(openedWorkspace);
      resetWebResearchProgress();
      applyWorkspace(workspace, { syncEmptyContextRows: true });
      // A completed deck already has enough Workspace metadata to show the
      // finished-deck shell and its manual-edit/preview/export actions. Do not
      // make that first paint wait for the generation-run lookup (which is
      // notably slow in Cloud). The preview images keep loading in the
      // background through applyWorkspace(). An active transaction below still
      // takes precedence and switches to its generating view once confirmed.
      const completedDeckAvailable = completedDeckIsAvailable(
        isWorkspaceDeckStale(workspace),
        normalizeWorkspacePageProgress(workspace.page_progress),
      );
      if (completedDeckAvailable) {
        setGenerated(true);
        setStage("deck");
        setPage("main");
        setHistory((items) => (items.at(-1) === "main" ? items : [...items, "main"]));
      }
      const transaction = await backend.getWorkspaceGenerationRun({ workspace_dir: workspace.workspace_dir });
      if (transaction?.state === "active" || transaction?.state === "preparing") {
        setGenerationTransaction(transaction);
        if (transaction.state === "active") {
          const shadowWorkspace = await backend.openWorkspace({ workspace_dir: transaction.shadow_workspace_dir });
          applyWorkspace(shadowWorkspace, { preserveCurrentSlide: true });
          setCurrentWorkspace(workspace);
        }
        setStage("generating");
        setPage("main");
      }
      setPage("main");
      setHistory((items) => (items.at(-1) === "main" ? items : [...items, "main"]));
      showToast(
        reconcileToast ?? formatMessage(t.toasts.workspaceOpened, { id: workspace.task_id ?? workspace.workspace_id }),
      );
    } catch (error) {
      // WORK-008: keep My Works usable and surface a readable summary instead of
      // the raw RPC envelope; the card itself stays in place for a retry.
      const { summary, detail } = summarizeUserFacingError(t, error, t.myWork.openFailed);
      setWorkspaceError(summary);
      setWorkspaceErrorDetail(detail);
    } finally {
      openingWorkspaceDirRef.current = null;
      setOpeningWorkspaceDir(null);
    }
  }

  async function createWorkspace() {
    if (!backend) return;

    resetGenerationUiState();
    invalidateWorkspaceDiagnosticBundle();
    setWorkspaceLoading(true);
    setWorkspaceError("");
    try {
      const created = await backend.createWorkspace({
        title: getDefaultWorkspaceTitle()
      });
      const workspace = applyCreatedWorkspace(created);
      setWorkspaceScan(await backend.listWorkspaces());
      setPage("main");
      showToast(formatMessage(t.toasts.workspaceCreated, { id: workspace.task_id ?? workspace.workspace_id }));
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : "Failed to create workspace."
      );
    } finally {
      setWorkspaceLoading(false);
    }
  }

  async function selectTemplate(groupId: string) {
    if (!backend) return;
    if (!isSelectableTemplateGroup(groupId)) {
      showToast(t.template.empty);
      return;
    }

    setLoading("template");
    try {
      const workspace = await ensureCurrentWorkspace();
      if (!workspace) return;
      const result = await backend.selectTemplate({
        workspace_dir: workspace.workspace_dir,
        template_group: groupId
      });
      applyWorkspace(result.workspace);
      setSelectedTemplateGroupId(result.selection.selected_template_group);
      setWorkspaceScan(await backend.listWorkspaces());
      setStage("brief");
      showToast(t.template.selected);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t.template.empty);
    } finally {
      setLoading("none");
    }
  }

  async function saveWorkspaceSettings(setting: WorkspaceSettings) {
    if (!backend) return;

    setWorkspaceSettingsSaving(true);
    setWorkspaceError("");
    try {
      const result = await backend.patchWorkspaceDefaults({ setting });
      applyWorkspaceSetting(result.setting);
      showToast(t.status.settingsSaved);
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : "Failed to save settings."
      );
    } finally {
      setWorkspaceSettingsSaving(false);
    }
  }

  /**
   * The three controls below the Brief field must acknowledge a click without
   * waiting for a host RPC. Their writes are still persisted in click order,
   * because the backend returns the whole settings record and out-of-order
   * responses would otherwise restore a stale value.
   */
  async function persistBriefWorkspaceSettings(patch: WorkspaceSettings): Promise<boolean> {
    if (!backend) return false;
    const mutation = briefSettingsMutationRef.current + 1;
    briefSettingsMutationRef.current = mutation;
    applyWorkspaceSetting({ ...globalSettingsRef.current, ...patch });
    setWorkspaceError("");

    const persist = async () => {
      try {
        const result = await backend.patchWorkspaceDefaults({ setting: patch });
        // A later click already owns the visible optimistic value. Its queued
        // request will become authoritative after this one finishes.
        if (briefSettingsMutationRef.current === mutation) {
          applyWorkspaceSetting(result.setting);
        }
        return true;
      } catch (error) {
        if (briefSettingsMutationRef.current === mutation) {
          setWorkspaceError(
            error instanceof Error ? error.message : "Failed to save settings."
          );
        }
        // Do not break the queue: the following click may still persist fine.
        return false;
      }
    };
    const queued = briefSettingsSaveQueueRef.current.then(persist, persist);
    briefSettingsSaveQueueRef.current = queued;
    return queued;
  }

  async function saveWorkspaceTitle(title: string) {
    if (!backend || !currentWorkspace) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle || trimmedTitle === getWorkspaceTitle(currentWorkspace)) return;

    setWorkspaceSettingsSaving(true);
    setWorkspaceError("");
    try {
      const workspace = await backend.updateWorkspaceTitle({
        workspace_dir: currentWorkspace.workspace_dir,
        title: trimmedTitle
      });
      applyWorkspace(workspace);
      setDeckTitle(trimmedTitle);
      setWorkspaceScan(await backend.listWorkspaces());
      showToast(t.status.settingsSaved);
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : "Failed to save workspace title."
      );
    } finally {
      setWorkspaceSettingsSaving(false);
    }
  }

  async function renameWorkspace(workspaceDir: string, title: string) {
    if (!backend) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    setWorkspaceLoading(true);
    setWorkspaceError("");
    try {
      const workspace = await backend.updateWorkspaceTitle({ workspace_dir: workspaceDir, title: trimmedTitle });
      if (currentWorkspaceRef.current?.workspace_dir === workspaceDir) {
        applyWorkspace(workspace);
        setDeckTitle(trimmedTitle);
      }
      await refreshMyWork({ force: true });
      showToast(t.status.settingsSaved);
    } catch (error) {
      const { summary, detail } = summarizeUserFacingError(t, error);
      setWorkspaceError(summary);
      setWorkspaceErrorDetail(detail);
    } finally {
      setWorkspaceLoading(false);
    }
  }

  async function deleteWorkspace(workspaceDir: string, title: string) {
    if (!backend) return;
    // Deleting a Workspace removes every file it owns, so it always goes
    // through the app-owned destructive confirmation.
    const confirmed = await requestConfirmation({
      title: t.myWork.deleteTitle,
      body: formatMessage(t.myWork.deleteBody, { title }),
      cancelLabel: t.controls.cancel,
      confirmLabel: t.myWork.deleteConfirm,
      tone: "danger",
    });
    if (!confirmed) return;
    setWorkspaceLoading(true);
    setWorkspaceError("");
    setWorkspaceErrorDetail("");
    try {
      await backend.deleteWorkspace({ workspace_dir: workspaceDir });
      if (currentWorkspaceRef.current?.workspace_dir === workspaceDir) {
        await startNewPresentation();
      } else {
        await refreshMyWork({ force: true });
      }
    } catch (error) {
      const { summary, detail } = summarizeUserFacingError(t, error);
      setWorkspaceError(summary);
      setWorkspaceErrorDetail(detail);
    } finally {
      setWorkspaceLoading(false);
    }
  }

  /**
   * WORK-005: the copy is an independent Workspace, so the user stays in the
   * list and the new card is highlighted instead of being opened for them.
   */
  async function duplicateWorkspace(workspaceDir: string, sourceTitle: string) {
    if (!backend) return;
    setWorkspaceError("");
    setWorkspaceErrorDetail("");
    try {
      const copy = await backend.duplicateWorkspace({
        workspace_dir: workspaceDir,
        title: formatMessage(t.myWork.duplicateTitle, { title: sourceTitle }),
      });
      await refreshMyWork({ force: true });
      setHighlightedWorkspaceId(copy.workspace_id);
      showToast(copy.snapshot_error ? t.myWork.duplicateSnapshotFailed : t.myWork.duplicated);
    } catch (error) {
      const { summary, detail } = summarizeUserFacingError(t, error, t.myWork.duplicateFailed);
      setWorkspaceError(summary);
      setWorkspaceErrorDetail(detail);
    }
  }

  function dismissCloudConflictDialog() {
    setCloudConflictDialog(null);
  }

  async function refreshWorkspaceSnapshotInfo() {
    if (!backend) return;
    const dir = currentWorkspaceRef.current?.task_dir ?? currentWorkspaceRef.current?.workspace_dir;
    if (!dir) return;
    setWorkspaceSnapshotInfo(null);
    setWorkspaceSnapshotSyncState(null);
    const [info, syncState] = await Promise.all([
      backend.getWorkspaceSnapshotInfo({ workspace_dir: dir }).catch(() => null),
      backend.getWorkspaceSnapshotSyncState({ workspace_dir: dir }).catch(() => null),
    ]);
    setWorkspaceSnapshotInfo(info);
    setWorkspaceSnapshotSyncState(syncState);
  }

  async function refineDeck(instruction: string) {
    if (!backend || !aiClient || !researchWebClient || !agentClient || !hostUploadClient || !currentWorkspace) return;
    const trimmedInstruction = instruction.trim();
    if (!trimmedInstruction) return;

    let activeRunWorkspaceDir: string | undefined;
    let shouldReconcileActiveRun = false;
    let generationRun: GenerationRunTransaction | null = null;
    const cancelSignal = beginCancellableGeneration();
    setLoading("refineDeck");
    resetGenerationProgress({ preservePagePreviews: true });
    // Enter the Generation page in a non-recoverable startup state. Without
    // this, its first render has neither a durable run nor progress and is
    // briefly interpreted as an interrupted run with a "Resume" action.
    setGenerationPreparing(true);
    const initialOutline = workspaceOutlineForDownstream(currentWorkspace).items;
    const initialTargetPageId = initialOutline[currentSlide]?.page_id;
    showRefinementLoadingPreviews("deck", initialOutline, initialTargetPageId);
    setStage("generating");
    setPage("main");
    try {
      const refreshedWorkspace = await refreshCurrentWorkspaceSnapshot();
      if (!refreshedWorkspace) return;
      const shadowRun = await prepareShadowGenerationRun(refreshedWorkspace, "deck-refinement", workspaceOutlineForDownstream(refreshedWorkspace).items[currentSlide]?.page_id, (transaction) => { generationRun = transaction; });
      generationRun = shadowRun.transaction;
      activeRunWorkspaceDir = shadowRun.workspace.workspace_dir;
      shouldReconcileActiveRun = true;
      showRefinementLoadingPreviews(
        "deck",
        workspaceOutlineForDownstream(shadowRun.workspace).items,
        initialTargetPageId,
      );
      const completion = await measurePerformanceOperation("deck_refinement.run", shadowRun.workspace.workspace_dir, () => runDeckRefinement({
        backend,
        aiClient,
        researchWebClient,
        agentClient,
        hostUploadClient,
        aiLogger,
        workspace: shadowRun.workspace,
        confirmedOutline: workspaceOutlineForDownstream(shadowRun.workspace),
        locale,
        instruction: trimmedInstruction,
        scope: "deck",
        onProgress: generationProgressHandler(cancelSignal),
        isCancelled: () => cancelCreateDeckRef.current,
        cancelSignal,
      }));
      if (!ownsGenerationOperation(cancelSignal)) return;
      if (completion.status === "completed" && completion.noChange) {
        await backend.abandonGenerationRun({ run_id: generationRun.run_id });
        setGenerationTransaction(null);
        const official = await backend.openWorkspace({ workspace_dir: generationRun.official_workspace_dir });
        applyWorkspace(official, { preserveCurrentSlide: true });
        showToast("当前内容无需优化。");
      } else if (completion.status === "completed") {
        const committed = await commitShadowGenerationRun(generationRun);
        setGenerationTransaction(null);
        await applyDeckGenerationCompletion(rebaseCompletion(completion, generationRun.shadow_workspace_dir, generationRun.official_workspace_dir), committed.workspace);
      } else if (!cancelCreateDeckRef.current) {
        await applyDeckGenerationCompletion(completion, shadowRun.workspace, { resumeAllowedOnRecoverableStop: true });
      }
      shouldReconcileActiveRun = false;
      if (completion.status === "completed") {
        showToast(t.status.deckRefined);
      }
    } catch (error) {
      if (!ownsGenerationOperation(cancelSignal)) return;
      showToast(error instanceof Error ? error.message : t.status.refiningDeck);
    } finally {
      if (ownsGenerationOperation(cancelSignal)) {
        releaseGenerationPagePreviewHolds();
        setGenerationPreparing(false);
        setLoading("none");
        await finishActiveGenerationRun({
          workspaceDir: activeRunWorkspaceDir,
          reconcileInterrupted: shouldReconcileActiveRun && !generationRun,
        });
      }
      if (generationRun) void backend.cleanupGenerationRun({ run_id: generationRun.run_id }).catch((error) => console.warn("Failed to clean generation run", error));
    }
  }

  async function refineSlide(instruction: string) {
    if (!backend || !aiClient || !researchWebClient || !agentClient || !hostUploadClient || !currentWorkspace) return;
    const trimmedInstruction = instruction.trim();
    if (!trimmedInstruction) return;
    const slide = deck[currentSlide];
    if (!slide) return;

    // This is the tester-facing latency for one Page Refinement: it includes
    // refreshing the official Workspace, creating the shadow Workspace,
    // authoring and rendering the page, and publishing the successful result.
    // Keep the narrower page_refinement.run span below so reports can still
    // separate the AI workflow itself from transaction setup and commit time.
    const endToEndSpan = beginPerformanceSpan({
      operationName: "page_refinement.end_to_end",
      workspaceId: currentWorkspace.workspace_id,
      attributes: { layer: "workflow" },
    });
    let endToEndStatus: "ok" | "error" | "interrupted" = "ok";
    let activeRunWorkspaceDir: string | undefined;
    let shouldReconcileActiveRun = false;
    let generationRun: GenerationRunTransaction | null = null;
    const cancelSignal = beginCancellableGeneration();
    setLoading("refineSlide");
    resetGenerationProgress({ preservePagePreviews: true });
    // See refineDeck: preparation starts before navigating so recovery
    // controls never flash while the shadow Workspace is being created.
    setGenerationPreparing(true);
    const initialOutline = workspaceOutlineForDownstream(currentWorkspace).items;
    const initialTargetPageId = reviewRenderRef.current.result?.slides[currentSlide]?.slide_id
      ?? initialOutline[currentSlide]?.page_id;
    showRefinementLoadingPreviews("slide", initialOutline, initialTargetPageId);
    setStage("generating");
    setPage("main");
    try {
      const refreshedWorkspace = await refreshCurrentWorkspaceSnapshot();
      if (!refreshedWorkspace) {
        endToEndStatus = "interrupted";
        return;
      }
      const originPageId = initialTargetPageId;
      const canPublish = captureReviewResultGuard(refreshedWorkspace.workspace_dir);
      const shadowRun = await prepareShadowGenerationRun(refreshedWorkspace, "page-refinement", originPageId, (transaction) => { generationRun = transaction; });
      generationRun = shadowRun.transaction;
      activeRunWorkspaceDir = shadowRun.workspace.workspace_dir;
      shouldReconcileActiveRun = true;
      showRefinementLoadingPreviews(
        "slide",
        workspaceOutlineForDownstream(shadowRun.workspace).items,
        originPageId,
      );
      const completion = await measurePerformanceOperation("page_refinement.run", shadowRun.workspace.workspace_dir, () => runDeckRefinement({
        backend,
        aiClient,
        researchWebClient,
        agentClient,
        hostUploadClient,
        aiLogger,
        workspace: shadowRun.workspace,
        confirmedOutline: workspaceOutlineForDownstream(shadowRun.workspace),
        locale,
        instruction: trimmedInstruction,
        scope: "slide",
        pageId: originPageId,
        onProgress: generationProgressHandler(cancelSignal),
        isCancelled: () => cancelCreateDeckRef.current,
        cancelSignal,
      }));
      if (!ownsGenerationOperation(cancelSignal)) {
        endToEndStatus = "interrupted";
        return;
      }
      if (completion.status === "completed") {
        const committed = await commitShadowGenerationRun(generationRun);
        if (!ownsGenerationOperation(cancelSignal) || !canPublish()) return;
        setGenerationTransaction(null);
        await applyDeckGenerationCompletion(
          rebaseCompletion(completion, generationRun.shadow_workspace_dir, generationRun.official_workspace_dir),
          committed.workspace, { returnPageId: originPageId, changedPageIds: originPageId ? [originPageId] : [] },
        );
      } else if (!cancelCreateDeckRef.current) {
        await applyDeckGenerationCompletion(completion, shadowRun.workspace, { resumeAllowedOnRecoverableStop: true });
      }
      if (completion.status === "cancelled" || cancelCreateDeckRef.current) {
        endToEndStatus = "interrupted";
      } else if (completion.status === "failed") {
        endToEndStatus = "error";
      }
      shouldReconcileActiveRun = false;
      if (completion.status === "completed") {
        showToast(t.status.slideRefined);
      }
    } catch (error) {
      endToEndStatus = cancelCreateDeckRef.current ? "interrupted" : "error";
      if (!ownsGenerationOperation(cancelSignal)) return;
      showToast(error instanceof Error ? error.message : t.status.refiningSlide);
    } finally {
      if (ownsGenerationOperation(cancelSignal)) {
        releaseGenerationPagePreviewHolds();
        setGenerationPreparing(false);
        setLoading("none");
        await finishActiveGenerationRun({
          workspaceDir: activeRunWorkspaceDir,
          reconcileInterrupted: shouldReconcileActiveRun && !generationRun,
        });
      }
      if (generationRun) void backend.cleanupGenerationRun({ run_id: generationRun.run_id }).catch((error) => console.warn("Failed to clean generation run", error));
      endToEndSpan?.finish(endToEndStatus);
    }
  }

  function buildRewriteCurrentSlideInstruction() {
    return [
      "Rewrite only the current slide for clarity, impact, and executive readability.",
      "Keep the current slide purpose, key message, factual content, and evidence.",
      "Do not add unsupported facts, numbers, dates, names, citations, examples, or claims.",
      "Prefer concise wording, stronger hierarchy, and cleaner slide-level narrative.",
      "Do not change other pages.",
    ].join("\n");
  }

  function buildChangeCurrentSlideLayoutInstruction(
    mode: "simpler" | "visual" | "comparison" | "process" | "report",
  ) {
    const modeInstruction = {
      simpler:
        "Make the slide simpler: reduce density, clarify the hierarchy, and keep only the essential message and support.",
      visual:
        "Make the slide more visual: use stronger visual grouping, callouts, metrics, or diagram-like structure where appropriate.",
      comparison:
        "Make the slide better for comparison: organize content into clear side-by-side dimensions, tradeoffs, or benchmark structure.",
      process:
        "Make the slide better for process explanation: organize content into stages, sequence, flow, or roadmap structure.",
      report:
        "Make the slide better for an executive report: emphasize conclusion-first structure, concise evidence, and decision-ready framing.",
    }[mode];

    return [
      "Change only the current slide layout direction while preserving its factual content and key message.",
      modeInstruction,
      "You may restructure the current slide TSX and data, and you may reference available blueprints/components for layout ideas.",
      "Do not modify visual-rhythm.md, page-visual-plans, manifest slide ids, other pages, or unrelated shared files.",
      "Do not add unsupported facts, numbers, dates, names, citations, examples, or claims.",
      "If content does not fit the requested layout, prioritize truthful omission or TBD over invention.",
    ].join("\n");
  }

  async function rewriteCurrentSlide() {
    await refineSlide(buildRewriteCurrentSlideInstruction());
  }

  async function changeCurrentSlideLayout(
    mode: "simpler" | "visual" | "comparison" | "process" | "report",
  ) {
    await refineSlide(buildChangeCurrentSlideLayoutInstruction(mode));
  }

  async function renderDeckHtmlForWorkspace(
    workspace: WorkspaceResult,
    loadingKind: LoadingKind
  ): Promise<RenderDeckHtmlResult | null> {
    if (!backend || currentWorkspaceRef.current?.workspace_dir !== workspace.workspace_dir) return null;
    const requestId = ++reviewLoadRequestRef.current;
    const canPublish = captureReviewResultGuard(workspace.workspace_dir);
    const isCurrent = () => reviewLoadRequestRef.current === requestId && canPublish();
    setLoading(loadingKind);
    setReviewRender((current) => current.result?.workspace_dir === workspace.workspace_dir ? current : {
      status: "loading", result: null, error: "", renderKey: workspaceReviewRenderKey(workspace),
    });

    try {
      const submission = await backend.renderDeckHtml({
        workspace_dir: workspace.workspace_dir
      });
      if (!isCurrent()) return null;
      const completedProgress = await waitForFinalDeckRender({
        backend,
        workspaceDir: workspace.workspace_dir,
        submission,
        onProgress: (nextProgress) => { if (isCurrent()) setPageProgress(nextProgress); },
      });
      if (!isCurrent()) return null;
      if (!completedProgress) throw new Error("Final Deck render was cancelled.");
      const metadata = await backend.getRenderedDeckHtml({
        allow_partial: true, workspace_dir: workspace.workspace_dir,
      });
      if (!isCurrent()) return null;
      const refreshedWorkspace = await backend.openWorkspace({
        workspace_dir: workspace.workspace_dir
      });
      if (!isCurrent()) return null;
      const result = publishDeckResult(refreshedWorkspace, metadata, { changedPageIds: [] });
      void backend.listWorkspaces().then(setWorkspaceScan).catch((error) => {
        console.warn(
          "Failed to refresh tasks after render",
          error instanceof Error ? error.message : error
        );
      });
      return result;
    } catch (error) {
      if (!isCurrent()) return null;
      const message =
        error instanceof Error ? error.message : "Failed to render deck HTML.";
      const renderKey = workspaceReviewRenderKey(workspace);
      setReviewRender((current) => current.result ? current : {
        status: "error", result: null, error: message, renderKey,
      });
      showToast(message);
      return null;
    } finally {
      if (reviewLoadRequestRef.current === requestId) {
        setLoading((current) => current === loadingKind ? "none" : current);
      }
    }
  }

  async function loadDeckHtmlForWorkspace(
    workspace: WorkspaceResult,
    loadingKind: LoadingKind
  ): Promise<RenderDeckHtmlResult | null> {
    if (!backend) return null;

    const requestId = ++reviewLoadRequestRef.current;
    const canPublish = captureReviewResultGuard(workspace.workspace_dir);
    const renderKey = workspaceReviewRenderKey(workspace);
    const isCurrent = () => reviewLoadRequestRef.current === requestId && canPublish()
      && currentWorkspaceRef.current?.workspace_dir === workspace.workspace_dir
      && workspaceReviewRenderKey(currentWorkspaceRef.current) === renderKey;
    setLoading(loadingKind);
    setReviewRender((current) => current.result?.workspace_dir === workspace.workspace_dir ? current : {
      status: "loading",
      result: null,
      error: "",
      renderKey,
    });

    try {
      const outlineRecord = workspace.outline as Partial<WorkspaceOutline> | null;
      const metadata = withOutlineTitles(await backend.getRenderedDeckHtml({
        allow_partial: true, workspace_dir: workspace.workspace_dir,
      }), Array.isArray(outlineRecord?.items) ? outlineRecord.items : []);
      if (!isCurrent()) return null;
      const assembled = await assembleMeasuredReviewRender({
        backend,
        metadata,
        workspaceDir: workspace.workspace_dir,
        previews: generationPagePreviewsRef.current,
      });
      const latestWorkspace = currentWorkspaceRef.current;
      if (!isCurrent() || !latestWorkspace) return null;
      generationPagePreviewsRef.current = assembled.previews;
      setGenerationPagePreviews(assembled.previews);
      return publishDeckResult(latestWorkspace, assembled.result, { changedPageIds: [], syncWorkspace: false });
    } catch (error) {
      if (!isCurrent()) return null;
      const message = error instanceof Error ? error.message : t.review.renderFailed;
      setReviewRender((current) => current.result ? current : {
        status: "error", result: null, error: message, renderKey,
      });
      return null;
    } finally {
      if (reviewLoadRequestRef.current === requestId) {
        setLoading((current) => current === loadingKind ? "none" : current);
      }
    }
  }

  function captureReviewResultGuard(workspaceDir: string) {
    const workspace = currentWorkspaceRef.current;
    const renderKey = workspace ? workspaceReviewRenderKey(workspace) : "";
    const publication = reviewPublicationRef.current;
    return () => workspace?.workspace_dir === workspaceDir
      && currentWorkspaceRef.current?.workspace_dir === workspaceDir
      && workspaceReviewRenderKey(currentWorkspaceRef.current) === renderKey
      && reviewPublicationRef.current === publication;
  }

  function returnToDeckPage(workspaceDir: string, pageId?: string | null) {
    if (currentWorkspaceRef.current?.workspace_dir !== workspaceDir) return;
    const slides = reviewRenderRef.current.result?.slides ?? [];
    const targetIndex = pageId ? slides.findIndex((slide) => slide.slide_id === pageId) : -1;
    setCurrentSlide((current) => pageId === null ? 0 : targetIndex >= 0
      ? targetIndex : Math.min(Math.max(current, 0), Math.max(0, slides.length - 1)));
    setStage("deck");
    setPage("main");
  }

  /** All page-writing workflows publish through this synchronous boundary.
   * Saving pages and choosing where to return are intentionally independent. */
  function publishDeckResult(
    workspace: WorkspaceResult,
    metadata: RenderDeckHtmlResult | null,
    options: {
      changedPageIds: readonly string[];
      syncWorkspace?: boolean;
      returnTo?: { pageId?: string | null };
    },
  ): RenderDeckHtmlResult | null {
    const previousWorkspace = currentWorkspaceRef.current;
    if (previousWorkspace?.workspace_dir !== workspace.workspace_dir
      || (metadata && metadata.workspace_dir !== workspace.workspace_dir)) return null;
    const previous = reviewRenderRef.current;
    const outlineRecord = workspace.outline as Partial<WorkspaceOutline> | null;
    const result = metadata ? reconcileReviewRender({
      previous: previous.renderKey === workspaceReviewRenderKey(previousWorkspace) ? previous.result : null,
      metadata,
      previousProgress: normalizeWorkspacePageProgress(previousWorkspace.page_progress),
      nextProgress: normalizeWorkspacePageProgress(workspace.page_progress),
      changedPageIds: options.changedPageIds,
      outline: Array.isArray(outlineRecord?.items) ? outlineRecord.items : [],
    }) : null;
    reviewPublicationRef.current += 1;
    if (options.syncWorkspace !== false && result) {
      // Passing metadata avoids a second load and keeps the mounted previews.
      applyWorkspace(workspace, { reviewRenderResult: result, preserveCurrentSlide: true });
    } else {
      currentWorkspaceRef.current = workspace;
      setCurrentWorkspace(workspace);
    }
    setPageProgress(normalizeWorkspacePageProgress(workspace.page_progress));
    const nextReview: DeckReviewRenderState = {
      status: result ? "ready" : "idle", result, error: "", renderKey: workspaceReviewRenderKey(workspace),
    };
    // Consecutive saves may finish before React renders; the next save must
    // merge with this publication rather than the previous render's closure.
    reviewRenderRef.current = nextReview;
    setReviewRender(nextReview);
    if (result) applyRenderedDeck(result, undefined, { activateDeck: false, preserveCurrentSlide: true });
    const previews = { ...generationPagePreviewsRef.current };
    for (const pageId of options.changedPageIds) delete previews[pageId];
    generationPagePreviewsRef.current = previews;
    setGenerationPagePreviews(previews);
    if (!exportInFlightRef.current && (options.syncWorkspace !== false || options.changedPageIds.length > 0)) {
      setExportArtifactWithProgress(readWorkspaceExportArtifactPath(workspace));
    }
    if (options.returnTo) returnToDeckPage(workspace.workspace_dir, options.returnTo.pageId);
    return result;
  }

  async function applyAdoptedPage(workspaceDir: string, pageId: string) {
    if (!backend || currentWorkspaceRef.current?.workspace_dir !== workspaceDir) return;
    const isCurrent = captureReviewResultGuard(workspaceDir);
    const workspace = await backend.openWorkspace({ workspace_dir: workspaceDir });
    if (!isCurrent()) return;
    const metadata = await backend.getRenderedDeckHtml({ workspace_dir: workspaceDir, allow_partial: true });
    if (!isCurrent()) return;
    publishDeckResult(workspace, metadata, { changedPageIds: [pageId], returnTo: { pageId } });
  }

  async function exitManualEditor(workspaceDir: string, pageId: string | undefined, requiresDeckRender: boolean) {
    const workspace = currentWorkspaceRef.current;
    if (workspace?.workspace_dir !== workspaceDir) return;
    returnToDeckPage(workspaceDir, pageId);
    if (requiresDeckRender) await renderDeckHtmlForWorkspace(workspace, "review");
  }

  async function refreshReviewPageImage(_pageId: string): Promise<void> {
    // HTML preview components own their retry and resource URL refresh.
  }

  async function renderDeckHtml() {
    if (!backend) return;

    const workspace = await ensureCurrentWorkspace();
    if (!workspace) return;

    await renderDeckHtmlForWorkspace(workspace, "review");
  }

  function applyManualPageUpdate(
    result: SaveManualPageRevisionResult | RestorePageSourceVersionResult,
  ) {
    const workspace = currentWorkspaceRef.current;
    if (workspace?.workspace_dir !== result.workspace_dir) return;
    const previousProgress = normalizeWorkspacePageProgress(workspace.page_progress);
    const previousPage = previousProgress?.pages.find((page) => page.page_id === result.page_id);
    if (previousPage?.updated_at && Date.parse(previousPage.updated_at) >= Date.parse(result.page_progress_updated_at)) return;
    // Editor saves are serialized. A receipt predating another saved page is
    // stale and must not roll back its progress or aggregate deck metadata.
    if (previousProgress?.updated_at && Date.parse(previousProgress.updated_at) > Date.parse(result.page_progress_updated_at)) return;
    const htmlPath = "manifest" in result
      ? result.manifest.current_html_path
      : result.html_path;
    const sourceFingerprint = "manifest" in result
      ? result.manifest.current_html_sha256
      : result.page_progress?.pages.find((page) => page.page_id === result.page_id)?.render_source_sha256;
    const manuallyEdited = "manifest" in result || result.manually_edited === true;
    const patchProgress = (current: PageProgress | null): PageProgress | null => {
      if ("page_progress" in result && result.page_progress) return result.page_progress;
      if (!current) return current;
      const existingFinalRender = current.final_deck_render;
      return {
        ...current,
        final_deck_render: result.final_deck_render_updated
          ? {
              status: "completed",
              message: null,
              error: null,
              output_dir: existingFinalRender?.output_dir ?? null,
              deck_html_path: result.deck_html_path,
              rendered_at: result.rendered_at,
              updated_at: result.page_progress_updated_at,
            }
          : {
              status: "idle",
              message: "Manual page saved; Final Deck Render requires a rebuild.",
              error: null,
              output_dir: null,
              deck_html_path: null,
              rendered_at: null,
              updated_at: result.page_progress_updated_at,
            },
        pages: current.pages.map((page) => page.page_id === result.page_id ? {
          ...page,
          render_source_sha256: sourceFingerprint ?? page.render_source_sha256,
          snapshot_source_sha256: sourceFingerprint ?? page.snapshot_source_sha256,
          last_html_path: htmlPath,
          last_screenshot_path: "",
          updated_at: result.page_progress_updated_at,
        } : page),
        updated_at: result.page_progress_updated_at,
      };
    };
    const nextPageProgress = patchProgress(previousProgress);
    const previousRender = reviewRenderRef.current.result;
    const metadata = previousRender?.workspace_dir === result.workspace_dir ? {
      ...previousRender,
      deck_html_path: result.deck_html_path ?? previousRender.deck_html_path,
      rendered_at: result.rendered_at ?? previousRender.rendered_at,
      slides: previousRender.slides.map((slide) => slide.slide_id === result.page_id ? {
        ...slide,
        html_path: htmlPath,
        render_source_fingerprint: sourceFingerprint ?? slide.render_source_fingerprint,
        // slideforge-ppt made screenshots transient and keys previews off the
        // server-provided fingerprint; the manual-save discriminator below is
        // still consumed by the outer preview cache (see previewVersionCache).
        screenshot_path: "",
        preview_source_fingerprint: result.preview_source_fingerprint,
        // The authoritative slides/<page_id>.html path stays stable across
        // saves; use the server version to invalidate just this page.
        preview_version: `manual-save:${result.page_progress_updated_at}`,
        manually_edited: manuallyEdited,
        preview_unavailable: false,
      } : slide),
    } : null;
    const task = workspace.task && typeof workspace.task === "object" && !Array.isArray(workspace.task)
      ? workspace.task as Record<string, unknown>
      : {};
    const artifacts = task.artifacts && typeof task.artifacts === "object" && !Array.isArray(task.artifacts)
      ? { ...task.artifacts as Record<string, unknown> }
      : {};
    delete artifacts.pptx;
    delete artifacts.pdf;
    const nextWorkspace: WorkspaceResult = {
      ...workspace,
      task: { ...task, artifacts, updated_at: result.page_progress_updated_at },
      page_progress: nextPageProgress,
    };
    publishDeckResult(nextWorkspace, metadata, { changedPageIds: [result.page_id], syncWorkspace: false });
  }

  function returnToOutlineFromGeneration() {
    setGenerationUnresumable(false);
    if (outline.length === 0) {
      navigateMain("brief");
      return;
    }
    setPage("main");
    setStage("outline");
  }

  /**
   * GEN-003: Back on the last two stages behaves like the header entries. A run
   * that is still going cannot just be walked away from, so the button asks for
   * the Generation Abandonment confirmation and lets that decide where the user
   * lands; with no run in flight it is an ordinary step back.
   */
  async function backFromGeneration() {
    if (isGenerationInFlight()) {
      await cancelGenerateDeck();
      return;
    }
    returnToOutlineFromGeneration();
  }

  async function backFromDeck() {
    if (isGenerationInFlight()) {
      await cancelGenerateDeck();
      return;
    }
    await navigateMain(resolveDeckBackStage({
      hasGenerationProgress: createDeckProgress !== null,
      canReturnToOutline:
        outline.length > 0 && confirmedRequirementsAllowOutline(currentWorkspace?.requirements),
    }));
  }

  function returnToBriefFromUploadedSourceAnalysis() {
    setPage("main");
    setStage("brief");
    pendingUploadedSourceAnalysisActionRef.current = null;
  }

  async function retryUploadedSourceAnalysis() {
    const action = pendingUploadedSourceAnalysisActionRef.current;
    if (action) {
      forceUploadedSourceAnalysisRefreshRef.current = true;
      try {
        await action();
      } finally {
        forceUploadedSourceAnalysisRefreshRef.current = false;
      }
      return;
    }
    if (!currentWorkspace) return;
    forceUploadedSourceAnalysisRefreshRef.current = true;
    try {
      await ensureUploadedSourceAnalysisForOutline(currentWorkspace);
    } finally {
      forceUploadedSourceAnalysisRefreshRef.current = false;
    }
  }

  async function regenerateDeck() {
    if (outline.length > 0) {
      await createDeckFromOutline();
      return;
    }
    await generateDeck();
  }

  async function resumeDeckGeneration() {
    if (!backend || !aiClient || !researchWebClient || !agentClient || !hostUploadClient) return;
    if (generationRetryInFlightRef.current || loading !== "none") return;
    generationRetryInFlightRef.current = true;

    let activeRunWorkspaceDir: string | undefined;
    let shouldReconcileActiveRun = false;
    let generationRun: GenerationRunTransaction | null = null;
    const cancelSignal = beginCancellableGeneration();
    setLoading("deckFromOutline");
    try {
      const workspace = await refreshCurrentWorkspaceSnapshot();
      if (!workspace) return;
      const canPublish = captureReviewResultGuard(workspace.workspace_dir);
      generationRun = await backend.getWorkspaceGenerationRun({ workspace_dir: workspace.workspace_dir });
      const runWorkspace = generationRun
        ? await backend.openWorkspace({ workspace_dir: generationRun.shadow_workspace_dir })
        : workspace;
      const refreshedWorkspace = await reconcileWorkspaceInterruptedPages(runWorkspace);
      activeRunWorkspaceDir = refreshedWorkspace.workspace_dir;
      shouldReconcileActiveRun = true;
      setStage("generating");
      setPage("main");
      const recoveryProgress = await backend.getPageProgress({ workspace_dir: refreshedWorkspace.workspace_dir });
      const recoveryKind = recoveryProgress.recovery?.run_kind;
      const isRefinementResume = recoveryKind === "page-refinement" || recoveryKind === "deck-refinement";
      if (generationRun) beginActiveGenerationRun(isRefinementResume ? recoveryKind : "deck-generation", generationRun);
      const commonInput = {
            generationRunId: generationRun?.run_id,
            backend,
            aiClient,
            researchWebClient,
            agentClient,
            hostUploadClient,
            aiLogger,
            workspace: refreshedWorkspace,
            confirmedOutline: workspaceOutlineForDownstream(refreshedWorkspace),
            locale,
            onProgress: generationProgressHandler(cancelSignal),
            isCancelled: () => cancelCreateDeckRef.current,
            cancelSignal,
          };
      const completion = await measurePerformanceOperation(
        isRefinementResume ? (recoveryKind === "page-refinement" ? "page_refinement.run" : "deck_refinement.run") : "generation.run",
        refreshedWorkspace.workspace_dir,
        () => isRefinementResume
        ? runDeckRefinement({
            ...commonInput,
            instruction: recoveryProgress.recovery?.refinement_request ?? "Resume refinement",
            scope: recoveryKind === "page-refinement" ? "slide" : "deck",
            pageId: recoveryProgress.recovery?.target_page_ids[0],
            resumePageIds: recoveryProgress.recovery?.target_page_ids,
            skipIntentReview: true,
          })
        : runDeckGeneration({ ...commonInput, startMode: "resume", resumeResearch: true }),
      );
      if (!ownsGenerationOperation(cancelSignal)) return;
      const returnPageId = generationRun?.run_kind === "page-refinement"
        ? generationRun.origin_page_id ?? recoveryProgress.recovery?.target_page_ids[0]
        : (recoveryKind === "page-refinement" ? recoveryProgress.recovery?.target_page_ids[0] : undefined);
      const returnOptions = { returnPageId, changedPageIds: isRefinementResume ? recoveryProgress.recovery?.target_page_ids ?? [] : [] };
      if (completion.status === "completed" && generationRun) {
        const committed = await commitShadowGenerationRun(generationRun);
        if (!ownsGenerationOperation(cancelSignal) || !canPublish()) return;
        setGenerationTransaction(null);
        await applyDeckGenerationCompletion(rebaseCompletion(completion, generationRun.shadow_workspace_dir, generationRun.official_workspace_dir), committed.workspace, returnOptions);
      } else {
        if (completion.status === "completed" && !canPublish()) return;
        await applyDeckGenerationCompletion(completion, refreshedWorkspace, returnOptions);
      }
      shouldReconcileActiveRun = false;
    } catch (error) {
      if (!ownsGenerationOperation(cancelSignal)) return;
      showToast(error instanceof Error ? error.message : t.toasts.createDeckFirst);
    } finally {
      generationRetryInFlightRef.current = false;
      if (ownsGenerationOperation(cancelSignal)) {
        setLoading("none");
        await finishActiveGenerationRun({
          workspaceDir: activeRunWorkspaceDir,
          reconcileInterrupted: shouldReconcileActiveRun && !generationRun,
        });
      }
      if (generationRun) void backend.cleanupGenerationRun({ run_id: generationRun.run_id }).catch((error) => console.warn("Failed to clean generation run", error));
    }
  }

  async function retryPageGeneration(pageId: string) {
    if (!backend || !aiClient || !researchWebClient || !agentClient || !hostUploadClient) return;
    if (generationRetryInFlightRef.current || loading !== "none") return;
    generationRetryInFlightRef.current = true;

    let activeRunWorkspaceDir: string | undefined;
    let shouldReconcileActiveRun = false;
    let generationRun: GenerationRunTransaction | null = null;
    const cancelSignal = beginCancellableGeneration();
    setLoading("deckFromOutline");
    try {
      const officialWorkspace = await refreshCurrentWorkspaceSnapshot();
      if (!officialWorkspace) return;
      const canPublish = captureReviewResultGuard(officialWorkspace.workspace_dir);
      generationRun = await backend.getWorkspaceGenerationRun({ workspace_dir: officialWorkspace.workspace_dir });
      const refreshedWorkspace = generationRun
        ? await backend.openWorkspace({ workspace_dir: generationRun.shadow_workspace_dir })
        : officialWorkspace;
      if (generationRun) beginActiveGenerationRun(generationRun.run_kind, generationRun);
      activeRunWorkspaceDir = refreshedWorkspace.workspace_dir;
      shouldReconcileActiveRun = true;
      setStage("generating");
      setPage("main");
      const completion = await measurePerformanceOperation("page.generation", refreshedWorkspace.workspace_dir, () => runPageGenerationRetry({
        generationRunId: generationRun?.run_id,
        backend,
        aiClient,
        researchWebClient,
        agentClient,
        hostUploadClient,
        aiLogger,
        workspace: refreshedWorkspace,
        confirmedOutline: workspaceOutlineForDownstream(refreshedWorkspace),
        locale,
        pageId,
        onProgress: generationProgressHandler(cancelSignal),
        isCancelled: () => cancelCreateDeckRef.current,
        cancelSignal,
        resumeResearch: true,
      }));
      if (!ownsGenerationOperation(cancelSignal)) return;
      const returnPageId = generationRun?.run_kind === "page-refinement"
        ? generationRun.origin_page_id ?? pageId
        : pageId;
      const returnOptions = { returnPageId, changedPageIds: [pageId] };
      if (completion.status === "completed" && generationRun) {
        const committed = await commitShadowGenerationRun(generationRun);
        if (!ownsGenerationOperation(cancelSignal) || !canPublish()) return;
        setGenerationTransaction(null);
        await applyDeckGenerationCompletion(rebaseCompletion(completion, generationRun.shadow_workspace_dir, generationRun.official_workspace_dir), committed.workspace, returnOptions);
      } else {
        if (completion.status === "completed" && !canPublish()) return;
        await applyDeckGenerationCompletion(completion, refreshedWorkspace, returnOptions);
      }
      shouldReconcileActiveRun = false;
    } catch (error) {
      if (!ownsGenerationOperation(cancelSignal)) return;
      showToast(error instanceof Error ? error.message : t.toasts.createDeckFirst);
    } finally {
      generationRetryInFlightRef.current = false;
      if (ownsGenerationOperation(cancelSignal)) {
        setLoading("none");
        await finishActiveGenerationRun({
          workspaceDir: activeRunWorkspaceDir,
          reconcileInterrupted: shouldReconcileActiveRun && !generationRun,
        });
      }
      if (generationRun) void backend.cleanupGenerationRun({ run_id: generationRun.run_id }).catch((error) => console.warn("Failed to clean generation run", error));
    }
  }

  async function exportFile(selection: { type: "PPTX" | "PDF"; pageNumbers?: number[] }) {
    const { type, pageNumbers } = selection;
    if (!backend) return;

    const workspace = await ensureCurrentWorkspace();
    if (!workspace) return;
    exportInFlightRef.current = true;

    setLoading("export");
    setExportProgress(createExportStartProgress(t, type));
    setExportArtifact(null);
    setExportDownload({ status: "idle", message: "" });
    try {
      if (type === "PDF" && (
        reviewRender.status !== "ready" ||
        reviewRender.result === null ||
        reviewRender.renderKey !== workspaceReviewRenderKey(workspace)
      )) {
        const rendered = await loadDeckHtmlForWorkspace(workspace, "export");
        if (!rendered) return;
        setLoading("export");
        setExportProgress(createExportStartProgress(t, type));
      }

      let updatedWorkspace: WorkspaceResult;
      if (type === "PPTX") {
        const completed = await backend.runPptxExport({
          workspace_dir: workspace.workspace_dir,
          ...(pageNumbers === undefined ? {} : { pageNumbers }),
          onProgress: (progress) => {
            setExportProgress((current) => ({
              ...current,
              active: true,
              mode: progress.currentPage && progress.totalPages ? "determinate" : current.mode,
              percent: typeof progress.percent === "number" ? progress.percent : current.percent,
              message: progress.phase === "merging" && progress.totalPages
                ? formatMessage(t.exportPage.pptxMergingPages, { total: progress.totalPages })
                : progress.currentPage && progress.totalPages
                ? formatMessage(t.exportPage.pptxRenderingPage, {
                    current: progress.currentPage,
                    total: progress.totalPages,
                  })
                : progress.message || current.message,
            }));
          },
        });
        setExportProgress(createPptxJobExportProgress(t, completed));

        const pptxPath = completed.pptx_path;
        assertPptxExportPath(pptxPath, "pptx_path");
        updatedWorkspace = await backend.openWorkspace({
          workspace_dir: workspace.workspace_dir,
        });
        applyWorkspace(updatedWorkspace);
      } else {
        setExportProgress(createExportStartProgress(t, "PDF"));
        await backend.runPdfExport({
          workspace_dir: workspace.workspace_dir,
          ...(pageNumbers === undefined ? {} : { pageNumbers }),
          onProgress: (progress) => {
            setExportProgress((current) => ({
              ...current,
              active: true,
              percent: typeof progress.percent === "number" ? progress.percent : current.percent,
              message: progress.message || current.message,
            }));
          },
        });
        updatedWorkspace = await backend.openWorkspace({ workspace_dir: workspace.workspace_dir });
        applyWorkspace(updatedWorkspace);
      }

      const artifact = readWorkspaceExportArtifactPath(updatedWorkspace);
      if (!artifact) {
        throw new Error(`${type} export was recorded without an artifact path.`);
      }
      setExportArtifact(artifact);
      setExportProgress(createExportDownloadPreparingProgress(t, type));
      setExportDownload({ status: "preparing", message: "" });
      try {
        const published = await publishExportArtifact(updatedWorkspace, artifact);
        setExportProgress(createArtifactExportProgress(t, published));
        setExportDownload({ status: "idle", message: t.exportPage.downloadNotPrepared });
        showToast(type === "PPTX" ? t.toasts.pptxExported : t.toasts.pdfExported);
      } catch (error) {
        // The local export artifact is still valid even when its APS mirror
        // could not be published. Keep the export complete and let the user
        // retry the download preparation without regenerating the file.
        setExportProgress(createArtifactExportProgress(t, artifact));
        const message = formatExportDownloadError(error);
        console.warn("Failed to publish the Export Artifact Mirror", error);
        setExportDownload({ status: "error", message });
        showToast(message);
      }
    } catch (error) {
      // EXPORT-001: a raw `JSON-RPC request timed out` is not actionable, so the
      // page shows a summary and keeps the retry entry available.
      const { summary } = summarizeUserFacingError(t, error, t.exportPage.exportFailedSummary);
      setExportProgress((current) =>
        createExportErrorProgress(summary, type, current.percent)
      );
      showToast(summary);
    } finally {
      exportInFlightRef.current = false;
      setLoading("none");
    }
  }

  async function downloadCurrentExportArtifact() {
    if (!backend || !currentWorkspace || !exportArtifact || exportDownload.status === "preparing") {
      return;
    }
    // Only the fallback route leaves a URL behind, and while it is still valid
    // pressing the button again just retries that transfer.
    if (hasActiveDownloadUrl(exportDownload) && exportDownload.href) {
      startBrowserDownload(exportDownload.href, document);
      setExportDownload({ ...exportDownload, message: t.exportPage.downloadStartedWithLink });
      return;
    }
    setExportDownload({ status: "preparing", message: t.exportPage.downloadPreparing });
    try {
      let artifact = exportArtifact;
      if (artifact.mirrorStatus !== "ready" || !artifact.mirrorPath) {
        artifact = await publishExportArtifact(currentWorkspace, artifact);
      }
      // Preferred route: the Host resolves the mirror, authorizes it and saves
      // it from the top-level page, so the signed URL never reaches this App.
      if (artifact.mirrorPath && hostFileDownloadClient) {
        const outcome = await hostFileDownloadClient.download({
          path: artifact.mirrorPath,
          scope: artifact.mirrorScope,
          filename: artifact.fileName,
        });
        if (outcome === "downloaded") {
          setExportDownload({ status: "ready", message: t.exportPage.downloadStarted });
          return;
        }
      }
      const result = await backend.getExportArtifactDownloadUrl({
        workspace_dir: currentWorkspace.workspace_dir,
        artifact_type: artifact.type.toLowerCase() as "pptx" | "pdf",
      });
      if (result.status !== "ready") {
        setExportArtifact((current) => current
          ? { ...current, mirrorStatus: result.status }
          : current);
        throw new Error(result.reason);
      }
      setExportArtifact({
        ...artifact,
        fileName: result.artifact.filename,
        mirrorStatus: "ready",
        mirrorPath: result.mirror.path,
        mirrorScope: result.mirror.scope,
      });
      const started = startBrowserDownload(result.download_url, document);
      setExportDownload({
        status: "ready",
        message: started ? t.exportPage.downloadStartedWithLink : t.exportPage.downloadReady,
        href: result.download_url,
        expiresAt: result.expires_at,
      });
    } catch (error) {
      const message = formatExportDownloadError(error);
      console.warn("Failed to download the Export Artifact Mirror", error);
      setExportDownload({ status: "error", message });
      showToast(message);
    }
  }

  /**
   * The ZIP is rebuilt on every request, so this is both "prepare" and "how the
   * download starts": the Host saves the fresh object, and the signed URL only
   * comes into play when this Host cannot.
   */
  async function downloadCurrentWorkspaceDiagnosticBundle() {
    if (!backend || !currentWorkspace || workspaceDiagnosticBundle.status === "preparing") return;
    // Only the fallback route leaves a URL behind, and while it is still valid
    // pressing the button again just retries that transfer.
    if (hasActiveDownloadUrl(workspaceDiagnosticBundle) && workspaceDiagnosticBundle.href) {
      startBrowserDownload(workspaceDiagnosticBundle.href, document);
      setWorkspaceDiagnosticBundle({
        ...workspaceDiagnosticBundle,
        message: t.library.diagnosticBundleDownloadStartedWithLink,
      });
      return;
    }

    const workspaceId = currentWorkspace.workspace_id;
    const workspaceDir = currentWorkspace.workspace_dir;
    const requestId = workspaceDiagnosticBundleRequestRef.current + 1;
    workspaceDiagnosticBundleRequestRef.current = requestId;
    setWorkspaceDiagnosticBundle({
      status: "preparing",
      message: t.library.diagnosticBundlePreparing,
      workspaceId,
    });

    try {
      const result = await backend.prepareWorkspaceDiagnosticBundle({
        workspace_dir: workspaceDir,
      });
      if (
        workspaceDiagnosticBundleRequestRef.current !== requestId ||
        currentWorkspaceRef.current?.workspace_id !== workspaceId
      ) {
        return;
      }
      const mirrorPath = result.mirror?.path;
      const mirrorScope = result.mirror?.scope;
      // Preferred route: the Host resolves the object, authorizes it and saves
      // it from the top-level page, so the signed URL never reaches this App.
      if (mirrorPath && hostFileDownloadClient) {
        const outcome = await hostFileDownloadClient.download({
          path: mirrorPath,
          scope: mirrorScope,
          filename: result.filename,
        });
        if (
          workspaceDiagnosticBundleRequestRef.current !== requestId ||
          currentWorkspaceRef.current?.workspace_id !== workspaceId
        ) {
          return;
        }
        if (outcome === "downloaded") {
          setWorkspaceDiagnosticBundle({
            status: "ready",
            message: t.library.diagnosticBundleDownloadStarted,
            workspaceId,
            filename: result.filename,
            sizeBytes: result.size_bytes,
            mirrorPath,
            mirrorScope,
          });
          return;
        }
      }
      const started = startBrowserDownload(result.download_url, document);
      setWorkspaceDiagnosticBundle({
        status: "ready",
        message: started
          ? t.library.diagnosticBundleDownloadStartedWithLink
          : t.library.diagnosticBundleReady,
        workspaceId,
        filename: result.filename,
        sizeBytes: result.size_bytes,
        mirrorPath,
        mirrorScope,
        href: result.download_url,
        expiresAt: result.expires_at,
      });
    } catch (error) {
      if (
        workspaceDiagnosticBundleRequestRef.current !== requestId ||
        currentWorkspaceRef.current?.workspace_id !== workspaceId
      ) {
        return;
      }
      const detail = error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
      const message = detail
        ? `${t.library.diagnosticBundleFailedPrefix}${detail}`
        : t.library.diagnosticBundleFailed;
      console.warn("Failed to download the Workspace Diagnostic Bundle", error);
      setWorkspaceDiagnosticBundle({
        status: "error",
        message,
        workspaceId,
      });
    }
  }

  function openStyleProfileCreation() {
    setPage("style-profile-creation");
    setHistory((items) => (items.at(-1) === "style-profile-creation" ? items : [...items, "style-profile-creation"]));
    void refreshStyleProfiles();
  }

  function resetStyleProfileCreation() {
    styleProfileCreationAbortRef.current?.abort();
    styleProfileCreationAbortRef.current = null;
    setStyleProfileCreation(createIdleStyleProfileCreationState());
  }

  function setStyleProfileCreationName(value: string) {
    setStyleProfileCreation((current) => ({ ...current, displayName: value }));
  }

  function setStyleProfileCreationFiles(files: File[]) {
    setStyleProfileCreation((current) => ({
      ...current,
      files,
      error: "",
      message: files.length > 0 ? `已选择 ${files.length} 个参考资料。` : "上传 PPTX 或图片参考资料后开始分析。",
    }));
  }

  async function refreshStyleProfiles() {
    if (!backend) return;
    setStyleProfileLibraryLoading(true);
    setStyleProfileLibraryError("");
    try {
      const result = await backend.listStyleProfiles();
      setStyleProfiles(result.profiles);
    } catch (error) {
      const message = error instanceof Error ? error.message : "风格画像库加载失败。";
      setStyleProfileLibraryError(message);
    } finally {
      setStyleProfileLibraryLoading(false);
    }
  }

  async function loadStyleProfilePreview(styleProfileId: string) {
    if (!backend || styleProfilePreviews[styleProfileId]) return;
    try {
      const preview = await backend.getStyleProfilePreview({ style_profile_id: styleProfileId });
      setStyleProfilePreviews((current) => ({ ...current, [styleProfileId]: preview }));
    } catch (error) {
      console.warn("Failed to load Style Profile preview", error);
    }
  }

  async function openStyleProfileDetail(styleProfileId: string) {
    if (!backend) return;
    setStyleProfileDetail({ status: "loading", styleProfileId, detail: null, error: "" });
    try {
      const detail = await backend.getStyleProfile({ style_profile_id: styleProfileId });
      setStyleProfileDetail({ status: "ready", styleProfileId, detail, error: "" });
    } catch (error) {
      setStyleProfileDetail({
        status: "error",
        styleProfileId,
        detail: null,
        error: error instanceof Error ? error.message : "风格画像详情加载失败。",
      });
    }
  }

  function closeStyleProfileDetail() {
    setStyleProfileDetail({ status: "closed", styleProfileId: "", detail: null, error: "" });
  }

  async function runStyleProfileCreation(options: { retryAnalysis: boolean }) {
    if (!backend || !hostUploadClient || !agentClient) {
      showToast("风格画像创建能力尚未就绪。");
      return;
    }
    const displayName = styleProfileCreation.displayName.trim();
    if (!displayName) {
      showToast("请填写风格画像名称。");
      return;
    }
    if (!options.retryAnalysis && styleProfileCreation.files.length === 0) {
      showToast("请先上传 PPTX 或图片参考资料。");
      return;
    }
    const abortController = new AbortController();
    styleProfileCreationAbortRef.current = abortController;
    setStyleProfileCreation((current) => ({
      ...current,
      status: "running",
      displayName,
      error: "",
      canRetryAnalysis: false,
      createdStyleProfileId: "",
      message: options.retryAnalysis ? "正在重试分析视觉风格。" : "正在准备参考资料。",
      stages: options.retryAnalysis
        ? current.stages.map((stage) => (
            stage.id === "analyze" || stage.id === "publish"
              ? { ...stage, state: "pending", error: "", activities: [], lines: [], summaryLines: [] }
              : stage
          ))
        : createStyleProfileCreationStages(),
    }));
    try {
      const result = await createStyleProfile({
        backend,
        hostUploadClient,
        agentClient,
        displayName,
        files: options.retryAnalysis ? [] : styleProfileCreation.files,
        creationId: options.retryAnalysis ? styleProfileCreation.creationId : undefined,
        skipUpload: options.retryAnalysis,
        signal: abortController.signal,
        isCancelled: () => abortController.signal.aborted,
        onProgress: (event) => {
          setStyleProfileCreation((current) => applyStyleProfileCreationEvent(current, event));
        },
      });
      setStyleProfileCreation((current) => ({
        ...current,
        status: "completed",
        creationId: result.creationContext.creation_id,
        createdStyleProfileId: result.publishResult.style_profile.style_profile_id,
        canRetryAnalysis: false,
        message: "创建成功。",
        stages: current.stages.map((stage) => ({ ...stage, state: stage.state === "pending" ? "completed" : stage.state })),
      }));
      setStyleProfiles(result.publishResult.index.profiles);
      setStyleProfilePreviews((current) => {
        const next = { ...current };
        delete next[result.publishResult.style_profile.style_profile_id];
        return next;
      });
      void loadStyleProfilePreview(result.publishResult.style_profile.style_profile_id);
      showToast("风格画像创建成功。");
    } catch (error) {
      if (isStyleProfileCreationCancelledError(error) || abortController.signal.aborted) {
        setStyleProfileCreation((current) => ({
          ...current,
          status: "stopped",
          message: "已停止。",
          stages: current.stages.map((stage) =>
            stage.state === "active" ? { ...stage, state: "stopped" } : stage
          ),
        }));
        return;
      }
      const message = error instanceof Error ? error.message : "风格画像创建失败。";
      setStyleProfileCreation((current) => ({
        ...current,
        status: "failed",
        error: message,
        message,
        canRetryAnalysis: Boolean(current.creationId),
      }));
      showToast(message);
    } finally {
      if (styleProfileCreationAbortRef.current === abortController) {
        styleProfileCreationAbortRef.current = null;
      }
    }
  }

  async function startStyleProfileCreation() {
    await runStyleProfileCreation({ retryAnalysis: false });
  }

  async function retryStyleProfileAnalysis() {
    await runStyleProfileCreation({ retryAnalysis: true });
  }

  function stopStyleProfileCreation() {
    styleProfileCreationAbortRef.current?.abort();
  }

  async function selectStyleProfile(styleProfileId: string) {
    if (!backend || !currentWorkspace) return;
    if (hasDownstreamArtifacts(currentWorkspace)) {
      const ok = await requestConfirmation({
        title: t.dialogs.changeStyleProfile.title,
        body: t.dialogs.changeStyleProfile.body,
        cancelLabel: t.dialogs.changeStyleProfile.cancel,
        confirmLabel: t.dialogs.changeStyleProfile.confirm,
        tone: "warning",
      });
      if (!ok) return;
    }
    try {
      const result = await backend.selectWorkspaceStyleProfile({
        workspace_dir: currentWorkspace.workspace_dir,
        style_profile_id: styleProfileId,
      });
      setSelectedStyleProfile(result.selection);
      applyWorkspace(result.workspace);
      showToast(t.toasts.styleProfileSelected);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t.toasts.styleProfileSelectFailed);
    }
  }

  async function clearStyleProfile() {
    if (!backend || !currentWorkspace || !selectedStyleProfile) return;
    if (hasDownstreamArtifacts(currentWorkspace)) {
      const ok = await requestConfirmation({
        title: t.dialogs.clearStyleProfile.title,
        body: t.dialogs.clearStyleProfile.body,
        cancelLabel: t.dialogs.clearStyleProfile.cancel,
        confirmLabel: t.dialogs.clearStyleProfile.confirm,
        tone: "warning",
      });
      if (!ok) return;
    }
    try {
      const result = await backend.clearWorkspaceStyleProfile({
        workspace_dir: currentWorkspace.workspace_dir,
      });
      setSelectedStyleProfile(null);
      applyWorkspace(result.workspace);
      showToast("已清除风格画像，当前成稿需要重新生成。");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "风格画像清除失败。");
    }
  }

  async function refreshPerformanceRuns() {
    if (!backend || !PERFORMANCE_TESTING_ENABLED) return;
    setPerformanceTesting((current) => ({ ...current, loading: true, error: "" }));
    try {
      const result = await backend.listPerformanceRuns();
      setPerformanceTesting((current) => ({
        ...current,
        supported: true,
        loading: false,
        activeRun: result.active_run,
        runs: result.runs,
      }));
    } catch (error) {
      setPerformanceTesting((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : t.performance.unavailable }));
    }
  }

  async function refreshAgentResourceInfo() {
    if (!backend || !AGENT_RESOURCE_INFO_ENABLED || agentResourceInfo.loading) return;
    setAgentResourceInfo((current) => ({ ...current, loading: true, error: "" }));
    try {
      const result = await backend.getAgentResourceInfo();
      setAgentResourceInfo({ enabled: true, loading: false, error: "", info: result });
    } catch (error) {
      setAgentResourceInfo((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : t.library.agentResourceInfoUnavailable,
      }));
    }
  }

  async function startPerformanceRun() {
    if (!backend || performanceTesting.busy || performanceTesting.activeRun || batchTesting.busy) return;
    setPerformanceTesting((current) => ({ ...current, busy: true, error: "" }));
    try {
      const run = await backend.startPerformanceRun({
        app_version: appManifest.version,
        environment: {
          locale,
          viewport_width: window.innerWidth,
          viewport_height: window.innerHeight,
          device_pixel_ratio: window.devicePixelRatio,
          online: navigator.onLine,
        },
        initial_settings: globalSettings,
      });
      setPerformanceTesting((current) => ({ ...current, busy: false, activeRun: run, runs: [run, ...current.runs.filter((item) => item.run_id !== run.run_id)] }));
      showToast(t.performance.started);
    } catch (error) {
      setPerformanceTesting((current) => ({ ...current, busy: false, error: error instanceof Error ? error.message : t.performance.startFailed }));
    }
  }

  async function finalizePerformanceRun() {
    if (!backend || performanceTesting.busy || !performanceTesting.activeRun || batchTesting.busy) return;
    const runId = performanceTesting.activeRun.run_id;
    setPerformanceTesting((current) => ({ ...current, busy: true, error: "" }));
    try {
      let result = await backend.finalizePerformanceRun({ run_id: runId, locale: toPerfReportLocale(locale) });
      if (result.requires_force) {
        setPerformanceTesting((current) => ({ ...current, busy: false }));
        const force = await requestConfirmation({
          title: t.performance.activeOperationsTitle,
          body: formatMessage(t.performance.activeOperationsBody, { count: result.active_span_count }),
          cancelLabel: t.performance.keepRecording,
          confirmLabel: t.performance.forceFinish,
          tone: "warning",
        });
        if (!force) return;
        setPerformanceTesting((current) => ({ ...current, busy: true }));
        result = await backend.finalizePerformanceRun({ run_id: runId, locale: toPerfReportLocale(locale), force: true });
      }
      setPerformanceTesting((current) => ({
        ...current,
        busy: false,
        activeRun: null,
        runs: [result.run, ...current.runs.filter((item) => item.run_id !== result.run.run_id)],
      }));
      showToast(t.performance.reportGenerated);
    } catch (error) {
      const message = error instanceof Error ? error.message : t.performance.finalizeFailed;
      try {
        const latest = await backend.listPerformanceRuns();
        setPerformanceTesting((current) => ({ ...current, busy: false, error: message, activeRun: latest.active_run, runs: latest.runs }));
      } catch {
        setPerformanceTesting((current) => ({ ...current, busy: false, error: message }));
      }
    }
  }

  async function abandonPerformanceRun() {
    if (!backend || performanceTesting.busy || !performanceTesting.activeRun || batchTesting.busy) return;
    const confirmed = await requestConfirmation({
      title: t.performance.abandonTitle,
      body: t.performance.abandonBody,
      cancelLabel: t.controls.cancel,
      confirmLabel: t.performance.abandonConfirm,
      tone: "danger",
    });
    if (!confirmed) return;
    setPerformanceTesting((current) => ({ ...current, busy: true, error: "" }));
    try {
      const run = await backend.abandonPerformanceRun({ run_id: performanceTesting.activeRun.run_id });
      setPerformanceTesting((current) => ({ ...current, busy: false, activeRun: null, runs: [run, ...current.runs.filter((item) => item.run_id !== run.run_id)] }));
    } catch (error) {
      setPerformanceTesting((current) => ({ ...current, busy: false, error: error instanceof Error ? error.message : t.performance.abandonFailed }));
    }
  }

  async function deletePerformanceRun(run: PerformanceRunListItem) {
    if (!backend || performanceTesting.busy) return;
    const confirmed = await requestConfirmation({
      title: t.performance.deleteTitle,
      body: formatMessage(t.performance.deleteBody, { runId: run.run_id }),
      cancelLabel: t.controls.cancel,
      confirmLabel: t.performance.deleteConfirm,
      tone: "danger",
    });
    if (!confirmed) return;
    setPerformanceTesting((current) => ({ ...current, busy: true, error: "" }));
    try {
      await backend.deletePerformanceRun({ run_id: run.run_id });
      setPerformanceTesting((current) => ({ ...current, busy: false, runs: current.runs.filter((item) => item.run_id !== run.run_id) }));
    } catch (error) {
      setPerformanceTesting((current) => ({ ...current, busy: false, error: error instanceof Error ? error.message : t.performance.deleteFailed }));
    }
  }

  async function openPerformanceReport(run: PerformanceRunListItem) {
    if (!backend || performanceTesting.busy || !run.report_available) return;
    setPerformanceTesting((current) => ({ ...current, busy: true, error: "" }));
    try {
      const result = await backend.preparePerformanceReport({ run_id: run.run_id });
      const html = result.report_html;
      setPerformanceTesting((current) => ({ ...current, busy: false, reportHtml: html, reportRunId: run.run_id }));
      setPage("performance-report");
      setHistory((items) => [...items, "performance-report"]);
    } catch (error) {
      setPerformanceTesting((current) => ({ ...current, busy: false, error: error instanceof Error ? error.message : t.performance.reportFailed }));
    }
  }

  async function regeneratePerformanceReport(run: PerformanceRunListItem) {
    if (!backend || performanceTesting.busy || run.status !== "completed") return;
    setPerformanceTesting((current) => ({ ...current, busy: true, error: "" }));
    try {
      const regenerated = await backend.regeneratePerformanceReport({ run_id: run.run_id, locale: toPerfReportLocale(locale) });
      setPerformanceTesting((current) => ({
        ...current,
        busy: false,
        runs: current.runs.map((item) => item.run_id === regenerated.run_id ? regenerated : item),
      }));
      showToast(t.performance.reportRegenerated);
    } catch (error) {
      const message = error instanceof Error ? error.message : t.performance.regenerateFailed;
      try {
        const latest = await backend.listPerformanceRuns();
        setPerformanceTesting((current) => ({ ...current, busy: false, error: message, activeRun: latest.active_run, runs: latest.runs }));
      } catch {
        setPerformanceTesting((current) => ({ ...current, busy: false, error: message }));
      }
    }
  }

  function createWebResearchLabRunId() {
    const now = new Date();
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    return [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      "-",
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds()),
      "-",
      pad(now.getMilliseconds(), 3),
    ].join("");
  }

  async function openWebResearchLab() {
    if (!WEB_RESEARCH_LAB_ENABLED || isGenerationInFlight()) return;
    await navigate("web-research-lab");
  }

  async function exitWebResearchLab() {
    if (webResearchLab.status === "running") return;
    await navigate("main");
  }

  async function runWebResearchLabTest(input: {
    systemPrompt: string;
    userPrompt: string;
    modelPreference: string;
  }) {
    if (!WEB_RESEARCH_LAB_ENABLED || webResearchLab.status === "running") return;
    if (!backend || !agentClient || !webResearchLabWebClient) {
      setWebResearchLab((current) => ({ ...current, status: "failed", error: t.webResearchLab.dependenciesUnavailable }));
      return;
    }
    const systemPrompt = input.systemPrompt.trim();
    const userPrompt = input.userPrompt.trim();
    if (!userPrompt) {
      setWebResearchLab((current) => ({ ...current, status: "failed", error: t.webResearchLab.userPromptRequired }));
      return;
    }
    const runId = createWebResearchLabRunId();
    const controller = new AbortController();
    webResearchLabAbortRef.current = controller;
    setWebResearchLab({
      enabled: true,
      status: "running",
      systemPrompt,
      userPrompt,
      modelPreference: input.modelPreference,
      events: [],
      rounds: [],
      resultMarkdown: "",
      runId,
      runDir: "",
      error: "",
    });
    try {
      const result = await executeWebResearchLab({
        agentClient,
        researchWebClient: webResearchLabWebClient,
        run_id: runId,
        systemPrompt,
        userPrompt,
        modelPreference: input.modelPreference,
        locale,
        persistFile: (fileName, content, append) => backend.writeResearchTestFile({
          run_id: runId,
          file_name: fileName,
          content,
          ...(append ? { append: true } : {}),
        }),
        signal: controller.signal,
        onEvent: (event: WebResearchLabEvent) => {
          setWebResearchLab((current) => ({
            ...current,
            events: [...current.events, event],
            runDir: event.type === "started" && typeof event.data === "string"
              ? event.data
              : current.runDir,
          }));
        },
      });
      setWebResearchLab((current) => ({
        ...current,
        status: "completed",
        rounds: result.rounds,
        resultMarkdown: result.markdown,
        runDir: result.run_dir,
        error: "",
      }));
    } catch (error) {
      if (!controller.signal.aborted) {
        setWebResearchLab((current) => ({
          ...current,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }));
      } else {
        setWebResearchLab((current) => ({ ...current, status: "idle", error: "" }));
      }
    } finally {
      if (webResearchLabAbortRef.current === controller) webResearchLabAbortRef.current = null;
    }
  }

  async function stopWebResearchLab() {
    if (webResearchLab.status !== "running") return;
    webResearchLabAbortRef.current?.abort();
    await agentClient?.cancelActiveRuns().catch(() => undefined);
  }

  function upsertBatchTestRun(current: DeckWorkspaceState["batchTesting"], run: import("../../../api/types").BatchTestRunRecord) {
    const history = current.history.some((item) => item.test_id === run.test_id)
      ? current.history.map((item) => item.test_id === run.test_id ? run : item)
      : [run, ...current.history];
    history.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    return { ...current, run, selectedRun: run, cases: run.cases, history };
  }

  async function refreshBatchTestHistory() {
    if (!backend || !BATCH_TESTING_ENABLED) return;
    setBatchTesting((current) => ({ ...current, historyLoading: true, historyError: "" }));
    try {
      const result = await backend.listBatchTestRuns();
      setBatchTesting((current) => ({ ...current, historyLoading: false, history: result.runs, historyError: "" }));
    } catch (error) {
      setBatchTesting((current) => ({
        ...current,
        historyLoading: false,
        historyError: error instanceof Error ? error.message : t.batchTesting.historyFailed,
      }));
    }
  }

  async function openBatchTesting() {
    if (!BATCH_TESTING_ENABLED || batchTesting.busy || page === "batch-testing") return;
    const confirmed = await requestConfirmation({
      title: t.batchTesting.enterTitle,
      body: t.batchTesting.enterBody,
      cancelLabel: t.batchTesting.enterCancel,
      confirmLabel: t.batchTesting.enterConfirm,
      tone: "warning",
    });
    if (!confirmed) return;
    setPage("batch-testing");
    setHistory((items) => items.at(-1) === "batch-testing" ? items : [...items, "batch-testing"]);
    setBatchTesting((current) => ({ ...current, view: "history", selectedRun: null, historyError: "" }));
    await refreshBatchTestHistory();
  }

  async function exitBatchTesting() {
    if (batchTesting.busy) return;
    const confirmed = await requestConfirmation({
      title: t.batchTesting.exitTitle,
      body: t.batchTesting.exitBody,
      cancelLabel: t.batchTesting.exitCancel,
      confirmLabel: t.batchTesting.exitConfirm,
      tone: "default",
    });
    if (!confirmed) return;
    setPage("main");
    setStage("brief");
    setHistory(["main"]);
    setBatchTesting((current) => ({ ...current, view: "history", selectedRun: null }));
  }

  function showNewBatchTest() {
    if (batchTesting.busy) return;
    batchTestAutoLoadedCaseIdsRef.current.clear();
    setBatchTesting({
      ...createIdleBatchTestingState(true),
      view: "new",
      history: batchTesting.history,
    });
  }

  function showBatchTestHistory() {
    if (batchTesting.busy) return;
    setBatchTesting((current) => ({ ...current, view: "history", selectedRun: null }));
  }

  function openBatchTestRun(run: import("../../../api/types").BatchTestRunRecord) {
    if (batchTesting.busy) return;
    setBatchTesting((current) => ({
      ...current,
      view: "detail",
      run,
      selectedRun: run,
      cases: run.cases,
      caseDetails: {},
      error: "",
    }));
  }

  async function deleteBatchTestRun(run: import("../../../api/types").BatchTestRunRecord) {
    if (!backend || batchTesting.busy || run.status === "queued" || run.status === "running") return;
    const confirmed = await requestConfirmation({
      title: t.batchTesting.deleteTitle,
      body: formatMessage(t.batchTesting.deleteBody, { testId: run.test_id }),
      cancelLabel: t.controls.cancel,
      confirmLabel: t.batchTesting.deleteConfirm,
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await backend.deleteBatchTestRun({ root_dir: run.root_dir });
      setBatchTesting((current) => ({
        ...current,
        history: current.history.filter((item) => item.test_id !== run.test_id),
        view: current.selectedRun?.test_id === run.test_id ? "history" : current.view,
        selectedRun: current.selectedRun?.test_id === run.test_id ? null : current.selectedRun,
        run: current.run?.test_id === run.test_id ? null : current.run,
      }));
    } catch (error) {
      setBatchTesting((current) => ({ ...current, error: error instanceof Error ? error.message : t.batchTesting.deleteFailed }));
    }
  }

  async function loadBatchTestCaseDetailForItem(item: BatchTestCaseRecord) {
    if (!backend) return;
    const requestKey = `${item.workspace_dir}:${item.case_id}`;
    const activeRequest = batchTestCaseDetailRequestsRef.current.get(requestKey);
    if (activeRequest) return activeRequest;
    const existing = batchTestingRef.current.caseDetails[item.case_id];
    if (existing?.loading || (existing?.requirements && existing.outline && existing.progress)) return;

    const request = (async () => {
      setBatchTesting((current) => ({
        ...current,
        caseDetails: {
          ...current.caseDetails,
          [item.case_id]: { ...(current.caseDetails[item.case_id] ?? createIdleBatchTestCaseDetail()), loading: true, error: "" },
        },
      }));
      try {
        const [workspace, requirements, outline, progress] = await Promise.all([
          backend.openWorkspace({ workspace_dir: item.workspace_dir }),
          backend.getWorkspaceRequirements({ workspace_dir: item.workspace_dir }),
          backend.getWorkspaceOutline({ workspace_dir: item.workspace_dir }),
          backend.getPageProgress({ workspace_dir: item.workspace_dir }),
        ]);
        setBatchTesting((current) => ({
          ...current,
          caseDetails: {
            ...current.caseDetails,
            [item.case_id]: {
              ...(current.caseDetails[item.case_id] ?? createIdleBatchTestCaseDetail()),
              loading: false,
              error: "",
              requirements,
              outline,
              progress,
              template: workspace.template,
            },
          },
        }));
      } catch (error) {
        setBatchTesting((current) => ({
          ...current,
          caseDetails: {
            ...current.caseDetails,
            [item.case_id]: {
              ...(current.caseDetails[item.case_id] ?? createIdleBatchTestCaseDetail()),
              loading: false,
              error: error instanceof Error ? error.message : t.batchTesting.detailFailed,
            },
          },
        }));
      }
    })();
    batchTestCaseDetailRequestsRef.current.set(requestKey, request);
    try {
      await request;
    } finally {
      batchTestCaseDetailRequestsRef.current.delete(requestKey);
    }
  }

  async function loadBatchTestCaseDetail(caseId: string) {
    const current = batchTestingRef.current;
    const run = current.selectedRun ?? current.run;
    const item = run?.cases.find((entry) => entry.case_id === caseId);
    if (!item || item.status === "pending" || item.status === "running") return;
    await loadBatchTestCaseDetailForItem(item);
  }

  async function startBatchTest(input: BatchTestInput) {
    if (!BATCH_TESTING_ENABLED || batchTesting.busy) return;
    if (!backend || !aiClient || !researchAiClient || !pageRefinementClassifier || !researchWebClient || !agentClient || !hostUploadClient) {
      setBatchTesting((current) => ({ ...current, status: "failed", error: t.batchTesting.startFailed }));
      return;
    }
    if (isGenerationInFlight()) {
      setBatchTesting((current) => ({ ...current, status: "failed", error: t.batchTesting.startFailed }));
      return;
    }
    const controller = new AbortController();
    batchTestAbortRef.current?.abort();
    batchTestAbortRef.current = controller;
    batchTestAutoLoadedCaseIdsRef.current.clear();
    let resumeRun: import("../../../api/types").BatchTestRunRecord | undefined;
    try {
      const persisted = await backend.listBatchTestRuns();
      resumeRun = input.test_id
        ? persisted.runs.find((run) => run.test_id === input.test_id && run.status !== "completed")
        : undefined;
    } catch (error) {
      setBatchTesting((current) => ({ ...current, status: "failed", error: error instanceof Error ? error.message : t.batchTesting.startFailed }));
      return;
    }
    setBatchTesting({
      ...createIdleBatchTestingState(true),
      status: "running",
      busy: true,
      view: "new",
      history: batchTesting.history,
    });
    try {
      const preparedInput = input.briefs.some((brief) => brief.attachments?.length)
        ? await prepareAttachmentBatchUploads(input)
        : input;
      const run = await runBatchTestWorkflow(preparedInput, {
        backend,
        aiClient,
        researchAiClient,
        pageRefinementClassifier,
        researchWebClient,
        agentClient,
        attachmentBriefCompletionClient: attachmentBriefCompletionClient ?? undefined,
        imageBriefClient: imageBriefClient ?? undefined,
        hostUploadClient,
        aiLogger,
        locale,
        appVersion: appManifest.version,
        signal: controller.signal,
        onRun: (run) => {
          setBatchTesting((current) => ({
            ...upsertBatchTestRun(current, run),
            view: "detail",
            status: run.status === "queued" ? "running" : run.status,
            busy: run.status === "queued" || run.status === "running",
            error: "",
            bundle: null,
            bundleError: "",
          }));
          for (const item of run.cases) {
            if (run.target_stage === "attachment-context-created") continue;
            const key = `${run.test_id}:${item.case_id}`;
            if (item.status !== "completed" || batchTestAutoLoadedCaseIdsRef.current.has(key)) continue;
            batchTestAutoLoadedCaseIdsRef.current.add(key);
            void loadBatchTestCaseDetailForItem(item);
          }
        },
        onProgress: (caseId, step) => {
          setBatchTesting((current) => ({ ...current, currentCaseId: caseId, currentStep: step }));
        },
      }, { resumeRun });
      setBatchTesting((current) => ({
        ...upsertBatchTestRun(current, run),
        view: "detail",
        status: run.status === "queued" || run.status === "running" ? "completed" : run.status,
        busy: false,
        currentCaseId: null,
        currentStep: "",
      }));
    } catch (error) {
      setBatchTesting((current) => ({
        ...current,
        status: controller.signal.aborted ? "cancelled" : "failed",
        busy: false,
        currentCaseId: null,
        currentStep: "",
        error: controller.signal.aborted ? "" : error instanceof Error ? error.message : t.batchTesting.startFailed,
      }));
    } finally {
      if (batchTestAbortRef.current === controller) batchTestAbortRef.current = null;
      if (PERFORMANCE_TESTING_ENABLED) {
        try {
          const latest = await backend.listPerformanceRuns();
          setPerformanceTesting((current) => ({
            ...current,
            loading: false,
            activeRun: latest.active_run,
            runs: latest.runs,
          }));
        } catch {
          // The batch result remains authoritative even if the optional history refresh fails.
        }
      }
    }
  }

  async function prepareAttachmentBatchUploads(input: BatchTestInput): Promise<BatchTestInput> {
    const uploadedByFile = new Map<File, import("../../../api/types").HostUploadRef>();
    const briefs: BatchTestInput["briefs"] = [];
    for (const brief of input.briefs) {
      if (!brief.attachments?.length) {
        briefs.push(brief);
        continue;
      }
      const attachments = [];
      for (const attachment of brief.attachments) {
        if (attachment.host_upload && !attachment.file) {
          attachments.push(attachment);
          continue;
        }
        if (!attachment.file) throw new Error(formatMessage(t.batchTesting.attachmentFixtureMissing, { name: attachment.filename }));
        let hostUpload = uploadedByFile.get(attachment.file);
        if (!hostUpload) {
          if (!hostUploadClient) throw new Error(t.batchTesting.startFailed);
          hostUpload = await hostUploadClient.uploadFile(attachment.file, {
            purpose: "user_artifact",
            filename: attachment.file.name,
            mimeType: attachment.file.type || undefined,
            metadata: { source: "ppt-app.batch-attachment-fixture", target_stage: input.target_stage },
          });
          uploadedByFile.set(attachment.file, hostUpload);
        }
        attachments.push({
          ...attachment,
          filename: attachment.file.name,
          mime_type: hostUpload.mime_type,
          size_bytes: attachment.file.size,
          host_upload: hostUpload,
        });
      }
      briefs.push({ ...brief, attachments });
    }
    return { ...input, briefs };
  }

  async function stopBatchTest() {
    if (!batchTesting.busy) return;
    batchTestAbortRef.current?.abort();
    setBatchTesting((current) => ({ ...current, currentStep: "" }));
    await agentClient?.cancelActiveRuns().catch(() => undefined);
  }

  async function downloadBatchTestBundle(targetRun?: import("../../../api/types").BatchTestRunRecord) {
    const run = targetRun ?? batchTesting.selectedRun ?? batchTesting.run;
    if (!backend || !run || batchTesting.bundleBusy) return;
    setBatchTesting((current) => ({ ...current, bundleBusy: true, bundleError: "" }));
    try {
      const result = await backend.prepareBatchTestBundle({ root_dir: run.root_dir });
      const mirrorPath = result.mirror?.path;
      const mirrorScope = result.mirror?.scope;
      let downloaded = false;
      if (mirrorPath && hostFileDownloadClient) {
        downloaded = (await hostFileDownloadClient.download({
          path: mirrorPath,
          scope: mirrorScope,
          filename: result.filename,
        })) === "downloaded";
      }
      if (!downloaded) startBrowserDownload(result.download_url, document);
      setBatchTesting((current) => ({ ...current, bundleBusy: false, bundle: result }));
    } catch (error) {
      setBatchTesting((current) => ({
        ...current,
        bundleBusy: false,
        bundleError: error instanceof Error ? error.message : t.batchTesting.bundleFailed,
      }));
    }
  }

  const state: DeckWorkspaceState = {
    userTemplates,
    panelMode,
    page,
    stage,
    toast,
    prompt,
    globalSettings,
    contextRows,
    selectedAspectRatio,
    presentationRequirements,
    requirementsProgress: requirementsProcess.steps,
    outlineCreationProgress: outlineProcess.steps,
    requirementsStatus,
    requirementsError,
    requirementsErrorDetail,
    requirementsSaving,
    requirementsConfirming,
    requirementsDirty,
    requirementsHasSavedDraft,
    webResearchStatus,
    webResearchProgress,
    webResearchError,
    webResearchErrorDetail,
    deckTitle,
    deck,
    outline,
    outlineDraft,
    outlineDraftTitle,
    outlineDraftRequirements,
    outlineFeedback,
    outlineDirty,
    outlineSaving,
    outlineError,
    outlineErrorDetail,
    generated,
    currentSlide,
    previewMode,
    reviewRender,
    createDeckProgress,
    uploadedSourceAnalysisProgress,
    generationHistory,
    pageProgress,
    refineScope,
    loading,
    activeGenerationRun,
    generationViewState,
    generationPagePreviews,
    generationPreviewWorkspaceDir,
    pinnedGenerationPreviewPageId,
    exportProgress,
    exportArtifact,
    exportDownload,
    workspaceDiagnosticBundleEnabled: WORKSPACE_DIAGNOSTIC_BUNDLE_ENABLED,
    workspaceDiagnosticBundle: templateDiagnosticMode ? templateDiagnosticBundle.state : workspaceDiagnosticBundle,
    templateDiagnosticMode,
    performanceTesting,
    batchTesting,
    webResearchLab,
    currentStatus,
    workspaceScan,
    openingWorkspaceDir,
    highlightedWorkspaceId,
    currentWorkspace,
    uploadedSources,
    uploadedSourcePreflights,
    uploadedSourcePreflightRunning,
    uploadedSourceAnalysisState,
    workspaceLoading,
    workspaceError: invokeTimeoutSummary(t, workspaceErrorDetail || workspaceError, workspaceError),
    workspaceErrorDetail: workspaceErrorDetail || (isInvokeTimeout(workspaceError) ? workspaceError : ""),
    workspaceSettingsSaving,
    runtimeInfo,
    runtimeInfoError,
    agentResourceInfo,
    templateGroups,
    selectedVisualStylePresetId,
    selectedTemplateGroupId,
    styleProfiles,
    styleProfilePreviews,
    selectedStyleProfile,
    styleProfileLibraryLoading,
    styleProfileLibraryError,
    styleProfileCreation,
    styleProfileDetail,
    confirmationDialog,
    workspaceSyncStates,
    cloudWorkspaces,
    workspaceSnapshotInfo,
    workspaceSnapshotSyncState,
    cloudConflictDialog,
  };

  const outlineWorkspaceDir = currentWorkspace?.workspace_dir;
  const imageLibrary = useMemo(() => {
    if (!backend || !researchWebClient || !outlineWorkspaceDir) return null;
    return createOutlineImageLibraryService({ backend, web: researchWebClient, workspaceDir: outlineWorkspaceDir, locale });
  }, [backend, researchWebClient, outlineWorkspaceDir, locale]);
  const loadOutlineImages = useCallback(async () => imageLibrary ? imageLibrary.load() : [], [imageLibrary]);
  const loadOutlineImagePreview = useCallback(async (assetId: string, size?: "thumbnail" | "large") => {
    if (!imageLibrary) throw new Error("Workspace unavailable");
    return imageLibrary.preview(assetId, size);
  }, [imageLibrary]);

  const pageImageUpload = useMemo(() => {
    if (!backend || !hostUploadClient || !outlineWorkspaceDir) return null;
    return createPageImageUploadService({ backend, upload: hostUploadClient, workspaceDir: outlineWorkspaceDir });
  }, [backend, hostUploadClient, outlineWorkspaceDir]);
  const pageImageSearch = useMemo(() => {
    if (!backend || !agentClient || !aiClient || !researchWebClient || !currentWorkspace) return null;
    return createPageImageSearchService({ backend, agentClient, aiClient, researchWebClient, hostUploadClient, aiLogger,
      workspace: currentWorkspace, confirmedOutline: workspaceOutlineForDownstream(currentWorkspace), locale,
      onProgress: () => undefined, isCancelled: () => false, activeStreams: new Map(), getProgress: () => null, setProgress: () => undefined });
  }, [backend, agentClient, aiClient, researchWebClient, hostUploadClient, aiLogger, currentWorkspace, locale]);
  const actions: DeckWorkspaceActions = {
    pageImageUpload,
    imageLibrary,
    pageImageSearch,
    loadOutlineImages,
    loadOutlineImagePreview,
    setPanelMode,
    setPrompt,
    setDeckTitle,
    setCurrentSlide,
    setPreviewMode,
    setRefineScope,
    showToast,
    resolveConfirmation,
    refreshPerformanceRuns,
    refreshAgentResourceInfo,
    startPerformanceRun,
    finalizePerformanceRun,
    abandonPerformanceRun,
    deletePerformanceRun,
    openPerformanceReport,
    regeneratePerformanceReport,
    openBatchTesting,
    exitBatchTesting,
    openWebResearchLab,
    exitWebResearchLab,
    runWebResearchLab: runWebResearchLabTest,
    stopWebResearchLab,
    showBatchTestHistory,
    showNewBatchTest,
    refreshBatchTestHistory,
    openBatchTestRun,
    deleteBatchTestRun,
    loadBatchTestCaseDetail,
    startBatchTest,
    stopBatchTest,
    downloadBatchTestBundle,
    cancelGenerateDeck,
    navigate,
    navigateFromHeader,
    goHomeFromHeader,
    navigateMain,
    goBack,
    addContextRow,
    updateContextRow,
    removeContextRow,
    addStyleRow,
    generateDeck: () => generateDeck(),
    setSelectedAspectRatio,
    generatePresentationRequirements,
    retryPresentationRequirements,
    selectVisualStylePreset,
    useManualPresentationRequirements,
    selectPresentationRequirement,
    selectPresentationResearch,
    returnToBriefFromRequirements,
    savePresentationRequirements,
    confirmPresentationRequirements,
    retryWebResearch,
    returnToRequirementsFromWebResearch,
    createDeckFromOutline,
    applyOutlineFeedback,
    retryOutlineCreation,
    returnToRequirementsFromOutline,
    saveOutlineDraft,
    setOutlineDraftTitle,
    setOutlineDraftRequirements,
    setOutlineFeedback,
    updateOutlineDraftItem,
    replaceOutlineDraftItems,
    openLocalProject,
    openWorkspace,
    scanWorkspaces,
    showWorkspacePicker,
    startNewPresentation,
    refreshMyWork,
    useLatestWorkspace,
    createWorkspace,
    uploadUploadedSource,
    removeUploadedSource,
    openStyleProfileCreation,
    setStyleProfileCreationName,
    setStyleProfileCreationFiles,
    startStyleProfileCreation,
    retryStyleProfileAnalysis,
    stopStyleProfileCreation,
    resetStyleProfileCreation,
    refreshStyleProfiles,
    loadStyleProfilePreview,
    openStyleProfileDetail,
    closeStyleProfileDetail,
    selectStyleProfile,
    clearStyleProfile,
    saveWorkspaceSettings,
    saveWorkspaceTitle,
    renameWorkspace,
    deleteWorkspace,
    duplicateWorkspace,
    dismissCloudConflictDialog,
    refreshWorkspaceSnapshotInfo,
    selectTemplate,
    openRefineDeck,
    openRefineSlide,
    refineDeck,
    refineSlide,
    rewriteCurrentSlide,
    changeCurrentSlideLayout,
    renderDeckHtml,
    refreshReviewPageImage,
    applyManualPageUpdate,
    exitManualEditor,
    exportFile,
    downloadExportArtifact: downloadCurrentExportArtifact,
    downloadWorkspaceDiagnosticBundle: templateDiagnosticMode ? templateDiagnosticBundle.download : downloadCurrentWorkspaceDiagnosticBundle,
    resetWorkspaceDiagnosticBundle: templateDiagnosticMode ? templateDiagnosticBundle.reset : invalidateWorkspaceDiagnosticBundle,
    selectGenerationPreviewPage: setPinnedGenerationPreviewPageId,
    returnToOutlineFromGeneration,
    backFromGeneration,
    backFromDeck,
    returnToBriefFromUploadedSourceAnalysis,
    regenerateDeck,
    resumeDeckGeneration,
    retryPageGeneration,
    retryUploadedSourceAnalysis
  };

  const pageRegeneration = usePageRegeneration({
    pageImageUpload,
    imageLibrary,
    pageImageSearch,
    backend, agent: agentClient, ai: aiClient, logger: aiLogger,
    workspace: currentWorkspace, t, locale,
    onAdopted: applyAdoptedPage,
  });
  return { state, actions, pageRegeneration };
}
