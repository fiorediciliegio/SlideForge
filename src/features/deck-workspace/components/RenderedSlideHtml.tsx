import { memo, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPptBackend } from "../../../api/pptBackend";
import type { Messages } from "../../../i18n/messages";
import { loadCachedPageHtml, previewHtmlUsableUntil } from "../pageHtmlPreviewCache";
import { buildPagePreviewDocument } from "../pageHtmlPreviewDocument";
import { emptyRenderedPageSession, pageFrameIsVisible, reduceRenderedPageSession, type RenderedPageAction, type RenderedPageEntry } from "../renderedPageSession";
import { pagePreviewKey, planPagePreviewWork, prioritizePagePreviews, type PagePreviewSource } from "../pagePreviewWork";
import { SlidePreviewLoading } from "./SlidePreviewLoading";
import { isPageRecoveryEligible, loadPagePreviewWithRecovery, reportPreviewRecovery } from "../previewRecovery";
import { setPagePreviewUnavailable } from "../previewAvailability";
import { PageRecoveryNotice } from "./PageRecoveryNotice";
import type { RestorePageSourceVersionResult } from "../../../api/types";

export interface RenderedSlideHtmlProps {
  batchId?: string;
  candidateId?: string;
  compact?: boolean;
  recoveryEnabled?: boolean;
  preservePreviousPreview?: boolean;
  onPageRestored?: (result: RestorePageSourceVersionResult) => void;
  onSettled?: () => void;
  /** HTML visibility is independent of image/font load completion. */
  onPreviewState?: (state: "loading" | "visible" | "error") => void;
  pages?: PagePreviewSource[];
  workspaceDir: string;
  pageId: string;
  version: string;
  expectedFingerprint?: string;
  title: string;
  t: Messages;
}

export function RenderedSlideHtml(props: RenderedSlideHtmlProps) {
  // Changing Workspace disposes every frame, pending result and visual state.
  return <WorkspaceSlideHtmlSession key={props.workspaceDir} {...props}
    version={props.batchId ? `${props.batchId}:${props.candidateId}:${props.version}` : props.version} />;
}

function WorkspaceSlideHtmlSession(props: RenderedSlideHtmlProps) {
  const host = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const pending = useRef(new Set<string>());
  const frameRecoveries = useRef(new Set<string>());
  const [retrying, setRetrying] = useState<string | null>(null);
  const [preparationStatus, setPreparationStatus] = useState<"queued" | "running" | "ready" | "error" | null>(null);
  const sourceCatalog = useRef(new Map<string, PagePreviewSource>());
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const [settled, setSettled] = useState(0);
  const [session, dispatch] = useReducer(reduceRenderedPageSession, emptyRenderedPageSession);
  const key = pagePreviewKey(props.workspaceDir, props);
  // Metadata refreshes must not restart a preview queue when page versions did not change.
  const sourcesJson = JSON.stringify(props.pages ?? [{ pageId: props.pageId, title: props.title,
    version: props.version, expectedFingerprint: props.expectedFingerprint }]);
  const sources = useMemo(() => (JSON.parse(sourcesJson) as PagePreviewSource[])
    .map((page) => ({ ...page, key: pagePreviewKey(props.workspaceDir, page) })), [sourcesJson, props.workspaceDir]);
  const complete = props.pages !== undefined;
  useEffect(() => {
    mounted.current = true;
    const element = host.current!;
    const resize = () => setHostSize({ width: element.clientWidth, height: element.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => { mounted.current = false; observer.disconnect(); };
  }, []);
  useEffect(() => {
    if (complete) sourceCatalog.current.clear();
    for (const source of sources) sourceCatalog.current.set(source.key, source);
    dispatch({ type: "sync", entries: sources, selectedKey: key, complete });
  }, [sources, key, complete]);
  useEffect(() => {
    if (session.selectedKey !== key) return;
    const ordered = prioritizePagePreviews(sources, key);
    const orderedKeys = [...new Set([...ordered.map((page) => page.key), ...session.entries.map((entry) => entry.key)])]
      .filter((entryKey) => sourceCatalog.current.has(entryKey));
    const work = planPagePreviewWork(session, orderedKeys, pending.current.size);
    for (const entry of work.defer) dispatch({ type: "deferred", key: entry.key });
    for (const entry of work.render) dispatch({ type: "prepared", key: entry.key, html: entry.html! });
    for (const entry of work.fetch) {
      if (pending.current.has(entry.key)) continue;
      const input = sourceCatalog.current.get(entry.key)!;
      pending.current.add(entry.key);
      dispatch({ type: "loading", key: entry.key });
      void loadCachedPageHtml(entry.key, async () => {
        const backend = await createPptBackend();
        return loadPagePreviewWithRecovery(backend, { workspace_dir: props.workspaceDir, page_id: input.pageId || undefined, batch_id: props.batchId, candidate_id: props.candidateId,
          expected_preview_fingerprint: input.expectedFingerprint }, { priority: input.pageId === props.pageId ? "foreground" : "background",
          onPreparationStatus: (status) => {
          if (mounted.current && input.pageId === props.pageId) setPreparationStatus(status);
        } });
      }).then((value) => {
        if (mounted.current) dispatch({ type: "downloaded", key: entry.key, html: value.html,
          expiresAt: previewHtmlUsableUntil(value) });
      }).catch((error) => {
        if (mounted.current) dispatch({ type: "error", key: entry.key,
          recoveryEligible: isPageRecoveryEligible(error) });
      }).finally(() => {
        pending.current.delete(entry.key);
        // Even a discarded old-version response must release its request slot.
        if (mounted.current) setSettled((value) => value + 1);
      });
    }
  }, [session, sources, key, props.workspaceDir, settled]);
  const selected = session.entries.find((entry) => entry.key === key);
  const retained = props.preservePreviousPreview !== false && !props.batchId
    ? session.entries.find((entry) => entry.pageId === props.pageId && entry.key !== key && pageFrameIsVisible(entry))
    : undefined;
  const visibleKey = pageFrameIsVisible(selected) ? key : selected?.status === "error" ? "" : retained?.key ?? "";
  const visible = session.entries.find((entry) => entry.key === visibleKey);
  const previewState = pageFrameIsVisible(selected) ? "visible" : selected?.status === "error" ? "error" : "loading";
  useEffect(() => { props.onPreviewState?.(previewState); }, [previewState, props.onPreviewState]);
  useEffect(() => {
    if (!props.batchId && !props.compact && props.recoveryEnabled !== false && selected) {
      setPagePreviewUnavailable(props.workspaceDir, props.pageId, !pageFrameIsVisible(selected));
    }
  }, [props.workspaceDir, props.pageId, props.batchId, props.compact, props.recoveryEnabled, selected?.status]);
  const retryPreview = () => {
    if (retrying === key) return;
    const retryKey = key;
    setRetrying(retryKey);
    void loadCachedPageHtml(retryKey, async () => {
      const backend = await createPptBackend();
      const value = await loadPagePreviewWithRecovery(backend, { workspace_dir: props.workspaceDir,
        page_id: props.pageId, batch_id: props.batchId, candidate_id: props.candidateId,
        expected_preview_fingerprint: props.batchId ? props.expectedFingerprint : undefined },
      { onPreparationStatus: (status) => { if (mounted.current) setPreparationStatus(status); } });
      if (!value.fallback && !props.batchId) reportPreviewRecovery(backend, { workspaceDir: props.workspaceDir,
        pageId: props.pageId, event: "preview.recovered", errorKind: "unknown", source: "current",
        requestedFingerprint: props.expectedFingerprint, actualFingerprint: value.preview_source_fingerprint });
      return value;
    }, true).then((value) => {
      if (mounted.current) dispatch({ type: "replaced", key: retryKey, html: value.html,
        expiresAt: previewHtmlUsableUntil(value) });
    }).catch((error) => { if (mounted.current) dispatch({ type: "error", key: retryKey,
      recoveryEligible: isPageRecoveryEligible(error) }); })
      .finally(() => { if (mounted.current) setRetrying((current) => current === retryKey ? null : current); });
  };
  useEffect(() => {
    if (selected?.status !== "error" || !selected.frameFailed || frameRecoveries.current.has(key)) return;
    frameRecoveries.current.add(key);
    retryPreview();
  }, [key, selected?.status, selected?.frameFailed]);
  useEffect(() => {
    if (selected?.status === "ready" || selected?.status === "error") props.onSettled?.();
  }, [selected?.status, props.onSettled]);
  // Mounting exposes the document progressively; load only settles its queue slot.
  const loading = !visible && selected?.status !== "error";
  return (
    <div ref={host} className="static-html-preview" aria-label={props.title} aria-busy={loading}>
      {session.entries.filter((entry) => entry.status === "prepared" || entry.status === "ready").map((entry) => (
        <PreparedSlideFrame key={entry.key} entry={entry} visible={entry.key === visibleKey} hostSize={hostSize} dispatch={dispatch} />
      ))}
      {selected?.status === "error" && !visible && selected.recoveryEligible && !props.batchId && !props.compact && props.recoveryEnabled !== false
        && retrying !== key && (!selected.frameFailed || frameRecoveries.current.has(key)) ? (
        <PageRecoveryNotice key={key} workspaceDir={props.workspaceDir} pageId={props.pageId} versionKey={key}
          title={props.title} t={props.t} retry={retryPreview} retrying={retrying === key}
          onRestored={(result) => {
            props.onPageRestored?.(result);
            if (mounted.current && !props.onPageRestored) retryPreview();
          }} />
      ) : selected?.status === "error" && !visible ? (
        <div className="static-html-preview-overlay static-html-preview-error" role="alert">
          <span>{props.t.review.previewFailed}</span>
          {!props.compact && <button type="button" className="secondary-btn" onClick={(event) => {
            event.stopPropagation();
            retryPreview();
          }} disabled={retrying === key}>{retrying === key ? props.t.review.previewRecovering : props.t.review.previewRetry}</button>}
        </div>
      ) : loading ? <div className="static-html-preview-overlay"><SlidePreviewLoading
        label={preparationStatus === "running" ? props.t.review.rendering : props.t.review.previewLoading}
        compact={props.compact} /></div> : null}
    </div>
  );
}

const PreparedSlideFrame = memo(function PreparedSlideFrame({ entry, visible, hostSize, dispatch }: {
  entry: RenderedPageEntry;
  visible: boolean;
  hostSize: { width: number; height: number };
  dispatch: (action: RenderedPageAction) => void;
}) {
  useEffect(() => {
    if (entry.status !== "prepared") return;
    // A stalled document must not occupy one of the preparation slots forever.
    const timeout = window.setTimeout(() => dispatch({ type: "error", key: entry.key, frameFailed: true }), 30_000);
    return () => window.clearTimeout(timeout);
  }, [entry.key, entry.status, dispatch]);
  const { width, height, html } = useMemo(() => buildPagePreviewDocument(entry.html ?? ""), [entry.html]);
  const scale = Math.min(hostSize.width / width, hostSize.height / height);
  return <iframe title={entry.title} sandbox="" referrerPolicy="no-referrer" srcDoc={html}
    aria-hidden={!visible} tabIndex={-1}
    onLoad={() => dispatch({ type: "ready", key: entry.key })}
    onError={() => dispatch({ type: "error", key: entry.key, frameFailed: true })}
    style={{ width, height, transform: `translate(-50%, -50%) scale(${scale || 1})`,
      display: visible || entry.status === "prepared" ? "block" : "none",
      visibility: visible ? "visible" : "hidden" }} />;
});
