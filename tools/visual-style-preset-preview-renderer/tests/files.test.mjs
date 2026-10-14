import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertDisjointDirectories } from "../src/files.mjs";

test("source and output roots must be separate and non-nested", async () => {
  const root = await mkdtemp(join(tmpdir(), "slideforge-preview-paths-"));
  try {
    const source = join(root, "source");
    const output = join(root, "output");
    await mkdir(source);
    await mkdir(output);
    await assert.doesNotReject(() => assertDisjointDirectories(source, output));
    await assert.rejects(() => assertDisjointDirectories(source, source), /must be separate/);
    await assert.rejects(() => assertDisjointDirectories(root, source), /must be separate/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
