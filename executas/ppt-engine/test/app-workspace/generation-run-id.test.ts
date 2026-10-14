import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  beginGenerationRun, prepareGenerationRun, recoverGenerationRunForWorkspace,
  commitGenerationRun, cleanupGenerationRun, type AppGenerationRunTransaction,
} from "../../src/app-workspace/generation-run.ts";

for (const legacy of [false, true]) {
  test(`${legacy ? "legacy UUID" : "short ID"} run can recover, publish and clean up`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ppt-run-id-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const official = path.join(root, "deck");
    await mkdir(official);
    await writeFile(path.join(official, "marker.txt"), "original");
    let transaction: AppGenerationRunTransaction;
    if (legacy) {
      const id = "d8e0ae41-36c6-43cf-bea1-78bae4a88ac6";
      const runRoot = path.join(root, ".generation-runs", id);
      transaction = {
        schema_version: 1, run_id: id, workspace_id: "deck", run_kind: "deck-generation",
        state: "preparing", official_workspace_dir: official,
        shadow_workspace_dir: path.join(runRoot, "shadow", "deck"),
        previous_workspace_dir: path.join(runRoot, "previous", "deck"),
        origin_page_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      await mkdir(runRoot, { recursive: true });
      await writeFile(path.join(runRoot, "transaction.json"), JSON.stringify(transaction));
    } else {
      transaction = await beginGenerationRun({ workspace_root: root, official_workspace_dir: official,
        workspace_id: "deck", run_kind: "deck-generation" });
      assert.match(transaction.run_id, /^[0-9a-f]{12}$/);
    }
    await prepareGenerationRun(root, transaction.run_id);
    assert.equal((await recoverGenerationRunForWorkspace(root, "deck"))?.run_id, transaction.run_id);
    await writeFile(path.join(transaction.shadow_workspace_dir, "marker.txt"), "updated");
    await commitGenerationRun(root, transaction.run_id);
    assert.equal(await readFile(path.join(official, "marker.txt"), "utf8"), "updated");
    assert.equal(await cleanupGenerationRun(root, transaction.run_id), true);
    await assert.rejects(access(path.join(root, ".generation-runs", transaction.run_id)), { code: "ENOENT" });
  });
}

test("ID collisions preserve existing runs, retry and fail with a bounded budget", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-run-collision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const existing = path.join(root, ".generation-runs", "111111111111");
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, "transaction.json"), "existing transaction");
  let calls = 0;
  const random = t.mock.method(crypto, "randomBytes", () => Buffer.alloc(6, ++calls === 2 ? 0x22 : 0x11));
  syncBuiltinESMExports();
  try {
    const input = { workspace_root: root, official_workspace_dir: path.join(root, "deck"),
      workspace_id: "deck", run_kind: "deck-generation" as const };
    assert.equal((await beginGenerationRun(input)).run_id, "222222222222");
    assert.equal(calls, 2);
    await assert.rejects(beginGenerationRun(input), /after 10 attempts/);
    assert.equal(calls, 12);
    assert.equal(await readFile(path.join(existing, "transaction.json"), "utf8"), "existing transaction");
  } finally {
    random.mock.restore();
    syncBuiltinESMExports();
  }
});
