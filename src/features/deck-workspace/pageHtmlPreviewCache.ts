import type { WorkspacePageHtml } from "../../api/pageHtmlPreview";

const cache = new Map<string, { value: WorkspacePageHtml; expiresAt: number; bytes: number }>();
const pending = new Map<string, Promise<WorkspacePageHtml>>();
const encoder = new TextEncoder();
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

export function previewHtmlUsableUntil(value: WorkspacePageHtml, now = Date.now()) {
  return Math.min(now + 5 * 60_000, value.resources_expires_at ? Date.parse(value.resources_expires_at) - 60_000 : Infinity);
}

export function loadCachedPageHtml(key: string, load: () => Promise<WorkspacePageHtml>, force = false): Promise<WorkspacePageHtml> {
  if (force) cache.delete(key);
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    cache.delete(key);
    cache.set(key, existing);
    return Promise.resolve(existing.value);
  }
  cache.delete(key);
  const request = pending.get(key);
  if (request) return request;
  const next = load().then((value) => {
    const entry = { value, expiresAt: previewHtmlUsableUntil(value), bytes: encoder.encode(value.html).byteLength };
    if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now()) throw new Error("Preview resource URLs have expired");
    if (entry.bytes <= MAX_CACHE_BYTES) cache.set(key, entry);
    while (cache.size > 12 || [...cache.values()].reduce((sum, item) => sum + item.bytes, 0) > MAX_CACHE_BYTES) cache.delete(cache.keys().next().value!);
    return value;
  }).finally(() => { if (pending.get(key) === next) pending.delete(key); });
  pending.set(key, next);
  return next;
}
