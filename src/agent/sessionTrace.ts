import { redactDiagnosticValue } from "../../executas/ppt-engine/src/diagnostics/redact";

export interface SessionTraceSink {
  enabled: boolean;
  write(channel: "ai-user-template-interactions" | "ai-user-template-stream", entry: Record<string, unknown>): Promise<unknown>;
  registerFlush?(flush: () => Promise<void>): () => void;
}
export interface SessionTraceContext {
  sink: SessionTraceSink;
  context: Record<string, unknown>;
}
export const diagnosticId = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;

export function sessionIdentifiers(value: unknown) {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(["id", "session_id", "sessionId", "app_session_uuid", "appSessionUuid", "run_id", "runId"].flatMap((key) =>
    typeof record[key] === "string" ? [[key, record[key]]] : [],
  ));
}

export async function traceSessionEvent(trace: SessionTraceContext | undefined, event: string, payload: Record<string, unknown>) {
  if (!trace?.sink.enabled) return;
  try {
    await trace.sink.write("ai-user-template-interactions", {
      ...trace.context, timestamp: new Date().toISOString(), event,
      ...redactDiagnosticValue(payload) as Record<string, unknown>,
    });
  } catch { /* Diagnostic failures never change Session execution or retries. */ }
}

/** Records every SDK-delivered frame, independently of normalized UI events. */
export function createSessionRunTrace(trace: SessionTraceContext | undefined, context: Record<string, unknown>) {
  if (!trace?.sink.enabled) return undefined;
  const activeTrace = trace;
  const interactionId = diagnosticId("interaction");
  const base = { ...trace.context, ...context, interaction_id: interactionId };
  const started = performance.now();
  let frames: Record<string, unknown>[] = [];
  let bytes = 0;
  let pendingBytes = 0;
  let received = 0;
  let persisted = 0;
  let recordingErrors = 0;
  let dropped = 0;
  let ended = false;
  let output = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  const missingRanges: Array<{ first: number; last: number; reason: string }> = [];

  function missing(batch: Record<string, unknown>[], reason: string) {
    dropped += batch.length;
    const first = Number(batch[0]?.receive_index), last = Number(batch.at(-1)?.receive_index);
    const previous = missingRanges.at(-1);
    if (previous && previous.last + 1 === first && previous.reason === reason) previous.last = last;
    else missingRanges.push({ first, last, reason });
  }
  function flushBatch() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!frames.length) return;
    const batch = frames;
    const batchBytes = bytes;
    frames = []; bytes = 0;
    // Bound pending memory during a prolonged storage outage. Any gap is
    // explicit in the terminal integrity record; never pretend it is complete.
    if (pendingBytes + batchBytes > 8 * 1024 * 1024) { missing(batch, "queue_capacity"); return; }
    pendingBytes += batchBytes;
    pending = pending.then(async () => {
      try {
        await activeTrace.sink.write("ai-user-template-stream", {
          ...base, event: "session.frames", observation_layer: "session.run.payload",
          first_receive_index: batch[0].receive_index,
          last_receive_index: batch.at(-1)!.receive_index, frames: batch,
        });
        persisted += batch.length;
      } catch { recordingErrors += 1; missing(batch, "write_failed"); }
      finally { pendingBytes -= batchBytes; }
    });
  }
  const flush = async () => { flushBatch(); await pending; };
  const unregister = activeTrace.sink.registerFlush?.(flush);
  return {
    interactionId,
    async start(request: unknown) {
      await traceSessionEvent({ ...activeTrace, context: base }, "session.run.started", { request });
    },
    frame(frame: unknown) {
      if (ended) return;
      const receiveIndex = ++received;
      try {
        // Detach now: the SDK must not mutate a frame while it waits in a batch.
        const raw = JSON.parse(JSON.stringify(redactDiagnosticValue(frame)));
        const entry = { receive_index: receiveIndex, received_at: new Date().toISOString(), elapsed_ms: performance.now() - started, frame: raw };
        frames.push(entry);
        bytes += JSON.stringify(entry).length * 2;
        if (frames.length >= 32 || bytes >= 64 * 1024) flushBatch();
        else timer ??= setTimeout(flushBatch, 250);
      } catch {
        recordingErrors += 1;
        missing([{ receive_index: receiveIndex }], "serialization_failed");
      }
    },
    content(text: string) { if (!ended) output += text; },
    flush,
    async finish(status: string, payload: Record<string, unknown>) {
      if (ended) return;
      ended = true;
      const elapsed = performance.now() - started;
      flushBatch();
      await pending;
      await traceSessionEvent({ ...activeTrace, context: base }, "session.run.finished", {
        status, duration_ms: elapsed, ...payload,
        ...(status === "succeeded" ? { output } : { partial_output: { kind: "partial", text: output } }),
        frame_integrity: { received, persisted, dropped, recording_errors: recordingErrors, missing_ranges: missingRanges, complete: dropped === 0 && persisted === received },
      });
      output = "";
      unregister?.();
    },
  };
}
export type SessionRunTrace = NonNullable<ReturnType<typeof createSessionRunTrace>>;
