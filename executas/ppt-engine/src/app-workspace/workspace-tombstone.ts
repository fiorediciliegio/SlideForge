import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { getPptWorkspaceRoot } from "../workspace-root.js";

const WORKSPACE_ID_PATTERN = /^ppt-\d{8}-\d{6}$/;
const TOMBSTONE_SCHEMA_VERSION = 1;

export interface WorkspaceTombstone {
  schema_version: 1;
  workspace_id: string;
  deleted_at: string;
  // A deletion is a lifecycle replacement even though no Workspace tree is
  // left. This value is informational until the deleted tree is explicitly
  // restored and starts a new snapshot-sync state.
  lifecycle_epoch: number;
}

function assertWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error("workspace_id must be a ppt-YYYYMMDD-HHmmss directory name");
  }
}

function tombstoneRoot(): string {
  return path.join(getPptWorkspaceRoot(), ".workspace-tombstones");
}

export function workspaceTombstonePath(workspaceId: string): string {
  assertWorkspaceId(workspaceId);
  return path.join(tombstoneRoot(), `${workspaceId}.json`);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function getWorkspaceTombstone(workspaceId: string): Promise<WorkspaceTombstone | null> {
  try {
    const value = JSON.parse(await readFile(workspaceTombstonePath(workspaceId), "utf8")) as Partial<WorkspaceTombstone>;
    const lifecycleEpoch = value.lifecycle_epoch;
    if (value.schema_version !== TOMBSTONE_SCHEMA_VERSION || value.workspace_id !== workspaceId ||
      typeof value.deleted_at !== "string" || !Number.isSafeInteger(lifecycleEpoch) || lifecycleEpoch === undefined || lifecycleEpoch < 1) {
      return null;
    }
    return {
      schema_version: TOMBSTONE_SCHEMA_VERSION,
      workspace_id: workspaceId,
      deleted_at: value.deleted_at,
      lifecycle_epoch: lifecycleEpoch,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeWorkspaceTombstone(input: {
  workspace_id: string;
  lifecycle_epoch?: number;
}): Promise<WorkspaceTombstone> {
  assertWorkspaceId(input.workspace_id);
  const previous = await getWorkspaceTombstone(input.workspace_id);
  const tombstone: WorkspaceTombstone = {
    schema_version: TOMBSTONE_SCHEMA_VERSION,
    workspace_id: input.workspace_id,
    deleted_at: new Date().toISOString(),
    lifecycle_epoch: Math.max(
      previous?.lifecycle_epoch ?? 0,
      Number.isSafeInteger(input.lifecycle_epoch) ? Number(input.lifecycle_epoch) : 0,
    ) + 1,
  };
  await atomicWriteJson(workspaceTombstonePath(input.workspace_id), tombstone);
  return tombstone;
}

export async function clearWorkspaceTombstone(workspaceId: string): Promise<boolean> {
  try {
    await unlink(workspaceTombstonePath(workspaceId));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}
