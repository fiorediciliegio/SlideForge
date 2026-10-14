import type { HostUploadRef, SharedResearchImageAsset } from "./types";

/** Saved originals are usable even when an optional visual description is empty. */
export type PageUploadedImage = SharedResearchImageAsset;
export type PageImageUploadRequest = { workspace_dir: string } & (
  | { action: "commit"; filename: string; size_bytes: number; host_upload: HostUploadRef }
  | { action: "list_pending" }
  | { action: "prepare"; asset_id: string }
  | { action: "describe"; asset_id: string; description: string }
);
export interface PageImageUploadResult { images: PageUploadedImage[]; host_upload?: HostUploadRef }
