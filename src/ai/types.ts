import type { OutlineDetail, Slide } from "../data/mockDeck";
import type { LlmCompleteInput } from "../runtime/annaRuntime";
import type {
  PresentationRequirements,
  PresentationRequirementsGeneratedCandidates,
  AttachmentContext,
  VisualStylePreset,
  VisualStylePresetColor,
  WorkspaceSettings,
  WorkspaceThemeValidationResult,
} from "../api/types";
import type {
  WorkspaceThemeContext,
  WorkspaceOutline,
} from "../api/types";
import type { Locale } from "../i18n/messages";
import type { AiOperationLogContext } from "./interactionLog";
import type { GenerateWorkspaceStyleGuideInput } from "./styleGuidePrompt";
import type { GeneratePageVisualPlanInput, GenerateVisualRhythmInput } from "./visualPlanningPrompt";
import type { AnalyzeOutlineInput } from "./outlineAnalysisPrompt";
import type { OutlineAnalysis } from "../api/outlineTypes";
import type { LlmRequestAttempt } from "./llmRequestExecutor";
import type { VisualStylePresetRecommendationIntent } from "./visualStylePresetRecommendationIntent";

export interface LlmContextRow {
  id: string;
  value: string;
}

export interface DeckBriefInput {
  prompt: string;
  contextRows: LlmContextRow[];
  locale: Locale;
  setting?: WorkspaceSettings;
  logContext?: AiOperationLogContext;
}

export interface OutlineAttemptInfo {
  session: number;
  stage: "header" | "items";
  correction: number;
  pageRange?: { start: number; end: number };
}

export interface GenerateOutlineInput {
  onStreamEvent?: import("../agent/agentClient").AgentRunOptions["onStreamEvent"];
  onAttemptStart?: (info: OutlineAttemptInfo) => void;
  onAttemptEnd?: (result: { status: "success" | "retry" | "error"; text?: string }) => void;
  isCancelled?: () => boolean;
  requirements: PresentationRequirements;
  uploadedSourceAnalysisContext?: unknown;
  webResearchSummary?: string;
  attachmentContext?: AttachmentContext | null;
  logContext?: AiOperationLogContext;
}

export interface GenerateDeckInput extends DeckBriefInput {
  outlineFirst: boolean;
}

export interface GeneratePresentationRequirementsInput {
  brief: string;
  outputLanguage: string;
  attachmentContext?: AttachmentContext | null;
  logContext?: AiOperationLogContext;
}

export interface DetectOutputLanguageInput {
  brief: string;
  logContext?: AiOperationLogContext;
}

export interface AnalyzeVisualStylePresetRecommendationIntentInput {
  brief: string;
  logContext?: AiOperationLogContext;
}

export type VisualStylePresetSelectionCandidate = Pick<
  VisualStylePreset,
  "id" | "version" | "name" | "description" | "theme" | "color" | "user" | "use_case" | "industry"
>;

export interface SelectDominantAestheticReferenceInput {
  target: "visual-master" | "page";
  brief: string;
  requirements: PresentationRequirements;
  outline: WorkspaceOutline;
  page?: WorkspaceOutline["items"][number];
  candidates: Array<{ path: string; description: string }>;
  logContext?: AiOperationLogContext;
}

export interface SelectVisualStylePresetColorInput {
  brief: string;
  requirements: PresentationRequirements;
  colors: VisualStylePresetColor[];
  logContext?: AiOperationLogContext;
}

export interface SelectVisualStylePresetInput {
  brief: string;
  requirements: PresentationRequirements;
  color: VisualStylePresetColor;
  candidates: VisualStylePresetSelectionCandidate[];
  logContext?: AiOperationLogContext;
}

export interface GenerateThemeTokenInput {
  prompt: string;
  contextRows: LlmContextRow[];
  locale: Locale;
  themeContext: WorkspaceThemeContext;
  refinementRequest?: string;
  currentToken?: unknown;
  selectedStyleProfile?: {
    displayName?: string;
    profilePath: string;
    content: string;
  } | null;
  validateToken?: (
    token: unknown,
  ) => WorkspaceThemeValidationResult | Promise<WorkspaceThemeValidationResult>;
  onAttempt?: (attempt: LlmRequestAttempt) => void | Promise<void>;
  logContext?: AiOperationLogContext;
}

export interface ReviseOutlineInput extends Pick<GenerateOutlineInput, "onStreamEvent" | "onAttemptStart" | "onAttemptEnd" | "isCancelled"> {
  global_creation_requirements?: string;
  title?: string;
  outline: OutlineDetail[];
  feedback: string;
  requirements: PresentationRequirements;
  uploadedSourceAnalysisContext?: unknown;
  webResearchSummary?: string;
  attachmentContext?: AttachmentContext | null;
  logContext?: AiOperationLogContext;
}

export interface OutlineAnalysisInput extends AnalyzeOutlineInput {
  logContext?: AiOperationLogContext;
}

export interface GenerateSlidesFromOutlineInput {
  outline: OutlineDetail[];
  locale: Locale;
  logContext?: AiOperationLogContext;
}

export interface RefineDeckInput {
  slides: Slide[];
  locale: Locale;
  logContext?: AiOperationLogContext;
}

export interface RefineSlideInput {
  slide: Slide;
  slideIndex: number;
  locale: Locale;
  logContext?: AiOperationLogContext;
}

export interface GeneratedDeck {
  title: string;
  outline: OutlineDetail[];
  slides: Slide[];
}

export interface GeneratedOutline {
  /** 用户明确提出的全局创作要求；旧大纲缺省按空字符串读取。 */
  global_creation_requirements?: string;
  title: string;
  items: OutlineDetail[];
}

export interface AiAttemptLog {
  sessionAttempt?: number;
  stage?: "header" | "items" | "session";
  pageRange?: { start: number; end: number };
  operation: "generateOutline" | "reviseOutline";
  attempt: number;
  status: "success" | "retry" | "error";
  transport: "llm" | "session";
  llmRequest?: LlmCompleteInput;
  llmRawResponse?: unknown;
  sessionPrompt?: string;
  sessionRawResponse?: string;
  validation?: {
    ok: boolean;
    errors: string[];
  };
  error?: {
    message: string;
  };
}

export interface OutlineGenerationResult {
  outline: GeneratedOutline;
  attempts: AiAttemptLog[];
}

export interface OutlineAnalysisResult {
  items: OutlineAnalysis[];
}

export type DeckRefinementPlanningRoute = "proceed" | "no_op";

export type DeckRefinementOutlineOperation =
  | {
      op: "keep";
      page_id: string;
      reason: string;
    }
  | {
      op: "update";
      page_id: string;
      page_type: "cover" | "standard";
      title: string;
      content: string;
      reason: string;
    }
  | {
      op: "add";
      page_type: "cover" | "standard";
      title: string;
      content: string;
      reason: string;
    }
  | {
      op: "delete";
      page_id: string;
      reason: string;
    };

export interface DeckRefinementPlan {
  route: DeckRefinementPlanningRoute;
  title: string;
  output_language_change: {
    changed: boolean;
    output_language?: string;
    reason?: string;
  };
  style_guide_change: {
    action: "preserve" | "regenerate";
    reason: string;
  };
  visual_rhythm_action: "preserve" | "rewrite";
  persistent_elements_action: "preserve" | "revise";
  operations: DeckRefinementOutlineOperation[];
  reason: string;
}

export interface PlanDeckRefinementInput {
  instruction: string;
  outline: WorkspaceOutline;
  requirements: PresentationRequirements;
  currentStyleGuide: string;
  currentVisualRhythm?: string;
  locale: Locale;
  visualStylePresetSelected?: boolean;
  logContext?: AiOperationLogContext;
}

export interface DeckRefinementPlanningAttempt {
  attempt: number;
  status: "success" | "retry" | "error";
  llmRequest: LlmCompleteInput;
  llmRawResponse?: unknown;
  validation: {
    ok: boolean;
    errors: string[];
  };
  error?: { message: string };
}

export interface DeckRefinementPlanningResult {
  plan: DeckRefinementPlan;
  attempts: DeckRefinementPlanningAttempt[];
}

export interface AiClient {
  detectOutputLanguage(
    input: DetectOutputLanguageInput,
  ): Promise<{ output_language: string }>;
  generatePresentationRequirements(
    input: GeneratePresentationRequirementsInput
  ): Promise<PresentationRequirementsGeneratedCandidates>;
  analyzeVisualStylePresetRecommendationIntent(
    input: AnalyzeVisualStylePresetRecommendationIntentInput,
  ): Promise<{ intent: VisualStylePresetRecommendationIntent; attempts: LlmRequestAttempt[] }>;
  selectVisualStylePresetColor(
    input: SelectVisualStylePresetColorInput,
  ): Promise<VisualStylePresetColor>;
  selectVisualStylePreset(
    input: SelectVisualStylePresetInput,
  ): Promise<string>;
  selectDominantAestheticReference(
    input: SelectDominantAestheticReferenceInput,
  ): Promise<string>;
  generateOutline(input: GenerateOutlineInput): Promise<OutlineGenerationResult>;
  analyzeOutline?(input: OutlineAnalysisInput): Promise<OutlineAnalysisResult>;
  generateWorkspaceStyleGuide(input: GenerateWorkspaceStyleGuideInput): Promise<string>;
  generateThemeToken(input: GenerateThemeTokenInput): Promise<unknown>;
  generateVisualRhythm(input: GenerateVisualRhythmInput): Promise<string>;
  generatePageVisualPlan(input: GeneratePageVisualPlanInput): Promise<string>;
  planDeckRefinement(input: PlanDeckRefinementInput): Promise<DeckRefinementPlanningResult>;
  generateDeck(input: GenerateDeckInput): Promise<GeneratedDeck>;
  reviseOutline(input: ReviseOutlineInput): Promise<OutlineGenerationResult>;
  generateSlidesFromOutline(
    input: GenerateSlidesFromOutlineInput
  ): Promise<Slide[]>;
  refineDeck(input: RefineDeckInput): Promise<Slide[]>;
  refineSlide(input: RefineSlideInput): Promise<Slide>;
}
