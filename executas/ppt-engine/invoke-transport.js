// Shared by the browser and Node. Only ordinary app_invoke_transport calls opt in.
export const INVOKE_INLINE_BYTES = 3 * 1024 * 1024;
export const INVOKE_MAX_BYTES = 128 * 1024 * 1024;
export const INVOKE_CHUNK_BYTES = 256 * 1024;
export const INVOKE_TRANSPORT_TOOL = "app_invoke_transport";
export const INVOKE_CHANNEL_TOOL = "app_invoke_transport_channel";

export function jsonBytes(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("Invoke payload must be JSON serializable");
  return new TextEncoder().encode(text);
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function base64ToBytes(value, maxBytes = INVOKE_INLINE_BYTES) {
  if (typeof value !== "string" || value.length > 4 * Math.ceil(maxBytes / 3)
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Invalid invoke Base64 payload");
  }
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (bytes.length > maxBytes) throw new Error("Invoke chunk exceeds its byte limit");
  return bytes;
}

export async function readBoundedBytes(stream, expectedBytes) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > INVOKE_MAX_BYTES) {
    throw new Error("Invalid invoke payload size");
  }
  const reader = stream.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expectedBytes) throw new Error("Invoke payload exceeds its declared size");
      parts.push(value);
    }
    if (size !== expectedBytes) throw new Error("Invoke payload size mismatch");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

export function validateInvokeUpload(upload, expectedBytes) {
  if (!upload || upload.transport !== "host_upload" || upload.mime_type !== "application/json"
    || typeof upload.r2_key !== "string" || !upload.r2_key
    || typeof upload.url !== "string" || new URL(upload.url).protocol !== "https:"
    || upload.size_bytes !== expectedBytes) {
    throw new Error("Invalid invoke upload reference");
  }
}

/** fits includes the actual caller's complete request/response envelope. */
export async function encodeInvokePayload(value, { fits, upload }) {
  const bytes = jsonBytes(value);
  if (bytes.length > INVOKE_MAX_BYTES) throw new Error("Invoke payload exceeds 128 MiB");
  const base = { version: 1, original_size_bytes: bytes.length };
  const plain = { ...base, encoding: "json", value };
  if (fits(plain)) return plain;
  const compressed = new Uint8Array(await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer());
  const zipped = { ...base, encoding: "gzip-base64", content: bytesToBase64(compressed) };
  if (fits(zipped)) return zipped;
  // application/json is already supported by the existing Host Upload grant.
  const reference = await upload(bytes);
  validateInvokeUpload(reference, bytes.length);
  const uploaded = { ...base, encoding: "upload", upload: reference };
  if (!fits(uploaded)) throw new Error("Invoke upload metadata exceeds 3 MiB");
  return uploaded;
}

export async function decodeInvokePayload(frame, { download }) {
  if (!frame || frame.version !== 1 || !Number.isSafeInteger(frame.original_size_bytes)
    || frame.original_size_bytes < 1 || frame.original_size_bytes > INVOKE_MAX_BYTES) {
    throw new Error("Invalid invoke transport version or size");
  }
  let bytes;
  if (frame.encoding === "json") {
    bytes = jsonBytes(frame.value);
  } else if (frame.encoding === "gzip-base64") {
    const compressed = base64ToBytes(frame.content);
    bytes = await readBoundedBytes(new Blob([compressed]).stream().pipeThrough(
      new DecompressionStream("gzip"),
    ), frame.original_size_bytes);
  } else if (frame.encoding === "upload") {
    validateInvokeUpload(frame.upload, frame.original_size_bytes);
    bytes = await download(frame.upload);
  } else {
    throw new Error("Unsupported invoke transport encoding");
  }
  if (bytes.byteLength !== frame.original_size_bytes) throw new Error("Invoke payload size mismatch");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
