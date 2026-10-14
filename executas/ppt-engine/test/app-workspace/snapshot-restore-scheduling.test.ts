import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const source = await readFile(new URL("../../example_plugin.js", import.meta.url), "utf8");

function queueSelector() {
  const start = source.indexOf("function selectNextSnapshotQueueEntry(");
  const end = source.indexOf("\nfunction queueWorkspacePreviewRegeneration(", start);
  assert.ok(start >= 0 && end > start, "shared snapshot priority selector must exist");
  return new Function(`${source.slice(start, end)}; return selectNextSnapshotQueueEntry;`)() as (
    entries: Map<string, { state: string; priority: number; sequence: number }>,
  ) => { state: string; priority: number; sequence: number } | null;
}

function autoRestoreAuditApi(workspaceRoot: string) {
  const start = source.indexOf("const AUTO_RESTORE_DECISION_AUDIT_FILENAME");
  const end = source.indexOf("\n/**", start);
  assert.ok(start >= 0 && end > start, "auto-restore audit implementation must exist");
  return new Function(
    "path",
    "mkdir",
    "appendFile",
    "readFile",
    "storageErrorRecord",
    "getAppWorkspaceDefaults",
    `${source.slice(start, end)}; return { appendAutoRestoreDecisionAudit, toolAppGetAutoRestoreDecisions, autoRestoreDecisionAuditPath };`,
  )(
    path,
    mkdir,
    appendFile,
    readFile,
    (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
    async () => ({ workspace_root: workspaceRoot }),
  ) as {
    appendAutoRestoreDecisionAudit(root: string, record: object): Promise<void>;
    toolAppGetAutoRestoreDecisions(args?: { limit?: number }): Promise<{ audit_path: string; records: Array<Record<string, unknown>> }>;
    autoRestoreDecisionAuditPath(root: string): string;
  };
}

test("snapshot scheduling chooses an opened Workspace ahead of first-screen and background work", () => {
  const select = queueSelector();
  const entries = new Map([
    ["background", { state: "pending", priority: 0, sequence: 1 }],
    ["first-screen", { state: "pending", priority: 1, sequence: 2 }],
    ["opened", { state: "pending", priority: 2, sequence: 3 }],
  ]);

  assert.equal(select(entries), entries.get("opened"));
  entries.get("opened")!.state = "running";
  assert.equal(select(entries), entries.get("first-screen"));
  entries.get("first-screen")!.state = "running";
  assert.equal(select(entries), entries.get("background"));
});

test("automatic restore is bounded to the first screen and defers the rest", () => {
  assert.match(source, /const AUTO_RESTORE_FIRST_SCREEN_LIMIT = 3;/);
  const autoRestoreStart = source.indexOf("async function toolAppAutoRestoreMissingWorkspaces(");
  const autoRestoreEnd = source.indexOf("\nasync function toolAppPrepareWorkspaceDiagnosticBundle(", autoRestoreStart);
  const autoRestore = source.slice(autoRestoreStart, autoRestoreEnd);

  assert.match(autoRestore, /eagerRestoreCount >= AUTO_RESTORE_FIRST_SCREEN_LIMIT/);
  assert.match(autoRestore, /reason: "outside_first_screen"/);
  assert.match(autoRestore, /_restore_priority: "first_screen"/);
  assert.match(autoRestore, /deferred,/);
});

test("restore and rebuild use independent single-worker drains with user-open promotion", () => {
  assert.match(source, /async function drainWorkspaceSnapshotRestoreQueue\(\)/);
  assert.match(source, /async function drainWorkspacePreviewRegenerationQueue\(\)/);
  assert.match(source, /async function prioritizeWorkspacePreviewRegeneration\(workspaceDir\)/);
  assert.match(source, /priority: "user_open"/);
  assert.doesNotMatch(source, /let workspaceSnapshotRestoreQueue = Promise\.resolve\(\)/);
});

test("automatic restore decisions persist cloud order and survive a torn final audit line", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-auto-restore-audit-"));
  try {
    const audit = autoRestoreAuditApi(root);
    await audit.appendAutoRestoreDecisionAudit(root, {
      event: "cloud.auto_restore.run_started",
      run_id: "run-1",
      cloud_order: [{ rank: 1, workspace_id: "ppt-1" }],
    });
    await audit.appendAutoRestoreDecisionAudit(root, {
      event: "cloud.auto_restore.decision",
      run_id: "run-1",
      workspace_id: "ppt-1",
      decision: "outside_first_screen",
    });
    await appendFile(audit.autoRestoreDecisionAuditPath(root), "{torn", "utf8");

    const result = await audit.toolAppGetAutoRestoreDecisions({ limit: 10 });
    assert.match(result.audit_path, /\.snapshot-restore[\\/]auto-restore-decisions\.jsonl$/);
    assert.deepEqual(result.records.map((record) => record.event), [
      "cloud.auto_restore.run_started",
      "cloud.auto_restore.decision",
    ]);
    assert.equal(result.records[0]?.schema_version, 1);
    assert.deepEqual(result.records[0]?.cloud_order, [{ rank: 1, workspace_id: "ppt-1" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
