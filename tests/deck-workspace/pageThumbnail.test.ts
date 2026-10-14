import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePageThumbnail, type PageThumbnail } from "../../src/api/pageThumbnail.ts";
import { createPageThumbnailCache } from "../../src/features/deck-workspace/pageThumbnailCache.ts";

const value: PageThumbnail = { version: 1, page_id: "page-a", preview_source_fingerprint: "version-a", width: 640, height: 360,
  size_bytes: 4, generated_at: "2026-09-20T00:00:00Z", image_url: "data:image/webp;base64,YWJjZA==", expires_at: null };

test("thumbnail validates WebP, page and version and rejects legacy upload references", () => {
  const { image_url, expires_at, ...metadata } = value;
  const inline = { ...metadata, image_data_url: image_url };
  assert.equal(decodePageThumbnail(inline, { workspace_dir: "/workspace" }).image_url, image_url);
  assert.throws(() => decodePageThumbnail(inline, { workspace_dir: "/workspace", page_id: "other" }), /version changed/);
  assert.throws(() => decodePageThumbnail(inline, { workspace_dir: "/workspace", expected_preview_fingerprint: "old" }), /version changed/);
  assert.throws(() => decodePageThumbnail({ ...inline, image_data_url: "data:image/png;base64,YWJjZA==" }, { workspace_dir: "/workspace" }), /Invalid/);
  assert.equal(decodePageThumbnail(inline, { workspace_dir: "/workspace" }).expires_at, null);
  assert.throws(() => decodePageThumbnail({ ...metadata, image_upload: { url: "https://example.test/thumb.webp" } } as any,
    { workspace_dir: "/workspace" }), /Invalid/);
});

test("thumbnail loads share requests, reuse warm versions and bound actual work to four", async () => {
  const cache = createPageThumbnailCache();
  const releases: Array<() => void> = [];
  let active = 0, peak = 0, calls = 0;
  const load = async () => { calls++; active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve)); active--; return value; };
  const first = cache("same", load);
  assert.equal(cache("same", load), first);
  const rest = Array.from({ length: 6 }, (_, i) => cache(`page-${i}`, load));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 4);
  releases.splice(0).forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((release) => release());
  await Promise.all([first, ...rest]);
  assert.equal(peak, 4);
  assert.equal(calls, 7);
  assert.equal(await cache("same", load), value);
  assert.equal(calls, 7);
});

test("failed or expired thumbnail references retry instead of remaining cached", async () => {
  const cache = createPageThumbnailCache();
  await assert.rejects(cache("page", async () => { throw new Error("offline"); }), /offline/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await cache("page", async () => value), value);
  await cache("expired", async () => ({ ...value, expires_at: new Date(Date.now()).toISOString() }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await cache("expired", async () => value), value);
});
