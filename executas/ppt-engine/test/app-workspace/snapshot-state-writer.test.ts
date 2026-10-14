import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function writeValidSinglePageWorkspace(workspaceDir: string, body: string) {
  const pageId = "page-state-writer";
  await mkdir(path.join(workspaceDir, "slides"), { recursive: true });
  await writeFile(path.join(workspaceDir, "slides", `${pageId}.html`), `<!doctype html><body>${body}</body>`, "utf8");
  await writeFile(path.join(workspaceDir, "manifest.json"), JSON.stringify({
    title: "State writer",
    slides: [{ id: pageId, source: `./slides/${pageId}.html` }],
  }), "utf8");
  await writeFile(path.join(workspaceDir, "outline.json"), JSON.stringify({
    version: 3,
    status: "confirmed",
    title: "State writer",
    items: [{ page_id: pageId, title: "Page", core_message: "Message", required_content: "Content" }],
    updated_at: "2026-09-17T00:00:00.000Z",
    confirmed_at: "2026-09-17T00:00:00.000Z",
  }), "utf8");
  await writeFile(path.join(workspaceDir, "page-progress.json"), JSON.stringify({
    status: "completed",
    pages: [{ page_id: pageId, status: "accepted" }],
    updated_at: "2026-09-17T00:00:00.000Z",
  }), "utf8");
}

test("an upload can commit snapshot N while generation writes N+1 without either state being lost", async () => {
  const api = await import("../../src/app-workspace/index.ts");
  const snapshot = await import("../../src/app-workspace/snapshot-sync.ts");
  const workspace = await api.createAppWorkspace({ title: "Snapshot state writer" });
  await writeValidSinglePageWorkspace(workspace.workspace_dir, "first");

  await api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir });
  const firstState = await snapshot.getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.ok(firstState?.source_sha256);
  const firstJob = await snapshot.startWorkspaceSnapshotPublish({ workspace_dir: workspace.workspace_dir });
  assert.equal(firstJob.source_sha256, firstState.source_sha256);

  await writeValidSinglePageWorkspace(workspace.workspace_dir, "second");
  const mirror = {
    provider: "aps.files" as const,
    scope: "user" as const,
    path: firstJob.aps_path ?? "workspaces/test/snapshots/first.zip",
    etag: "test-etag",
    size_bytes: firstJob.snapshot_size_bytes ?? 1,
    content_type: "application/zip",
    source_updated_at: firstJob.source_updated_at ?? "2026-09-17T00:00:00.000Z",
    source_sha256: firstJob.source_sha256 ?? "",
    published_at: "2026-09-17T00:00:00.000Z",
    meta_path: firstJob.aps_meta_path ?? "workspaces/test/meta.json",
    meta_etag: "meta-etag",
  };

  await Promise.all([
    api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir }),
    snapshot.commitWorkspaceSnapshotPublish({
      workspace_dir: workspace.workspace_dir,
      expected_job_id: firstJob.job_id,
      expected_updated_at: firstJob.source_updated_at,
      expected_sha256: firstJob.source_sha256 ?? "",
      mirror,
    }),
  ]);

  const after = await snapshot.getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.ok(after?.source_sha256);
  assert.notEqual(after?.source_sha256, firstJob.source_sha256, "N+1 remains the latest generated snapshot");
  assert.equal(after?.publish?.status, "completed");
  assert.equal(after?.publish?.last_synced_sha256, firstJob.source_sha256, "the stable baseline remains snapshot N");
  assert.equal(after?.publish?.source_sha256, firstJob.source_sha256, "the completed job remains bound to its own ZIP");
  assert.equal(after?.synced_baseline?.source_sha256, firstJob.source_sha256, "the stable baseline is independent of the current job");

  await writeValidSinglePageWorkspace(workspace.workspace_dir, "third");
  const dirty = await snapshot.markWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
  assert.equal(dirty.pending_change_seq, dirty.change_seq, "a saved edit is durably marked before a new ZIP exists");
  await api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir });
  const regenerated = await snapshot.getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.equal(regenerated?.pending_change_seq, null, "a generated ZIP clears the change it covered");
});
