import { invokeTimeoutSummary } from "../deck-workspace/userFacingError";
import { useEffect, useRef, useState } from "react";
import { Check, Search } from "lucide-react";
import type { Messages } from "../../i18n/messages";
import type { PageImageSearchResult, PageImageSearchTask } from "../../api/pageImageSearchTypes";
import { ProcessStepView } from "../process-progress/ProcessProgress";
import { OutlineImageThumbnail, type PreviewLoader } from "../deck-workspace/components/OutlineImagePreview";
import type { OutlineImageAsset } from "../outline/images";
import type { PageImageSearchInput, PageImageSearchService } from "./service";

/** 内嵌到共用配图窗口；搜索不负责导入或应用页面选择。 */
export function PageImageSearchPanel(props: {
  service: PageImageSearchService | null;
  context: Omit<PageImageSearchInput, "opinion">;
  t: Messages;
  disabled?: boolean;
  loadPreview: PreviewLoader;
  resolveImage: (result: PageImageSearchResult) => OutlineImageAsset;
  isSelected: (image: OutlineImageAsset) => boolean;
  isFailed: (image: OutlineImageAsset) => boolean;
  onToggle: (image: OutlineImageAsset) => void;
  onResults: (results: PageImageSearchResult[]) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = props.t.pageImageSearch;
  const [query, setQuery] = useState("");
  const [task, setTask] = useState<PageImageSearchTask | null>(null);
  const [history, setHistory] = useState<PageImageSearchTask[]>([]);
  const [executing, setExecuting] = useState(false);
  const [timing, setTiming] = useState<{ startedAt?: number; endedAt?: number }>({});
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const starting = useRef(false);
  const ownedTask = useRef<string>();
  const callbacks = useRef(props);
  callbacks.current = props;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (starting.current && ownedTask.current) callbacks.current.service?.cancel(ownedTask.current);
    };
  }, []);
  const running = executing || task?.status === "running";
  const busy = running || props.disabled;

  async function run() {
    if (!props.service || starting.current || busy) return;
    const value = query.trim();
    if (!value) { setError("PAGE_IMAGE_SEARCH_QUERY_REQUIRED"); return; }
    starting.current = true;
    ownedTask.current = undefined;
    callbacks.current.onBusyChange(true);
    setTiming({ startedAt: Date.now() });
    setExecuting(true); setStopping(false); setError(""); setTask(null);
    const receive = (next: PageImageSearchTask) => {
      ownedTask.current = next.id;
      if (!mounted.current) { callbacks.current.service?.cancel(next.id); return; }
      setTask(next);
      if (next.status !== "running") {
        // 仅保留本次窗口操作的最近搜索，不恢复或续跑历史任务。
        setHistory((current) => [...current.filter((item) => item.id !== next.id), next].slice(-5));
        callbacks.current.onResults(next.results ?? []);
      }
    };
    try {
      receive(await props.service.run({ ...props.context, opinion: value }, null, receive));
    } catch (err) {
      if (mounted.current) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setTask((current) => current ? { ...current, status: "failed", error: message } : null);
      }
    } finally {
      starting.current = false;
      if (mounted.current) {
        setTiming((current) => ({ ...current, endedAt: Date.now() }));
        setExecuting(false); setStopping(false);
        callbacks.current.onBusyChange(false);
      }
    }
  }

  const results = task?.results ?? [];
  const taskError = task?.error === "PAGE_IMAGE_SEARCH_CANDIDATES_SKIPPED" ? "" : task?.error;
  const visibleError = error || taskError;
  const state = running ? "running" : task?.status === "failed" ? "failed"
    : task?.status === "cancelled" || taskError ? "warning" : "completed";
  return <div className="page-image-search-body">
    <label>{t.query}<textarea rows={2} placeholder={t.placeholder} value={query} disabled={busy || !props.service}
      onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="page-image-search-actions">
      <button type="button" className="primary-btn" disabled={busy || !props.service} onClick={() => void run()}>
        <Search size={15} />{history.length || task ? t.newSearch : t.start}</button>
      {running ? <button type="button" className="secondary-btn" disabled={stopping}
        onClick={() => { setStopping(true); props.service?.cancel(ownedTask.current); }}>
        {stopping ? t.stopping : t.cancel}</button> : null}
    </div>
    {!props.service ? <p className="outline-images-empty">{t.unavailable}</p> : null}
    {history.length ? <div className="page-image-search-history" role="group" aria-label={t.recentSearches}>
      <span>{t.recentSearches}</span>{history.map((item) => <button type="button" key={item.id} disabled={busy}
        aria-pressed={task?.id === item.id} onClick={() => {
          setTask(item); setQuery(item.context.opinion); setError(""); setTiming({});
        }}>{item.context.opinion}</button>)}
    </div> : null}
    {running ? <p className="outline-image-picker-hint">{t.fetching}</p> : null}
    {task || executing ? <div className="process-timeline" role="region" aria-label={t.title}>
      <ProcessStepView t={props.t} step={{ id: "page-image-search", label: t.title, state, ...timing,
        summary: running ? t.running : task ? t[task.status] : undefined }} />
    </div> : null}
    {visibleError ? <div role="alert" className="page-image-search-error">
      <p>{invokeTimeoutSummary(props.t, visibleError, error === "PAGE_IMAGE_SEARCH_QUERY_REQUIRED" ? t.queryRequired
        : visibleError.includes("PAGE_IMAGE_SEARCH_BUSY") ? t.busy : t.error)}</p>
      <details><summary>{t.details}</summary>{visibleError}</details>
    </div> : null}
    {results.length ? <>
      <p className="outline-image-picker-hint">{t.resultsCount.replace("{count}", String(results.length))}</p>
      <div className="outline-image-library page-image-search-results">{results.map((result) => {
        const image = props.resolveImage(result);
        const checked = props.isSelected(image);
        return <article key={result.result_id} className={`outline-image-option ${checked ? "is-selected" : ""}`}>
          <OutlineImageThumbnail asset={image} t={props.t} load={props.loadPreview} />
          <button type="button" className="outline-image-select" aria-pressed={checked} disabled={busy}
            onClick={() => props.onToggle(image)}>
            <span className="outline-image-check" aria-hidden="true">{checked ? <Check size={15} /> : null}</span>
            <span className="outline-image-caption"><strong>{image.title || props.t.outline.imageUnnamed}</strong>
              <span>{result.source_url}</span>
              {props.isFailed(image) ? <small role="alert">{props.t.outline.imageFileFailed}</small> : null}</span>
          </button>
        </article>;
      })}</div>
    </> : task && !running ? <p className="outline-images-empty">{t.empty}</p> : null}
  </div>;
}
