import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutoRestoreMissingWorkspacesResult, ListWorkspacesResult, WorkspaceSummary } from "../../src/api/types.ts";
import { loadMyWork } from "../../src/features/deck-workspace/loadMyWork.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const scan = (ids: string[]) => ({ workspaces: ids.map((id) => ({ workspace_id: id, workspace_dir: `/tmp/${id}`, has_deck_html: true }) as WorkspaceSummary) }) as ListWorkspacesResult;
const restored = { workspace_root: "/tmp", restored: [{ workspace_id: "restored", revision: null, status: "completed" }], skipped: [], failed: [] } satisfies AutoRestoreMissingWorkspacesResult;
function harness() {
  const local = deferred<ListWorkspacesResult>();
  const cloud = deferred<{ workspaces: [] }>();
  const sync = deferred<null>();
  const restoration = deferred<AutoRestoreMissingWorkspacesResult>();
  const published: string[] = [], backgrounds: string[] = [], errors: unknown[] = [];
  let current = true, restoredCount = 0, timings = 0;
  const input: Parameters<typeof loadMyWork>[0] = {
    backend: { listWorkspaces: () => local.promise, listMyWork: () => cloud.promise, getWorkspaceSnapshotSyncState: () => sync.promise },
    restoration: restoration.promise, isCurrent: () => current,
    onList: (value) => published.push(`list:${value.workspaces.map((item) => item.workspace_id).join(",")}`),
    onListError: (error) => errors.push(error), onCloudWorkspaces: () => backgrounds.push("cloud"),
    onSyncState: (id) => backgrounds.push(`sync:${id}`), onRestored: (count) => { restoredCount += count; },
    onTiming: () => { timings++; }, onBackgroundError: (_source, error) => errors.push(error),
  };
  return { input, local, cloud, sync, restoration, published, backgrounds, errors,
    invalidate: () => { current = false; }, restoredCount: () => restoredCount, timings: () => timings };
}

test("local list finishes without waiting for cover downloads, cloud, restore or sync", async () => {
  const h = harness();
  const loading = loadMyWork(h.input);
  h.local.resolve(scan(["1", "2", "3", "4", "5"]));
  await loading;
  assert.deepEqual(h.published, ["list:1,2,3,4,5"]);
  assert.equal(h.timings(), 1);
  assert.deepEqual(h.backgrounds, []);
  h.cloud.resolve({ workspaces: [] }); h.sync.resolve(null); h.restoration.resolve(restored);
  await tick();
  assert.ok(h.backgrounds.includes("cloud"));
  assert.equal(h.backgrounds.filter((item) => item.startsWith("sync:")).length, 5);
  assert.equal(h.restoredCount(), 1);
});

test("background failures cannot hide the local list", async () => {
  const h = harness(); const loading = loadMyWork(h.input);
  h.cloud.reject(new Error("cloud unavailable")); h.restoration.reject(new Error("restore unavailable"));
  h.local.resolve(scan(["1"])); await tick(); h.sync.reject(new Error("sync unavailable"));
  await loading; await tick();
  assert.deepEqual(h.published, ["list:1"]);
  assert.deepEqual(h.backgrounds, ["sync:1"]);
  assert.equal(h.errors.length, 2);
});

test("skipCloudList leaves the cloud listing to the caller without stalling the rest", async () => {
  const h = harness();
  const loading = loadMyWork({ ...h.input, skipCloudList: true });
  h.local.resolve(scan(["1"]));
  await loading; await tick();
  assert.deepEqual(h.published, ["list:1"]);
  assert.equal(h.timings(), 1);

  // The cloud deferred never settles: nothing was ever asked of it.
  h.sync.resolve(null); h.restoration.resolve(restored);
  await tick();
  assert.ok(!h.backgrounds.includes("cloud"));
  assert.deepEqual(h.backgrounds, ["sync:1"]);
  assert.equal(h.restoredCount(), 1);
  assert.deepEqual(h.errors, []);
});

test("late background responses and old lists cannot write into a newer visit", async () => {
  for (const failed of [false, true]) {
    const h = harness(); const loading = loadMyWork(h.input); h.invalidate();
    if (failed) h.local.reject(new Error("old list")); else h.local.resolve(scan(["old"]));
    h.cloud.resolve({ workspaces: [] }); h.sync.resolve(null); h.restoration.resolve(restored);
    await loading; await tick();
    assert.deepEqual(h.published, []); assert.deepEqual(h.errors, []); assert.deepEqual(h.backgrounds, []);
    assert.equal(h.restoredCount(), 0);
  }
});

test("the newest visit observes shared restoration and reloads the local list", async () => {
  const old = harness(); const oldLoading = loadMyWork(old.input); old.invalidate();
  const current = harness(); let refreshed: Promise<void> | undefined;
  current.input.restoration = old.restoration.promise;
  current.input.onRestored = () => {
    current.invalidate();
    refreshed = loadMyWork({ ...current.input, restoration: null, isCurrent: () => true,
      backend: { ...current.input.backend, listWorkspaces: async () => scan(["restored"]) } });
  };
  const loading = loadMyWork(current.input); old.restoration.resolve(restored); await tick(); await refreshed;
  old.local.resolve(scan(["old"])); current.local.resolve(scan(["before-restore"]));
  await Promise.all([oldLoading, loading]);
  assert.deepEqual(old.published, []); assert.deepEqual(current.published, ["list:restored"]);
});
