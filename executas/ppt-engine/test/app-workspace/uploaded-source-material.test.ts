import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("uploaded source material persists identities, active state, and analysis artifacts", async () => {
  const previousHome = process.env.HOME;
  const previousWorkspaceRoot = process.env.ANNA_WORKSPACE_DIR;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "presenton-uploaded-source-home-"));
  process.env.HOME = homeDir;
  process.env.ANNA_WORKSPACE_DIR = path.join(homeDir, "anna-workspace");

  const {
    createAppWorkspace,
    uploadAppUploadedSource,
    commitAppUploadedSourceUpload,
    listAppUploadedSources,
    removeAppUploadedSource,
    ignoreAppUploadedSource,
    runAppUploadedSourcePreflight,
    recordAppAttachmentBrief,
    writeAppAttachmentContext,
    prepareAppUploadedSourceAnalysisWorkspace,
    recordAppUploadedSourceAnalysisDraft,
    getAppUploadedSourceAnalysisDraft,
    getAppUploadedSourceAnalysisDraftFingerprint,
    recordAppUploadedSourceAnalysis,
    getAppUploadedSourceAnalysis,
    getAppWorkspaceSnapshotSyncState,
  } = await import("../../src/app-workspace/index.ts");

  try {
    const workspace = await createAppWorkspace({ title: "Uploaded source workspace" });
    const bytes = Buffer.from("source facts", "utf8");
    const first = await uploadAppUploadedSource({
      workspace_dir: workspace.workspace_dir,
      filename: "source.md",
      mime_type: "text/markdown",
      content_base64: bytes.toString("base64"),
    });
    const duplicate = await uploadAppUploadedSource({
      workspace_dir: workspace.workspace_dir,
      filename: "source.md",
      mime_type: "text/markdown",
      content_base64: bytes.toString("base64"),
    });

    assert.notEqual(first.material.uploaded_source_id, duplicate.material.uploaded_source_id);
    assert.deepEqual(duplicate.material.duplicate_of, [first.material.uploaded_source_id]);
    assert.equal((await stat(first.material.file_path)).isFile(), true);

    // Every persisted member of the uploaded-source authority set must advance
    // the snapshot change sequence, even though none of these writes starts a
    // publish directly. This leaves one scheduler-visible pending revision
    // after the whole local transaction has settled.
    let dirtyState = await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
    assert.ok(dirtyState);
    assert.ok(dirtyState.change_seq >= 2);

    const preflight = await runAppUploadedSourcePreflight({ workspace_dir: workspace.workspace_dir });
    assert.equal(preflight.results.length, 2);
    let nextDirtyState = await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
    assert.ok(nextDirtyState && nextDirtyState.change_seq > dirtyState.change_seq);
    dirtyState = nextDirtyState!;

    await recordAppAttachmentBrief({
      workspace_dir: workspace.workspace_dir,
      uploaded_source_id: first.material.uploaded_source_id,
      brief: {
        content_strategy: "full_context",
        original_reading_method: "document_read",
        content: "source facts",
        key_facts: [],
        must_include: [],
        must_avoid: [],
        recommended_storyline: [],
        gaps: [],
        unread_content: [],
      },
    });
    nextDirtyState = await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
    assert.ok(nextDirtyState && nextDirtyState.change_seq > dirtyState.change_seq);
    dirtyState = nextDirtyState!;

    await writeAppAttachmentContext({ workspace_dir: workspace.workspace_dir, user_brief: "Use the source facts." });
    nextDirtyState = await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
    assert.ok(nextDirtyState && nextDirtyState.change_seq > dirtyState.change_seq);
    dirtyState = nextDirtyState!;

    const listed = await listAppUploadedSources({ workspace_dir: workspace.workspace_dir });
    assert.equal(listed.active.length, 2);

    const removed = await removeAppUploadedSource({
      workspace_dir: workspace.workspace_dir,
      uploaded_source_id: first.material.uploaded_source_id,
    });
    assert.equal(removed.material.status, "removed");
    assert.equal((await stat(first.material.file_path)).isFile(), true);
    assert.equal(
      (await listAppUploadedSources({ workspace_dir: workspace.workspace_dir })).index.active_total_size_bytes,
      duplicate.material.size_bytes,
    );
    nextDirtyState = await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
    assert.ok(nextDirtyState && nextDirtyState.change_seq > dirtyState.change_seq);
    dirtyState = nextDirtyState!;

    const ignored = await ignoreAppUploadedSource({
      workspace_dir: workspace.workspace_dir,
      uploaded_source_id: duplicate.material.uploaded_source_id,
      reason: "Snapshot dirty coverage test",
    });
    assert.equal(ignored.material.status, "ignored");
    nextDirtyState = await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
    assert.ok(nextDirtyState && nextDirtyState.change_seq > dirtyState.change_seq);
    dirtyState = nextDirtyState!;

    await assert.rejects(
      () => uploadAppUploadedSource({
        workspace_dir: workspace.workspace_dir,
        filename: "run.sh",
        mime_type: "text/x-shellscript",
        content_base64: Buffer.from("echo bad").toString("base64"),
      }),
      /Unsupported uploaded source file type/,
    );

    const prepared = await prepareAppUploadedSourceAnalysisWorkspace({
      workspace_dir: workspace.workspace_dir,
    });
    assert.equal(path.basename(prepared.factual_draft_path), "uploaded-source-factual.json");
    assert.equal(prepared.uploaded_source_index.materials.length, 2);
    nextDirtyState = await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
    assert.ok(nextDirtyState && nextDirtyState.change_seq > dirtyState.change_seq);
    dirtyState = nextDirtyState!;

    const draft = await recordAppUploadedSourceAnalysisDraft({
      workspace_dir: workspace.workspace_dir,
      draft_type: "factual",
      draft: { version: 1, draft_type: "factual", status: "ready" },
    });
    assert.equal(draft.draft_type, "factual");
    assert.equal((await getAppUploadedSourceAnalysisDraft({
      workspace_dir: workspace.workspace_dir,
      draft_type: "factual",
    })).status, "ready");
    assert.equal((await getAppUploadedSourceAnalysisDraftFingerprint({
      workspace_dir: workspace.workspace_dir,
      draft_type: "factual",
    })).exists, true);
    nextDirtyState = await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
    assert.ok(nextDirtyState && nextDirtyState.change_seq > dirtyState.change_seq);
    dirtyState = nextDirtyState!;

    const analysis = await recordAppUploadedSourceAnalysis({
      workspace_dir: workspace.workspace_dir,
      analysis: { version: 1, status: "ready", source: { active_uploaded_sources: [] } },
    });
    assert.equal(analysis.status, "ready");
    assert.equal((await getAppUploadedSourceAnalysis({ workspace_dir: workspace.workspace_dir })).status, "ready");
    nextDirtyState = await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir });
    assert.ok(nextDirtyState && nextDirtyState.change_seq > dirtyState.change_seq);

    const concurrent = await Promise.all([
      uploadAppUploadedSource({
        workspace_dir: workspace.workspace_dir,
        filename: "concurrent-a.md",
        mime_type: "text/markdown",
        content_base64: Buffer.from("concurrent a").toString("base64"),
      }),
      uploadAppUploadedSource({
        workspace_dir: workspace.workspace_dir,
        filename: "concurrent-b.md",
        mime_type: "text/markdown",
        content_base64: Buffer.from("concurrent b").toString("base64"),
      }),
    ]);
    const afterConcurrent = await listAppUploadedSources({ workspace_dir: workspace.workspace_dir });
    assert.ok(afterConcurrent.active.some((item) => item.uploaded_source_id === concurrent[0].material.uploaded_source_id));
    assert.ok(afterConcurrent.active.some((item) => item.uploaded_source_id === concurrent[1].material.uploaded_source_id));
    assert.equal(
      afterConcurrent.index.active_total_size_bytes,
      afterConcurrent.active.reduce((sum, item) => sum + item.size_bytes, 0),
    );

    const stagingPath = path.join(homeDir, "staged-upload.md");
    const stagedBytes = Buffer.from("staged source facts", "utf8");
    await writeFile(stagingPath, stagedBytes);
    const committed = await commitAppUploadedSourceUpload({
      workspace_dir: workspace.workspace_dir,
      upload_id: "upload-test",
      filename: "staged.md",
      mime_type: "text/markdown",
      staging_file_path: stagingPath,
      expected_size_bytes: stagedBytes.byteLength,
    });
    assert.equal(committed.upload_id, "upload-test");
    assert.equal(committed.material.size_bytes, stagedBytes.byteLength);

    await Promise.all([
      removeAppUploadedSource({
        workspace_dir: workspace.workspace_dir,
        uploaded_source_id: concurrent[0].material.uploaded_source_id,
      }),
      uploadAppUploadedSource({
        workspace_dir: workspace.workspace_dir,
        filename: "during-remove.md",
        mime_type: "text/markdown",
        content_base64: Buffer.from("during remove").toString("base64"),
      }),
    ]);
    const afterMixed = await listAppUploadedSources({ workspace_dir: workspace.workspace_dir });
    assert.equal(
      afterMixed.index.active_total_size_bytes,
      afterMixed.active.reduce((sum, item) => sum + item.size_bytes, 0),
    );
  } finally {
    process.env.HOME = previousHome;
    if (previousWorkspaceRoot === undefined) delete process.env.ANNA_WORKSPACE_DIR;
    else process.env.ANNA_WORKSPACE_DIR = previousWorkspaceRoot;
    await rm(homeDir, { recursive: true, force: true });
  }
});
