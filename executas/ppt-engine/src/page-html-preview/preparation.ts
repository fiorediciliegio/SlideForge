import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readManualPageRevision } from "../manual-page-revisions/index.js";
import { resolveCurrentPageSnapshot } from "./current-page.js";
import { fingerprintPageSnapshot } from "./snapshot.js";
import { ensurePageThumbnail } from "./thumbnail.js";

export type PagePreviewPreparationStatus = "queued" | "running" | "ready" | "error";
export interface PagePreviewPreparation {
  task_id: string;
  workspace_dir: string;
  page_id: string;
  status: PagePreviewPreparationStatus;
  input_version: string;
  preview_source_fingerprint?: string;
  error?: string;
}

interface Task {
  result: PagePreviewPreparation;
  priority: number;
  snapshotPath?: string;
  thumbnail: boolean;
  htmlPath?: string;
  finishedAt?: number;
}

const tasks = new Map<string, Task>();
const pending: Task[] = [];
let running = false;
let scheduled = false;

function publicResult(task: Task): PagePreviewPreparation {
  return { ...task.result };
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    void runNext();
  });
}

async function runNext() {
  if (running) return;
  pending.sort((a, b) => a.priority - b.priority);
  const task = pending.shift();
  if (!task) return;
  running = true;
  task.result.status = "running";
  try {
    const snapshot = await resolveCurrentPageSnapshot({
      workspaceDir: task.result.workspace_dir,
      pageId: task.result.page_id,
      snapshotPath: task.snapshotPath,
    });
    // A queued task must not publish an answer for a later edit or manifest.
    const version = await currentInputVersion(task.result.workspace_dir, task.result.page_id);
    if (version !== task.result.input_version) throw new Error("Page preview version changed");
    task.result.preview_source_fingerprint = await fingerprintPageSnapshot(
      task.result.workspace_dir, snapshot.htmlPath, snapshot.html);
    if (task.thumbnail) {
      await ensurePageThumbnail({ workspaceDir: task.result.workspace_dir, pageId: task.result.page_id,
        htmlPath: snapshot.htmlPath, expectedFingerprint: task.result.preview_source_fingerprint });
      if (await currentInputVersion(task.result.workspace_dir, task.result.page_id) !== task.result.input_version) {
        throw new Error("Page preview version changed");
      }
    }
    task.htmlPath = snapshot.htmlPath;
    task.result.status = "ready";
  } catch (error) {
    task.result.error = error instanceof Error ? error.message : String(error);
    task.result.status = "error";
  } finally {
    task.finishedAt = Date.now();
    running = false;
    schedule();
  }
}

async function currentInputVersion(workspaceDir: string, pageId: string) {
  const [source, manifest] = await Promise.all([
    readFile(path.join(workspaceDir, "slides", `${pageId}.html`)),
    readFile(path.join(workspaceDir, "manifest.json")),
  ]);
  return createHash("sha256").update(pageId).update(source).update(manifest).digest("hex");
}

/** A fast request boundary: browser work continues after the RPC returns. */
export async function submitPagePreviewPreparation(input: {
  workspaceDir: string; pageId: string; snapshotPath?: string;
  priority?: "foreground" | "background"; kind?: "html" | "thumbnail"; retry?: boolean;
}): Promise<PagePreviewPreparation> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.pageId)) throw new Error("Invalid page_id");
  await readManualPageRevision(input.workspaceDir, input.pageId);
  const version = await currentInputVersion(input.workspaceDir, input.pageId);
  const taskId = createHash("sha256").update(path.resolve(input.workspaceDir)).update("\0")
    .update(input.pageId).update("\0").update(input.kind ?? "html").update("\0").update(version).digest("hex");
  const existing = tasks.get(taskId);
  if (existing && !(input.retry && existing.result.status === "error")) {
    if (existing.result.status === "ready" && existing.htmlPath) {
      const present = await stat(existing.htmlPath).then((info) => info.isFile()).catch(() => false);
      if (present) return publicResult(existing);
    } else {
      if (input.priority === "foreground") existing.priority = 0;
      return publicResult(existing);
    }
  }
  const task: Task = {
    result: { task_id: taskId, workspace_dir: input.workspaceDir, page_id: input.pageId,
      status: "queued", input_version: version },
    priority: input.priority === "background" ? 1 : 0,
    snapshotPath: input.snapshotPath,
    thumbnail: input.kind === "thumbnail",
  };
  tasks.set(taskId, task);
  pending.push(task);
  // Finished entries only support short-lived polling and deduplication.
  for (const [id, item] of tasks) {
    if (item.finishedAt && Date.now() - item.finishedAt > 10 * 60_000) tasks.delete(id);
  }
  schedule();
  return publicResult(task);
}

export function getPagePreviewPreparationStatus(input: { workspaceDir: string; taskId: string }): PagePreviewPreparation {
  const task = tasks.get(input.taskId);
  if (!task || path.resolve(task.result.workspace_dir) !== path.resolve(input.workspaceDir)) {
    throw new Error("Page preview task is no longer available");
  }
  return publicResult(task);
}
