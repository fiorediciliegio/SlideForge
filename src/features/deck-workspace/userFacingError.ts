import type { Messages } from "../../i18n/messages";

/**
 * A raw backend failure split into what a user is shown and what stays behind a
 * diagnostics disclosure. The UI renders `summary`; `detail` keeps the original
 * text so nothing is lost for troubleshooting.
 */
export interface UserFacingError {
  summary: string;
  detail: string;
}

export type UserFacingErrorKind =
  | "quotaExceeded"
  | "modelBusy"
  | "timeout"
  | "transport"
  | "notFound"
  | "network"
  | "unknown";

const MAX_DETAIL_LENGTH = 800;

export function extractErrorDetail(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  if (typeof error === "string") return error.trim();
  if (error === null || error === undefined) return "";
  try {
    return JSON.stringify(error).trim();
  } catch {
    return String(error).trim();
  }
}

/** Only tool RPC timeouts imply a potentially busy server; local timers keep their own wording. */
export function isInvokeTimeout(error: unknown): boolean {
  const detail = extractErrorDetail(error);
  return /\btools\.invoke(?:AsyncAwait)?\b/i.test(detail)
    && classifyUserFacingError(detail) === "timeout";
}

export function invokeTimeoutSummary(t: Messages, error: unknown, fallback: string): string {
  const kind = classifyUserFacingError(`${extractErrorDetail(error)} ${extractErrorCodes(error)}`);
  if (kind === "quotaExceeded") return t.errors.summaryQuotaExceeded;
  return isInvokeTimeout(error) ? t.errors.summaryInvokeTimeout : fallback;
}

function extractErrorCodes(error: unknown): string {
  const codes: string[] = [];
  const seen = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const record = current as Record<string, unknown>;
    if (seen.has(record)) break;
    seen.add(record);
    for (const key of ["code", "errorCode", "error_type"]) {
      if (typeof record[key] === "string") codes.push(record[key]);
    }
    current = record.lastError ?? record.cause ?? record.error;
  }

  return codes.join(" ");
}

export function classifyUserFacingError(detail: string): UserFacingErrorKind {
  const value = detail.toLowerCase();
  if (!value) return "unknown";
  if (/(?:app[\s_-]*quota[\s_-]*exceeded|quota[\s_-]*(?:is[\s_-]*)?(?:exhausted|exceeded)|remaining[\s_-]*cu[\"':=\s]*0(?:\.0+)?|unable to continue using slideforge service)/i.test(value)) {
    return "quotaExceeded";
  }
  // Classify model failures only at the display boundary; retain raw errors
  // for diagnostics and leave Session retry decisions unchanged.
  const modelRequest = /\b(?:agent|model|llm)\b|\bsession\.run\b/.test(value);
  if (modelRequest && /timed out|timeout|deadline exceeded|rate[ _-]?limit|too many requests|\b429\b|overloaded/.test(value)) {
    return "modelBusy";
  }
  if (/timed out|timeout|etimedout|deadline exceeded/.test(value)) return "timeout";
  if (/r2_key|does not belong to this invoke|host upload|artifact transport/.test(value)) {
    return "transport";
  }
  if (/enoent|no such file|not found|does not exist/.test(value)) return "notFound";
  if (/fetch failed|econnrefused|econnreset|network error|socket hang up|offline/.test(value)) {
    return "network";
  }
  return "unknown";
}

/**
 * True for payloads that must never reach the user interface verbatim, such as
 * a full JSON-RPC envelope or a stringified stack trace.
 */
export function isOpaqueErrorDetail(detail: string): boolean {
  const value = detail.trim();
  if (!value) return true;
  if (/^[[{]/.test(value) && /"(jsonrpc|error|code|result|id)"\s*:/.test(value)) return true;
  if (/\n\s+at\s/.test(value)) return true;
  return value.length > 240;
}

export function summarizeUserFacingError(
  t: Messages,
  error: unknown,
  fallbackSummary?: string,
): UserFacingError {
  const detail = extractErrorDetail(error).slice(0, MAX_DETAIL_LENGTH);
  const kind = classifyUserFacingError(`${detail} ${extractErrorCodes(error)}`);
  const generic = fallbackSummary ?? t.errors.summaryUnknown;

  const summary = kind === "unknown"
    ? (isOpaqueErrorDetail(detail) ? generic : detail)
    : t.errors[summaryKeyOf(kind)];

  return { summary: invokeTimeoutSummary(t, error, summary), detail };
}

function summaryKeyOf(kind: Exclude<UserFacingErrorKind, "unknown">) {
  switch (kind) {
    case "quotaExceeded":
      return "summaryQuotaExceeded" as const;
    case "modelBusy":
      return "summaryModelBusy" as const;
    case "timeout":
      return "summaryTimeout" as const;
    case "transport":
      return "summaryTransport" as const;
    case "notFound":
      return "summaryNotFound" as const;
    case "network":
      return "summaryNetwork" as const;
  }
}
