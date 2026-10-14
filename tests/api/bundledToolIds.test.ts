import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { resolvePptBundledToolIds } from "../../src/api/bundledToolIds.ts";

const originalWindow = (globalThis as typeof globalThis & { window?: Window }).window;

function setToolIds(toolIds: Record<string, string> | undefined) {
  (globalThis as typeof globalThis & { window?: Window }).window = {
    __BUNDLED_TOOL_IDS__: toolIds,
  } as Window;
}

describe("Bundled tool ids", () => {
  afterEach(() => {
    (globalThis as typeof globalThis & { window?: Window }).window = originalWindow;
  });

  it("resolves the required PPT tool ids from the SlideForge sidecar", () => {
    setToolIds({
      "ppt-engine": "tool-engine",
    });

    assert.deepEqual(resolvePptBundledToolIds(), {
      pptEngine: "tool-engine",
    });
  });

  it("fails when the SlideForge tool id sidecar is missing", () => {
    setToolIds(undefined);

    assert.throws(
      () => resolvePptBundledToolIds(),
      /Missing SlideForge bundled tool id for "ppt-engine"/,
    );
  });

  it("does not substitute a test-export handle for the required engine", () => {
    setToolIds({ "ppt-engine-test-export": "tool-test-engine" });
    assert.throws(() => resolvePptBundledToolIds(), /Missing SlideForge bundled tool id for "ppt-engine"/);
  });

});
