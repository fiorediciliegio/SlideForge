import { ChevronRight, Globe, ImageOff, Search } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ResearchDiscoveryProgressPhaseRecord, ResearchDiscoveryProgressVisualAsset } from "../../api/types";
import { formatMessage, type Messages } from "../../i18n/messages";
import { LiveText, SourceLink, ProcessDisclosure } from "./ProcessProgress";
import { safeExternalUrl, streamedResearchReport } from "./model";

export function ResearchDetails({ t, record }: { t: Messages; record: ResearchDiscoveryProgressPhaseRecord }) {
  const latest = record.liveRounds?.at(-1);
  const liveReport = latest ? streamedResearchReport(latest.text) : undefined;
  const report = record.report || liveReport;
  const isDecision = record.phase.endsWith("-decision");

  return <div className="process-research-details">
    {isDecision && record.rationale ? <p className="process-empty">{record.rationale}</p> : null}
    {record.queries?.map((query) => <ResearchActivity key={`${query.kind}-${query.query}`}
      icon={<Search size={15} aria-hidden="true" />}
      label={formatMessage(t.processProgress.searchQuery, { query: query.query })}
      meta={query.status === "running" ? t.processProgress.running : formatMessage(
        query.kind === "visual" ? t.processProgress.images : t.processProgress.results,
        { count: query.resultCount ?? 0 },
      )}>
      {query.sources?.length ? <div className="process-sources">{query.sources.map((source, i) => <div key={`${source.url}-${i}`}>
        <SourceLink url={source.url}>{source.title || source.url || t.processProgress.source}</SourceLink>
        <small>{hostname(source.url)}</small>{source.snippet ? <p>{source.snippet}</p> : null}
      </div>)}</div> : null}
      {query.images?.length ? <div className="process-image-grid">{query.images.map((asset) => <ResearchImage key={asset.id} t={t} asset={asset} />)}</div> : null}
      {!query.sources?.length && !query.images?.length ? <p className="process-empty">{query.status === "running" ? t.processProgress.waitingOutput : formatMessage(query.kind === "visual" ? t.processProgress.images : t.processProgress.results, { count: 0 })}</p> : null}
    </ResearchActivity>)}
    {record.fetchedPages?.map((page, index) => <ResearchActivity key={`${page.url}-${index}`}
      icon={<Globe size={15} aria-hidden="true" />}
      label={formatMessage(t.processProgress.fetchPage, { page: page.title || hostname(page.url) || page.url })}
      meta={page.pending && record.state === "running" ? t.processProgress.running : undefined}>
      <SourceLink url={page.final_url || page.url}>{t.processProgress.source}</SourceLink>
      {page.truncated ? <p className="process-empty">{t.processProgress.truncated}</p> : null}
      {page.content ? <div className="process-page-content">{page.content}</div> : <p className="process-empty">
        {page.pending && record.state === "running" ? t.processProgress.waitingPage : t.processProgress.noPageContent}
      </p>}
    </ResearchActivity>)}
    {report !== undefined ? <section className="process-research-report" aria-label={t.processProgress.report}>
      <h4>{t.processProgress.report}</h4>
      <LiveText t={t} text={report} report running={latest?.state === "running" && !record.report} />
    </section> : null}
  </div>;
}

function ResearchActivity({ icon, label, meta, children }: {
  icon: ReactNode; label: string; meta?: string; children: ReactNode;
}) {
  return <ProcessDisclosure className="process-research-activity">
    <summary>
      {icon}<span className="process-activity-label">{label}</span>
      {meta ? <small>{meta}</small> : null}
      <ChevronRight size={14} className="process-activity-chevron" aria-hidden="true" />
    </summary>
    <div className="process-activity-content">{children}</div>
  </ProcessDisclosure>;
}

function hostname(url?: string) {
  try { return url ? new URL(url).hostname : ""; } catch { return ""; }
}

function ResearchImage({ t, asset }: { t: Messages; asset: ResearchDiscoveryProgressVisualAsset }) {
  const thumbnail = safeExternalUrl(asset.thumbnailUrl) || safeExternalUrl(asset.imageUrl);
  const original = safeExternalUrl(asset.imageUrl) || thumbnail;
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState(false);
  const [originalFailed, setOriginalFailed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { setFailed(false); setOriginalFailed(false); }, [thumbnail, original]);
  useEffect(() => { if (preview && !dialog.current?.open) dialog.current?.showModal(); }, [preview]);

  return <div className="process-image">
    <button type="button" className="process-image-preview" aria-label={`${t.processProgress.preview}: ${asset.title || t.processProgress.image}`}
      aria-haspopup="dialog" onClick={() => { setOriginalFailed(false); setPreview(true); }}>
      {thumbnail && !failed ? <img src={thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <ImageOff size={24} aria-hidden="true" />}
    </button>
    {preview ? <dialog className="process-image-dialog" ref={dialog} aria-labelledby={titleId}
      onClose={() => setPreview(false)} onClick={(event) => { if (event.target === dialog.current) dialog.current.close(); }}>
      <button type="button" autoFocus onClick={() => dialog.current?.close()}>{t.processProgress.closePreview}</button>
      {!original || originalFailed ? <p>{t.processProgress.imageFailed}</p> : <img src={original} alt={asset.title || asset.visualSummary || ""} referrerPolicy="no-referrer" onError={() => setOriginalFailed(true)} />}
      <div className="process-image-info">
        <h4 id={titleId}>{asset.title || t.processProgress.imageDetails}</h4>
        <span>{t.processProgress[asset.state ?? "candidate"]}</span>
        {asset.visualSummary ? <p>{asset.visualSummary}</p> : null}
        {asset.reason ? <p>{asset.reason}</p> : null}
        <SourceLink url={asset.pageUrl}>{t.processProgress.source}</SourceLink>
      </div>
    </dialog> : null}
  </div>;
}
