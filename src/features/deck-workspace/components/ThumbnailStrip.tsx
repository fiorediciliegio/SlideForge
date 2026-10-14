import { useEffect, useRef, useState } from "react";
import type { Slide } from "../../../data/mockDeck";
import type { RenderDeckHtmlResult } from "../../../api/types";
import { formatSlideNumber } from "../utils";
import { SlideThumbnail } from "./SlideThumbnail";
import type { Messages } from "../../../i18n/messages";
import { SlidePreviewLoading } from "./SlidePreviewLoading";
import { pagePreviewKey } from "../pagePreviewWork";
import { prioritizeThumbnailPrefetch, useThumbnailPrefetch } from "../useThumbnailPrefetch";

interface ThumbnailStripProps {
  workspaceDir?: string;
  t: Messages;
  orientation?: "horizontal" | "vertical";
  deck: Slide[];
  currentSlide: number;
  setCurrentSlide: (index: number) => void;
  renderedSlides?: RenderDeckHtmlResult["slides"];
  preloadPages?: boolean;
}

export function ThumbnailStrip(props: ThumbnailStripProps) {
  return <ThumbnailStripSession key={props.workspaceDir ?? ""} {...props} />;
}

function ThumbnailStripSession({
  deck,
  workspaceDir, t,
  currentSlide,
  setCurrentSlide,
  renderedSlides = [],
  orientation = "horizontal",
  preloadPages = false,
}: ThumbnailStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set());
  const pageKeys = deck.map((_, index) => {
    const slide = renderedSlides[index];
    return workspaceDir && slide && (slide.html_path || slide.preview_unavailable) ? pagePreviewKey(workspaceDir, {
      pageId: slide.slide_id, title: slide.title,
      version: slide.preview_version ?? slide.preview_source_fingerprint ?? slide.html_path,
      expectedFingerprint: slide.preview_source_fingerprint,
    }) : undefined;
  });
  const keys = pageKeys.filter((key) => key !== undefined);
  const { work, settle } = useThumbnailPrefetch(keys, pageKeys[currentSlide], visible, preloadPages);
  const priorities = new Map(prioritizeThumbnailPrefetch(keys, pageKeys[currentSlide], visible).map((key, index) => [key, index]));
  const pageKeysJson = JSON.stringify(pageKeys);
  useEffect(() => {
    if (!preloadPages || !stripRef.current) return;
    const keys = JSON.parse(pageKeysJson) as Array<string | null>;
    const elements = new Map([...stripRef.current.querySelectorAll(".thumb")].map((element, index) => [element, keys[index]]));
    const nearby = new Set<string>();
    setVisible(new Set());
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const key = elements.get(entry.target);
        if (!key) continue;
        if (entry.isIntersecting) nearby.add(key); else nearby.delete(key);
      }
      setVisible(new Set(nearby));
    }, { root: stripRef.current, rootMargin: "200px" });
    for (const element of elements.keys()) observer.observe(element);
    return () => observer.disconnect();
  }, [pageKeysJson, preloadPages]);

  useEffect(() => {
    if (orientation !== "vertical") return;
    const strip = stripRef.current;
    if (!strip) return;

    // Scroll only the thumbnail rail, never the surrounding workspace.
    const revealSelection = () => {
      const active = strip.querySelector<HTMLButtonElement>('[aria-current="true"]');
      if (!strip.clientHeight || !active) return;
      const railBounds = strip.getBoundingClientRect();
      const activeBounds = active.getBoundingClientRect();
      if (activeBounds.top < railBounds.top) {
        strip.scrollTop -= railBounds.top - activeBounds.top;
      } else if (activeBounds.bottom > railBounds.bottom) {
        strip.scrollTop += activeBounds.bottom - railBounds.bottom;
      }
    };
    revealSelection();
    const observer = new ResizeObserver(revealSelection);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [currentSlide, deck.length, orientation]);

  return (
    <div ref={stripRef} className={`thumbnail-strip${orientation === "vertical" ? " vertical" : ""}`}>
      {deck.map((slide, index) => {
        const renderedSlide = renderedSlides[index];
        return (
          <button
            data-performance-id="deck.thumbnail.select"
            key={renderedSlide?.slide_id ?? `${slide.title}-${index}`}
            className={`thumb ${index === currentSlide ? "active" : ""}`}
            type="button"
            aria-current={index === currentSlide ? "true" : undefined}
            title={slide.title}
            onClick={() => setCurrentSlide(index)}
          >
          {(renderedSlide?.html_path || renderedSlide?.preview_unavailable) && workspaceDir ? (
            <div className="thumb-html-frame">
              <SlideThumbnail t={t} workspaceDir={workspaceDir} pageId={renderedSlide.slide_id} title={slide.title}
                loadEnabled={preloadPages ? work.has(pageKeys[index]!) : undefined}
                preloadPriority={preloadPages ? priorities.get(pageKeys[index]!) : undefined}
                onSettled={preloadPages ? () => settle(pageKeys[index]!) : undefined}
                priority={index === currentSlide ? "foreground" : "background"}
                version={renderedSlide.preview_version ?? renderedSlide.preview_source_fingerprint ?? renderedSlide.html_path}
                expectedFingerprint={renderedSlide.preview_source_fingerprint} />
            </div>
          ) : (
            <div className="thumb-html-frame">
              <SlidePreviewLoading label={t.review.previewLoading} compact />
            </div>
          )}
          <span>{formatSlideNumber(index)}</span>
          <strong>{slide.title}</strong>
          </button>
        );
      })}
    </div>
  );
}
