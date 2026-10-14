import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { PageRegenerationBatch } from "./types.js";

export function batchDirectory(workspaceDir: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid regeneration batch id");
  return path.join(workspaceDir, ".page-regenerations", id);
}

export function candidateDirectory(workspaceDir: string, batchId: string, candidateId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(candidateId)) throw new Error("Invalid regeneration candidate id");
  return path.join(batchDirectory(workspaceDir, batchId), "candidates", candidateId);
}

export async function writeBatch(workspaceDir: string, batch: PageRegenerationBatch): Promise<void> {
  const directory = batchDirectory(workspaceDir, batch.id);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(batch, null, 2));
    await rename(temporary, path.join(directory, "batch.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readBatch(workspaceDir: string, id: string): Promise<PageRegenerationBatch> {
  const batch = JSON.parse(await readFile(path.join(batchDirectory(workspaceDir, id), "batch.json"), "utf8")) as PageRegenerationBatch;
  if (batch.id !== id) throw new Error("Regeneration batch identity mismatch");
  if (!/^page-[0-9a-f-]{36}$/.test(batch.page_id) || !Array.isArray(batch.candidates)
    || batch.candidates.length < 1 || batch.candidates.length > 10) throw new Error("Invalid regeneration batch");
  for (const candidate of batch.candidates) {
    const root = batch.status === "adopted"
      ? path.join(workspaceDir, "output", "page-regenerations", batch.page_id, batch.id)
      : candidateDirectory(workspaceDir, batch.id, candidate.id);
    const expectedSource = batch.status === "adopted" ? path.join(workspaceDir, "slides", `${batch.page_id}.html`)
      : path.join(root, "slides", `${batch.page_id}.html`);
    if (candidate.source_path && candidate.source_path !== expectedSource) throw new Error("Invalid candidate source path");
    for (const file of [candidate.html_path, candidate.screenshot_path]) {
      if (!file) continue;
      const relative = path.relative(root, file);
      if (!path.isAbsolute(file) || !relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Candidate artifact is outside its directory");
    }
  }
  return batch;
}

const queues = new Map<string, Promise<unknown>>();
export async function withBatchLock<T>(workspaceDir: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(workspaceDir);
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(key, current);
  try { return await current; } finally { if (queues.get(key) === current) queues.delete(key); }
}

export async function latestBatch(workspaceDir: string, pageId: string, mode?: "regenerate" | "beautify"): Promise<PageRegenerationBatch | null> {
  const root = path.join(workspaceDir, ".page-regenerations");
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const batches = await Promise.all(names.filter((name) => /^[0-9a-f-]{36}$/.test(name)).map(async (id) => {
    try { return await readBatch(workspaceDir, id); }
    catch (error) {
      // A process can exit while capturing beautification input, before the
      // batch record is published. Such a directory is not an available batch.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }));
  return batches.filter((batch): batch is PageRegenerationBatch => Boolean(batch))
    .filter((batch) => batch.page_id === pageId && batch.status !== "adopted" && (!mode || (batch.mode ?? "regenerate") === mode))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

export function fingerprint(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

// A small publication journal protects only the files being replaced. It is
// never a second Workspace and does not provide a user-visible rollback flow.
const JOURNAL = ".page-regeneration-publication";
interface JournalEntry { relative: string; existed: boolean }
function containedFile(workspaceDir: string, relative: string): string {
  const target = path.resolve(workspaceDir, relative);
  const checked = path.relative(workspaceDir, target);
  if (!checked || checked.startsWith("..") || path.isAbsolute(checked)) throw new Error("Publication path is outside Workspace");
  return target;
}

export function recoverPageRegenerationPublication(workspaceDir: string): void {
  const directory = path.join(workspaceDir, JOURNAL);
  if (!existsSync(directory)) return;
  if (!existsSync(path.join(directory, "committed")) && existsSync(path.join(directory, "journal.json"))) {
    const entries = JSON.parse(readFileSync(path.join(directory, "journal.json"), "utf8")) as JournalEntry[];
    entries.forEach((entry, index) => {
      const target = containedFile(workspaceDir, entry.relative);
      if (entry.existed) {
        const temporary = path.join(path.dirname(target), `.recover-${randomUUID()}`);
        writeFileSync(temporary, readFileSync(path.join(directory, `${index}.previous`)));
        renameSync(temporary, target);
      } else rmSync(target, { force: true });
    });
  }
  rmSync(directory, { recursive: true, force: true });
}

export function publishPageRegenerationFiles(workspaceDir: string, files: Map<string, string | Buffer | null>): void {
  recoverPageRegenerationPublication(workspaceDir);
  const directory = path.join(workspaceDir, JOURNAL);
  mkdirSync(directory);
  const entries: JournalEntry[] = [];
  try {
    for (const [relative, content] of files) {
      const target = containedFile(workspaceDir, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      const index = entries.length;
      const existed = existsSync(target);
      if (existed) writeFileSync(path.join(directory, `${index}.previous`), readFileSync(target));
      if (content !== null) writeFileSync(path.join(directory, `${index}.next`), content);
      entries.push({ relative, existed });
    }
    writeFileSync(path.join(directory, "journal.next"), JSON.stringify(entries));
    renameSync(path.join(directory, "journal.next"), path.join(directory, "journal.json"));
    // No awaits between replacements: other operations in this engine process
    // cannot observe an intermediate publication. A process exit is recovered.
    entries.forEach((entry, index) => {
      const target = containedFile(workspaceDir, entry.relative);
      if (files.get(entry.relative) === null) rmSync(target, { force: true });
      else renameSync(path.join(directory, `${index}.next`), target);
    });
    writeFileSync(path.join(directory, "committed"), "true");
  } catch (error) {
    recoverPageRegenerationPublication(workspaceDir);
    throw error;
  }
  // Publication already succeeded; cleanup can be retried when reopened.
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* next open */ }
}
