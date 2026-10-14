import { ZoomIn, ZoomOut } from "lucide-react";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Messages } from "../../../i18n/messages";
import { SlideAspectRatioContext, slideFormat } from "../../../slideFormat";

interface DeckPreviewCanvasProps {
  t: Messages;
  pageId: string | number;
  children: ReactNode;
}

export function DeckPreviewCanvas({ t, pageId, children }: DeckPreviewCanvasProps) {
  const { width, height } = slideFormat(useContext(SlideAspectRatioContext));
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const fitScale = Math.min(viewport.width / width, viewport.height / height);
  const scale = zoom === "fit" ? fitScale : zoom;
  const minScale = Math.min(0.1, fitScale);
  const maxScale = Math.max(2, fitScale);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      // Content-box dimensions exclude padding and scrollbars. Ignore the
      // hidden, retained result page so returning to it preserves its view.
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setViewport({ width, height });
    });
    observer.observe(viewportRef.current!);
    return () => observer.disconnect();
  }, []);

  const fitting = zoom === "fit";
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = 0;
    viewport.scrollLeft = 0;
  }, [pageId, fitting]);

  function stepZoom(direction: -1 | 1) {
    setZoom(Math.min(maxScale, Math.max(minScale, Math.round((scale + direction * 0.1) * 1000) / 1000)));
  }

  return (
    <div className="deck-result-canvas">
      <div className="deck-preview-zoom" role="group" aria-label={t.deck.previewZoom}>
        <button type="button" data-performance-id="deck.zoom.fit" aria-pressed={fitting}
          onClick={() => setZoom("fit")}>{t.deck.fitWindow}</button>
        <button type="button" data-performance-id="deck.zoom.out" title={t.deck.zoomOut}
          aria-label={t.deck.zoomOut} disabled={!fitScale || scale <= minScale}
          onClick={() => stepZoom(-1)}><ZoomOut size={16} aria-hidden="true" /></button>
        <span aria-live="polite" aria-atomic="true">{scale ? `${Math.round(scale * 100)}%` : "—"}</span>
        <button type="button" data-performance-id="deck.zoom.in" title={t.deck.zoomIn}
          aria-label={t.deck.zoomIn} disabled={!fitScale || scale >= maxScale}
          onClick={() => stepZoom(1)}><ZoomIn size={16} aria-hidden="true" /></button>
      </div>
      <div ref={viewportRef} className="deck-preview-viewport" tabIndex={0} role="region" aria-label={t.controls.preview}>
        <div className="deck-preview-scaled-page" style={{ width: width * scale, height: height * scale }}>
          {children}
        </div>
      </div>
    </div>
  );
}
