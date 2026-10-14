import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const previousHome = process.env.HOME;
const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
const homeDir = await mkdtemp(path.join(os.tmpdir(), "ppt-workspace-tombstone-"));
process.env.HOME = homeDir;
process.env.SLIDEFORGE_WORKSPACE_DIR = path.join(homeDir, "slideforge-workspace");
const api = await import("../../src/app-workspace/index.ts");

after(async () => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
  else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
  await rm(homeDir, { recursive: true, force: true });
});

test("local delete writes a tombstone and invalidates an in-flight snapshot publication", async () => {
  const workspace = await api.createAppWorkspace({ title: "Tombstone test" });
  await api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir });
  const publish = await api.startAppWorkspaceSnapshotPublish({ workspace_dir: workspace.workspace_dir });

  const deleted = await api.deleteAppWorkspace({ workspace_dir: workspace.workspace_dir });
  assert.equal(deleted.deleted, true);
  assert.ok(deleted.tombstone.lifecycle_epoch >= 1);
  await assert.rejects(() => stat(workspace.workspace_dir));

  const tombstone = await api.getAppWorkspaceTombstone({ workspace_id: workspace.workspace_id });
  assert.equal(tombstone?.workspace_id, workspace.workspace_id);
  await assert.rejects(
    () => api.commitAppWorkspaceSnapshotPublish({
      workspace_dir: workspace.workspace_dir,
      expected_job_id: publish.job_id,
      expected_updated_at: publish.source_updated_at,
      expected_sha256: publish.source_sha256!,
      mirror: {
        provider: "aps.files",
        scope: "user",
        path: publish.aps_path!,
        etag: "late",
        size_bytes: publish.snapshot_size_bytes!,
        content_type: "application/zip",
        source_updated_at: publish.source_updated_at!,
        source_sha256: publish.source_sha256!,
        fingerprint_algo: publish.fingerprint_algo,
        published_at: new Date().toISOString(),
        meta_path: publish.aps_meta_path!,
        meta_etag: "late-meta",
      },
    }),
    /deleted locally/,
  );

  assert.deepEqual(
    await api.clearAppWorkspaceTombstone({ workspace_id: workspace.workspace_id }),
    { cleared: true },
  );
  assert.equal(
    await api.getAppWorkspaceTombstone({ workspace_id: workspace.workspace_id }),
    null,
  );
});
