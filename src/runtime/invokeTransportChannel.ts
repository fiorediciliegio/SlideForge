import type { HostRuntime, ToolInvokeInput } from "./hostRuntime";
import type { HostUploadRef } from "../api/types";
import {
  INVOKE_CHANNEL_TOOL, INVOKE_CHUNK_BYTES, INVOKE_INLINE_BYTES, INVOKE_MAX_BYTES,
  base64ToBytes, bytesToBase64, jsonBytes, type InvokeUpload,
} from "../../executas/ppt-engine/invoke-transport.js";

/** The only ordinary runtime invoke boundary, including bounded transfer controls. */
export async function sendInvokeFrame(runtime: HostRuntime, input: ToolInvokeInput, options?: { timeoutMs?: number }): Promise<unknown> {
  if (jsonBytes(input).length > INVOKE_INLINE_BYTES) throw new Error("Invoke message exceeds 3 MiB");
  return runtime.tools.invoke(input, options);
}

export function unwrapInvokeResult<T>(value: unknown): T {
  if (value && typeof value === "object" && "success" in value && value.success === true && "data" in value) {
    return value.data as T;
  }
  return value as T;
}

async function control<T>(runtime: HostRuntime, toolId: string, args: object): Promise<T> {
  return unwrapInvokeResult<T>(await sendInvokeFrame(runtime, {
    tool_id: toolId, method: INVOKE_CHANNEL_TOOL, args, timeoutMs: 600_000,
  }, { timeoutMs: 600_000 }));
}

/** CORS relay never calls the payload encoder/upload client, so it cannot recurse. */
export async function relayHostUpload(runtime: HostRuntime, toolId: string, file: File, input: {
  filename: string; mimeType: string; purpose: string; metadata?: Record<string, unknown>;
}): Promise<HostUploadRef> {
  if (file.size < 1 || file.size > INVOKE_MAX_BYTES) throw new Error("Invalid invoke relay file size");
  const { transfer_id } = await control<{ transfer_id: string }>(runtime, toolId, {
    action: "begin", filename: input.filename, mime_type: input.mimeType, purpose: input.purpose,
    size_bytes: file.size, workspace_dir: input.metadata?.workspace_dir,
  });
  if (typeof transfer_id !== "string" || !transfer_id) throw new Error("Invalid invoke transfer id");
  try {
    for (let offset = 0; offset < file.size; offset += INVOKE_CHUNK_BYTES) {
      const bytes = new Uint8Array(await file.slice(offset, offset + INVOKE_CHUNK_BYTES).arrayBuffer());
      const result = await control<{ next_offset: number }>(runtime, toolId, {
        action: "append", transfer_id, offset, content: bytesToBase64(bytes),
      });
      if (result.next_offset !== offset + bytes.length) throw new Error("Invoke relay offset mismatch");
    }
    return await control<HostUploadRef>(runtime, toolId, { action: "finish", transfer_id });
  } finally {
    await control(runtime, toolId, { action: "release", transfer_id }).catch(() => undefined);
  }
}

/** Download controls return bounded bytes, never another upload reference. */
export async function readInvokeUploadThroughEngine(runtime: HostRuntime, toolId: string, upload: InvokeUpload): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(upload.size_bytes) || upload.size_bytes < 1 || upload.size_bytes > INVOKE_MAX_BYTES) {
    throw new Error("Invalid invoke download size");
  }
  const { transfer_id } = await control<{ transfer_id: string }>(runtime, toolId, { action: "download", upload });
  if (typeof transfer_id !== "string" || !transfer_id) throw new Error("Invalid invoke download id");
  try {
    const result = new Uint8Array(upload.size_bytes);
    let offset = 0;
    while (offset < result.length) {
      const chunk = await control<{ offset: number; next_offset: number; content: string }>(runtime, toolId, {
        action: "read", transfer_id, offset,
      });
      const bytes = base64ToBytes(chunk.content, INVOKE_CHUNK_BYTES);
      if (chunk.offset !== offset || bytes.length === 0 || chunk.next_offset !== offset + bytes.length
        || chunk.next_offset > result.length) throw new Error("Invalid invoke download chunk");
      result.set(bytes, offset);
      offset = chunk.next_offset;
    }
    return result;
  } finally {
    await control(runtime, toolId, { action: "release", transfer_id }).catch(() => undefined);
  }
}
