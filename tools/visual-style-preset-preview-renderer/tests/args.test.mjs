import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/args.mjs";

test("render arguments keep paths supplied by the caller", () => {
  const result = parseArgs([
    "render",
    "--source-root", "./source",
    "--output-root", "./output",
    "--browser-executable", "./chromium",
    "--quality", "90",
  ]);
  assert.equal(result.sourceRoot, "./source");
  assert.equal(result.outputRoot, "./output");
  assert.equal(result.browserExecutable, "./chromium");
  assert.equal(result.quality, 90);
});

test("render rejects a missing browser path", () => {
  assert.throws(
    () => parseArgs(["render", "--source-root", "./source", "--output-root", "./output"]),
    /browser-executable is required/,
  );
});

test("convert-images does not require Chromium", () => {
  const result = parseArgs([
    "convert-images",
    "--source-root", "./source",
    "--output-root", "./output",
  ]);
  assert.equal(result.command, "convert-images");
  assert.equal(result.browserExecutable, undefined);
});
