import type { Locale } from "../i18n/messages";
import { pickLocale } from "../i18n/locales";
import type { LlmCompleteInput, HostRuntime } from "../runtime/hostRuntime";
import type { AiOperationLogContext } from "./interactionLog";
import { executeLlmRequest, type LlmRequestAttempt } from "./llmRequestExecutor";
import { parseStructuredJson } from "./structuredJson";

export type PageRefinementTaskType =
  | "exact_text_edit"
  | "content_rewrite"
  | "style_edit"
  | "layout_edit"
  | "web_research"
  | "image_research"
  | "mixed"
  | "unclear";

export type PageRefinementExecutionScope = "local" | "regenerate" | "uncertain";

export interface PageRefinementClassification {
  task_type: PageRefinementTaskType;
  execution_scope: PageRefinementExecutionScope;
  web_research: boolean;
  image_research: boolean;
  reason: string;
}

export interface PageRefinementClassificationEvaluationResult {
  classification: PageRefinementClassification;
  actual_model: string | null;
  token_usage: unknown;
  latency_ms: number;
  json_repair_count: number;
  retry_count: number;
  retry_reasons: Array<"invocation" | "json_format" | "schema">;
}

export interface PageRefinementClassifier {
  classifyForEvaluation(input: {
    request: string;
    locale: Locale;
    promptTemplate: string;
    logContext?: AiOperationLogContext;
  }): Promise<PageRefinementClassificationEvaluationResult>;
}

const TASK_TYPES = new Set<PageRefinementTaskType>([
  "exact_text_edit", "content_rewrite", "style_edit", "layout_edit",
  "web_research", "image_research", "mixed", "unclear",
]);
const EXECUTION_SCOPES = new Set<PageRefinementExecutionScope>(["local", "regenerate", "uncertain"]);

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Classification must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function normalizeClassification(value: unknown): PageRefinementClassification {
  const record = asRecord(value);
  const taskType = record.task_type;
  const executionScope = record.execution_scope;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  if (typeof taskType !== "string" || !TASK_TYPES.has(taskType as PageRefinementTaskType)) {
    throw new Error("Classification task_type is invalid.");
  }
  if (typeof executionScope !== "string" || !EXECUTION_SCOPES.has(executionScope as PageRefinementExecutionScope)) {
    throw new Error("Classification execution_scope is invalid.");
  }
  if (typeof record.web_research !== "boolean" || typeof record.image_research !== "boolean" || !reason) {
    throw new Error("Classification response is incomplete.");
  }
  return {
    task_type: taskType as PageRefinementTaskType,
    execution_scope: executionScope as PageRefinementExecutionScope,
    web_research: record.web_research,
    image_research: record.image_research,
    reason,
  };
}

function evaluationPrompt(input: { request: string; locale: Locale; promptTemplate: string }): string {
  const language = pickLocale(input.locale, { zh: "Simplified Chinese", en: "English", ja: "Japanese", de: "German" });
  return input.promptTemplate
    .replaceAll("{Simplified Chinese 或 English}", language)
    .replaceAll("{Simplified Chinese or English}", language)
    .replaceAll("{用户输入的修改要求}", input.request)
    .replaceAll("{User page refinement request}", input.request);
}

function retryReason(attempt: LlmRequestAttempt): "invocation" | "json_format" | "schema" {
  if (attempt.failure_kind === "request") return "invocation";
  if (attempt.failure_kind === "response_validation" && attempt.errors.some((error) => /JSON|parse/iu.test(error))) {
    return "json_format";
  }
  return "schema";
}

function responseMetadata(response: unknown): { actual_model: string | null; token_usage: unknown } {
  const record = response && typeof response === "object" && !Array.isArray(response)
    ? response as Record<string, unknown>
    : null;
  return {
    actual_model: typeof record?.model === "string" && record.model.trim() ? record.model : null,
    token_usage: record?.usage ?? record?.token_usage ?? null,
  };
}

export function createPageRefinementClassifier(runtime: HostRuntime): PageRefinementClassifier {
  return {
    async classifyForEvaluation(input) {
      const startedAt = performance.now();
      const request: LlmCompleteInput = {
        messages: [{ role: "user", content: { type: "text", text: evaluationPrompt(input) } }],
      };
      const result = await executeLlmRequest({
        runtime,
        request,
        logContext: input.logContext,
        timeoutMs: 600_000,
        performanceLayer: "slideforge-page-refinement-classification-evaluation",
        accept: (rawText) => normalizeClassification(parseStructuredJson<unknown>(rawText)),
      });
      const failedAttempts = result.attempts.filter((attempt) => attempt.status === "retry");
      const successfulAttempt = result.attempts.find((attempt) => attempt.status === "success");
      return {
        classification: result.value,
        ...responseMetadata(successfulAttempt?.raw_response),
        latency_ms: Math.round(performance.now() - startedAt),
        json_repair_count: failedAttempts.filter((attempt) => retryReason(attempt) === "json_format").length,
        retry_count: failedAttempts.length,
        retry_reasons: failedAttempts.map(retryReason),
      };
    },
  };
}
