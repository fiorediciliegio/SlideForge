import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const previousHome = process.env.HOME;
const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
const homeDir = await mkdtemp(path.join(os.tmpdir(), "ppt-generation-run-home-"));
process.env.HOME = homeDir;
process.env.SLIDEFORGE_WORKSPACE_DIR = path.join(homeDir, "slideforge-workspace");
const api = await import("../../src/app-workspace/index.ts");

after(async () => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
  else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
  await rm(homeDir, { recursive: true, force: true });
});

test("generation run publishes a self-contained shadow Workspace atomically", async () => {
  const created = await api.createAppWorkspace({ title: "Shadow commit" });
  const markerPath = path.join(created.workspace_dir, "marker.json");
  await writeFile(markerPath, JSON.stringify({ root: created.workspace_dir, value: "old" }), "utf8");

  const transaction = await api.beginAppGenerationRun({
    workspace_dir: created.workspace_dir,
    run_kind: "deck-refinement",
    origin_page_id: "page-origin",
  });
  const prepared = await api.prepareAppGenerationRun({ run_id: transaction.run_id });
  assert.equal(prepared.transaction.state, "active");
  assert.ok(prepared.workspace);
  const shadowMarker = path.join(transaction.shadow_workspace_dir, "marker.json");
  assert.equal(
    (JSON.parse(await readFile(shadowMarker, "utf8")) as { root: string }).root,
    transaction.shadow_workspace_dir,
  );
  await writeFile(shadowMarker, JSON.stringify({ root: transaction.shadow_workspace_dir, value: "new" }), "utf8");
  const shadowCatalog = path.join(transaction.shadow_workspace_dir, "research", "evidence", "image-catalog.json");
  const shadowSlide = path.join(transaction.shadow_workspace_dir, "slides", "page-1.tsx");
  const shadowImage = path.join(transaction.shadow_workspace_dir, "research", "evidence", "images", "image-1.png");
  await mkdir(path.dirname(shadowCatalog), { recursive: true });
  await mkdir(path.dirname(shadowSlide), { recursive: true });
  await writeFile(shadowCatalog, JSON.stringify({ file_path: shadowImage }), "utf8");
  await writeFile(shadowSlide, `export const imagePath = ${JSON.stringify(shadowImage)};`, "utf8");

  const committed = await api.commitAppGenerationRun({ run_id: transaction.run_id });
  assert.equal(committed.transaction.state, "committed");
  const published = JSON.parse(await readFile(markerPath, "utf8")) as { root: string; value: string };
  assert.equal(published.root, created.workspace_dir);
  assert.equal(published.value, "new");
  const officialImage = path.join(created.workspace_dir, "research", "evidence", "images", "image-1.png");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(created.workspace_dir, "research", "evidence", "image-catalog.json"), "utf8")),
    { file_path: officialImage },
  );
  assert.equal(
    await readFile(path.join(created.workspace_dir, "slides", "page-1.tsx"), "utf8"),
    `export const imagePath = ${JSON.stringify(officialImage)};`,
  );
  assert.deepEqual(await api.cleanupAppGenerationRun({ run_id: transaction.run_id }), { cleaned: true });
  await assert.rejects(access(path.dirname(path.dirname(transaction.shadow_workspace_dir))), { code: "ENOENT" });
});

test("generation commit invalidates export artifacts from the replaced deck version", async () => {
  const created = await api.createAppWorkspace({ title: "Invalidate exports" });
  const taskPath = path.join(created.workspace_dir, "task.json");
  const existingTask = JSON.parse(await readFile(taskPath, "utf8")) as Record<string, unknown>;
  await writeFile(taskPath, JSON.stringify({
    ...existingTask,
    artifacts: {
      pptx: { path: path.join(created.workspace_dir, "output", "old.pptx"), updated_at: "2026-08-13T00:00:00.000Z" },
      pdf: { path: path.join(created.workspace_dir, "output", "old.pdf"), updated_at: "2026-08-13T00:00:00.000Z" },
    },
  }), "utf8");
  const transaction = await api.beginAppGenerationRun({
    workspace_dir: created.workspace_dir,
    run_kind: "deck-refinement",
  });
  await api.prepareAppGenerationRun({ run_id: transaction.run_id });
  const shadowTaskPath = path.join(transaction.shadow_workspace_dir, "task.json");
  const shadowTask = JSON.parse(await readFile(shadowTaskPath, "utf8")) as { artifacts?: Record<string, unknown> };
  assert.ok(shadowTask.artifacts?.pptx);
  await api.commitAppGenerationRun({ run_id: transaction.run_id });
  const publishedTask = JSON.parse(await readFile(taskPath, "utf8")) as { artifacts?: Record<string, unknown> };
  assert.equal(publishedTask.artifacts?.pptx, undefined);
  assert.equal(publishedTask.artifacts?.pdf, undefined);
  assert.deepEqual(await api.cleanupAppGenerationRun({ run_id: transaction.run_id }), { cleaned: true });
});

test("abandonment leaves the official Workspace unchanged and retains its shadow for diagnostics", async () => {
  const created = await api.createAppWorkspace({ title: "Shadow abandon" });
  const markerPath = path.join(created.workspace_dir, "marker.txt");
  await writeFile(markerPath, "official", "utf8");
  const transaction = await api.beginAppGenerationRun({
    workspace_dir: created.workspace_dir,
    run_kind: "page-refinement",
  });
  await api.prepareAppGenerationRun({ run_id: transaction.run_id });
  await writeFile(path.join(transaction.shadow_workspace_dir, "marker.txt"), "shadow", "utf8");
  const abandoned = await api.abandonAppGenerationRun({ run_id: transaction.run_id });
  assert.equal(abandoned.state, "abandoned");
  assert.equal(await readFile(markerPath, "utf8"), "official");
  assert.deepEqual(await api.cleanupAppGenerationRun({ run_id: transaction.run_id }), { cleaned: false });
  assert.equal(await readFile(path.join(transaction.shadow_workspace_dir, "marker.txt"), "utf8"), "shadow");
  assert.equal(await api.getAppWorkspaceGenerationRun({ workspace_dir: created.workspace_dir }), null);
  assert.equal(await readFile(path.join(transaction.shadow_workspace_dir, "marker.txt"), "utf8"), "shadow");
});

test("recovery marks an interrupted preparation abandoned and retains its partial shadow", async () => {
  const created = await api.createAppWorkspace({ title: "Interrupted preparation" });
  const transaction = await api.beginAppGenerationRun({
    workspace_dir: created.workspace_dir,
    run_kind: "page-refinement",
  });
  const partialFile = path.join(transaction.shadow_workspace_dir, "slides", "partial.tsx");
  await mkdir(path.dirname(partialFile), { recursive: true });
  await writeFile(partialFile, "export default null;", "utf8");

  assert.equal(await api.getAppWorkspaceGenerationRun({ workspace_dir: created.workspace_dir }), null);
  const transactionRecord = JSON.parse(
    await readFile(path.join(path.dirname(path.dirname(transaction.shadow_workspace_dir)), "transaction.json"), "utf8"),
  ) as { state: string };
  assert.equal(transactionRecord.state, "abandoned");
  assert.equal(await readFile(partialFile, "utf8"), "export default null;");
});

test("Workspace Diagnostic Bundle includes every on-disk generation run, including abandoned runs", async () => {
  const created = await api.createAppWorkspace({ title: "Shadow diagnostics" });
  const abandonedTransaction = await api.beginAppGenerationRun({
    workspace_dir: created.workspace_dir,
    run_kind: "deck-generation",
  });
  await api.prepareAppGenerationRun({ run_id: abandonedTransaction.run_id });
  await writeFile(path.join(abandonedTransaction.shadow_workspace_dir, "abandoned-only.txt"), "abandoned diagnostic", "utf8");
  await api.abandonAppGenerationRun({ run_id: abandonedTransaction.run_id });
  await api.cleanupAppGenerationRun({ run_id: abandonedTransaction.run_id });

  const activeTransaction = await api.beginAppGenerationRun({
    workspace_dir: created.workspace_dir,
    run_kind: "page-refinement",
  });
  await api.prepareAppGenerationRun({ run_id: activeTransaction.run_id });
  await writeFile(path.join(activeTransaction.shadow_workspace_dir, "active-only.txt"), "active diagnostic", "utf8");

  const otherWorkspace = await api.createAppWorkspace({ title: "Other workspace" });
  const otherTransaction = await api.beginAppGenerationRun({
    workspace_dir: otherWorkspace.workspace_dir,
    run_kind: "deck-generation",
  });
  await api.prepareAppGenerationRun({ run_id: otherTransaction.run_id });
  await writeFile(path.join(otherTransaction.shadow_workspace_dir, "other-only.txt"), "other diagnostic", "utf8");

  const bundle = await api.prepareAppWorkspaceDiagnosticBundle({ workspace_dir: created.workspace_dir });
  try {
    const bytes = await readFile(bundle.archive_path);
    assert.equal(bytes.includes(Buffer.from(`generation-runs/${abandonedTransaction.run_id}/transaction.json`)), true);
    assert.equal(bytes.includes(Buffer.from(`generation-runs/${abandonedTransaction.run_id}/shadow/${created.workspace_id}/abandoned-only.txt`)), true);
    assert.equal(bytes.includes(Buffer.from(`generation-runs/${activeTransaction.run_id}/transaction.json`)), true);
    assert.equal(bytes.includes(Buffer.from(`generation-runs/${activeTransaction.run_id}/shadow/${created.workspace_id}/active-only.txt`)), true);
    assert.equal(bytes.includes(Buffer.from(`generation-runs/${otherTransaction.run_id}/transaction.json`)), false);
    assert.equal(bytes.includes(Buffer.from(`generation-runs/${otherTransaction.run_id}/shadow/${otherWorkspace.workspace_id}/other-only.txt`)), false);
  } finally {
    await unlink(bundle.archive_path).catch(() => undefined);
    await api.cleanupAppGenerationRun({ run_id: abandonedTransaction.run_id });
    await api.abandonAppGenerationRun({ run_id: activeTransaction.run_id });
    await api.cleanupAppGenerationRun({ run_id: activeTransaction.run_id });
    await api.abandonAppGenerationRun({ run_id: otherTransaction.run_id });
    await api.cleanupAppGenerationRun({ run_id: otherTransaction.run_id });
  }
});
