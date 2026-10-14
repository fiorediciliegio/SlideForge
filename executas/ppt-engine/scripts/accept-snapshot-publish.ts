/**
 * Local acceptance check for workspace snapshot PUBLICATION state machine
 * (design doc §6, engine side only — no APS upload; the APS transport runs in
 * example_plugin.js). Asserts generation → start → commit → idempotency →
 * change detection → interrupt recovery, then cleans up.
 *
 * Usage: node --import tsx/esm scripts/accept-snapshot-publish.ts
 */
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPptWorkspaceRoot } from "../src/workspace-root.ts";
import {
  commitWorkspaceSnapshotPublish,
  getWorkspaceSnapshotPublishStatus,
  getWorkspaceSnapshotSyncState,
  markWorkspaceSnapshotPublishJobInterrupted,
  maybePublishWorkspaceSnapshot,
  startWorkspaceSnapshotPublish,
  writeWorkspaceSnapshotPublish,
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
  "task.json": JSON.stringify({ workspace_id: "", title: "Publish Acceptance" }),
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
  console.log(`WORKSPACE_ROOT=${WORKSPACE_ROOT}`);
  console.log(`scratch workspace=${workspaceId}`);

  try {
    await mkdir(workspaceDir, { recursive: true });
    for (const [relative, content] of Object.entries(authoritativeFiles)) {
      const absolute = path.join(workspaceDir, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }

    console.log("\n1) generate a snapshot first");
    const generated = await maybePublishWorkspaceSnapshot({ workspace_dir: workspaceDir });
    check("generation status === generated", generated.status === "generated", generated.status);
    check("revision present", generated.revision !== null);

    console.log("\n2) start publish → queued job");
    const queued = await startWorkspaceSnapshotPublish({ workspace_dir: workspaceDir });
    check("status === queued", queued.status === "queued", queued.status);
    check("job_id non-empty", queued.job_id.length > 0);
    check("aps_path set", queued.aps_path === `workspaces/${workspaceId}/snapshots/${generated.revision}.zip`, queued.aps_path ?? "null");
    check("aps_meta_path set", queued.aps_meta_path === `workspaces/${workspaceId}/meta.json`);
    check("snapshot_path set", queued.snapshot_path !== null);
    check("meta_json carries workspace_id", queued.meta_json?.includes(workspaceId) === true);
    check("meta_json carries current_snapshot.aps_path", queued.meta_json?.includes(queued.aps_path ?? "") === true);
    check("source_sha256 set", typeof queued.source_sha256 === "string" && queued.source_sha256.length === 64);
    check("mirror null before upload", queued.mirror === null);

    console.log("\n3) progress writes are persisted");
    const uploading = await writeWorkspaceSnapshotPublish({
      workspace_dir: workspaceDir,
      publish: { ...queued, status: "uploading" },
    });
    check("uploading persisted", uploading.status === "uploading", uploading.status);
    const status = await getWorkspaceSnapshotPublishStatus({ workspace_dir: workspaceDir });
    check("getWorkspaceSnapshotPublishStatus === uploading", status.status === "uploading", status.status);

    console.log("\n4) commit (simulated APS success)");
    const mirror = {
      provider: "aps.files" as const,
      scope: "user" as const,
      path: queued.aps_path!,
      etag: "abc123etag",
      size_bytes: 1234,
      content_type: "application/zip",
      source_updated_at: queued.source_updated_at!,
      source_sha256: queued.source_sha256!,
      published_at: new Date().toISOString(),
      meta_path: queued.aps_meta_path!,
      meta_etag: "metaetag",
    };
    const committed = await commitWorkspaceSnapshotPublish({
      workspace_dir: workspaceDir,
      expected_updated_at: queued.source_updated_at,
      expected_sha256: queued.source_sha256!,
      mirror,
    });
    check("commit status === completed", committed.status === "completed", committed.status);
    check("mirror stored", committed.mirror?.etag === "abc123etag");
    check("last_synced_sha256 recorded", committed.last_synced_sha256 === queued.source_sha256);
    check("last_synced_updated_at recorded", committed.last_synced_updated_at === queued.source_updated_at);
    check("completed_at set", committed.completed_at !== null);

    console.log("\n5) idempotent re-start (same fingerprint)");
    const again = await startWorkspaceSnapshotPublish({ workspace_dir: workspaceDir });
    check("second start === completed", again.status === "completed", again.status);
    check("second start returns same revision", again.revision === queued.revision);
    check("second start same mirror", again.mirror?.etag === "abc123etag");

    console.log("\n6) change detection → re-publish required");
    await appendFile(path.join(workspaceDir, "task.json"), "\n// touched", "utf8");
    const regenerated = await maybePublishWorkspaceSnapshot({ workspace_dir: workspaceDir });
    check("regeneration happened", regenerated.status === "generated", regenerated.status);
    const republish = await startWorkspaceSnapshotPublish({ workspace_dir: workspaceDir });
    check("re-publish is queued (not completed)", republish.status === "queued", republish.status);
    check("re-publish revision differs", republish.revision !== queued.revision);
    check("re-publish aps_path uses new revision", republish.aps_path === `workspaces/${workspaceId}/snapshots/${regenerated.revision}.zip`, republish.aps_path ?? "null");

    console.log("\n7) commit again with mismatched expected_sha256 is rejected");
    let commitRejected = false;
    try {
      await commitWorkspaceSnapshotPublish({
        workspace_dir: workspaceDir,
        expected_updated_at: republish.source_updated_at,
        expected_sha256: "0".repeat(64),
        mirror,
      });
    } catch {
      commitRejected = true;
    }
    check("mismatched commit rejected", commitRejected);

    console.log("\n8) interrupt recovery");
    const failed = await markWorkspaceSnapshotPublishJobInterrupted({ workspace_dir: workspaceDir });
    check("mark interrupted → failed", failed.status === "failed", failed.status);
    check("interrupted flag set", failed.error?.interrupted === true);
    check("job_id preserved", failed.job_id === republish.job_id);
    // A failed publish can be started again.
    const restarted = await startWorkspaceSnapshotPublish({ workspace_dir: workspaceDir });
    check("restart after failure is queued", restarted.status === "queued", restarted.status);

    console.log("\n9) sync state still coherent");
    const sync = await getWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
    check("sync status === completed (generation untouched by publish)", sync?.status === "completed", sync?.status ?? "null");
    check("publish sub-state present", sync?.publish !== null);

    console.log("\nRESULT");
    if (failures === 0) {
      console.log("  ALL PASS (snapshot publish state machine)");
    } else {
      console.log(`  ${failures} FAILED`);
      process.exitCode = 1;
    }
  } finally {
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(path.join(WORKSPACE_ROOT, ".snapshot-sync", workspaceId), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    console.log(`\ncleaned scratch workspace ${workspaceId}`);
  }
}

await main();
