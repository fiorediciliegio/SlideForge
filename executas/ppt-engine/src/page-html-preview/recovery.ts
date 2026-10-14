import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { readWorkspacePageSnapshot } from "./current-page.js";

export type PageRecoverySource = "original_source" | "manual_base" | "saved_snapshot";
export interface PageRecoveryOption {
  workspace_dir: string;
  page_id: string;
  available: boolean;
  source?: PageRecoverySource;
  recovery_token?: string;
}
export const recoveryHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Capture bytes, including missing files, so confirmation cannot overwrite a later save. */
export async function captureRecoveryFiles(workspaceDir: string, files: string[]) {
  const root = await realpath(workspaceDir);
  const captured = new Map<string, Buffer | null>();
  for (const file of new Set(files)) {
    try {
      const relative = path.relative(root, await realpath(file));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Recovery file is outside Workspace");
      captured.set(file, await readFile(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      captured.set(file, null);
    }
  }
  return captured;
}

/** No await between this check and the existing synchronous publication journal. */
export function assertRecoveryFilesUnchanged(workspaceDir: string, captured: Map<string, Buffer | null>) {
  const root = realpathSync(workspaceDir);
  for (const [file, before] of captured) {
    let after: Buffer | null = null;
    try {
      const relative = path.relative(root, realpathSync(file));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("PAGE_RECOVERY_CONFLICT");
      after = readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (before === null ? after !== null : after === null || !before.equals(after)) throw new Error("PAGE_RECOVERY_CONFLICT");
  }
}

export async function selectPageRecoveryCandidate(input: {
  workspaceDir: string; pageId: string; snapshotPath?: string; sourceOnly?: boolean;
}) {
  const sourcePath = path.join(input.workspaceDir, "slides", `${input.pageId}.html`);
  const source = await readWorkspacePageSnapshot(input.workspaceDir, sourcePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (source?.html.trim()) return { html: source.html, htmlPath: source.htmlPath,
    source: "original_source" as const };
  return null;
}

const queues = new Map<string, Promise<unknown>>();
/** Manual saves and restores share this queue, including validation/preparation. */
export async function withPageRecoveryWriteQueue<T>(workspaceDir: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(workspaceDir);
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(key, current);
  try { return await current; } finally { if (queues.get(key) === current) queues.delete(key); }
}
