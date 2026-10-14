import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const queues = new Map<string, Promise<unknown>>();

/** Serialize append/snapshot operations without initializing a Deck workspace. */
export async function withDiagnosticDirectoryLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(directory) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  queues.set(directory, next);
  try { return await next; }
  finally { if (queues.get(directory) === next) queues.delete(directory); }
}

export async function appendDirectoryDiagnosticLog(input: {
  directory: string;
  channel: string;
  entry: Record<string, unknown>;
  payload_keys?: string[];
  inline_payload_max_bytes?: number;
}) {
  if (!/^[a-z0-9-]+$/.test(input.channel)) throw new Error("Invalid diagnostic channel");
  return withDiagnosticDirectoryLock(input.directory, async () => {
    const logDir = path.join(input.directory, ".log");
    const logFile = path.join(logDir, `${input.channel}.jsonl`);
    const entry: Record<string, unknown> = { timestamp: new Date().toISOString(), ...input.entry };
    const budget = typeof input.inline_payload_max_bytes === "number" && Number.isFinite(input.inline_payload_max_bytes) && input.inline_payload_max_bytes > 0
      ? Math.max(1024, Math.floor(input.inline_payload_max_bytes)) : 64 * 1024;
    await mkdir(logDir, { recursive: true });
    for (const key of input.payload_keys ?? []) {
      if (!Object.prototype.hasOwnProperty.call(entry, key) || entry[key] === undefined) continue;
      const serialized = `${JSON.stringify(entry[key], null, 2)}\n`;
      const size = Buffer.byteLength(serialized, "utf8");
      if (size <= budget) continue;
      const sha256 = createHash("sha256").update(serialized).digest("hex");
      const payloadDir = path.join(logDir, "payloads", input.channel);
      const safeKey = key.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "payload";
      const payloadFile = path.join(payloadDir, `${String(entry.timestamp).replace(/[^a-zA-Z0-9_-]/g, "-")}-${safeKey}-${sha256.slice(0, 16)}.json`);
      await mkdir(payloadDir, { recursive: true });
      await writeFile(payloadFile, serialized, "utf8");
      entry[key] = { __workspace_log_payload: true, path: payloadFile, relative_path: path.relative(input.directory, payloadFile), size, sha256 };
    }
    await appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8");
    return { workspace_dir: input.directory, log_file: logFile, appended: true };
  });
}
