function isOpeningBracket(char: string) {
  return char === "{" || char === "[";
}

function matchingClosingBracket(char: string) {
  return char === "{" ? "}" : "]";
}

/** Yield every balanced-bracket candidate in order, so the caller can try
 *  each with repairs. The FIRST candidate in a document that also contains
 *  CSS is often a style block's `{...}` — not JSON — and older code stopped
 *  there; iterating rescues outputs where the real JSON object comes later. */
function* extractBalancedJsonCandidates(text: string): Generator<string> {
  for (let start = 0; start < text.length; start += 1) {
    const firstChar = text[start];
    if (!isOpeningBracket(firstChar)) continue;

    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          continue;
        }

        if (char === "\"") {
          inString = false;
        }

        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (isOpeningBracket(char)) {
        stack.push(char);
        continue;
      }

      if (char === "}" || char === "]") {
        const open = stack.pop();
        if (!open || matchingClosingBracket(open) !== char) {
          break;
        }

        if (stack.length === 0) {
          yield text.slice(start, index + 1);
          break;
        }
      }
    }
  }
}

/** Repair the classic "model embedded HTML in a JSON string" breakage: raw
 *  control characters (newlines/tabs) inside string literals are illegal in
 *  JSON but models emit them constantly when a multi-line HTML document is a
 *  string value. String-aware scan (same state machine as the balanced
 *  extractor): only characters INSIDE strings are escaped. Idempotent for
 *  already-valid text. */
export function escapeControlCharsInJsonStrings(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        result += char;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        result += char;
        continue;
      }
      if (char === "\"") {
        inString = false;
        result += char;
        continue;
      }
      if (char === "\n") { result += "\\n"; continue; }
      if (char === "\r") { result += "\\r"; continue; }
      if (char === "\t") { result += "\\t"; continue; }
      result += char;
      continue;
    }
    if (char === "\"") inString = true;
    result += char;
  }
  return result;
}

function tryParseWithControlCharRepair(candidate: string): string | null {
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    // Fall through to repair.
  }
  const repaired = escapeControlCharsInJsonStrings(candidate);
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}

export function extractStructuredJsonText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Response did not contain JSON text.");
  }

  const direct = tryParseWithControlCharRepair(trimmed);
  if (direct !== null) return direct;

  const fencedBlocks = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);

  for (const block of fencedBlocks) {
    const parsed = tryParseWithControlCharRepair(block);
    if (parsed !== null) return parsed;
  }

  for (const balanced of extractBalancedJsonCandidates(trimmed)) {
    const parsed = tryParseWithControlCharRepair(balanced);
    if (parsed !== null) return parsed;
  }

  throw new Error("Response did not contain a parseable JSON value.");
}

export function parseStructuredJson<T>(text: string): T {
  return JSON.parse(extractStructuredJsonText(text)) as T;
}

export function buildStructuredJsonRepairPrompt(
  sourceText: string,
  expectedShape: string,
  parseError: string
) {
  void sourceText;

  return [
    "The previous response was not valid JSON.",
    `Parse error: ${parseError}`,
    "Return exactly one JSON value only.",
    "Do not include markdown, code fences, explanations, or any extra text.",
    "Use this shape exactly:",
    expectedShape,
  ].join("\n");
}
