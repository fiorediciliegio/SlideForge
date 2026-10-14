import { beginPerformanceSpan } from "../performance/performanceRecorder";
import type { LlmCompleteInput, AnnaRuntime } from "../runtime/annaRuntime";
import type { AiOperationLogContext } from "./interactionLog";
import { shortLogHash } from "./interactionLog";

export const DEFAULT_LLM_MAX_ATTEMPTS = 6;
export const DEFAULT_LLM_MODEL_PREFERENCE = "google/gemini-3-flash-preview";
export const DEFAULT_LLM_RETRY_BASE_DELAY_MS = 250;
export const DEFAULT_LLM_RETRY_MAX_DELAY_MS = 2_000;
export const DEFAULT_LLM_RETRY_JITTER_RATIO = 0.2;

export type LlmAttemptFailureKind =
  | "request"
  | "empty_response"
  | "response_validation";

export interface LlmRequestAttempt {
  attempt: number;
  status: "success" | "retry" | "error";
  request: LlmCompleteInput;
  request_hash: string;
  raw_response?: unknown;
  raw_text?: string;
  failure_kind?: LlmAttemptFailureKind;
  errors: string[];
  details?: unknown;
  will_retry: boolean;
}

export class LlmResponseValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: string[] = [message],
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "LlmResponseValidationError";
  }
}

export class LlmRequestExecutionError extends Error {
  constructor(
    message: string,
    public readonly attempts: LlmRequestAttempt[],
    public readonly lastError: unknown,
  ) {
    super(message, { cause: lastError });
    this.name = "LlmRequestExecutionError";
  }
}

interface CompletionContent {
  type?: string;
  text?: string;
}

interface CompletionResult {
  content?: CompletionContent | CompletionContent[] | string;
  text?: string;
  output_text?: string;
  message?: {
    content?: CompletionContent | CompletionContent[] | string;
  };
}

export interface ExecuteLlmRequestInput<T> {
  runtime: AnnaRuntime;
  request: LlmCompleteInput;
  accept: (rawText: string, rawResponse: unknown) => T | Promise<T>;
  logContext?: AiOperationLogContext;
  maxAttempts?: number;
  timeoutMs: number;
  performanceLayer: string;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryJitterRatio?: number;
  wait?: (delayMs: number) => Promise<void>;
  random?: () => number;
  onAttempt?: (attempt: LlmRequestAttempt) => void | Promise<void>;
  /**
   * Builds the next request only when a provider returned text that failed the
   * caller's validation. Network retries intentionally keep the base request.
   */
  onValidationRetry?: (input: {
    baseRequest: LlmCompleteInput;
    attempt: LlmRequestAttempt;
  }) => LlmCompleteInput | Promise<LlmCompleteInput>;
}

export interface ExecuteLlmRequestResult<T> {
  value: T;
  attempts: LlmRequestAttempt[];
}

function cloneRequest(request: LlmCompleteInput): LlmCompleteInput {
  return {
    ...request,
    messages: request.messages.map((message) => ({
      ...message,
      content: typeof message.content === "string"
        ? message.content
        : { ...message.content },
    })),
  };
}

function extractContentText(content: CompletionResult["content"] | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => extractContentText(item)).join("");
  }
  return content?.type === "text" && typeof content.text === "string"
    ? content.text
    : "";
}

export function extractLlmCompletionText(result: unknown): string {
  if (typeof result === "string") return result;
  const completion = result as CompletionResult | null;
  if (typeof completion?.output_text === "string" && completion.output_text.trim()) {
    return completion.output_text;
  }
  if (typeof completion?.text === "string" && completion.text.trim()) {
    return completion.text;
  }
  return (
    extractContentText(completion?.content)
    || extractContentText(completion?.message?.content)
  );
}

function readErrorMessages(error: unknown): string[] {
  if (error instanceof LlmResponseValidationError) return error.errors;
  if (error && typeof error === "object" && "errors" in error) {
    const errors = (error as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      const messages = errors.filter((item): item is string => typeof item === "string");
      if (messages.length > 0) return messages;
    }
  }
  return [error instanceof Error ? error.message : String(error)];
}

function readErrorDetails(error: unknown): unknown {
  return error instanceof LlmResponseValidationError ? error.details : undefined;
}

function defaultWait(delayMs: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
}

function calculateRetryDelayMs(input: {
  retryNumber: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  random: () => number;
}) {
  const baseDelay = Math.min(
    input.baseDelayMs * 2 ** Math.max(0, input.retryNumber - 1),
    input.maxDelayMs,
  );
  const jitterOffset = (input.random() * 2 - 1) * input.jitterRatio;
  return Math.max(0, Math.round(baseDelay * (1 + jitterOffset)));
}

async function notifyAttempt(
  callback: ExecuteLlmRequestInput<unknown>["onAttempt"],
  attempt: LlmRequestAttempt,
) {
  if (!callback) return;
  try {
    await callback(attempt);
  } catch (error) {
    console.warn(
      "Failed to report LLM attempt",
      error instanceof Error ? error.message : error,
    );
  }
}

export async function executeLlmRequest<T>(
  input: ExecuteLlmRequestInput<T>,
): Promise<ExecuteLlmRequestResult<T>> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_LLM_MAX_ATTEMPTS);
  const requestSnapshot = cloneRequest({
    ...input.request,
    modelPreferences: input.request.modelPreferences ?? {
      hints: [{ name: DEFAULT_LLM_MODEL_PREFERENCE }],
    },
  });
  let nextRequestSnapshot = cloneRequest(requestSnapshot);
  const attempts: LlmRequestAttempt[] = [];
  const wait = input.wait ?? defaultWait;
  const random = input.random ?? Math.random;
  let lastError: unknown = new Error("LLM request did not run.");

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    const request = cloneRequest(nextRequestSnapshot);
    const requestHash = shortLogHash(request);
    const interactionHandle = input.logContext?.logger
      ? await input.logContext.logger.startInteraction(input.logContext, {
          request,
          extra: {
            attempt: attemptNumber,
            attempt_limit: maxAttempts,
            request_hash: requestHash,
          },
        })
      : null;
    const performanceSpan = beginPerformanceSpan({
      operationName: "ai.interaction",
      workspaceId: input.logContext?.workspace_dir.split(/[\\/]/).filter(Boolean).at(-1),
      attributes: {
        layer: input.performanceLayer,
        attempt: attemptNumber,
        attempt_limit: maxAttempts,
      },
    });

    let rawResponse: unknown;
    let rawText = "";
    try {
      rawResponse = typeof input.runtime.call === "function"
        ? await input.runtime.call("llm", "complete", request, {
            timeoutMs: input.timeoutMs,
          })
        : await input.runtime.llm.complete(request);
      rawText = extractLlmCompletionText(rawResponse);
    } catch (error) {
      lastError = error;
      const willRetry = attemptNumber < maxAttempts;
      const attempt: LlmRequestAttempt = {
        attempt: attemptNumber,
        status: willRetry ? "retry" : "error",
        request,
        request_hash: requestHash,
        failure_kind: "request",
        errors: readErrorMessages(error),
        will_retry: willRetry,
      };
      attempts.push(attempt);
      performanceSpan?.finish("error", {
        failure_kind: "request",
        will_retry: willRetry,
      });
      if (interactionHandle) {
        await input.logContext?.logger?.finishInteraction(interactionHandle, {
          status: "failed",
          error,
          extra: {
            attempt: attemptNumber,
            attempt_limit: maxAttempts,
            request_hash: requestHash,
            accepted: false,
            failure_kind: attempt.failure_kind,
            will_retry: willRetry,
          },
        });
      }
      await notifyAttempt(input.onAttempt, attempt);
      if (!willRetry) break;
      const delayMs = calculateRetryDelayMs({
        retryNumber: attemptNumber,
        baseDelayMs: input.retryBaseDelayMs ?? DEFAULT_LLM_RETRY_BASE_DELAY_MS,
        maxDelayMs: input.retryMaxDelayMs ?? DEFAULT_LLM_RETRY_MAX_DELAY_MS,
        jitterRatio: input.retryJitterRatio ?? DEFAULT_LLM_RETRY_JITTER_RATIO,
        random,
      });
      await wait(delayMs);
      continue;
    }

    try {
      if (!rawText.trim()) {
        throw new LlmResponseValidationError(
          "LLM returned an empty response.",
          ["LLM returned an empty response."],
        );
      }
      const value = await input.accept(rawText, rawResponse);
      const attempt: LlmRequestAttempt = {
        attempt: attemptNumber,
        status: "success",
        request,
        request_hash: requestHash,
        raw_response: rawResponse,
        raw_text: rawText,
        errors: [],
        will_retry: false,
      };
      attempts.push(attempt);
      performanceSpan?.finish("ok");
      if (interactionHandle) {
        await input.logContext?.logger?.finishInteraction(interactionHandle, {
          status: "succeeded",
          response: rawResponse,
          output: rawText,
          token_source: "llm",
          extra: {
            attempt: attemptNumber,
            attempt_limit: maxAttempts,
            request_hash: requestHash,
            accepted: true,
            will_retry: false,
          },
        });
      }
      await notifyAttempt(input.onAttempt, attempt);
      return { value, attempts };
    } catch (error) {
      lastError = error;
      const failureKind: LlmAttemptFailureKind = rawText.trim()
        ? "response_validation"
        : "empty_response";
      const willRetry = attemptNumber < maxAttempts;
      const attempt: LlmRequestAttempt = {
        attempt: attemptNumber,
        status: willRetry ? "retry" : "error",
        request,
        request_hash: requestHash,
        raw_response: rawResponse,
        raw_text: rawText,
        failure_kind: failureKind,
        errors: readErrorMessages(error),
        details: readErrorDetails(error),
        will_retry: willRetry,
      };
      attempts.push(attempt);
      performanceSpan?.finish("error", {
        failure_kind: failureKind,
        will_retry: willRetry,
      });
      if (interactionHandle) {
        await input.logContext?.logger?.finishInteraction(interactionHandle, {
          status: "succeeded",
          response: rawResponse,
          output: rawText,
          token_source: "llm",
          extra: {
            attempt: attemptNumber,
            attempt_limit: maxAttempts,
            request_hash: requestHash,
            accepted: false,
            failure_kind: failureKind,
            validation_errors: attempt.errors,
            will_retry: willRetry,
          },
        });
      }
      await notifyAttempt(input.onAttempt, attempt);
      if (!willRetry) break;
      if (input.onValidationRetry && failureKind === "response_validation") {
        nextRequestSnapshot = cloneRequest(await input.onValidationRetry({
          baseRequest: requestSnapshot,
          attempt,
        }));
      }
    }
  }

  const lastMessage = lastError instanceof Error ? lastError.message : String(lastError);
  throw new LlmRequestExecutionError(
    `LLM request failed after ${attempts.length} attempts: ${lastMessage}`,
    attempts,
    lastError,
  );
}
