/**
 * Local acceptance check for the snapshot FORCE-REGENERATE subsystem (design doc
 * "快照上传校验与删除策略" §2 engine side). Asserts that:
 *   - maybePublishWorkspaceSnapshot is idempotent (skips on same fingerprint)
 *   - force:true bypasses the skip and rebuilds the zip
 *   - a locally corrupt snapshot zip fails verification
 *   - regenerateWorkspaceSnapshot rebuilds the zip and refreshes the in-flight
 *     publish job contract (snapshot_sha256 / snapshot_path / meta_json)
 * then cleans up. No APS is involved.
 *
 * Usage: node --import tsx/esm scripts/accept-snapshot-regenerate.ts
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPptWorkspaceRoot } from "../src/workspace-root.ts";
import {
  getWorkspaceSnapshotPublishStatus,
  getWorkspaceSnapshotSyncState,
  maybePublishWorkspaceSnapshot,
  regenerateWorkspaceSnapshot,
  startWorkspaceSnapshotPublish,
  verifyWorkspaceSnapshotZip,
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

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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
  "task.json": JSON.stringify({ workspace_id: "", title: "Regenerate Acceptance" }),
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

    console.log("\n1) initial generation, then idempotent skip");
    const first = await maybePublishWorkspaceSnapshot({ workspace_dir: workspaceDir });
    check("first status === generated", first.status === "generated", first.status);
    const firstState = await getWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
    const firstSha = firstState?.snapshot_sha256 ?? "";
    check("first snapshot_sha256 present", /^[0-9a-f]{64}$/.test(firstSha));
    const again = await maybePublishWorkspaceSnapshot({ workspace_dir: workspaceDir });
    check("second call status === skipped", again.status === "skipped", again.status);

    console.log("\n2) force:true bypasses the skip and rebuilds");
    const forced = await maybePublishWorkspaceSnapshot({ workspace_dir: workspaceDir, force: true });
    check("forced status === generated", forced.status === "generated", forced.status);
    const forcedState = await getWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
    const forcedSha = forcedState?.snapshot_sha256 ?? "";
    check("forced snapshot_sha256 present", /^[0-9a-f]{64}$/.test(forcedSha));
    // The manifest embeds a new created_at each build, so the zip bytes change.
    check("forced zip bytes differ from first", forcedSha !== firstSha);

    console.log("\n3) start a publish job (queued, no APS)");
    const publish = await startWorkspaceSnapshotPublish({ workspace_dir: workspaceDir });
    check("publish status === queued", publish.status === "queued", publish.status);
    check("publish job_id present", typeof publish.job_id === "string" && publish.job_id.length > 0);
    const queuedSha = publish.snapshot_sha256;
    check("queued snapshot_sha256 matches state", queuedSha === forcedSha, `${queuedSha} vs ${forcedSha}`);

    console.log("\n4) corrupt the local zip on disk (EOCD cdOffset)");
    const snapshotPath = forcedState?.snapshot_path ?? publish.snapshot_path ?? "";
    check("snapshot_path present", typeof snapshotPath === "string" && snapshotPath.length > 0);
    const goodBytes = await readFile(snapshotPath);
    const corruptBytes = Buffer.from(goodBytes);
    corruptBytes[corruptBytes.length - 22 + 16] ^= 0xff;
    await writeFile(snapshotPath, corruptBytes);
    const corruptVerify = await verifyWorkspaceSnapshotZip({
      zip_path: snapshotPath,
      expected_workspace_id: workspaceId,
      expected_source_sha256: forcedState?.source_sha256 ?? undefined,
    });
    check("corrupt zip fails verification", corruptVerify.ok === false, corruptVerify.reason ?? "unexpectedly ok");

    console.log("\n5) regenerate rebuilds the zip and refreshes the publish job");
    const refreshed = await regenerateWorkspaceSnapshot({ workspace_dir: workspaceDir });
    check("refreshed status preserved (queued)", refreshed.status === "queued", refreshed.status);
    check("refreshed snapshot_path present", typeof refreshed.snapshot_path === "string" && refreshed.snapshot_path.length > 0);
    check("refreshed snapshot_sha256 present", /^[0-9a-f]{64}$/.test(refreshed.snapshot_sha256 ?? ""));
    check("refreshed zip bytes differ from corrupt build", refreshed.snapshot_sha256 !== corruptVerify.snapshot_sha256);
    const refreshedState = await getWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
    check("state snapshot_sha256 updated to refreshed", refreshedState?.snapshot_sha256 === refreshed.snapshot_sha256);
    check("state snapshot_path matches", refreshedState?.snapshot_path === refreshed.snapshot_path);

    console.log("\n6) refreshed publish meta_json points at the regenerated zip");
    const meta = refreshed.meta_json ? JSON.parse(refreshed.meta_json) : null;
    check("meta_json parses", Boolean(meta?.current_snapshot));
    check(
      "meta current_snapshot.snapshot_sha256 matches refreshed",
      meta?.current_snapshot?.snapshot_sha256 === refreshed.snapshot_sha256,
      `${meta?.current_snapshot?.snapshot_sha256} vs ${refreshed.snapshot_sha256}`,
    );
    check("meta revision matches", meta?.current_snapshot?.revision === refreshed.revision);
    const statusAfter = await getWorkspaceSnapshotPublishStatus({ workspace_dir: workspaceDir });
    check(
      "persisted publish snapshot_sha256 matches refreshed",
      statusAfter.snapshot_sha256 === refreshed.snapshot_sha256,
      `${statusAfter.snapshot_sha256} vs ${refreshed.snapshot_sha256}`,
    );

    console.log("\n7) regenerated zip verifies cleanly");
    const good = await verifyWorkspaceSnapshotZip({
      zip_path: refreshed.snapshot_path ?? "",
      expected_workspace_id: workspaceId,
      expected_source_sha256: refreshedState?.source_sha256 ?? undefined,
    });
    check("regenerated zip ok === true", good.ok === true, good.reason ?? "ok");
    check("regenerated snapshot_sha256 === refreshed", good.snapshot_sha256 === refreshed.snapshot_sha256);

    console.log("\nRESULT");
    if (failures === 0) {
      console.log("  ALL PASS (snapshot force-regenerate)");
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
