import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkspaceResult } from "../../src/api/types.ts";
import { createWorkspaceReviewRenderKey } from "../../src/features/deck-workspace/workspaceReviewRenderKey.ts";

function makeWorkspace(overrides: Partial<WorkspaceResult> = {}): WorkspaceResult {
  return {
    workspace_dir: "/tmp/workspaces/demo",
    files: { manifest: "/tmp/workspaces/demo/manifest.json" },
    setting: { page_generation_concurrency: 3 },
    outline: { updated_at: "2026-07-03T00:01:00.000Z" },
    page_progress: { updated_at: "2026-07-03T00:03:00.000Z" },
    ...overrides,
  } as WorkspaceResult;
}

describe("workspace review render key", () => {
  it("does not invalidate rendered previews for non-rendering setting saves", () => {
    const before = makeWorkspace();
    const after = makeWorkspace({
      setting: {
        page_generation_concurrency: 5,
        updated_at: "2026-07-03T00:10:00.000Z",
      },
    });

    assert.equal(createWorkspaceReviewRenderKey(after), createWorkspaceReviewRenderKey(before));
  });

  it("invalidates rendered previews when render-affecting workspace artifacts change", () => {
    const before = makeWorkspace();
    for (const change of [
      { outline: { updated_at: "2026-07-03T00:10:00.000Z" } },
      { page_progress: { updated_at: "2026-07-03T00:10:00.000Z" } },
      { files: { manifest: "/tmp/workspaces/demo/new-manifest.json" } },
    ]) {
      assert.notEqual(createWorkspaceReviewRenderKey(makeWorkspace(change as Partial<WorkspaceResult>)), createWorkspaceReviewRenderKey(before));
    }
  });
});
