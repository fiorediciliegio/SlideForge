import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const previousHome = process.env.HOME;
const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
const homeDir = await mkdtemp(path.join(os.tmpdir(), "ppt-snapshot-restore-safety-"));
process.env.HOME = homeDir;
process.env.SLIDEFORGE_WORKSPACE_DIR = path.join(homeDir, "slideforge-workspace");
const api = await import("../../src/app-workspace/index.ts");

after(async () => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
  else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
  await rm(homeDir, { recursive: true, force: true });
});

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

async function holdWindowsFileWithoutDeleteShare(filePath: string): Promise<ChildProcessWithoutNullStreams> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$stream = [System.IO.File]::Open($env:RESTORE_LOCK_TARGET, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); [Console]::WriteLine('READY'); Start-Sleep -Seconds 60; $stream.Dispose()",
    ],
    {
      env: { ...process.env, RESTORE_LOCK_TARGET: filePath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("READY")) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Windows lock helper exited before ready: ${code}`)));
    child.stdout.on("data", onData);
  });
  return child;
}

test("restore preserves the pre-restore Workspace in a job-specific previous directory", async () => {
  const workspace = await api.createAppWorkspace({ title: "Cloud version" });
  const snapshot = await api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir });
  assert.equal(snapshot.status, "generated");
  assert.ok(snapshot.revision);
  assert.ok(snapshot.snapshot_path);
  assert.ok(snapshot.source_sha256);

  await api.updateAppWorkspaceTitle({ workspace_dir: workspace.workspace_dir, title: "Local version" });
  await api.extractAppWorkspaceSnapshotZip({
    workspace_dir: workspace.workspace_dir,
    zip_path: snapshot.snapshot_path,
    revision: snapshot.revision,
    expected_source_sha256: snapshot.source_sha256,
  });
  const restore = await api.startAppWorkspaceRestoreSnapshot({
    workspace_dir: workspace.workspace_dir,
    revision: snapshot.revision,
    source_sha256: snapshot.source_sha256,
    source_updated_at: snapshot.source_updated_at ?? undefined,
    force: true,
  });
  assert.equal(restore.status, "queued");

  const committed = await api.commitAppWorkspaceSnapshotRestore({
    workspace_dir: workspace.workspace_dir,
    expected_sha256: snapshot.source_sha256,
    mirror: restoreMirror(snapshot.source_sha256, snapshot.source_updated_at),
  });
  assert.equal(committed.status, "completed");

  const restoredTask = JSON.parse(await readFile(path.join(workspace.workspace_dir, "task.json"), "utf8")) as { title: string };
  assert.equal(restoredTask.title, "Cloud version");

  const previousRoot = path.join(
    path.dirname(workspace.workspace_dir),
    ".snapshot-restore",
    workspace.workspace_id,
    "previous",
  );
  const previousJobs = await readdir(previousRoot, { withFileTypes: true });
  assert.equal(previousJobs.length, 1);
  assert.equal(previousJobs[0]?.isDirectory(), true);
  const previousTask = JSON.parse(await readFile(path.join(previousRoot, previousJobs[0]!.name, "task.json"), "utf8")) as { title: string };
  assert.equal(previousTask.title, "Local version");
});

test("Windows file lock defers restore without changing the official Workspace", { timeout: 40_000 }, async () => {
  const workspace = await api.createAppWorkspace({ title: "Cloud version under lock" });
  const snapshot = await api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir });
  assert.ok(snapshot.revision && snapshot.snapshot_path && snapshot.source_sha256);

  await api.updateAppWorkspaceTitle({ workspace_dir: workspace.workspace_dir, title: "Local version under lock" });
  await api.extractAppWorkspaceSnapshotZip({
    workspace_dir: workspace.workspace_dir,
    zip_path: snapshot.snapshot_path,
    revision: snapshot.revision,
    expected_source_sha256: snapshot.source_sha256,
  });
  await api.startAppWorkspaceRestoreSnapshot({
    workspace_dir: workspace.workspace_dir,
    revision: snapshot.revision,
    source_sha256: snapshot.source_sha256,
    source_updated_at: snapshot.source_updated_at ?? undefined,
    force: true,
  });

  const lock = await holdWindowsFileWithoutDeleteShare(path.join(workspace.workspace_dir, "task.json"));
  try {
    await assert.rejects(
      () => api.commitAppWorkspaceSnapshotRestore({
        workspace_dir: workspace.workspace_dir,
        expected_sha256: snapshot.source_sha256,
        mirror: restoreMirror(snapshot.source_sha256, snapshot.source_updated_at),
      }),
      /Snapshot restore deferred because the active Workspace is still locked/,
    );
  } finally {
    lock.kill();
  }

  const taskAfterDeferredRestore = JSON.parse(
    await readFile(path.join(workspace.workspace_dir, "task.json"), "utf8"),
  ) as { title: string };
  assert.equal(taskAfterDeferredRestore.title, "Local version under lock");
});
