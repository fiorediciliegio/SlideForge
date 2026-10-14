import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

function functionSource(source: string, name: string, nextName: string) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${nextName}`, start);
  assert.notEqual(start, -1, `${name} should exist`);
  assert.notEqual(end, -1, `${nextName} should exist after ${name}`);
  return source.slice(start, end);
}

describe("workspace navigation attachment reset", () => {
  it("does not leave attachment IDs from the previous workspace on a new Brief", async () => {
    const hook = await readFile(
      path.resolve("src/features/deck-workspace/hooks/useDeckWorkspace.ts"),
      "utf8",
    );
    const source = functionSource(hook, "startNewPresentation", "openWorkspace");

    assert.match(source, /setCurrentWorkspace\(null\);/);
    assert.match(source, /setUploadedSources\(\[\]\);/);
    assert.match(source, /setUploadedSourcePreflights\(\[\]\);/);
  });

  it("also clears attachment state before opening the workspace picker", async () => {
    const hook = await readFile(
      path.resolve("src/features/deck-workspace/hooks/useDeckWorkspace.ts"),
      "utf8",
    );
    const source = functionSource(hook, "showWorkspacePicker", "startNewPresentation");

    assert.match(source, /setCurrentWorkspace\(null\);/);
    assert.match(source, /setUploadedSources\(\[\]\);/);
    assert.match(source, /setUploadedSourcePreflights\(\[\]\);/);
  });
});
