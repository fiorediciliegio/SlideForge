import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PRE_OUTLINE_WEB_RESEARCH_ENABLED } from "../../src/features/deck-workspace/researchWorkflow.ts";

describe("research workflow archive switch", () => {
  it("keeps pre-outline Web research disabled during the outline rebuild", () => {
    assert.equal(PRE_OUTLINE_WEB_RESEARCH_ENABLED, false);
  });
});
