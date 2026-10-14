import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

function mirrorFor(job: {
  aps_path: string | null;
  aps_meta_path: string | null;
  source_updated_at: string | null;
  source_sha256: string | null;
  snapshot_size_bytes: number | null;
}) {
  assert.ok(job.source_sha256);
  return {
    provider: "aps.files" as const,
    scope: "user" as const,
    path: job.aps_path ?? "workspaces/test/snapshots/test.zip",
    etag: "test-etag",
    size_bytes: job.snapshot_size_bytes ?? 1,
    content_type: "application/zip",
    source_updated_at: job.source_updated_at ?? "2026-09-17T00:00:00.000Z",
    source_sha256: job.source_sha256,
    published_at: "2026-09-17T00:00:00.000Z",
    meta_path: job.aps_meta_path ?? "workspaces/test/meta.json",
    meta_etag: "test-meta-etag",
  };
}

test("retry budget is durable per change, clears for a new edit, and never lets N commit erase N+1", async () => {
  const api = await import("../../src/app-workspace/index.ts");
  const snapshot = await import("../../src/app-workspace/snapshot-sync.ts");
  const workspace = await api.createAppWorkspace({ title: "Snapshot retry budget" });

  // A new authoritative edit starts change N's budget at zero.
  await api.updateAppWorkspaceTitle({ workspace_dir: workspace.workspace_dir, title: "N" });
  const dirtyN = await snapshot.getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.ok(dirtyN?.pending_change_seq !== null);

  const retry1 = await snapshot.recordWorkspaceSnapshotRetry({
    workspace_dir: workspace.workspace_dir,
    phase: "generation",
    error: "tree changed while packaging",
  });
  assert.equal(retry1.change_seq, dirtyN?.change_seq);
  assert.equal(retry1.attempts, 1);
  assert.equal(retry1.exhausted, false);
  assert.ok(retry1.next_retry_at);

  // A successful ZIP has covered N, so it settles the delay/error but keeps
  // the attempt count. A later upload failure for the same edit spends the
  // next attempt instead of getting a fresh budget.
  await api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir });
  const generatedN = await snapshot.getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.equal(generatedN?.retry?.change_seq, dirtyN?.change_seq);
  assert.equal(generatedN?.retry?.attempts, 1);
  assert.equal(generatedN?.retry?.phase, null);
  assert.equal(generatedN?.retry?.next_retry_at, null);

  const retry2 = await snapshot.recordWorkspaceSnapshotRetry({
    workspace_dir: workspace.workspace_dir,
    phase: "upload",
    error: "APS temporarily unavailable",
  });
  assert.equal(retry2.attempts, 2);
  const uploadN = await snapshot.startWorkspaceSnapshotPublish({ workspace_dir: workspace.workspace_dir });
  assert.equal(uploadN.change_seq, retry2.change_seq);

  // N+1 is generated and encounters a retry while N is still in flight.
  // N's acknowledgement must only clear its own budget.
  await api.updateAppWorkspaceTitle({ workspace_dir: workspace.workspace_dir, title: "N+1" });
  await api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir });
  const retryNPlus1 = await snapshot.recordWorkspaceSnapshotRetry({
    workspace_dir: workspace.workspace_dir,
    phase: "upload",
    error: "APS temporarily unavailable for N+1",
  });
  assert.notEqual(retryNPlus1.change_seq, uploadN.change_seq);

  await snapshot.commitWorkspaceSnapshotPublish({
    workspace_dir: workspace.workspace_dir,
    expected_job_id: uploadN.job_id,
    expected_updated_at: uploadN.source_updated_at,
    expected_sha256: uploadN.source_sha256 ?? "",
    mirror: mirrorFor(uploadN),
  });
  const afterNCommit = await snapshot.getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.equal(afterNCommit?.retry?.change_seq, retryNPlus1.change_seq);
  assert.equal(afterNCommit?.retry?.attempts, retryNPlus1.attempts);

  // Exhaustion is finite for this change; a later edit always opens a fresh
  // budget and is therefore recoverable after a process restart as well.
  await snapshot.recordWorkspaceSnapshotRetry({ workspace_dir: workspace.workspace_dir, phase: "upload", error: "fail 2" });
  await snapshot.recordWorkspaceSnapshotRetry({ workspace_dir: workspace.workspace_dir, phase: "upload", error: "fail 3" });
  const exhausted = await snapshot.recordWorkspaceSnapshotRetry({
    workspace_dir: workspace.workspace_dir,
    phase: "upload",
    error: "fail 4",
  });
  assert.equal(exhausted.attempts, 4);
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.next_retry_at, null);

  const dirtyNPlus2 = await snapshot.markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
  assert.equal(dirtyNPlus2.retry, null);
  assert.ok(dirtyNPlus2.change_seq > exhausted.change_seq);
});

test("snapshot collection waits for the workspace swap/edit coordinator", async () => {
  const api = await import("../../src/app-workspace/index.ts");
  const generation = await import("../../src/app-workspace/generation-run.ts");
  const workspace = await api.createAppWorkspace({ title: "Snapshot workspace boundary" });

  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered: (() => void) | undefined;
  const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
  const blockingMutation = generation.withGenerationWorkspaceLock(workspace.workspace_dir, async () => {
    entered?.();
    await held;
  });
  await enteredLock;

  let generated = false;
  const generationAttempt = api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir })
    .then(() => { generated = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(generated, false, "a ZIP build cannot observe a directory while its replacement is in progress");

  release?.();
  await blockingMutation;
  await generationAttempt;
  assert.equal(generated, true);
});

test("legacy last_synced fields migrate to a stable baseline without fabricating dirty work", async () => {
  const api = await import("../../src/app-workspace/index.ts");
  const snapshot = await import("../../src/app-workspace/snapshot-sync.ts");
  const workspace = await api.createAppWorkspace({ title: "Snapshot baseline migration" });
  await api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir });
  const upload = await snapshot.startWorkspaceSnapshotPublish({ workspace_dir: workspace.workspace_dir });
  await snapshot.commitWorkspaceSnapshotPublish({
    workspace_dir: workspace.workspace_dir,
    expected_job_id: upload.job_id,
    expected_updated_at: upload.source_updated_at,
    expected_sha256: upload.source_sha256 ?? "",
    mirror: mirrorFor(upload),
  });

  // Recreate a schema-v1 state written before the new top-level fields
  // existed. The completed publish job is its only cloud baseline evidence.
  const statePath = path.join(
    path.dirname(workspace.workspace_dir),
    ".snapshot-sync",
    path.basename(workspace.workspace_dir),
    "snapshot-sync.json",
  );
  const legacy = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
  delete legacy.synced_baseline;
  delete legacy.generated_change_seq;
  delete legacy.retry;
  await writeFile(statePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  const migrated = await snapshot.getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.equal(migrated?.synced_baseline?.source_sha256, upload.source_sha256);
  assert.equal(migrated?.generated_change_seq, migrated?.change_seq);
  assert.equal(migrated?.pending_change_seq, null);

  // The next normal writer persists the migrated representation.
  await snapshot.markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
  assert.equal(
    (persisted.synced_baseline as { source_sha256?: string } | undefined)?.source_sha256,
    upload.source_sha256,
  );
});
