import { diagnosticId, type SessionTraceContext } from "../../agent/sessionTrace";
import { isDiagnosticLoggingEnabled } from "../../runtime/diagnosticLogging";
import { redactDiagnosticValue } from "../../../executas/ppt-engine/src/diagnostics/redact";
import type { UserTemplateLogChannel } from "../../../executas/ppt-engine/src/user-templates/diagnostics";
import type { UserTemplateBackend } from "./types";

const activeFlushes = new Map<string, Set<() => Promise<void>>>();
const activeWrites = new Map<string, Set<Promise<unknown>>>();

/** Flush a finite cut of received frames; active generation may keep running. */
export async function flushUserTemplateDiagnostics(id: string) {
  await Promise.allSettled([...(activeFlushes.get(id) ?? [])].map((flush) => flush()));
  await Promise.allSettled([...(activeWrites.get(id) ?? [])]);
}

export function createUserTemplateDiagnostics(backend: UserTemplateBackend, id: string, creationRunId: string) {
  const enabled = backend.diagnosticLoggingEnabled ?? isDiagnosticLoggingEnabled();
  const context = { template_id: id, creation_run_id: creationRunId };
  let failedWrites = 0;
  const write = async (channel: UserTemplateLogChannel, entry: Record<string, unknown>) => {
    if (!enabled) return;
    const pending = backend.appendUserTemplateLog({
      id, channel,
      entry: { ...context, ...redactDiagnosticValue(entry) as Record<string, unknown>, prior_failed_log_writes: failedWrites },
      payload_keys: ["request", "response", "output", "partial_output", "error", "frames", "result", "stream_diagnostics"],
    });
    const writes = activeWrites.get(id) ?? new Set();
    activeWrites.set(id, writes); writes.add(pending);
    try { const result = await pending; if (!result.appended) throw new Error("Template log was not appended"); }
    catch (error) { failedWrites += 1; throw error; }
    finally { writes.delete(pending); if (!writes.size && activeWrites.get(id) === writes) activeWrites.delete(id); }
  };
  return {
    async event(event: string, extra: Record<string, unknown> = {}) {
      try { await write("user-template", { event, timestamp: new Date().toISOString(), ...extra }); }
      catch { /* Preserve the business result. */ }
    },
    session(stage: string, pageNumber?: number): SessionTraceContext {
      return {
        context: { ...context, operation_id: diagnosticId(stage), stage, page_number: pageNumber },
        sink: {
          enabled, write,
          registerFlush(flush) {
            const flushes = activeFlushes.get(id) ?? new Set();
            activeFlushes.set(id, flushes); flushes.add(flush);
            return () => { flushes.delete(flush); if (!flushes.size && activeFlushes.get(id) === flushes) activeFlushes.delete(id); };
          },
        },
      };
    },
    flush: () => flushUserTemplateDiagnostics(id),
  };
}
