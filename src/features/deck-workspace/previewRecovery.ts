import type { GetWorkspacePageHtmlInput, WorkspacePageHtml } from "../../api/pageHtmlPreview";
import type { PagePreviewPreparation } from "../../api/pageHtmlPreview";
import type { PptBackend } from "../../api/pptBackend";
import { previewHtmlUsableUntil } from "./pageHtmlPreviewCache";

export type PreviewErrorKind = "version_changed" | "resource_unavailable" | "timeout" | "missing_snapshot" | "render_failed" | "unknown" | "identity_mismatch";

/** Only source/version problems justify offering to replace the current page. */
export function isPageRecoveryEligible(error: unknown): boolean {
  const kind = classifyPreviewError(error);
  return kind === "version_changed" || kind === "missing_snapshot";
}

/** APS resource resolution can take longer than the old eight-second UI bound. */
export const PREVIEW_HTML_REQUEST_DEADLINE_MS = 30_000;

export function classifyPreviewError(error: unknown): PreviewErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  if (/identity mismatch|Candidate page mismatch/i.test(message)) return "identity_mismatch";
  if (/version changed|changed while|PAGE_RECOVERY_CONFLICT/i.test(message)) return "version_changed";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/ENOENT|missing|no rendered|no usable/i.test(message)) return "missing_snapshot";
  if (/resource|expired|network|fetch|upload|download|APS/i.test(message)) return "resource_unavailable";
  return "unknown";
}

export function withPreviewDeadline<T>(operation: Promise<T>, milliseconds = 8_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Preview request timed out")), milliseconds);
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Poll only lightweight state RPCs while Chrome prepares a missing snapshot. */
export async function waitForPagePreviewPreparation(
  backend: Pick<PptBackend, "prepareWorkspacePagePreview" | "getWorkspacePagePreviewPreparation">,
  input: { workspace_dir: string; page_id: string; priority: "foreground" | "background";
    kind?: "html" | "thumbnail"; retry?: boolean },
  options: { onStatus?: (status: PagePreviewPreparation["status"]) => void; maxWaitMs?: number } = {},
): Promise<PagePreviewPreparation> {
  const started = Date.now();
  let state = await withPreviewDeadline(backend.prepareWorkspacePagePreview(input));
  if (state.workspace_dir !== input.workspace_dir || state.page_id !== input.page_id) {
    throw new Error("Preview page identity mismatch");
  }
  for (;;) {
    options.onStatus?.(state.status);
    if (state.status === "ready") return state;
    if (state.status === "error") throw new Error(state.error || "Page preview preparation failed");
    if (Date.now() - started >= (options.maxWaitMs ?? 120_000)) {
      throw new Error("Preview preparation timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, input.priority === "foreground" ? 400 : 1_500));
    state = await withPreviewDeadline(backend.getWorkspacePagePreviewPreparation({
      workspace_dir: input.workspace_dir, task_id: state.task_id,
    }));
    if (state.workspace_dir !== input.workspace_dir || state.page_id !== input.page_id) {
      throw new Error("Preview page identity mismatch");
    }
  }
}

const reported = new Map<string, number>();
export function reportPreviewRecovery(backend: Pick<PptBackend, "appendWorkspaceLog">, input: {
  workspaceDir: string; pageId: string; event: "preview.fallback" | "preview.recovered" | "preview.failed" | "preview.restored" | "preview.restore_failed" | "preview.cancelled";
  errorKind: PreviewErrorKind; source: string; requestedFingerprint?: string; actualFingerprint?: string;
}) {
  const entry = { event: input.event, page_id: input.pageId, error_kind: input.errorKind,
    source: input.source, requested_fingerprint: input.requestedFingerprint, actual_fingerprint: input.actualFingerprint };
  const key = JSON.stringify([input.workspaceDir, entry]);
  if (Date.now() - (reported.get(key) ?? 0) < 60_000) return;
  reported.set(key, Date.now());
  while (reported.size > 512) reported.delete(reported.keys().next().value!);
  // Telemetry cannot delay or reject an otherwise usable preview.
  void Promise.resolve().then(() => backend.appendWorkspaceLog({ workspace_dir: input.workspaceDir,
    channel: "preview-recovery", entry })).catch(() => undefined);
}

/** Read the current page twice at most. A saved version requires explicit confirmation. */
export async function loadPagePreviewWithRecovery(
  backend: Pick<PptBackend, "getWorkspacePageHtml" | "appendWorkspaceLog" | "prepareWorkspacePagePreview" | "getWorkspacePagePreviewPreparation">,
  input: GetWorkspacePageHtmlInput,
  options: { deadlineMs?: number; priority?: "foreground" | "background";
    onPreparationStatus?: (status: PagePreviewPreparation["status"]) => void } = {},
): Promise<WorkspacePageHtml> {
  const official = Boolean(input.page_id && !input.batch_id && !input.candidate_id);
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const request = attempt === 1 && official ? { ...input, expected_preview_fingerprint: undefined } : input;
      if (official) await waitForPagePreviewPreparation(backend, {
        workspace_dir: input.workspace_dir, page_id: input.page_id!, priority: options.priority ?? "foreground", retry: attempt > 0,
      }, { onStatus: options.onPreparationStatus });
      const value = await withPreviewDeadline(backend.getWorkspacePageHtml(request),
        options.deadlineMs ?? PREVIEW_HTML_REQUEST_DEADLINE_MS);
      if (input.page_id && value.page_id !== input.page_id) throw new Error("Preview page identity mismatch");
      if (request.expected_preview_fingerprint && value.preview_source_fingerprint !== request.expected_preview_fingerprint) throw new Error("Page preview version changed");
      if (value.fallback) throw new Error("Unexpected preview fallback metadata");
      if (!value.html?.trim()) throw new Error("Page HTML is missing");
      if (!(previewHtmlUsableUntil(value) > Date.now())) throw new Error("Preview resource URLs have expired");
      if (official && attempt > 0) reportPreviewRecovery(backend, { workspaceDir: input.workspace_dir,
        pageId: input.page_id!, event: "preview.recovered", errorKind: classifyPreviewError(failure), source: "current",
        requestedFingerprint: input.expected_preview_fingerprint, actualFingerprint: value.preview_source_fingerprint });
      return value;
    } catch (error) {
      failure = error;
      if (["identity_mismatch", "timeout"].includes(classifyPreviewError(error))) break;
    }
  }
  if (official) reportPreviewRecovery(backend, { workspaceDir: input.workspace_dir, pageId: input.page_id!,
    event: "preview.failed", errorKind: classifyPreviewError(failure), source: "none",
    requestedFingerprint: input.expected_preview_fingerprint });
  throw failure;
}

// Cancel survives navigation/remounts for this page version, but not a new version.
const dismissed = new Set<string>();
export function recoveryPromptDismissed(key: string) { return dismissed.has(key); }
export function dismissRecoveryPrompt(key: string) {
  dismissed.add(key);
  while (dismissed.size > 256) dismissed.delete(dismissed.values().next().value!);
}
const restoring = new Set<string>();
export function beginPageRecovery(workspaceDir: string, pageId: string): (() => void) | null {
  const key = JSON.stringify([workspaceDir, pageId]);
  if (restoring.has(key)) return null;
  restoring.add(key);
  return () => { restoring.delete(key); };
}
