import type { LinearResearchCheckpoint } from "../features/deck-generation/linearResearchWorkflow";
import type { PresentationRequirements, WorkspaceOutlineItem } from "./types";

export interface PageImageSearchContext {
  target_key: string;
  title: string;
  global_creation_requirements: string;
  page: Pick<WorkspaceOutlineItem, "title" | "content" | "creation_requirements" | "selected_image_ids" | "page_id">;
  opinion: string;
  requirements: PresentationRequirements;
}

export interface PageImageSearchResult {
  result_id: string;
  query: string;
  image_url: string;
  thumbnail_url?: string | null;
  source_url: string;
  final_url: string;
  title?: string | null;
  width?: number | null;
  height?: number | null;
  aps_path: string;
  aps_paths?: string[];
  source_urls?: string[];
  matched_queries?: string[];
  get_url: string;
  mime_type: string;
  bytes_size: number;
  sha256: string;
}

export interface PageImageSearchTask {
  id: string;
  context: PageImageSearchContext;
  max_searches: number;
  status: "running" | "completed" | "cancelled" | "failed";
  checkpoint: LinearResearchCheckpoint;
  result_ids: string[];
  /** Search results are absent in tasks persisted by older app versions. */
  results?: PageImageSearchResult[];
  error?: string;
  updated_at: string;
}
export interface PageImageSearchRequest {
  workspace_dir: string;
  action: "get" | "acquire" | "save" | "heartbeat" | "release";
  target_key?: string;
  owner?: string;
  task?: PageImageSearchTask;
}
