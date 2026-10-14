/**
 * Local acceptance check for the Windows in-place restore fallback
 * (design doc §7, engine side only). When the official Workspace directory
 * cannot be renamed away because files inside it are held open (active app
 * transport log / preview serving), `commitWorkspaceSnapshotRestore` must fall
 * back to a file-level in-place restore: copy the snapshot shadow over the
 * official tree, prune authoritative entries the snapshot lacks, and leave
 * regenerable artifacts (.log/) alone — while the swap-based atomic path keeps
 * working everywhere else.
 *
 * Usage: node --import tsx/esm scripts/accept-snapshot-restore-inplace.ts
 */
import { copyFile, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPptWorkspaceRoot } from "../src/workspace-root.ts";
import {
  commitWorkspaceSnapshotRestore,
  extractWorkspaceSnapshotZip,
  getWorkspaceSnapshotSyncState,
  maybePublishWorkspaceSnapshot,
  startWorkspaceSnapshotRestore,
  writeWorkspaceSnapshotRestore,
} from "../src/app-workspace/snapshot-sync.ts";

const WORKSPACE_ROOT = getPptWorkspaceRoot();
const IS_WINDOWS = process.platform === "win32";
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
  "task.json": JSON.stringify({ workspace_id: "", title: "Inplace Acceptance" }),
  "requirements.json": JSON.stringify({ brief: "clean" }),
  "outline.json": "{}",
  "page-progress.json": "{}",
  "manifest.json": "{}",
  "visual-master.html": "<html></html>",
  "aesthetic-reference-selections.json": "{}",
  "slides/page-a.html": "<html>slide-a</html>",
  "slides/page-b.html": "<html>slide-b</html>",
};

async function main(): Promise<void> {
  const workspaceId = pptWorkspaceName(new Date());
  const workspaceDir = path.join(WORKSPACE_ROOT, workspaceId);
  const snapshotSyncRoot = path.join(WORKSPACE_ROOT, ".snapshot-sync", workspaceId);
  const restoreRoot = path.join(WORKSPACE_ROOT, ".snapshot-restore", workspaceId);
  const heldHandlePath = path.join(workspaceDir, ".log", "held.lock");
  let heldHandle: Awaited<ReturnType<typeof open>> | null = null;

  console.log(`WORKSPACE_ROOT=${WORKSPACE_ROOT}`);
  console.log(`scratch workspace=${workspaceId} (platform=${process.platform})`);

  try {
    await mkdir(workspaceDir, { recursive: true });
    for (const [relative, content] of Object.entries(authoritativeFiles)) {
      const absolute = path.join(workspaceDir, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }

    console.log("\n1) generate a clean snapshot to restore FROM (the cloud baseline)");
    const generated = await maybePublishWorkspaceSnapshot({ workspace_dir: workspaceDir });
    check("generation status === generated", generated.status === "generated", generated.status);
    const revision = generated.revision!;
    const sourceSha256 = generated.source_sha256;
    const sourceUpdatedAt = generated.source_updated_at;

    console.log("\n2) tamper local: modify requirements.json + add an extra slide");
    await writeFile(path.join(workspaceDir, "requirements.json"), JSON.stringify({ brief: "tampered" }), "utf8");
    await writeFile(path.join(workspaceDir, "slides", "page-extra.html"), "<html>extra</html>", "utf8");

    console.log("\n3) stage the downloaded zip and queue a forced restore");
    const stagingZip = path.join(restoreRoot, "snapshots", `${revision}.zip`);
    await mkdir(path.dirname(stagingZip), { recursive: true });
    await copyFile(generated.snapshot_path!, stagingZip);
    const queued = await startWorkspaceSnapshotRestore({
      workspace_dir: workspaceDir,
      revision,
      source_sha256: sourceSha256,
      source_updated_at: sourceUpdatedAt,
      force: true,
    });
    check("forced status === queued", queued.status === "queued", queued.status);

    console.log("\n4) extract the zip into the shadow");
    const extracted = await extractWorkspaceSnapshotZip({
      workspace_dir: workspaceDir,
      zip_path: stagingZip,
      revision,
      expected_source_sha256: sourceSha256,
    });
    check("extracted source matches", extracted.restored_source_sha256 === sourceSha256);
    const extracting = await writeWorkspaceSnapshotRestore({
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
    check("extracting persisted", extracting.status === "extracting", extracting.status);

    console.log("\n5) hold a file open inside the workspace (Windows blocks the dir rename)");
    await mkdir(path.dirname(heldHandlePath), { recursive: true });
    await writeFile(heldHandlePath, "held", "utf8");
    heldHandle = await open(heldHandlePath, "r+");
    check("held handle open", heldHandle !== null);

    console.log("\n6) commit — Windows path must fall back to in-place restore");
    const mirror = {
      provider: "aps.files" as const,
      scope: "user" as const,
      path: queued.aps_path!,
      etag: "inplace-etag-abc",
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
    check("mirror stored", committed.mirror?.etag === "inplace-etag-abc");

    console.log("\n7) restored content: tamper gone, extra slide pruned, snapshot sources present");
    check(
      "requirements.json restored to clean",
      (await readFile(path.join(workspaceDir, "requirements.json"), "utf8")) === authoritativeFiles["requirements.json"],
    );
    const extraSlideGone = await readdir(path.join(workspaceDir, "slides")).then(
      (names) => !names.includes("page-extra.html"),
      () => true,
    );
    check("extra slide page-extra.html pruned", extraSlideGone);
    check(
      "slides/page-a.html present",
      (await readFile(path.join(workspaceDir, "slides", "page-a.html"), "utf8")) === authoritativeFiles["slides/page-a.html"],
    );
    check(
      "slides/page-b.html present",
      (await readFile(path.join(workspaceDir, "slides", "page-b.html"), "utf8")) === authoritativeFiles["slides/page-b.html"],
    );
    const previousExists = await readdir(path.join(restoreRoot)).then(
      (names) => names.includes("previous"),
      () => false,
    );
    if (IS_WINDOWS) {
      // In-place fallback: .log is not authoritative, so the held handle file
      // stays at its original path and no previous-dir swap happened.
      const heldStillThere = await readFile(heldHandlePath, "utf8").then(
        () => true,
        () => false,
      );
      check("in-place fallback ran (no previous dir swap)", !previousExists);
      check("regenerable .log/held.lock left in place", heldStillThere);
    } else {
      // Atomic swap: the whole tree moved to previous, taking .log with it.
      const heldAtPrevious = await readFile(
        path.join(restoreRoot, "previous", ".log", "held.lock"),
        "utf8",
      ).then(
        () => true,
        () => false,
      );
      check("atomic swap ran (previous dir present)", previousExists);
      check(".log/held.lock moved to previous", heldAtPrevious);
    }

    console.log("\n8) top-level snapshot state re-pointed at restored content");
    const sync = await getWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
    check("sync status === completed", sync?.status === "completed", sync?.status ?? "null");
    check("sync source_sha256 === restored", sync?.source_sha256 === sourceSha256, sync?.source_sha256?.slice(0, 8) ?? "null");
    check("publish.last_synced_sha256 === restored", sync?.publish?.last_synced_sha256 === sourceSha256);

    console.log("\nRESULT");
    if (failures === 0) {
      console.log("  ALL PASS (snapshot restore in-place fallback)");
    } else {
      console.log(`  ${failures} FAILED`);
      process.exitCode = 1;
    }
  } finally {
    await heldHandle?.close().catch(() => undefined);
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(snapshotSyncRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(restoreRoot, { recursive: true, force: true }).catch(() => undefined);
    console.log(`\ncleaned scratch workspace ${workspaceId}`);
  }
}

await main();
