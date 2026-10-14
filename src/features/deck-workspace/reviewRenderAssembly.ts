import type { RenderDeckHtmlResult } from "../../api/types";
import type { PptBackend } from "../../api/pptBackend";
import type { GenerationPagePreviews } from "./generationPagePreviews";

export interface ReviewRenderAssemblyResult {
  result: RenderDeckHtmlResult;
  previews: GenerationPagePreviews;
  fetchedPageIds: string[];
  failedPageIds: string[];
}

/** Metadata is sufficient for HTML previews. Loading a deck never uploads PNGs. */
export async function assembleReviewRender(input: {
  backend: Pick<PptBackend, "getWorkspacePageHtml">;
  metadata: RenderDeckHtmlResult;
  workspaceDir: string;
  previews?: GenerationPagePreviews;
  pageIds?: readonly string[];
  nowMs?: number;
}): Promise<ReviewRenderAssemblyResult> {
  const previews: GenerationPagePreviews = {};
  input.metadata.slides.forEach((slide, pageIndex) => {
    previews[slide.slide_id] = {
      pageId: slide.slide_id, pageIndex, title: slide.title, htmlPath: slide.html_path,
      renderSourceFingerprint: slide.render_source_fingerprint,
      snapshotSourceFingerprint: slide.render_source_fingerprint,
      previewSourceFingerprint: slide.preview_source_fingerprint,
      status: slide.html_path && !slide.preview_unavailable ? "ready" : "loading",
    };
  });
  return { result: { ...input.metadata, workspace_dir: input.workspaceDir }, previews, fetchedPageIds: [], failedPageIds: [] };
}
