import type { RestorePageSourceVersionResult } from "../../../api/types";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Slide } from "../../../data/mockDeck";
import { formatMessage, type Messages } from "../../../i18n/messages";
import type { DeckReviewRenderState } from "../types";
import { DeckPreviewCanvas } from "./DeckPreviewCanvas";
import { RenderedSlideHtml } from "./RenderedSlideHtml";
import { SlidePreviewLoading } from "./SlidePreviewLoading";
import { ThumbnailStrip } from "./ThumbnailStrip";

interface SlidePreviewNavigatorProps {
  onPageRestored?: (result: RestorePageSourceVersionResult) => void;
  recoveryEnabled?: boolean;
  layout?: "stacked" | "workspace";
  preloadPages?: boolean;
  t: Messages;
  deck: Slide[];
  currentSlide: number;
  setCurrentSlide: (index: number) => void;
  reviewRender: DeckReviewRenderState;
}

export function SlidePreviewNavigator(props: SlidePreviewNavigatorProps) {
  const { t, deck, currentSlide, setCurrentSlide, reviewRender } = props;
  const maxSlideIndex = Math.max(0, deck.length - 1);
  const selectedIndex = Math.min(Math.max(currentSlide, 0), maxSlideIndex);
  const renderedSlides = reviewRender.result?.slides ?? [];
  const selectedRenderedSlide = renderedSlides[selectedIndex];

  // A failed preview used to fall through to the generic loading branch below.
  // That made a terminal render failure indistinguishable from an in-flight
  // render and left the user looking at a spinner forever. In particular, an
  // older restored snapshot can declare a completed deck while its page assets
  // are no longer renderable. Preserve that data, but surface the failure.
  if (reviewRender.status === "error") {
    return (
      <div className="deck-html-review-error" role="alert">
        <strong>{t.review.renderFailed}</strong>
        <pre>{reviewRender.error}</pre>
      </div>
    );
  }

  // Lightweight metadata still identifies every page. Let the session prepare
  // missing previews individually and reuse unchanged page versions.
  const preview = reviewRender.status === "ready" && (selectedRenderedSlide?.html_path || selectedRenderedSlide?.preview_unavailable) ? (
    <div className="deck-stage-html-frame">
      <RenderedSlideHtml recoveryEnabled={props.recoveryEnabled} onPageRestored={props.onPageRestored}
        preservePreviousPreview={props.layout !== "workspace"} pages={props.preloadPages ? renderedSlides.map((slide) => ({
        pageId: slide.slide_id, title: slide.title, version: slide.preview_version ?? slide.preview_source_fingerprint ?? slide.html_path,
        expectedFingerprint: slide.preview_source_fingerprint,
      })) : undefined} t={t} workspaceDir={reviewRender.result!.workspace_dir} pageId={selectedRenderedSlide.slide_id} title={selectedRenderedSlide.title} version={selectedRenderedSlide.preview_version ?? selectedRenderedSlide.preview_source_fingerprint ?? selectedRenderedSlide.html_path} expectedFingerprint={selectedRenderedSlide.preview_source_fingerprint} />
    </div>
  ) : (
    <div className="deck-stage-html-frame">
      <SlidePreviewLoading label={t.review.previewLoading} />
    </div>
  );

  return (
    <>
      {props.layout === "workspace" ? (
        <DeckPreviewCanvas key={reviewRender.result?.workspace_dir} t={t} pageId={selectedRenderedSlide?.slide_id ?? selectedIndex}>
          {preview}
        </DeckPreviewCanvas>
      ) : preview}

      {props.layout !== "workspace" ? <div className="preview-controls">
        <button
          data-performance-id="deck.slide.previous"
          className="nav-arrow"
          type="button"
          aria-label={t.deck.previousSlide}
          disabled={selectedIndex === 0}
          onClick={() => setCurrentSlide(Math.max(0, selectedIndex - 1))}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <div className="slide-counter">
          {formatMessage(t.deck.slideCounter, {
            current: String(selectedIndex + 1),
            total: String(deck.length)
          })}
        </div>
        <button
          data-performance-id="deck.slide.next"
          className="nav-arrow"
          type="button"
          aria-label={t.deck.nextSlide}
          disabled={selectedIndex === maxSlideIndex}
          onClick={() => setCurrentSlide(Math.min(maxSlideIndex, selectedIndex + 1))}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div> : null}

      {props.layout !== "workspace" ? <ThumbnailStrip t={t} workspaceDir={reviewRender.result?.workspace_dir}
        deck={deck}
        currentSlide={selectedIndex}
        setCurrentSlide={setCurrentSlide}
        renderedSlides={renderedSlides}
      /> : null}
    </>
  );
}
