import { useEffect, useId, useRef, useState } from "react";
import { createPptBackend } from "../../../api/pptBackend";
import type { PageRecoveryOption, RestorePageSourceVersionResult } from "../../../api/types";
import type { Messages } from "../../../i18n/messages";
import { beginPageRecovery, classifyPreviewError, dismissRecoveryPrompt, recoveryPromptDismissed, reportPreviewRecovery, withPreviewDeadline } from "../previewRecovery";

export function PageRecoveryNotice(props: {
  workspaceDir: string; pageId: string; versionKey: string; title: string; t: Messages;
  retry: () => void; retrying: boolean; onRestored: (result: RestorePageSourceVersionResult) => void;
}) {
  const t = props.t.review;
  const [option, setOption] = useState<PageRecoveryOption | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const requested = useRef(false);
  const automaticPrompt = useRef(!recoveryPromptDismissed(props.versionKey));
  const mounted = useRef(true);
  const submitting = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const heading = useId();
  const body = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    setLoading(true);
    void createPptBackend().then((backend) => withPreviewDeadline(backend.preparePageRecovery({
      workspace_dir: props.workspaceDir, page_id: props.pageId,
    }))).then((value) => {
      if (!current) return;
      if (value.workspace_dir !== props.workspaceDir || value.page_id !== props.pageId) throw new Error("Preview page identity mismatch");
      setOption(value);
      if (value.available && value.recovery_token && (requested.current || automaticPrompt.current)) {
        // Mark before opening so remounts and another retained preview cannot auto-prompt again.
        dismissRecoveryPrompt(props.versionKey);
        automaticPrompt.current = false;
        requested.current = false;
        setOpen(true);
      }
    }).catch(() => { if (current) { setOption(null); setError(t.previewRecoveryCheckFailed); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [props.workspaceDir, props.pageId, props.versionKey, attempt, t.previewRecoveryCheckFailed]);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    cancelButton.current?.focus();
    return () => { element.close(); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  const cancel = () => {
    if (submitting.current) return;
    setOpen(false);
    dismissRecoveryPrompt(props.versionKey);
    void createPptBackend().then((backend) => reportPreviewRecovery(backend, {
      workspaceDir: props.workspaceDir, pageId: props.pageId, event: "preview.cancelled",
      source: option?.source ?? "none", errorKind: "unknown",
    })).catch(() => undefined);
  };
  const restore = async () => {
    if (!option?.recovery_token || submitting.current) return;
    const release = beginPageRecovery(props.workspaceDir, props.pageId);
    if (!release) { setError(t.previewRecoveryBusy); return; }
    submitting.current = true;
    setBusy(true); setError("");
    try {
      const backend = await createPptBackend();
      // A mutation is never automatically retried on timeout or transport failure.
      const result = await backend.restorePageSourceVersion({ workspace_dir: props.workspaceDir,
        page_id: props.pageId, recovery_token: option.recovery_token });
      if (result.workspace_dir !== props.workspaceDir || result.page_id !== props.pageId || !result.restored) throw new Error("Preview page identity mismatch");
      // Keep the normal Workspace state in sync even if the user navigated to another page.
      props.onRestored(result);
      if (mounted.current) setOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mounted.current) {
        setError(/PAGE_RECOVERY_CONFLICT/.test(message) ? t.previewRecoveryConflict
          : /PAGE_RECOVERY_BUSY/.test(message) ? t.previewRecoveryBusy : t.previewRecoveryFailed);
        setOption(null); setOpen(false);
      }
      void createPptBackend().then((backend) => reportPreviewRecovery(backend, {
        workspaceDir: props.workspaceDir, pageId: props.pageId, event: "preview.restore_failed",
        source: option.source ?? "none", errorKind: classifyPreviewError(error),
      })).catch(() => undefined);
    } finally {
      release(); submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const sourceBody = option?.source === "original_source" ? t.previewRecoveryOriginal
    : option?.source === "manual_base" ? t.previewRecoveryManualBase : t.previewRecoverySaved;
  return <div className="static-html-preview-overlay static-html-preview-error preview-recovery-notice"
    onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}
    onWheel={(event) => event.stopPropagation()}>
    <strong>{props.title}</strong>
    <span>{t.previewFailed}</span>
    {error && <span role="alert">{error}</span>}
    {!loading && option?.available === false && <span>{t.previewRecoveryUnavailable}</span>}
    <div className="preview-recovery-actions">
      <button type="button" className="secondary-btn" disabled={busy || props.retrying} onClick={props.retry}>
        {props.retrying ? t.previewRecovering : t.previewRetry}
      </button>
      <button type="button" className="primary-btn" data-performance-id="preview.recovery.open"
        disabled={busy || loading || props.retrying || option?.available === false} onClick={() => {
          setError("");
          if (option?.recovery_token) setOpen(true);
          else { requested.current = true; setAttempt((value) => value + 1); }
        }}>{loading ? t.previewRecoveryChecking : t.previewRecoveryUseSaved}</button>
    </div>
    {open && <dialog ref={dialog} className="preview-recovery-dialog" aria-labelledby={heading} aria-describedby={body}
      onCancel={(event) => { event.preventDefault(); cancel(); }}>
      <h2 id={heading}>{t.previewRecoveryTitle}</h2>
      <p id={body}>{sourceBody}</p>
      <footer className="preview-recovery-actions">
        <button ref={cancelButton} type="button" className="secondary-btn" disabled={busy}
          data-performance-id="preview.recovery.cancel" onClick={cancel}>{t.previewRecoveryCancel}</button>
        <button type="button" className="primary-btn" disabled={busy}
          data-performance-id="preview.recovery.confirm" onClick={() => void restore()}>
          {busy ? t.previewRecoveryRestoring : t.previewRecoveryConfirm}
        </button>
      </footer>
    </dialog>}
  </div>;
}
