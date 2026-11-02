import { z } from "zod";

export const apiErrorSchema = z.object({
  error: z.string(),
  error_code: z.string(),
  retryable: z.boolean(),
  details: z.unknown().optional(),
});

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

const ERROR_CODE_BY_STATUS: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  402: "payment_required",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  429: "rate_limited",
  500: "internal_error",
  503: "service_unavailable",
};

export function apiError(status: number, message: string, details?: unknown): ApiErrorBody {
  return {
    error: message,
    error_code: ERROR_CODE_BY_STATUS[status] ?? "unknown_error",
    retryable: status === 429 || status >= 500,
    ...(details === undefined ? {} : { details }),
  };
}
