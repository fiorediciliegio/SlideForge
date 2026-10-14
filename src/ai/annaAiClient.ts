import { creationRequirementsPrompt } from "./creationRequirementsPrompt";
import type { LlmCompleteInput, AnnaRuntime } from "../runtime/annaRuntime";
import type { OutlineDetail } from "../data/mockDeck";
import {
  createAgentClient,
  type AgentClient,
  type AgentOutlineSession,
  type AgentRunOptions,
  type AgentSessionCreationOptions,
} from "../agent/agentClient";
import {
  executeAgentSession,
  type AgentSessionAttempt,
} from "../agent/agentSessionExecutor";
import {
  buildGenerateOutlineLlmRequest,
  buildReviseOutlineLlmRequest,
} from "./outlinePrompt";
import { buildOutlineChunkPrompt, buildOutlineRepairPrompt } from "./outlinePromptMessages";
import { buildPageVisualPlanLlmRequest, buildVisualRhythmLlmRequest } from "./visualPlanningPrompt";
import {
  buildDeckRefinementPlanningRequest,
  DeckRefinementPlanningValidationError,
  normalizeDeckRefinementPlan,
} from "./deckRefinementIntentReview";
import {
  parseOutlineJson,
  validateOutlineHeader,
  validateOutlineChunk,
} from "./outlineParser";
import {
  buildPresentationRequirementsRequest,
} from "./requirementsPrompt";
import {
  buildOutputLanguageRequest,
} from "./outputLanguagePrompt";
import { parseOutputLanguageResponse } from "./outputLanguageParser";
import {
  buildVisualStylePresetColorRequest,
  buildVisualStylePresetRequest,
  parseVisualStylePresetColorResponse,
  parseVisualStylePresetResponse,
} from "./visualStylePresetSelectionPrompt";
import {
  buildVisualStylePresetRecommendationIntentRequest,
  parseVisualStylePresetRecommendationIntentResponse,
} from "./visualStylePresetRecommendationIntent";
import {
  parsePresentationRequirementsCandidates,
  PresentationRequirementsValidationError,
} from "./requirementsParser";
import {
  parseStructuredJson,
} from "./structuredJson";
import { CONTENT_GROUNDING_RULES } from "./groundingRules";
import type { AiOperationLogContext } from "./interactionLog";
import { buildWorkspaceStyleGuideLlmRequest } from "./styleGuidePrompt";
import {
  executeLlmRequest,
  LlmRequestExecutionError,
  LlmResponseValidationError,
  type LlmRequestAttempt,
} from "./llmRequestExecutor";
import {
  applyOutlineAnalysis,
  buildOutlineAiGeneratedAnalysisRequest,
  buildOutlineFocusAnalysisRequest,
  buildOutlineResearchAnalysisRequest,
  parseOutlineAiGeneratedAnalysis,
  parseOutlineFocusAnalysis,
  parseOutlineResearchAnalysis,
} from "./outlineAnalysisPrompt";
import type {
  AiAttemptLog,
  AiClient,
  GeneratedDeck,
  OutlineGenerationResult,
  SelectDominantAestheticReferenceInput,
  OutlineAnalysisInput,
  OutlineAnalysisResult,
} from "./types";

const LLM_COMPLETE_TIMEOUT_MS = 120_000;
const OUTLINE_SESSION_MODEL_PREFERENCE = "google/gemini-3.8-flash";
export interface AnnaAiClientOptions {
  agentClient?: AgentClient;
  createOutlineSession?: (
    systemPrompt: string,
    options?: AgentSessionCreationOptions,
  ) => Promise<AgentOutlineSession>;
}

export class AiOutlineGenerationError extends Error {
  constructor(
    message: string,
    public readonly attempts: AiAttemptLog[]
  ) {
    super(message);
    this.name = "AiOutlineGenerationError";
  }
}

export class AiPresentationRequirementsError extends Error {
  constructor(message: string, public readonly validationErrors: string[] = []) {
    super(message);
    this.name = "AiPresentationRequirementsError";
  }
}

function parseJsonResult<T>(text: string, label: string): T {
  try {
    return parseStructuredJson<T>(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Anna LLM returned invalid JSON for ${label}: ${message}`);
  }
}

async function completeJson<T>(
  runtime: AnnaRuntime,
  label: string,
  prompt: string,
  logContext?: AiOperationLogContext
): Promise<T> {
  return completeJsonRequest<T>(
    runtime,
    label,
    {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: prompt
          }
        }
      ]
    },
    undefined,
    logContext,
  );
}

async function completeJsonRequest<T>(
  runtime: AnnaRuntime,
  label: string,
  initialRequest: LlmCompleteInput,
  parseResponse: (rawText: string) => T = (rawText) => parseJsonResult<T>(rawText, label),
  logContext?: AiOperationLogContext,
  options: {
    onAttempt?: (attempt: LlmRequestAttempt) => void | Promise<void>;
    accept?: (value: T) => T | Promise<T>;
  } = {},
): Promise<T> {
  const result = await executeLlmRequest({
    runtime,
    request: initialRequest,
    logContext,
    timeoutMs: LLM_COMPLETE_TIMEOUT_MS,
    performanceLayer: "anna-llm",
    onAttempt: options.onAttempt,
    accept: async (rawText) => {
      const value = parseResponse(rawText);
      return options.accept ? options.accept(value) : value;
    },
  });
  return result.value;
}

async function completePresentationRequirementsWithRetry(
  runtime: AnnaRuntime,
  brief: string,
  outputLanguage: string,
  logContext?: AiOperationLogContext,
  attachmentContext?: import("../api/types").AttachmentContext | null,
) {
  const request = buildPresentationRequirementsRequest(
    brief,
    outputLanguage,
    attachmentContext,
  );
  try {
    const result = await executeLlmRequest({
      runtime,
      request,
      logContext,
      timeoutMs: LLM_COMPLETE_TIMEOUT_MS,
      performanceLayer: "anna-llm",
      accept: (rawText) => parsePresentationRequirementsCandidates(rawText),
    });
    return result.value;
  } catch (error) {
    const executionError = error instanceof LlmRequestExecutionError ? error : null;
    const lastError = executionError?.lastError ?? error;
    const validationErrors = lastError instanceof PresentationRequirementsValidationError
      ? lastError.errors
      : [lastError instanceof Error ? lastError.message : String(lastError)];
    const lastAttempt = executionError?.attempts.at(-1);
    const message = lastAttempt?.failure_kind === "request"
      ? `Anna LLM request failed while generating Presentation Requirements: ${validationErrors.join("; ")}`
      : `Anna LLM returned invalid Presentation Requirements JSON: ${validationErrors.join("; ")}`;
    throw new AiPresentationRequirementsError(
      message,
      validationErrors,
    );
  }
}

async function detectOutputLanguageWithRetry(
  runtime: AnnaRuntime,
  brief: string,
  logContext?: AiOperationLogContext,
) {
  return completeJsonRequest(
    runtime,
    "presentation output language",
    buildOutputLanguageRequest(brief),
    parseOutputLanguageResponse,
    logContext,
  );
}

async function selectVisualStylePresetColorWithRetry(
  runtime: AnnaRuntime,
  input: Parameters<typeof buildVisualStylePresetColorRequest>[0],
  logContext?: AiOperationLogContext,
) {
  const request = buildVisualStylePresetColorRequest(input);
  return completeJsonRequest(
    runtime,
    "visual style preset color",
    request,
    (rawText) => parseVisualStylePresetColorResponse(parseStructuredJson(rawText), input.colors),
    logContext,
  );
}

async function selectVisualStylePresetWithRetry(
  runtime: AnnaRuntime,
  input: Parameters<typeof buildVisualStylePresetRequest>[0],
  logContext?: AiOperationLogContext,
) {
  const request = buildVisualStylePresetRequest(input);
  return completeJsonRequest(
    runtime,
    "visual style preset",
    request,
    (rawText) => parseVisualStylePresetResponse(parseStructuredJson(rawText), input.candidates),
    logContext,
  );
}

function buildThemeTokenPrompt(input: Parameters<AiClient["generateThemeToken"]>[0]) {
  const isRefinement = Boolean(input.refinementRequest?.trim());
  const userInput = {
    locale: input.locale,
    run_kind: isRefinement ? "deck-refinement" : "deck-generation",
    brief: input.prompt,
    context_rows: input.contextRows,
    refinement_request: input.refinementRequest ?? "",
    current_token: isRefinement ? input.currentToken ?? null : null,
    template_theme_contract: {
      schema_path: input.themeContext.schema_path,
      default_token_path: input.themeContext.default_token_path,
      readme_path: input.themeContext.readme_path,
      schema: input.themeContext.schema,
      default_token: input.themeContext.default_token,
      readme: input.themeContext.readme,
    },
    selected_style_profile: input.selectedStyleProfile
      ? {
          display_name: input.selectedStyleProfile.displayName ?? "",
          profile_path: input.selectedStyleProfile.profilePath,
          markdown: input.selectedStyleProfile.content,
        }
      : null,
  };

  return [
    "Generate a complete Workspace Theme Token JSON object for the selected presentation Template.",
    "Return only the bare JSON object. Do not include markdown, code fences, comments, explanations, rationale, patches, or an envelope.",
    "The output must be a full replacement token that satisfies the provided JSON Schema.",
    "Use the template README and default token as the baseline. Preserve the template's intended visual system unless the user clearly asks for a different whole-deck style.",
    "Do not invent schema keys. Do not omit required keys. Do not use values outside enum/const/pattern requirements.",
    isRefinement
      ? "For Deck Refinement, use current_token as the baseline and apply only the requested whole-deck theme/style change."
      : "For initial Deck Generation, use the brief and context rows to infer theme intent.",
    "Contrast requirements are hard requirements.",
    "Style priority: template theme contract/schema/contrast requirements > explicit user or workspace style intent > Selected Style Profile > template default token baseline.",
    "When selected_style_profile is present, use it as visual style guidance only: colors, contrast, typography tone, hierarchy, spacing, layout rhythm, graphic language, and chart/image treatment.",
    "Selected Style Profile is not factual evidence. Do not use it for claims, numbers, dates, source names, chart data, or business conclusions.",
    "Before returning the token, self-check key foreground/background pairs for readable contrast.",
    "If the user asks for black backgrounds with white/orange text, do not set any token used as foreground on dark backgrounds to black or near-black.",
    "Do not use Uploaded Source Analysis, web research, component source code, or fixed theme IDs.",
    "",
    "Input JSON:",
    JSON.stringify(userInput, null, 2),
  ].join("\n");
}

function readOutlineSessionPrompts(request: LlmCompleteInput) {
  const textForRole = (role: "system" | "user") => {
    const content = request.messages.find((message) => message.role === role)?.content;
    return (typeof content === "string" ? content : content?.type === "text" ? content.text : "").trim();
  };
  const systemPrompt = textForRole("system");
  const userPrompt = textForRole("user");
  if (!systemPrompt || !userPrompt) {
    throw new Error("Outline Session requires both a system prompt and a user prompt.");
  }
  return { systemPrompt, userPrompt };
}

function readOutlineValidationErrors(error: unknown): string[] {
  if (error && typeof error === "object" && "errors" in error) {
    const errors = (error as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      const messages = errors.filter((item): item is string => typeof item === "string");
      if (messages.length > 0) return messages;
    }
  }
  return [error instanceof Error ? error.message : String(error)];
}

async function completeOutlineWithSession(
  operation: "generateOutline" | "reviseOutline",
  initialRequest: LlmCompleteInput,
  createOutlineSession: (
    systemPrompt: string,
    options?: AgentSessionCreationOptions,
  ) => Promise<AgentOutlineSession>,
  logContext?: AiOperationLogContext,
  progress?: Pick<import("./types").GenerateOutlineInput, "onStreamEvent" | "onAttemptStart" | "onAttemptEnd" | "isCancelled">,
  expectedSlideCount?: number,
): Promise<OutlineGenerationResult> {
  const { systemPrompt, userPrompt } = readOutlineSessionPrompts(initialRequest);
  const attempts: AiAttemptLog[] = [];
  let sessionAttempt = 0;
  const isCancellationError = (error: unknown) => error instanceof Error && error.name === "AgentRunCancelledError";
  const checkCancelled = () => {
    if (progress?.isCancelled?.()) {
      const error = new Error("Outline creation cancelled");
      error.name = "AgentRunCancelledError";
      throw error;
    }
  };
  const recordAttempt = (
    attempt: AgentSessionAttempt<AgentRunOptions>,
    stage: AiAttemptLog["stage"],
    range?: { start: number; end: number },
  ) => {
    attempts.push({
      operation,
      attempt: attempts.length + 1,
      sessionAttempt,
      stage,
      pageRange: range,
      status: attempt.status,
      transport: "session",
      sessionPrompt: attempt.prompt,
      sessionRawResponse: attempt.raw_text,
      validation: { ok: attempt.status === "success", errors: attempt.status === "success" ? [] : readOutlineValidationErrors(attempt.error) },
      ...(attempt.error ? { error: { message: attempt.error instanceof Error ? attempt.error.message : String(attempt.error) } } : {}),
    });
  };
  try {
    const result = await executeAgentSession<OutlineGenerationResult["outline"], AgentRunOptions>({
      initialPrompt: userPrompt,
      maxSameSessionRetries: 0,
      maxFreshSessionRetries: 5,
      isCancellationError,
      createSession: async () => {
        checkCancelled();
        sessionAttempt += 1;
        const session = await createOutlineSession(systemPrompt, { manageFreshSessionRetries: false });
        // 外层拥有真实会话；每个阶段复用执行器做三次同会话纠正，不能自行换会话。
        const runStage = async <T>(
          prompt: string,
          accept: (rawText: string) => T,
          stage: "header" | "items",
          repairRequirement: string,
          range?: { start: number; end: number },
        ): Promise<T> => {
          const response = await executeAgentSession<T, AgentRunOptions>({
            initialPrompt: prompt,
            createSession: async () => ({
              run: async (text, options) => { checkCancelled(); return session.run(text, options ?? {}); },
              close: async () => undefined,
            }),
            runOptionsForAttempt: ({ sameSessionRetryCount }) => {
              progress?.onAttemptStart?.({ session: sessionAttempt, stage, correction: sameSessionRetryCount, pageRange: range });
              return { logContext, modelPreference: OUTLINE_SESSION_MODEL_PREFERENCE, toolAccessPolicy: "off",
                onStreamEvent: progress?.onStreamEvent, isCancelled: progress?.isCancelled };
            },
            accept: (rawText) => { checkCancelled(); return accept(rawText); },
            buildSameSessionRepairPrompt: ({ error }) => buildOutlineRepairPrompt(readOutlineValidationErrors(error), repairRequirement),
            maxSameSessionRetries: 3,
            maxFreshSessionRetries: 0,
            isCancellationError,
            onAttempt: (attempt) => {
              recordAttempt(attempt, stage, range);
              progress?.onAttemptEnd?.({ status: attempt.status, text: attempt.raw_text });
            },
          });
          return response.value;
        };
        return {
          run: async (prompt: string) => {
            const header = await runStage(prompt,
              (raw) => validateOutlineHeader(parseOutlineJson(raw), expectedSlideCount),
              "header",
              '只返回 {"title":"...","total_pages":正整数,"global_creation_requirements":"..."}，不要返回 items 或章节规划。'
                + (expectedSlideCount === undefined
                  ? "除非用户明确要求改变页数，否则保持输入的当前大纲页数。"
                  : `total_pages 必须为 ${expectedSlideCount}。`));
            const items: OutlineDetail[] = [];
            for (let start = 1; start <= header.total_pages; start += 20) {
              const end = Math.min(start + 19, header.total_pages);
              const chunkPrompt = buildOutlineChunkPrompt(start, end, header.total_pages);
              items.push(...await runStage(chunkPrompt,
                (raw) => validateOutlineChunk(parseOutlineJson(raw), start, end),
                "items", chunkPrompt, { start, end }));
            }
            checkCancelled();
            // 此字符串由已校验的分段组装，不是未经校验的模型响应。
            return JSON.stringify({
              title: header.title,
              global_creation_requirements: header.global_creation_requirements,
              items,
            });
          },
          close: () => session.close(),
        };
      },
      accept: (assembled) => JSON.parse(assembled) as OutlineGenerationResult["outline"],
      onAttempt: (attempt) => {
        if (attempt.status !== "success") recordAttempt(attempt, "session");
      },
    });
    return { outline: result.value, attempts };
  } catch (error) {
    if (isCancellationError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AiOutlineGenerationError(`大纲 Session 运行失败：${message}`, attempts);
  }
}

async function analyzeOutlineWithLlm(
  runtime: AnnaRuntime,
  input: OutlineAnalysisInput,
): Promise<OutlineDetail[]> {
  const expectedPages = input.outline.length;
  const contextFor = (operation: string) => input.logContext
    ? { ...input.logContext, operation }
    : undefined;
  const [focusResult, aiGeneratedResult, researchResult] = await Promise.all([
    executeLlmRequest({
      runtime,
      request: buildOutlineFocusAnalysisRequest(input),
      logContext: contextFor("outline_focus_analysis"),
      timeoutMs: LLM_COMPLETE_TIMEOUT_MS,
      performanceLayer: "anna-llm",
      accept: (rawText) => parseOutlineFocusAnalysis(rawText, expectedPages),
    }),
    executeLlmRequest({
      runtime,
      request: buildOutlineAiGeneratedAnalysisRequest(input),
      logContext: contextFor("outline_ai_generated_analysis"),
      timeoutMs: LLM_COMPLETE_TIMEOUT_MS,
      performanceLayer: "anna-llm",
      accept: (rawText) => parseOutlineAiGeneratedAnalysis(rawText, expectedPages),
    }),
    executeLlmRequest({
      runtime,
      request: buildOutlineResearchAnalysisRequest(input),
      logContext: contextFor("outline_research_analysis"),
      timeoutMs: LLM_COMPLETE_TIMEOUT_MS,
      performanceLayer: "anna-llm",
      accept: (rawText) => parseOutlineResearchAnalysis(rawText, expectedPages),
    }),
  ]);
  return applyOutlineAnalysis(
    input.outline,
    focusResult.value,
    aiGeneratedResult.value,
    researchResult.value,
    input.requirements,
  );
}

function formatAestheticReferenceDeckSummary(input: SelectDominantAestheticReferenceInput): string {
  const selections = input.requirements.selections;
  const preset = selections.visual_style_preset;
  return [
    `主题：${input.outline.title}`,
    `模板：${preset ? `${preset.name}：${preset.description}` : "未提供"}`,
    `语言：${selections.output_language ?? "未提供"}`,
    `页数：${input.outline.items.length} 页`,
  ].join("\n");
}

function formatAestheticReferenceCandidates(input: SelectDominantAestheticReferenceInput): string {
  return input.candidates.map((candidate, index) => [
    `${index + 1}. 路径：${candidate.path}`,
    `   描述：${candidate.description}`,
  ].join("\n")).join("\n");
}

function buildVisualMasterAestheticReferencePrompt(input: SelectDominantAestheticReferenceInput): string {
  return [
    "你是一名 HTML 美学参考选择专家。",
    "请选择最适合作为整套演示跨页视觉基础的唯一参考页。",
    "优先考虑通用性、可复用的字体层级、页面骨架和跨页一致性。不要因为某一页的局部内容结构而选择高度专用的数据页、封面页或收束页。",
    "只参考候选页的视觉设计，不参考其中的文字事实。",
    "",
    "## 演示文稿概况",
    formatAestheticReferenceDeckSummary(input),
    ...creationRequirementsPrompt(input.outline.global_creation_requirements),
    "",
    "## 候选模板参考页",
    formatAestheticReferenceCandidates(input),
    "",
    '只输出 JSON：{"path":"html/example.html"}',
  ].join("\n");
}

function buildPageAestheticReferencePrompt(input: SelectDominantAestheticReferenceInput): string {
  const page = input.page;
  if (!page) throw new Error("Page is required for page aesthetic reference selection");
  const pageIndex = input.outline.items.findIndex((item) =>
    item === page || Boolean(page.page_id && item.page_id === page.page_id)
  );
  if (pageIndex < 0) throw new Error("Page is missing from the outline for aesthetic reference selection");
  return [
    "你是一名 HTML 美学参考选择专家。",
    "请选择最适合当前页信息结构和页面类型的唯一参考页。",
    "重点参考候选页的构图、信息层级和视觉节奏，不参考其中的文字事实。",
    "",
    "## 演示文稿概况",
    formatAestheticReferenceDeckSummary(input),
    ...creationRequirementsPrompt(input.outline.global_creation_requirements, page.creation_requirements),
    "",
    "## 当前页",
    `页码：第 ${pageIndex + 1} 页，共 ${input.outline.items.length} 页`,
    `页面类型：${page.page_type === "cover" ? "封面页" : "普通内容页"}`,
    `页面标题：${page.title}`,
    "页面内容：",
    page.content,
    "",
    "## 候选模板参考页",
    formatAestheticReferenceCandidates(input),
    "",
    '只输出 JSON：{"path":"html/example.html"}',
  ].join("\n");
}

export function createAnnaAiClient(
  runtime: AnnaRuntime,
  options: AnnaAiClientOptions = {},
): AiClient {
  let outlineAgentClientPromise: ReturnType<typeof createAgentClient> | null = null;
  const createOutlineSession = options.createOutlineSession ?? (async (
    systemPrompt: string,
    sessionOptions?: AgentSessionCreationOptions,
  ) => {
    if (options.agentClient) {
      return options.agentClient.createOutlineSession(systemPrompt, sessionOptions);
    }
    outlineAgentClientPromise ??= createAgentClient(runtime, { toolAccessPolicy: "off" });
    return (await outlineAgentClientPromise).createOutlineSession(systemPrompt, sessionOptions);
  });

  return {
    detectOutputLanguage(input) {
      return detectOutputLanguageWithRetry(runtime, input.brief, input.logContext);
    },

    generatePresentationRequirements(input) {
      return completePresentationRequirementsWithRetry(
        runtime,
        input.brief,
        input.outputLanguage,
        input.logContext,
        input.attachmentContext,
      );
    },

    async analyzeVisualStylePresetRecommendationIntent(input) {
      const result = await executeLlmRequest({
        runtime,
        request: buildVisualStylePresetRecommendationIntentRequest(input.brief),
        logContext: input.logContext,
        timeoutMs: LLM_COMPLETE_TIMEOUT_MS,
        performanceLayer: "template-recommendation-intent",
        maxAttempts: 3,
        accept: (rawText) => parseVisualStylePresetRecommendationIntentResponse(parseStructuredJson(rawText)),
      });
      return { intent: result.value, attempts: result.attempts };
    },

    selectVisualStylePresetColor(input) {
      return selectVisualStylePresetColorWithRetry(
        runtime,
        input,
        input.logContext ? { ...input.logContext, operation: "select_preset_color" } : undefined,
      );
    },

    selectVisualStylePreset(input) {
      return selectVisualStylePresetWithRetry(
        runtime,
        input,
        input.logContext ? { ...input.logContext, operation: "select_preset_template" } : undefined,
      );
    },

    async selectDominantAestheticReference(input) {
      if (input.candidates.length === 0) throw new Error("No aesthetic reference candidates are available");
      // A singleton catalog has no decision to make. Besides avoiding an
      // unnecessary model request, this prevents a model from inventing a
      // reference path which then blocks the whole deck before HTML authoring.
      if (input.candidates.length === 1) return input.candidates[0]!.path;
      const prompt = input.target === "visual-master"
        ? buildVisualMasterAestheticReferencePrompt(input)
        : buildPageAestheticReferencePrompt(input);
      const result = await executeLlmRequest({
        runtime,
        request: {
          messages: [{ role: "user", content: { type: "text", text: prompt } }],
        },
        logContext: input.logContext,
        timeoutMs: LLM_COMPLETE_TIMEOUT_MS,
        performanceLayer: "anna-llm",
        accept: (rawText) => {
          const parsed = parseStructuredJson<{ path?: unknown }>(rawText);
          const selectedPath = typeof parsed.path === "string" ? parsed.path.trim() : "";
          if (!input.candidates.some((candidate) => candidate.path === selectedPath)) {
            throw new Error(`LLM selected an unknown aesthetic reference: ${selectedPath || "(empty)"}`);
          }
          return selectedPath;
        },
      });
      return result.value;
    },

    async generateOutline(input) {
      return completeOutlineWithSession(
        "generateOutline",
        buildGenerateOutlineLlmRequest(input),
        createOutlineSession,
        input.logContext,
        input,
        input.requirements.selections.slide_count!,
      );
    },

    async analyzeOutline(input): Promise<OutlineAnalysisResult> {
      const analyzedItems = await analyzeOutlineWithLlm(runtime, input);
      return {
        items: analyzedItems.map((item) => item.analysis!).filter(Boolean),
      };
    },

    async generateWorkspaceStyleGuide(input) {
      const request = buildWorkspaceStyleGuideLlmRequest(input);
      const result = await executeLlmRequest({
        runtime,
        request,
        logContext: input.logContext,
        timeoutMs: LLM_COMPLETE_TIMEOUT_MS,
        performanceLayer: "anna-llm",
        accept: (rawText) => rawText.trim(),
      });
      return result.value;
    },

    async generateThemeToken(input) {
      const result = await completeJsonRequest<unknown>(
        runtime,
        "workspace theme token",
        {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: buildThemeTokenPrompt(input),
              },
            },
          ],
        },
        undefined,
        input.logContext,
        {
          onAttempt: input.onAttempt,
          accept: async (token) => {
            if (!input.validateToken) return token;
            const validation = await input.validateToken(token);
            if (!validation.ok) {
              throw new LlmResponseValidationError(
                `Workspace Theme Token validation failed: ${validation.errors.join("; ")}`,
                validation.errors,
                validation,
              );
            }
            return token;
          },
        },
      );
      return result;
    },

    async generateVisualRhythm(input) {
      const request = buildVisualRhythmLlmRequest(input);
      const result = await executeLlmRequest({
        runtime,
        request,
        logContext: input.logContext,
        timeoutMs: LLM_COMPLETE_TIMEOUT_MS,
        performanceLayer: "anna-llm",
        accept: (rawText) => rawText.trim(),
      });
      return result.value;
    },

    async generatePageVisualPlan(input) {
      const request = buildPageVisualPlanLlmRequest(input);
      const result = await executeLlmRequest({
        runtime,
        request,
        logContext: input.logContext,
        timeoutMs: LLM_COMPLETE_TIMEOUT_MS,
        performanceLayer: "anna-llm",
        accept: (rawText) => rawText.trim(),
      });
      return result.value;
    },

    async planDeckRefinement(input) {
      const mapAttempts = (attempts: LlmRequestAttempt[]) => attempts.map((attempt) => ({
        attempt: attempt.attempt,
        status: attempt.status,
        llmRequest: attempt.request,
        ...(attempt.raw_response === undefined ? {} : { llmRawResponse: attempt.raw_response }),
        validation: {
          ok: attempt.status === "success",
          errors: attempt.errors,
        },
        ...(attempt.failure_kind === "request"
          ? { error: { message: attempt.errors.join("; ") } }
          : {}),
      }));
      try {
        const result = await executeLlmRequest({
          runtime,
          request: buildDeckRefinementPlanningRequest(input),
          logContext: input.logContext,
          timeoutMs: LLM_COMPLETE_TIMEOUT_MS,
          performanceLayer: "anna-llm",
          accept: (rawText) => normalizeDeckRefinementPlan(
            parseStructuredJson<unknown>(rawText),
            input,
          ),
        });
        return {
          plan: result.value,
          attempts: mapAttempts(result.attempts),
        };
      } catch (error) {
        if (error instanceof LlmRequestExecutionError
          && error.lastError instanceof DeckRefinementPlanningValidationError) {
          throw error.lastError;
        }
        throw error;
      }
    },

    async generateDeck(input) {
      return completeJson<GeneratedDeck>(
        runtime,
        "deck",
        [
          "Return a JSON object with title, outline, and slides fields.",
          "outline items must have title and outline.",
          "slides must have title and subtitle.",
          CONTENT_GROUNDING_RULES,
          `Locale: ${input.locale}`,
          `Prompt: ${input.prompt}`,
          `Context: ${JSON.stringify(input.contextRows)}`,
          `Setting: ${JSON.stringify(input.setting ?? {})}`
        ].join("\n"),
        input.logContext
      );
    },

    async reviseOutline(input) {
      const result = await completeOutlineWithSession(
        "reviseOutline",
        buildReviseOutlineLlmRequest(input),
        createOutlineSession,
        input.logContext,
        input,
      );
      return result;
    },

    generateSlidesFromOutline(input) {
      return completeJson(
        runtime,
        "slides",
        [
          "Create slide summaries from this outline.",
          "Return only a JSON array. Each item must have title and subtitle.",
          CONTENT_GROUNDING_RULES,
          `Locale: ${input.locale}`,
          `Outline: ${JSON.stringify(input.outline)}`
        ].join("\n"),
        input.logContext
      );
    },

    refineDeck(input) {
      return completeJson(
        runtime,
        "refined deck",
        [
          "Refine this deck. Return only a JSON array of slides.",
          "Each slide must have title and subtitle.",
          CONTENT_GROUNDING_RULES,
          "Do not add new factual claims during refinement unless they are already present in the provided slides.",
          `Locale: ${input.locale}`,
          `Slides: ${JSON.stringify(input.slides)}`
        ].join("\n"),
        input.logContext
      );
    },

    refineSlide(input) {
      return completeJson(
        runtime,
        "refined slide",
        [
          "Refine this single slide. Return only a JSON object with title and subtitle.",
          CONTENT_GROUNDING_RULES,
          "Do not add new factual claims during refinement unless they are already present in the provided slide.",
          `Locale: ${input.locale}`,
          `Slide number: ${input.slideIndex + 1}`,
          `Slide: ${JSON.stringify(input.slide)}`
        ].join("\n"),
        input.logContext
      );
    }
  };
}
