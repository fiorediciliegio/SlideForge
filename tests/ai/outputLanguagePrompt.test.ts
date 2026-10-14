import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOutputLanguageRequest,
  buildOutputLanguageSystemPrompt,
} from "../../src/ai/outputLanguagePrompt";
import { parseOutputLanguageResponse } from "../../src/ai/outputLanguageParser";

test("defines explicit-language precedence and mixed-language rules", () => {
  const system = buildOutputLanguageSystemPrompt();
  assert.match(system, /explicitly says the presentation or PPT should be in a specific language/);
  assert.match(system, /primary language of the Brief's natural-language instructions/);
  assert.match(system, /isolated localized labels/);
  assert.match(system, /Always return one concrete language/);

  const request = buildOutputLanguageRequest("Create an English deck for 工作坊.");
  assert.equal(request.messages.length, 2);
  assert.match(request.messages[1].content.text, /Create an English deck for 工作坊/);
});

test("parses fenced output language JSON and rejects invalid values", () => {
  assert.deepEqual(
    parseOutputLanguageResponse("```json\n{\"output_language\":\"English\"}\n```"),
    { output_language: "English" },
  );
  assert.throws(() => parseOutputLanguageResponse('{"output_language":"auto"}'), /concrete language/);
  assert.throws(() => parseOutputLanguageResponse('{"output_language":"English","reason":"x"}'), /unexpected field reason/);
});
