import { isDiagnosticLoggingEnabled } from "../diagnostic-logging.js";
import { appendDirectoryDiagnosticLog } from "../diagnostics/log.js";
import { redactDiagnosticValue } from "../diagnostics/redact.js";
import { resolveUserTemplateDirectory } from "./storage.js";

export type UserTemplateLogChannel = "user-template" | "ai-user-template-interactions" | "ai-user-template-stream" | "storage-transport";
const channels = new Set<UserTemplateLogChannel>(["user-template", "ai-user-template-interactions", "ai-user-template-stream", "storage-transport"]);
export interface UserTemplateDiagnosticContext {
  creation_run_id?: string;
  operation_id?: string;
  page_number?: number;
}
export async function appendUserTemplateLog(input: {
  id: string;
  channel: UserTemplateLogChannel;
  entry: Record<string, unknown>;
  payload_keys?: string[];
}) {
  if (!isDiagnosticLoggingEnabled()) return { log_file: "", appended: false };
  if (!channels.has(input.channel)) throw new Error("Unsupported user template log channel");
  const directory = await resolveUserTemplateDirectory(input.id);
  return appendDirectoryDiagnosticLog({
    directory, channel: input.channel,
    entry: { ...redactDiagnosticValue(input.entry) as Record<string, unknown>, schema_version: 1, template_id: input.id },
    payload_keys: input.payload_keys,
  });
}

export async function recordUserTemplateOperation<T>(input: {
  id: string;
  operation: string;
  diagnostic_context?: UserTemplateDiagnosticContext;
  request?: unknown;
}, action: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const log = (status: string, extra: Record<string, unknown> = {}) => appendUserTemplateLog({
    id: input.id, channel: "user-template",
    entry: { event: `template.backend.${status}`, operation: input.operation, ...input.diagnostic_context, status, ...extra },
    payload_keys: ["request", "result", "error"],
  }).catch(() => undefined);
  await log("started", { request: input.request });
  try {
    const result = await action();
    await log("succeeded", { result, duration_ms: Date.now() - started });
    return result;
  } catch (error) {
    await log("failed", { error, duration_ms: Date.now() - started });
    throw error;
  }
}
