import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deckJobs, loadDeckJobs, persistDeckJob, type DeckJob } from "../../src/server/jobs.ts";

test("job snapshots restore ownership and mark interrupted generation as failed", async () => {
  const previousDataDir = process.env.SLIDEFORGE_DATA_DIR;
  process.env.SLIDEFORGE_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "slideforge-jobs-"));
  deckJobs.clear();
  try {
    const ready: DeckJob = { id: "deck-ready", status: "ready", events: [], overflowPages: [], ownerKeyHash: "owner-a" };
    const interrupted: DeckJob = { id: "deck-running", status: "creating", events: [], overflowPages: [], ownerKeyHash: "owner-b" };
    deckJobs.set(ready.id, ready);
    deckJobs.set(interrupted.id, interrupted);
    await persistDeckJob(ready);
    await persistDeckJob(interrupted);
    deckJobs.clear();
    await loadDeckJobs();
    assert.equal(deckJobs.get("deck-ready")?.ownerKeyHash, "owner-a");
    assert.equal(deckJobs.get("deck-running")?.status, "error");
    assert.match(deckJobs.get("deck-running")?.error ?? "", /重启/);
  } finally {
    deckJobs.clear();
    if (previousDataDir === undefined) delete process.env.SLIDEFORGE_DATA_DIR;
    else process.env.SLIDEFORGE_DATA_DIR = previousDataDir;
  }
});
