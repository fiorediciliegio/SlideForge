import assert from "node:assert/strict";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function writeCompletedPageWorkspace(
  workspaceDir: string,
  options: {
    outline: "empty" | "draft" | "confirmed";
    progressPageId?: string;
    extraArchivedPageId?: string;
  } = { outline: "confirmed" },
) {
  const pageId = "page-semantic-check";
  await mkdir(path.join(workspaceDir, "slides"), { recursive: true });
  await writeFile(path.join(workspaceDir, "slides", `${pageId}.html`), "<!doctype html><title>Page</title>", "utf8");
  if (options.extraArchivedPageId) {
    await writeFile(
      path.join(workspaceDir, "slides", `${options.extraArchivedPageId}.html`),
      "<!doctype html><title>Unreferenced page</title>",
      "utf8",
    );
  }
  await writeFile(path.join(workspaceDir, "manifest.json"), JSON.stringify({
    title: "Snapshot semantic validation",
    slides: [{ id: pageId, source: `./slides/${pageId}.html` }],
  }), "utf8");
  await writeFile(path.join(workspaceDir, "outline.json"), JSON.stringify(
    options.outline === "confirmed"
      ? {
          version: 4,
          status: "confirmed",
          title: "Snapshot semantic validation",
          items: [{ page_id: pageId, title: "Page", content: "Content" }],
          updated_at: "2026-09-08T00:00:00.000Z",
          confirmed_at: "2026-09-08T00:00:00.000Z",
        }
      : options.outline === "draft"
        ? {
            version: 4,
            status: "draft",
            title: "Snapshot semantic validation",
            // A draft intentionally has no page_id, even when the prior Deck
            // still owns manifest/page-progress identities.
            items: [{ title: "Page", core_message: "Message", content: "Content" }],
            updated_at: "2026-09-08T00:00:00.000Z",
            confirmed_at: null,
          }
      : { version: 4, status: "empty", title: "", items: [], updated_at: null, confirmed_at: null },
  ), "utf8");
  await writeFile(path.join(workspaceDir, "page-progress.json"), JSON.stringify({
    status: "completed",
    pages: [{ page_id: options.progressPageId ?? pageId, status: "accepted" }],
    updated_at: "2026-09-08T00:00:00.000Z",
  }), "utf8");
}

test("snapshot publication accepts a blank workspace and a confirmed outline before pages exist", async () => {
  const api = await import("../../src/app-workspace/index.ts");
  const blank = await api.createAppWorkspace({ title: "Blank semantic validation" });

  const blankSnapshot = await api.publishAppWorkspaceSnapshot({ workspace_dir: blank.workspace_dir });
  assert.equal(blankSnapshot.status, "generated");
  assert.ok(blankSnapshot.snapshot_path);

  const confirmedOnly = await api.createAppWorkspace({ title: "Confirmed outline semantic validation" });
  await writeFile(path.join(confirmedOnly.workspace_dir, "outline.json"), JSON.stringify({
    version: 4,
    status: "confirmed",
    title: "Confirmed before page generation",
    items: [{ page_id: "page-planned", title: "Planned" }],
    updated_at: "2026-09-08T00:00:00.000Z",
    confirmed_at: "2026-09-08T00:00:00.000Z",
  }), "utf8");

  const confirmedSnapshot = await api.publishAppWorkspaceSnapshot({ workspace_dir: confirmedOnly.workspace_dir });
  assert.equal(confirmedSnapshot.status, "generated");
  assert.ok(confirmedSnapshot.snapshot_path);
});

test("snapshot publication accepts completed pages with a later outline draft", async () => {
  const api = await import("../../src/app-workspace/index.ts");
  const workspace = await api.createAppWorkspace({ title: "Semantic draft with existing pages" });
  await writeCompletedPageWorkspace(workspace.workspace_dir, { outline: "draft" });

  const result = await api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir });
  assert.equal(result.status, "generated");
  assert.ok(result.snapshot_path);
});

test("snapshot publication rejects completed progress that does not match manifest pages", async () => {
  const api = await import("../../src/app-workspace/index.ts");
  const workspace = await api.createAppWorkspace({ title: "Semantic progress mismatch" });
  await writeCompletedPageWorkspace(workspace.workspace_dir, {
    outline: "confirmed",
    progressPageId: "page-other",
  });

  await assert.rejects(
    () => api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir }),
    /Snapshot semantic validation failed: completed_progress_page_ids_mismatch/,
  );
});

test("snapshot publication accepts a complete, internally consistent workspace", async () => {
  const api = await import("../../src/app-workspace/index.ts");
  const workspace = await api.createAppWorkspace({ title: "Semantic validation success" });
  await writeCompletedPageWorkspace(workspace.workspace_dir);

  const result = await api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir });
  assert.equal(result.status, "generated");
  assert.ok(result.snapshot_path);
});

test("snapshot publication excludes archived pages absent from the manifest (orphan slides)", async () => {
  const api = await import("../../src/app-workspace/index.ts");
  const { getWorkspaceSnapshotSyncState } = await import("../../src/app-workspace/snapshot-sync.ts");
  const workspace = await api.createAppWorkspace({ title: "Semantic archived page mismatch" });
  await writeCompletedPageWorkspace(workspace.workspace_dir, {
    outline: "confirmed",
    extraArchivedPageId: "page-unreferenced",
  });

  // Orphan slides/<id>.html left on disk after a page-set replacement used to
  // fail semantic validation with manifest_archive_slide_ids_mismatch and
  // permanently block cloud publish. The snapshot build now excludes undeclared
  // slides, so publication succeeds and the orphan never enters the archive.
  const result = await api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir });
  assert.equal(result.status, "generated");
  assert.ok(result.snapshot_path);

  const state = await getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.equal(state?.semantic_validation_failed, null);

  const { readFile } = await import("node:fs/promises");
  const zipBytes = await readFile(result.snapshot_path);
  assert.equal(zipBytes.includes(Buffer.from("page-unreferenced.html")), false);
  assert.equal(zipBytes.includes(Buffer.from("slides/page-semantic-check.html")), true);
});

test("a rejected candidate preserves the last valid snapshot, then a later local rebuild clears the failure marker", async () => {
  const api = await import("../../src/app-workspace/index.ts");
  const { getWorkspaceSnapshotSyncState } = await import("../../src/app-workspace/snapshot-sync.ts");
  const workspace = await api.createAppWorkspace({ title: "Semantic candidate isolation" });
  await writeCompletedPageWorkspace(workspace.workspace_dir);
  await api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir });

  const before = await getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.ok(before?.snapshot_path);
  const snapshotDir = path.dirname(before.snapshot_path);
  const filesBefore = (await readdir(snapshotDir)).sort();

  await writeCompletedPageWorkspace(workspace.workspace_dir, {
    outline: "confirmed",
    progressPageId: "page-other",
  });
  // page-progress is intentionally excluded from the content fingerprint, so
  // also change an authoritative fingerprinted file and force a new candidate
  // through semantic validation.
  await writeFile(
    path.join(workspace.workspace_dir, "requirements.json"),
    JSON.stringify({ snapshot_semantic_test: "invalid-progress-candidate" }),
    "utf8",
  );
  const invalidChange = await api.markAppWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
  await assert.rejects(
    () => api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir }),
    /Snapshot semantic validation failed: completed_progress_page_ids_mismatch/,
  );

  const after = await getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.equal(after?.revision, before.revision);
  assert.equal(after?.source_sha256, before.source_sha256);
  assert.equal(after?.snapshot_path, before.snapshot_path);
  assert.equal(after?.snapshot_sha256, before.snapshot_sha256);
  assert.equal(after?.semantic_validation_failed?.source_sha256 !== before.source_sha256, true);
  assert.equal(after?.semantic_validation_failed?.change_seq, invalidChange.change_seq);
  assert.deepEqual(
    after?.semantic_validation_failed?.errors.map((error) => error.code),
    ["completed_progress_page_ids_mismatch"],
  );
  await stat(before.snapshot_path);
  assert.deepEqual((await readdir(snapshotDir)).sort(), filesBefore);

  await writeCompletedPageWorkspace(workspace.workspace_dir);
  const repairedChange = await api.markAppWorkspaceSnapshotDirty({ workspace_dir: workspace.workspace_dir });
  // A new authoritative mutation clears the old candidate's diagnostic before
  // the replacement ZIP is generated. It cannot be mistaken for failure of
  // this later sequence.
  const beforeRebuild = await getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.equal(beforeRebuild?.semantic_validation_failed, null);
  assert.equal(beforeRebuild?.pending_change_seq, repairedChange.change_seq);
  // The retry scheduler uses this same local rebuild entry point. No new
  // business commit is required once the workspace files have settled back
  // into a semantically valid combination.
  const repaired = await api.publishAppWorkspaceSnapshot({ workspace_dir: workspace.workspace_dir });
  const recovered = await getWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
  assert.equal(repaired.status, "generated");
  assert.notEqual(recovered?.revision, before.revision);
  assert.equal(recovered?.semantic_validation_failed, null);
});
