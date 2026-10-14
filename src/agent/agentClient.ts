import { createSessionRunTrace, diagnosticId, sessionIdentifiers, traceSessionEvent, type SessionRunTrace, type SessionTraceContext } from "./sessionTrace";
import { pickLocale } from "../i18n/locales";
import type {
  AgentImageAttachment,
  HostAgentSession,
  HostRuntime,
} from "../runtime/hostRuntime";
import { beginPerformanceSpan } from "../performance/performanceRecorder";
import {
  AGENT_TOOLS_UNAVAILABLE_MESSAGE,
  getAgentToolAccessWarning,
  type AgentToolAccessWarning,
} from "./agentToolAccess";
import {
  DEFAULT_AGENT_TOOL_ACCESS_POLICY,
  type AgentToolAccessPolicy,
} from "./agentToolAccessPolicy";
import {
  buildStructuredJsonRepairPrompt,
  parseStructuredJson,
} from "../ai/structuredJson";
import type { AiOperationLogContext } from "../ai/interactionLog";
import type { Locale } from "../i18n/messages";

export const HTML_GENERATION_SYSTEM_PROMPT = `你是 SlideForge 的 HTML 演示页面生成 Agent（代理）。你只负责当前页，需要根据用户整体 Brief、当前页大纲、整套演示描述、全局视觉母版、主导美学参考、Web 研究资料、图片目录，以及可选的原始 HTML 和修改意见，生成或精修当前页。

【事实边界，优先级最高】
1. 只能使用本次输入明确提供的信息，包括 Brief、当前页内容和 Web 研究资料；不得依赖模型记忆、联网搜索、常识补全或自行创作新的日期、数字、人物、机构、地点、事件、因果、预测和来源。
2. Web 研究资料必须保留原文的来源归属和确定性，不得把推测写成事实。
3. 没有输入明确支持的事实性内容应省略或标记为“待补充”。
4. 只能使用图片目录中的 file_path，并逐字符复制，禁止猜测或改写路径。
5. 输出前静默复核一次。
6. 研究资料、附件或大纲中的数据若带有日期、月份、季度、样本期、统计区间、截至日期或具体时点，必须在页面中显式标注对应时间，并在相关数据或结论附近保留。
7. 不得把带有历史或限定时间范围的数据呈现成没有时间限定的“当前数据”或“最新数据”。

【输出约束】
- 只输出一个完整、可运行的 HTML 文档，不要输出 Markdown 代码块、解释或其他文字。
- 文档只能包含一个 .slide 根容器，宽高必须严格遵守当前任务指定的画布尺寸。
- 遵守全局视觉母版，只修改当前页允许编辑的区域。
- 不写磁盘文件，不自行读取或引入未提供的资料。`;
import {
  DEFAULT_AGENT_FRESH_SESSION_RETRIES,
  DEFAULT_AGENT_SAME_SESSION_RETRIES,
  AgentSessionExecutionError,
  AgentSessionResponseValidationError,
  executeAgentSession,
  type AgentSessionAttempt,
  type AgentSessionAttemptContext,
  type AgentSessionHandle,
} from "./agentSessionExecutor";
export {
  DEFAULT_AGENT_FRESH_SESSION_RETRIES,
  DEFAULT_AGENT_SAME_SESSION_RETRIES,
  AgentSessionExecutionError,
  AgentSessionResponseValidationError,
  executeAgentSession,
} from "./agentSessionExecutor";
export type {
  AgentSessionAttemptStatus,
  AgentSessionAttempt,
  AgentSessionAttemptContext,
  AgentSessionHandle,
  AgentSessionRetryMode,
  ExecuteAgentSessionInput,
  ExecuteAgentSessionResult,
} from "./agentSessionExecutor";
import {
  guardStreamLiveness,
  isStreamCancelledError,
  isStreamIdleTimeoutError,
} from "./streamLivenessGuard";

import { createStreamDiagnostics, type StreamDiagnostics, type StreamExitReason } from "./streamDiagnostics";

const AGENT_RUN_TIMEOUT_MS = 600_000;
const AGENT_STREAM_IDLE_TIMEOUT_MS = 180_000;
/** Hot-switch companion to the model preference: raise the stream idle budget
 *  when the upstream provider is slow (e.g. long time-to-first-token):
 *  localStorage.setItem("slideforge.agent.idle-timeout-ms", "600000") */
const STREAM_IDLE_TIMEOUT_STORAGE_KEY = "slideforge.agent.idle-timeout-ms";
function resolveStreamIdleTimeoutMs(override?: number): number {
  if (override) return override;
  try {
    const stored = Number(globalThis.localStorage?.getItem(STREAM_IDLE_TIMEOUT_STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= 30_000 && stored <= 1_800_000) return stored;
  } catch { /* storage unavailable — fall through */ }
  return AGENT_STREAM_IDLE_TIMEOUT_MS;
}
const DEFAULT_AGENT_SESSION_EXPIRES_IN_SECONDS = 600;
const DEFAULT_AGENT_SESSION_ALLOWED_TOOLS = ["fs_read_file", "fs_write_file"] as const;
export const AGENT_SESSION_MODEL_PREFERENCE = "google/gemini-3.8-flash";
/** Hot-switch hook for local diagnosis: read per-run so the console can
 *  redirect the next Session without a rebuild. Short aliases keep the
 *  console one-liner friendly:
 *  localStorage.setItem("slideforge.agent.model-preference", "gemini" | "kimi" | "<full/model-name>") */
const MODEL_PREFERENCE_STORAGE_KEY = "slideforge.agent.model-preference";
const MODEL_PREFERENCE_ALIASES: Record<string, string> = {
  gemini: "google/gemini-3.8-flash",
  kimi: "moonshotai/kimi-k2.6",
};
export function resolveAgentModelPreference(explicit?: string): string {
  const pick = (value?: string | null) => {
    const name = value?.trim();
    if (!name) return undefined;
    return MODEL_PREFERENCE_ALIASES[name.toLowerCase()] ?? name;
  };
  const resolved = pick(explicit) ?? (() => {
    try { return pick(globalThis.localStorage?.getItem(MODEL_PREFERENCE_STORAGE_KEY)); }
    catch { return undefined; /* storage unavailable (SSR/private mode) */ }
  })();
  return resolved ?? AGENT_SESSION_MODEL_PREFERENCE;
}

export interface AgentRunSummary {
  status: "ready_for_render" | "blocked";
  changed_files: string[];
  files_read: string[];
  authoring_kit_sources_read: string[];
  summary: string;
  needs_render: boolean;
  notes: string[];
  raw_text?: string;
  parsed_json?: boolean;
  same_session_retries?: number;
  fresh_session_retries?: number;
  logical_attempts?: number;
}

export interface AgentPageVisualReviewResult {
  changed: boolean;
  blocked: boolean;
  summary: string;
  same_session_retries?: number;
  fresh_session_retries?: number;
  logical_attempts?: number;
}

export interface AgentHtmlGenerationResult {
  html: string;
  raw_text: string;
  content_attempts: number;
  same_session_retries: number;
  fresh_session_retries: number;
  logical_attempts: number;
}

export interface AgentSessionCreationOptions {
  /** Rebuilds the initial context when a fresh Session is needed. */
  freshPrompt?: () => string;
  /** Rebuilds attachments and other run-scoped input for the fresh prompt. */
  freshRunOptions?: () => AgentRunOptions | undefined;
  /** Lets a held-session owner persist its fresh-session attempt counter. */
  onFreshSession?: () => void;
  /** Lets a higher-level executor own the fresh-session retry budget. */
  manageFreshSessionRetries?: boolean;
}

export interface AgentClient {
  runStructuredPrompt<T>(prompt: string, validate: (value: unknown) => T, options?: AgentRunOptions): Promise<T>;
  checkToolAccess(): Promise<void>;
  runAuthoringPrompt(prompt: string, options?: AgentRunOptions): Promise<AgentRunSummary>;
  runPageVisualReviewPrompt(prompt: string, options?: AgentRunOptions): Promise<AgentPageVisualReviewResult>;
  runHtmlGenerationPrompt(prompt: string, options?: AgentRunOptions, systemPrompt?: string): Promise<AgentHtmlGenerationResult>;
  createOutlineSession(systemPrompt: string, options?: AgentSessionCreationOptions): Promise<AgentOutlineSession>;
  createImageResearchSession(systemPrompt: string, options?: AgentSessionCreationOptions): Promise<AgentImageResearchSession>;
  createWebResearchSession(systemPrompt: string, options?: AgentSessionCreationOptions): Promise<AgentWebResearchSession>;
  cancelActiveRuns(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentWebResearchSession {
  run(prompt: string, options: AgentRunOptions): Promise<string>;
  restartFreshSession(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentOutlineSession {
  run(prompt: string, options: AgentRunOptions): Promise<string>;
  close(): Promise<void>;
}

export interface AgentImageResearchSession {
  run(prompt: string, options: AgentRunOptions): Promise<string>;
  restartFreshSession(): Promise<void>;
  close(): Promise<void>;
}

export type AgentStreamEvent =
  | { type: "content"; text: string }
  | { type: "activity"; message: string; tool?: string; path?: string; size?: number; diagnosticOnly?: boolean }
  | { type: "error"; message: string; code?: string; expired?: boolean }
  | { type: "complete"; usage?: unknown };

export interface AgentRunOptions {
  attachments?: AgentImageAttachment[];
  onStreamEvent?: (event: AgentStreamEvent) => void;
  signal?: AbortSignal;
  isCancelled?: () => boolean;
  logContext?: AiOperationLogContext;
  sessionTrace?: SessionTraceContext;
  drainOnCancel?: boolean;
  toolAccessPolicy?: AgentToolAccessPolicy;
  /**
   * Per-run Agent tool allowlist. Omit this for the default, filesystem-only
   * authoring session. Callers that need a specialized tool must opt in here.
   */
  sessionTools?: readonly string[];
  /** Run-scoped routing preference; the Host may still select another permitted model. */
  modelPreference?: string;
  /** Secondary sink for technical diagnostic activity (retries, frame details) the UI hides from progress. */
  onDiagnosticStreamEvent?: (event: AgentStreamEvent) => void;
  /** Fired when the host assigns a run id mid-stream. */
  onRunId?: (runId: string) => void;
  /** Fired with every raw wire frame for run-log diagnostics. */
  onRawFrame?: (frame: unknown) => void;
}

export interface AgentClientOptions {
  runTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  toolAccessPolicy?: AgentToolAccessPolicy;
  locale?: Locale;
}

interface CollectedAgentRun {
  exitReason: StreamExitReason;
  text: string;
  events: AgentStreamEvent[];
}

/** Per-run timing segments. The gap between runStartedAt and firstFrameAt is
 *  the provider queue (invisible server-side); firstFrameAt to firstContentAt
 *  is time-to-first-token; the remainder is generation. */
interface RunTiming {
  runStartedAt: number;
  firstFrameAt?: number;
  firstContentAt?: number;
  finishedAt?: number;
}

function readFinishReason(usage: unknown): string {
  if (!usage || typeof usage !== "object") return "";
  const record = usage as Record<string, unknown>;
  const reason = record.finish_reason ?? record.finishReason;
  return typeof reason === "string" ? reason : "";
}

function describeRunTiming(timing: RunTiming, meta: { outcome: string; exitReason: string; frameCount: number; contentChars: number; usage: unknown }): string {
  const finishedAt = timing.finishedAt ?? Date.now();
  const firstFrameMs = timing.firstFrameAt === undefined ? "" : ` first_frame=+${timing.firstFrameAt - timing.runStartedAt}ms`;
  const firstContentMs = timing.firstContentAt === undefined ? "" : ` first_content=+${timing.firstContentAt - timing.runStartedAt}ms`;
  const generationMs = timing.firstFrameAt === undefined ? "" : ` generation=${finishedAt - timing.firstFrameAt}ms`;
  const finishReason = readFinishReason(meta.usage);
  return `run.timing: outcome=${meta.outcome} exit=${meta.exitReason} total=${finishedAt - timing.runStartedAt}ms` +
    `${firstFrameMs}${firstContentMs}${generationMs} frames=${meta.frameCount} content_chars=${meta.contentChars}` +
    `${finishReason ? ` finish_reason=${finishReason}` : ""}`;
}

class AgentRunStreamError extends Error {
  constructor(
    message: string,
    public readonly expired = false,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AgentRunStreamError";
  }
}

export class AgentInfrastructureError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly activeSessionLimit = false,
    public readonly rawMessage?: string,
    public readonly noToolsAvailable = false,
  ) {
    super(message);
    this.name = "AgentInfrastructureError";
  }
}

export function isAgentInfrastructureError(error: unknown): error is AgentInfrastructureError {
  return error instanceof AgentInfrastructureError;
}

export class AgentRunCancelledError extends Error {
  constructor() {
    super("Agent run cancelled");
    this.name = "AgentRunCancelledError";
  }
}

class AgentRunTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Agent run timed out after ${timeoutMs}ms`);
    this.name = "AgentRunTimeoutError";
  }
}

export function isAgentRunCancelledError(error: unknown): error is AgentRunCancelledError {
  return error instanceof AgentRunCancelledError;
}

export function parseJsonObject<T>(text: string, label: string): T {
  try {
    return parseStructuredJson<T>(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Raw preview turns user-pasted run logs into self-sufficient bug
    // reports: without it, a parse failure is undiagnosable remotely.
    const preview = text.slice(0, 300).replace(/\s+/g, " ").trim();
    const tail = text.length > 300 ? ` …(total ${text.length} chars)` : "";
    throw new Error(`Failed to parse Agent ${label} JSON: ${message} | raw: "${preview}${tail}"`);
  }
}

function normalizeRunSummary(value: unknown): AgentRunSummary {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Partial<AgentRunSummary>)
    : {};
  const status = record.status === "blocked" ? "blocked" : "ready_for_render";

  return {
    status,
    changed_files: Array.isArray(record.changed_files)
      ? record.changed_files.filter((item): item is string => typeof item === "string")
      : [],
    files_read: Array.isArray(record.files_read)
      ? record.files_read.filter((item): item is string => typeof item === "string")
      : [],
    authoring_kit_sources_read: Array.isArray(record.authoring_kit_sources_read)
      ? record.authoring_kit_sources_read.filter((item): item is string => typeof item === "string")
      : [],
    summary: typeof record.summary === "string" ? record.summary : "",
    needs_render:
      typeof record.needs_render === "boolean" ? record.needs_render : status !== "blocked",
    notes: Array.isArray(record.notes)
      ? record.notes.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function fallbackRunSummary(
  text: string,
  retryCounts: { sameSessionRetries?: number; freshSessionRetries?: number; logicalAttempts?: number } = {},
): AgentRunSummary {
  return {
    status: "ready_for_render",
    changed_files: [],
    files_read: [],
    authoring_kit_sources_read: [],
    summary: text.trim().slice(0, 500),
    needs_render: true,
    notes: [],
    raw_text: text,
    parsed_json: false,
    same_session_retries: retryCounts.sameSessionRetries,
    fresh_session_retries: retryCounts.freshSessionRetries,
    logical_attempts: retryCounts.logicalAttempts,
  };
}

function normalizeCollectedAuthoringRun(collected: {
  text: string;
  sameSessionRetries?: number;
  freshSessionRetries?: number;
  logicalAttempts?: number;
}): AgentRunSummary {
  try {
    return {
      ...normalizeRunSummary(parseJsonObject(collected.text, "authoring summary")),
      raw_text: collected.text,
      parsed_json: true,
      same_session_retries: collected.sameSessionRetries,
      fresh_session_retries: collected.freshSessionRetries,
      logical_attempts: collected.logicalAttempts,
    };
  } catch {
    return fallbackRunSummary(
      collected.text,
      {
        sameSessionRetries: collected.sameSessionRetries,
        freshSessionRetries: collected.freshSessionRetries,
        logicalAttempts: collected.logicalAttempts,
      },
    );
  }
}

function normalizePageVisualReview(value: unknown): AgentPageVisualReviewResult {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Partial<AgentPageVisualReviewResult>)
    : {};
  return {
    changed: record.changed === true,
    blocked: record.blocked === true,
    summary: typeof record.summary === "string" ? record.summary : "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function extractSingleCompleteHtml(text: string): string {
  const completeDocuments = (value: string) => {
    const matches = value.match(/(?:<!doctype\s+html[^>]*>\s*)?<html\b[^>]*>[\s\S]*?<\/html\s*>/gi) ?? [];
    return matches.map((item) => item.trim());
  };
  const fenced = [...text.matchAll(/```html\s*([\s\S]*?)```/gi)]
    .flatMap((match) => completeDocuments(match[1] ?? ""));
  const candidates = fenced.length > 0 ? fenced : completeDocuments(text);
  if (candidates.length === 0) throw new Error("找不到完整 HTML");
  if (candidates.length > 1) throw new Error("多个完整 HTML");
  return candidates[0];
}

/**
 * Returns the newest document fragment from an HTML-producing Agent stream.
 * The fragment deliberately does not need a closing </html>: browsers can
 * paint the completed portion while the Agent is still writing the rest.
 * Keeping this separate from `extractSingleCompleteHtml` means the persisted
 * page still has the existing, strict complete-document gate.
 */
export function extractLatestHtmlPreview(text: string): string | null {
  const matches = [...text.matchAll(/(?:<!doctype\s+html[^>]*>\s*)?<html\b[^>]*>/gi)];
  const latest = matches.at(-1);
  if (latest?.index === undefined) return null;

  // A retry in the same Agent session starts a new document. Only preview the
  // newest one, rather than leaving the failed attempt on screen.
  const fragment = text.slice(latest.index);
  const fenceEnd = fragment.indexOf("```");
  const html = (fenceEnd >= 0 ? fragment.slice(0, fenceEnd) : fragment).trim();

  // Before the body begins there is nothing useful to paint, and attempting to
  // load a partial <style> block can briefly flash an unstyled document.
  return /<body\b/i.test(html) ? html : null;
}

function extractFrameText(frame: unknown): string {
  if (!isRecord(frame)) return "";
  const record = frame;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (typeof record.delta === "string") return record.delta;

  const choices = Array.isArray(record.choices) ? record.choices : [];
  const fromChoices = choices
    .map((choice) => {
      if (!isRecord(choice)) return "";
      const delta = isRecord(choice.delta) ? choice.delta : {};
      const message = isRecord(choice.message) ? choice.message : {};
      return [
        readString(delta.content),
        readString(delta.text),
        readString(message.content),
      ].join("");
    })
    .join("");
  if (fromChoices) return fromChoices;

  const payload = record.payload;
  if (isRecord(payload)) {
    return extractFrameText(payload);
  }

  return "";
}

function parseToolOutputPath(output: unknown): { path?: string; size?: number } {
  const raw = typeof output === "string" ? output : "";
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    const data = isRecord(parsed.data) ? parsed.data : {};
    return {
      path: readString(data.path) || undefined,
      size: typeof data.size === "number" ? data.size : undefined,
    };
  } catch {
    return {};
  }
}

function getPathFromInput(input: unknown): string | undefined {
  return isRecord(input) ? readString(input.path) || undefined : undefined;
}

function buildAgentToolAccessWarningMessage(warning: AgentToolAccessWarning) {
  return `Agent tool access warning: ${warning.message}`;
}

function extractFrameEvents(
  frame: unknown,
  toolAccessPolicy: AgentToolAccessPolicy,
): AgentStreamEvent[] {
  if (!isRecord(frame)) return [];
  const events: AgentStreamEvent[] = [];

  if (toolAccessPolicy !== "off") {
    const toolAccessWarning = getAgentToolAccessWarning(frame);
    if (toolAccessWarning) {
      if (toolAccessPolicy === "warn") {
        events.push({
          type: "activity",
          message: buildAgentToolAccessWarningMessage(toolAccessWarning),
          diagnosticOnly: true,
        });
      } else {
        events.push({
          type: "error",
          code: toolAccessWarning.code,
          message: AGENT_TOOLS_UNAVAILABLE_MESSAGE,
        });
      }
    }
  }

  const errorType = readString(frame.error_type) || readString(frame.code);
  const errorMessage = readString(frame.message) || readString(frame.error);
  const hasErrorFrame = frame.event === "error" || Boolean(errorType) ||
    (frame.event === "sse" && Boolean(errorMessage));
  if (hasErrorFrame) {
    const message = errorMessage || "Agent stream error.";
    events.push({
      type: "error",
      code: errorType || undefined,
      message,
      expired: /expired|APP_NOT_GRANTED|invalid app_session_token/i.test(message),
    });
  }

  const text = extractFrameText(frame);
  if (text && !(frame.event === "raw" && text === "[DONE]")) {
    events.unshift({ type: "content", text });
  }

  const choices = Array.isArray(frame.choices) ? frame.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = isRecord(choice.delta) ? choice.delta : {};

    if (isRecord(delta.tool_start)) {
      const toolStart = delta.tool_start;
      const toolName = readString(toolStart.name) || "tool";
      const filePath = getPathFromInput(toolStart.input);
      events.push({
        type: "activity",
        tool: toolName,
        path: filePath,
        message: filePath ? `${toolName} ${filePath}` : `${toolName} started`,
      });
    }

    if (isRecord(delta.tool_end)) {
      const toolEnd = delta.tool_end;
      const toolName = readString(toolEnd.name) || "tool";
      const parsedOutput = parseToolOutputPath(toolEnd.output);
      events.push({
        type: "activity",
        tool: toolName,
        path: parsedOutput.path,
        size: parsedOutput.size,
        message: parsedOutput.path
          ? `${toolName} ${parsedOutput.path}`
          : `${toolName} completed`,
      });
    }

    if (delta.error) {
      const detail = isRecord(delta.error) ? delta.error : {};
      events.push({ type: "error", message: readString(delta.error) || readString(detail.message) || "Agent stream error." });
    }

    if (isRecord(delta.task_complete) && delta.task_complete.status === "completed") {
      events.push({
        type: "complete",
        usage: delta.task_complete.token_usage,
      });
    }
  }

  if (frame.event === "complete" && !events.some((event) => event.type === "complete")) {
    events.push({
      type: "complete",
      usage: frame.usage ?? frame.token_usage ?? (isRecord(frame.task_complete) ? frame.task_complete.token_usage : undefined),
    });
  }
  return events;
}

function agentRunRequest(content: string, options?: AgentRunOptions) {
  return {
    content,
    modelPreferences: { hints: [{ name: resolveAgentModelPreference(options?.modelPreference) }] },
    ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
  };
}

async function collectRunText(
  session: HostAgentSession,
  content: string,
  options: AgentRunOptions | undefined,
  clientOptions: AgentClientOptions,
  toolAccessPolicy: AgentToolAccessPolicy,
  stopSignal: AbortSignal,
  diagnostics?: StreamDiagnostics,
  rawTrace?: SessionRunTrace,
): Promise<CollectedAgentRun> {
  let output = "";
  const events: AgentStreamEvent[] = [];

  const sessionRecord = session as unknown as Record<string, unknown>;
  // A held Session must not retain the preceding run's cancellation target.
  sessionRecord.__activeRunId = null;
  // Anti-ghost timing: segment the run into create / queue (time-to-first-frame)
  // / generation so overload failures show their shape in the log without any
  // server-side visibility.
  const timing: RunTiming = { runStartedAt: Date.now() };
  const rawStream = session.run(agentRunRequest(content, options));
  diagnostics?.stream(rawStream);
  const streamRecord = rawStream as unknown as Record<string, unknown>;
  const initialRunId = typeof streamRecord.run_id === "string"
    ? streamRecord.run_id
    : typeof streamRecord.runId === "string" ? streamRecord.runId : null;
  if (initialRunId) sessionRecord.__activeRunId = initialRunId;
  // Lifecycle diagnostic frames for the run log: session.create before session.run.
  if (typeof options?.onDiagnosticStreamEvent === "function") {
    const granted = Array.isArray(sessionRecord.granted_tools)
      ? (sessionRecord.granted_tools as unknown[]).filter((tool): tool is string => typeof tool === "string")
      : [];
    const expiresInSeconds = readSessionExpiresInSeconds(session);
    const sessionId = typeof sessionRecord.appSessionUuid === "string"
      ? sessionRecord.appSessionUuid
      : typeof sessionRecord.session_id === "string" ? sessionRecord.session_id : "";
    options.onDiagnosticStreamEvent({
      type: "activity",
      diagnosticOnly: true,
      message:
        `session.create: model=${resolveAgentModelPreference(options?.modelPreference)} ` +
        `tools=${(options?.sessionTools ?? DEFAULT_AGENT_SESSION_ALLOWED_TOOLS).join(",")} ` +
        `granted=${granted.join(",")} ` +
        `expires_in=${expiresInSeconds ?? "?"}s ` +
        `session_id=${sessionId}`,
    });
    options.onDiagnosticStreamEvent({
      type: "activity",
      diagnosticOnly: true,
      message:
        `session.run: model_hint=${resolveAgentModelPreference(options?.modelPreference)} ` +
        `content_chars=${content.length}`,
    });
  }
  const stream = guardStreamLiveness(rawStream, {
    idleMs: resolveStreamIdleTimeoutMs(clientOptions.streamIdleTimeoutMs),
    signal: options?.drainOnCancel ? undefined : options?.signal,
    isCancelled: options?.drainOnCancel ? undefined : options?.isCancelled,
    stopSignal,
    onIteratorDone: diagnostics ? () => diagnostics.iteratorDone() : undefined,
    onCleanup: diagnostics ? (status) => diagnostics.cleanup(status) : undefined,
  });
  let exitReason: StreamExitReason = "stream_exhausted";
  let usage: unknown;
  let frameCount = 0;
  let outcome = "ok";
  try {
    for await (const frame of stream) {
      frameCount += 1;
      if (timing.firstFrameAt === undefined) timing.firstFrameAt = Date.now();
      if (stopSignal.aborted) break;
      const frameRunId = typeof frame.run_id === "string"
        ? frame.run_id
        : typeof frame.runId === "string" ? frame.runId : null;
      if (frameRunId) {
        sessionRecord.__activeRunId = frameRunId;
        options?.onRunId?.(frameRunId);
      }
      rawTrace?.frame(frame);
      const frameEvents = extractFrameEvents(frame, toolAccessPolicy);
      diagnostics?.frame(frame, frameEvents);
      options?.onRawFrame?.(frame);
      for (const event of frameEvents) {
        events.push(event);
        // Keep technical warnings in interaction logs without replacing UI progress.
        if (event.type !== "activity" || !event.diagnosticOnly) options?.onStreamEvent?.(event);
        if (event.type === "activity" && event.diagnosticOnly) options?.onDiagnosticStreamEvent?.(event);
        if (event.type === "content") {
          output += event.text;
          if (timing.firstContentAt === undefined) timing.firstContentAt = Date.now();
          rawTrace?.content(event.text);
        } else if (event.type === "error") {
          throw new AgentRunStreamError(
            event.message,
            event.expired,
            event.code,
          );
        } else if (event.type === "complete") {
          usage = event.usage;
        }
      }
      // Process the whole frame (including content, usage and errors) before stopping.
      if (frameEvents.some((event) => event.type === "complete")) {
        exitReason = frame.event === "complete" ? "top_level_complete" : "task_complete";
        break;
      }
    }
  } catch (cause) {
    outcome = isStreamIdleTimeoutError(cause) ? "idle_timeout"
      : isStreamCancelledError(cause) ? "cancelled"
      : cause instanceof AgentRunStreamError && cause.expired ? "session_expired" : "error";
    throw cause;
  } finally {
    timing.finishedAt = Date.now();
    if (typeof options?.onDiagnosticStreamEvent === "function") {
      options.onDiagnosticStreamEvent({
        type: "activity",
        diagnosticOnly: true,
        message: describeRunTiming(timing, { outcome, exitReason, frameCount, contentChars: output.length, usage }),
      });
    }
  }
  return { text: output, events, exitReason };
}

function isActiveSessionLimitMessage(message: string) {
  return /active session|活跃 session|session 上限|HTTP 429|session\.mint failed/i.test(message);
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function toAgentInfrastructureError(
  error: unknown,
  fallbackMessage: string,
  options: {
    rawMessage?: string;
    noToolsAvailable?: boolean;
  } = {},
) {
  if (error instanceof AgentInfrastructureError) return error;
  const rawMessage = toErrorMessage(error) || fallbackMessage;
  const activeSessionLimit = isActiveSessionLimitMessage(rawMessage);
  const noToolsAvailable = options.noToolsAvailable
    || (error instanceof AgentRunStreamError && error.code === "NO_TOOLS_AVAILABLE");
  const message = noToolsAvailable
    ? AGENT_TOOLS_UNAVAILABLE_MESSAGE
    : activeSessionLimit
    ? `${rawMessage} 请先 delete/revoke 旧 Agent session，或等待服务端释放后重试。`
    : rawMessage;
  return new AgentInfrastructureError(
    message,
    error instanceof AgentRunStreamError
      ? error.code
      : isStreamIdleTimeoutError(error)
        ? "idle_timeout"
        : error instanceof AgentRunTimeoutError
          ? "timeout"
          : undefined,
    activeSessionLimit,
    options.rawMessage,
    noToolsAvailable,
  );
}

function createNoToolsAvailableError(
  warning: AgentToolAccessWarning,
): AgentInfrastructureError {
  return new AgentInfrastructureError(
    AGENT_TOOLS_UNAVAILABLE_MESSAGE,
    warning.code,
    false,
    warning.message,
    true,
  );
}

function readSessionExpiresInSeconds(session: HostAgentSession): number {
  const value = typeof session.expires_in === "number"
    ? session.expires_in
    : typeof session.expiresIn === "number"
      ? session.expiresIn
      : DEFAULT_AGENT_SESSION_EXPIRES_IN_SECONDS;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_AGENT_SESSION_EXPIRES_IN_SECONDS;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = globalThis.setTimeout(() => {
      reject(new AgentRunTimeoutError(timeoutMs));
      onTimeout?.();
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
    }
  }
}

function readCompletionUsage(events: AgentStreamEvent[]): unknown {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "complete") {
      return event.usage;
    }
  }
  return undefined;
}

async function readSessionHistory(session: HostAgentSession | null): Promise<unknown> {
  if (typeof session?.history !== "function") return undefined;
  try {
    return await session.history();
  } catch {
    return undefined;
  }
}

export async function createAgentClient(
  runtime: HostRuntime,
  clientOptions: AgentClientOptions = {},
): Promise<AgentClient> {
  const activeSessions = new Set<HostAgentSession>();
  const runDiagnostics = new WeakMap<HostAgentSession, StreamDiagnostics>();
  const toolAccessPolicy =
    clientOptions.toolAccessPolicy ?? DEFAULT_AGENT_TOOL_ACCESS_POLICY;
  const uiLocale: Locale = clientOptions.locale ?? "en";

  function formatRetryActivity(input: {
    kind: "fresh_session" | "same_session";
    label?: string;
    retryNumber: number;
    retryLimit: number;
  }) {
    if (input.kind === "same_session") {
      return pickLocale(uiLocale, {
        zh: `Agent 响应校验失败，正在当前会话中重试（${input.retryNumber}/${input.retryLimit}）`,
        en: `Agent response validation failed; retrying in the current session (${input.retryNumber}/${input.retryLimit})`,
        ja: `エージェントの応答検証に失敗しました。現在のセッションで再試行中（${input.retryNumber}/${input.retryLimit}）`,
        de: `Die Antwortvalidierung des Agents ist fehlgeschlagen; Wiederholung in der aktuellen Sitzung (${input.retryNumber}/${input.retryLimit})`,
      });
    }
    const label = input.label ? `${input.label} ` : "";
    return pickLocale(uiLocale, {
      zh: `${label}Agent 会话失败，正在创建新的 Session（${input.retryNumber}/${input.retryLimit}）`,
      en: `${label}Agent session failed; creating a fresh session (${input.retryNumber}/${input.retryLimit})`,
      ja: `${label}エージェントセッションが失敗しました。新しいセッションを作成中（${input.retryNumber}/${input.retryLimit}）`,
      de: `${label}Agent-Sitzung fehlgeschlagen; neue Sitzung wird erstellt (${input.retryNumber}/${input.retryLimit})`,
    });
  }

  function heldSessionLabel(label: string) {
    const translated: Record<string, Record<Locale, string>> = {
      Outline: { en: "Outline", zh: "大纲", ja: "アウトライン", de: "Gliederung" },
      "Image research": { en: "Image research", zh: "图片研究", ja: "画像リサーチ", de: "Bildrecherche" },
      "Web research": { en: "Web research", zh: "Web 研究", ja: "Web リサーチ", de: "Web-Recherche" },
    };
    const entry = translated[label];
    return entry ? pickLocale(uiLocale, entry) : label;
  }
  const sessionTraces = new WeakMap<HostAgentSession, SessionTraceContext>();
  async function createSession(
    enforceToolAccess = true,
    sessionTools: readonly string[] = DEFAULT_AGENT_SESSION_ALLOWED_TOOLS,
    systemPrompt?: string,
    trace?: SessionTraceContext,
  ) {
    const performanceSpan = beginPerformanceSpan({ operationName: "agent.session", attributes: { phase: "create" } });
    const request = { submode: "auto" as const, ...(systemPrompt ? { systemPrompt } : {}), quotaCaps: { inherit_host_tools: false, allowed_tools: [...sessionTools] } };
    const creationTrace = trace?.sink.enabled ? { ...trace, context: { ...trace.context, local_session_id: diagnosticId("session") } } : undefined;
    await traceSessionEvent(creationTrace, "session.create.started", { request });
    try {
      const session = await runtime.agent.session(request);
      if (creationTrace) {
        sessionTraces.set(session, { ...creationTrace, context: { ...creationTrace.context, session: sessionIdentifiers(session) } });
        await traceSessionEvent(sessionTraces.get(session), "session.create.succeeded", { response: { ...sessionIdentifiers(session), expires_in: readSessionExpiresInSeconds(session) } });
      }
      activeSessions.add(session);
      if (enforceToolAccess && toolAccessPolicy !== "off") {
        const toolAccessWarning = getAgentToolAccessWarning(session);
        if (toolAccessWarning) {
          if (toolAccessPolicy === "warn") {
            console.warn(buildAgentToolAccessWarningMessage(toolAccessWarning));
          } else {
            await session.delete().catch(() => undefined);
            activeSessions.delete(session);
            throw createNoToolsAvailableError(toolAccessWarning);
          }
        }
      }
      performanceSpan?.finish("ok");
      return {
        session,
        createdAtMs: Date.now(),
        expiresInSeconds: readSessionExpiresInSeconds(session),
      };
    } catch (error) {
      performanceSpan?.finish("error");
      await traceSessionEvent(creationTrace, "session.create.failed", { error });
      throw toAgentInfrastructureError(error, "Failed to create Agent session.");
    }
  }

  async function deleteSession(session: HostAgentSession | null) {
    if (!session) return;
    activeSessions.delete(session);
    const trace = sessionTraces.get(session);
    await traceSessionEvent(trace, "session.delete.started", {});
    try {
      await session.delete();
      await traceSessionEvent(trace, "session.delete.succeeded", {});
    } catch (error) { await traceSessionEvent(trace, "session.delete.failed", { error }); }
    finally { sessionTraces.delete(session); }
  }

  function readActiveRunId(session: HostAgentSession): string | null {
    const sessionRecord = session as unknown as Record<string, unknown>;
    if ("__activeRunId" in sessionRecord) {
      return typeof sessionRecord.__activeRunId === "string" ? sessionRecord.__activeRunId : null;
    }
    return typeof sessionRecord.run_id === "string"
      ? sessionRecord.run_id
      : typeof sessionRecord.runId === "string" ? sessionRecord.runId : null;
  }

  async function cancelSessionRun(session: HostAgentSession): Promise<void> {
    const diagnostics = runDiagnostics.get(session);
    const runId = readActiveRunId(session);
    if (!runId || typeof session.cancel !== "function") {
      await traceSessionEvent(sessionTraces.get(session), "session.cancel.unavailable", { run_id: runId });
      diagnostics?.hostCancel("unavailable");
      console.warn("Agent Session cancellation is unavailable for an active run.");
      return;
    }
    await traceSessionEvent(sessionTraces.get(session), "session.cancel.started", { run_id: runId });
    diagnostics?.hostCancel("requested");
    await session.cancel(runId).then(async () => { diagnostics?.hostCancel("resolved"); await traceSessionEvent(sessionTraces.get(session), "session.cancel.succeeded", { run_id: runId }); }, async (error) => {
      await traceSessionEvent(sessionTraces.get(session), "session.cancel.failed", { run_id: runId, error });
      diagnostics?.hostCancel("rejected");
      console.warn("Failed to cancel Agent Session run", error);
    });
  }

  async function runPromptOnce(
    sessionMeta: Awaited<ReturnType<typeof createSession>>,
    prompt: string,
    runOptions: AgentRunOptions | undefined,
    extra: {
      heldSession?: boolean;
      heldAttempt?: { run_index: number; run_attempt: number; fresh_session_retry_count: number };
      sessionSystemPrompt?: string;
      attempt?: AgentSessionAttemptContext;
    } = {},
  ): Promise<CollectedAgentRun> {
    const interactionHandle = runOptions?.logContext?.logger
      ? await runOptions.logContext.logger.startInteraction(runOptions.logContext, {
          prompt,
          extra: {
            ...(extra.sessionSystemPrompt ? { system_prompt: extra.sessionSystemPrompt } : {}),
            model_preference: resolveAgentModelPreference(runOptions.modelPreference),
            held_session: extra.heldSession === true,
            held_session_attempt: extra.heldAttempt,
            ...(extra.attempt
              ? {
                  session_attempt: extra.attempt.session_attempt,
                  same_session_retry_count: extra.attempt.same_session_retry_count,
                  fresh_session_retry_count: extra.attempt.fresh_session_retry_count,
                  logical_attempt: extra.attempt.logical_attempt,
                  retry_mode: extra.attempt.retry_mode,
                }
              : {}),
          },
        }).catch(() => null)
      : null;
    const performanceSpan = beginPerformanceSpan({
      operationName: "agent.session.attempt",
      workspaceId: runOptions?.logContext?.workspace_dir.split(/[\\/]/).filter(Boolean).at(-1),
      attributes: {
        phase: "run",
        held_session: extra.heldSession === true,
        ...(extra.attempt
          ? {
              session_attempt: extra.attempt.session_attempt,
              same_session_retry: extra.attempt.same_session_retry_count,
              fresh_session_retry: extra.attempt.fresh_session_retry_count,
              logical_attempt: extra.attempt.logical_attempt,
            }
          : {}),
      },
    });
    const stopController = new AbortController();
    const rawTrace = runOptions?.sessionTrace?.sink.enabled ? createSessionRunTrace(runOptions.sessionTrace, {
      ...sessionTraces.get(sessionMeta.session)?.context, attempt: extra.attempt,
      session: sessionIdentifiers(sessionMeta.session),
    }) : undefined;
    await rawTrace?.start(agentRunRequest(prompt, runOptions));
    const diagnostics = runOptions?.logContext?.logger?.enabled || rawTrace ? createStreamDiagnostics({
      operation_id: interactionHandle?.operation_id ?? (typeof runOptions?.sessionTrace?.context.operation_id === "string" ? runOptions.sessionTrace.context.operation_id : undefined),
      interaction_id: interactionHandle?.interaction_id ?? rawTrace?.interactionId,
      session: sessionMeta.session,
      attempt: extra.attempt,
      held_session_attempt: extra.heldAttempt,
      idle_ms: resolveStreamIdleTimeoutMs(clientOptions.streamIdleTimeoutMs),
      run_timeout_ms: clientOptions.runTimeoutMs ?? AGENT_RUN_TIMEOUT_MS,
    }) : undefined;
    if (diagnostics) runDiagnostics.set(sessionMeta.session, diagnostics);
    try {
      const collected = await withTimeout(
        collectRunText(
          sessionMeta.session,
          prompt,
          runOptions,
          clientOptions,
          runOptions?.toolAccessPolicy ?? toolAccessPolicy,
          stopController.signal,
          diagnostics,
          rawTrace,
        ),
        clientOptions.runTimeoutMs ?? AGENT_RUN_TIMEOUT_MS,
        () => {
          diagnostics?.end("run_timeout");
          stopController.abort();
        },
      );
      diagnostics?.end(collected.exitReason);
      const diagnosticSnapshot = diagnostics?.snapshot(false);
      await rawTrace?.finish("succeeded", { ...diagnosticSnapshot, usage: readCompletionUsage(collected.events), exit_reason: collected.exitReason });
      if (interactionHandle) await runOptions?.logContext?.logger?.finishInteraction(interactionHandle, {
        status: "succeeded",
        output: collected.text,
        usage: readCompletionUsage(collected.events),
        token_source: "session",
        session_history: runOptions?.logContext?.logger?.enabled
          ? await readSessionHistory(sessionMeta.session) : undefined,
        extra: {
          ...diagnosticSnapshot,
          events: collected.events,
          held_session: extra.heldSession === true,
          held_session_attempt: extra.heldAttempt,
          ...(extra.attempt
            ? {
                session_attempt: extra.attempt.session_attempt,
                same_session_retry_count: extra.attempt.same_session_retry_count,
                fresh_session_retry_count: extra.attempt.fresh_session_retry_count,
                logical_attempt: extra.attempt.logical_attempt,
                retry_mode: extra.attempt.retry_mode,
              }
            : {}),
        },
      }).catch(() => undefined);
      performanceSpan?.finish("ok");
      return collected;
    } catch (error) {
      performanceSpan?.finish("error");
      diagnostics?.end(error instanceof AgentRunTimeoutError ? "run_timeout"
        : isStreamIdleTimeoutError(error) ? "idle_timeout"
        : isStreamCancelledError(error) || isAgentRunCancelledError(error) ? "cancelled" : "error");
      if (error instanceof AgentRunTimeoutError) await cancelSessionRun(sessionMeta.session);
      const diagnosticSnapshot = diagnostics?.snapshot(true);
      await rawTrace?.finish(isStreamCancelledError(error) || isAgentRunCancelledError(error) ? "cancelled" : "failed", { ...diagnosticSnapshot, error });
      if (interactionHandle) await runOptions?.logContext?.logger?.finishInteraction(interactionHandle, {
        status: isStreamCancelledError(error) || isAgentRunCancelledError(error) ? "cancelled" : "failed",
        error,
        session_history: runOptions?.logContext?.logger?.enabled
          ? await readSessionHistory(sessionMeta.session) : undefined,
        extra: {
          ...diagnosticSnapshot,
          held_session: extra.heldSession === true,
          held_session_attempt: extra.heldAttempt,
          ...(extra.attempt
            ? {
                session_attempt: extra.attempt.session_attempt,
                same_session_retry_count: extra.attempt.same_session_retry_count,
                fresh_session_retry_count: extra.attempt.fresh_session_retry_count,
                logical_attempt: extra.attempt.logical_attempt,
                retry_mode: extra.attempt.retry_mode,
              }
            : {}),
        },
      }).catch(() => undefined);
      if (isStreamCancelledError(error) || isAgentRunCancelledError(error)) {
        throw isAgentRunCancelledError(error) ? error : new AgentRunCancelledError();
      }
      throw toAgentInfrastructureError(error, "Agent session failed.");
    } finally {
      runDiagnostics.delete(sessionMeta.session);
    }
  }

  async function executePrompt<T>(input: {
    prompt: string;
    systemPrompt?: string;
    runOptions?: AgentRunOptions;
    enforceToolAccess?: boolean;
    sessionTools?: readonly string[];
    accept: (rawText: string) => T | Promise<T>;
    buildSameSessionRepairPrompt?: (input: {
      rawText: string;
      error: unknown;
      retryNumber: number;
    }) => string;
    runOptionsForAttempt?: (input: {
      retryMode: "initial" | "same_session" | "fresh_session";
    }) => AgentRunOptions | undefined;
  }) {
    try {
      const result = await executeAgentSession<T, AgentRunOptions>({
        initialPrompt: input.prompt,
        runOptions: input.runOptions,
        runOptionsForAttempt: input.runOptionsForAttempt
          ? ({ retryMode }) => input.runOptionsForAttempt?.({ retryMode })
          : undefined,
        createSession: async (): Promise<AgentSessionHandle<AgentRunOptions>> => {
          const sessionMeta = await createSession(
            input.enforceToolAccess !== false,
            input.sessionTools ?? DEFAULT_AGENT_SESSION_ALLOWED_TOOLS,
            input.systemPrompt,
            input.runOptions?.sessionTrace,
          );
          return {
            run: async (prompt, runOptions, attempt) => (
              await runPromptOnce(sessionMeta, prompt, runOptions, { attempt })
            ).text,
            close: () => deleteSession(sessionMeta.session),
          };
        },
        accept: input.accept,
        buildSameSessionRepairPrompt: input.buildSameSessionRepairPrompt,
        maxSameSessionRetries: DEFAULT_AGENT_SAME_SESSION_RETRIES,
        maxFreshSessionRetries: DEFAULT_AGENT_FRESH_SESSION_RETRIES,
        isCancellationError: isAgentRunCancelledError,
        onAttempt: async (attempt) => {
          await traceSessionEvent(input.runOptions?.sessionTrace, "session.attempt.result", {
            logical_attempt: attempt.logical_attempt, session_attempt: attempt.session_attempt,
            same_session_retry_count: attempt.same_session_retry_count, fresh_session_retry_count: attempt.fresh_session_retry_count,
            retry_mode: attempt.retry_mode, status: attempt.status, will_retry: attempt.will_retry,
            response_validation: attempt.raw_text === undefined ? "unavailable" : attempt.status === "success" ? "passed" : "failed",
            error: attempt.error,
          });
          if (attempt.status !== "retry") return;
          if (attempt.raw_text === undefined) {
            input.runOptions?.onStreamEvent?.({
              type: "activity",
              message: formatRetryActivity({
                kind: "fresh_session",
                retryNumber: attempt.fresh_session_retry_count + 1,
                retryLimit: DEFAULT_AGENT_FRESH_SESSION_RETRIES,
              }),
            });
          } else {
            input.runOptions?.onStreamEvent?.({
              type: "activity",
              message: formatRetryActivity({
                kind: "same_session",
                retryNumber: attempt.same_session_retry_count + 1,
                retryLimit: DEFAULT_AGENT_SAME_SESSION_RETRIES,
              }),
            });
          }
        },
      });
      return result;
    } catch (error) {
      if (isAgentRunCancelledError(error)) throw error;
      if (error instanceof AgentSessionResponseValidationError) throw error;
      if (error instanceof AgentSessionExecutionError) {
        if (error.lastError instanceof AgentInfrastructureError) throw error.lastError;
        throw toAgentInfrastructureError(error.lastError, "Agent session failed.");
      }
      throw error;
    }
  }

  function isSessionCancellation(error: unknown) {
    return isAgentRunCancelledError(error) || isStreamCancelledError(error);
  }

  async function createHeldSession(
    systemPrompt: string,
    creationOptions: AgentSessionCreationOptions | undefined,
    label: string,
    transformRunOptions?: (options: AgentRunOptions) => AgentRunOptions,
  ) {
    const displayLabel = heldSessionLabel(label);
    let freshSessionRetries = 0;
    let sessionMeta: Awaited<ReturnType<typeof createSession>>;
    const freshRetriesEnabled = creationOptions?.manageFreshSessionRetries !== false;
    const createWithFreshRetries = async () => {
      for (;;) {
        try {
          return await createSession(false, [], systemPrompt);
        } catch (error) {
          if (!freshRetriesEnabled || freshSessionRetries >= DEFAULT_AGENT_FRESH_SESSION_RETRIES) throw error;
          freshSessionRetries += 1;
        }
      }
    };
    sessionMeta = await createWithFreshRetries();
    let closed = false;
    let runIndex = 0;

    const restartFreshSession = async () => {
      if (closed) throw new AgentInfrastructureError(`${label} Agent session is already closed.`);
      if (!freshRetriesEnabled || freshSessionRetries >= DEFAULT_AGENT_FRESH_SESSION_RETRIES) {
        throw new AgentInfrastructureError(`${label} Agent fresh-session retry budget is exhausted.`);
      }
      freshSessionRetries += 1;
      creationOptions?.onFreshSession?.();
      await deleteSession(sessionMeta.session);
      sessionMeta = await createWithFreshRetries();
    };

    const run = async (prompt: string, inputOptions: AgentRunOptions = {}) => {
      if (closed) throw new AgentInfrastructureError(`${label} Agent session is already closed.`);
      const currentRunIndex = ++runIndex;
      let runAttempt = 0;
      let currentPrompt = prompt;
      let currentOptions = transformRunOptions?.(inputOptions) ?? inputOptions;
      for (;;) {
        try {
          return (await runPromptOnce(sessionMeta, currentPrompt, currentOptions, {
            heldSession: true,
            heldAttempt: { run_index: currentRunIndex, run_attempt: ++runAttempt, fresh_session_retry_count: freshSessionRetries },
            sessionSystemPrompt: systemPrompt,
          })).text;
        } catch (error) {
          if (isSessionCancellation(error)) throw error;
          if (!freshRetriesEnabled || freshSessionRetries >= DEFAULT_AGENT_FRESH_SESSION_RETRIES) throw error;
          currentOptions.onStreamEvent?.({
            type: "activity",
            message: formatRetryActivity({
              kind: "fresh_session",
              label: displayLabel,
              retryNumber: freshSessionRetries,
              retryLimit: DEFAULT_AGENT_FRESH_SESSION_RETRIES,
            }),
          });
          await restartFreshSession();
          currentPrompt = creationOptions?.freshPrompt?.() ?? prompt;
          currentOptions = creationOptions?.freshRunOptions?.()
            ?? transformRunOptions?.(inputOptions)
            ?? inputOptions;
        }
      }
    };

    return {
      run,
      restartFreshSession,
      async close() {
        if (closed) return;
        try {
          await sessionMeta.session.delete();
        } catch (error) {
          throw toAgentInfrastructureError(error, `Failed to delete ${label} Agent session.`);
        }
        closed = true;
        activeSessions.delete(sessionMeta.session);
      },
    };
  }

  return {
    async runStructuredPrompt<T>(prompt: string, validate: (value: unknown) => T, options?: AgentRunOptions) {
      const result = await executePrompt({
        prompt,
        runOptions: options,
        enforceToolAccess: false,
        sessionTools: options?.sessionTools ?? [],
        accept: (rawText) => validate(parseJsonObject(rawText, "template response")),
        buildSameSessionRepairPrompt: ({ error }) => `上次输出不是合法 JSON（错误：${error instanceof Error ? error.message : String(error)}）。最常见的原因是字符串值内有未转义的换行或双引号——多行文本（如 HTML）作为 JSON 字符串时，内部换行必须写成 \\n、双引号必须写成 \\"，且结尾不能缺括号。请完整重新输出符合原格式要求的 JSON，只输出 JSON 本身，不要解释、不要代码块。`,
        runOptionsForAttempt: ({ retryMode }) => retryMode === "same_session" ? { ...options, attachments: undefined } : options,
      });
      return result.value;
    },
    async checkToolAccess() {
      const sessionMeta = await createSession();
      await deleteSession(sessionMeta.session);
    },

    async runAuthoringPrompt(prompt, options) {
      const result = await executePrompt({
        prompt,
        runOptions: options,
        sessionTools: options?.sessionTools,
        accept: (rawText) => {
          const parsed = parseJsonObject<unknown>(rawText, "authoring summary");
          if (!isRecord(parsed)) throw new Error("Agent authoring summary must be a JSON object.");
          return rawText;
        },
        buildSameSessionRepairPrompt: ({ error }) => buildStructuredJsonRepairPrompt(
          "",
          '{"status":"ready_for_render","changed_files":[],"files_read":[],"authoring_kit_sources_read":[],"summary":"","needs_render":true,"notes":[]}',
          error instanceof Error ? error.message : String(error),
        ),
      });
      const rawText = result.attempts.at(-1)?.raw_text ?? result.value;
      return normalizeCollectedAuthoringRun({
        text: rawText,
        sameSessionRetries: result.sameSessionRetries,
        freshSessionRetries: result.freshSessionRetries,
        logicalAttempts: result.logicalAttempts,
      });
    },

    async runPageVisualReviewPrompt(prompt, options) {
      const result = await executePrompt({
        prompt,
        runOptions: options,
        accept: (rawText) => normalizePageVisualReview(parseJsonObject(rawText, "page visual review")),
        buildSameSessionRepairPrompt: ({ error }) => buildStructuredJsonRepairPrompt(
          "",
          '{"changed":false,"blocked":true,"summary":""}',
          error instanceof Error ? error.message : String(error),
        ),
        runOptionsForAttempt: ({ retryMode }) => retryMode === "same_session"
          ? { ...options, attachments: undefined }
          : options,
      });
      return {
        ...result.value,
        same_session_retries: result.sameSessionRetries,
        fresh_session_retries: result.freshSessionRetries,
        logical_attempts: result.logicalAttempts,
      };
    },

    async runHtmlGenerationPrompt(prompt, options, systemPrompt) {
      const result = await executePrompt({
        prompt,
        systemPrompt,
        runOptions: options,
        enforceToolAccess: false,
        sessionTools: [],
        accept: (rawText) => ({
          html: extractSingleCompleteHtml(rawText),
          raw_text: rawText,
        }),
        buildSameSessionRepairPrompt: ({ error }) => [
          "你上一轮没有返回唯一的完整 HTML。",
          `提取错误：${error instanceof Error ? error.message : String(error)}`,
          "请在同一会话中修复：只返回一个完整、可运行的 HTML 文档。不要输出分析、说明或多个备选版本，也不要用 Markdown 代码块包裹。",
          "若原始任务是基于已有 HTML 的布局修复或美化，还必须遵守以下图片来源约束：",
          "- 以该任务最初输入的原始 HTML 为准，逐字符保留其中已有的 <img src>、srcset 和 CSS 背景图引用；不要以上一轮不完整或已改错的输出作为图片来源依据。",
          "- 会话中的整页截图仅用于观察和检查布局，不是正文配图。禁止将截图 URL 或截图附件下载地址写入返回的 HTML，不能作为正文图片、背景图，也不能通过裁切截图来替代原始配图。",
          "- 只可调整图片尺寸、位置和裁剪等展示样式，不得改变图片来源或虚构新路径；原始 HTML 没有正文配图时，不得用页面截图补图。",
        ].join("\n"),
        runOptionsForAttempt: ({ retryMode }) => ({
          ...options,
          ...(retryMode === "same_session" ? { attachments: undefined } : {}),
          sessionTools: [],
          toolAccessPolicy: "off",
        }),
      });
      return {
        html: result.value.html,
        raw_text: result.value.raw_text,
        content_attempts: result.logicalAttempts,
        same_session_retries: result.sameSessionRetries,
        fresh_session_retries: result.freshSessionRetries,
        logical_attempts: result.logicalAttempts,
      };
    },

    async createOutlineSession(systemPrompt, creationOptions) {
      return createHeldSession(systemPrompt, creationOptions, "Outline");
    },

    async createImageResearchSession(systemPrompt, creationOptions) {
      return createHeldSession(
        systemPrompt,
        creationOptions,
        "Image research",
        (options) => ({ ...options, sessionTools: [], toolAccessPolicy: "off" }),
      );
    },

    async createWebResearchSession(systemPrompt, creationOptions) {
      return createHeldSession(
        systemPrompt,
        creationOptions,
        "Web research",
        (options) => ({ ...options, sessionTools: [], toolAccessPolicy: "off" }),
      );
    },

    async cancelActiveRuns() {
      await Promise.all([...activeSessions].map(async (session) => {
        await cancelSessionRun(session);
      }));
    },

    async close() {
      // Sessions are run-scoped and deleted after each run.
    },
  };
}
