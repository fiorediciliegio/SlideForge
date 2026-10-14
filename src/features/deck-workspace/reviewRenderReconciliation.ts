import type { PageProgress, RenderDeckHtmlResult, WorkspaceOutlineItem } from "../../api/types";

/** The minimal rendering manifest owns page identity, not the displayed title. */
export function withOutlineTitles(
  result: RenderDeckHtmlResult,
  outline: readonly WorkspaceOutlineItem[],
): RenderDeckHtmlResult {
  const titles = new Map(outline.filter((item) => item?.page_id && typeof item.title === "string")
    .map((item) => [item.page_id, item.title]));
  return {
    ...result,
    slides: result.slides.map((slide, index) => ({
      ...slide,
      title: titles.get(slide.slide_id)
        ?? (!outline[index]?.page_id ? outline[index]?.title : undefined)
        ?? slide.title,
    })),
  };
}

/** Preserve unchanged previews across all ways of publishing page results. */
export function reconcileReviewRender(input: {
  previous: RenderDeckHtmlResult | null;
  metadata: RenderDeckHtmlResult;
  previousProgress: PageProgress | null;
  nextProgress: PageProgress | null;
  changedPageIds: readonly string[];
  outline: readonly WorkspaceOutlineItem[];
}): RenderDeckHtmlResult {
  const next = withOutlineTitles(input.metadata, input.outline);
  if (input.previous?.workspace_dir !== next.workspace_dir) return next;
  const previousSlides = new Map(input.previous.slides.map((slide) => [slide.slide_id, slide]));
  const previousPages = new Map(input.previousProgress?.pages.map((page) => [page.page_id, page]));
  const nextPages = new Map(input.nextProgress?.pages.map((page) => [page.page_id, page]));
  const changedPageIds = new Set(input.changedPageIds);
  return {
    ...next,
    slides: next.slides.map((slide) => {
      const previous = previousSlides.get(slide.slide_id);
      const before = previousPages.get(slide.slide_id);
      const after = nextPages.get(slide.slide_id);
      // A refreshed timestamp alone cannot be compared with a previously loaded
      // content fingerprint. Check the authoritative per-page progress instead.
      if (changedPageIds.has(slide.slide_id) || !previous || !before || !after
        || !before.updated_at || before.updated_at !== after.updated_at
        || before.status !== after.status
        || previous.render_source_fingerprint !== slide.render_source_fingerprint
        || (slide.preview_source_fingerprint && previous.preview_source_fingerprint
          && slide.preview_source_fingerprint !== previous.preview_source_fingerprint)
        || (slide.preview_version && slide.preview_version !== previous.preview_version
          && slide.preview_version !== after.updated_at)
        || before.render_source_sha256 !== after.render_source_sha256
        || before.snapshot_source_sha256 !== after.snapshot_source_sha256
        || before.last_html_path !== after.last_html_path) return slide;
      return {
        ...slide,
        html_path: previous.html_path,
        preview_unavailable: previous.preview_unavailable,
        preview_source_fingerprint: previous.preview_source_fingerprint,
        preview_version: previous.preview_version,
        manually_edited: previous.manually_edited,
      };
    }),
  };
}
