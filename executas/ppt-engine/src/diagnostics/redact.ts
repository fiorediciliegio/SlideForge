/** Shared by the browser recorder and engine; usage counters and correlation IDs survive. */
export function redactDiagnosticValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (typeof value === "string") return value
    .replace(/https?:\/\/[^\s<>"']+/gi, (url) => /[?&](?:[^=&]*(?:token|signature|credential|x-amz|x-goog)|key)=/i.test(url) ? "[REDACTED_URL]" : url)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
  if (!value || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[CIRCULAR]";
  const next = new Set(ancestors).add(value);
  if (value instanceof Error) return redactDiagnosticValue({ ...value, name: value.name, message: value.message, stack: value.stack, cause: value.cause }, next);
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item, next));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    /^(?:authorization|cookie|set-cookie|token|(?:access|refresh|session|auth)[_-]?token|api[_-]?key|secret|password|signature|url|(?:signed|put|download|get)[_-]?url|.*[_-](?:url|token|secret|signature))$/i.test(key)
      ? "[REDACTED]" : redactDiagnosticValue(child, next),
  ]));
}
