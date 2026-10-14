import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const HOOK = "src/features/deck-workspace/hooks/useDeckWorkspace.ts";
const ADAPTER = "src/api/annaPptBackend.ts";
const ENGINE_MANIFEST = "executas/ppt-engine/invoke-tools.json";

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.resolve(relativePath), "utf8");
}

describe("generation page preview route", () => {
  it("keeps preview identity on the active Shadow Workspace without image uploads", async () => {
    const hook = await readSource(HOOK);
    assert.match(hook, /activeGenerationRun\?\.shadowWorkspaceDir \?\? currentWorkspace\?\.workspace_dir/);
    assert.doesNotMatch(hook, /getWorkspacePageImage/);
  });

  it("clears previews whenever the run or Workspace is reset", async () => {
    const hook = await readSource(HOOK);
    const resets = hook.match(/resetGenerationPagePreviews\(\);/g) ?? [];

    assert.ok(resets.length >= 3, `expected the reset paths to clear previews, saw ${resets.length}`);
    assert.match(
      hook,
      /function resetGenerationPagePreviews\(\) \{[\s\S]*generationPagePreviewSessionRef\.current \+= 1;[\s\S]*setPinnedGenerationPreviewPageId\(null\);/,
    );
  });

  it("declares HTML preview for pages, covers and candidates", async () => {
    const manifest = JSON.parse(await readSource(ENGINE_MANIFEST));
    const tool = manifest.tools.find((entry: { name: string }) => entry.name === "app_get_workspace_page_html");
    assert.ok(tool);
    assert.equal(tool.parameters.find((entry: { name: string }) => entry.name === "page_id").required, false);
    assert.ok(tool.parameters.some((entry: { name: string }) => entry.name === "candidate_id"));
  });
});
