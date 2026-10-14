import type { PptBackend } from "../../api/pptBackend";
import type { AgentImageAttachment } from "../../runtime/annaRuntime";
import { resolveOutlineImage, type OutlineImageAsset } from "../outline/images";
import { PAGE_IMAGE_ATTACHMENT_LIMIT } from "../outline/imageAttachmentLimit";

export interface PreparedPageImages {
  images: Array<OutlineImageAsset & { attachment_index: number | null }>;
  attachments: AgentImageAttachment[];
}

/** 附件与提示词清单共用已选顺序；上传失败直接失败，不能悄悄错位或跳图。 */
export async function preparePageImageAttachments(input: {
  backend: PptBackend;
  workspaceDir: string;
  selectedImageIds: string[];
  availableImages: OutlineImageAsset[];
}): Promise<PreparedPageImages> {
  const images = input.selectedImageIds.map((id, index) => {
    const asset = resolveOutlineImage(input.availableImages, id);
    if (!asset) throw new Error(`Assigned image is unavailable: ${id}`);
    return { ...asset, attachment_index: index < PAGE_IMAGE_ATTACHMENT_LIMIT ? index + 1 : null };
  });
  const operationId = `page-image-attachments-${crypto.randomUUID()}`;
  const attachments = await Promise.all(images.slice(0, PAGE_IMAGE_ATTACHMENT_LIMIT).map(async (image): Promise<AgentImageAttachment> => {
    const { host_upload } = await input.backend.uploadOutlineImageForAgent({
      workspace_dir: input.workspaceDir, asset_id: image.asset_id, operation_id: operationId,
    });
    if (!host_upload.url || !host_upload.mime_type.startsWith("image/")) {
      throw new Error(`Invalid image attachment: ${image.asset_id}`);
    }
    return { type: host_upload.mime_type, url: host_upload.url, filename: host_upload.filename, detail: "auto" };
  }));
  return { images, attachments };
}
