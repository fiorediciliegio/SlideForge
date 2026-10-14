import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PreviewResource, PreviewResourceUrl } from "./resources.js";

type RecordValue = Record<string, unknown>;
function valueType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

/** Log structure and expiry metadata, never signed URLs or arbitrary response values. */
function describeDownloadResponse(value: unknown, now: number) {
  const response = value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
  const fields = Object.fromEntries(Object.entries(response).map(([key, entry]) => [key, valueType(entry)]));
  const urls = Object.fromEntries(["url", "get_url"].map((key) => {
    const entry = response[key];
    let protocol: string | null = null;
    if (typeof entry === "string") {
      try { protocol = new URL(entry).protocol; } catch { /* Invalid URL: do not log its content. */ }
    }
    return [key, { present: Object.hasOwn(response, key), type: valueType(entry), protocol }];
  }));
  const expiry = Object.fromEntries(["expires_at", "expires_in", "ttl_seconds"].map((key) => {
    const entry = response[key];
    const safeValue = typeof entry === "number" && Number.isFinite(entry) ? entry
      : typeof entry === "string" && entry.length <= 80 && /^[0-9TtZz:+.\-\s]+$/.test(entry) ? entry : null;
    return [key, { present: Object.hasOwn(response, key), type: valueType(entry), value: safeValue,
      redacted: entry !== undefined && entry !== null && safeValue === null }];
  }));
  const url = response.url ?? response.get_url;
  const expiresAt = response.expires_at;
  const parsedExpiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  const reasons: string[] = [];
  if (typeof url !== "string") reasons.push("url_missing_or_not_string");
  else if (!url.startsWith("https://")) reasons.push("url_not_https");
  if (typeof expiresAt !== "string") reasons.push("expires_at_missing_or_not_string");
  else if (!Number.isFinite(parsedExpiry)) reasons.push("expires_at_unparseable");
  else if (parsedExpiry <= now + 60_000) reasons.push("expires_at_insufficient_remaining_time");
  return { response_type: valueType(value), response_fields: fields, url_fields: urls, expiry_fields: expiry,
    received_at: new Date(now).toISOString(), parsed_expires_at: Number.isFinite(parsedExpiry) ? new Date(parsedExpiry).toISOString() : null,
    remaining_ms: Number.isFinite(parsedExpiry) ? parsedExpiry - now : null, validation_reasons: reasons };
}

const publicationQueues = new Map<string, Promise<unknown>>();
async function serializePublication<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = publicationQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  publicationQueues.set(key, current);
  try { return await current; }
  finally { if (publicationQueues.get(key) === current) publicationQueues.delete(key); }
}
export interface PreviewApsClient {
  list(input: { prefix: string; scope: string; limit: number }): Promise<unknown>;
  uploadBegin(input: { path: string; scope: string; sizeBytes: number; contentType: string }): Promise<RecordValue>;
  uploadComplete(input: { path: string; scope: string; sizeBytes: number; contentType: string; etag?: string }): Promise<RecordValue>;
  downloadUrl(input: { path: string; scope: string; expiresIn: number }): Promise<RecordValue>;
}

function entries(value: unknown): RecordValue[] {
  if (Array.isArray(value)) return value as RecordValue[];
  if (value && typeof value === "object") {
    for (const key of ["entries", "objects", "items", "files", "data"]) {
      const list = (value as RecordValue)[key];
      if (Array.isArray(list)) return list as RecordValue[];
    }
  }
  // An unknown response is not proof that the object is missing.
  throw new Error("Unrecognized APS file listing response");
}

/** Durable content-addressed files; signed URLs are never persisted. */
export function createPreviewResourceResolver(input: {
  client: PreviewApsClient;
  indexDirectory: string;
  onEvent?: (phase: string, details: RecordValue) => void;
  fetch?: typeof fetch;
}) {
  const pending = new Map<string, Promise<PreviewResourceUrl>>();
  return (resource: PreviewResource): Promise<PreviewResourceUrl> => {
    const sha256 = createHash("sha256").update(resource.bytes).digest("hex");
    const existing = pending.get(sha256);
    if (existing) return existing;
    const startedAt = Date.now();
    let stage = "publication-queue";
    const operation = serializePublication(sha256, async () => {
      stage = "local-index";
      const scope = "user";
      const expectedPath = `ppt-app/preview-assets/${sha256}${resource.extension === ".jpeg" ? ".jpg" : resource.extension}`;
      const recordPath = path.join(input.indexDirectory, `${sha256}.json`);
      const record = await readFile(recordPath, "utf8").then((text) => JSON.parse(text) as RecordValue).catch(() => null);
      const apsPath = record?.sha256 === sha256 && record.aps_path === expectedPath ? String(record.aps_path) : expectedPath;
      // Always check through the current authenticated user namespace. A local
      // record copied from another account/environment cannot authorize reuse.
      stage = "resource-list";
      const listStartedAt = Date.now();
      const listed = entries(await input.client.list({ prefix: apsPath, scope, limit: 2 }));
      const remote = listed.find((entry) => {
        const name = typeof entry === "string" ? entry : entry.path ?? entry.key ?? entry.name;
        return name === apsPath || name === `user/${apsPath}`;
      });
      const remoteSize = remote && (remote.size_bytes ?? remote.size);
      input.onEvent?.("resource-resolved", { sha256, aps_path: apsPath, remote_exists: Boolean(remote),
        index_hit: record?.sha256 === sha256 && record.aps_path === expectedPath,
        duration_ms: Date.now() - listStartedAt, elapsed_ms: Date.now() - startedAt });
      if (remoteSize !== undefined && Number(remoteSize) !== resource.bytes.length) {
        throw new Error("APS preview resource size does not match its content identity");
      }
      let etag = remote?.etag;
      if (!remote) {
        stage = "resource-upload";
        input.onEvent?.("upload-started", { sha256, aps_path: apsPath, size_bytes: resource.bytes.length });
        const upload = await input.client.uploadBegin({ path: apsPath, scope, sizeBytes: resource.bytes.length, contentType: resource.mimeType });
        if (typeof upload.put_url !== "string" || !upload.put_url.startsWith("https://")) throw new Error("APS resource upload URL is unavailable");
        const response = await (input.fetch ?? fetch)(upload.put_url, {
          method: "PUT",
          headers: { ...(upload.headers as Record<string, string> ?? {}), "Content-Type": resource.mimeType },
          body: new Uint8Array(resource.bytes),
        });
        if (!response.ok) throw new Error(`APS resource upload failed: HTTP ${response.status}`);
        const confirmed = await input.client.uploadComplete({
          path: apsPath, scope, sizeBytes: resource.bytes.length, contentType: resource.mimeType,
          etag: response.headers.get("etag") ?? undefined,
        });
        if (confirmed.size_bytes !== undefined && Number(confirmed.size_bytes) !== resource.bytes.length) throw new Error("APS resource confirmation size mismatch");
        etag = confirmed.etag ?? response.headers.get("etag");
        input.onEvent?.("upload-confirmed", { sha256, aps_path: apsPath });
      }
      stage = "index-write";
      await mkdir(input.indexDirectory, { recursive: true });
      const temporary = `${recordPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, sha256, provider: "aps.files", scope, aps_path: apsPath,
          size_bytes: resource.bytes.length, mime_type: resource.mimeType, etag: etag ?? null }));
        await rename(temporary, recordPath);
      } finally { await rm(temporary, { force: true }); }
      stage = "download-url-request";
      const downloadStartedAt = Date.now();
      input.onEvent?.("download-url-started", { sha256, aps_path: apsPath, scope, requested_expires_in: 3600,
        elapsed_ms: downloadStartedAt - startedAt });
      const download = await input.client.downloadUrl({ path: apsPath, scope, expiresIn: 3600 });
      const receivedAt = Date.now();
      const diagnostic = describeDownloadResponse(download, receivedAt);
      input.onEvent?.("download-url-response", { sha256, aps_path: apsPath, ...diagnostic,
        duration_ms: receivedAt - downloadStartedAt, elapsed_ms: receivedAt - startedAt });
      stage = "download-url-validation";
      const url = download.url ?? download.get_url;
      const expiresAt = download.expires_at;
      if (typeof url !== "string" || !url.startsWith("https://") || typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now() + 60_000) {
        input.onEvent?.("download-url-validation-failed", { sha256, aps_path: apsPath,
          validation_reasons: diagnostic.validation_reasons, elapsed_ms: Date.now() - startedAt });
        throw new Error("APS preview resource download URL or expiry is invalid");
      }
      input.onEvent?.("resource-ready", { sha256, aps_path: apsPath, elapsed_ms: Date.now() - startedAt });
      return { url, expires_at: expiresAt };
    }).catch((error) => {
      // Exception messages and provider data may contain a signed URL; log only safe classifications.
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      input.onEvent?.("failed", { sha256, stage, elapsed_ms: Date.now() - startedAt,
        error_kind: error instanceof TypeError ? "TypeError" : error instanceof Error ? "Error" : "unknown",
        error_code: typeof code === "number" && Number.isFinite(code) ? code : null });
      throw error;
    });
    pending.set(sha256, operation);
    // The resolver belongs to one preview request; never retain URLs across accounts.
    return operation;
  };
}
