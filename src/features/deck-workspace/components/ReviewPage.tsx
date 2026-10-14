import type { RestorePageSourceVersionResult } from "../../../api/types";
import { usePagePreviewUnavailable } from "../previewAvailability";
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Edit3, LayoutGrid, Maximize2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WheelEvent } from "react";
import type { Slide } from "../../../data/mockDeck";
import type { Messages } from "../../../i18n/messages";
import { exitFullscreenPreview, startFullscreenPresentation } from "../fullscreenPreview";
import type { DeckReviewRenderState, PreviewMode } from "../types";
import { formatSlideNumber } from "../utils";
import { PageHeader } from "./PageHeader";
import { SlideThumbnail } from "./SlideThumbnail";
import { RenderedSlideHtml } from "./RenderedSlideHtml";
import { ThumbnailStrip } from "./ThumbnailStrip";
import { SlidePreviewLoading } from "./SlidePreviewLoading";

interface ReviewPageProps {
  onPageRestored?: (result: RestorePageSourceVersionResult) => void;
  recoveryEnabled?: boolean;
  t: Messages;
  deck: Slide[];
  currentSlide: number;
  setCurrentSlide: (index: number) => void;
  previewMode: PreviewMode;
  setPreviewMode: (mode: PreviewMode) => void;
  reviewRender: DeckReviewRenderState;
  renderDeckHtml: () => Promise<void>;
  refreshPageImage: (pageId: string) => Promise<void>;
  onBack: () => void;
  onEdit: () => void;
}

export function ReviewPage(props: ReviewPageProps) {
  const fullscreenPreviewRef = useRef<HTMLDivElement>(null);
  const renderedSlides = props.reviewRender.result?.slides ?? [];
  const maxSlideIndex = Math.max(0, props.deck.length - 1);
  const selectedSlideIndex = Math.min(Math.max(0, props.currentSlide), maxSlideIndex);
  const selectedRenderedSlide = renderedSlides[selectedSlideIndex];
  const previewUnavailable = usePagePreviewUnavailable(props.reviewRender.result?.workspace_dir, selectedRenderedSlide?.slide_id);
  const renderWaiting = props.reviewRender.status === "loading";
  const mode = props.previewMode === "present" ? "present" : "grid";
  const [thumbnailsExpanded, setThumbnailsExpanded] = useState(true);
  const lastWheelAtRef = useRef(0);

  const changeSlide = (delta: number) => {
    props.setCurrentSlide(
      Math.max(0, Math.min(maxSlideIndex, selectedSlideIndex + delta)),
    );
  };

  const handlePresentClick = () => changeSlide(1);

  const handlePresentWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const now = Date.now();
    if (now - lastWheelAtRef.current < 350) return;
    lastWheelAtRef.current = now;
    changeSlide(event.deltaY > 0 ? 1 : -1);
  };

  useEffect(() => {
    if (props.currentSlide !== selectedSlideIndex) {
      props.setCurrentSlide(selectedSlideIndex);
    }
  }, [props.currentSlide, props.setCurrentSlide, selectedSlideIndex]);

  useEffect(() => {
    if (mode !== "present") return;
    const getFullscreenElement = () =>
      document.fullscreenElement ??
      (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ??
      null;
    const returnToGridAfterFullscreenExit = () => {
      if (!getFullscreenElement()) props.setPreviewMode("grid");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector(".preview-recovery-dialog[open]")) return;
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        changeSlide(-1);
      } else if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        changeSlide(1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        props.setPreviewMode("grid");
        if (getFullscreenElement()) void exitFullscreenPreview();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("fullscreenchange", returnToGridAfterFullscreenExit);
    document.addEventListener("webkitfullscreenchange", returnToGridAfterFullscreenExit);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("fullscreenchange", returnToGridAfterFullscreenExit);
      document.removeEventListener("webkitfullscreenchange", returnToGridAfterFullscreenExit);
    };
  }, [mode, props.currentSlide, props.deck.length, props.setCurrentSlide, props.setPreviewMode, selectedSlideIndex]);
  return (
    <section className="page active review-page">
      <PageHeader
        title={props.t.review.title}
        onBack={props.onBack}
        t={props.t}
        actions={
          <>
            <button
              data-performance-id="review.render-again"
              className="icon-action-btn"
              onClick={() => void props.renderDeckHtml()}
              disabled={renderWaiting}
              title={props.t.review.renderAgain}
              aria-label={props.t.review.renderAgain}
            >
              <RefreshCw size={14} aria-hidden="true" />
            </button>
            <button
              data-performance-id="review.manual-edit"
              className="icon-action-btn"
              disabled={previewUnavailable} onClick={props.onEdit}
              title={props.t.controls.edit}
              aria-label={props.t.controls.edit}
            >
              <Edit3 size={14} aria-hidden="true" />
            </button>
          </>
        }
      />
      <div className="mode-toggle">
        <button
          data-performance-id="review.mode.grid"
          className={mode === "grid" ? "active" : ""}
          aria-pressed={mode === "grid"}
          onClick={() => props.setPreviewMode("grid")}
        >
          <LayoutGrid size={14} aria-hidden="true" />{props.t.review.grid}
        </button>
        <button
          data-performance-id="review.mode.present"
          className={mode === "present" ? "active" : ""}
          aria-pressed={mode === "present"}
          onClick={() => void startFullscreenPresentation(
            fullscreenPreviewRef.current,
            () => props.setPreviewMode("present"),
          )}
        >
          <Maximize2 size={14} aria-hidden="true" />{props.t.review.present}
        </button>
      </div>
      {props.reviewRender.status === "loading" ? <PreviewLoadingFrame label={props.t.review.rendering} /> : null}
      {props.reviewRender.status === "error" ? (
        <div className="deck-html-review-error"><AlertTriangle size={18} aria-hidden="true" /><pre>{props.reviewRender.error}</pre></div>
      ) : null}
      <div className="review-fullscreen-preview" ref={fullscreenPreviewRef}>
        {mode === "grid" ? (
          <div className="preview-grid-view">
            {props.deck.map((slide, index) => (
              <article key={`${slide.title}-${index}`} className={`grid-card ${index === selectedSlideIndex ? "active" : ""}`} onClick={() => props.setCurrentSlide(index)}>
                <span>{formatSlideNumber(index)}</span>
                {(renderedSlides[index]?.html_path || renderedSlides[index]?.preview_unavailable) ? (
                  <div className="grid-card-html-frame">
                    <SlideThumbnail t={props.t} workspaceDir={props.reviewRender.result!.workspace_dir}
                      pageId={renderedSlides[index].slide_id} title={slide.title}
                      priority={index === selectedSlideIndex ? "foreground" : "background"}
                      version={renderedSlides[index].preview_version ?? renderedSlides[index].preview_source_fingerprint ?? renderedSlides[index].html_path}
                      expectedFingerprint={renderedSlides[index].preview_source_fingerprint} />
                  </div>
                ) : (
                  <PreviewLoadingFrame compact label={props.t.review.rendering} />
                )}
                <strong>{slide.title}</strong>
              </article>
            ))}
          </div>
        ) : (
          <div className={`preview-present-view ${thumbnailsExpanded ? "thumbnails-expanded" : "thumbnails-collapsed"}`} onWheel={handlePresentWheel}>
            {(selectedRenderedSlide?.html_path || selectedRenderedSlide?.preview_unavailable)
              ? (
                <div
                  className="present-html-frame"
                  role="button"
                  tabIndex={0}
                  aria-label={`${props.t.review.present} ${formatSlideNumber(selectedSlideIndex)}`}
                  onClick={handlePresentClick}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      changeSlide(1);
                    }
                  }}
                >
                  <RenderedSlideHtml recoveryEnabled={props.recoveryEnabled} onPageRestored={props.onPageRestored} t={props.t} workspaceDir={props.reviewRender.result!.workspace_dir}
                    pageId={selectedRenderedSlide.slide_id} title={selectedRenderedSlide.title}
                    version={selectedRenderedSlide.preview_version ?? selectedRenderedSlide.preview_source_fingerprint ?? selectedRenderedSlide.html_path}
                    expectedFingerprint={selectedRenderedSlide.preview_source_fingerprint} />
                </div>
              )
              : <PreviewLoadingFrame label={props.t.review.rendering} />}
            <div className="preview-present-controls">
              <button
                type="button"
                className="icon-action-btn"
                aria-label={props.t.deck.previousSlide}
                disabled={selectedSlideIndex <= 0}
                onClick={() => changeSlide(-1)}
              >
                <ChevronLeft size={18} aria-hidden="true" />
              </button>
              <span>{selectedSlideIndex + 1}/{props.deck.length}</span>
              <button
                type="button"
                className="icon-action-btn"
                aria-label={props.t.deck.nextSlide}
                disabled={selectedSlideIndex >= maxSlideIndex}
                onClick={() => changeSlide(1)}
              >
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="preview-thumbnails-panel">
              <div className="preview-thumbnails-header">
                <span>{props.t.controls.preview}</span>
                <button
                  type="button"
                  className="icon-action-btn preview-thumbnails-toggle"
                  aria-expanded={thumbnailsExpanded}
                  aria-label={props.t.controls.preview}
                  title={props.t.controls.preview}
                  onClick={() => setThumbnailsExpanded((expanded) => !expanded)}
                >
                  {thumbnailsExpanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}
                </button>
              </div>
              {thumbnailsExpanded ? (
                <ThumbnailStrip t={props.t} workspaceDir={props.reviewRender.result?.workspace_dir}
                  deck={props.deck}
                  currentSlide={selectedSlideIndex}
                  setCurrentSlide={props.setCurrentSlide}
                  renderedSlides={renderedSlides}
                />
              ) : null}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function PreviewLoadingFrame({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <div className={`preview-loading-frame ${compact ? "compact" : ""}`}>
      <SlidePreviewLoading label={label} compact={compact} />
    </div>
  );
}
