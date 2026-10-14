export const DEFAULT_AGENT_SAME_SESSION_RETRIES = 2;
export const DEFAULT_AGENT_FRESH_SESSION_RETRIES = 2;

export type AgentSessionRetryMode = "initial" | "same_session" | "fresh_session";
export type AgentSessionAttemptStatus = "success" | "retry" | "error";

export interface AgentSessionAttemptContext {
  logical_attempt: number;
  session_attempt: number;
  same_session_retry_count: number;
  fresh_session_retry_count: number;
  retry_mode: AgentSessionRetryMode;
}

export interface AgentSessionHandle<RunOptions = unknown> {
  run(prompt: string, options?: RunOptions, attempt?: AgentSessionAttemptContext): Promise<string>;
  close(): Promise<void>;
}

export interface AgentSessionAttempt<RunOptions = unknown> {
  logical_attempt: number;
  session_attempt: number;
  same_session_retry_count: number;
  fresh_session_retry_count: number;
  retry_mode: AgentSessionRetryMode;
  status: AgentSessionAttemptStatus;
  prompt: string;
  raw_text?: string;
  error?: unknown;
  will_retry: boolean;
  run_options?: RunOptions;
}

export class AgentSessionResponseValidationError extends Error {
  constructor(
    message: string,
    public readonly rawText: string,
    public readonly attempts: AgentSessionAttempt[],
    public readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "AgentSessionResponseValidationError";
  }
}

export class AgentSessionExecutionError extends Error {
  constructor(
    message: string,
    public readonly attempts: AgentSessionAttempt[],
    public readonly lastError: unknown,
  ) {
    super(message, { cause: lastError });
    this.name = "AgentSessionExecutionError";
  }
}

export interface ExecuteAgentSessionInput<T, RunOptions = unknown> {
  initialPrompt: string;
  runOptions?: RunOptions;
  runOptionsForAttempt?: (input: {
    retryMode: AgentSessionRetryMode;
    logicalAttempt: number;
    sameSessionRetryCount: number;
    freshSessionRetryCount: number;
  }) => RunOptions | undefined;
  createSession: () => Promise<AgentSessionHandle<RunOptions>>;
  accept: (rawText: string) => T | Promise<T>;
  buildSameSessionRepairPrompt?: (input: {
    rawText: string;
    error: unknown;
    retryNumber: number;
  }) => string;
  /** Route response validation failures through a fresh Session. */
  retryValidationInFreshSession?: boolean;
  maxSameSessionRetries?: number;
  maxFreshSessionRetries?: number;
  isCancellationError?: (error: unknown) => boolean;
  onAttempt?: (attempt: AgentSessionAttempt<RunOptions>) => void | Promise<void>;
}

export interface ExecuteAgentSessionResult<T, RunOptions = unknown> {
  value: T;
  attempts: AgentSessionAttempt<RunOptions>[];
  sameSessionRetries: number;
  freshSessionRetries: number;
  logicalAttempts: number;
}

async function notifyAttempt<T, RunOptions>(
  callback: ExecuteAgentSessionInput<T, RunOptions>["onAttempt"],
  attempt: AgentSessionAttempt<RunOptions>,
) {
  if (!callback) return;
  try {
    await callback(attempt);
  } catch (error) {
    console.warn(
      "Failed to report Agent Session attempt",
      error instanceof Error ? error.message : error,
    );
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Executes one logical Agent request with two retry modes. By default response
 * validation failures stay in the current Session, while Session execution
 * failures create a fresh Session. Callers can route validation failures to a
 * fresh Session too. The counters are global to this logical request, so the
 * two budgets never multiply into nested retry loops.
 */
export async function executeAgentSession<T, RunOptions = unknown>(
  input: ExecuteAgentSessionInput<T, RunOptions>,
): Promise<ExecuteAgentSessionResult<T, RunOptions>> {
  const maxSameSessionRetries = Math.max(
    0,
    input.maxSameSessionRetries ?? DEFAULT_AGENT_SAME_SESSION_RETRIES,
  );
  const maxFreshSessionRetries = Math.max(
    0,
    input.maxFreshSessionRetries ?? DEFAULT_AGENT_FRESH_SESSION_RETRIES,
  );
  const isCancellationError = input.isCancellationError ?? (() => false);
  const attempts: AgentSessionAttempt<RunOptions>[] = [];
  let sameSessionRetries = 0;
  let freshSessionRetries = 0;
  let logicalAttempts = 0;
  let sessionAttempt = 0;
  let session: AgentSessionHandle<RunOptions> | null = null;
  let prompt = input.initialPrompt;
  let retryMode: AgentSessionRetryMode = "initial";
  let lastError: unknown = new Error("Agent Session request did not run.");

  const closeSession = async () => {
    const current = session;
    session = null;
    await current?.close().catch(() => undefined);
  };

  try {
    for (;;) {
      if (!session) {
        try {
          session = await input.createSession();
          sessionAttempt += 1;
        } catch (error) {
          lastError = error;
          const cancelled = isCancellationError(error);
          const canRetry = !cancelled && freshSessionRetries < maxFreshSessionRetries;
          const attempt: AgentSessionAttempt<RunOptions> = {
            logical_attempt: logicalAttempts + 1,
            session_attempt: sessionAttempt + 1,
            same_session_retry_count: sameSessionRetries,
            fresh_session_retry_count: freshSessionRetries,
            retry_mode: freshSessionRetries > 0 ? "fresh_session" : "initial",
            status: canRetry ? "retry" : "error",
            prompt: input.initialPrompt,
            error,
            will_retry: canRetry,
            run_options: input.runOptions,
          };
          attempts.push(attempt);
          await notifyAttempt(input.onAttempt, attempt);
          if (cancelled) throw error;
          if (!canRetry) {
            throw new AgentSessionExecutionError(
              `Agent Session failed after ${attempts.length} attempts: ${errorMessage(error)}`,
              attempts,
              error,
            );
          }
          freshSessionRetries += 1;
          retryMode = "fresh_session";
          continue;
        }
      }

      logicalAttempts += 1;
      let rawText = "";
      const runOptions = input.runOptionsForAttempt?.({
        retryMode,
        logicalAttempt: logicalAttempts,
        sameSessionRetryCount: sameSessionRetries,
        freshSessionRetryCount: freshSessionRetries,
      }) ?? input.runOptions;

      try {
        rawText = await session.run(prompt, runOptions, {
          logical_attempt: logicalAttempts,
          session_attempt: sessionAttempt,
          same_session_retry_count: sameSessionRetries,
          fresh_session_retry_count: freshSessionRetries,
          retry_mode: retryMode,
        });
      } catch (error) {
        lastError = error;
        const cancelled = isCancellationError(error);
        const canRetry = !cancelled && freshSessionRetries < maxFreshSessionRetries;
        const attempt: AgentSessionAttempt<RunOptions> = {
          logical_attempt: logicalAttempts,
          session_attempt: sessionAttempt,
          same_session_retry_count: sameSessionRetries,
          fresh_session_retry_count: freshSessionRetries,
          retry_mode: retryMode,
          status: canRetry ? "retry" : "error",
          prompt,
          error,
          will_retry: canRetry,
          run_options: runOptions,
        };
        attempts.push(attempt);
        await notifyAttempt(input.onAttempt, attempt);
        if (cancelled) throw error;
        if (!canRetry) {
          throw new AgentSessionExecutionError(
            `Agent Session failed after ${attempts.length} attempts: ${errorMessage(error)}`,
            attempts,
            error,
          );
        }

        freshSessionRetries += 1;
        prompt = input.initialPrompt;
        retryMode = "fresh_session";
        await closeSession();
        continue;
      }

      try {
        const value = await input.accept(rawText);
        const attempt: AgentSessionAttempt<RunOptions> = {
          logical_attempt: logicalAttempts,
          session_attempt: sessionAttempt,
          same_session_retry_count: sameSessionRetries,
          fresh_session_retry_count: freshSessionRetries,
          retry_mode: retryMode,
          status: "success",
          prompt,
          raw_text: rawText,
          will_retry: false,
          run_options: runOptions,
        };
        attempts.push(attempt);
        await notifyAttempt(input.onAttempt, attempt);
        return {
          value,
          attempts,
          sameSessionRetries,
          freshSessionRetries,
          logicalAttempts,
        };
      } catch (error) {
        lastError = error;
        if (isCancellationError(error)) throw error;
        const canRepair = Boolean(input.buildSameSessionRepairPrompt)
          && sameSessionRetries < maxSameSessionRetries;
        const canRetryInFreshSession = input.retryValidationInFreshSession === true
          && freshSessionRetries < maxFreshSessionRetries;
        const willRetry = canRepair || canRetryInFreshSession;
        const attempt: AgentSessionAttempt<RunOptions> = {
          logical_attempt: logicalAttempts,
          session_attempt: sessionAttempt,
          same_session_retry_count: sameSessionRetries,
          fresh_session_retry_count: freshSessionRetries,
          retry_mode: retryMode,
          status: willRetry ? "retry" : "error",
          prompt,
          raw_text: rawText,
          error,
          will_retry: willRetry,
          run_options: runOptions,
        };
        attempts.push(attempt);
        await notifyAttempt(input.onAttempt, attempt);
        if (!willRetry) {
          throw new AgentSessionResponseValidationError(
            `Agent Session returned an invalid response after ${attempts.length} attempts: ${errorMessage(error)}`,
            rawText,
            attempts,
            error,
          );
        }

        if (canRetryInFreshSession) {
          freshSessionRetries += 1;
          prompt = input.initialPrompt;
          retryMode = "fresh_session";
          await closeSession();
        } else {
          sameSessionRetries += 1;
          prompt = input.buildSameSessionRepairPrompt!({
            rawText,
            error,
            retryNumber: sameSessionRetries,
          });
          retryMode = "same_session";
        }
      }
    }
  } catch (error) {
    if (isCancellationError(error)) throw error;
    if (error instanceof AgentSessionExecutionError || error instanceof AgentSessionResponseValidationError) {
      throw error;
    }
    throw new AgentSessionExecutionError(
      `Agent Session failed after ${attempts.length} attempts: ${errorMessage(error)}`,
      attempts,
      lastError === undefined ? error : lastError,
    );
  } finally {
    await closeSession();
  }
}
