import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PptBackend } from "../../src/api/pptBackend.ts";
import type {
  GetWorkspacePageImageResult,
  HostUploadRef,
  RenderDeckHtmlResult,
} from "../../src/api/types.ts";
import type { GenerationPagePreviews } from "../../src/features/deck-workspace/generationPagePreviews.ts";
import { assembleReviewRender } from "../../src/features/deck-workspace/reviewRenderAssembly.ts";

function upload(pageId: string): HostUploadRef {
  return {
    transport: "host_upload",
    r2_key: pageId,
    url: `https://example.test/${pageId}.webp`,
    mime_type: "image/webp",
    size_bytes: 100,
    expires_at: "2026-08-03T01:00:00.000Z",
  };
}

function metadata(pageCount = 5): RenderDeckHtmlResult {
  return {
    workspace_dir: "/official",
    manifest_path: "/official/manifest.json",
    output_dir: "/official/output",
    deck_html_path: "/official/output/deck.html",
    slides: Array.from({ length: pageCount }, (_, index) => {
      const pageId = `page-${index + 1}`;
      return {
        slide_id: pageId,
        layout_id: "",
        title: `Page ${index + 1}`,
        html_path: `/official/output/${pageId}.html`,
        screenshot_path: `/official/output/${pageId}.png`,
        render_source_fingerprint: `source-${pageId}`,
        preview_source_fingerprint: `fingerprint-${pageId}`,
        speaker_note: "",
      };
    }),
    slide_count: pageCount,
    title: "Deck",
    rendered_at: "2026-08-03T00:00:00.000Z",
  };
}

describe("HTML review metadata", () => {
  it("uses page metadata immediately without fetching or uploading screenshots", async () => {
    const result = metadata();
    const backend = { getWorkspacePageHtml: async () => { throw new Error("Assembly must not eagerly load HTML"); } };
    const assembled = await assembleReviewRender({ backend, metadata: result, workspaceDir: "/official" });
    assert.equal(assembled.result.slide_count, 5);
    assert.deepEqual(assembled.fetchedPageIds, []);
    assert.deepEqual(assembled.failedPageIds, []);
    assert.equal(Object.keys(assembled.previews).length, 5);
    assert.equal(assembled.previews["page-1"]?.htmlPath, result.slides[0].html_path);
    assert.equal(assembled.previews["page-1"]?.status, "ready");
    const pending = await assembleReviewRender({ backend, metadata: { ...result,
      slides: result.slides.map((slide) => ({ ...slide, html_path: "", preview_unavailable: true })) },
      workspaceDir: "/official" });
    assert.equal(pending.previews["page-1"]?.status, "loading");
  });
});
