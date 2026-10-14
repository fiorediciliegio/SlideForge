import type { PptBackend } from "../../api/pptBackend";
import type {
  AutoRestoreMissingWorkspacesResult,
  ListMyWorkEntry,
  ListWorkspacesResult,
  WorkspaceSnapshotSyncState,
  WorkspaceSummary,
} from "../../api/types";
import { createMyWorkTimingRecord, type MyWorkTimingRecord } from "./myWorkTiming";
import {
  mapWithConcurrencyLimit,
  reconcileWorkspaceCovers,
  WORKSPACE_COVER_CONCURRENCY,
  workspaceDirOf,
  type WorkspaceCovers,
  type WorkspaceCoverState,
} from "./workspaceCovers";

interface LoadMyWorkInput {
  backend: Pick<PptBackend, "listWorkspaces" | "listMyWork" | "getWorkspaceSnapshotSyncState">;
  restoration: Promise<AutoRestoreMissingWorkspacesResult | null> | null;
  isCurrent: () => boolean;
  onList: (scan: ListWorkspacesResult) => void;
  onListError: (error: unknown) => void;
  onCloudWorkspaces: (workspaces: ListMyWorkEntry[]) => void;
  onSyncState: (id: string, state: WorkspaceSnapshotSyncState | null) => void;
  onRestored: (count: number) => void;
  onTiming: (record: MyWorkTimingRecord) => void;
  onBackgroundError: (source: string, error: unknown) => void;
  /**
   * Skips the cloud listing entirely, leaving the previous cloud Workspaces in
   * place. The caller owns the freshness policy; the local scan, covers and sync
   * badges still run.
   */
  skipCloudList?: boolean;
}

/** Local cards and covers never await cloud metadata, restoration or sync badges. */
export async function loadMyWork(input: LoadMyWorkInput): Promise<void> {
  const { backend, isCurrent } = input;
  const listStartedAt = performance.now();
  const listRequest = backend.listWorkspaces();

  if (!input.skipCloudList) {
    void (async () => {
      try {
        const result = await backend.listMyWork();
        if (isCurrent()) input.onCloudWorkspaces(result?.workspaces ?? []);
      } catch (error) {
        input.onBackgroundError("cloud-sync", error);
      }
    })();
  }

  if (input.restoration) {
    void input.restoration.then((result) => {
      const count = result?.restored?.length ?? 0;
      if (count > 0 && isCurrent()) input.onRestored(count);
    }).catch((error) => input.onBackgroundError("cloud-reconcile", error));
  }

  let scan: ListWorkspacesResult;
  try {
    scan = await listRequest;
  } catch (error) {
    if (isCurrent()) input.onListError(error);
    return;
  }
  if (!isCurrent()) return;
  const listMs = performance.now() - listStartedAt;
  input.onList(scan);

  const workspaces = scan.tasks ?? scan.workspaces ?? [];

  void mapWithConcurrencyLimit(workspaces, WORKSPACE_COVER_CONCURRENCY, async (item) => {
    if (!isCurrent()) return;
    let state: WorkspaceSnapshotSyncState | null = null;
    try {
      state = await backend.getWorkspaceSnapshotSyncState({ workspace_dir: workspaceDirOf(item) });
    } catch {
      // A missing/unreadable sync badge does not degrade the local card.
    }
    if (isCurrent()) input.onSyncState(item.workspace_id, state);
  }).catch((error) => input.onBackgroundError("cloud-sync", error));

  if (!isCurrent()) return;
  input.onTiming(createMyWorkTimingRecord({
    listMs,
    coversMs: 0,
    slowestCoverMs: 0,
    workspaceCount: workspaces.length,
    coverCount: 0,
  }));
}
