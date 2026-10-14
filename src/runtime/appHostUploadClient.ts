import type { HostUploadRef } from "../api/types";
import { resolvePptBundledToolIds } from "../api/bundledToolIds";
import type { AnnaRuntime } from "./annaRuntime";
import { relayHostUpload } from "./invokeTransportChannel";
import { beginPerformanceSpan } from "../performance/performanceRecorder";
import {
  assertStorageResponseOk,
  classifyStorageError,
  runWithStorageRetry,
} from "../../executas/ppt-engine/storage-retry.js";

export interface StorageTransferLogEvent {
  workspace_dir: string;
  user_template_id?: string;
  entry: Record<string, unknown>;
}

export type HostUploadPurpose = "user_artifact" | "image_reference" | "image_input";

export interface AppHostUploadClient {
  uploadFile(
    file: File,
    input: {
      purpose: HostUploadPurpose;
      filename?: string;
      mimeType?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<HostUploadRef>;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".pdf": "application/pdf",
};

function inferMimeType(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  const extension = dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
  return MIME_BY_EXTENSION[extension] ?? "";
}

function readUploadMimeType(file: File, filename: string, explicitMimeType?: string): string {
  const mimeType = (explicitMimeType || file.type || inferMimeType(filename)).trim();
  if (!mimeType) {
    throw new Error(`Cannot determine MIME type for ${filename}.`);
  }
  return mimeType;
}

function assertUploadRuntime(runtime: AnnaRuntime): NonNullable<AnnaRuntime["upload"]> {
  if (
    !runtime.upload ||
    typeof runtime.upload.negotiate !== "function" ||
    typeof runtime.upload.confirm !== "function"
  ) {
    throw new Error("Anna runtime upload.negotiate/upload.confirm is not available.");
  }
  return runtime.upload;
}

function randomTransferId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `transfer-${uuid ?? Math.random().toString(36).slice(2, 12)}`;
}

function redactStorageResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStorageResponse);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (/(authorization|token|signature|signed[_-]?url|put[_-]?url|download[_-]?url)/i.test(key) || key.toLowerCase() === "url") {
      return [key, "[REDACTED]"];
    }
    return [key, redactStorageResponse(child)];
  }));
}

function errorRecord(error: unknown): Record<string, unknown> {
  const redactMessage = (message: string) => message.replace(/https?:\/\/\S+/gi, "[REDACTED_URL]");
  const record = error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactMessage(error.message),
      ...(record.code !== undefined ? { code: record.code } : {}),
      ...(record.status !== undefined ? { http_status: record.status } : {}),
      ...(record.providerCode !== undefined ? { provider_code: record.providerCode } : {}),
      ...(record.data !== undefined ? { data: redactStorageResponse(record.data) } : {}),
    };
  }
  return {
    message: redactMessage(String(error)),
    ...(record.code !== undefined ? { code: record.code } : {}),
    ...(record.status !== undefined ? { http_status: record.status } : {}),
    ...(record.providerCode !== undefined ? { provider_code: record.providerCode } : {}),
    ...(record.data !== undefined ? { data: redactStorageResponse(record.data) } : {}),
  };
}

export function createAppHostUploadClient(
  runtime: AnnaRuntime,
  options: { appendWorkspaceLog?: (event: StorageTransferLogEvent) => Promise<unknown> } = {},
): AppHostUploadClient {
  return {
    async uploadFile(file, input) {
      const upload = assertUploadRuntime(runtime);
      const workspaceDir = typeof input.metadata?.workspace_dir === "string"
        ? input.metadata.workspace_dir
        : "";
      const templateId = typeof input.metadata?.user_template_id === "string" ? input.metadata.user_template_id : undefined;
      const source = typeof input.metadata?.source === "string"
        ? input.metadata.source
        : "app_host_upload";
      const operationId = typeof input.metadata?.operation_id === "string"
        ? input.metadata.operation_id
        : undefined;
      const interactionId = typeof input.metadata?.interaction_id === "string"
        ? input.metadata.interaction_id
        : undefined;
      const parentInteractionId = typeof input.metadata?.parent_interaction_id === "string"
        ? input.metadata.parent_interaction_id
        : undefined;
      const performanceSpan = beginPerformanceSpan({
        operationName: "host_upload",
        workspaceId: workspaceDir.split(/[\\/]/).filter(Boolean).at(-1),
        attributes: { layer: "anna-host-upload", size_bytes: file.size },
      });
      const filename = (input.filename || file.name || "upload").trim();
      if (!filename) {
        throw new Error("Upload filename must not be empty.");
      }
      const mimeType = readUploadMimeType(file, filename, input.mimeType);
      try {
        let currentAttemptLog: ((phase: string, status: string, extra?: Record<string, unknown>) => void) | undefined;
        const result = await runWithStorageRetry(async ({ attempt, maxAttempts }) => {
          const transferId = randomTransferId();
          let currentPhase = "started";
          const attemptLog = (phase: string, status: string, extra: Record<string, unknown> = {}) => {
            if ((!workspaceDir && !templateId) || !options.appendWorkspaceLog) return;
            void options.appendWorkspaceLog({
              workspace_dir: workspaceDir,
              user_template_id: templateId,
              entry: {
                event: status === "failed" ? "storage.transfer.failed" : `storage.transfer.${phase}`,
                schema_version: 1,
                transfer_id: transferId,
                creation_run_id: input.metadata?.creation_run_id,
                operation_id: operationId,
                interaction_id: interactionId,
                parent_interaction_id: parentInteractionId,
                source,
                transport: "host_upload",
                phase,
                status,
                attempt,
                max_attempts: maxAttempts,
                filename,
                mime_type: mimeType,
                size_bytes: file.size,
                ...extra,
              },
            }).catch(() => undefined);
          };
          currentAttemptLog = attemptLog;
          attemptLog("started", "started", { purpose: input.purpose });
          try {
            currentPhase = "negotiate";
            const negotiated = await upload.negotiate({
              filename,
              mime_type: mimeType,
              size_bytes: file.size,
              purpose: input.purpose,
              metadata: input.metadata,
            });
            if (!negotiated || typeof negotiated.put_url !== "string" || typeof negotiated.r2_key !== "string") {
              throw new Error("Host upload negotiate returned an invalid response.");
            }
            attemptLog("negotiate", "succeeded", { r2_key: negotiated.r2_key, response: redactStorageResponse(negotiated) });
            currentPhase = "put";
            const putResponse = await fetch(negotiated.put_url, {
              method: "PUT",
              headers: negotiated.headers ?? {},
              body: file,
            });
            await assertStorageResponseOk(putResponse, "Host upload PUT failed");
            attemptLog("put", "succeeded", { http_status: putResponse.status });
            currentPhase = "confirm";
            const confirmed = await upload.confirm({ r2_key: negotiated.r2_key });
            attemptLog("confirm", "succeeded", { r2_key: negotiated.r2_key, response: redactStorageResponse(confirmed) });
            if (typeof confirmed.download_url !== "string" || confirmed.download_url.length === 0) {
              throw new Error("Host upload confirm did not return download_url.");
            }
            const attemptResult = {
              transport: "host_upload" as const,
              r2_key: confirmed.r2_key || negotiated.r2_key,
              url: confirmed.download_url,
              mime_type: mimeType,
              size_bytes: typeof confirmed.size_bytes === "number" ? confirmed.size_bytes : file.size,
              filename,
              expires_at: confirmed.expires_at ?? negotiated.expires_at,
              expires_in: confirmed.expires_in,
              mode: "negotiate+confirm" as const,
            };
            attemptLog("finished", "succeeded", { r2_key: attemptResult.r2_key, expires_at: attemptResult.expires_at });
            return attemptResult;
          } catch (error) {
            const decision = classifyStorageError(error);
            attemptLog(currentPhase, "failed", {
              error: errorRecord(error),
              retryable: decision.retryable && attempt < maxAttempts,
              retry_reason: decision.reason,
              retry_exhausted: decision.retryable && attempt >= maxAttempts,
            });
            throw error;
          }
        }, {
          onRetry: ({ attempt, nextAttempt, maxAttempts, delayMs, reason }) => {
            currentAttemptLog?.("retry", "scheduled", {
              attempt,
              next_attempt: nextAttempt,
              max_attempts: maxAttempts,
              delay_ms: delayMs,
              retry_reason: reason,
            });
          },
        });
        performanceSpan?.finish("ok");
        return result;
      } catch (error) {
        performanceSpan?.finish("error");
        if (!(error instanceof TypeError)) throw error;
        try {
          const relayed = await relayHostUpload(runtime, resolvePptBundledToolIds().pptEngine, file, {
            filename,
            mimeType,
            purpose: input.purpose,
            metadata: input.metadata,
          });
          if (relayed) return relayed;
        } catch (relayError) {
          throw new Error(
            `Host upload failed: ${error instanceof Error ? error.message : String(error)}. ` +
            `ppt-engine relay failed: ${relayError instanceof Error ? relayError.message : String(relayError)}.`,
          );
        }
        throw error;
      }
    },
  };
}

export function hostUploadUrl(ref: HostUploadRef | null | undefined): string {
  return ref?.url ?? "";
}
