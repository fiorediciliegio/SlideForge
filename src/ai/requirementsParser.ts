import type {
  PresentationRequirementsGeneratedCandidates,
} from "../api/types";
import { parseStructuredJson } from "./structuredJson";

export class PresentationRequirementsValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join("; "));
    this.name = "PresentationRequirementsValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  errors: string[],
) {
  const actual = Object.keys(value);
  for (const key of expected) {
    if (!actual.includes(key)) errors.push(`${path} is missing ${key}.`);
  }
  for (const key of actual) {
    if (!expected.includes(key)) errors.push(`${path} contains unexpected field ${key}.`);
  }
}

function validateCandidateArray(value: unknown, path: string, errors: string[]): unknown[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array.`);
    return [];
  }
  if (value.length < 1 || value.length > 4) {
    errors.push(`${path} must contain 1 to 4 candidates.`);
  }
  return value;
}

export function parsePresentationRequirementsCandidates(
  text: string,
): PresentationRequirementsGeneratedCandidates {
  let value: unknown;
  try {
    value = parseStructuredJson<unknown>(text);
  } catch (error) {
    throw new PresentationRequirementsValidationError([
      error instanceof Error ? error.message : String(error),
    ]);
  }

  const errors: string[] = [];
  if (!isRecord(value)) {
    throw new PresentationRequirementsValidationError(["The response must be a JSON object."]);
  }
  validateExactKeys(value, ["slide_count"], "response", errors);

  const slideCountValues = validateCandidateArray(value.slide_count, "slide_count", errors);
  const slideCountSeen = new Set<number>();
  const slide_count: number[] = [];
  slideCountValues.forEach((candidate, index) => {
    if (!Number.isInteger(candidate) || (candidate as number) <= 0) {
      errors.push(`slide_count[${index}] must be a positive integer.`);
      return;
    }
    const count = candidate as number;
    if (slideCountSeen.has(count)) {
      errors.push("slide_count contains a duplicate candidate.");
      return;
    }
    slideCountSeen.add(count);
    slide_count.push(count);
  });

  if (errors.length > 0) throw new PresentationRequirementsValidationError(errors);

  return {
    slide_count,
  };
}
