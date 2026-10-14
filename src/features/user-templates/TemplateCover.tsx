import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { Messages } from "../../i18n";

/** Lazily fetch one cover/thumbnail via the single-asset channel. A failure
 *  degrades to a retry affordance on this card only — it never affects the
 *  rest of the list. Styles come from user-templates.css (imported by the
 *  page); kept in a standalone module with no CSS import so it stays unit
 *  testable under the node test runner. */
export function TemplateCover({ t, templateId, pageNumber, alt, preview }: { t: Messages; templateId: string; pageNumber?: number; alt: string; preview: (id: string, pageNumber?: number) => Promise<string> }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setUrl(""); setFailed(false);
    preview(templateId, pageNumber).then((resolved) => {
      if (!cancelled) setUrl(resolved);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [templateId, pageNumber, preview, reloadToken]);
  if (failed) {
    return <span className="user-template-thumb-retry" role="button" tabIndex={0}
      aria-label={t.userTemplates.retry} title={t.userTemplates.retry}
      onClick={() => setReloadToken((value) => value + 1)}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setReloadToken((value) => value + 1); } }}>
      <RefreshCw size={18} />
    </span>;
  }
  if (!url) return <span className="user-template-thumb-placeholder"><Loader2 className="user-template-spinner" size={20} /></span>;
  return <img src={url} alt={alt} loading="lazy" onError={() => { setUrl(""); setFailed(true); }} />;
}
