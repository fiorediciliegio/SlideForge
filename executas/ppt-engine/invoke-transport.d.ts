export const INVOKE_INLINE_BYTES: number;
export const INVOKE_MAX_BYTES: number;
export const INVOKE_CHUNK_BYTES: number;
export const INVOKE_TRANSPORT_TOOL: "app_invoke_transport";
export const INVOKE_CHANNEL_TOOL: "app_invoke_transport_channel";
export interface InvokeUpload {
  transport: "host_upload";
  r2_key: string;
  url: string;
  mime_type: string;
  size_bytes: number;
}
export type InvokePayload = { version: 1; original_size_bytes: number } & (
  | { encoding: "json"; value: unknown }
  | { encoding: "gzip-base64"; content: string }
  | { encoding: "upload"; upload: InvokeUpload }
);
export function jsonBytes(value: unknown): Uint8Array<ArrayBuffer>;
export function bytesToBase64(bytes: Uint8Array): string;
export function base64ToBytes(value: string, maxBytes?: number): Uint8Array<ArrayBuffer>;
export function readBoundedBytes(stream: ReadableStream<Uint8Array>, expectedBytes: number): Promise<Uint8Array<ArrayBuffer>>;
export function validateInvokeUpload(upload: unknown, expectedBytes: number): asserts upload is InvokeUpload;
export function encodeInvokePayload(value: unknown, options: {
  fits(frame: InvokePayload): boolean;
  upload(bytes: Uint8Array<ArrayBuffer>): Promise<InvokeUpload>;
}): Promise<InvokePayload>;
export function decodeInvokePayload(frame: InvokePayload, options: {
  download(upload: InvokeUpload): Promise<Uint8Array<ArrayBuffer>>;
}): Promise<unknown>;
