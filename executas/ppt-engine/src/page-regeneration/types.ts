import type { AppWorkspaceOutlineItem } from "../app-workspace/types.js";

export interface PageRegenerationCandidate {
  id: string;
  status: "generating" | "rendering" | "ready" | "failed";
  error?: string;
  source_path?: string;
  html_path?: string;
  screenshot_path?: string;
  source_sha256?: string;
  html_sha256?: string;
  screenshot_sha256?: string;
}

export interface PageRegenerationBatch {
  mode?: "regenerate" | "beautify";
  source_html_path?: string;
  source_snapshot_html_path?: string;
  source_screenshot_path?: string; // Legacy batches only.
  id: string;
  page_id: string;
  page_index: number;
  status: "running" | "ready" | "adopted";
  outline: AppWorkspaceOutlineItem;
  reference_path: string;
  base_fingerprint: string;
  candidates: PageRegenerationCandidate[];
  selected_id?: string;
  created_at: string;
  owner_id: string;
  lease_expires_at: number;
}
