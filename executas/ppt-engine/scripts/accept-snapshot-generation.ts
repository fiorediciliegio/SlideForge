/**
 * Local acceptance check for workspace snapshot GENERATION (design doc §5-6,
 * increment 1: no APS upload).
 *
 * Runs entirely against a scratch Workspace created under the PPT workspace
 * root, asserts the idempotent snapshot behavior, then cleans up. No Anna
 * runtime or login required.
 *
 * Zip inspection uses the engine's own dependency-free parser
 * (`readWorkspaceSnapshotInfo`), so no external unzip binary is needed.
 *
 * Usage: node --import tsx/esm scripts/accept-snapshot-generation.ts
 */
import { createWriteStream } from "node:fs";
import { appendFile, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { ZipArchive } from "archiver";
import { getPptWorkspaceRoot } from "../src/workspace-root.ts";
import {
  getWorkspaceSnapshotSyncState,
  maybePublishWorkspaceSnapshot,
  readWorkspaceSnapshotInfo,
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

async function buildZipWithEntries(
  outputPath: string,
  entries: { name: string; content: string }[],
): Promise<void> {
  const output = createWriteStream(outputPath, { flags: "w" });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const completed = pipeline(archive, output);
  for (const entry of entries) {
    archive.append(Buffer.from(entry.content, "utf8"), { name: entry.name, type: "file" });
  }
  await archive.finalize();
  await completed;
}

async function main(): Promise<void> {
  console.log(`WORKSPACE_ROOT=${WORKSPACE_ROOT}`);
  const workspaceId = pptWorkspaceName(new Date());
  const workspaceDir = path.join(WORKSPACE_ROOT, workspaceId);
  const emptyWorkspaceId = pptWorkspaceName(new Date(Date.now() - 60_000));
  const emptyWorkspaceDir = path.join(WORKSPACE_ROOT, emptyWorkspaceId);
  console.log(`scratch workspace=${workspaceId}`);

  // Authoritative sources the snapshot must include.
  const authoritativeFiles: Record<string, string> = {
    "task.json": JSON.stringify({ workspace_id: workspaceId, title: "Acceptance" }),
    "requirements.json": "{}",
    "outline.json": "{}",
    "page-progress.json": "{}",
    "manifest.json": "{}",
    "visual-master.html": "<html></html>",
    "aesthetic-reference-selections.json": "{}",
    "slides/page-accept.html": "<html>slide</html>",
    "template-reference/preset.json": "{}",
    "uploaded-sources/index.json": JSON.stringify({
      version: 1,
      materials: [
        { uploaded_source_id: "s1", status: "active", sha256: "abc123", size_bytes: 3 },
      ],
    }),
  };
  // Reconstructible/discardable data the snapshot must NOT include.
  const excludedFiles: Record<string, string> = {
    "output/deck.html": "<html>output must stay out of the snapshot</html>",
    ".log/ai-x.jsonl": "x\n",
    "uploaded-sources/files/s1/blob.bin": "attachment body must stay out",
  };

  try {
    await mkdir(workspaceDir, { recursive: true });
    for (const [relative, content] of Object.entries(authoritativeFiles)) {
      const absolute = path.join(workspaceDir, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }
    for (const [relative, content] of Object.entries(excludedFiles)) {
      const absolute = path.join(workspaceDir, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }

    console.log("\n1) first generation");
    const first = await maybePublishWorkspaceSnapshot({ workspace_dir: workspaceDir });
    check("status === generated", first.status === "generated", first.status);
    check("revision (mtime ms) present", first.revision !== null);
    check(
      `file_count === ${Object.keys(authoritativeFiles).length}`,
      first.file_count === Object.keys(authoritativeFiles).length,
      `file_count=${first.file_count}`,
    );
    check(
      "snapshot lives outside the Workspace (.snapshot-sync)",
      Boolean(first.snapshot_path) && !first.snapshot_path!.includes(workspaceDir),
      first.snapshot_path ?? "no path",
    );

    console.log("\n2) zip contents match the whitelist (engine-internal parser)");
    const zipPath = first.snapshot_path!;
    const info = await lstat(zipPath);
    check("snapshot zip exists and is non-empty", info.size > 0, `size=${info.size}`);
    const parsedZip = await readWorkspaceSnapshotInfo({ workspace_dir: workspaceDir });
    const entryNames = new Set(parsedZip.entries.map((entry) => entry.name));
    for (const relative of Object.keys(authoritativeFiles)) {
      check(`zip includes ${relative}`, entryNames.has(relative));
    }
    for (const relative of Object.keys(excludedFiles)) {
      check(`zip excludes ${relative}`, !entryNames.has(relative));
    }
    check("zip has .snapshot-manifest.json", entryNames.has(".snapshot-manifest.json"));

    console.log("\n3) .snapshot-manifest.json (read back from the zip)");
    const manifestSnapshot = parsedZip.manifest;
    check("manifest.workspace_id matches", manifestSnapshot.workspace_id === workspaceId);
    check(
      "manifest.source_sha256 === result.source_sha256",
      manifestSnapshot.source_sha256 === first.source_sha256,
    );
    check(
      "manifest.files lists every authoritative file",
      manifestSnapshot.files.length === Object.keys(authoritativeFiles).length,
      `files.length=${manifestSnapshot.files.length}`,
    );
    check(
      "manifest.attachments records the active content hash",
      manifestSnapshot.attachments.some((item) => item.content_hash === "abc123"),
      JSON.stringify(manifestSnapshot.attachments),
    );

    console.log("\n4) snapshot-sync.json state");
    const state = await getWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
    check("state.status === completed", state?.status === "completed", state?.status ?? "null");
    check("state.source_sha256 matches", state?.source_sha256 === first.source_sha256);
    check("state.snapshot_sha256 is a 64-hex zip hash", state?.snapshot_sha256?.length === 64);
    check("state.file_count matches", state?.file_count === first.file_count);

    console.log("\n5) idempotency (unchanged content)");
    const second = await maybePublishWorkspaceSnapshot({ workspace_dir: workspaceDir });
    check("second call === skipped", second.status === "skipped", second.status);
    check("second call returns same revision", second.revision === first.revision);

    console.log("\n6) change detection (content + mtime change)");
    await appendFile(path.join(workspaceDir, "task.json"), "\n// touched", "utf8");
    const third = await maybePublishWorkspaceSnapshot({ workspace_dir: workspaceDir });
    check("third call === generated", third.status === "generated", third.status);
    check("new revision differs", third.revision !== first.revision);
    check("new source_sha256 differs", third.source_sha256 !== first.source_sha256);

    console.log("\n7) state still coherent after regeneration");
    const stateAfter = await getWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
    check(
      "state.source_sha256 === regenerated sha",
      stateAfter?.source_sha256 === third.source_sha256,
    );

    console.log("\n8) readWorkspaceSnapshotInfo parses the generated snapshot");
    const parsed = await readWorkspaceSnapshotInfo({ workspace_dir: workspaceDir });
    check("parsed.workspace_id matches", parsed.workspace_id === workspaceId);
    check("parsed.revision === state revision", parsed.revision === third.revision);
    check("parsed.snapshot_path points at the zip", parsed.snapshot_path === third.snapshot_path);
    check("parsed.zip_sha256 is 64-hex", /^[0-9a-f]{64}$/.test(parsed.zip_sha256), parsed.zip_sha256);
    check(
      "parsed.zip_sha256_matches_state === true",
      parsed.zip_sha256_matches_state === true,
      String(parsed.zip_sha256_matches_state),
    );
    check(
      "parsed.manifest.source_sha256 === state sha",
      parsed.manifest.source_sha256 === third.source_sha256,
    );
    check(
      "parsed.manifest.files covers every authoritative file",
      parsed.manifest.files.length === Object.keys(authoritativeFiles).length,
      `files.length=${parsed.manifest.files.length}`,
    );
    const untrackedEntries = parsed.entries.filter((entry) => entry.sha256 === null);
    check(
      "parsed.entries: only .snapshot-manifest.json is untracked",
      untrackedEntries.every((entry) => entry.name === ".snapshot-manifest.json"),
      JSON.stringify(untrackedEntries.map((entry) => entry.name)),
    );
    check(
      "parsed.file_count === authoritative files + manifest",
      parsed.file_count === Object.keys(authoritativeFiles).length + 1,
      `file_count=${parsed.file_count}`,
    );
    check("parsed.missing_files is empty", parsed.missing_files.length === 0);
    check("parsed.mismatched_files is empty", parsed.mismatched_files.length === 0);
    check("parsed.all_files_verified === true", parsed.all_files_verified === true);

    console.log("\n9) tampered zip is detected (mismatch + missing + state hash)");
    const tamperedDir = path.join(WORKSPACE_ROOT, ".snapshot-sync", workspaceId, "snapshots");
    const tamperedPath = path.join(tamperedDir, "tampered.zip");
    await buildZipWithEntries(tamperedPath, [
      {
        name: ".snapshot-manifest.json",
        content: `${JSON.stringify({
          schema_version: 1,
          snapshot: {
            workspace_id: workspaceId,
            revision: "tampered",
            source_sha256: "0".repeat(64),
            source_updated_at: null,
            files: [
              { path: "task.json", sha256: "a".repeat(64), size: 8 },
              { path: "requirements.json", sha256: "b".repeat(64), size: 2 },
            ],
            attachments: [],
            created_at: new Date().toISOString(),
          },
        }, null, 2)}\n`,
      },
      { name: "task.json", content: "tampered" },
      // requirements.json is deliberately omitted → must be reported missing
    ]);
    const tampered = await readWorkspaceSnapshotInfo({
      workspace_dir: workspaceDir,
      revision: "tampered",
    });
    check(
      "tampered.mismatched_files includes task.json",
      tampered.mismatched_files.includes("task.json"),
      JSON.stringify(tampered.mismatched_files),
    );
    check(
      "tampered.missing_files includes requirements.json",
      tampered.missing_files.includes("requirements.json"),
      JSON.stringify(tampered.missing_files),
    );
    check("tampered.all_files_verified === false", tampered.all_files_verified === false);
    check(
      "tampered.zip_sha256_matches_state === false",
      tampered.zip_sha256_matches_state === false,
      String(tampered.zip_sha256_matches_state),
    );
    check("tampered.file_count counts only present entries", tampered.file_count === 2, `file_count=${tampered.file_count}`);

    console.log("\n10) no snapshot generated => readWorkspaceSnapshotInfo throws");
    await mkdir(emptyWorkspaceDir, { recursive: true });
    let threw = false;
    try {
      await readWorkspaceSnapshotInfo({ workspace_dir: emptyWorkspaceDir });
    } catch (error) {
      threw = true;
      check(
        "error mentions no snapshot",
        error instanceof Error && error.message.includes("No snapshot"),
        error instanceof Error ? error.message : String(error),
      );
    }
    check("readWorkspaceSnapshotInfo throws without a snapshot", threw);

    console.log("\nRESULT");
    if (failures === 0) {
      console.log(`  ALL PASS (${Object.keys(authoritativeFiles).length} authoritative files)`);
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
    await rm(emptyWorkspaceDir, { recursive: true, force: true }).catch(() => undefined);
    console.log(`\ncleaned scratch workspace ${workspaceId}`);
  }
}

await main();
