import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
const testDir = await mkdtemp(path.join(os.tmpdir(), "ppt-delete-corrupt-"));
process.env.SLIDEFORGE_WORKSPACE_DIR = path.join(testDir, "slideforge-workspace");
const api = await import("../../src/app-workspace/index.ts");
let workspaceNumber = 0;

after(async () => {
  if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
  else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
  await rm(testDir, { recursive: true, force: true });
});

function createWorkspace() {
  workspaceNumber += 1;
  return api.openAppWorkspace({
    workspace_dir: path.join(
      api.getDefaultAppWorkspaceRoot(),
      `ppt-20260923-1200${String(workspaceNumber).padStart(2, "0")}`,
    ),
  });
}

const invalidOutline = JSON.stringify({
  version: 4,
  status: "draft",
  title: "Damaged outline",
  items: [{ page_type: "standard", title: "Page", content: "" }],
  updated_at: "2026-09-23T00:00:00.000Z",
  confirmed_at: null,
});

for (const scenario of [
  { name: "invalid outline content", file: "outline.json", content: invalidOutline },
  { name: "malformed outline JSON", file: "outline.json", content: "{" },
  { name: "malformed requirements JSON", file: "requirements.json", content: "{" },
  { name: "malformed task JSON", file: "task.json", content: "{" },
  { name: "malformed page progress JSON", file: "page-progress.json", content: "{" },
]) {
  test(`deletion tolerates ${scenario.name} and retains the tombstone`, async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace.workspace_dir, scenario.file), scenario.content, "utf8");

    const deleted = await api.deleteAppWorkspace({ workspace_dir: workspace.workspace_dir });

    assert.equal(deleted.deleted, true);
    await assert.rejects(access(workspace.workspace_dir), { code: "ENOENT" });
    const tombstone = await api.getAppWorkspaceTombstone({ workspace_id: workspace.workspace_id });
    assert.equal(tombstone?.workspace_id, workspace.workspace_id);
    assert.equal(tombstone?.lifecycle_epoch, deleted.tombstone.lifecycle_epoch);
  });
}

test("a damaged outline does not bypass active generation protection", async () => {
  const workspace = await createWorkspace();
  const run = await api.beginAppGenerationRun({
    workspace_dir: workspace.workspace_dir,
    run_kind: "deck-generation",
  });
  await api.prepareAppGenerationRun({ run_id: run.run_id });
  await writeFile(workspace.files.outline, invalidOutline, "utf8");

  await assert.rejects(
    api.deleteAppWorkspace({ workspace_dir: workspace.workspace_dir }),
    /An active generation run must be stopped/,
  );
  assert.equal(await readFile(workspace.files.outline, "utf8"), invalidOutline);
  assert.equal(await api.getAppWorkspaceTombstone({ workspace_id: workspace.workspace_id }), null);

  await api.abandonAppGenerationRun({ run_id: run.run_id });
  await api.deleteAppWorkspace({ workspace_dir: workspace.workspace_dir });
  await assert.rejects(access(workspace.workspace_dir), { code: "ENOENT" });
  await assert.rejects(access(path.dirname(path.dirname(run.shadow_workspace_dir))), { code: "ENOENT" });
});

test("deletion still rejects paths outside the workspace root and the root itself", async () => {
  const workspace = await createWorkspace();
  const markerPath = path.join(testDir, "keep.txt");
  await writeFile(markerPath, "keep", "utf8");

  for (const workspaceDir of [testDir, api.getDefaultAppWorkspaceRoot()]) {
    await assert.rejects(
      api.deleteAppWorkspace({ workspace_dir: workspaceDir }),
      /must be under the default PPT workspace root/,
    );
  }
  assert.equal(await readFile(markerPath, "utf8"), "keep");
  await access(workspace.workspace_dir);
});
