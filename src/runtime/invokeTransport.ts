import type { HostRuntime } from "./hostRuntime";
import { createAppHostUploadClient } from "./appHostUploadClient";
import { readInvokeUploadThroughEngine, sendInvokeFrame, unwrapInvokeResult } from "./invokeTransportChannel";
import { assertStorageResponseOk, runWithStorageRetry } from "../../executas/ppt-engine/storage-retry.js";
import {
  INVOKE_INLINE_BYTES, INVOKE_TRANSPORT_TOOL, decodeInvokePayload, encodeInvokePayload,
  jsonBytes, readBoundedBytes, type InvokePayload,
} from "../../executas/ppt-engine/invoke-transport.js";

/** Ordinary calls only. Async jobs deliberately continue to use their original protocol. */
export function createInvokeTransport(runtime: HostRuntime) {
  const uploads = createAppHostUploadClient(runtime);
  return async function invoke<T>(toolId: string, method: string, args: object, options?: { timeoutMs?: number }): Promise<T> {
    const message = (payload: InvokePayload) => ({
      tool_id: toolId, method: INVOKE_TRANSPORT_TOOL, args: { tool: method, payload },
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    const payload = await encodeInvokePayload(args, {
      fits: (frame) => jsonBytes(message(frame)).length <= INVOKE_INLINE_BYTES,
      upload: (bytes) => uploads.uploadFile(new File([bytes], "invoke-request.json", { type: "application/json" }), {
        purpose: "user_artifact",
        metadata: { source: "ppt-app.invoke-request", method, workspace_dir: (args as { workspace_dir?: string }).workspace_dir },
      }),
    });
    const frame = unwrapInvokeResult<InvokePayload>(await sendInvokeFrame(runtime, message(payload), options));
    const outcome = await decodeInvokePayload(frame, {
      download: async (upload) => {
        try {
          return await runWithStorageRetry(async () => {
            const response = await fetch(upload.url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(120_000) });
            await assertStorageResponseOk(response, "Invoke download failed");
            if (!response.body) throw new Error("Invoke download has no body");
            return readBoundedBytes(response.body, upload.size_bytes);
          });
        } catch (error) {
          // Browsers cannot distinguish CORS from other fetch network failures.
          if (!(error instanceof TypeError)) throw error;
          return readInvokeUploadThroughEngine(runtime, toolId, upload);
        }
      },
    }) as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    if (!outcome || typeof outcome !== "object") throw new Error("Invalid invoke result");
    if (outcome.error) {
      throw Object.assign(new Error(outcome.error.message || "Invoke failed"), {
        code: outcome.error.code, data: outcome.error.data,
      });
    }
    if (!("result" in outcome)) throw new Error("Invoke result is missing");
    return unwrapInvokeResult<T>(outcome.result);
  };
}
