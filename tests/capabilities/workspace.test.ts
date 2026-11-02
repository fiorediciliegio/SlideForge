import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDeck } from "../../src/capabilities/deck.ts";
import { createDeckWorkspace, resolveDeckRunDir } from "../../src/capabilities/workspace.ts";

test("workspace uses the exact external deck id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slideforge-workspace-"));
  const runDir = await createDeckWorkspace(root, "deck-Shared-123");
  assert.equal(runDir, resolveDeckRunDir(root, "deck-Shared-123"));
  assert.equal(path.basename(runDir), "deck-Shared-123");
});

test("createDeck uses the external id before model invocation and rejects reuse", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slideforge-create-workspace-"));
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const input = {
    deckId: "deck-external-contract",
    brief: "测试",
    pageCount: 2,
    concurrency: 1,
    decksRoot: root,
  } as const;
  try {
    await assert.rejects(() => createDeck(input), /Missing env OPENAI_API_KEY/);
    assert.deepEqual(await readdir(root), ["deck-external-contract"]);
    await assert.rejects(() => createDeck(input), /EEXIST|already exists/);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("workspace rejects existing directories instead of overwriting them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slideforge-workspace-"));
  const runDir = await createDeckWorkspace(root, "deck-duplicate");
  await writeFile(path.join(runDir, "outline.json"), "keep");
  await assert.rejects(() => createDeckWorkspace(root, "deck-duplicate"), /EEXIST|already exists/);
  assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(runDir, "outline.json"), "utf8")), "keep");
});

test("workspace rejects traversal and ambiguous identifiers", () => {
  for (const id of ["deck-../escape", "deck-..", "deck-a/b", "deck-a\\b", "../deck-a", "deck-a b"]) {
    assert.throws(() => resolveDeckRunDir("artifacts/decks", id));
  }
});
