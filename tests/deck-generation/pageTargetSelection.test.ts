import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getGenerationTargetPageIds } from "../../src/features/deck-generation/pageTargetSelection.ts";
import type { AuthoringDeck, RunDeckGenerationInput } from "../../src/features/deck-generation/types.ts";
import type { PageProgress } from "../../src/api/types.ts";

const authoringDeck: AuthoringDeck = {
  title: "Demo",
  pages: [
    { page_id: "page-1", index: 0, page_type: "standard", title: "One", outline: "", slide_path: "./slides/page-1.html" },
    { page_id: "page-2", index: 1, page_type: "standard", title: "Two", outline: "", slide_path: "./slides/page-2.html" },
    { page_id: "page-3", index: 2, page_type: "standard", title: "Three", outline: "", slide_path: "./slides/page-3.html" },
  ],
};

const progress: PageProgress = {
  version: 1,
  status: "running",
  pages: authoringDeck.pages.map((page, index) => ({
    page_id: page.page_id,
    index,
    title: page.title,
    status: index === 0 ? "accepted" : index === 1 ? "interrupted" : "pending",
    render_attempts: 0,
    visual_review_attempts: 0,
    content_review_attempts: 0,
    agent_failures: 0,
    agent_infrastructure_failures: 0,
    slide_path: page.slide_path,
    data_path: "",
    last_html_path: "",
    last_screenshot_path: "",
    last_error: "",
    content_review: null,
    visual_review: null,
    review: null,
    updated_at: null,
  })),
  updated_at: null,
};

function input(overrides: Partial<RunDeckGenerationInput>): RunDeckGenerationInput {
  return {
    backend: null as never,
    aiClient: null as never,
    agentClient: null as never,
    researchWebClient: null as never,
    workspace: null as never,
    confirmedOutline: null as never,
    locale: "zh",
    onProgress: () => undefined,
    isCancelled: () => false,
    ...overrides,
  };
}

describe("Generation page target selection", () => {
  it("limits Page Refinement to its explicit target page", () => {
    assert.deepEqual(
      getGenerationTargetPageIds(input({
        refinementRunKind: "page-refinement",
        pageRefinementReasons: { "page-1": "优化当前页" },
      }), authoringDeck, progress),
      ["page-1"],
    );
  });

  it("keeps ordinary resume semantics for unfinished pages", () => {
    assert.deepEqual(
      getGenerationTargetPageIds(input({ startMode: "resume" }), authoringDeck, progress),
      ["page-2", "page-3"],
    );
  });
});
