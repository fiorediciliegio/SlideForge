import type { AgentClient } from "../../agent/agentClient";
import type { AiInteractionLogger } from "../../ai/interactionLog";
import type { PptBackend } from "../../api/pptBackend";
import type { AppHostUploadClient } from "../../runtime/appHostUploadClient";
import type { Locale } from "../../i18n";
import type { OutlineImageAsset } from "../outline/images";

export const PAGE_IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif";
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
export function validatePageImageFile(file: Pick<File, "name" | "size">) {
  const mime = MIME[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!mime || !file.size || file.name.length > 180) throw new Error("PAGE_IMAGE_INVALID_FILE");
  if (file.size > 25 * 1024 * 1024) throw new Error("PAGE_IMAGE_FILE_TOO_LARGE");
  return mime;
}

export function parsePageImageDescription(value: unknown): string {
  const record = value as { description?: unknown; error?: unknown } | null;
  if (!record || record.error || typeof record.description !== "string" || !record.description.trim() || record.description.trim().length > 400) {
    throw new Error("Return a visible-image description of 1–400 characters; never guess an unavailable image.");
  }
  return record.description.trim();
}

export interface PageImageDescriptionItem {
  attachment_index: number;
  description?: string;
  error?: string;
}

export interface PageImageDescriptionAttachment {
  url: string;
  mime_type: string;
  filename?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parsePageImageDescriptions(value: unknown, expectedCount: number): PageImageDescriptionItem[] {
  if (!isRecord(value) || !Array.isArray(value.descriptions) || value.descriptions.length !== expectedCount) {
    throw new Error(`Return exactly ${expectedCount} image descriptions.`);
  }
  const items = value.descriptions.map((item, index) => {
    if (!isRecord(item) || !Number.isInteger(item.attachment_index) || item.attachment_index !== index + 1) {
      throw new Error("Image descriptions must use consecutive attachment_index values starting at 1.");
    }
    const description = typeof item.description === "string" ? item.description.trim() : "";
    const error = typeof item.error === "string" ? item.error.trim() : "";
    if (description && error) throw new Error("Each image description must contain either description or error, not both.");
    if (!description && !error) throw new Error("Each image description must contain description or error.");
    if (description.length > 400) throw new Error("Each image description must be 1–400 characters.");
    return {
      attachment_index: item.attachment_index,
      ...(description ? { description } : {}),
      ...(error ? { error } : {}),
    };
  });
  return items;
}

export async function describeImageAttachments(input: {
  agent: AgentClient;
  attachments: PageImageDescriptionAttachment[];
  locale: Locale;
  workspaceDir: string;
  logger?: AiInteractionLogger | null;
  operationId?: string;
  retryUnavailable?: boolean;
  signal?: AbortSignal;
  isCancelled?: () => boolean;
  onDescriptions?: (items: PageImageDescriptionItem[]) => void;
}): Promise<PageImageDescriptionItem[]> {
  if (!input.attachments.length) return [];
  const successful = new Map<number, PageImageDescriptionItem>();
  return input.agent.runStructuredPrompt([
    "用户选择了这些图片作为 PPT 配图。请实际查看每一张附件，分别用一句话描述图片内容，供页面创作Agent理解图片。",
    "附件按 1 开始的 attachment_index 顺序对应。必须检查每一张图片；不要交换编号。",
    `描述语言：${({ zh: "简体中文", en: "English", ja: "日本語", de: "Deutsch" })[input.locale]}。`,
    `只返回 JSON：${JSON.stringify({ descriptions: input.attachments.map((_, index) => ({ attachment_index: index + 1, description: "一句话图片描述" })) })}。每项必须返回 description（最多 400 字符）；无法看到对应图片时返回 error 为 IMAGE_NOT_AVAILABLE，不要猜测。`,
  ].join("\n"), (value) => {
    const parsed = parsePageImageDescriptions(value, input.attachments.length);
    for (const item of parsed) if (item.description) successful.set(item.attachment_index, item);
    const merged = parsed.map((item) => successful.get(item.attachment_index) ?? item);
    input.onDescriptions?.(merged);
    if (input.retryUnavailable && merged.some((item) => item.error)) throw new Error("IMAGE_NOT_AVAILABLE: inspect every attachment again and return descriptions for the unavailable images; never guess.");
    return merged;
  }, {
    signal: input.signal,
    isCancelled: input.isCancelled,
    sessionTools: [], toolAccessPolicy: "off",
    modelPreference: "google/gemini-3.8-flash",
    attachments: input.attachments.map((attachment) => ({
      type: attachment.mime_type,
      url: attachment.url,
      filename: attachment.filename,
      detail: "auto" as const,
    })),
    logContext: {
      logger: input.logger ?? undefined,
      workspace_dir: input.workspaceDir,
      domain: "outline",
      operation: "page_image_description",
      operation_id: input.operationId ?? `batch-${crypto.randomUUID()}`,
    },
  });
}

export interface PageImageUploadService {
  upload(file: File): Promise<OutlineImageAsset>;
}

export function createPageImageUploadService(input: {
  backend: PptBackend; upload: AppHostUploadClient; workspaceDir: string;
}): PageImageUploadService {
  const workspace_dir = input.workspaceDir;
  return {
    async upload(file) {
      const mimeType = validatePageImageFile(file);
      const reference = await input.upload.uploadFile(file, { purpose: "image_input", mimeType,
        metadata: { workspace_dir, source: "ppt-app.page-image-upload" } });
      const result = await input.backend.pageImageUpload({ workspace_dir, action: "commit", filename: file.name, size_bytes: file.size, host_upload: reference });
      const image = result.images[0];
      if (!image) throw new Error("PAGE_IMAGE_UPLOAD_FAILED");
      return { ...image, source: /^(manual-upload|uploaded-source):\/\//.test(image.source_url) ? "uploaded" : "search" };
    },
  };
}
