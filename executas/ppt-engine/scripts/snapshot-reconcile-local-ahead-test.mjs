#!/usr/bin/env node

/**
 * Development-only evidence harness for the real local-ahead reopen path:
 *
 *   baseline N synced -> pause N+1 after ZIP verification/before meta ->
 *   close and reopen -> prove C preserved N+1 instead of restoring N.
 *
 * It never edits Workspace files, calls APS, or releases the upload gate. It
 * only writes the existing development upload-gate control and this script's
 * own session record beside snapshot-sync.json.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const [action, workspaceDirArg] = process.argv.slice(2);
const actions = new Set(["prepare", "capture-paused", "verify", "status", "reset"]);
const workspaceIdPattern = /^ppt-\d{8}-\d{6}$/;

if (!actions.has(action) || !workspaceDirArg) {
  console.error("Usage: npm run snapshot-reconcile-local-ahead-test -- <prepare|capture-paused|verify|status|reset> <absolute-workspace-dir>");
  process.exitCode = 1;
} else {
  const workspaceDir = path.resolve(workspaceDirArg);
  const workspaceId = path.basename(workspaceDir);
  if (!workspaceIdPattern.test(workspaceId)) {
    throw new Error(`Expected a ppt-YYYYMMDD-HHMMSS workspace directory, received: ${workspaceDir}`);
  }

  const workspaceRoot = path.dirname(workspaceDir);
  const syncRoot = path.join(workspaceRoot, ".snapshot-sync", workspaceId);
  const statePath = path.join(syncRoot, "snapshot-sync.json");
  const gatePath = path.join(syncRoot, "snapshot-upload-test-gate.json");
  const sessionPath = path.join(syncRoot, "snapshot-reconcile-local-ahead-test.json");
  const restoreTimingPath = path.join(syncRoot, "cloud-restore-timing.jsonl");

  async function readJsonIfExists(filePath) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function readTextIfExists(filePath) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  }

  async function writeJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  async function workspaceDirectories() {
    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && workspaceIdPattern.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  const lineCount = (text) => text ? text.split("\n").filter(Boolean).length : 0;

  const state = await readJsonIfExists(statePath);
  const gate = await readJsonIfExists(gatePath);
  const session = await readJsonIfExists(sessionPath);
  const print = (value) => console.log(JSON.stringify({
    workspace_dir: workspaceDir,
    workspace_id: workspaceId,
    ...value,
  }, null, 2));

  if (action === "status") {
    print({
      gate: gate?.status ?? "idle",
      session: session ?? null,
      snapshot: state ? {
        source_sha256: state.source_sha256 ?? null,
        revision: state.revision ?? null,
        baseline_sha256: state.synced_baseline?.source_sha256 ?? null,
        publish_status: state.publish?.status ?? null,
        publish_source_sha256: state.publish?.source_sha256 ?? null,
      } : null,
    });
  } else if (action === "reset") {
    await rm(sessionPath, { force: true });
    print({ reset: true, note: "Only this script's evidence record was removed; use snapshot-upload-test-gate clear to clear the upload gate." });
  } else if (action === "prepare") {
    if (!state?.source_sha256 || !state?.synced_baseline?.source_sha256) {
      throw new Error("A completed initial cloud baseline is required before this test. Wait for N to upload, then retry.");
    }
    if (state.source_sha256 !== state.synced_baseline.source_sha256) {
      throw new Error("The workspace is already ahead of its baseline. Let it finish syncing or use a fresh disposable workspace.");
    }
    if (gate?.status === "paused") {
      throw new Error("The upload gate is already paused. Run snapshot-upload-test-gate clear before preparing a new test.");
    }
    const now = new Date().toISOString();
    await writeJson(gatePath, {
      status: "armed",
      job_id: null,
      armed_at: now,
      paused_at: null,
      released_at: null,
    });
    await writeJson(sessionPath, {
      schema_version: 1,
      scenario: "local_ahead_reopen",
      stage: "armed",
      workspace_dir: workspaceDir,
      workspace_id: workspaceId,
      baseline_sha256: state.synced_baseline.source_sha256,
      baseline_revision: state.synced_baseline.revision ?? null,
      workspace_ids_before: await workspaceDirectories(),
      restore_timing_line_count_before: lineCount(await readTextIfExists(restoreTimingPath)),
      armed_at: now,
      local_sha256: null,
      local_revision: null,
      captured_at: null,
    });
    print({
      prepared: true,
      baseline_sha256: state.synced_baseline.source_sha256,
      next: "Edit the disposable workspace and wait for the upload gate to become paused, then run capture-paused.",
    });
  } else if (action === "capture-paused") {
    if (!session || session.stage !== "armed") throw new Error("Run prepare before capture-paused.");
    if (gate?.status !== "paused") throw new Error("The upload is not paused yet. Check status and wait for checkpoint after ZIP verification before meta.json.");
    if (!state?.source_sha256 || !state?.revision) throw new Error("No generated N+1 snapshot is present in snapshot-sync.json.");
    if (state.source_sha256 === session.baseline_sha256) throw new Error("The paused upload still represents baseline N; make an edit that changes an authoritative snapshot file.");
    if (state.synced_baseline?.source_sha256 !== session.baseline_sha256) {
      throw new Error("The cloud baseline changed before capture. Reset and start again with a fresh disposable workspace.");
    }
    const captured = {
      ...session,
      stage: "paused",
      local_sha256: state.source_sha256,
      local_revision: state.revision,
      paused_job_id: gate.job_id ?? null,
      captured_at: new Date().toISOString(),
    };
    await writeJson(sessionPath, captured);
    print({
      captured: true,
      baseline_sha256: captured.baseline_sha256,
      local_sha256: captured.local_sha256,
      next: "Close the dev app without release, run snapshot-upload-test-gate clear, restart the app, open this workspace, then run verify.",
    });
  } else if (action === "verify") {
    if (!session || session.stage !== "paused") throw new Error("Run capture-paused before verify.");
    if (!state?.source_sha256) throw new Error("snapshot-sync.json no longer has a current source fingerprint; do not treat this run as passed.");
    const newWorkspaceIds = (await workspaceDirectories()).filter((id) => !session.workspace_ids_before.includes(id));
    const restoreTiming = await readTextIfExists(restoreTimingPath);
    const newRestoreEntries = restoreTiming
      .split("\n")
      .filter(Boolean)
      .slice(session.restore_timing_line_count_before ?? 0);
    const localPreserved = state.source_sha256 === session.local_sha256;
    const noNewWorkspaceCopy = newWorkspaceIds.length === 0;
    const noRestore = newRestoreEntries.length === 0;
    const passed = localPreserved && noNewWorkspaceCopy && noRestore;
    print({
      passed,
      checks: {
        local_n_plus_1_preserved: localPreserved,
        expected_local_sha256: session.local_sha256,
        current_source_sha256: state.source_sha256,
        no_new_workspace_copy: noNewWorkspaceCopy,
        new_workspace_ids: newWorkspaceIds,
        no_cloud_restore: noRestore,
        new_restore_log_entries: newRestoreEntries,
      },
      note: passed
        ? "C classified R=B and L!=B as local_ahead: the original workspace was preserved."
        : "Do not delete evidence. Inspect the checks above and the restore timing log before retrying.",
    });
    if (!passed) process.exitCode = 1;
  }
}
