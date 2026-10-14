import type { AttachmentContext, UploadedSourceMaterial } from "../api/types";
import { IMAGE_ATTACHMENT_BRIEFS_ENABLED } from "../features/deck-generation/featureFlags";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export function isMainWorkflowAttachmentSource(source: UploadedSourceMaterial): boolean {
  return IMAGE_ATTACHMENT_BRIEFS_ENABLED || !(IMAGE_EXTENSIONS.has(source.extension.toLowerCase()) || source.mime_type?.startsWith("image/"));
}

/** 同样过滤旧工作区已保存的图片摘要，避免经需求或研究间接进入新大纲。 */
export function mainWorkflowAttachmentContext(context: AttachmentContext | null | undefined): AttachmentContext | null {
  if (!context) return null;
  if (IMAGE_ATTACHMENT_BRIEFS_ENABLED) return context;
  const briefs = context.attachment_context.filter((brief) => brief.original_reading_method !== "image_multimodal_read");
  return briefs.length ? { ...context, attachment_context: briefs } : null;
}
