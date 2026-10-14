import assert from "node:assert/strict";
import test from "node:test";

function mirrorFor(job: {
  aps_path: string | null;
  aps_meta_path: string | null;
  source_updated_at: string | null;
  source_sha256: string | null;
  snapshot_size_bytes: number | null;
}) {
  assert.ok(job.source_sha256, "a publish job must bind an immutable source fingerprint");
  return {
    provider: "aps.files" as const,
    scope: "user" as const,
    path: job.aps_path ?? "workspaces/test/snapshots/test.zip",
    etag: `snapshot-${job.source_sha256.slice(0, 12)}`,
    size_bytes: job.snapshot_size_bytes ?? 1,
    content_type: "application/zip",
    source_updated_at: job.source_updated_at ?? "2026-09-17T00:00:00.000Z",
    source_sha256: job.source_sha256,
    published_at: "2026-09-17T00:00:00.000Z",
    meta_path: job.aps_meta_path ?? "workspaces/test/meta.json",
    meta_etag: "test-meta-etag",
  };
}

/**
 * Models one ordinary create/edit flow without contacting APS:
 *
 *   title save -> navigation snapshot -> upload N starts -> another title save
 *   -> navigation/background rebuild N+1 -> upload N completes -> N+1 uploads
 *
 * The test's assertions are the contract between the independent trigger
 * owners. A future trigger may be added to this flow, but it may not change a
 * completed upload's frozen fingerprint or erase a newer local snapshot.
 */
test("workspace create flow keeps navigation, local edits, and upload callbacks coherent", async () => {
  const api = await import("../../src/app-workspace/index.ts");
  const snapshot = await import("../../src/app-workspace/snapshot-sync.ts");
  const workspace = await api.createAppWorkspace({ title: "Create flow trigger race" });

  // Trigger 1: the initial user save marks the authoritative tree dirty.
  await api.updateAppWorkspaceTitle({ workspace_dir: workspace.workspace_dir, title: "Draft N" });
  const dirtyN = await snapshot.getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.equal(dirtyN?.pending_change_seq, dirtyN?.change_seq);

  // Trigger 2: navigation and the background pump can both request the same
  // local build. The per-workspace generation queue makes this idempotent.
  await Promise.all([
    api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir }),
    api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir }),
  ]);
  const generatedN = await snapshot.getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.ok(generatedN?.source_sha256);
  assert.equal(generatedN.pending_change_seq, null);

  // Trigger 3: APS starts moving the immutable N package and reports progress.
  const uploadN = await snapshot.startWorkspaceSnapshotPublish({ workspace_dir: workspace.workspace_dir });
  await snapshot.writeWorkspaceSnapshotPublish({
    workspace_dir: workspace.workspace_dir,
    publish: { ...uploadN, status: "uploading", updated_at: "2026-09-17T00:00:01.000Z" },
  });

  // Trigger 4: a later user save and navigation build N+1 while N is in flight.
  await api.updateAppWorkspaceTitle({ workspace_dir: workspace.workspace_dir, title: "Draft N+1" });
  await Promise.all([
    api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir }),
    snapshot.commitWorkspaceSnapshotPublish({
      workspace_dir: workspace.workspace_dir,
      expected_job_id: uploadN.job_id,
      expected_updated_at: uploadN.source_updated_at,
      expected_sha256: uploadN.source_sha256 ?? "",
      mirror: mirrorFor(uploadN),
    }),
  ]);

  const afterNCommit = await snapshot.getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.ok(afterNCommit?.source_sha256);
  assert.notEqual(afterNCommit.source_sha256, uploadN.source_sha256, "the N+1 local snapshot survives N's callback");
  assert.equal(afterNCommit?.synced_baseline?.source_sha256, uploadN.source_sha256, "only N is the stable cloud baseline");
  assert.equal(afterNCommit?.publish?.source_sha256, uploadN.source_sha256, "N's job contract is never rewritten to N+1");
  assert.equal(afterNCommit?.pending_change_seq, null, "the N+1 build covers the later saved edit");

  // Trigger 5: the background pump starts N+1. A late callback from N must be
  // ignored/rejected rather than replacing this newer job.
  const uploadNPlus1 = await snapshot.startWorkspaceSnapshotPublish({ workspace_dir: workspace.workspace_dir });
  assert.notEqual(uploadNPlus1.job_id, uploadN.job_id);
  const staleProgress = await snapshot.writeWorkspaceSnapshotPublish({
    workspace_dir: workspace.workspace_dir,
    publish: { ...uploadN, status: "failed", updated_at: "2026-09-17T00:00:02.000Z" },
  });
  assert.equal(staleProgress.job_id, uploadNPlus1.job_id, "a stale upload callback cannot replace the active job");
  await assert.rejects(
    () => snapshot.commitWorkspaceSnapshotPublish({
      workspace_dir: workspace.workspace_dir,
      expected_job_id: uploadN.job_id,
      expected_updated_at: uploadN.source_updated_at,
      expected_sha256: uploadN.source_sha256 ?? "",
      mirror: mirrorFor(uploadN),
    }),
    /Snapshot publication job changed before it committed/,
  );

  await snapshot.commitWorkspaceSnapshotPublish({
    workspace_dir: workspace.workspace_dir,
    expected_job_id: uploadNPlus1.job_id,
    expected_updated_at: uploadNPlus1.source_updated_at,
    expected_sha256: uploadNPlus1.source_sha256 ?? "",
    mirror: mirrorFor(uploadNPlus1),
  });
  const settled = await snapshot.getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.equal(settled?.synced_baseline?.source_sha256, settled?.source_sha256, "the final cloud baseline reaches N+1");
  assert.equal(settled?.publish?.source_sha256, settled?.source_sha256);
  assert.equal(settled?.publish?.status, "completed");
});
