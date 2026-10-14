import { AlertCircle, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPptBackend } from "../../../api/pptBackend";
import type { PageThumbnail } from "../../../api/pageThumbnail";
import { loadCachedPageThumbnail } from "../pageThumbnailCache";
import { pagePreviewKey } from "../pagePreviewWork";
import type { RenderedSlideHtmlProps } from "./RenderedSlideHtml";
import { SlidePreviewLoading } from "./SlidePreviewLoading";
import { RenderedSlideHtml } from "./RenderedSlideHtml";
import { classifyPreviewError, waitForPagePreviewPreparation, withPreviewDeadline } from "../previewRecovery";

type Props = Pick<RenderedSlideHtmlProps, "workspaceDir" | "pageId" | "version" | "expectedFingerprint" | "title" | "t"> & {
  priority?: "foreground" | "background";
  preservePreview?: boolean;
  refreshEnabled?: boolean;
  /** Undefined keeps viewport-triggered loading; the result rail grants bounded work explicitly. */
  loadEnabled?: boolean;
  preloadPriority?: number;
  onSettled?: () => void;
};
export function SlideThumbnail(props: Props) {
  return <Thumbnail key={props.preservePreview ? JSON.stringify([props.workspaceDir, props.pageId]) : pagePreviewKey(props.workspaceDir, props)} {...props} />;
}
function Thumbnail(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [requested, setRequested] = useState(false);
  const key = pagePreviewKey(props.workspaceDir, props);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [result, setResult] = useState<{ key: string; value: PageThumbnail } | null>(null);
  const [displayed, setDisplayed] = useState<{ key: string; value: PageThumbnail } | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState({ key, attempt: 0 });
  const attempt = retry.key === key ? retry.attempt : 0;
  const currentAttempt = useRef(attempt);
  currentAttempt.current = attempt;
  const mounted = useRef(true);
  const priority = useRef(props.priority);
  priority.current = props.priority;
  const preloadPriority = useRef(props.preloadPriority);
  preloadPriority.current = props.preloadPriority;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const previousPriority = useRef(props.priority);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setRequested(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const previous = previousPriority.current;
    previousPriority.current = props.priority;
    if ((!requested && !props.loadEnabled) || previous !== "background" || props.priority !== "foreground" || !props.pageId) return;
    void createPptBackend().then((backend) => backend.prepareWorkspacePagePreview({
      workspace_dir: props.workspaceDir, page_id: props.pageId, priority: "foreground", kind: "thumbnail",
    })).catch(() => undefined);
  }, [requested, props.loadEnabled, props.priority, props.workspaceDir, props.pageId]);
  const enabled = props.loadEnabled ?? requested;
  useEffect(() => {
    if (!enabled || props.refreshEnabled === false) return;
    let current = true;
    setFailed(false);
    void loadCachedPageThumbnail(pagePreviewKey(props.workspaceDir, props), async () => {
      const backend = await createPptBackend();
      try {
        if (props.pageId) await waitForPagePreviewPreparation(backend, { workspace_dir: props.workspaceDir,
          page_id: props.pageId, priority: priority.current ?? "background", kind: "thumbnail", retry: attempt > 0 });
        return await withPreviewDeadline(backend.getWorkspacePageThumbnail({ workspace_dir: props.workspaceDir, page_id: props.pageId || undefined,
          expected_preview_fingerprint: props.expectedFingerprint }));
      } catch (error) {
        if (classifyPreviewError(error) !== "version_changed") throw error;
        if (props.pageId) await waitForPagePreviewPreparation(backend, { workspace_dir: props.workspaceDir,
          page_id: props.pageId, priority: priority.current ?? "background", kind: "thumbnail" });
        return withPreviewDeadline(backend.getWorkspacePageThumbnail({ workspace_dir: props.workspaceDir, page_id: props.pageId || undefined }));
      }
    }, attempt > 0, () => preloadPriority.current ?? 0).then((value) => { if (current) setResult({ key, value }); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [enabled, attempt, props.workspaceDir, props.pageId, props.version, props.expectedFingerprint, props.refreshEnabled]);
  const imageFailed = (imageKey = key) => {
    if (!mounted.current || currentKey.current !== imageKey || imageKey !== key || currentAttempt.current !== attempt) return;
    if (attempt === 0) { setResult(null); setRetry({ key, attempt: 1 }); } else setFailed(true);
  };
  useEffect(() => {
    if (!result || result.key !== key || result === displayed || failed) return;
    // A stalled download/decode must release the result rail's preparation slot.
    const timer = window.setTimeout(imageFailed, 30_000);
    return () => window.clearTimeout(timer);
  }, [result, displayed, failed, key, attempt]);
  useEffect(() => {
    if (displayed?.key === key || failed) props.onSettled?.();
  }, [displayed, failed, key, props.onSettled]);
  const updating = props.preservePreview && displayed && (displayed.key !== key || props.refreshEnabled === false || failed);
  return <div ref={host} className="slide-thumbnail" role="img" aria-label={props.title}>
    {displayed ? <img src={displayed.value.image_url} alt={props.title} decoding="async" /> : null}
    {result && result !== displayed ? <img key={result.key} src={result.value.image_url} alt="" aria-hidden="true"
      className="slide-thumbnail-incoming" decoding="async"
      loading="eager"
      onLoad={(event) => {
        const image = event.currentTarget;
        void withPreviewDeadline(typeof image.decode === "function" ? image.decode() : Promise.resolve()).then(() => {
          if (mounted.current && currentKey.current === result.key && currentAttempt.current === attempt) setDisplayed(result);
        }, () => imageFailed(result.key));
      }}
      onError={() => imageFailed(result.key)} /> : null}
    {!displayed ? failed ? requested || props.priority === "foreground" ? <RenderedSlideHtml {...props} compact />
      : <div className="slide-thumbnail-error">{props.t.review.previewFailed}</div>
      : <SlidePreviewLoading label={props.t.review.previewLoading} compact /> : null}
    {updating ? <span className="generation-thumbnail-updating" role="status"
      aria-label={failed ? props.t.review.previewFailed : props.t.generating.preview.updating}
      title={failed ? props.t.review.previewFailed : props.t.generating.preview.updating}>
      {failed ? <AlertCircle size={12} /> : <LoaderCircle className="generation-running-icon" size={12} />}
    </span> : null}
  </div>;
}
