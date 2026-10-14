import { SlideThumbnail } from "./SlideThumbnail";
import { RenderedSlideHtml } from "./RenderedSlideHtml";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveHtmlPagePreview } from "./LiveHtmlPagePreview";
import { formatMessage, type Messages } from "../../../i18n/messages";
import type { DeckGenerationProgressPage, DeckGenerationStream } from "../../deck-generation";
import {
  isRenderedSnapshotCurrent,
  orderGenerationPagePreviews,
  resolveGenerationPreviewSelection,
  type GenerationPagePreviewEntry,
  type GenerationPagePreviews,
} from "../generationPagePreviews";

interface GenerationPagePreviewPanelProps {
  workspaceDir: string;
  t: Messages;
  previews: GenerationPagePreviews;
  pinnedPageId: string | null;
  onSelectPage: (pageId: string | null) => void;
  activePageIndex?: number | null;
  activeStreams?: readonly DeckGenerationStream[];
  pageProgress?: readonly DeckGenerationProgressPage[];
}

export function GenerationPagePreviewPanel(props: GenerationPagePreviewPanelProps) {
  const { t, previews, pinnedPageId, onSelectPage, activePageIndex, activeStreams, pageProgress } = props;
  const entries = useMemo(() => orderGenerationPagePreviews(previews), [previews]);
  const [automaticPageId, setAutomaticPageId] = useState<string | null>(null);

  // Start on page one. Other pages continue to receive their HTML updates in
  // the background, but the display does not move until its current page is
  // accepted. This makes parallel generation observable without a flickering
  // "last event wins" preview. A manual thumbnail selection remains pinned.
  useEffect(() => {
    if (pinnedPageId) return;
    setAutomaticPageId((current) => {
      const firstPageId = entries[0]?.pageId ?? null;
      const currentPageId = entries.some((entry) => entry.pageId === current) ? current : firstPageId;
      if (!currentPageId) return null;
      const currentPage = pageProgress?.find((page) => page.page_id === currentPageId);
      if (currentPage?.status !== "accepted") return currentPageId;
      const currentIndex = entries.find((entry) => entry.pageId === currentPageId)?.pageIndex ?? -1;
      const nextLivePage = (activeStreams ?? [])
        .filter((stream) => (stream.kind === "page-html" || stream.kind === "page-layout-check" || stream.kind === "page-layout-rewrite") && stream.preview_html && stream.page_index > currentIndex)
        .sort((left, right) => left.page_index - right.page_index)[0];
      return nextLivePage?.page_id ?? currentPageId;
    });
  }, [activeStreams, entries, pageProgress, pinnedPageId]);

  const displayedAutomaticPageId = automaticPageId ?? entries[0]?.pageId ?? null;
  const automaticPageIndex = displayedAutomaticPageId
    ? entries.find((entry) => entry.pageId === displayedAutomaticPageId)?.pageIndex
    : undefined;
  const selected = resolveGenerationPreviewSelection({
    entries,
    pinnedPageId,
    activePageIndex: automaticPageIndex ?? activePageIndex,
  });
  const followingLatest = !pinnedPageId;
  const liveHtml = selected
    ? activeStreams?.find((stream) => stream.page_id === selected.pageId && stream.preview_html)?.preview_html
    : undefined;

  return (
    <section className="generation-preview-panel" aria-label={t.generating.preview.title}>
      <div className="generation-preview-header">
        <div>
          <div className="section-label">{t.generating.preview.title}</div>
          {/* No page yet: the stage below already carries the loading status, so
              leaving the heading empty keeps that message on screen only once. */}
          <strong>{selected ? pageHeading(t, selected) : null}</strong>
        </div>
        {entries.length > 0 ? (
          followingLatest ? (
            <span className="generation-preview-follow-hint">{t.generating.preview.followingLatest}</span>
          ) : (
            <button
              className="generation-preview-follow-btn"
              type="button"
              onClick={() => onSelectPage(null)}
            >
              {t.generating.preview.backToLatest}
            </button>
          )
        ) : null}
      </div>

      <GenerationPreviewStage
        key={JSON.stringify([props.workspaceDir, selected?.pageId])}
        workspaceDir={props.workspaceDir} t={t} entry={selected} liveHtml={liveHtml}
        accepted={pageProgress?.find((page) => page.page_id === selected?.pageId)?.status === "accepted"}
      />

      {entries.length > 0 ? (
        <div
          className="generation-preview-thumbnails"
          role="tablist"
          aria-label={t.generating.preview.thumbnails}
        >
          {entries.map((entry) => {
            const active = entry.pageId === selected?.pageId;
            const className = ["generation-preview-thumbnail", entry.status]
              .concat(entry.notApplied ? ["not-applied"] : [])
              .concat(active ? ["active"] : [])
              .join(" ");
            return (
              <button
                key={entry.pageId}
                className={className}
                type="button"
                role="tab"
                aria-selected={active}
                title={entry.notApplied
                  ? `${pageHeading(t, entry)} — ${t.generating.preview.notApplied}`
                  : pageHeading(t, entry)}
                aria-label={formatMessage(t.generating.preview.selectPage, {
                  page: entry.pageIndex + 1,
                })}
                onClick={() => onSelectPage(entry.pageId)}
              >
                <span className="generation-preview-thumbnail-frame">
                  {entry.htmlPath && entry.awaitingRenderFrom === undefined && props.workspaceDir ? (
                    <SlideThumbnail t={t} workspaceDir={props.workspaceDir} pageId={entry.pageId} title={pageHeading(t, entry)} version={entry.snapshotSourceFingerprint ?? entry.renderSourceFingerprint ?? entry.htmlPath}
                      preservePreview refreshEnabled={entry.status === "ready" && isRenderedSnapshotCurrent(entry)} />
                  ) : entry.status === "error" ? (
                    <AlertCircle size={14} aria-hidden="true" />
                  ) : (
                    <LoaderCircle className="generation-running-icon" size={14} aria-hidden="true" />
                  )}
                </span>
                <span className="generation-preview-thumbnail-index">{entry.pageIndex + 1}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}


function GenerationPreviewStage({ workspaceDir, t, entry, liveHtml, accepted }: {
  workspaceDir: string;
  t: Messages;
  entry: GenerationPagePreviewEntry | null;
  liveHtml?: string;
  accepted: boolean;
}) {
  // This component is scoped to a workspace/page. A previous page must never
  // masquerade as the newly selected page while its resources are loading.
  const live = useRef<string>();
  if (liveHtml) live.current = liveHtml;
  const snapshot = useRef<{ version: string; pageId: string; title: string }>();
  if (entry?.htmlPath && entry.awaitingRenderFrom === undefined && isRenderedSnapshotCurrent(entry)) {
    snapshot.current = { version: entry.snapshotSourceFingerprint ?? entry.renderSourceFingerprint ?? entry.htmlPath,
      pageId: entry.pageId, title: pageHeading(t, entry) };
  }
  const source = snapshot.current;
  const [staticState, setStaticState] = useState<{ version?: string; state: "loading" | "visible" | "error" }>();
  const version = source?.version;
  const onPreviewState = useCallback((state: "loading" | "visible" | "error") => {
    setStaticState({ version, state });
  }, [version]);
  const currentState = staticState?.version === version ? staticState?.state : "loading";
  const showLive = Boolean(live.current && (!accepted || (currentState !== "visible" && currentState !== "error")));
  const requestedVersion = entry?.snapshotSourceFingerprint ?? entry?.renderSourceFingerprint ?? entry?.htmlPath;
  const replacingSnapshot = source && entry && (currentState === "loading"
    || !isRenderedSnapshotCurrent(entry) || source.version !== requestedVersion);
  const updating = Boolean(entry && !entry.notApplied && (showLive || replacingSnapshot));

  return <div className="generation-preview-stage">
    {source && workspaceDir ? <div className="generation-preview-layer" aria-hidden={showLive}
      style={{ visibility: showLive ? "hidden" : "visible", opacity: showLive ? 0 : 1 }}>
      <RenderedSlideHtml recoveryEnabled={false} t={t} workspaceDir={workspaceDir}
        pageId={source.pageId} title={entry ? pageHeading(t, entry) : source.title} version={source.version}
        onPreviewState={onPreviewState} />
    </div> : null}
    {live.current ? <div className="generation-preview-layer" aria-hidden={!showLive}
      style={{ visibility: showLive ? "visible" : "hidden", opacity: showLive ? 1 : 0 }}>
      <LiveHtmlPagePreview html={live.current} title={entry ? pageHeading(t, entry) : t.generating.preview.title} />
    </div> : null}
    {!showLive && !source ? <div className="generation-preview-placeholder" role="status">
      {entry?.status === "error" ? <AlertCircle size={20} aria-hidden="true" />
        : <LoaderCircle className="generation-running-icon" size={20} aria-hidden="true" />}
      <span>{entry?.status === "error" ? t.generating.preview.failed : t.generating.preview.loading}</span>
    </div> : null}
    {updating ? <span className="generation-preview-updating" role="status">{t.generating.preview.updating}</span> : null}
    {entry?.notApplied ? <span className="generation-preview-not-applied">{t.generating.preview.notApplied}</span> : null}
  </div>;
}

function pageHeading(t: Messages, entry: GenerationPagePreviewEntry) {
  const title = entry.title.trim() || t.generating.preview.untitledPage;
  return `${entry.pageIndex + 1}. ${title}`;
}
