import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

describe("requirements confirmation navigation", () => {
  it("runs Web research before creating the Outline", async () => {
    const source = await readFile(
      path.resolve("src/features/deck-workspace/hooks/useDeckWorkspace.ts"),
      "utf8",
    );
    const start = source.indexOf("async function confirmPresentationRequirements");
    const end = source.indexOf("async function runWebResearchBeforeOutline", start);
    const body = source.slice(start, end);
    assert.match(body, /setStage\("outline"\)/);
    assert.match(body, /setLoading\("outline"\)/);
    assert.match(body, /await runWebResearchBeforeOutline\(resetWorkspace, false\)/);
    assert.match(body, /await createOutlineFromConfirmedRequirements\(resetWorkspace\)/);
    assert.ok(
      body.indexOf("await runWebResearchBeforeOutline(resetWorkspace, false)")
        < body.indexOf("await createOutlineFromConfirmedRequirements(resetWorkspace)"),
    );
  });
});
