export interface GetWorkspacePageThumbnailInput {
  workspace_dir: string;
  page_id?: string;
  expected_preview_fingerprint?: string;
}
export interface PageThumbnail {
  version: 1;
  page_id: string;
  preview_source_fingerprint: string;
  width: number;
  height: number;
  size_bytes: number;
  generated_at: string;
  image_url: string;
  expires_at: string | null;
}
export type PageThumbnailTransport = Omit<PageThumbnail, "image_url" | "expires_at"> & {
  image_data_url: string;
};

export function decodePageThumbnail(value: PageThumbnailTransport, input: GetWorkspacePageThumbnailInput): PageThumbnail {
  if (value.version !== 1 || (input.page_id && value.page_id !== input.page_id)
    || (input.expected_preview_fingerprint && value.preview_source_fingerprint !== input.expected_preview_fingerprint)) {
    throw new Error("Page thumbnail version changed");
  }
  const { image_data_url, ...metadata } = value;
  if (typeof image_data_url !== "string" || !/^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/.test(image_data_url)) {
    throw new Error("Invalid WebP thumbnail transport");
  }
  return { ...metadata, image_url: image_data_url, expires_at: null };
}
