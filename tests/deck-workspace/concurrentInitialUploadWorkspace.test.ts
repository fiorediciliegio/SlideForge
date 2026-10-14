import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

describe("concurrent initial attachment upload", () => {
  it("single-flights Workspace creation before parallel uploads begin", async () => {
    const hook = await readFile(
      path.resolve("src/features/deck-workspace/hooks/useDeckWorkspace.ts"),
      "utf8",
    );
    const start = hook.indexOf("async function ensureCurrentWorkspace");
    const end = hook.indexOf("async function uploadUploadedSource", start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const source = hook.slice(start, end);

    assert.match(hook, /workspaceCreationPromiseRef = useRef<Promise<WorkspaceResult \| null> \| null>\(null\)/);
    assert.match(source, /const pendingCreation = workspaceCreationPromiseRef\.current;/);
    assert.match(source, /if \(pendingCreation\) return pendingCreation;/);
    assert.match(source, /workspaceCreationPromiseRef\.current = creation;/);
    assert.match(source, /workspaceCreationPromiseRef\.current = null;/);
  });
});
