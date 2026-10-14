/**
 * Local acceptance check for the snapshot zip VERIFICATION subsystem
 * (design doc "快照上传校验与删除策略" §1, engine side). Asserts that
 * verifyWorkspaceSnapshotZip accepts a well-formed snapshot zip and rejects
 * corrupt / tampered / non-snapshot archives, then cleans up.
 *
 * Usage: node --import tsx/esm scripts/accept-snapshot-verify.ts
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPptWorkspaceRoot } from "../src/workspace-root.ts";
import {
  getWorkspaceSnapshotSyncState,
  maybePublishWorkspaceSnapshot,
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
  "task.json": JSON.stringify({ workspace_id: "", title: "Verify Acceptance" }),
  "requirements.json": "{}",
  "outline.json": "{}",
  "page-progress.json": "{}",
  "manifest.json": "{}",
  "visual-master.html": "<html></html>",
  "aesthetic-reference-selections.json": "{}",
  "slides/page-a.html": "<html>slide</html>",
};

/** Minimal STORE-method ZIP builder (classic layout, no data descriptors). */
function buildMinimalZip(files: { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt32LE(0, 10); // mtime/mdate
    local.writeUInt32LE(0, 14); // crc (unchecked by reader)
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += 30 + nameBuf.length + file.data.length;
  }
  const cd = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, cd, eocd]);
}

async function main(): Promise<void> {
  const workspaceId = pptWorkspaceName(new Date());
  const workspaceDir = path.join(WORKSPACE_ROOT, workspaceId);
  const scratchDir = path.join(WORKSPACE_ROOT, ".verify-scratch", workspaceId);
  console.log(`WORKSPACE_ROOT=${WORKSPACE_ROOT}`);
  console.log(`scratch workspace=${workspaceId}`);

  try {
    await mkdir(workspaceDir, { recursive: true });
    for (const [relative, content] of Object.entries(authoritativeFiles)) {
      const absolute = path.join(workspaceDir, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }
    await mkdir(scratchDir, { recursive: true });

    console.log("\n1) generate a snapshot to verify against");
    const generated = await maybePublishWorkspaceSnapshot({ workspace_dir: workspaceDir });
    check("generation status === generated", generated.status === "generated", generated.status);
    check("snapshot_path present", generated.snapshot_path !== null);
    const state = await getWorkspaceSnapshotSyncState({ workspace_dir: workspaceDir });
    const snapshotPath = generated.snapshot_path!;
    const expectedSourceSha256 = state?.source_sha256 ?? generated.source_sha256!;

    console.log("\n2) good snapshot zip passes with expectations");
    const good = await verifyWorkspaceSnapshotZip({
      zip_path: snapshotPath,
      expected_workspace_id: workspaceId,
      expected_source_sha256: expectedSourceSha256,
    });
    check("ok === true", good.ok === true, good.reason ?? "ok");
    check("reason === null", good.reason === null, good.reason ?? "");
    check("workspace_id matches", good.workspace_id === workspaceId, good.workspace_id ?? "null");
    check("revision present", typeof good.revision === "string" && good.revision.length > 0);
    check("source_sha256 matches", good.source_sha256 === expectedSourceSha256);
    check("snapshot_sha256 is 64 hex", /^[0-9a-f]{64}$/.test(good.snapshot_sha256));
    check("all_files_verified", good.all_files_verified === true);
    check("file_count >= 8", good.file_count >= 8, String(good.file_count));

    console.log("\n3) good snapshot zip passes without expectations");
    const noExpect = await verifyWorkspaceSnapshotZip({ zip_path: snapshotPath });
    check("ok === true without expectations", noExpect.ok === true, noExpect.reason ?? "ok");
    check("no missing files", noExpect.missing_files.length === 0);
    check("no mismatched files", noExpect.mismatched_files.length === 0);

    console.log("\n4) corrupted EOCD cdOffset is rejected");
    const goodBytes = await readFile(snapshotPath);
    const corruptBytes = Buffer.from(goodBytes);
    corruptBytes[corruptBytes.length - 22 + 16] ^= 0xff; // EOCD cdOffset field
    const corruptZip = path.join(scratchDir, "corrupt.zip");
    await writeFile(corruptZip, corruptBytes);
    const corrupt = await verifyWorkspaceSnapshotZip({
      zip_path: corruptZip,
      expected_workspace_id: workspaceId,
      expected_source_sha256: expectedSourceSha256,
    });
    check("corrupt zip ok === false", corrupt.ok === false, corrupt.reason ?? "unexpectedly ok");
    check("corrupt zip has reason", typeof corrupt.reason === "string" && corrupt.reason.length > 0);

    console.log("\n5) wrong expected_source_sha256 is rejected");
    const wrongSource = await verifyWorkspaceSnapshotZip({
      zip_path: snapshotPath,
      expected_workspace_id: workspaceId,
      expected_source_sha256: "0".repeat(64),
    });
    check("wrong source ok === false", wrongSource.ok === false, wrongSource.reason ?? "unexpectedly ok");
    check("reason mentions source_sha256", (wrongSource.reason ?? "").includes("source_sha256"));

    console.log("\n6) wrong expected_workspace_id is rejected");
    const wrongId = await verifyWorkspaceSnapshotZip({
      zip_path: snapshotPath,
      expected_workspace_id: "ppt-00000000-000000",
      expected_source_sha256: expectedSourceSha256,
    });
    check("wrong id ok === false", wrongId.ok === false, wrongId.reason ?? "unexpectedly ok");
    check("reason mentions workspace_id", (wrongId.reason ?? "").includes("workspace_id"));

    console.log("\n7) non-zip bytes are rejected");
    const randomZip = path.join(scratchDir, "random.zip");
    await writeFile(randomZip, Buffer.from(sha256Hex("not a zip"), "hex"));
    const random = await verifyWorkspaceSnapshotZip({ zip_path: randomZip });
    check("random bytes ok === false", random.ok === false, random.reason ?? "unexpectedly ok");

    console.log("\n8) empty file is rejected");
    const emptyZip = path.join(scratchDir, "empty.zip");
    await writeFile(emptyZip, Buffer.alloc(0));
    const empty = await verifyWorkspaceSnapshotZip({ zip_path: emptyZip });
    check("empty file ok === false", empty.ok === false, empty.reason ?? "unexpectedly ok");

    console.log("\n9) valid zip without a snapshot manifest is rejected");
    const nonSnapshotZip = path.join(scratchDir, "non-snapshot.zip");
    await writeFile(nonSnapshotZip, buildMinimalZip([{ name: "hello.txt", data: Buffer.from("hello", "utf8") }]));
    const nonSnapshot = await verifyWorkspaceSnapshotZip({ zip_path: nonSnapshotZip });
    check("no-manifest ok === false", nonSnapshot.ok === false, nonSnapshot.reason ?? "unexpectedly ok");
    check("reason mentions manifest", (nonSnapshot.reason ?? "").includes("snapshot-manifest"));

    console.log("\n10) STORE-method snapshot zip passes");
    const hello = Buffer.from("hello from store", "utf8");
    const helloSha = sha256Hex(hello);
    const storeSourceSha256 = sha256Hex(`hello.txt\0${helloSha}\n`);
    const storeManifest = {
      schema_version: 1,
      snapshot: {
        workspace_id: workspaceId,
        revision: "1700000000000",
        source_sha256: storeSourceSha256,
        source_updated_at: null,
        files: [{ path: "hello.txt", sha256: helloSha, size: hello.length }],
        attachments: [],
        created_at: "2026-08-28T00:00:00.000Z",
      },
    };
    const storeZip = path.join(scratchDir, "store-snapshot.zip");
    await writeFile(
      storeZip,
      buildMinimalZip([
        { name: ".snapshot-manifest.json", data: Buffer.from(JSON.stringify(storeManifest), "utf8") },
        { name: "hello.txt", data: hello },
      ]),
    );
    const store = await verifyWorkspaceSnapshotZip({
      zip_path: storeZip,
      expected_workspace_id: workspaceId,
      expected_source_sha256: storeSourceSha256,
    });
    check("store zip ok === true", store.ok === true, store.reason ?? "ok");
    check("store all_files_verified", store.all_files_verified === true);
    check("store file_count === 2", store.file_count === 2, String(store.file_count));

    console.log("\n11) STORE zip with corrupted file data is rejected");
    const storeBytes = await readFile(storeZip);
    const tamperedStoreBytes = Buffer.from(storeBytes);
    const manifestJson = JSON.stringify(storeManifest);
    // hello.txt is the second entry: local(manifest) = 30 + name + data, then local(hello) = 30 + name.
    const helloDataOffset =
      30 + ".snapshot-manifest.json".length + Buffer.byteLength(manifestJson, "utf8") + 30 + "hello.txt".length;
    tamperedStoreBytes[helloDataOffset] ^= 0xff;
    const tamperedStoreZip = path.join(scratchDir, "store-tampered.zip");
    await writeFile(tamperedStoreZip, tamperedStoreBytes);
    const storeTampered = await verifyWorkspaceSnapshotZip({
      zip_path: tamperedStoreZip,
      expected_workspace_id: workspaceId,
      expected_source_sha256: storeSourceSha256,
    });
    check("tampered store data ok === false", storeTampered.ok === false, storeTampered.reason ?? "unexpectedly ok");
    check("tampered store reason lists mismatch", (storeTampered.reason ?? "").includes("content mismatch"));

    console.log("\nRESULT");
    if (failures === 0) {
      console.log("  ALL PASS (snapshot zip verification)");
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
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    console.log(`\ncleaned scratch workspace ${workspaceId}`);
  }
}

await main();
