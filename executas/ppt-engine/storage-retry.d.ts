export interface StorageRetryDecision {
  retryable: boolean;
  reason: string;
}

export interface StorageRetryAttempt {
  attempt: number;
  maxAttempts: number;
}

export interface StorageRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  classify?: (error: unknown, context: StorageRetryAttempt) => StorageRetryDecision;
  sleep?: (delayMs: number) => Promise<unknown>;
  onRetry?: (input: {
    attempt: number;
    nextAttempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
    error: unknown;
  }) => void | Promise<void>;
}

export class StorageHttpError extends Error {
  status?: number;
  body?: string;
  providerCode?: string;
  retryAfterMs?: number;
  constructor(input: {
    status?: number;
    message: string;
    body?: string;
    providerCode?: string;
    retryAfterMs?: number;
  });
}

export function classifyStorageError(error: unknown, context?: StorageRetryAttempt): StorageRetryDecision;
export function retryAfterMsFromError(error: unknown): number | undefined;
export function calculateStorageRetryDelay(input: {
  attempt: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  retryAfterMs?: number;
}): number;
export function runWithStorageRetry<T>(
  operation: (attempt: StorageRetryAttempt) => Promise<T>,
  options?: StorageRetryOptions,
): Promise<T>;
export function assertStorageResponseOk<T>(response: T & { ok?: boolean; status?: number; text?: () => Promise<string>; headers?: { get?: (name: string) => string | null } }, fallbackMessage: string): Promise<T>;
export const STORAGE_RETRY_DEFAULTS: Readonly<{
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}>;
