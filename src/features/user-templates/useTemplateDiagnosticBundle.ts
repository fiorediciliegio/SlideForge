import { useEffect, useRef, useState } from "react";
import type { PptBackend } from "../../api/pptBackend";
import type { AppHostFileDownloadClient } from "../../runtime/appHostFileDownload";
import type { Messages } from "../../i18n/messages";
import type { WorkspaceDiagnosticBundleState } from "../deck-workspace/types";
import { hasActiveDownloadUrl } from "../deck-workspace/downloadUrl";
import { startBrowserDownload } from "../deck-workspace/browserDownload";
import { flushUserTemplateDiagnostics } from "./diagnostics";

export function useTemplateDiagnosticBundle(input: {
  backend: PptBackend | null;
  hostDownload: AppHostFileDownloadClient | null;
  templateId: string;
  enabled: boolean;
  t: Messages;
}) {
  const [state, setState] = useState<WorkspaceDiagnosticBundleState>({ status: "idle", message: "" });
  const latest = useRef(input);
  latest.current = input;
  const request = useRef(0);
  const busy = useRef(false);
  function reset() {
    request.current += 1; busy.current = false;
    setState({ status: "idle", message: "" });
  }
  useEffect(() => { reset(); }, [input.templateId, input.enabled]);
  useEffect(() => () => { request.current += 1; }, []);
  async function download() {
    const { backend, templateId, enabled, hostDownload, t } = latest.current;
    if (!enabled || !backend || !templateId || busy.current) return;
    if (state.workspaceId === templateId && hasActiveDownloadUrl(state) && state.href) {
      startBrowserDownload(state.href, document);
      return;
    }
    const token = ++request.current;
    const current = () => request.current === token && latest.current.enabled && latest.current.templateId === templateId;
    busy.current = true;
    setState({ status: "preparing", message: t.library.diagnosticBundlePreparing, workspaceId: templateId });
    try {
      await flushUserTemplateDiagnostics(templateId);
      if (!current()) return;
      const result = await backend.prepareUserTemplateDiagnosticBundle({ id: templateId });
      if (!current()) return;
      const common = {
        status: "ready" as const, workspaceId: templateId, filename: result.filename,
        sizeBytes: result.size_bytes, mirrorPath: result.mirror?.path, mirrorScope: result.mirror?.scope,
      };
      if (result.mirror?.path && hostDownload) {
        const outcome = await hostDownload.download({ path: result.mirror.path, scope: result.mirror.scope, filename: result.filename });
        if (!current()) return;
        if (outcome === "downloaded") {
          setState({ ...common, message: t.library.diagnosticBundleDownloadStarted });
          return;
        }
      }
      const started = startBrowserDownload(result.download_url, document);
      setState({ ...common, message: started ? t.library.diagnosticBundleDownloadStartedWithLink : t.library.diagnosticBundleReady, href: result.download_url, expiresAt: result.expires_at });
    } catch (error) {
      if (current()) setState({ status: "error", workspaceId: templateId, message: `${t.library.diagnosticBundleFailedPrefix}${error instanceof Error ? error.message : String(error)}` });
    } finally { if (request.current === token) busy.current = false; }
  }
  return { state, reset, download };
}
