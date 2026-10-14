import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

const seen = new Map<string, number>();
const queues = new Map<string, Promise<unknown>>();
const choices = {
  event: ["preview.fallback", "preview.recovered", "preview.failed", "preview.restored", "preview.restore_failed", "preview.cancelled"],
  error_kind: ["version_changed", "resource_unavailable", "timeout", "missing_snapshot", "render_failed", "unknown", "identity_mismatch"],
  source: ["saved_snapshot", "manual_base", "thumbnail", "retained_frame", "cached_html", "current", "none", "original_source"],
};

/** Always-on, bounded operational warnings. Never accepts HTML, URLs or raw errors. */
export async function appendPreviewRecoveryLog(workspaceDir: string, input: Record<string, unknown>) {
  const entry: Record<string, unknown> = {};
  for (const [field, allowed] of Object.entries(choices)) {
    if (typeof input[field] !== "string" || !allowed.includes(input[field] as string)) throw new Error("Invalid preview recovery event");
    entry[field] = input[field];
  }
  if (typeof input.page_id !== "string" || !/^page-[a-f0-9-]{36}$/.test(input.page_id)) throw new Error("Invalid recovery page id");
  entry.page_id = input.page_id;
  for (const field of ["requested_fingerprint", "actual_fingerprint"]) {
    entry[field] = typeof input[field] === "string" && /^[a-f0-9]{64}$/.test(input[field] as string) ? input[field] : null;
  }
  const logFile = path.join(workspaceDir, ".log", "preview-recovery.jsonl");
  const key = JSON.stringify([workspaceDir, entry]);
  const previous = queues.get(workspaceDir) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    if (Date.now() - (seen.get(key) ?? 0) < 60_000) return { workspace_dir: workspaceDir, log_file: logFile, appended: false };
    await mkdir(path.dirname(logFile), { recursive: true });
    if (await stat(logFile).then((info) => info.size >= 2 * 1024 * 1024).catch(() => false)) {
      await rename(logFile, `${logFile}.previous`);
    }
    await appendFile(logFile, `${JSON.stringify({ timestamp: new Date().toISOString(), workspace_id: path.basename(workspaceDir), ...entry })}\n`);
    seen.set(key, Date.now());
    while (seen.size > 1000) seen.delete(seen.keys().next().value!);
    return { workspace_dir: workspaceDir, log_file: logFile, appended: true };
  });
  queues.set(workspaceDir, operation);
  try { return await operation; } finally { if (queues.get(workspaceDir) === operation) queues.delete(workspaceDir); }
}
