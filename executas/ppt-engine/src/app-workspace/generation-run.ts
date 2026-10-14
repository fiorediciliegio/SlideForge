import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type AppGenerationRunKind = "deck-generation" | "page-refinement" | "deck-refinement";
export type AppGenerationRunState = "preparing" | "active" | "committing" | "committed" | "abandoned";

export interface AppGenerationRunTransaction {
  schema_version: 1;
  run_id: string;
  workspace_id: string;
  run_kind: AppGenerationRunKind;
  state: AppGenerationRunState;
  official_workspace_dir: string;
  shadow_workspace_dir: string;
  previous_workspace_dir: string;
  origin_page_id: string | null;
  created_at: string;
  updated_at: string;
}

const queues = new Map<string, Promise<unknown>>();
const workspaceQueues = new Map<string, Promise<unknown>>();

const TRANSIENT_FILESYSTEM_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
export const FILESYSTEM_RETRY_DELAYS_MS = [
  50, 100, 200, 400, 800, 1200, 1600, 2000,
  2500, 3000, 3500, 4000, 4500,
];

export function isTransientFilesystemError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      TRANSIENT_FILESYSTEM_ERRORS.has(error.code),
  );
}

/**
 * Windows may keep a recently uploaded/rendered file open briefly. Retry
 * directory moves so a transient host-upload, browser, or antivirus lock
 * does not turn an otherwise valid generation commit into a failed save.
 */
export async function renameWithFilesystemRetry(source: string, destination: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= FILESYSTEM_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientFilesystemError(error) || attempt === FILESYSTEM_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, FILESYSTEM_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}

export async function removeWithFilesystemRetry(target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= FILESYSTEM_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientFilesystemError(error) || attempt === FILESYSTEM_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, FILESYSTEM_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}

export async function publishShadowWorkspace(transaction: {
  shadow_workspace_dir: string;
  official_workspace_dir: string;
}): Promise<void> {
  try {
    await renameWithFilesystemRetry(transaction.shadow_workspace_dir, transaction.official_workspace_dir);
    return;
  } catch (error) {
    if (!isTransientFilesystemError(error)) throw error;
  }

  // A file inside the shadow tree may still be open by host/upload or Chrome.
  // Copying into a fresh sibling gives Windows a new, unlocked tree to publish.
  const replacement = path.join(path.dirname(transaction.shadow_workspace_dir), "..", "published", path.basename(transaction.official_workspace_dir));
  await removeWithFilesystemRetry(replacement).catch((error) => {
    if (!isNotFoundError(error) && !isTransientFilesystemError(error)) throw error;
  });
  await copyTree(transaction.shadow_workspace_dir, replacement);
  try {
    await renameWithFilesystemRetry(replacement, transaction.official_workspace_dir);
  } catch (error) {
    if (!isTransientFilesystemError(error)) throw error;

    // Some Windows hosts reject directory renames for a newly-created tree as
    // well as the original shadow tree (for example while a scanner observes
    // its preview files). At this point the official Workspace was already
    // moved to `previous`, so materialize the already-copied replacement at
    // the final path without another directory rename. This is deliberately a
    // final fallback: the two earlier rename paths remain atomic when they are
    // available, and the caller restores `previous` if this copy fails.
    // `ensureWorkspaceFiles` creates its requested Workspace directory. A
    // background read that still points at the official path can therefore
    // recreate an empty directory after we moved the old version to
    // `previous`. That old version is safely preserved, so discard any such
    // replacement before materializing the new version.
    await removeWithFilesystemRetry(transaction.official_workspace_dir).catch((destinationError) => {
      if (!isNotFoundError(destinationError)) throw destinationError;
    });
    await copyTree(replacement, transaction.official_workspace_dir);
  }
}

/**
 * A generation/refinement replaces the current deck version. Export records
 * belong to the version that was replaced and must not be carried forward by
 * the shadow Workspace copy.
 */
async function invalidateShadowExportArtifacts(shadowWorkspaceDir: string): Promise<void> {
  const taskPath = path.join(shadowWorkspaceDir, "task.json");
  let task: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(taskPath, "utf8")) as unknown;
    task = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }

  const artifacts = task.artifacts && typeof task.artifacts === "object" && !Array.isArray(task.artifacts)
    ? { ...(task.artifacts as Record<string, unknown>) }
    : {};
  const hadExport = Object.prototype.hasOwnProperty.call(artifacts, "pptx") ||
    Object.prototype.hasOwnProperty.call(artifacts, "pdf");
  if (!hadExport) return;

  delete artifacts.pptx;
  delete artifacts.pdf;
  await writeFile(taskPath, `${JSON.stringify({ ...task, artifacts }, null, 2)}\n`, "utf8");
}

export async function withGenerationWorkspaceLock<T>(workspaceDir: string, operation: () => Promise<T>): Promise<T> {
  const previous = workspaceQueues.get(workspaceDir) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  workspaceQueues.set(workspaceDir, current);
  try { return await current; } finally {
    if (workspaceQueues.get(workspaceDir) === current) workspaceQueues.delete(workspaceDir);
  }
}

function runRoot(workspaceRoot: string, runId: string) {
  return path.join(workspaceRoot, ".generation-runs", runId);
}

async function reserveGenerationRunId(workspaceRoot: string): Promise<string> {
  await mkdir(path.join(workspaceRoot, ".generation-runs"), { recursive: true });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const runId = randomBytes(6).toString("hex");
    try {
      // Reserve atomically: a collision must never reuse another run's files.
      await mkdir(runRoot(workspaceRoot, runId));
      return runId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not reserve a unique generation run directory after 10 attempts");
}

function transactionPath(workspaceRoot: string, runId: string) {
  return path.join(runRoot(workspaceRoot, runId), "transaction.json");
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

async function cleanupOrphanGenerationRun(workspaceRoot: string, runId: string): Promise<void> {
  await rm(runRoot(workspaceRoot, runId), { recursive: true, force: true }).catch(() => undefined);
}

async function atomicWriteJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(runId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(runId, current);
  try {
    return await current;
  } finally {
    if (queues.get(runId) === current) queues.delete(runId);
  }
}

/** Auxiliary image writes must not outlive their shadow generation transaction. */
export async function withActiveGenerationWorkspace<T>(
  workspaceRoot: string,
  workspaceDir: string,
  operation: (runId?: string) => Promise<T>,
): Promise<T> {
  if (path.dirname(workspaceDir) === workspaceRoot) {
    return withGenerationWorkspaceLock(workspaceDir, () => operation());
  }
  const parts = path.relative(workspaceRoot, workspaceDir).split(path.sep);
  if (parts.length !== 4 || parts[0] !== ".generation-runs" || parts[2] !== "shadow") {
    throw new Error("Image descriptions require an official or active shadow Workspace");
  }
  return withRunLock(parts[1]!, async () => {
    const transaction = await readGenerationRun(workspaceRoot, parts[1]!);
    if (transaction.state !== "active" || transaction.shadow_workspace_dir !== workspaceDir) {
      throw new Error("Image description generation run is no longer active");
    }
    return operation(transaction.run_id);
  });
}

export async function readGenerationRun(workspaceRoot: string, runId: string): Promise<AppGenerationRunTransaction> {
  const value = JSON.parse(await readFile(transactionPath(workspaceRoot, runId), "utf8")) as AppGenerationRunTransaction;
  if (value.schema_version !== 1 || value.run_id !== runId) throw new Error("Invalid generation transaction record");
  return value;
}

async function updateState(workspaceRoot: string, transaction: AppGenerationRunTransaction, state: AppGenerationRunState) {
  const next = { ...transaction, state, updated_at: new Date().toISOString() };
  await atomicWriteJson(transactionPath(workspaceRoot, transaction.run_id), next);
  return next;
}

export async function beginGenerationRun(input: {
  workspace_root: string;
  official_workspace_dir: string;
  workspace_id: string;
  run_kind: AppGenerationRunKind;
  origin_page_id?: string | null;
}): Promise<AppGenerationRunTransaction> {
  const runId = await reserveGenerationRunId(input.workspace_root);
  const root = runRoot(input.workspace_root, runId);
  const basename = path.basename(input.official_workspace_dir);
  const now = new Date().toISOString();
  const transaction: AppGenerationRunTransaction = {
    schema_version: 1,
    run_id: runId,
    workspace_id: input.workspace_id,
    run_kind: input.run_kind,
    state: "preparing",
    official_workspace_dir: input.official_workspace_dir,
    shadow_workspace_dir: path.join(root, "shadow", basename),
    previous_workspace_dir: path.join(root, "previous", basename),
    origin_page_id: input.origin_page_id?.trim() || null,
    created_at: now,
    updated_at: now,
  };
  await atomicWriteJson(transactionPath(input.workspace_root, runId), transaction);
  return transaction;
}

/**
 * Whole-Workspace copy shared by shadow runs and user-visible duplication.
 * Reflink first so a copy stays cheap on filesystems that support it.
 */
export async function copyTree(source: string, destination: string): Promise<void> {
  const info = await lstat(source);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) await copyTree(path.join(source, entry), path.join(destination, entry));
    return;
  }
  if (info.isSymbolicLink()) throw new Error(`Workspace copy cannot include symbolic link: ${source}`);
  if (!info.isFile()) throw new Error(`Workspace copy cannot include special file: ${source}`);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await copyFile(source, destination, fsConstants.COPYFILE_FICLONE);
  } catch {
    await copyFile(source, destination);
  }
}

/** Rewrites absolute Workspace paths recorded inside copied text artifacts. */
export async function rebaseTextTree(root: string, from: string, to: string): Promise<void> {
  const escapedFrom = JSON.stringify(from).slice(1, -1);
  const escapedTo = JSON.stringify(to).slice(1, -1);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await rebaseTextTree(entryPath, from, to);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = await readFile(entryPath);
    if (bytes.includes(0)) continue;
    const content = bytes.toString("utf8");
    if (!content.includes(from) && !content.includes(escapedFrom)) continue;
    await writeFile(
      entryPath,
      content.split(from).join(to).split(escapedFrom).join(escapedTo),
      "utf8",
    );
  }
}

export async function prepareGenerationRun(workspaceRoot: string, runId: string): Promise<AppGenerationRunTransaction> {
  let transaction = await readGenerationRun(workspaceRoot, runId);
  if (transaction.state === "abandoned") return transaction;
  if (transaction.state !== "preparing") throw new Error(`Generation run cannot be prepared from ${transaction.state}`);
  await rm(transaction.shadow_workspace_dir, { recursive: true, force: true });
  await copyTree(transaction.official_workspace_dir, transaction.shadow_workspace_dir);
  await rebaseTextTree(transaction.shadow_workspace_dir, transaction.official_workspace_dir, transaction.shadow_workspace_dir);
  return withRunLock(runId, async () => {
    transaction = await readGenerationRun(workspaceRoot, runId);
    if (transaction.state === "abandoned") return transaction;
    return updateState(workspaceRoot, transaction, "active");
  });
}

export async function abandonGenerationRun(workspaceRoot: string, runId: string): Promise<AppGenerationRunTransaction> {
  return withRunLock(runId, async () => {
    const transaction = await readGenerationRun(workspaceRoot, runId);
    if (transaction.state === "abandoned") return transaction;
    if (transaction.state === "committing" || transaction.state === "committed") {
      throw new Error("生成结果已进入提交阶段，无法停止。");
    }
    return updateState(workspaceRoot, transaction, "abandoned");
  });
}

export async function commitGenerationRun(workspaceRoot: string, runId: string): Promise<AppGenerationRunTransaction> {
  return withRunLock(runId, async () => {
    let transaction = await readGenerationRun(workspaceRoot, runId);
    if (transaction.state !== "active") throw new Error(`Generation run cannot commit from ${transaction.state}`);
    transaction = await updateState(workspaceRoot, transaction, "committing");
    try {
      await rebaseTextTree(transaction.shadow_workspace_dir, transaction.shadow_workspace_dir, transaction.official_workspace_dir);
      await invalidateShadowExportArtifacts(transaction.shadow_workspace_dir);
      const officialLog = path.join(transaction.official_workspace_dir, ".log");
      const shadowLog = path.join(transaction.shadow_workspace_dir, ".log");
      await rm(shadowLog, { recursive: true, force: true });
      try { await copyTree(officialLog, shadowLog); } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
      await mkdir(path.dirname(transaction.previous_workspace_dir), { recursive: true });
      await renameWithFilesystemRetry(transaction.official_workspace_dir, transaction.previous_workspace_dir);
      await publishShadowWorkspace(transaction);
      return updateState(workspaceRoot, transaction, "committed");
    } catch (error) {
      let restored = false;
      let officialWorkspaceWasUntouched = false;
      try {
        await lstat(transaction.previous_workspace_dir);
        await rm(transaction.official_workspace_dir, { recursive: true, force: true });
        await rename(transaction.previous_workspace_dir, transaction.official_workspace_dir);
        restored = true;
      } catch (recoveryError) {
        if (isNotFoundError(recoveryError)) {
          try {
            await lstat(transaction.official_workspace_dir);
            officialWorkspaceWasUntouched = true;
          } catch {
            // Recovery is retried on startup when neither directory is available.
          }
        }
      }
      if (restored || officialWorkspaceWasUntouched) {
        await updateState(workspaceRoot, transaction, "abandoned");
      }
      throw error;
    }
  });
}

export async function cleanupGenerationRun(workspaceRoot: string, runId: string): Promise<boolean> {
  return withRunLock(runId, async () => {
    const transaction = await readGenerationRun(workspaceRoot, runId);
    // Failed and abandoned runs are diagnostic artifacts. Only a successfully
    // published run is disposable without losing the state that produced an
    // error report.
    if (transaction.state !== "committed") return false;
    try {
      await removeWithFilesystemRetry(runRoot(workspaceRoot, runId));
      return true;
    } catch (error) {
      // A host upload can still hold a derived preview briefly on Windows.
      // Leave the run for startup recovery instead of masking the primary
      // commit result with a secondary cleanup failure.
      if (!isTransientFilesystemError(error)) throw error;
      return false;
    }
  });
}

export async function findGenerationRunForWorkspace(workspaceRoot: string, workspaceId: string): Promise<AppGenerationRunTransaction | null> {
  const runs = await listGenerationRunsForWorkspace(workspaceRoot, workspaceId);
  return runs.find((transaction) =>
    transaction.state === "preparing" ||
    transaction.state === "active" ||
    transaction.state === "committing"
  ) ?? null;
}

export async function listGenerationRunsForWorkspace(
  workspaceRoot: string,
  workspaceId: string,
): Promise<AppGenerationRunTransaction[]> {
  const root = path.join(workspaceRoot, ".generation-runs");
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const runs: AppGenerationRunTransaction[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const transaction = await readGenerationRun(workspaceRoot, entry.name);
      if (transaction.workspace_id === workspaceId) runs.push(transaction);
    } catch (error) {
      if (isNotFoundError(error)) await cleanupOrphanGenerationRun(workspaceRoot, entry.name);
      // Invalid transaction records remain available for diagnostics.
    }
  }
  return runs.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function recoverGenerationRunForWorkspace(workspaceRoot: string, workspaceId: string): Promise<AppGenerationRunTransaction | null> {
  const root = path.join(workspaceRoot, ".generation-runs");
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return null; }
  const active: AppGenerationRunTransaction[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let transaction: AppGenerationRunTransaction;
    try {
      transaction = await readGenerationRun(workspaceRoot, entry.name);
    } catch (error) {
      if (isNotFoundError(error)) await cleanupOrphanGenerationRun(workspaceRoot, entry.name);
      continue;
    }
    if (transaction.workspace_id !== workspaceId) continue;
    if (transaction.state === "active") {
      active.push(transaction);
      continue;
    }
    if (transaction.state === "preparing") {
      await updateState(workspaceRoot, transaction, "abandoned");
      continue;
    }
    if (transaction.state === "committing") {
      let restored = false;
      let officialWorkspaceWasUntouched = false;
      try {
        await lstat(transaction.previous_workspace_dir);
        await rm(transaction.official_workspace_dir, { recursive: true, force: true });
        await rename(transaction.previous_workspace_dir, transaction.official_workspace_dir);
        restored = true;
      } catch (recoveryError) {
        if (isNotFoundError(recoveryError)) {
          try {
            await lstat(transaction.official_workspace_dir);
            officialWorkspaceWasUntouched = true;
          } catch {
            // Leave the transaction committing so a later recovery can retry.
          }
        }
      }
      if (restored || officialWorkspaceWasUntouched) {
        await updateState(workspaceRoot, transaction, "abandoned");
      }
      continue;
    }
    if (transaction.state === "committed") {
      await removeWithFilesystemRetry(runRoot(workspaceRoot, transaction.run_id)).catch((error) => {
        if (!isTransientFilesystemError(error)) throw error;
      });
    }
  }
  return active.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
}

export async function deleteGenerationRunsForWorkspace(
  workspaceRoot: string,
  workspaceId: string,
): Promise<void> {
  const runs = await listGenerationRunsForWorkspace(workspaceRoot, workspaceId);
  const blocking = runs.find((transaction) =>
    transaction.state === "preparing" ||
    transaction.state === "active" ||
    transaction.state === "committing"
  );
  if (blocking) throw new Error("An active generation run must be stopped before deleting this workspace.");
  await Promise.all(runs.map((transaction) =>
    withRunLock(transaction.run_id, () => removeWithFilesystemRetry(runRoot(workspaceRoot, transaction.run_id)))
  ));
}
