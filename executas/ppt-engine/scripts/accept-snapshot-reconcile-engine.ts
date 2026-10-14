/**
 * Local acceptance check for the cloud-priority conflict resolution primitives
 * (design doc 快照冲突云优先-待定设计.md, engine side only — the plugin tool
 * app_reconcile_workspace_with_cloud adds APS target resolution + transport).
 * Asserts the local fingerprint (not-yet-synced, then unsynced after mutation,
 * then in-sync after a force restore), backup-as-copy (title, marker, unsynced
 * content preserved, -2 dedup), and that a force restore over the original
 * leaves the backup copy intact, then cleans up.
 *
 * Usage: node --import tsx/esm scripts/accept-snapshot-reconcile-engine.ts
 */
import { appendFile, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPptWorkspaceRoot } from "../src/workspace-root.ts";
import {
  backupAppWorkspaceAsLocalCopy,
  createAppWorkspace,
  getAppWorkspaceLocalSnapshotFingerprint,
} from "../src/app-workspace/index.ts";
import {
  commitWorkspaceSnapshotRestore,
  extractWorkspaceSnapshotZip,
  getWorkspaceSnapshotSyncState,
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

function backupStamp(title: string): string | null {
  const match = title.match(/本地副本-(\d{8}-\d{4})/);
  return match ? match[1] : null;
}

async function main(): Promise<void> {
  const workspace = await createAppWorkspace();
  const workspaceDir = workspace.workspace_dir;
  const workspaceId = workspace.workspace_id;
  const snapshotSyncRoot = path.join(WORKSPACE_ROOT, ".snapshot-sync", workspaceId);
  const restoreRoot = path.join(WORKSPACE_ROOT, ".snapshot-restore", workspaceId);
  const createdCopyDirs: string[] = [];
  const createdCopySyncRoots: string[] = [];
  console.log(`WORKSPACE_ROOT=${WORKSPACE_ROOT}`);
  console.log(`scratch workspace=${workspaceId}`);

  try {
    // Add the whitelisted snapshot files that createAppWorkspace does not create,
    // so the fixture has the full 7-file + slides whitelist (8 sources).
    const extraSources: Record<string, string> = {
      "manifest.json": "{}",
      "visual-master.html": "<html></html>",
      "slides/page-a.html": "<html>slide</html>",
    };
    for (const [relative, content] of Object.entries(extraSources)) {
      const absolute = path.join(workspaceDir, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }

    console.log("\n1) generate a snapshot for the original workspace");
    const generated = await maybePublishWorkspaceSnapshot({ workspace_dir: workspaceDir });
    check("generation status === generated", generated.status === "generated", generated.status);
    const revision = generated.revision;
    const sourceSha256 = generated.source_sha256;
    const sourceUpdatedAt = generated.source_updated_at;
    check("revision present", revision !== null);

    console.log("\n2) fingerprint after local generation (not yet uploaded to APS)");
    const justGenerated = await getAppWorkspaceLocalSnapshotFingerprint({ workspace_dir: workspaceDir });
    check("has_files === true", justGenerated.has_files === true, String(justGenerated.has_files));
    check("source_sha256 matches snapshot", justGenerated.source_sha256 === sourceSha256, justGenerated.source_sha256?.slice(0, 8) ?? "null");
    check("file_count === 8", justGenerated.file_count === 8, String(justGenerated.file_count));
    check("unsynced === true (local-only, never synced)", justGenerated.unsynced === true, String(justGenerated.unsynced));

    console.log("\n3) mutate local content -> fingerprint stays unsynced with a new hash");
    await appendFile(path.join(workspaceDir, "slides", "page-a.html"), "\n<!-- RECONCILE-TOUCHED -->", "utf8");
    const mutated = await getAppWorkspaceLocalSnapshotFingerprint({ workspace_dir: workspaceDir });
    check("unsynced === true", mutated.unsynced === true, String(mutated.unsynced));
    check("source_sha256 changed", mutated.source_sha256 !== sourceSha256, mutated.source_sha256?.slice(0, 8) ?? "null");

    console.log("\n4) backup-as-copy preserves the unsynced local work");
    const firstBackup = await backupAppWorkspaceAsLocalCopy({ workspace_dir: workspaceDir });
    const copyDir = firstBackup.workspace_dir;
    const copyId = firstBackup.workspace_id;
    createdCopyDirs.push(copyDir);
    createdCopySyncRoots.push(path.join(WORKSPACE_ROOT, ".snapshot-sync", copyId));
    check("backup_of === source", firstBackup.backup_of === workspaceId, firstBackup.backup_of);
    check(
      "title has 本地副本 marker",
      /本地副本-\d{8}-\d{4}/.test(firstBackup.title),
      firstBackup.title,
    );
    const copiedTask = JSON.parse(await readFile(path.join(copyDir, "task.json"), "utf8"));
    check("copy task.local_conflict_backup === true", copiedTask.local_conflict_backup === true, String(copiedTask.local_conflict_backup));
    check("copy task.backup_of === source", copiedTask.backup_of === workspaceId, String(copiedTask.backup_of));
    const copiedSlide = await readFile(path.join(copyDir, "slides", "page-a.html"), "utf8");
    check("copy keeps the unsynced slide content", copiedSlide.includes("RECONCILE-TOUCHED"), copiedSlide.slice(-40));

    console.log("\n5) backup does not mutate the original");
    const originalSlide = await readFile(path.join(workspaceDir, "slides", "page-a.html"), "utf8");
    check("original still holds the local change", originalSlide.includes("RECONCILE-TOUCHED"));
    const originalFingerprint = await getAppWorkspaceLocalSnapshotFingerprint({ workspace_dir: workspaceDir });
    check("original still unsynced", originalFingerprint.unsynced === true, String(originalFingerprint.unsynced));

    console.log("\n6) second backup dedups the title with -2");
    const secondBackup = await backupAppWorkspaceAsLocalCopy({ workspace_dir: workspaceDir });
    createdCopyDirs.push(secondBackup.workspace_dir);
    createdCopySyncRoots.push(path.join(WORKSPACE_ROOT, ".snapshot-sync", secondBackup.workspace_id));
    check("second backup has distinct title", secondBackup.title !== firstBackup.title, `${firstBackup.title} vs ${secondBackup.title}`);
    if (backupStamp(firstBackup.title) === backupStamp(secondBackup.title)) {
      check("same-minute duplicate gets -2 suffix", secondBackup.title.endsWith("-2)"), secondBackup.title);
    } else {
      console.log("  (note: minute rolled over between backups; -2 dedup not exercised)");
    }

    console.log("\n7) force restore the cloud snapshot over the original");
    const stagingZip = path.join(restoreRoot, "snapshots", `${revision}.zip`);
    await mkdir(path.dirname(stagingZip), { recursive: true });
    await copyFile(generated.snapshot_path!, stagingZip);
    const queued = await startWorkspaceSnapshotRestore({
      workspace_dir: workspaceDir,
      revision: revision!,
      source_sha256: sourceSha256,
      source_updated_at: sourceUpdatedAt,
      force: true,
    });
    check("forced restore queued", queued.status === "queued", queued.status);
    const extracted = await extractWorkspaceSnapshotZip({
      workspace_dir: workspaceDir,
      zip_path: stagingZip,
      revision: revision!,
      expected_source_sha256: sourceSha256,
    });
    check("extracted sha256 matches snapshot", extracted.restored_source_sha256 === sourceSha256);
    await writeWorkspaceSnapshotRestore({
      workspace_dir: workspaceDir,
      restore: {
        ...queued,
        status: "extracting",
        snapshot_path: stagingZip,
        source_updated_at: extracted.source_updated_at ?? queued.source_updated_at,
        source_sha256: extracted.restored_source_sha256,
        snapshot_sha256: extracted.snapshot_sha256,
        snapshot_size_bytes: extracted.snapshot_size_bytes,
        file_count: extracted.file_count,
        attachments: extracted.attachments,
        error: null,
      },
    });
    const committed = await commitWorkspaceSnapshotRestore({
      workspace_dir: workspaceDir,
      expected_sha256: extracted.restored_source_sha256,
      mirror: {
        provider: "aps.files" as const,
        scope: "user" as const,
        path: queued.aps_path!,
        etag: "reconcile-etag",
        size_bytes: extracted.snapshot_size_bytes,
        content_type: "application/zip",
        source_updated_at: extracted.source_updated_at ?? "",
        source_sha256: extracted.restored_source_sha256,
        downloaded_at: new Date().toISOString(),
      },
    });
    check("restore committed", committed.status === "completed", committed.status);
    const restoredSlide = await readFile(path.join(workspaceDir, "slides", "page-a.html"), "utf8");
    check("original slide reverted to snapshot", restoredSlide === "<html>slide</html>", restoredSlide.slice(0, 30));

    console.log("\n8) original is in-sync again; the backup copy is untouched");
    const synced = await getAppWorkspaceLocalSnapshotFingerprint({ workspace_dir: workspaceDir });
    check("original unsynced === false after restore", synced.unsynced === false, String(synced.unsynced));
    check("original source_sha256 === snapshot", synced.source_sha256 === sourceSha256, synced.source_sha256?.slice(0, 8) ?? "null");
    const syncState = await getWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
    check("last_synced_sha256 recorded", syncState?.publish?.last_synced_sha256 === sourceSha256, syncState?.publish?.last_synced_sha256?.slice(0, 8) ?? "null");
    const copySlideStill = await readFile(path.join(copyDir, "slides", "page-a.html"), "utf8");
    check("backup copy still holds the local change", copySlideStill.includes("RECONCILE-TOUCHED"), copySlideStill.slice(-40));

    console.log("\n9) a fresh empty workspace fingerprints as not-unsynced");
    const emptyId = pptWorkspaceName(new Date(2026, 8, 28, 12, 0, 0));
    const emptyDir = path.join(WORKSPACE_ROOT, emptyId);
    await mkdir(emptyDir, { recursive: true });
    try {
      const emptyFingerprint = await getAppWorkspaceLocalSnapshotFingerprint({ workspace_dir: emptyDir });
      check("empty has_files === false", emptyFingerprint.has_files === false, String(emptyFingerprint.has_files));
      check("empty unsynced === false", emptyFingerprint.unsynced === false, String(emptyFingerprint.unsynced));
    } finally {
      await rm(emptyDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(path.join(WORKSPACE_ROOT, ".snapshot-sync", emptyId), { recursive: true, force: true }).catch(() => undefined);
      await rm(path.join(WORKSPACE_ROOT, ".snapshot-restore", emptyId), { recursive: true, force: true }).catch(() => undefined);
    }

    console.log("\nRESULT");
    if (failures === 0) {
      console.log("  ALL PASS (snapshot reconcile engine primitives)");
    } else {
      console.log(`  ${failures} FAILED`);
      process.exitCode = 1;
    }
  } finally {
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(snapshotSyncRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(restoreRoot, { recursive: true, force: true }).catch(() => undefined);
    for (const dir of createdCopyDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const root of createdCopySyncRoots) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    console.log(`\ncleaned scratch workspace ${workspaceId}`);
  }
}

await main();
