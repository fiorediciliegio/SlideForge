import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  INVOKE_CHUNK_BYTES, INVOKE_MAX_BYTES, base64ToBytes, bytesToBase64,
  readBoundedBytes, validateInvokeUpload,
} from "./invoke-transport.js";
import { assertStorageResponseOk, runWithStorageRetry } from "./storage-retry.js";

export async function downloadInvokeUpload(upload) {
  validateInvokeUpload(upload, upload.size_bytes);
  return runWithStorageRetry(async () => {
    const response = await fetch(upload.url, { signal: AbortSignal.timeout(120_000) });
    await assertStorageResponseOk(response, "Invoke download failed");
    if (!response.body) throw new Error("Invoke download has no body");
    return readBoundedBytes(response.body, upload.size_bytes);
  });
}

/** Ephemeral CORS relay. Random handles never expose or accept local paths. */
export function createInvokeTransportChannel({ directory, uploadFile, download = downloadInvokeUpload, now = Date.now }) {
  const transfers = new Map();
  const ttl = 10 * 60_000;
  let allocated = 0;
  async function release(id) {
    const item = transfers.get(id);
    if (!item) return;
    transfers.delete(id);
    allocated -= item.size;
    await rm(item.file, { force: true });
  }
  async function sweep() {
    for (const [id, item] of transfers) if (!item.busy && item.expires <= now()) await release(id);
  }
  const timer = setInterval(() => { void sweep().catch(() => undefined); }, 60_000);
  timer.unref();
  async function allocate(size, kind, metadata) {
    if (!Number.isSafeInteger(size) || size < 1 || size > INVOKE_MAX_BYTES) throw new Error("Invalid invoke transfer size");
    if (transfers.size >= 16 || allocated + size > 2 * INVOKE_MAX_BYTES) throw new Error("Invoke transfer capacity exceeded");
    const id = randomUUID();
    const item = { file: path.join(directory, `${id}.tmp`), size, kind, metadata, offset: 0, expires: now() + ttl, busy: true };
    transfers.set(id, item);
    allocated += size;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(item.file, new Uint8Array(), { flag: "wx" });
      return { id, item };
    } catch (error) { await release(id); throw error; }
  }
  async function handle(args) {
    await sweep();
    if (args.action === "begin") {
      if (typeof args.filename !== "string" || !args.filename || /[\\/\x00-\x1f]/.test(args.filename)
        || typeof args.mime_type !== "string" || !args.mime_type
        || !["user_artifact", "image_reference", "image_input"].includes(args.purpose)) throw new Error("Invalid invoke upload metadata");
      const { id, item } = await allocate(args.size_bytes, "upload", args);
      item.busy = false;
      return { transfer_id: id };
    }
    if (args.action === "download") {
      validateInvokeUpload(args.upload, args.upload?.size_bytes);
      const { id, item } = await allocate(args.upload.size_bytes, "download", {});
      try {
        const bytes = await download(args.upload);
        if (bytes.length !== item.size) throw new Error("Invoke download size mismatch");
        await writeFile(item.file, bytes);
        return { transfer_id: id };
      } catch (error) { await release(id); throw error; }
      finally { item.busy = false; }
    }
    const item = transfers.get(args.transfer_id);
    if (args.action === "release" && !item) return { released: true };
    if (!item) throw new Error("Invoke transfer expired or does not exist");
    if (item.busy) throw new Error("Invoke transfer is busy");
    item.busy = true;
    item.expires = now() + ttl;
    try {
      if (args.action === "release") { await release(args.transfer_id); return { released: true }; }
      if (args.action === "append" && item.kind === "upload") {
        const bytes = base64ToBytes(args.content, INVOKE_CHUNK_BYTES);
        if (args.offset !== item.offset || bytes.length === 0 || item.offset + bytes.length > item.size) throw new Error("Invalid invoke upload offset or size");
        await appendFile(item.file, bytes);
        item.offset += bytes.length;
        return { next_offset: item.offset };
      }
      if (args.action === "finish" && item.kind === "upload") {
        if (item.offset !== item.size) throw new Error("Invoke upload is incomplete");
        const metadata = item.metadata;
        try {
          return await uploadFile({ filePath: item.file, filename: metadata.filename, mimeType: metadata.mime_type,
            purpose: metadata.purpose, workspaceDir: metadata.workspace_dir, source: "ppt-engine.invoke-relay" });
        } finally { await release(args.transfer_id); }
      }
      if (args.action === "read" && item.kind === "download") {
        if (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset >= item.size) throw new Error("Invalid invoke download offset");
        const buffer = Buffer.alloc(Math.min(INVOKE_CHUNK_BYTES, item.size - args.offset));
        const file = await open(item.file, "r");
        try {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, args.offset);
          if (bytesRead !== buffer.length) throw new Error("Invoke download file was truncated");
          return { offset: args.offset, next_offset: args.offset + bytesRead, content: bytesToBase64(buffer) };
        } finally { await file.close(); }
      }
      throw new Error("Invalid invoke transfer action");
    } finally { item.busy = false; }
  }
  return { handle, async close() { clearInterval(timer); for (const id of transfers.keys()) await release(id); } };
}
