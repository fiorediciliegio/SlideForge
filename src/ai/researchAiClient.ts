import { requirementsForPrompt } from "./requirementsFormatting";
import type { AttachmentContext, PresentationRequirements, PresentationResearchRequirements } from "../api/types";
import type { Locale } from "../i18n/messages";
import { pickLocale } from "../i18n/locales";
import type { LlmCompleteInput, AnnaRuntime } from "../runtime/annaRuntime";
import type { AiOperationLogContext } from "./interactionLog";
import { parseStructuredJson } from "./structuredJson";
import { executeLlmRequest, LlmRequestExecutionError, type LlmRequestAttempt } from "./llmRequestExecutor";
import { currentDatePromptLine } from "./promptContext";
import { formatUserProvidedAttachmentContextForPrompt } from "./attachmentContextPrompt";

const RESEARCH_RECOMMENDATION_JSON_ONLY =
  'Return exactly one JSON object:{"web":{"recommended":false,"reason":"..."},"images":{"recommended":false,"reason":"..."}}';

/**
 * 推荐理由语言：跟随界面 locale（不是成稿 output_language）。
 * 理由是界面辅助文案，读它的人看的是界面语言；
 * output_language 只管 PPT 成稿内容，两者职责分离（方案 §4.1 范式）。
 */
const RESEARCH_REASON_LANGUAGE: Record<Locale, string> = {
  en: "English",
  zh: "中文",
  ja: "日本語",
  de: "Deutsch",
};

export interface ResearchRoutingEvaluationResult {
  research: PresentationResearchRequirements;
  actual_model: string | null;
  token_usage: unknown;
  latency_ms: number;
  json_repair_count: number;
  retry_count: number;
  retry_reasons: Array<"invocation" | "json_format" | "schema">;
}

export interface ResearchAiClient {
  recommendResearch(input: {
    brief: string;
    requirements: PresentationRequirements;
    attachmentContext?: AttachmentContext | null;
    /** 界面 locale：推荐理由语言跟随它（界面辅助文案，非成稿内容） */
    locale: Locale;
    logContext?: AiOperationLogContext;
  }): Promise<PresentationResearchRequirements>;
  /**
   * Evaluation-only entry point. Production research recommendations must use
   * recommendResearch above; this method exists so the offline evaluator can
   * compare candidate prompts without changing the production prompt.
   */
  recommendResearchForEvaluation(input: {
    brief: string;
    requirements: PresentationRequirements;
    attachmentContext?: AttachmentContext | null;
    locale: Locale;
    promptTemplate: string;
    promptVersion?: string;
    logContext?: AiOperationLogContext;
  }): Promise<ResearchRoutingEvaluationResult>;
}

async function completeJson<T>(
  runtime: AnnaRuntime,
  messages: LlmCompleteInput["messages"],
  accept: (value: unknown) => T,
  logContext?: AiOperationLogContext,
): Promise<T> {
  const request: LlmCompleteInput = {
    messages,
    modelPreferences: { hints: [{ name: "google/gemini-3.8-flash" }] },
  };
  const result = await executeLlmRequest({
    runtime,
    request,
    logContext,
    timeoutMs: 600_000,
    performanceLayer: "anna-research-llm",
    accept: (rawText) => accept(parseStructuredJson<unknown>(rawText)),
  });
  return result.value;
}

function readCompletionModel(response: unknown): string | null {
  const record = response && typeof response === "object" && !Array.isArray(response)
    ? response as Record<string, unknown>
    : null;
  return typeof record?.model === "string" && record.model.trim() ? record.model : null;
}

function readCompletionUsage(response: unknown): unknown {
  const record = response && typeof response === "object" && !Array.isArray(response)
    ? response as Record<string, unknown>
    : null;
  return record?.usage ?? record?.token_usage ?? null;
}

function evaluationPrompt(input: {
  brief: string;
  requirements: PresentationRequirements;
  locale: Locale;
  promptTemplate: string;
  promptVersion?: string;
  attachmentContext?: AttachmentContext | null;
}): LlmCompleteInput["messages"] {
  const language = input.requirements.selections.output_language?.trim() || "未提供";
  const promptText = input.promptTemplate
    .replaceAll("{Simplified Chinese 或 English}", language)
    .replaceAll("{Simplified Chinese or English}", language)
    .replaceAll("{用户输入的原始 Prompt}", input.brief)
    .replaceAll("{User brief}", input.brief)
    .replaceAll("{完整的 Presentation Requirements JSON}", JSON.stringify(requirementsForPrompt(input.requirements), null, 2))
    .replaceAll("{Presentation Requirements JSON}", JSON.stringify(requirementsForPrompt(input.requirements), null, 2));
  if (input.promptVersion === "v11") {
    const attachmentSection = formatUserProvidedAttachmentContextForPrompt(input.attachmentContext, "en");
    const user = [
      promptText.trimEnd(),
      currentDatePromptLine(),
      ...(attachmentSection ? [attachmentSection] : []),
    ].join("\n\n");
    return [
      { role: "system", content: { type: "text", text: RESEARCH_RECOMMENDATION_JSON_ONLY } },
      { role: "user", content: { type: "text", text: user } },
    ];
  }
  return [{ role: "user", content: { type: "text", text: promptText } }];
}

function evaluationRetryReason(attempt: LlmRequestAttempt): "invocation" | "json_format" | "schema" {
  if (attempt.failure_kind === "request") return "invocation";
  if (attempt.failure_kind === "response_validation" && attempt.errors.some((error) => /JSON|parse/iu.test(error))) {
    return "json_format";
  }
  return "schema";
}

function normalizeResearchRecommendation(value: unknown): PresentationResearchRequirements {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const choice = (key: "web" | "images") => {
    const raw = record[key] && typeof record[key] === "object" && !Array.isArray(record[key])
      ? record[key] as Record<string, unknown>
      : {};
    if (typeof raw.recommended !== "boolean") throw new Error(`Research recommendation ${key}.recommended must be boolean.`);
    const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
    if (!reason) throw new Error(`Research recommendation ${key}.reason must be non-empty.`);
    return { recommended: raw.recommended, reason, enabled: raw.recommended };
  };
  return { web: choice("web"), images: choice("images") };
}

export function createResearchAiClient(runtime: AnnaRuntime): ResearchAiClient {
  return {
    async recommendResearch(input) {
      const recommendationLanguage = pickLocale(input.locale, RESEARCH_REASON_LANGUAGE);
      const attachmentSection = formatUserProvidedAttachmentContextForPrompt(input.attachmentContext, "en");
      const userPrompt = [
        "Decide whether NEW external Web or image research is genuinely required.",
        [
          "Do not recommend research only because:",
          "- the presentation mentions a known company, product, person, or place;",
          "- comparisons, examples, or visuals might be helpful;",
          "- the user asks for a polished or visually impressive presentation;",
          "- additional information could make the presentation more detailed;",
          "- images could be used decoratively;",
          "- the topic is broad or the brief is short.",
        ].join("\n"),
        "Recommend Web only when the user's requested result depends on missing current, external, or verifiable facts.",
        "Recommend images only when the request depends on actual real-world visual material rather than generated diagrams, illustrations, icons, or decorative graphics.",
        "Default to false when the need is optional or uncertain. Evaluate Web and images independently.",
        currentDatePromptLine(),
        "Use this date to determine whether an event is past, ongoing, a future plan, or a hypothetical scenario.",
        "Return concise reasons in the requested interface language.",
        `Recommendation reason language: ${recommendationLanguage}`,
        `User brief:\n${input.brief}`,
        `Presentation requirements draft:\n${JSON.stringify(requirementsForPrompt(input.requirements), null, 2)}`,
        ...(attachmentSection ? [attachmentSection] : []),
      ].join("\n\n");
      try {
        return await completeJson(runtime, [
          { role: "system", content: { type: "text", text: RESEARCH_RECOMMENDATION_JSON_ONLY } },
          { role: "user", content: { type: "text", text: userPrompt } },
        ], normalizeResearchRecommendation, input.logContext);
      } catch (error) {
        if (!(error instanceof LlmRequestExecutionError)) throw error;
        // 推荐失败不阻断需求生成，用户仍可在需求确认时调整搜索选择。
        return {
          web: { recommended: false, enabled: false, reason: "" },
          images: { recommended: false, enabled: false, reason: "" },
        };
      }
    },

    async recommendResearchForEvaluation(input) {
      const startedAt = performance.now();
      const request: LlmCompleteInput = {
        messages: evaluationPrompt(input),
      };
      const result = await executeLlmRequest({
        runtime,
        request,
        logContext: input.logContext,
        timeoutMs: 600_000,
        performanceLayer: "anna-research-llm-evaluation",
        accept: (rawText) => normalizeResearchRecommendation(parseStructuredJson<unknown>(rawText)),
      });
      const failedAttempts = result.attempts.filter((attempt) => attempt.status === "retry");
      const successfulAttempt = result.attempts.find((attempt) => attempt.status === "success");
      return {
        research: result.value,
        actual_model: readCompletionModel(successfulAttempt?.raw_response),
        token_usage: readCompletionUsage(successfulAttempt?.raw_response),
        latency_ms: Math.round(performance.now() - startedAt),
        json_repair_count: failedAttempts.filter((attempt) => evaluationRetryReason(attempt) === "json_format").length,
        retry_count: failedAttempts.length,
        retry_reasons: failedAttempts.map(evaluationRetryReason),
      };
    },
  };
}
