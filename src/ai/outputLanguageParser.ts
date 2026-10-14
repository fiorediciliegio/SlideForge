import { parseStructuredJson } from "./structuredJson";

export class OutputLanguageValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join("; "));
    this.name = "OutputLanguageValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseOutputLanguageResponse(text: string): { output_language: string } {
  let value: unknown;
  try {
    value = parseStructuredJson<unknown>(text);
  } catch (error) {
    throw new OutputLanguageValidationError([
      error instanceof Error ? error.message : String(error),
    ]);
  }

  const errors: string[] = [];
  if (!isRecord(value)) {
    throw new OutputLanguageValidationError(["The response must be a JSON object."]);
  }

  const actualKeys = Object.keys(value);
  if (!actualKeys.includes("output_language")) {
    errors.push("response is missing output_language.");
  }
  for (const key of actualKeys) {
    if (key !== "output_language") {
      errors.push(`response contains unexpected field ${key}.`);
    }
  }

  const outputLanguage = value.output_language;
  if (typeof outputLanguage !== "string" || !outputLanguage.trim() || outputLanguage !== outputLanguage.trim()) {
    errors.push("output_language must be a non-empty string without surrounding whitespace.");
  } else if (["auto", "ambiguous", "unknown"].includes(outputLanguage.toLowerCase())) {
    errors.push("output_language must be a concrete language.");
  }

  if (errors.length > 0) {
    throw new OutputLanguageValidationError(errors);
  }

  return { output_language: outputLanguage as string };
}
