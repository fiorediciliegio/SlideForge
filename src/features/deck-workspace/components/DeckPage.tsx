import type { RestorePageSourceVersionResult } from "../../../api/types";
import { usePagePreviewUnavailable } from "../previewAvailability";
import { ArrowLeft, Download, Edit3, Eye, PanelLeftClose, PanelLeftOpen, Sparkles, Wrench } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { Slide } from "../../../data/mockDeck";
import type { Messages } from "../../../i18n/messages";
import type { DeckReviewRenderState } from "../types";
import { SlidePreviewNavigator } from "./SlidePreviewNavigator";
import { ThumbnailStrip } from "./ThumbnailStrip";

interface DeckPageProps {
  onPageRestored?: (result: RestorePageSourceVersionResult) => void;
  recoveryEnabled?: boolean;
  t: Messages;
  deck: Slide[];
  currentSlide: number;
  setCurrentSlide: (index: number) => void;
  reviewRender: DeckReviewRenderState;
  loading: string;
  onPreview: () => void;
  onBack: () => void;
  onRefineSlide: (instruction: string) => void;
  onRegeneratePage: () => void;
  onBeautifyPage: () => void;
  canRegeneratePage: boolean;
  onRefineDeck: () => void;
  onExport: () => void;
  onEdit: () => void;
}

export type SlideLayoutMode = "simpler" | "visual" | "comparison" | "process" | "report";

export function DeckPage(props: DeckPageProps) {
  const [isInlineRefineOpen, setIsInlineRefineOpen] = useState(false);
  const [refineInstruction, setRefineInstruction] = useState("");
  const [thumbnailsCollapsed, setThumbnailsCollapsed] = useState(false);
  const thumbnailsId = useId();
  const inlineRefineId = useId();
  const selectedIndex = Math.min(Math.max(props.currentSlide, 0), Math.max(0, props.deck.length - 1));
  const selectedPreview = props.reviewRender.result?.slides[selectedIndex];
  const previewUnavailable = usePagePreviewUnavailable(props.reviewRender.result?.workspace_dir, selectedPreview?.slide_id);

  useEffect(() => {
    setIsInlineRefineOpen(false);
    setRefineInstruction("");
  }, [selectedIndex]);

  return (
    <section className={`page active deck-page${thumbnailsCollapsed ? " thumbnails-collapsed" : ""}`}>
      <aside className="deck-result-sidebar" aria-label={props.t.deck.thumbnails}>
        <div className="deck-result-sidebar-header">
          {!thumbnailsCollapsed ? <strong>{props.t.deck.thumbnails}</strong> : null}
          <button
            className="deck-result-sidebar-toggle"
            data-performance-id="deck.thumbnails.toggle"
            type="button"
            aria-label={thumbnailsCollapsed ? props.t.controls.expandSidebar : props.t.controls.collapseSidebar}
            title={thumbnailsCollapsed ? props.t.controls.expandSidebar : props.t.controls.collapseSidebar}
            aria-expanded={!thumbnailsCollapsed}
            aria-controls={thumbnailsId}
            onClick={() => setThumbnailsCollapsed((collapsed) => !collapsed)}
          >
            {thumbnailsCollapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}
          </button>
        </div>
        <div id={thumbnailsId} className="deck-result-thumbnail-list" hidden={thumbnailsCollapsed}>
          <ThumbnailStrip t={props.t} workspaceDir={props.reviewRender.result?.workspace_dir}
            deck={props.deck}
            currentSlide={selectedIndex}
            setCurrentSlide={props.setCurrentSlide}
            renderedSlides={props.reviewRender.result?.slides}
            orientation="vertical"
            preloadPages={props.reviewRender.status === "ready"}
          />
        </div>
      </aside>
      <div className="deck-result-main">
        <div className="deck-top-actions">
          <button data-performance-id="deck.back" className="secondary-btn deck-back-btn" type="button" onClick={() => props.onBack()}>
            <ArrowLeft size={16} aria-hidden="true" />{props.t.controls.back}
          </button>
          <button
            data-performance-id="deck.preview"
            className="secondary-btn"
            type="button"
            onClick={props.onPreview}
          >
            <Eye size={14} aria-hidden="true" />
            {props.t.controls.preview}
          </button>
          <button data-performance-id="deck.export" className="secondary-btn" type="button" onClick={props.onExport}>
            <Download size={14} aria-hidden="true" />
            {props.t.controls.export}
          </button>
        </div>
        <div className="deck-result-preview">
          <SlidePreviewNavigator
            recoveryEnabled={props.recoveryEnabled} onPageRestored={props.onPageRestored}
            layout="workspace"
            preloadPages
            t={props.t}
            deck={props.deck}
            currentSlide={props.currentSlide}
            setCurrentSlide={props.setCurrentSlide}
            reviewRender={props.reviewRender}
          />
        </div>
        <div className="action-bar">
          <button
            data-performance-id="deck.manual-edit"
            className="secondary-btn"
            disabled={previewUnavailable} onClick={props.onEdit}
            title={props.t.controls.edit}
            aria-label={props.t.controls.edit}
          >
            <Edit3 size={14} aria-hidden="true" />
            {props.t.controls.edit}
          </button>
          <button
            data-performance-id="deck.refine-page"
            className="secondary-btn"
            type="button"
            disabled={previewUnavailable} aria-expanded={isInlineRefineOpen}
            aria-controls={isInlineRefineOpen ? inlineRefineId : undefined}
            onClick={() => setIsInlineRefineOpen((open) => !open)}
          >
            <Sparkles size={14} aria-hidden="true" />
            {props.t.controls.refineSlide}
          </button>
          <button data-performance-id="deck.beautify-page" className="secondary-btn" type="button"
            disabled={previewUnavailable || !props.canRegeneratePage || props.loading !== "none"} onClick={props.onBeautifyPage}>
            <Wrench size={15} aria-hidden="true" />{props.t.pageBeautification.button}
          </button>
          <button data-performance-id="deck.regenerate-alternatives" className="deck-regenerate-btn" type="button"
            disabled={previewUnavailable || !props.canRegeneratePage || props.loading !== "none"} onClick={props.onRegeneratePage}>
            <Sparkles size={15} aria-hidden="true" />
            {props.t.pageRegeneration.button}
          </button>
        </div>
        {isInlineRefineOpen ? (
          <div id={inlineRefineId} className="deck-inline-refine">
            <label className="refine-label" htmlFor="deck-inline-refine-prompt">
              {props.t.refine.slidePrompt}
              <textarea
                id="deck-inline-refine-prompt"
                name="deck-inline-refine-prompt"
                className="refine-input"
                placeholder={props.t.refine.slidePlaceholder}
                value={refineInstruction}
                onChange={(event) => setRefineInstruction(event.target.value)}
                disabled={props.loading !== "none"}
              />
            </label>
            <button
              data-performance-id="deck.refine-page.apply"
              className="primary-btn deck-inline-refine-submit"
              type="button"
              onClick={() => props.onRefineSlide(refineInstruction)}
              disabled={previewUnavailable || props.loading !== "none" || !refineInstruction.trim()}
            >
              {props.loading === "refineSlide" ? <span className="spinner small" /> : null}
              {props.t.controls.applyToSlide}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
