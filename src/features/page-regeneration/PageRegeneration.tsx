import { invokeTimeoutSummary } from "../deck-workspace/userFacingError";
import { LazySlideHtml } from "../deck-workspace/components/LazySlideHtml";
import { RenderedSlideHtml } from "../deck-workspace/components/RenderedSlideHtml";
import { OutlinePageImages, OutlineImagePicker } from "../deck-workspace/components/OutlineImages";
import { mergeOutlineImageAssets, type OutlineImageAsset } from "../outline/images";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, CircleAlert, Expand, ImageOff, Layers, LoaderCircle, Minus, Plus, RefreshCw, Sparkles, Wrench, X } from "lucide-react";
import type { Messages } from "../../i18n/messages";
import { formatMessage } from "../../i18n/messages";
import { ConfirmationDialog } from "../deck-workspace/components/ConfirmationDialog";
import type { PageRegenerationModel } from "./usePageRegeneration";
import { editedRegenerationOutline, validAlternativeCount, validRegenerationInput } from "./workflow";
import "./page-regeneration.css";

function ErrorNotice({ model, t }: { model: PageRegenerationModel; t: Messages }) {
  return model.error ? <div className="alternatives-error" role="alert">
    <p>{invokeTimeoutSummary(t, model.detail || model.error, model.error)}</p>
    {model.detail ? <details><summary>{model.text.details}</summary><pre>{model.detail}</pre></details> : null}
  </div> : null;
}

export function PageRegenerationSetupPage({ model, t }: { model: PageRegenerationModel; t: Messages }) {
  const text = model.text;
  const ActionIcon = model.mode === "beautify" ? Wrench : Sparkles;
  const [count, setCount] = useState(model.mode === "beautify" ? "2" : "4");
  const [title, setTitle] = useState(model.outline?.title ?? "");
  const [content, setContent] = useState(model.outline?.content ?? "");
  const [creationRequirements, setCreationRequirements] = useState(model.outline?.creation_requirements ?? "");
  const [imageIds, setImageIds] = useState(model.outline?.selected_image_ids ?? []);
  const [imagePicker, setImagePicker] = useState(false);
  const [images, setImages] = useState<OutlineImageAsset[]>([]);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);
  const [imageRetry, setImageRetry] = useState(0);
  const loadPreview = useMemo(() => {
    const cache = new Map<string, Promise<string>>();
    return (id: string, size: "thumbnail" | "large" = "thumbnail") => {
      const key = `${id}:${size}`;
      let promise = cache.get(key);
      if (!promise) {
        promise = model.loadImagePreview(id, size).then((url) => { if (!url.startsWith("data:")) cache.delete(key); return url; }).catch((error) => { cache.delete(key); throw error; });
        cache.set(key, promise);
      }
      return promise;
    };
  }, [model.loadImagePreview, imageRetry]);
  useEffect(() => {
    if (model.mode === "beautify") return;
    let active = true;
    setImageLoading(true); setImageError(false);
    void model.loadImages().then((assets) => { if (active) setImages(assets); }, () => { if (active) setImageError(true); })
      .finally(() => { if (active) setImageLoading(false); });
    return () => { active = false; };
  }, [model.loadImages, imageRetry, model.mode]);
  if (!model.outline) return null;
  const edited = model.mode === "beautify" ? model.outline : {
    ...editedRegenerationOutline(model.outline, title, content),
    creation_requirements: creationRequirements.trim() ? creationRequirements : undefined,
    selected_image_ids: imageIds,
  };
  const pageIndex = model.outlineItems.findIndex((item) => item.page_id === edited.page_id);
  const pickerOutline = model.outlineItems.map((item, index) => index === pageIndex ? edited : item);
  const numericCount = Number(count);
  const valid = model.mode === "beautify" ? validAlternativeCount(numericCount) : validRegenerationInput(numericCount, edited);
  function stepCount(delta: number) {
    const current = Number.isFinite(numericCount) ? Math.round(numericCount) : 1;
    setCount(String(Math.min(10, Math.max(1, current + delta))));
  }
  return <main className="alternatives-page">
    <form className="alternatives-content alternatives-setup" aria-labelledby="alternatives-config-title"
      onSubmit={(event) => { event.preventDefault(); if (valid && !model.busy) void model.start(numericCount, edited); }}>
      <nav className="alternatives-toolbar" aria-label={text.title}>
        <button type="button" className="secondary-btn deck-back-btn" disabled={model.busy} onClick={model.close}>
          <ArrowLeft size={16} aria-hidden="true" />{text.back}
        </button>
      </nav>
      <header className="alternatives-header">
        <div className="alternatives-icon"><ActionIcon size={22} aria-hidden="true" /></div>
        <div>
          <h1 id="alternatives-config-title">{text.title}</h1>
          <p>{text.configHint}</p>
        </div>
      </header>
      <section className="alternatives-card">
        <h2>{text.settingsSection}</h2>
        <p className="alternatives-settings-hint">{text.settingsHint}</p>
        <div className="alternatives-count-row">
          <div><label htmlFor="alternatives-count">{text.count}</label><p id="alternatives-count-hint">{text.countHint}</p></div>
          <div className="alternatives-stepper">
            <button type="button" aria-label={text.decreaseCount} disabled={model.busy || numericCount <= 1} onClick={() => stepCount(-1)}>
              <Minus size={16} aria-hidden="true" />
            </button>
            <input id="alternatives-count" type="number" min="1" max="10" step="1" required value={count}
              aria-describedby="alternatives-count-hint" disabled={model.busy} onChange={(event) => setCount(event.target.value)} />
            <button type="button" aria-label={text.increaseCount} disabled={model.busy || numericCount >= 10} onClick={() => stepCount(1)}>
              <Plus size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>
      {model.mode !== "beautify" ? <><section className="alternatives-card">
        <h2>{text.contentSection}</h2>
        <p className="alternatives-outline-hint">{text.outlineHint}</p>
        <div className="alternatives-fields">
          <label>{text.pageTitle}<input required value={title} disabled={model.busy} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>{text.outline}<textarea className="alternatives-outline-input" rows={8} required value={content} disabled={model.busy} onChange={(event) => setContent(event.target.value)} /></label>
          <label>{t.outline.pageCreationRequirements}<textarea rows={3} value={creationRequirements} disabled={model.busy}
            placeholder={t.outline.creationRequirementsHint} onChange={(event) => setCreationRequirements(event.target.value)} /></label>
        </div>
      </section>
      <section className="alternatives-card">
        <OutlinePageImages t={t} ids={imageIds} assets={images} busy={model.busy} loading={imageLoading} error={imageError}
          loadPreview={loadPreview} onAdd={() => setImagePicker(true)} onRemove={(id) => setImageIds((ids) => ids.filter((value) => value !== id))}
          onRetry={() => setImageRetry((value) => value + 1)} />
      </section>
      </> : <section className="alternatives-card">
        <h2>{text.contentSection}</h2>
        <p className="alternatives-outline-hint">{text.outlineHint}</p>
        <dl className="alternatives-readonly">
          <div><dt>{text.pageTitle}</dt><dd>{model.outline.title}</dd></div>
          <div><dt>{text.outline}</dt><dd>{model.outline.content}</dd></div>
          {model.globalRequirements.trim() ? <div>
            <dt>{t.outline.globalCreationRequirements}</dt><dd>{model.globalRequirements}</dd>
          </div> : null}
          {model.outline.creation_requirements?.trim() ? <div>
            <dt>{t.outline.pageCreationRequirements}</dt><dd>{model.outline.creation_requirements}</dd>
          </div> : null}
        </dl>
      </section>}
      <ErrorNotice model={model} t={t} />
      <footer className="alternatives-setup-footer">
        <p>{text.originalHint}</p>
        <div>
          <button type="button" className="secondary-btn" disabled={model.busy} onClick={model.close}>{text.cancel}</button>
          <button type="submit" className="primary-btn alternatives-submit" disabled={!valid || model.busy}>
            <ActionIcon size={15} aria-hidden="true" />{text.start}
          </button>
        </div>
      </footer>
    </form>
    {imagePicker && !model.busy && pageIndex >= 0 ? <OutlineImagePicker t={t} pageIndex={pageIndex} outline={pickerOutline} assets={images}
      pageImageSearch={model.pageImageSearch} deckTitle={model.deckTitle} globalRequirements={model.globalRequirements}
      loading={imageLoading} error={imageError} onRetry={() => setImageRetry((value) => value + 1)}
      imageLibrary={model.imageLibrary} imageUpload={model.pageImageUpload} onUploaded={(image) => setImages((current) => mergeOutlineImageAssets(current, [image]))}
      loadPreview={loadPreview} onChange={setImageIds} onClose={() => setImagePicker(false)} /> : null}
  </main>;
}

function ApplyingDialog({ number, model }: { number: number | null; model: PageRegenerationModel }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialogRef.current?.showModal(); }, []);
  const text = model.text;
  return <dialog ref={dialogRef} className="alternatives-applying" aria-labelledby="alternatives-applying-title"
    aria-describedby="alternatives-applying-hint" onCancel={(event) => event.preventDefault()}>
    <div className="alternatives-applying-icon"><LoaderCircle size={28} className="alternatives-spinner" aria-hidden="true" /></div>
    <div role="status">
      <h2 id="alternatives-applying-title">{number ? formatMessage(text.adoptingCandidate, { number }) : text.adopting}</h2>
      <p id="alternatives-applying-hint">{text.adoptingHint}</p>
    </div>
  </dialog>;
}

export function PageRegenerationPage({ model, t }: { model: PageRegenerationModel; t: Messages }) {
  const text = model.text;
  const [selected, setSelected] = useState<string | null>(null);
  const [adoptingNumber, setAdoptingNumber] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ id: string; version: string; label: string } | null>(null);
  const [visitedPreviews, setVisitedPreviews] = useState<Array<{ id: string; version: string; label: string }>>([]);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const previewRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (preview) previewRef.current?.showModal();
    else previewRef.current?.close();
  }, [preview]);
  const candidates = model.batch?.candidates ?? [];
  const readyCount = candidates.filter((candidate) => candidate.status === "ready").length;
  const failedCount = candidates.filter((candidate) => candidate.status === "failed").length;
  const finishedCount = readyCount + failedCount;
  const finished = candidates.length > 0 && finishedCount === candidates.length;
  return <main className="alternatives-page">
    <div className="alternatives-content">
      {model.imagePreparation ? <p role="status" aria-live="polite">{formatMessage(model.imagePreparation.failed && model.imagePreparation.completed === model.imagePreparation.total
        ? t.imagePreparation.fallback : t.imagePreparation.progress, { ...model.imagePreparation })}</p> : null}
      <nav className="alternatives-toolbar" aria-label={text.candidates}>
        <button className="secondary-btn deck-back-btn" disabled={model.busy} onClick={model.close}><ArrowLeft size={16} aria-hidden="true" />{text.back}</button>
        <div>
          <button className="secondary-btn" disabled={model.busy} onClick={() => { setPreviewAttempt((attempt) => attempt + 1); void model.refresh(); }}><RefreshCw size={15} aria-hidden="true" />{text.refresh}</button>
          <button className="secondary-btn" disabled={model.busy || (candidates.length > 0 && !finished)} onClick={model.configure}><Plus size={16} aria-hidden="true" />{text.newBatch}</button>
        </div>
      </nav>
      <header className="alternatives-header">
        <div className="alternatives-icon"><Layers size={22} aria-hidden="true" /></div>
        <div><h1>{text.candidates}</h1><p>{model.outline?.title}</p></div>
      </header>
      <div className="alternatives-summary">
        <p className="alternatives-muted">{finished && readyCount > 0 ? text.readyHint : text.subtitle}</p>
        {candidates.length > 0 ? <div className="alternatives-progress" role="status">
          <span className={`alternatives-status ${finished ? "is-complete" : ""}`}>
            {finished ? <Check size={14} aria-hidden="true" /> : <LoaderCircle size={14} className="alternatives-spinner" aria-hidden="true" />}
            {formatMessage(text.progress, { finished: finishedCount, total: candidates.length })}
          </span>
          {readyCount > 0 ? <span>{formatMessage(text.readyCount, { count: readyCount })}</span> : null}
          {failedCount > 0 ? <span>{formatMessage(text.failedCount, { count: failedCount })}</span> : null}
        </div> : null}
      </div>
      <ErrorNotice model={model} t={t} />
      {finished && !readyCount ? <div className="alternatives-empty" role="status"><CircleAlert size={22} aria-hidden="true" /><p>{text.allFailed}</p></div> : null}
      {!candidates.length && model.busy ? <div className="alternatives-initial" role="status"><LoaderCircle className="alternatives-spinner" aria-hidden="true" />{text.loading}</div> : null}
      <div className="alternatives-grid">
        {candidates.map((candidate, index) => {
          const working = candidate.status === "generating" || candidate.status === "rendering";
          const imageReady = candidate.status === "ready";
          const label = formatMessage(text.candidate, { number: index + 1 });
          return <article key={candidate.id} className={`alternative-card is-${candidate.status}`} aria-label={label}>
            <header className="alternative-card-header">
              <strong>{label}</strong>
              <span className={`alternatives-status is-${candidate.status}`}>
                {working ? <LoaderCircle size={13} className="alternatives-spinner" aria-hidden="true" />
                  : candidate.status === "ready" ? <Check size={13} aria-hidden="true" /> : <CircleAlert size={13} aria-hidden="true" />}
                {text[candidate.status]}
              </span>
            </header>
            <div className="alternative-image">
              {candidate.status === "ready" && imageReady ? <button aria-label={`${text.preview} · ${label}`} onClick={() => {
                const next = { id: candidate.id, version: candidate.preview_fingerprint ?? candidate.id, label };
                // Keep DOM order stable: moving an existing iframe can reload its document.
                setVisitedPreviews((entries) => entries.some((entry) => entry.id === next.id)
                  ? entries.map((entry) => entry.id === next.id ? next : entry) : [...entries, next]);
                setPreview(next);
              }}>
                <LazySlideHtml key={previewAttempt} t={t} workspaceDir={model.workspaceDir} pageId={model.batch!.page_id} title={label}
                  batchId={model.batch!.id} candidateId={candidate.id} version={candidate.preview_fingerprint ?? candidate.id} />
                <span className="alternative-expand"><Expand size={16} aria-hidden="true" />{text.preview}</span>
              </button> : <div className={`alternative-placeholder ${working ? "is-working" : ""}`}>
                <div className="alternative-placeholder-icon">
                  {working ? <Layers size={26} aria-hidden="true" /> : candidate.status === "failed" ? <CircleAlert size={26} aria-hidden="true" /> : <ImageOff size={26} aria-hidden="true" />}
                </div>
                <p>{working ? (candidate.status === "generating" ? text.generatingHint : text.renderingHint)
                  : candidate.status === "failed" ? text.failedHint : text.previewFailed}</p>
              </div>}
            </div>
            <footer className="alternative-card-footer">
              <button className="primary-btn" disabled={!finished || model.busy || candidate.status !== "ready" || !imageReady}
                onClick={() => setSelected(candidate.id)}><Check size={15} aria-hidden="true" />{text.use}</button>
            </footer>
            {candidate.error ? <details className="alternative-details"><summary>{text.details}</summary><pre>{candidate.error}</pre></details> : null}
          </article>;
        })}
      </div>
    </div>
    <ConfirmationDialog request={selected ? { title: text.confirmTitle, body: text.confirmBody, tone: "warning",
      confirmLabel: text.confirm, cancelLabel: text.keepChoosing, closeLabel: text.close } : null}
      onResolve={(confirmed) => {
        const id = selected;
        setSelected(null);
        if (confirmed && id) {
          setAdoptingNumber(candidates.findIndex((candidate) => candidate.id === id) + 1);
          void model.adopt(id);
        }
      }} />
    {visitedPreviews.length > 0 ? <dialog ref={previewRef} className="alternative-preview" aria-labelledby="alternative-preview-title" onCancel={() => setPreview(null)}>
      <header><strong id="alternative-preview-title">{preview?.label}</strong>
        <button className="alternatives-icon-button" aria-label={text.close} onClick={() => setPreview(null)}><X size={18} aria-hidden="true" /></button>
      </header>
      {visitedPreviews.map((entry) => <div key={`${entry.id}:${entry.version}`} className="alternative-html-preview"
        style={{ display: preview?.id === entry.id ? undefined : "none" }}>
        <RenderedSlideHtml t={t} workspaceDir={model.workspaceDir} pageId={model.batch!.page_id}
          batchId={model.batch!.id} candidateId={entry.id} version={entry.version} title={entry.label} />
      </div>)}
    </dialog> : null}
    {model.applying ? <ApplyingDialog number={adoptingNumber} model={model} /> : null}
  </main>;
}
