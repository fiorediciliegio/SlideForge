import { useState } from "react";
import { Sparkles, X } from "lucide-react";
import type { Messages } from "../../../i18n/messages";
import type { EditableOutline } from "../../outline/model";
import { ProcessPanel } from "../../process-progress/ProcessProgress";
import type { ProcessStep } from "../../process-progress/model";
import { ErrorNotice } from "./ErrorNotice";
import { OutlineDialog } from "./OutlineDialog";

function OutlinePreview({ value, label, t }: { value: EditableOutline; label: string; t: Messages }) {
  return <section className="outline-preview-column">
    <h3>{label}<span>{t.outline.pageListCount.replace("{count}", String(value.items.length))}</span></h3>
    <h4>{value.title}</h4>
    {value.global_creation_requirements ? <p><strong>{t.outline.globalCreationRequirements}</strong>{"\n"}{value.global_creation_requirements}</p> : null}
    <ol>{value.items.map((item, index) => <li key={index}>
      <div><span className="outline-preview-number">{String(index + 1).padStart(2, "0")}</span>
        {item.page_type === "cover" ? <span className="outline-page-type outline-page-type-cover">{t.outline.pageTypeCover}</span> : null}
        <strong>{item.title}</strong></div>
      <p>{item.content}</p>
      {item.creation_requirements ? <p><strong>{t.outline.pageCreationRequirements}</strong>{"\n"}{item.creation_requirements}</p> : null}
      <small>{t.outline.imageCount.replace("{count}", String(item.selected_image_ids?.length ?? 0))}</small>
    </li>)}</ol>
  </section>;
}

export function OutlineRewriteDialog(props: {
  t: Messages;
  current: EditableOutline;
  feedback: string;
  setFeedback: (value: string) => void;
  generate: () => Promise<EditableOutline | undefined>;
  apply: (value: EditableOutline) => Promise<boolean>;
  error: string;
  errorDetail?: string;
  progress: ProcessStep[];
  onClose: () => void;
}) {
  const { t } = props;
  const [preview, setPreview] = useState<EditableOutline | null>(null);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [generateFailed, setGenerateFailed] = useState(false);
  const busy = generating || applying;
  async function generate() {
    if (busy || !props.feedback.trim()) return;
    setGenerating(true);
    setSaveFailed(false);
    setGenerateFailed(false);
    try {
      const result = await props.generate();
      if (result) setPreview(result);
    } catch {
      setGenerateFailed(true);
    } finally {
      setGenerating(false);
    }
  }
  async function apply() {
    if (!preview || busy) return;
    setApplying(true);
    setSaveFailed(false);
    try {
      if (await props.apply(preview)) {
        props.setFeedback("");
        props.onClose();
      } else setSaveFailed(true);
    } catch {
      setSaveFailed(true);
    } finally {
      setApplying(false);
    }
  }
  return <OutlineDialog className={`outline-rewrite-dialog${preview ? " has-preview" : ""}`} labelledBy="outline-rewrite-title" busy={busy} onClose={props.onClose}>
    <header className="outline-dialog-header">
      <span className="outline-ai-mark"><Sparkles size={23} /></span>
      <div><h2 id="outline-rewrite-title">{preview ? t.outlineReview.previewTitle : t.outlineReview.aiTitle}</h2>
        <p>{preview ? t.outlineReview.previewHint : t.outlineReview.aiHint}</p></div>
      <button type="button" className="outline-dialog-close" disabled={busy} onClick={props.onClose} aria-label={t.controls.close}><X size={20} /></button>
    </header>
    <div className="outline-dialog-body">
      {generating ? <div className="outline-rewrite-progress" role="status">
        <h3>{t.outline.rewritingTitle}</h3><p>{t.outline.rewritingBody}</p>
        <ProcessPanel t={t} steps={props.progress} />
      </div> : preview ? <div className="outline-preview-grid">
        <OutlinePreview value={props.current} label={t.outlineReview.original} t={t} />
        <OutlinePreview value={preview} label={t.outlineReview.proposed} t={t} />
      </div> : <>
        <label className="outline-rewrite-field" htmlFor="outline-rewrite-request">{t.outlineReview.direction}</label>
        <textarea id="outline-rewrite-request" data-outline-autofocus className="outline-rewrite-input" rows={6} value={props.feedback}
          onChange={(event) => props.setFeedback(event.target.value)} placeholder={t.outlineReview.directionPlaceholder} />
        <div className="outline-rewrite-suggestions">{[t.outlineReview.shorten, t.outlineReview.deduplicate, t.outlineReview.reorder].map((suggestion) =>
          <button type="button" key={suggestion} onClick={() => props.setFeedback(props.feedback.trim() ? `${props.feedback.trim()}\n${suggestion}` : suggestion)}>{suggestion}</button>)}</div>
        {props.error ? <><ErrorNotice t={t} summary={props.error} detail={props.errorDetail} tone="inline" /><ProcessPanel t={t} steps={props.progress} /></> : null}
        {generateFailed && !props.error ? <p role="alert" className="outline-dialog-error">{t.outline.rewriteError}</p> : null}
      </>}
      {saveFailed ? <p role="alert" className="outline-dialog-error">{t.outlineReview.saveFailed}</p> : null}
    </div>
    <footer className="outline-dialog-footer">
      <button className="secondary-btn" type="button" disabled={busy} onClick={props.onClose}>{t.controls.cancel}</button>
      <button data-performance-id={preview ? "outline.rewrite.apply" : "outline.rewrite"} type="button" className="primary-btn" disabled={busy || (!preview && !props.feedback.trim())}
        onClick={() => void (preview ? apply() : generate())}>
        {busy ? <span className="spinner small" /> : null}{preview ? t.outlineReview.apply : t.outlineReview.generatePreview}</button>
    </footer>
  </OutlineDialog>;
}
