import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pagePreviewKey } from "../../src/features/deck-workspace/pagePreviewWork";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../../src");

describe("manual-save preview cache key", () => {
  it("pagePreviewKey changes when the version changes", () => {
    const base = { pageId: "page-1", title: "t", version: "a.html" };
    const first = pagePreviewKey("/ws", base);
    const second = pagePreviewKey("/ws", { ...base, version: "manual-save:2026-09-20T10:00:00Z" });
    assert.notEqual(first, second);
    // Same inputs must keep producing the same key (session reuse).
    assert.equal(second, pagePreviewKey("/ws", { ...base, version: "manual-save:2026-09-20T10:00:00Z" }));
  });

  it("applyManualPageUpdate stamps a per-save preview version", async () => {
    const hook = await readFile(join(SRC, "features/deck-workspace/hooks/useDeckWorkspace.ts"), "utf8");
    const apply = hook.slice(hook.indexOf("function applyManualPageUpdate"), hook.indexOf("function ", hook.indexOf("function applyManualPageUpdate") + 10));
    // anna-ppt keys previews off the server-provided fingerprint for the freshly
    // saved HTML, so the manual-save path keeps that fingerprint instead of
    // clearing it; the per-save version below still has to lead the cache-key
    // chain (see the consumer test).
    assert.match(apply, /preview_source_fingerprint: result\.preview_source_fingerprint/);
    assert.match(apply, /preview_version: `manual-save:\$\{result\.page_progress_updated_at\}`/);
  });

  it("every RenderedSlideHtml consumer prefers preview_version", async () => {
    for (const file of ["SlidePreviewNavigator.tsx", "ReviewPage.tsx", "RefinePage.tsx"]) {
      const source = await readFile(join(SRC, "features/deck-workspace/components", file), "utf8");
      assert.match(
        source,
        /preview_version \?\? \w+\.preview_source_fingerprint \?\? \w+\.html_path/,
        `${file} must key previews off preview_version first`,
      );
    }
  });
});
