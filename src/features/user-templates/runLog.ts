/** Structured run log for one template-creation workflow (diagnostics).
 *
 * The online deployment only surfaces frontend logs, so the workflow records
 * every LLM/agent call (stage, prompt size, duration, result, error message)
 * into this portable shape. On failure the log is shown in the error panel,
 * copyable with one click, and persisted to localStorage so it survives a
 * page refresh during online debugging.
 */

export type RunLogResult = "ok" | "error" | "aborted";
export type RunLogOutcome = "success" | "error" | "aborted";

export interface RunLogEntry {
  stage: string;
  label: string;
  started_at: string;
  duration_ms: number;
  result: RunLogResult;
  /** Error message, empty-completion notes, retry counts, etc. */
  detail?: string;
  /** Small scalar context: prompt_chars, attachments, page_number, retries… */
  meta?: Record<string, string | number | boolean | undefined>;
  /** Streamed agent event frames for this entry (live-filled via createFrameCollector). */
  frames?: RunFrame[];
}

export interface RunLog {
  started_at: string;
  finished_at?: string;
  template_id?: string;
  /** Routing hint sent to the Host for this run (the Host may override it). */
  model_preference?: string;
  entries: RunLogEntry[];
  outcome?: RunLogOutcome;
  error?: string;
  error_kind?: RunErrorKind;
  /** Host/environment facts captured at run start (engine version, UA, locale…). */
  environment?: Record<string, string>;
}

export function createRunLog(): RunLog {
  return { started_at: new Date().toISOString(), entries: [] };
}

export function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name;
  return String(cause);
}

/** Coarse classification so a glance at the log reveals the failure category. */
export type RunErrorKind = "empty_completion" | "timeout" | "parse" | "cancelled" | "network" | "unknown";
export function classifyRunError(detail: string | undefined): RunErrorKind {
  const text = detail ?? "";
  if (/no assistant message|without producing any output|empty completion/i.test(text)) return "empty_completion";
  if (/timed?\s*out|timeout|超时/i.test(text)) return "timeout";
  if (/invalid response|解析失败|parse|validation/i.test(text)) return "parse";
  if (/abort|cancel/i.test(text)) return "cancelled";
  // Browser-level fetch failures (CORS preflight, proxy/VPN drops, DNS) all
  // surface as "Failed to fetch" — one bucket so users check the network first.
  if (/failed to fetch|network request failed|err_connection|err_name_not_resolved|err_internet|fetch failed/i.test(text)) return "network";
  return "unknown";
}

/** One streamed agent event frame, summarized for diagnostics. */
export interface RunFrame {
  /** Milliseconds since the workflow run started. */
  offset_ms: number;
  type: string;
  summary: string;
  /** Platform run id active when this frame arrived (for server-side log lookup). */
  run_id?: string;
}

/** Structural shape of agentClient AgentStreamEvent (declared locally to avoid a cycle). */
export type StreamEventLike = {
  type: "content" | "activity" | "error" | "complete";
  text?: string;
  message?: string;
  tool?: string;
  path?: string;
  size?: number;
  code?: string;
  expired?: boolean;
  usage?: unknown;
  diagnosticOnly?: boolean;
};

const FRAME_SUMMARY_MAX_CHARS = 500;
const FRAMES_PER_ENTRY_MAX = 500;
const RAW_FRAME_MAX_CHARS = 1000;
const RAW_FRAME_STRING_MAX_CHARS = 200;

/** Raw wire frame (event stream.rpc payload) rendered for diagnostics:
 *  every string value truncated, whole frame capped. Never throws. */
export function summarizeRawFrame(frame: unknown): string {
  const truncate = (value: string) => (value.length > RAW_FRAME_STRING_MAX_CHARS ? `${value.slice(0, RAW_FRAME_STRING_MAX_CHARS)}…(${value.length}c)` : value);
  try {
    const text = JSON.stringify(frame, (_key, value: unknown) => (typeof value === "string" ? truncate(value) : value));
    return (text ?? String(frame)).slice(0, RAW_FRAME_MAX_CHARS);
  } catch {
    return String(frame).slice(0, RAW_FRAME_MAX_CHARS);
  }
}

export function summarizeStreamEvent(event: StreamEventLike): string {
  switch (event.type) {
    case "content":
      return `content: ${(event.text ?? "").slice(0, FRAME_SUMMARY_MAX_CHARS)}`;
    case "activity": {
      const parts = [event.tool, event.path, event.size !== undefined ? `${event.size}B` : undefined].filter(Boolean).join(" ");
      const prefix = event.diagnosticOnly ? "activity(diagnostic)" : "activity";
      return parts ? `${prefix}: ${parts} ${(event.message ?? "").slice(0, 200)}`.trim() : `${prefix}: ${(event.message ?? "").slice(0, FRAME_SUMMARY_MAX_CHARS)}`;
    }
    case "error":
      return `error: code=${event.code ?? "-"} expired=${event.expired === true} ${(event.message ?? "").slice(0, FRAME_SUMMARY_MAX_CHARS)}`.trim();
    case "complete":
      return `complete: usage=${JSON.stringify(event.usage ?? null).slice(0, 200)}`;
    default:
      return String(event.type);
  }
}

/** Build a callback that appends summarized stream frames to `frames` (capped).
 *  `runIdHolder` is read per frame, so a platform run-id rotation is stamped on
 *  subsequent frames without rebuilding the collector. */
export function createFrameCollector(runStartMs: number, frames: RunFrame[], maxFrames = FRAMES_PER_ENTRY_MAX, runIdHolder?: { run_id?: string }): (event: StreamEventLike) => void {
  return (event) => {
    if (frames.length >= maxFrames) return;
    frames.push({ offset_ms: Date.now() - runStartMs, type: event.type, summary: summarizeStreamEvent(event), run_id: runIdHolder?.run_id });
  };
}

/** Best-effort host/environment facts; safe outside the browser (tests). */
export function captureRunEnvironment(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...extra };
  try {
    if (typeof navigator !== "undefined" && navigator) {
      env.ua = navigator.userAgent.slice(0, 300);
      env.language = navigator.language;
    }
    if (typeof location !== "undefined" && location) env.origin = location.origin;
    try { env.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* ignore */ }
  } catch { /* diagnostics must never throw */ }
  return env;
}

/** Run `task`, recording one log entry. Errors are logged then rethrown. */
export async function runLogged<T>(
  log: RunLog,
  entry: { stage: string; label: string; meta?: RunLogEntry["meta"]; frames?: RunFrame[] },
  task: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const meta = { model: log.model_preference, ...entry.meta };
  try {
    const value = await task();
    log.entries.push({ stage: entry.stage, label: entry.label, started_at: new Date(startedAt).toISOString(), duration_ms: Date.now() - startedAt, result: "ok", meta, frames: entry.frames });
    return value;
  } catch (cause) {
    const aborted = cause instanceof DOMException && cause.name === "AbortError";
    const detail = describeError(cause).slice(0, 1000);
    log.entries.push({ stage: entry.stage, label: entry.label, started_at: new Date(startedAt).toISOString(), duration_ms: Date.now() - startedAt, result: aborted ? "aborted" : "error", detail, meta: { ...meta, kind: classifyRunError(detail) }, frames: entry.frames });
    throw cause;
  }
}

export function finishRunLog(log: RunLog, outcome: RunLogOutcome, error?: string): RunLog {
  log.outcome = outcome;
  // First finish wins: a later finish (e.g. a late success overwriting an error
  // outcome) must not move finished_at, or run durations shift under retries.
  log.finished_at ??= new Date().toISOString();
  if (error) {
    log.error = error.slice(0, 2000);
    log.error_kind = classifyRunError(log.error);
  }
  return log;
}

/** Human-readable plain-text rendering for copy/paste bug reports. */
export function formatRunLog(log: RunLog): string {
  const lines: string[] = [];
  lines.push(`# Template run log`);
  lines.push(`started_at: ${log.started_at}`);
  if (log.finished_at) lines.push(`finished_at: ${log.finished_at}`);
  if (log.template_id) lines.push(`template_id: ${log.template_id}`);
  if (log.model_preference) lines.push(`model_preference: ${log.model_preference} (hint only; the Host may route to another model)`);
  if (log.outcome) lines.push(`outcome: ${log.outcome}`);
  if (log.error) lines.push(`error: ${log.error}`);
  if (log.error_kind) lines.push(`error_kind: ${log.error_kind}`);
  for (const [key, value] of Object.entries(log.environment ?? {})) {
    lines.push(`env.${key}: ${value}`);
  }
  for (const entry of log.entries) {
    const meta = entry.meta ? ` ${Object.entries(entry.meta).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${String(value)}`).join(" ")}` : "";
    const detail = entry.detail ? ` — ${entry.detail}` : "";
    lines.push(`[${entry.started_at}] ${entry.stage}/${entry.label}: ${entry.result} in ${entry.duration_ms}ms${meta}${detail}`);
    for (const frame of entry.frames ?? []) {
      lines.push(`  +${frame.offset_ms}ms${frame.run_id ? ` [${frame.run_id}]` : ""} ${frame.summary}`);
    }
  }
  return lines.join("\n");
}

const STORAGE_KEY = "slideforge.user-templates.run-log";

export interface StoredRunLog { saved_at: string; log: RunLog }

/** Best-effort persistence: never throws, storage full/quota errors are ignored. */
export function persistRunLog(storage: Pick<Storage, "setItem" | "getItem"> | null | undefined, log: RunLog): void {
  if (!storage) return;
  try {
    const previous = loadRunLogs(storage);
    const next = [{ saved_at: new Date().toISOString(), log }, ...previous].slice(0, 5);
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch { /* diagnostics must never break the workflow */ }
}

export function loadRunLogs(storage: Pick<Storage, "getItem"> | null | undefined): StoredRunLog[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredRunLog[];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
