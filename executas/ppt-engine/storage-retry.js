const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5_000;
const DEFAULT_JITTER_RATIO = 0.2;

const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429]);
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const RETRYABLE_PROVIDER_CODES = new Set([
  "INTERNALERROR",
  "SLOWDOWN",
  "SERVICEUNAVAILABLE",
  "REQUESTTIMEOUT",
  "THROTTLING",
  "THROTTLINGEXCEPTION",
  "TRANSIENTERROR",
]);
const DETERMINISTIC_ERROR = /permission|forbidden|unauthori[sz]ed|quota|file too large|payload too large|invalid (?:argument|parameter)|unsupported|not granted|not negotiated|cancel(?:led|lation)|source changed|does not belong/i;

export class StorageHttpError extends Error {
  constructor({ status, message, body, providerCode, retryAfterMs }) {
    super(message);
    this.name = "StorageHttpError";
    this.status = Number.isInteger(status) ? status : undefined;
    this.body = body;
    this.providerCode = providerCode;
    this.retryAfterMs = retryAfterMs;
  }
}

function normalizedCode(value) {
  return typeof value === "string" ? value.replace(/[^a-z0-9]/gi, "").toUpperCase() : "";
}

function providerCodeFromValue(value) {
  if (typeof value === "string") {
    const xml = value.match(/<Code>\s*([^<\s]+)\s*<\/Code>/i);
    if (xml?.[1]) return xml[1];
    const json = value.match(/(?:"|')?(?:code|Code|error_code|errorCode)(?:"|')?\s*:\s*(?:"|')([^"']+)(?:"|')/i);
    if (json?.[1]) return json[1];
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["providerCode", "provider_code", "code", "Code", "error_code", "errorCode"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function providerCodeFromError(error) {
  return providerCodeFromValue(error?.providerCode)
    ?? providerCodeFromValue(error?.data)
    ?? providerCodeFromValue(error?.body)
    ?? providerCodeFromValue(error?.message);
}

function statusFromError(error) {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  return Number.isInteger(status) ? status : undefined;
}

function retryAfterMsFromValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value * 1_000));
  }
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    return Math.max(0, Math.floor(Number(value) * 1_000));
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function retryAfterMsFromError(error) {
  return Number.isFinite(error?.retryAfterMs)
    ? Math.max(0, Math.floor(error.retryAfterMs))
    : retryAfterMsFromValue(error?.headers?.["retry-after"] ?? error?.headers?.get?.("retry-after"));
}

export function classifyStorageError(error) {
  if (error?.name === "AbortError" || DETERMINISTIC_ERROR.test(String(error?.message ?? error))) {
    return { retryable: false, reason: "deterministic_error" };
  }

  const status = statusFromError(error);
  if (status !== undefined && (RETRYABLE_HTTP_STATUS.has(status) || status >= 500)) {
    return { retryable: true, reason: `http_${status}` };
  }

  const providerCode = providerCodeFromError(error);
  if (providerCode && RETRYABLE_PROVIDER_CODES.has(normalizedCode(providerCode))) {
    return { retryable: true, reason: `provider_${providerCode}` };
  }

  const code = typeof error?.code === "string" ? error.code.toUpperCase() : "";
  if (RETRYABLE_ERROR_CODES.has(code) || code === "UPLOAD_ERR_TIMEOUT" || code === "APS_FILES_ERROR_TIMEOUT") {
    return { retryable: true, reason: `error_${code.toLowerCase()}` };
  }
  if (error?.code === -32208 || error?.code === -32030) {
    return { retryable: true, reason: `error_${error.code}` };
  }

  // Fetch reports network failures as TypeError in both browsers and Node.
  if (error instanceof TypeError || error?.name === "FetchError") {
    return { retryable: true, reason: "network_error" };
  }

  return { retryable: false, reason: "non_retryable_error" };
}

/**
 * Classifier that also understands bridge-wrapped host upload RPC errors.
 *
 * `host/uploadFile` negotiate/confirm run as JSON-RPC through the bridge. When
 * the bridge's own upstream request fails (VPN blip etc.), the caller receives
 * a wrapped error named "HostUploadError" (e.g. code -32603, message
 * "fetch failed") — neither a TypeError nor a retryable code — so the stock
 * classifier marks it non-retryable and the bounded retry never runs (the
 * "instant failure" symptom). Any error reaching this fallback has already
 * failed the deterministic rules inside classifyStorageError
 * (permission/quota/invalid-params/...), so treating the remainder as a
 * transient RPC/transport failure is safe.
 */
export function classifyHostUploadAware(error, context) {
  const decision = classifyStorageError(error, context);
  if (decision.reason !== "non_retryable_error") return decision;
  if (error?.name === "HostUploadError") {
    return { retryable: true, reason: "host_upload_rpc_transient" };
  }
  return decision;
}

export function calculateStorageRetryDelay({ attempt, baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS, jitterRatio = DEFAULT_JITTER_RATIO, retryAfterMs }) {
  if (Number.isFinite(retryAfterMs)) return Math.max(0, Math.floor(retryAfterMs));
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const jitter = exponential * Math.max(0, Math.min(1, jitterRatio));
  return Math.max(0, Math.floor(exponential - jitter + Math.random() * jitter * 2));
}

export async function runWithStorageRetry(operation, options = {}) {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const classify = options.classify ?? classifyStorageError;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation({ attempt, maxAttempts });
    } catch (error) {
      lastError = error;
      const decision = classify(error, { attempt, maxAttempts });
      if (!decision?.retryable || attempt >= maxAttempts) throw error;
      const delayMs = calculateStorageRetryDelay({
        attempt,
        baseDelayMs: options.baseDelayMs,
        maxDelayMs: options.maxDelayMs,
        jitterRatio: options.jitterRatio,
        retryAfterMs: retryAfterMsFromError(error),
      });
      await options.onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        reason: decision.reason,
        error,
      });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export async function assertStorageResponseOk(response, fallbackMessage) {
  if (response?.ok) return response;
  const body = typeof response?.text === "function"
    ? await response.text().catch(() => "")
    : "";
  const status = Number.isInteger(response?.status) ? response.status : undefined;
  const providerCode = providerCodeFromValue(body);
  const message = body.trim() || `${fallbackMessage}: HTTP ${status ?? "unknown"}`;
  throw new StorageHttpError({
    status,
    message,
    body,
    providerCode,
    retryAfterMs: retryAfterMsFromValue(response?.headers?.get?.("retry-after")),
  });
}

export const STORAGE_RETRY_DEFAULTS = Object.freeze({
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  baseDelayMs: DEFAULT_BASE_DELAY_MS,
  maxDelayMs: DEFAULT_MAX_DELAY_MS,
  jitterRatio: DEFAULT_JITTER_RATIO,
});
