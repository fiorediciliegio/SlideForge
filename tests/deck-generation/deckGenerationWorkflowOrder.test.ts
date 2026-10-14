import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import path from "node:path";

const workflowPath = path.resolve(
  import.meta.dirname,
  "../../src/features/deck-generation/deckGenerationWorkflow.ts",
);

describe("Deck Generation workflow order", () => {
  it("loads previously collected images while preparing the visual master", async () => {
    const source = await readFile(workflowPath, "utf8");
    const researchPromiseIndex = source.indexOf("const researchPromise = input.backend.getSharedResearchContext");
    const artifactsPromiseIndex = source.indexOf("const artifactsPromise = (startMode === \"resume\"");

    assert.ok(researchPromiseIndex >= 0);
    assert.ok(artifactsPromiseIndex > researchPromiseIndex);
    assert.doesNotMatch(source.slice(researchPromiseIndex, artifactsPromiseIndex), /runLinearSharedResearch/);

    assert.match(source, /Promise\.all\(\[researchPromise, artifactsPromise\]\)/);
  });

  it("reuses persisted research for HTML page refinement", async () => {
    const source = await readFile(workflowPath, "utf8");
    assert.match(source, /if \(input\.reuseExistingResearch\)/);
    assert.match(source, /input\.backend\.getSharedResearchContext\(/);
    assert.match(source, /reuseExistingResearch[\s\S]*getSharedResearchContext/);
  });

  it("can stop after shared research before preparing page-generation artifacts", async () => {
    const source = await readFile(workflowPath, "utf8");
    const testStopIndex = source.indexOf("if (input.stopAfterImageResearch)");
    const initialArtifactsIndex = source.indexOf("const artifactsPromise = (startMode === \"resume\"");

    assert.ok(testStopIndex >= 0);
    assert.ok(initialArtifactsIndex > testStopIndex);
    assert.doesNotMatch(source.slice(testStopIndex, initialArtifactsIndex), /runLinearSharedResearch/);
    assert.match(source.slice(testStopIndex, initialArtifactsIndex), /getSharedResearchContext/);
    assert.match(source.slice(testStopIndex, initialArtifactsIndex), /status: "research-completed"/);
  });
});
