export const UPLOADED_SOURCE_PREFLIGHT_LIMITS = {
  fullContext: { maxTokensPerFile: 8_000, maxTokensTotal: 15_000 },
  spreadsheet: { maxNonEmptyCells: 2_000, maxSerializedTokens: 10_000 },
} as const;

export const PDF_NEAR_ZERO_TEXT_CHARACTERS = 10;

export const PDF_OCR_LIMITS = {
  // OCR is a persisted background job: do not impose document-wide page or
  // duration limits that discard visual content from large PDFs.
  pageTimeoutMs: 20_000,
  // Layout analysis is an optimization. Keep enough room for the following
  // two-page recognition batch inside Executa's 65-second invoke deadline;
  // timeout falls back to recognition and therefore does not drop content.
  detectionBatchTimeoutMs: 8_000,
  batchStartupGraceMs: 5_000,
  renderDpi: 200,
  maxRenderedPixels: 12_000_000,
} as const;
