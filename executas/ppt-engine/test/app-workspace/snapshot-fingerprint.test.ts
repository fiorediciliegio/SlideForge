import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("conflict fingerprint ignores regenerable/volatile state but still collects it", async () => {
  const api = await import("../../src/app-workspace/index.ts");
  const { getWorkspaceLocalSnapshotFingerprint } = await import("../../src/app-workspace/snapshot-sync.ts");

  const workspace = await api.createAppWorkspace({ title: "指纹稳定性" });

  const outlinePath = path.join(workspace.workspace_dir, "outline.json");
  await writeFile(outlinePath, JSON.stringify({ title: "指纹稳定性", sections: [{ title: "第一章" }] }), "utf8");

  const progressPath = path.join(workspace.workspace_dir, "page-progress.json");
  const progress = JSON.parse(await readFile(progressPath, "utf8"));
  progress.final_deck_render = { status: "completed", rendered_at: "2026-08-31T10:00:00.000Z" };
  await writeFile(progressPath, JSON.stringify(progress), "utf8");

  const taskPath = path.join(workspace.workspace_dir, "task.json");

  const first = await getWorkspaceLocalSnapshotFingerprint({ workspace_dir: workspace.workspace_dir });
  assert.ok(first.source_sha256, "workspace with whitelisted files must produce a fingerprint");
  assert.ok(first.file_count >= 3, "task/outline/page-progress are all collected into the snapshot");

  // Simulate what an open + preview regeneration does after a restore: page-progress
  // timestamps/attempt counters bump and task.json.updated_at is refreshed. The
  // conflict fingerprint must NOT change, otherwise a freshly-restored workspace
  // false-conflicts on its next open.
  progress.final_deck_render = { status: "completed", rendered_at: "2026-08-31T12:34:56.000Z" };
  progress.pages = [{ page_index: 0, render_attempts: 2 }];
  await writeFile(progressPath, JSON.stringify(progress), "utf8");

  const task = JSON.parse(await readFile(taskPath, "utf8"));
  task.updated_at = "2026-08-31T12:34:56.000Z";
  await writeFile(taskPath, JSON.stringify(task), "utf8");

  const afterRegen = await getWorkspaceLocalSnapshotFingerprint({ workspace_dir: workspace.workspace_dir });
  assert.equal(afterRegen.source_sha256, first.source_sha256, "page-progress + task.updated_at must not change the fingerprint");

  // Real authoring edits must still be detected as a change.
  await writeFile(outlinePath, JSON.stringify({ title: "指纹稳定性", sections: [{ title: "第一章改" }] }), "utf8");
  const afterEdit = await getWorkspaceLocalSnapshotFingerprint({ workspace_dir: workspace.workspace_dir });
  assert.notEqual(afterEdit.source_sha256, first.source_sha256, "content edits must change the fingerprint");
});
