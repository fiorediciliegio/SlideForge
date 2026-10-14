import { Cloud, CloudOff, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { formatMessage, type Messages } from "../../../i18n/messages";
import type { CloudConflictDialogState } from "../types";

interface CloudSyncNoticeDialogProps {
  t: Messages;
  notice: CloudConflictDialogState | null;
  onDismiss: () => void;
}

export function CloudSyncNoticeDialog({ t, notice, onDismiss }: CloudSyncNoticeDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    if (!notice) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const returnFocusTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      if (returnFocusTarget?.isConnected) returnFocusTarget.focus();
    };
  }, [notice, onDismiss]);

  if (!notice) return null;

  const resolved = notice.status === "conflict_resolved";
  const Icon = resolved ? Cloud : CloudOff;
  const body = resolved
    ? formatMessage(t.conflictDialog.bodyResolved, { backupTitle: notice.backupTitle ?? "" })
    : t.conflictDialog.bodyBlocked;

  return (
    <div
      className={`app-confirmation-modal cloud-sync-notice ${resolved ? "default" : "warning"}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
    >
      <section
        className={`app-confirmation-card cloud-sync-notice-card ${resolved ? "default" : "warning"}`}
      >
        <button
          data-performance-id="cloud-sync.notice.close"
          ref={closeButtonRef}
          type="button"
          className="app-confirmation-close"
          aria-label={t.conflictDialog.close}
          title={t.conflictDialog.close}
          onClick={onDismiss}
        >
          <X size={16} />
        </button>
        <div className="app-confirmation-icon" aria-hidden="true"><Icon size={22} /></div>
        <div className="app-confirmation-copy">
          <h2 id={titleId}>{t.conflictDialog.title}</h2>
          <p id={bodyId}>{body}</p>
        </div>
        <footer className="app-confirmation-actions">
          <button
            data-performance-id="cloud-sync.notice.confirm"
            type="button"
            className="primary-btn"
            onClick={onDismiss}
          >
            {t.conflictDialog.close}
          </button>
        </footer>
      </section>
    </div>
  );
}
