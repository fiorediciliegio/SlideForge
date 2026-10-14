export const STAGE1_RESULT_SCHEMA_VERSION = 1;

export const PROMPT_VERSION_PATTERN = /^v(?:[1-9]|1[01])[a-z]?$/u;
export const ROUTING_FAILURE_KINDS = new Set(["json_format", "invocation", "cancelled", "unknown"]);
export const ROUTING_RETRY_REASONS = new Set(["invocation", "json_format", "schema"]);

export function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

export function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

export function normalizeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value;
  const number = (...keys) => {
    const key = keys.find((candidate) => Number.isFinite(source[candidate]));
    return key ? Number(source[key]) : null;
  };
  // Batch Testing writes the model bridge's native camelCase usage fields.
  // Accept those alongside the Eval contract's snake_case fields so an exported
  // batch can always be scored without discarding its persisted token data.
  const inputTokens = number("input_tokens", "inputTokens");
  const outputTokens = number("output_tokens", "outputTokens");
  const totalTokens = number("total_tokens", "totalTokens");
  return inputTokens === null && outputTokens === null && totalTokens === null
    ? null
    : { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens };
}

/**
 * Normalized interchange written by Batch Testing and consumed by this Eval.
 * A failed invocation keeps `actual` null and includes `error`.
 */
export function normalizeStage1Result(value) {
  const record = assertRecord(value, "result");
  const status = record.status === "completed" ? "completed" : record.status === "failed" ? "failed" : null;
  if (!status) throw new Error("result.status must be completed or failed.");
  if (typeof record.case_id !== "string" || !record.case_id.trim()) throw new Error("result.case_id is required.");
  if (typeof record.prompt_version !== "string" || !PROMPT_VERSION_PATTERN.test(record.prompt_version)) {
    throw new Error("result.prompt_version must be v1 through v11, optionally followed by one letter.");
  }
  if (typeof record.prompt_hash !== "string" || !/^[a-f0-9]{64}$/u.test(record.prompt_hash)) {
    throw new Error("result.prompt_hash must be a SHA-256 hex digest.");
  }
  const expected = assertRecord(record.expected, "result.expected");
  const normalized = {
    case_id: record.case_id,
    prompt_version: record.prompt_version,
    prompt_hash: record.prompt_hash,
    status,
    expected: {
      web: assertBoolean(expected.web, "result.expected.web"),
      images: assertBoolean(expected.images, "result.expected.images"),
    },
    requested_model: typeof record.requested_model === "string" ? record.requested_model : null,
    actual_model: typeof record.actual_model === "string" ? record.actual_model : null,
    latency_ms: Number.isFinite(record.latency_ms) ? Number(record.latency_ms) : null,
    token_usage: normalizeUsage(record.token_usage),
    json_repair_count: Number.isInteger(record.json_repair_count) && record.json_repair_count >= 0
      ? record.json_repair_count
      : 0,
    retry_count: Number.isInteger(record.retry_count) && record.retry_count >= 0
      ? record.retry_count
      : 0,
    retry_reasons: Array.isArray(record.retry_reasons)
      ? record.retry_reasons.filter((reason) => typeof reason === "string" && ROUTING_RETRY_REASONS.has(reason))
      : [],
    failure_kind: status === "failed" && typeof record.failure_kind === "string" && ROUTING_FAILURE_KINDS.has(record.failure_kind)
      ? record.failure_kind
      : status === "failed"
        ? "unknown"
        : null,
    error: typeof record.error === "string" && record.error.trim() ? record.error.trim() : null,
  };
  if (status === "completed") {
    const actual = assertRecord(record.actual, "result.actual");
    normalized.actual = {
      web: assertBoolean(actual.web, "result.actual.web"),
      images: assertBoolean(actual.images, "result.actual.images"),
    };
  } else {
    normalized.actual = null;
  }
  return normalized;
}

export function normalizeStage1ResultsDocument(value) {
  const document = assertRecord(value, "results document");
  if (document.schema_version !== STAGE1_RESULT_SCHEMA_VERSION) {
    throw new Error(`Unsupported result schema version: ${String(document.schema_version)}.`);
  }
  if (!Array.isArray(document.results)) throw new Error("results document.results must be an array.");
  return {
    schema_version: STAGE1_RESULT_SCHEMA_VERSION,
    run_id: typeof document.run_id === "string" ? document.run_id : null,
    generated_at: typeof document.generated_at === "string" ? document.generated_at : null,
    git_commit: typeof document.git_commit === "string" ? document.git_commit : null,
    results: document.results.map(normalizeStage1Result),
  };
}
