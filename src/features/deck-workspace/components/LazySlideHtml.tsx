import { useCallback, useEffect, useRef, useState } from "react";
import { queuePreviewPreparation } from "../previewPreparationQueue";
import { RenderedSlideHtml, type RenderedSlideHtmlProps } from "./RenderedSlideHtml";
import { SlidePreviewLoading } from "./SlidePreviewLoading";

/** Load on first approach; retain the actual iframe until this page/session unmounts. */
export function LazySlideHtml(props: RenderedSlideHtmlProps) {
  return <VisibleSlide key={JSON.stringify([props.workspaceDir, props.pageId, props.batchId, props.candidateId, props.version, props.expectedFingerprint])} {...props} />;
}

function VisibleSlide(props: RenderedSlideHtmlProps) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const release = useRef<(() => void) | undefined>();
  const settled = useCallback(() => { release.current?.(); release.current = undefined; }, []);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const cancel = queuePreviewPreparation((done) => { release.current = done; setEnabled(true); });
    return () => { cancel(); settled(); setEnabled(false); };
  }, [visible, settled]);
  return <div ref={host} className="lazy-slide-html" role="img" aria-label={props.title}>
    {enabled ? <RenderedSlideHtml {...props} compact onSettled={settled} /> : <SlidePreviewLoading label={props.t.review.previewLoading} compact />}
  </div>;
}
