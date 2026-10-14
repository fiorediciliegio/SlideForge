import type {
  BatchTestCaseRecord,
  BatchTestRunRecord,
  BatchTestTargetStage,
  GetWorkspacePageImageResult,
  PageProgress,
  PrepareBatchTestBundleResult,
  PresentationRequirements,
  WorkspaceOutline,
} from "../../api/types";

export const BATCH_TEST_TARGET_STAGES = [
  "template-recommendation-completed",
  "attachment-context-created",
  "requirements-confirmed",
  "research-routing-completed",
  "page-refinement-classification-completed",
  "web-research-completed",
  "outline-confirmed",
  "image-research-completed",
  "pptx-exported",
] as const satisfies readonly BatchTestTargetStage[];

export const DEFAULT_BATCH_TEST_TARGET_STAGE: BatchTestTargetStage = "pptx-exported";

const BATCH_TEST_TARGET_STAGE_RANK = new Map<BatchTestTargetStage, number>(
  BATCH_TEST_TARGET_STAGES.map((stage, index) => [stage, index]),
);

export function batchTestTargetIncludes(
  target: BatchTestTargetStage,
  stage: BatchTestTargetStage,
): boolean {
  return (BATCH_TEST_TARGET_STAGE_RANK.get(target) ?? -1) >=
    (BATCH_TEST_TARGET_STAGE_RANK.get(stage) ?? Number.POSITIVE_INFINITY);
}

export interface BatchBriefInput {
  id?: string;
  brief: string;
  repeat?: number;
  /** A confirmed Requirements fixture for an outline-only evaluation. */
  provided_requirements?: PresentationRequirements;
  /** Parsed from a fixture JSON; a local File is paired before the run begins. */
  attachments?: BatchBriefAttachmentInput[];
}

export interface BatchBriefAttachmentInput {
  filename: string;
  expected_strategy?: "full_context" | "summarized_context";
  expected_notes?: string;
  file?: File;
  mime_type?: string;
  size_bytes?: number;
  host_upload?: import("../../api/types").HostUploadRef;
}

export interface BatchResearchRoutingInput {
  git_commit: string;
  /** Human-supplied label for the model selected in the Local Agent UI. */
  requested_model?: string | null;
  prompts: Array<{
    prompt_version: string;
    prompt: string;
    prompt_hash: string;
  }>;
  expected_by_brief_id: Record<string, { web: boolean; images: boolean }>;
}

export interface BatchPageRefinementClassificationInput {
  git_commit: string;
  requested_model?: string | null;
  prompts: Array<{
    prompt_version: string;
    prompt: string;
    prompt_hash: string;
  }>;
  expected_by_brief_id?: Record<string, {
    task_type: "exact_text_edit" | "content_rewrite" | "style_edit" | "layout_edit" | "web_research" | "image_research" | "mixed" | "unclear";
    execution_scope: "local" | "regenerate" | "uncertain";
    web_research: boolean;
    image_research: boolean;
  }>;
}

export interface BatchTestInput {
  test_id?: string;
  repeat?: number;
  target_stage: BatchTestTargetStage;
  /**
   * For Requirements-only recommendation tests, run the upstream Requirements
   * and research calls once per Brief, then reuse that output for later
   * repetitions. The local template recommender still runs for every case.
   */
  reuse_requirements?: boolean;
  briefs: BatchBriefInput[];
  research_routing?: BatchResearchRoutingInput;
  page_refinement_classification?: BatchPageRefinementClassificationInput;
}

export type { BatchTestTargetStage } from "../../api/types";

export type BatchTestingStatus = "idle" | "running" | "completed" | "partial_failure" | "failed" | "cancelled";

export type BatchTestingView = "history" | "new" | "detail";

export interface BatchTestCaseDetailState {
  loading: boolean;
  error: string;
  requirements: PresentationRequirements | null;
  outline: WorkspaceOutline | null;
  progress: PageProgress | null;
  template: unknown;
  images: Record<string, GetWorkspacePageImageResult | null>;
  imageLoading: string[];
}

export interface BatchTestingState {
  enabled: boolean;
  view: BatchTestingView;
  status: BatchTestingStatus;
  busy: boolean;
  currentCaseId: string | null;
  currentStep: string;
  error: string;
  run: BatchTestRunRecord | null;
  cases: BatchTestCaseRecord[];
  bundleBusy: boolean;
  bundleError: string;
  bundle: PrepareBatchTestBundleResult | null;
  history: BatchTestRunRecord[];
  historyLoading: boolean;
  historyError: string;
  selectedRun: BatchTestRunRecord | null;
  caseDetails: Record<string, BatchTestCaseDetailState>;
}

export function createIdleBatchTestingState(enabled: boolean): BatchTestingState {
  return {
    enabled,
    view: "history",
    status: "idle",
    busy: false,
    currentCaseId: null,
    currentStep: "",
    error: "",
    run: null,
    cases: [],
    bundleBusy: false,
    bundleError: "",
    bundle: null,
    history: [],
    historyLoading: false,
    historyError: "",
    selectedRun: null,
    caseDetails: {},
  };
}

export function createIdleBatchTestCaseDetail(): BatchTestCaseDetailState {
  return {
    loading: false,
    error: "",
    requirements: null,
    outline: null,
    progress: null,
    template: null,
    images: {},
    imageLoading: [],
  };
}
