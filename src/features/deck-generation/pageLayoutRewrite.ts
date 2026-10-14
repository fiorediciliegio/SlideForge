import { creationRequirementsPrompt } from "../../ai/creationRequirementsPrompt";
import { slideFormat, slideFormatFromHtml, type SlideAspectRatio } from "../../slideFormat";
import type { PageLayoutAuditResult } from "../../api/types";
import type { Locale } from "../../i18n/messages";
import { generationText } from "./messages";
import type { AgentImageAttachment } from "../../runtime/annaRuntime";

export function buildPageLayoutRewritePrompt(html: string, aspectRatio?: SlideAspectRatio, requirements?: { global_creation_requirements?: string; creation_requirements?: string; refinementRequest?: string }): string {
  const { width, height } = aspectRatio ? slideFormat(aspectRatio) : slideFormatFromHtml(html);
  return `你是一名 HTML 演示页面设计专家。不要使用其他任何系统工具。

现在的 HTML 渲染效果如附件图片所示，用户希望美化当前页 HTML ，你需要检查：
1. 这页的 HTML 是否有溢出和遮挡问题。
2. 这页的 HTML 是否有大量的空白地方。

针对检查出的问题，你需要修复该问题，不要改动这页的文字内容。最后美化后的 HTML 要求：
1. 没有溢出和遮挡问题。
2. 没有大量的空白地方。
3. 不要过度修复，不要因为修复溢出和遮挡问题而造成大量的空白地方，也不要因为修复空白问题而造成溢出和遮挡

${creationRequirementsPrompt(requirements?.global_creation_requirements, requirements?.creation_requirements).join("\n")}
${requirements?.refinementRequest?.trim() ? `本轮修改意见（与既有要求冲突时优先，未涉及的要求仍有效）：\n${requirements.refinementRequest}` : ""}

## 图片来源约束
附件是当前页原始 HTML 的整页截图，仅用于观察和检查布局，不是页面正文配图。禁止将截图 URL 或截图附件下载地址写入返回的 HTML，不能作为正文图片、背景图，也不能通过裁切截图来替代原始配图。
必须逐字符保留本次输入的原始 HTML 中已有的 <img src>、srcset 和 CSS 背景图引用，不得替换为截图地址、附件地址、新的远程链接或虚构路径。
允许调整图片尺寸、位置、object-fit 和 object-position 等展示样式，但不得改变图片来源。原始 HTML 没有正文配图时，不得用页面截图补图。

## 当前的 HTML 内容:
\`\`\`html
${html}
\`\`\`

## HTML 生成约束

字号不要过小，要让观众能够看清，主要正文字号最低不应小于20px,次级解释文字最低不应小于18px
页面必须是完整、可运行的 HTML 文档，并包含唯一一个固定为 ${width}×${height} 的 .slide 根容器。
不要写磁盘上的文件，直接输出 HTML 给我，不要返回除了 HTML 外任何内容，也不要用代码块包裹 HTML。`;
}

export async function loadPageLayoutRewriteContext(
  audit: Pick<PageLayoutAuditResult, "page_id" | "source_html" | "screenshot_upload">,
  locale: Locale,
  signal?: AbortSignal,
): Promise<{ html: string; screenshotAttachment: AgentImageAttachment }> {
  const text = generationText(locale);
  if (typeof audit.source_html !== "string" || !audit.screenshot_upload?.url) {
    throw new Error(text.layoutRepairMissingSource);
  }
  signal?.throwIfAborted();
  const html = audit.source_html;
  if (!html.trim()) throw new Error(text.layoutRepairSourceEmpty);
  return {
    html,
    screenshotAttachment: {
      type: audit.screenshot_upload.mime_type,
      url: audit.screenshot_upload.url,
      filename: audit.screenshot_upload.filename ?? `${audit.page_id}.png`,
      detail: "auto",
    },
  };
}
