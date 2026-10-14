export interface GetWorkspacePageHtmlInput {
  workspace_dir: string;
  page_id?: string;
  batch_id?: string;
  candidate_id?: string;
  expected_preview_fingerprint?: string;
  /** Explicit view-only recovery; never allowed for generation candidates. */
  fallback_only?: boolean;
}
export interface PreviewFallback {
  source: "saved_snapshot" | "manual_base" | "thumbnail" | "cached_html";
}
export interface WorkspacePageHtml {
  page_id: string;
  html: string;
  html_fingerprint: string;
  preview_source_fingerprint: string;
  resources_expires_at: string | null;
  fallback?: PreviewFallback;
}

export interface PagePreviewPreparation {
  task_id: string;
  workspace_dir: string;
  page_id: string;
  status: "queued" | "running" | "ready" | "error";
  input_version: string;
  preview_source_fingerprint?: string;
  error?: string;
}
