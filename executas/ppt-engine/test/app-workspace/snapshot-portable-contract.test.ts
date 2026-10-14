import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createHash } from "node:crypto";

const previousHome = process.env.HOME;
const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
const homeDir = await mkdtemp(path.join(os.tmpdir(), "ppt-snapshot-portable-contract-"));
process.env.HOME = homeDir;
process.env.SLIDEFORGE_WORKSPACE_DIR = path.join(homeDir, "slideforge-workspace");
const api = await import("../../src/app-workspace/index.ts");

after(async () => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
  else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
  await rm(homeDir, { recursive: true, force: true });
});

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function restoreMirror(sourceSha256: string, sourceUpdatedAt: string | null) {
  return {
    provider: "aps.files" as const,
    scope: "user" as const,
    path: "workspaces/test/snapshots/test.zip",
    etag: "test-etag",
    size_bytes: 1,
    content_type: "application/zip",
    source_updated_at: sourceUpdatedAt ?? "",
    source_sha256: sourceSha256,
    downloaded_at: new Date().toISOString(),
  };
}

test("snapshot freezes the full uploaded-source authority set and attachment contract", async () => {
  const workspace = await api.createAppWorkspace({ title: "Attachment contract" });
  const attachment = Buffer.from("original attachment body");
  const filePath = path.join(workspace.workspace_dir, "uploaded-sources", "files", "source.txt");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, attachment);
  await mkdir(path.join(workspace.workspace_dir, "uploaded-sources", "preflight"), { recursive: true });
  await writeFile(path.join(workspace.workspace_dir, "uploaded-sources", "preflight", "source.json"), JSON.stringify({ file_path: filePath }));
  await mkdir(path.join(workspace.workspace_dir, "uploaded-sources", "analysis"), { recursive: true });
  await writeFile(path.join(workspace.workspace_dir, "uploaded-sources", "analysis", "source.json"), JSON.stringify({ analysis_path: filePath }));
  await writeFile(path.join(workspace.workspace_dir, "uploaded-sources", "attachment-context.json"), JSON.stringify({ path: filePath }));
  await writeFile(path.join(workspace.workspace_dir, "uploaded-sources", "index.json"), JSON.stringify({
    version: 1,
    materials: [{
      uploaded_source_id: "source",
      status: "active",
      sha256: sha256(attachment),
      size_bytes: attachment.length,
      file_path: filePath,
    }],
  }));

  const snapshot = await api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir });
  const info = await api.getAppWorkspaceSnapshotInfo({ workspace_dir: workspace.workspace_dir });
  assert.equal(info.manifest.fingerprint_algo, 2);
  assert.equal(info.manifest.attachment_protocol, 1);
  assert.deepEqual(info.manifest.attachments, [{
    content_hash: sha256(attachment),
    size_bytes: attachment.length,
    restore_path: "uploaded-sources/files/source.txt",
  }]);
  assert.ok(info.entries.some((entry: { name: string }) => entry.name === "uploaded-sources/preflight/source.json"));
  assert.ok(info.entries.some((entry: { name: string }) => entry.name === "uploaded-sources/analysis/source.json"));
  assert.ok(info.entries.some((entry: { name: string }) => entry.name === "uploaded-sources/attachment-context.json"));

  await api.extractAppWorkspaceSnapshotZip({
    workspace_dir: workspace.workspace_dir,
    zip_path: snapshot.snapshot_path!,
    revision: snapshot.revision!,
    expected_source_sha256: snapshot.source_sha256,
    expected_fingerprint_algo: 2,
  });
});

test("restore advances lifecycle epoch and rejects an older publish commit", async () => {
  const workspace = await api.createAppWorkspace({ title: "Cloud version" });
  const snapshot = await api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir });
  const publish = await api.startAppWorkspaceSnapshotPublish({ workspace_dir: workspace.workspace_dir });
  await api.updateAppWorkspaceTitle({ workspace_dir: workspace.workspace_dir, title: "Local version" });
  await api.extractAppWorkspaceSnapshotZip({
    workspace_dir: workspace.workspace_dir,
    zip_path: snapshot.snapshot_path!,
    revision: snapshot.revision!,
    expected_source_sha256: snapshot.source_sha256,
    expected_fingerprint_algo: 2,
  });
  const restore = await api.startAppWorkspaceRestoreSnapshot({
    workspace_dir: workspace.workspace_dir,
    revision: snapshot.revision!,
    source_sha256: snapshot.source_sha256,
    source_updated_at: snapshot.source_updated_at ?? undefined,
    fingerprint_algo: 2,
    force: true,
  });
  const committed = await api.commitAppWorkspaceSnapshotRestore({
    workspace_dir: workspace.workspace_dir,
    expected_sha256: snapshot.source_sha256,
    mirror: restoreMirror(snapshot.source_sha256, snapshot.source_updated_at),
  });
  assert.equal(committed.lifecycle_epoch, 1);
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
    /lifecycle changed/,
  );
  const task = JSON.parse(await readFile(path.join(workspace.workspace_dir, "task.json"), "utf8")) as { title: string };
  assert.equal(task.title, "Cloud version");
  assert.equal(restore.status, "queued");
});
