import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspacePageHtml } from "../../src/api/pageHtmlPreview";
import { loadCachedPageHtml, previewHtmlUsableUntil } from "../../src/features/deck-workspace/pageHtmlPreviewCache";

function payload(html: string): WorkspacePageHtml {
  return { page_id: "page", html_fingerprint: "html", preview_source_fingerprint: "image", resources_expires_at: null, html };
}
test("cache coalesces requests, isolates workspace/version keys and expires ahead of resource URLs", async () => {
  let loads = 0;
  const load = async () => { loads++; return payload("<html>缓存</html>"); };
  await Promise.all([loadCachedPageHtml("workspace-a:version-1", load), loadCachedPageHtml("workspace-a:version-1", load)]);
  assert.equal(loads, 1);
  await loadCachedPageHtml("workspace-a:version-1", load);
  assert.equal(loads, 1);
  await loadCachedPageHtml("workspace-a:version-2", load);
  await loadCachedPageHtml("workspace-b:version-1", load);
  assert.equal(loads, 3);
  await loadCachedPageHtml("workspace-a:version-1", load, true);
  assert.equal(loads, 4);
  const now = Date.now();
  const value = await load();
  assert.equal(previewHtmlUsableUntil({ ...value, resources_expires_at: new Date(now + 120000).toISOString() }, now), now + 60000);
});
