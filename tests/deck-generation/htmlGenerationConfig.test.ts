import assert from "node:assert/strict";
import test from "node:test";
import { isPageHtmlGenerationSystemPromptEnabled } from "../../src/features/deck-generation/htmlGenerationConfig.ts";

test("single-page HTML system prompt flag only enables for exact true", () => {
  assert.equal(isPageHtmlGenerationSystemPromptEnabled("true"), true);
  assert.equal(isPageHtmlGenerationSystemPromptEnabled("false"), false);
  assert.equal(isPageHtmlGenerationSystemPromptEnabled(undefined), false);
  assert.equal(isPageHtmlGenerationSystemPromptEnabled("TRUE"), false);
  assert.equal(isPageHtmlGenerationSystemPromptEnabled(true), false);
});
