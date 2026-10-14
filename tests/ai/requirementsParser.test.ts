import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePresentationRequirementsCandidates,
  PresentationRequirementsValidationError,
} from "../../src/ai/requirementsParser";

const validValue = {
  slide_count: [8],
};

function expectInvalid(value: unknown, expectedError: RegExp) {
  assert.throws(
    () => parsePresentationRequirementsCandidates(JSON.stringify(value)),
    (error) => error instanceof PresentationRequirementsValidationError &&
      expectedError.test(error.errors.join("\n")),
  );
}

test("parses plain and fenced Presentation Requirements JSON", () => {
  assert.deepEqual(
    parsePresentationRequirementsCandidates(JSON.stringify(validValue)),
    validValue,
  );
  assert.deepEqual(
    parsePresentationRequirementsCandidates(`\`\`\`json\n${JSON.stringify(validValue)}\n\`\`\``),
    validValue,
  );
});

test("rejects missing and unexpected fields", () => {
  const { slide_count: _slideCount, ...missing } = validValue;
  expectInvalid(missing, /missing slide_count/);
  expectInvalid({ ...validValue, extra: [] }, /unexpected field extra/);
});

test("requires one to four positive, unique page-count candidates", () => {
  expectInvalid({ slide_count: [] }, /1 to 4/);
  expectInvalid({ slide_count: [1, 2, 3, 4, 5] }, /1 to 4/);
  for (const value of ["8", 0, -1, 1.5, null]) {
    expectInvalid({ slide_count: [value] }, /positive integer/);
  }
  expectInvalid({ slide_count: [8, 8] }, /duplicate/);
});

test("rejects removed content goals and independently resolved language", () => {
  for (const field of ["audience", "purpose", "desired_outcome", "visual_tone", "output_language"]) {
    expectInvalid({ ...validValue, [field]: [] }, new RegExp(`unexpected field ${field}`));
  }
});
