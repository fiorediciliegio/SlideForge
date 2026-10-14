import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("按页搜索独立持久化，工作区互斥、不可变快照与预算及租约归属", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ppt-page-search-"));
  const previousRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
  process.env.SLIDEFORGE_WORKSPACE_DIR = directory;
  try {
    const { appPageImageSearch, createAppWorkspace, prepareAppSharedResearchWorkspace, getAppSharedResearchContext, getAppWorkspaceSnapshotSyncState } = await import("../src/app-workspace/index.js");
    const workspace = await createAppWorkspace({ title: "按页补图" });
    assert.equal(path.dirname(workspace.workspace_dir), path.join(directory, "ppt"), "test workspace must stay inside its temporary root");
    const shared = await prepareAppSharedResearchWorkspace({ workspace_dir: workspace.workspace_dir });
    const original = await readFile(shared.progress_path, "utf8");
    const owner = randomUUID();
    const task = { id: randomUUID(), context: { target_key: "draft-one", page: { title: "未保存的页面", content: "未保存内容" } },
      max_searches: 10, checkpoint: { schema_version: 2, stages: {}, image: { searches: [] } }, status: "running", result_ids: [] };
    const input = { workspace_dir: workspace.workspace_dir, owner };
    await appPageImageSearch({ ...input, action: "acquire", task });
    await assert.rejects(appPageImageSearch({ ...input, owner: randomUUID(), action: "acquire", task: { ...task, id: randomUUID() } }), /BUSY/);
    await assert.rejects(appPageImageSearch({ ...input, owner: randomUUID(), action: "save", task }), /LEASE_LOST/);
    await assert.rejects(appPageImageSearch({ ...input, action: "save", task: { ...task, max_searches: 30 } }), /immutable/);
    await assert.rejects(appPageImageSearch({ ...input, action: "save", task: { ...task, context: { ...task.context, page: { title: "覆盖别页" } } } }), /immutable/);
    const savedTask = { ...task, checkpoint: { ...task.checkpoint, image: { searches: [{ query: "bridge", status: "completed" }] } }, status: "cancelled", result_ids: ["image-one"],
      results: [{ result_id: "image-one", aps_path: "aps/one", sha256: "a".repeat(64), mime_type: "image/png", bytes_size: 100, get_url: "https://signed.test/image?signature=secret", query: "bridge", source_url: "https://source.test/one" }] };
    const changeSeq = (await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir }))!.change_seq;
    await appPageImageSearch({ ...input, action: "save", task: savedTask });
    assert.ok((await getAppWorkspaceSnapshotSyncState({ workspace_dir: workspace.workspace_dir }))!.change_seq > changeSeq);
    const candidatePool = (await getAppSharedResearchContext({ workspace_dir: workspace.workspace_dir })).image_candidates!;
    assert.equal(candidatePool[0].candidate_id, "image-one"); assert.equal(candidatePool[0].description, "");
    assert.doesNotMatch(await readFile(path.join(workspace.workspace_dir, "research", "page-image-search", `${task.id}.json`), "utf8"), /signature=secret/);
    await appPageImageSearch({ ...input, action: "release" });
    const loaded = await appPageImageSearch({ workspace_dir: workspace.workspace_dir, action: "get", target_key: "draft-one" });
    assert.equal(loaded?.status, "cancelled"); assert.deepEqual(loaded?.result_ids, ["image-one"]);
    const resumed = await appPageImageSearch({ ...input, action: "acquire", task });
    assert.deepEqual(resumed?.checkpoint, savedTask.checkpoint, "stale clients must resume the newest saved checkpoint");
    assert.deepEqual(resumed?.result_ids, ["image-one"]);
    await appPageImageSearch({ ...input, action: "release" });
    const interrupted = await appPageImageSearch({ workspace_dir: workspace.workspace_dir, action: "get", target_key: "draft-one" });
    assert.equal(interrupted?.status, "failed", "an unowned running task must be resumable");
    assert.equal(await readFile(shared.progress_path, "utf8"), original);
    assert.equal(await appPageImageSearch({ workspace_dir: workspace.workspace_dir, action: "get", target_key: "different-page" }), null);
    await assert.rejects(appPageImageSearch({ ...input, action: "acquire", task: { ...task, id: "../../escape" } }), /Invalid/);
  } finally {
    if (previousRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR; else process.env.SLIDEFORGE_WORKSPACE_DIR = previousRoot;
    await rm(directory, { recursive: true, force: true });
  }
});
