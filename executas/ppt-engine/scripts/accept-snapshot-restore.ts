/**
 * Local acceptance check for workspace snapshot RESTORATION state machine
 * (design doc §7, engine side only — no APS download; the download transport
 * runs in example_plugin.js). Asserts local-changes blocking (force), zip
 * validation + extraction to shadow, atomic swap + rollback protection,
 * idempotency, mismatch rejection, and interrupt recovery, then cleans up.
 *
 * Usage: node --import tsx/esm scripts/accept-snapshot-restore.ts
 */
import { appendFile, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPptWorkspaceRoot } from "../src/workspace-root.ts";
import {
  commitWorkspaceSnapshotRestore,
  extractWorkspaceSnapshotZip,
  getWorkspaceSnapshotRestoreStatus,
  getWorkspaceSnapshotSyncState,
  markWorkspaceSnapshotRestoreJobInterrupted,
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
  "task.json": JSON.stringify({ workspace_id: "", title: "Restore Acceptance" }),
  "requirements.json": "{}",
  "outline.json": "{}",
  "page-progress.json": "{}",
  "manifest.json": "{}",
  "visual-master.html": "<html></html>",
  "aesthetic-reference-selections.json": "{}",
  "slides/page-a.html": "<html>slide</html>",
};

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

    console.log("\n1) generate a snapshot to restore FROM");
    const generated = await maybePublishWorkspaceSnapshot({ workspace_dir: workspaceDir });
    check("generation status === generated", generated.status === "generated", generated.status);
    const revision = generated.revision;
    const sourceSha256 = generated.source_sha256;
    const sourceUpdatedAt = generated.source_updated_at;
    check("revision present", revision !== null);

    // Simulate the plugin download: place the snapshot zip in the restore staging dir.
    const stagingZip = path.join(restoreRoot, "snapshots", `${revision}.zip`);
    await mkdir(path.dirname(stagingZip), { recursive: true });
    await copyFile(generated.snapshot_path!, stagingZip);

    console.log("\n2) local unsynchronized change blocks restore without force");
    await appendFile(path.join(workspaceDir, "task.json"), "\n// touched", "utf8");
    const blocked = await startWorkspaceSnapshotRestore({
      workspace_dir: workspaceDir,
      revision: revision!,
      source_sha256: sourceSha256,
      source_updated_at: sourceUpdatedAt,
    });
    check("blocked status === failed", blocked.status === "failed", blocked.status);
    check("blocked error.code === restore_blocked_local_changes", blocked.error?.code === "restore_blocked_local_changes", blocked.error?.code ?? "null");
    check("blocked left official untouched", (await readFile(path.join(workspaceDir, "task.json"), "utf8")).includes("// touched"));

    console.log("\n3) force:true queues a restore");
    const queued = await startWorkspaceSnapshotRestore({
      workspace_dir: workspaceDir,
      revision: revision!,
      source_sha256: sourceSha256,
      source_updated_at: sourceUpdatedAt,
      force: true,
    });
    check("forced status === queued", queued.status === "queued", queued.status);
    check("job_id non-empty", queued.job_id.length > 0);
    check("aps_path set", queued.aps_path === `workspaces/${workspaceId}/snapshots/${revision}.zip`, queued.aps_path ?? "null");
    check("force recorded", queued.force === true);

    console.log("\n4) commit with mismatched expected_sha256 is rejected");
    let mismatchRejected = false;
    try {
      await commitWorkspaceSnapshotRestore({
        workspace_dir: workspaceDir,
        expected_sha256: "0".repeat(64),
        mirror: {
          provider: "aps.files",
          scope: "user",
          path: queued.aps_path!,
          etag: "x",
          size_bytes: 0,
          content_type: "application/zip",
          source_updated_at: "",
          source_sha256: "0".repeat(64),
          downloaded_at: new Date().toISOString(),
        },
      });
    } catch {
      mismatchRejected = true;
    }
    check("mismatched commit rejected", mismatchRejected);

    console.log("\n5) interrupt recovery");
    const failed = await markWorkspaceSnapshotRestoreJobInterrupted({ workspace_dir: workspaceDir });
    check("mark interrupted → failed", failed.status === "failed", failed.status);
    check("interrupted flag set", failed.error?.interrupted === true);
    const restarted = await startWorkspaceSnapshotRestore({
      workspace_dir: workspaceDir,
      revision: revision!,
      source_sha256: sourceSha256,
      source_updated_at: sourceUpdatedAt,
      force: true,
    });
    check("restart after interruption is queued", restarted.status === "queued", restarted.status);

    console.log("\n6) extract the downloaded zip into the shadow");
    const extracted = await extractWorkspaceSnapshotZip({
      workspace_dir: workspaceDir,
      zip_path: stagingZip,
      revision: revision!,
      expected_source_sha256: sourceSha256,
    });
    check("restored_source_sha256 matches", extracted.restored_source_sha256 === sourceSha256);
    check("source_updated_at matches", extracted.source_updated_at === sourceUpdatedAt);
    check("file_count === 8", extracted.file_count === 8, String(extracted.file_count));
    const shadowTask = await readFile(path.join(extracted.shadow_dir, "task.json"), "utf8");
    check("shadow task.json equals snapshot content", shadowTask === authoritativeFiles["task.json"]);
    const shadowSlide = await readFile(path.join(extracted.shadow_dir, "slides", "page-a.html"), "utf8");
    check("shadow slides/page-a.html present", shadowSlide === authoritativeFiles["slides/page-a.html"]);

    // Persist the intermediate extracting state with the snapshot metadata, as the plugin does.
    const extracting = await writeWorkspaceSnapshotRestore({
      workspace_dir: workspaceDir,
      restore: {
        ...restarted,
        status: "extracting",
        snapshot_path: stagingZip,
        source_updated_at: extracted.source_updated_at ?? restarted.source_updated_at,
        source_sha256: extracted.restored_source_sha256,
        snapshot_sha256: extracted.snapshot_sha256,
        snapshot_size_bytes: extracted.snapshot_size_bytes,
        file_count: extracted.file_count,
        attachments: extracted.attachments,
        error: null,
      },
    });
    check("extracting persisted", extracting.status === "extracting", extracting.status);

    console.log("\n7) commit swaps shadow over official and records the restore");
    const mirror = {
      provider: "aps.files" as const,
      scope: "user" as const,
      path: queued.aps_path!,
      etag: "restore-etag-abc",
      size_bytes: extracted.snapshot_size_bytes,
      content_type: "application/zip",
      source_updated_at: extracted.source_updated_at ?? "",
      source_sha256: extracted.restored_source_sha256,
      downloaded_at: new Date().toISOString(),
    };
    const committed = await commitWorkspaceSnapshotRestore({
      workspace_dir: workspaceDir,
      expected_sha256: extracted.restored_source_sha256,
      mirror,
    });
    check("commit status === completed", committed.status === "completed", committed.status);
    check("mirror stored", committed.mirror?.etag === "restore-etag-abc");
    check("last_synced_sha256 recorded", committed.last_synced_sha256 === sourceSha256);
    check("snapshot_path moved into sync store", committed.snapshot_path !== null && committed.snapshot_path.includes(".snapshot-sync"));
    const restoredTask = await readFile(path.join(workspaceDir, "task.json"), "utf8");
    check("official task.json restored (tamper gone)", restoredTask === authoritativeFiles["task.json"], restoredTask.slice(0, 40));
    check("official slides/page-a.html restored", (await readFile(path.join(workspaceDir, "slides", "page-a.html"), "utf8")) === authoritativeFiles["slides/page-a.html"]);

    console.log("\n8) top-level snapshot state re-pointed at the restored content");
    const sync = await getWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
    check("sync status === completed", sync?.status === "completed", sync?.status ?? "null");
    check("sync source_sha256 === restored", sync?.source_sha256 === sourceSha256, sync?.source_sha256?.slice(0, 8) ?? "null");
    check("sync snapshot_path set", sync?.snapshot_path !== null);
    check("publish.last_synced_sha256 === restored", sync?.publish?.last_synced_sha256 === sourceSha256, sync?.publish?.last_synced_sha256?.slice(0, 8) ?? "null");
    const status = await getWorkspaceSnapshotRestoreStatus({ workspace_dir: workspaceDir });
    check("getStatus === completed", status.status === "completed", status.status);

    console.log("\n9) idempotent re-start returns completed");
    const again = await startWorkspaceSnapshotRestore({
      workspace_dir: workspaceDir,
      revision: revision!,
      source_sha256: sourceSha256,
      source_updated_at: sourceUpdatedAt,
    });
    check("re-start === completed", again.status === "completed", again.status);
    check("re-start same revision", again.revision === revision);

    console.log("\n10) fresh empty workspace restores without force");
    const freshId = pptWorkspaceName(new Date(2026, 8, 28, 12, 0, 0));
    const freshDir = path.join(WORKSPACE_ROOT, freshId);
    await mkdir(freshDir, { recursive: true });
    const freshJob = await startWorkspaceSnapshotRestore({
      workspace_dir: freshDir,
      revision: revision!,
      source_sha256: sourceSha256,
      source_updated_at: sourceUpdatedAt,
    });
    check("fresh restore queued (not blocked)", freshJob.status === "queued", freshJob.status);

    console.log("\nRESULT");
    if (failures === 0) {
      console.log("  ALL PASS (snapshot restore state machine)");
    } else {
      console.log(`  ${failures} FAILED`);
      process.exitCode = 1;
    }
  } finally {
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(path.join(WORKSPACE_ROOT, "ppt-20260828-120000"), { recursive: true, force: true }).catch(() => undefined);
    await rm(snapshotSyncRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(restoreRoot, { recursive: true, force: true }).catch(() => undefined);
    console.log(`\ncleaned scratch workspace ${workspaceId}`);
  }
}

await main();
