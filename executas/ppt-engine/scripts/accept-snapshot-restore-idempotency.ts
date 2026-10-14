/**
 * Local acceptance check for the restore idempotency guard fix: a completed
 * restore is only treated as an idempotent skip when the LIVE tree still
 * matches the target snapshot. If files were edited after the restore, a
 * re-requested restore must run again (queue) instead of short-circuiting to
 * "completed" and leaving the edited files in place — the exact bug that made
 * the cloud-priority reconcile report conflict_resolved while the tampered
 * content survived and re-polluted the cloud.
 *
 * Usage: node --import tsx/esm scripts/accept-snapshot-restore-idempotency.ts
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPptWorkspaceRoot } from "../src/workspace-root.ts";
import {
  commitWorkspaceSnapshotRestore,
  extractWorkspaceSnapshotZip,
  maybePublishWorkspaceSnapshot,
  startWorkspaceSnapshotRestore,
  writeWorkspaceSnapshotRestore,
} from "../src/app-workspace/snapshot-sync.ts";

const WORKSPACE_ROOT = getPptWorkspaceRoot();
let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function pptWorkspaceName(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return [
    "ppt",
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join("-");
}

const authoritativeFiles: Record<string, string> = {
  "task.json": JSON.stringify({ workspace_id: "", title: "Idempotency Acceptance" }),
  "requirements.json": JSON.stringify({ brief: "clean" }),
  "outline.json": "{}",
  "page-progress.json": "{}",
  "manifest.json": "{}",
  "visual-master.html": "<html></html>",
  "aesthetic-reference-selections.json": "{}",
  "slides/page-a.html": "<html>slide-a</html>",
};

async function completeRestore(workspaceDir: string, generated: Awaited<ReturnType<typeof maybePublishWorkspaceSnapshot>>, restoreRoot: string): Promise<void> {
  const revision = generated.revision!;
  const sourceSha256 = generated.source_sha256;
  const sourceUpdatedAt = generated.source_updated_at;
  const stagingZip = path.join(restoreRoot, "snapshots", `${revision}.zip`);
  await mkdir(path.dirname(stagingZip), { recursive: true });
  await copyFile(generated.snapshot_path!, stagingZip);
  const extracted = await extractWorkspaceSnapshotZip({
    workspace_dir: workspaceDir,
    zip_path: stagingZip,
    revision,
    expected_source_sha256: sourceSha256,
  });
  await writeWorkspaceSnapshotRestore({
    workspace_dir: workspaceDir,
    restore: {
      revision,
      source_sha256: extracted.restored_source_sha256,
      source_updated_at: extracted.source_updated_at ?? sourceUpdatedAt,
      snapshot_sha256: extracted.snapshot_sha256,
      snapshot_size_bytes: extracted.snapshot_size_bytes,
      file_count: extracted.file_count,
      attachments: extracted.attachments,
      force: true,
    },
  });
  await commitWorkspaceSnapshotRestore({
    workspace_dir: workspaceDir,
    expected_sha256: extracted.restored_source_sha256,
    mirror: {
      provider: "aps.files",
      scope: "user",
      path: `workspaces/${path.basename(workspaceDir)}/snapshots/${revision}.zip`,
      etag: "idempotency-etag",
      size_bytes: extracted.snapshot_size_bytes,
      content_type: "application/zip",
      source_updated_at: extracted.source_updated_at ?? "",
      source_sha256: extracted.restored_source_sha256,
      downloaded_at: new Date().toISOString(),
    },
  });
}

async function main(): Promise<void> {
  const workspaceId = pptWorkspaceName(new Date());
  const workspaceDir = path.join(WORKSPACE_ROOT, workspaceId);
  const snapshotSyncRoot = path.join(WORKSPACE_ROOT, ".snapshot-sync", workspaceId);
  const restoreRoot = path.join(WORKSPACE_ROOT, ".snapshot-restore", workspaceId);

  console.log(`WORKSPACE_ROOT=${WORKSPACE_ROOT}`);
  console.log(`scratch workspace=${workspaceId}`);

  try {
    await mkdir(workspaceDir, { recursive: true });
    for (const [relative, content] of Object.entries(authoritativeFiles)) {
      const absolute = path.join(workspaceDir, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }
    const generated = await maybePublishWorkspaceSnapshot({ workspace_dir: workspaceDir });
    const revision = generated.revision!;
    const sourceSha256 = generated.source_sha256;

    console.log("\n1) tamper, then complete a forced restore (files become clean)");
    await writeFile(path.join(workspaceDir, "requirements.json"), JSON.stringify({ brief: "tampered" }), "utf8");
    const queued = await startWorkspaceSnapshotRestore({
      workspace_dir: workspaceDir,
      revision,
      source_sha256: sourceSha256,
      source_updated_at: generated.source_updated_at,
      force: true,
    });
    check("forced restore queued", queued.status === "queued", queued.status);
    await completeRestore(workspaceDir, generated, restoreRoot);
    check(
      "files clean after restore",
      (await readFile(path.join(workspaceDir, "requirements.json"), "utf8")) === authoritativeFiles["requirements.json"],
    );

    console.log("\n2) untouched workspace: re-start is an idempotent skip (completed)");
    const untouched = await startWorkspaceSnapshotRestore({
      workspace_dir: workspaceDir,
      revision,
      source_sha256: sourceSha256,
      source_updated_at: generated.source_updated_at,
      force: true,
    });
    check("re-start returns completed (idempotent)", untouched.status === "completed", untouched.status);

    console.log("\n3) tamper again: re-start MUST run a real restore (queued), not skip");
    await writeFile(path.join(workspaceDir, "requirements.json"), JSON.stringify({ brief: "tampered-again" }), "utf8");
    const retry = await startWorkspaceSnapshotRestore({
      workspace_dir: workspaceDir,
      revision,
      source_sha256: sourceSha256,
      source_updated_at: generated.source_updated_at,
      force: true,
    });
    check("re-start after tamper returns queued (not completed)", retry.status === "queued", retry.status);

    console.log("\nRESULT");
    if (failures === 0) {
      console.log("  ALL PASS (restore idempotency guard)");
    } else {
      console.log(`  ${failures} FAILED`);
      process.exitCode = 1;
    }
  } finally {
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(snapshotSyncRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(restoreRoot, { recursive: true, force: true }).catch(() => undefined);
    console.log(`\ncleaned scratch workspace ${workspaceId}`);
  }
}

await main();
