import type { HostUploadRef, WorkspaceOutlineItem } from "./types";

export interface PageRegenerationCandidate {
  id: string;
  status: "generating" | "rendering" | "ready" | "failed";
  error?: string;
  preview_fingerprint?: string;
  preview_error?: boolean;
}

export interface PageRegenerationBatch {
  mode?: "regenerate" | "beautify";
  source_html?: string;
  source_screenshot_upload?: HostUploadRef;
  id: string;
  page_id: string;
  page_index: number;
  status: "running" | "ready" | "adopted";
  outline: WorkspaceOutlineItem;
  reference_path: string;
  candidates: PageRegenerationCandidate[];
  selected_id?: string;
  created_at: string;
}

export type PageRegenerationInput = { workspace_dir: string } & (
  | { action: "create"; mode?: "regenerate" | "beautify"; page_id: string; count: number; outline: WorkspaceOutlineItem; reference_path: string; owner_id: string }
  | { action: "get"; batch_id?: string; page_id?: string; owner_id?: string; mode?: "regenerate" | "beautify" }
  | { action: "submit"; batch_id: string; candidate_id: string; content: string }
  | { action: "fail"; batch_id: string; candidate_id: string; error: string }
  | { action: "adopt"; batch_id: string; candidate_id: string }
);
