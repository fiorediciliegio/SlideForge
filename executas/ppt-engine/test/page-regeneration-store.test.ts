import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { batchDirectory, candidateDirectory, publishPageRegenerationFiles, recoverPageRegenerationPublication } from "../src/page-regeneration/store.ts";

test("publication replaces only selected files and removes the obsolete revision authority", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ppt-alternative-publication-"));
  try {
    await writeFile(path.join(directory, "source.html"), "old");
    await writeFile(path.join(directory, "other.html"), "untouched");
    await writeFile(path.join(directory, "revision.json"), "manual");
    publishPageRegenerationFiles(directory, new Map([
      ["source.html", "new"], ["outline.json", "new outline"], ["revision.json", null],
    ]));
    assert.equal(await readFile(path.join(directory, "source.html"), "utf8"), "new");
    assert.equal(await readFile(path.join(directory, "other.html"), "utf8"), "untouched");
    await assert.rejects(readFile(path.join(directory, "revision.json")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(directory, ".page-regeneration-publication", "journal.json")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reopening recovers an interrupted multi-file publication without retaining a shadow Workspace", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ppt-alternative-recovery-"));
  try {
    const journal = path.join(directory, ".page-regeneration-publication");
    await mkdir(journal);
    await writeFile(path.join(directory, "source.html"), "partially published");
    await writeFile(path.join(directory, "new.html"), "partially published new file");
    await writeFile(path.join(journal, "0.previous"), "original");
    await writeFile(path.join(journal, "journal.json"), JSON.stringify([
      { relative: "source.html", existed: true }, { relative: "new.html", existed: false },
    ]));
    recoverPageRegenerationPublication(directory);
    assert.equal(await readFile(path.join(directory, "source.html"), "utf8"), "original");
    await assert.rejects(readFile(path.join(directory, "new.html")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("publication preparation failure preserves all official files and rejects escaping paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ppt-alternative-invalid-"));
  try {
    await writeFile(path.join(directory, "source.html"), "original");
    assert.throws(() => publishPageRegenerationFiles(directory, new Map([
      ["source.html", "new"], ["../outside.html", "outside"],
    ])), /outside Workspace/);
    assert.equal(await readFile(path.join(directory, "source.html"), "utf8"), "original");
    assert.throws(() => batchDirectory(directory, "../escape"), /Invalid/);
    assert.throws(() => candidateDirectory(directory, "11111111-1111-4111-8111-111111111111", "../escape"), /Invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
