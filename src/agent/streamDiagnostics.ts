import type { AgentStreamEvent } from "./agentClient";

const FIRST_FRAMES = 8;
const LAST_FRAMES = 32;
const KEY_FRAMES = 32;
const PARTIAL_TEXT_CHARS = 65_536;
const EVENT_NAMES = new Set(["started", "run_meta", "sse", "message", "content", "raw", "complete", "error", "end", "stream_end"]);
const DELTA_NAMES = ["content", "text", "tool_start", "tool_end", "tool_calls", "task_info", "processing_started", "task_complete", "error"];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** New diagnostic fields never copy raw frames, tool arguments, or download references. */
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)
    && !/^(sk-|Bearer|Authorization)/i.test(value) ? value : undefined;
}

function eventName(value: unknown): string {
  return typeof value !== "string" ? "unavailable" : EVENT_NAMES.has(value) ? value : "other";
}

function redactPartialText(text: string): string {
  // Redact after joining fragments so a credential/URL split across frames is covered.
  return text
    .replace(/(?:https?:\/\/|data:|file:\/\/)[^\s<>"'`]*/gi, "[redacted-url]")
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)["']?\s*[:=]\s*)(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\r\n,}]+)/gi, "$1[redacted]")
    .replace(/\bBearer\s+[^\s,"'<>}]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, "[redacted-key]");
}

export type StreamExitReason = "task_complete" | "top_level_complete" | "stream_exhausted" | "idle_timeout" | "run_timeout" | "cancelled" | "error";

interface Stamp { at: string; elapsed_ms: number }
interface FrameSummary extends Stamp {
  receive_index: number;
  event: string;
  event_type: string;
  delta_types: string[];
  text_chars: number;
  normalized_event_types: string[];
  task_complete?: { status: string; task_id?: string };
  stream_end?: { reason: string; task_id?: string };
}

/** One bounded, best-effort recorder per run attempt; no dependency on Host internals. */
export function createStreamDiagnostics(input: {
  operation_id?: string;
  interaction_id?: string;
  session: unknown;
  attempt?: { logical_attempt: number; session_attempt: number; same_session_retry_count: number; fresh_session_retry_count: number; retry_mode: string };
  held_session_attempt?: { run_index: number; run_attempt: number; fresh_session_retry_count: number };
  idle_ms: number;
  run_timeout_ms: number;
}) {
  const started = performance.now();
  const stamp = (): Stamp => ({ at: new Date().toISOString(), elapsed_ms: Math.max(0, performance.now() - started) });
  const waiting = stamp();
  const session = record(input.session);
  const ids: Record<string, string | undefined> = {};
  let firstFrame: Stamp | undefined;
  let lastFrame: Stamp | undefined;
  let firstText: Stamp | undefined;
  let lastText: Stamp | undefined;
  let ended: Stamp | undefined;
  let exitReason: StreamExitReason | undefined;
  let frames = 0;
  let fragments = 0;
  let textChars = 0;
  let maxGap = 0;
  let partialText = "";
  let keyCount = 0;
  let recordingErrors = 0;
  const first: FrameSummary[] = [];
  const last: FrameSummary[] = [];
  const key: FrameSummary[] = [];
  const eventCounts: Record<string, number> = {};
  const eventTypeCounts: Record<string, number> = {};
  const markers = {
    task_complete: { observed: false, count: 0, status: "unavailable", task_id: undefined as string | undefined },
    stream_end: { observed: false, reason: "unavailable", task_id: undefined as string | undefined },
    raw_done: false,
    top_level_complete: false,
    iterator_done: false,
  };
  let cleanup = "not_requested";
  let hostCancel = "not_requested";
  const safe = (action: () => void) => {
    try { action(); } catch { recordingErrors += 1; }
  };

  safe(() => {
    ids.session_appSessionUuid = identifier(session.appSessionUuid);
    ids.session_app_session_uuid = identifier(session.app_session_uuid);
  });
  return {
    stream(value: unknown) {
      safe(() => {
        if (ended) return;
        const stream = record(value);
        ids.stream_run_id = identifier(stream.run_id);
        ids.stream_runId = identifier(stream.runId);
        ids.stream_stream_id = identifier(stream.stream_id);
      });
    },
    frame(value: unknown, events: AgentStreamEvent[]) {
      safe(() => {
        if (ended) return;
        const frame = record(value);
        const time = stamp();
        maxGap = Math.max(maxGap, time.elapsed_ms - (lastFrame ?? waiting).elapsed_ms);
        firstFrame ??= time;
        lastFrame = time;
        frames += 1;
        const event = eventName(frame.event);
        const eventType = eventName(frame.event_type);
        eventCounts[event] = (eventCounts[event] ?? 0) + 1;
        eventTypeCounts[eventType] = (eventTypeCounts[eventType] ?? 0) + 1;
        if (identifier(frame.run_id)) ids.last_frame_run_id = identifier(frame.run_id);
        if (identifier(frame.runId)) ids.last_frame_runId = identifier(frame.runId);
        if (frame.event === "run_meta") {
          ids.run_meta_run_id = identifier(frame.run_id);
          ids.run_meta_runId = identifier(frame.runId);
          ids.run_meta_app_session_uuid = identifier(frame.app_session_uuid);
        }
        let keyFrame = ["started", "run_meta", "complete", "error", "end"].includes(event);
        const deltaTypes = new Set<string>();
        for (const choice of Array.isArray(frame.choices) ? frame.choices : []) {
          const delta = record(record(choice).delta);
          for (const name of DELTA_NAMES) if (name in delta) deltaTypes.add(name);
          if ("task_info" in delta) ids.task_info_task_id = identifier(record(delta.task_info).task_id);
          if ("processing_started" in delta) ids.processing_started_task_id = identifier(record(delta.processing_started).task_id);
          if ("task_complete" in delta) {
            const complete = record(delta.task_complete);
            markers.task_complete = {
              observed: true,
              count: markers.task_complete.count + 1,
              status: identifier(complete.status) ?? "unavailable",
              task_id: identifier(complete.task_id),
            };
            keyFrame = true;
          }
        }
        if (frame.event_type === "stream_end") {
          markers.stream_end = { observed: true, reason: identifier(frame.reason) ?? "unavailable", task_id: identifier(frame.task_id) };
          keyFrame = true;
        }
        if (frame.event === "raw" && frame.text === "[DONE]") {
          markers.raw_done = true;
          keyFrame = true;
        }
        if (frame.event === "complete") markers.top_level_complete = true;
        let frameChars = 0;
        for (const event of events) {
          if (event.type !== "content") continue;
          fragments += 1;
          frameChars += event.text.length;
          partialText += event.text.slice(0, Math.max(0, PARTIAL_TEXT_CHARS - partialText.length));
        }
        textChars += frameChars;
        if (frameChars) { firstText ??= time; lastText = time; }
        const summary: FrameSummary = {
          ...time, receive_index: frames, event, event_type: eventType,
          delta_types: [...deltaTypes], text_chars: frameChars,
          normalized_event_types: [...new Set(events.map((event) => event.type))],
          ...(deltaTypes.has("task_complete") ? { task_complete: { status: markers.task_complete.status, task_id: markers.task_complete.task_id } } : {}),
          ...(frame.event_type === "stream_end" ? { stream_end: { reason: markers.stream_end.reason, task_id: markers.stream_end.task_id } } : {}),
        };
        if (first.length < FIRST_FRAMES) first.push(summary);
        last.push(summary);
        if (last.length > LAST_FRAMES) last.shift();
        if (keyFrame) {
          keyCount += 1;
          key.push(summary);
          if (key.length > KEY_FRAMES) key.shift();
        }
      });
    },
    iteratorDone() { if (!ended) markers.iterator_done = true; },
    cleanup(status: string) { cleanup = status; },
    hostCancel(status: string) { hostCancel = status; },
    end(reason: StreamExitReason) {
      safe(() => { if (!ended) { ended = stamp(); exitReason = reason; } });
    },
    snapshot(failed: boolean) {
      try {
        const retained = new Map([...first, ...last, ...key].map((frame) => [frame.receive_index, frame]));
        const result = {
          schema_version: 1,
          observation_layer: "session.run.payload",
          operation_id: input.operation_id,
          interaction_id: input.interaction_id,
          identifiers: ids,
          attempt: input.attempt,
          held_session_attempt: input.held_session_attempt,
          // The SDK iterable does not expose the outer RPC envelope or build versions.
          rpc_outer_metadata: "unavailable",
          versions: "unavailable",
          timing: {
            waiting, first_frame: firstFrame, first_content: firstText,
            last_frame: lastFrame, last_content: lastText, terminated: ended,
            idle_timeout_ms: input.idle_ms, run_timeout_ms: input.run_timeout_ms,
            max_frame_gap_ms: maxGap,
            since_last_frame_ms: ended ? ended.elapsed_ms - (lastFrame ?? waiting).elapsed_ms : undefined,
          },
          counts: { frames, content_fragments: fragments, content_chars: textChars, character_unit: "UTF-16 code units", event: eventCounts, event_type: eventTypeCounts },
          markers,
          exit_reason: exitReason,
          subsequent_frames: markers.iterator_done ? "iterator_exhausted" : "not_observed",
          cleanup: { iterator_return: cleanup, host_cancel: hostCancel, return_wait_policy: "non_blocking" },
          frame_budget: {
            first: FIRST_FRAMES, last: LAST_FRAMES, lifecycle: KEY_FRAMES,
            retained: retained.size, dropped: frames - retained.size,
            lifecycle_dropped: Math.max(0, keyCount - KEY_FRAMES),
            truncated: retained.size < frames,
          },
          frames: [...retained.values()].sort((a, b) => a.receive_index - b.receive_index),
          recording_errors: recordingErrors,
        };
        // Detach before logging/history awaits; late next()/return() cannot change it.
        return {
          stream_diagnostics: JSON.parse(JSON.stringify(result)) as typeof result,
          ...(failed ? { partial_output: {
            kind: "partial", text: redactPartialText(partialText),
            received_chars: textChars, retained_chars: partialText.length,
            limit_chars: PARTIAL_TEXT_CHARS, truncated: textChars > partialText.length,
            character_unit: "UTF-16 code units", redacted: true,
          } } : {}),
        };
      } catch { return {}; }
    },
  };
}

export type StreamDiagnostics = ReturnType<typeof createStreamDiagnostics>;
