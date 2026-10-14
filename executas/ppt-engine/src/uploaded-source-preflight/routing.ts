import { UPLOADED_SOURCE_PREFLIGHT_LIMITS } from "./config.js";

export function estimateTokens(text: string): number {
  let cjk = 0; let ascii = 0; let symbols = 0;
  for (const char of text) {
    if (/\s/u.test(char)) continue;
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk += 1;
    else if (/[A-Za-z0-9_]/.test(char)) ascii += 1;
    else symbols += 1;
  }
  return cjk + Math.ceil(ascii / 4) + Math.ceil(symbols / 2);
}
export function routeTextualSource(input: { parseStatus: "ready" | "partial" | "failed"; tokenEstimate: number; totalTextTokens: number; isSpreadsheet: boolean; nonEmptyCells: number }) {
  if (input.parseStatus === "failed") return null;
  if (input.isSpreadsheet) return input.parseStatus === "ready" && input.totalTextTokens <= UPLOADED_SOURCE_PREFLIGHT_LIMITS.fullContext.maxTokensTotal && input.nonEmptyCells <= UPLOADED_SOURCE_PREFLIGHT_LIMITS.spreadsheet.maxNonEmptyCells && input.tokenEstimate <= UPLOADED_SOURCE_PREFLIGHT_LIMITS.spreadsheet.maxSerializedTokens ? "full_context" : "summarized_context";
  return input.parseStatus === "ready" && input.tokenEstimate <= UPLOADED_SOURCE_PREFLIGHT_LIMITS.fullContext.maxTokensPerFile && input.totalTextTokens <= UPLOADED_SOURCE_PREFLIGHT_LIMITS.fullContext.maxTokensTotal ? "full_context" : "summarized_context";
}

export function canContinuePartialSource(input: {
  text: string;
  formatMetrics: Record<string, number>;
  warnings: Array<{ code: string; locations?: string[] }>;
}): boolean {
  if (!input.text.trim() || input.warnings.some((warning) => warning.code === "needs_ocr")) return false;
  const pairs: Array<[string, string]> = [
    ["parsed_pages", "total_pages"],
    ["parsed_slides", "total_slides"],
    ["parsed_sheets", "total_sheets"],
  ];
  const pair = pairs.find(([parsed, total]) => Number.isFinite(input.formatMetrics[parsed]) && Number.isFinite(input.formatMetrics[total]));
  if (!pair) return false;
  const [parsedKey, totalKey] = pair;
  // A visible but genuinely empty worksheet is reported as a warning by the
  // extractor. It should not reduce coverage for the sheets that contain
  // readable attachment context. Parse failures still stay in the denominator.
  const emptySpreadsheetSheets = parsedKey === "parsed_sheets"
    ? input.warnings.filter((warning) => warning.code === "sheet_empty_excluded").length
    : 0;
  const total = input.formatMetrics[totalKey] - emptySpreadsheetSheets;
  const parsed = input.formatMetrics[parsedKey];
  if (total <= 0 || parsed / total < 0.9) return false;
  return input.warnings.every((warning) => (warning.locations?.length ?? 0) > 0);
}

/**
 * A workbook can be partially parsed only because of non-blocking warnings
 * (for example, a genuinely empty visible Sheet). In that case all readable
 * spreadsheet text remains suitable for full-context routing. A non-empty
 * Sheet that could not be read is different: it must remain on the summary
 * path so the omission is made explicit.
 */
export function canUseFullContextForPartialSpreadsheet(input: {
  text: string;
  formatMetrics: Record<string, number>;
  warnings: Array<{ code: string; locations?: string[] }>;
}): boolean {
  if (!canContinuePartialSource(input)) return false;
  return !input.warnings.some((warning) => [
    "sheet_parse_failed",
    "sheet_no_readable_cells",
    "spreadsheet_no_readable_cells",
  ].includes(warning.code));
}

export function selectOriginalReadingMethod(input: {
  contentStrategy: "full_context" | "summarized_context" | null;
  isSpreadsheet: boolean;
}): "document_read" | "document_retrieval" | "spreadsheet_read" | null {
  if (input.contentStrategy === null) return null;
  if (input.isSpreadsheet) return "spreadsheet_read";
  if (input.contentStrategy === "full_context") return "document_read";
  return "document_retrieval";
}
