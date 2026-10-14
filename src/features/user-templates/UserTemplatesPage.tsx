import { invokeTimeoutSummary } from "../deck-workspace/userFacingError";
import { useEffect, useRef, useState } from "react";
import { Check, ClipboardCopy, FileUp, Layers, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import type { Messages } from "../../i18n/messages";
import type { useUserTemplates } from "./useUserTemplates";
import type { TemplateStep, UserTemplateListEntry } from "./types";
import { ProfilePanel } from "./ProfilePanel";
import { ProfileEditor } from "./ProfileEditor";
import { MasterPreviewPanel } from "./MasterPreviewPanel";
import { TemplateCover } from "./TemplateCover";
import { formatRunLog, loadRunLogs, type RunLog } from "./runLog";
import "./user-templates.css";

/** Lazily hydrate the last persisted run log so a page refresh on the online
 *  deployment does not lose diagnostics for a failed attempt. */
function useLastRunLog(live: RunLog | null, error: string): RunLog | null {
  const [restored, setRestored] = useState<RunLog | null>(null);
  useEffect(() => {
    if (!error || live) return;
    try { setRestored(loadRunLogs(typeof localStorage === "undefined" ? null : localStorage)[0]?.log ?? null); }
    catch { setRestored(null); }
  }, [error, live]);
  return live ?? restored;
}

function RunLogDetails({ t, log }: { t: Messages; log: RunLog }) {
  const copy = t.userTemplates;
  const [copied, setCopied] = useState(false);
  const text = formatRunLog(log);
  return (
    <details className="user-template-runlog">
      <summary>{copy.runLogTitle}</summary>
      <div className="user-template-runlog-body">
        <button type="button" className="secondary-btn compact" onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}>{copied ? <Check size={13} /> : <ClipboardCopy size={13} />}{copied ? copy.runLogCopied : copy.runLogCopy}</button>
        <pre>{text}</pre>
      </div>
    </details>
  );
}

function StepDetail({ t, step }: { t: Messages; step: TemplateStep }) {
  const copy = t.userTemplates;
  const detail = step.detail;
  if (!detail) return null;
  const sourcePage = (page: number) => copy.sourcePage.replace("{page}", String(page));
  return (
    <div className="user-template-step-detail">
      {detail.page_numbers ? <p><strong>{copy.selectedPages}</strong>{detail.page_numbers.join(" · ")}</p> : null}
      {detail.images ? <ul className="user-template-thumbs">{detail.images.map((image) => (
        <li key={image.page_number}><img src={image.url} alt={sourcePage(image.page_number)} loading="lazy" /><span>{sourcePage(image.page_number)}</span></li>
      ))}</ul> : null}
      {detail.master_preview_url ? <ul className="user-template-thumbs"><li><img src={detail.master_preview_url} alt={copy.master} loading="lazy" /><span>{copy.master}</span></li></ul> : null}
      {detail.pages ? <ul className="user-template-thumbs">{detail.pages.map((page) => (
        <li key={page.page_number} className={page.status}>
          {page.preview_url ? <img src={page.preview_url} alt={sourcePage(page.page_number)} loading="lazy" /> : <span className="user-template-thumb-placeholder">{page.status === "running" ? <Loader2 className="user-template-spinner" size={16} /> : <Layers size={16} />}</span>}
          <span>{sourcePage(page.page_number)} · {copy.pageStatus[page.status]}</span>
        </li>
      ))}</ul> : null}
      {detail.drifts?.length ? (
        <div className="user-template-drift-warn" role="alert">
          <strong>{copy.driftWarn}</strong>
          <ul>{detail.drifts.map((drift) => (
            <li key={drift.page_number}>{sourcePage(drift.page_number)}：{drift.unmatched.join(" · ")}</li>
          ))}</ul>
        </div>
      ) : null}
      {detail.name ? <p><strong>{detail.name}</strong></p> : null}
      {detail.description ? <p>{detail.description}</p> : null}
      {detail.profile_colors ? <p><strong>{copy.stages.profile}</strong>{detail.profile_colors.join(" · ")}</p> : null}
    </div>
  );
}

export function UserTemplatesPage({ t, model }: { t: Messages; model: ReturnType<typeof useUserTemplates> }) {
  const copy = t.userTemplates;
  const runLog = useLastRunLog(model.runLog, model.error);
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<{ record: UserTemplateListEntry; pageNumber?: number } | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewError, setPreviewError] = useState(false);
  /** List records ship without the design profile (keeps the list light); the
   *  preview dialog hydrates the full record on open so ProfilePanel has it. */
  const openPreview = (record: UserTemplateListEntry, pageNumber?: number) => {
    setPreview({ record, pageNumber });
    void model.getTemplate(record.id).then((full) => {
      setPreview((current) => current && current.record.id === record.id
        ? { record: { ...full, preview_images: current.record.preview_images }, pageNumber: current.pageNumber }
        : current);
    }).catch(() => { /* keep the metadata-only record; the profile panel hides itself */ });
  };
  const [pendingDelete, setPendingDelete] = useState<UserTemplateListEntry | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resumeFileRef = useRef<HTMLInputElement>(null);
  const resumeIdRef = useRef("");
  function resumeTemplate(id: string) {
    const record = model.templates.find((item) => item.id === id);
    if (record?.source_ready === false) {
      resumeIdRef.current = id;
      model.select(id);
      resumeFileRef.current?.click();
    } else void model.resume(id);
  }
  useEffect(() => {
    if (!preview) return;
    let cancelled = false;
    setPreviewUrl(""); setPreviewError(false);
    void model.preview(preview.record.id, preview.pageNumber).then((url) => {
      if (!cancelled) setPreviewUrl(url);
    }).catch(() => { if (!cancelled) setPreviewError(true); });
    return () => { cancelled = true; };
  }, [preview, model.preview]);
  useEffect(() => { if (preview && !dialogRef.current?.open) dialogRef.current?.showModal(); }, [preview]);
  useEffect(() => { if (pendingDelete && !deleteDialogRef.current?.open) deleteDialogRef.current?.showModal(); }, [pendingDelete]);
  const [masterView, setMasterView] = useState<UserTemplateListEntry | null>(null);
  return (
    <section className="user-templates-page">
      <input ref={resumeFileRef} type="file" hidden accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        onChange={(event) => { const selected = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (selected && resumeIdRef.current) void model.resume(resumeIdRef.current, selected); }} />
      <header className="user-templates-heading">
        <div><h1>{copy.title}</h1><p>{copy.subtitle}</p></div>
        <button className="secondary-btn" disabled={model.loading || model.busy} onClick={() => void model.refresh()}><RefreshCw size={16} />{copy.refresh}</button>
      </header>
      <form className="user-template-upload" onSubmit={(event) => { event.preventDefault(); if (files.length) void model.create(files); }}>
        <span className="user-template-upload-icon"><FileUp size={26} /></span>
        <div className="user-template-upload-field">
          <strong>{copy.fileHint}</strong>
          <div className="user-template-upload-picker">
            <button type="button" className="secondary-btn compact" disabled={model.busy} onClick={() => fileInputRef.current?.click()}>{copy.chooseFile}</button>
            <span className="user-template-upload-filename">{files.length ? files.map((file) => file.name).join("、") : copy.noFileChosen}</span>
          </div>
          <input
            ref={fileInputRef}
            hidden
            type="file"
            multiple
            accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation,image/png,image/jpeg,image/webp"
            onChange={(event) => { setFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }}
          />
        </div>
        <button className="primary-btn" disabled={!files.length || model.busy || !model.ready}><Layers size={16} />{copy.upload}</button>
      </form>
      {model.steps.length ? (
        <div className="user-template-progress" role="status" aria-live="polite">
          <div className="user-template-progress-heading">
            <strong>{copy.progressTitle}</strong>
            {model.busy ? <button className="secondary-btn compact" onClick={model.stop}>{copy.stop}</button> : null}
          </div>
          <ol className="user-template-steps">
            {model.steps.map((step) => (
              <li key={step.stage} className={step.status}>
                <span className="user-template-step-icon">{step.status === "done" ? <Check size={13} /> : step.status === "running" ? <Loader2 className="user-template-spinner" size={13} /> : <X size={13} />}</span>
                <div className="user-template-step-body">
                  <div className="user-template-step-head">
                    <strong>{copy.stages[step.stage]}</strong>
                    {step.status === "failed" || step.status === "stopped" ? <span>{step.status === "failed" ? copy.stepFailed : copy.stopped}</span> : null}
                    {step.total ? <span>{step.completed}/{step.total}</span> : null}
                  </div>
                  {step.detail ? (
                    // Remounts on status change so a finished step collapses itself.
                    <details key={step.status} open={step.status === "running"}>
                      <summary>{copy.stepDetails}</summary>
                      <StepDetail t={t} step={step} />
                    </details>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {model.notice ? <p role="status" className="user-template-notice">{model.notice}</p> : null}
      {model.error ? <div role="alert" className="user-template-error"><p>{invokeTimeoutSummary(t, model.detail || model.error, model.error)}</p>{model.error === t.userTemplates.loadFailed ? <button type="button" className="secondary-btn compact" disabled={model.loading} onClick={() => void model.refresh()}><RefreshCw size={13} />{copy.refresh}</button> : null}{model.detail ? <details><summary>{copy.details}</summary><pre>{model.detail}</pre></details> : null}{runLog ? <RunLogDetails t={t} log={runLog} /> : null}</div> : null}
      {!model.busy && model.activeId && !model.templates.some((r) => r.id === model.activeId && r.status === "ready") ? <button className="secondary-btn" disabled={!model.ready} onClick={() => resumeTemplate(model.activeId)}>{copy.retry}</button> : null}
      {model.loading && !model.templates.length ? <p>{copy.loading}</p> : null}
      {!model.loading && !model.templates.length ? <div className="user-template-empty"><Layers size={36} /><p>{copy.empty}</p></div> : null}
      <div className="user-template-grid">
        {model.templates.map((record) => <article className="user-template-card" key={record.id}>
          <button className="user-template-cover" disabled={!record.master_ready} onClick={() => openPreview(record)} aria-label={`${copy.preview}: ${record.name}`}>
            {record.master_ready ? <TemplateCover t={t} templateId={record.id} pageNumber={record.pages[0]?.page_number} alt={record.name} preview={model.preview} /> : <Layers size={36} />}
          </button>
          <div className="user-template-card-body">
            <div className="user-template-card-title"><h2>{record.name}</h2><span>{record.status === "ready" ? copy.ready : copy.draft}</span></div>
            <p className="user-template-card-description">{record.description || record.filename}</p>
            {record.source_ready === false ? <p>{copy.sourceRequired}</p> : null}
            <div className="user-template-card-actions">
              {record.status === "draft"
                ? <button className="secondary-btn compact" disabled={model.busy || !model.ready} onClick={() => resumeTemplate(record.id)}>{record.source_ready === false ? copy.reselectSource : copy.retry}</button>
                : <button className="secondary-btn compact" onClick={() => openPreview(record)}>{copy.preview}</button>}
              {record.master_ready ? <button className="secondary-btn compact" onClick={() => setMasterView(record)}>{copy.master}</button> : null}
              <button className="icon-btn danger" disabled={model.busy || Boolean(model.deletingId)} onClick={() => setPendingDelete(record)} aria-label={`${copy.delete}: ${record.name}`} title={copy.delete}>
                {model.deletingId === record.id ? <Loader2 className="user-template-spinner" size={16} /> : <Trash2 size={16} />}
              </button>
            </div>
          </div>
        </article>)}
      </div>
      {preview ? <dialog ref={dialogRef} className="user-template-dialog" onCancel={() => setPreview(null)} onClose={() => setPreview(null)} aria-label={`${copy.preview}: ${preview.record.name}`}>
        <header><strong>{preview.record.name}</strong><button className="icon-btn" autoFocus onClick={() => setPreview(null)} aria-label={copy.close}><X size={20} /></button></header>
        <nav aria-label={copy.preview}><button className={preview.pageNumber === undefined ? "active" : ""} onClick={() => setPreview({ record: preview.record })}>{copy.master}</button>{preview.record.pages.filter((p) => preview.record.completed_pages.includes(p.page_number)).map((p) => <button key={p.page_number} className={p.page_number === preview.pageNumber ? "active" : ""} onClick={() => setPreview({ record: preview.record, pageNumber: p.page_number })}>{copy.page} {p.page_number}</button>)}</nav>
        <div className="user-template-preview">{previewUrl ? <img src={previewUrl} alt={preview.pageNumber === undefined ? copy.master : `${copy.page} ${preview.pageNumber}`} onError={() => { setPreviewUrl(""); setPreviewError(true); }} /> : <p>{previewError ? copy.previewFailed : copy.loading}</p>}</div>
        {preview.record.master_ready ? <button type="button" className="secondary-btn compact" onClick={() => setMasterView(preview.record)}>{copy.masterOptimizeTitle}</button> : null}
        <p>{preview.record.pages.find((p) => p.page_number === preview.pageNumber)?.description || preview.record.description}</p>
        {preview.record.status === "ready" && preview.record.profile ? <ProfilePanel t={t} profile={preview.record.profile} /> : null}
      </dialog> : null}
      {masterView ? <MasterPreviewPanel
        t={t}
        record={masterView}
        getTemplateHtmls={model.getTemplateHtmls}
        regenerate={(id, instruction, pageNumber, onStream) => model.regenerateMaster(id, instruction, pageNumber, onStream)}
        applyHtml={(record, html, pageNumber) => model.applyMasterHtml(record, html, pageNumber)}
        syncVars={(id) => model.syncPageVariables(id)}
        previewUrl={(id, pageNumber) => model.preview(id, pageNumber)}
        onClose={() => setMasterView(null)}
      /> : null}
      {model.profileReview ? <div className="user-template-editor-overlay">
        <ProfileEditor
          t={t}
          profile={model.profileReview.profile}
          reextracting={model.reextracting}
          onReextract={(section) => model.reextractProfileSection(section)}
          onSuggest={(profile, instruction) => model.suggestProfileEdits(profile, instruction)}
          importAsset={(file) => model.importProfileAsset(file)}
          assetUrl={(filename) => { const review = model.profileReview; return review ? model.profileAssetUrl(review.templateId, filename) : Promise.reject(new Error("")); }}
          onConfirm={(profile) => { void model.confirmProfileEdits(profile); }}
          onCancel={model.cancelProfileReview}
        />
      </div> : null}
      {pendingDelete ? <dialog ref={deleteDialogRef} className="user-template-dialog user-template-confirm" onCancel={() => setPendingDelete(null)} onClose={() => setPendingDelete(null)} aria-label={copy.deleteConfirmTitle}>
        <header><strong>{copy.deleteConfirmTitle}</strong></header>
        <p>{pendingDelete.name}</p>
        <p>{copy.deleteConfirmBody}</p>
        <div className="user-template-confirm-actions">
          <button className="secondary-btn" autoFocus onClick={() => setPendingDelete(null)}>{copy.deleteCancel}</button>
          <button className="danger-btn" onClick={() => { const id = pendingDelete.id; setPendingDelete(null); void model.remove(id); }}><Trash2 size={16} />{copy.deleteConfirm}</button>
        </div>
      </dialog> : null}
    </section>
  );
}
