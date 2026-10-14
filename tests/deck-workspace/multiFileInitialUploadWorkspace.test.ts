import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

function functionSource(source: string, name: string, nextMarker: string) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(nextMarker, start);
  assert.notEqual(start, -1, `${name} should exist`);
  assert.notEqual(end, -1, `${nextMarker} should follow ${name}`);
  return source.slice(start, end);
}

describe("initial multi-file attachment upload", () => {
  it("retains the newly created Workspace for later files in the same selection", async () => {
    const hook = await readFile(
      path.resolve("src/features/deck-workspace/hooks/useDeckWorkspace.ts"),
      "utf8",
    );
    const creationSource = functionSource(hook, "applyCreatedWorkspace", "useEffect(() =>");
    const ensureSource = functionSource(hook, "ensureCurrentWorkspace", "async function uploadUploadedSource");

    assert.match(creationSource, /currentWorkspaceRef\.current = workspace;/);
    assert.match(ensureSource, /const existingWorkspace = currentWorkspaceRef\.current;/);
    assert.match(ensureSource, /if \(existingWorkspace\) return existingWorkspace;/);
  });
});
