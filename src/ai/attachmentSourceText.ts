import { mainWorkflowAttachmentContext } from "./attachmentBriefPolicy";
import type { AttachmentBrief, AttachmentContext } from "../api/types";

export const NO_ATTACHMENT_SOURCES = "（本次没有可用的上传资料）";

function section(lines: string[], heading: string, values: string[]) {
  const usable = values.map((value) => value.trim()).filter(Boolean);
  if (usable.length === 0) return;
  lines.push(`${heading}：`);
  for (const value of usable) lines.push(`- ${value}`);
  lines.push("");
}

/**
 * summarized_context 附件没有 `content` 原文，事实分散在多个字段里。
 * 这里把它们摊平成可读文本，让大纲能直接引用其中的事实和数字。
 */
function renderSummarizedBrief(brief: AttachmentBrief): string[] {
  const lines: string[] = [];
  if (brief.relationship_to_task?.trim()) {
    lines.push(`与本次任务的关系：${brief.relationship_to_task.trim()}`, "");
  }
  if (brief.main_message?.trim()) {
    lines.push(`核心信息：${brief.main_message.trim()}`, "");
  }
  if (brief.key_facts.length > 0) {
    lines.push("关键事实：");
    for (const fact of brief.key_facts) {
      const label = fact.source_label?.trim();
      lines.push(`- ${fact.fact.trim()}${label ? `（来源：${label}）` : ""}`);
      if (fact.excerpt?.trim()) lines.push(`  原文：${fact.excerpt.trim()}`);
    }
    lines.push("");
  }
  section(lines, "必须纳入的内容", brief.must_include.map((item) => item.requirement));
  section(lines, "必须避免的表述", brief.must_avoid);
  section(lines, "建议的叙事线", brief.recommended_storyline);
  section(lines, "资料缺口", brief.gaps);
  section(lines, "未读取的内容", brief.unread_content);
  if (brief.sheet_coverage?.length) {
    lines.push("工作表覆盖情况：");
    for (const sheet of brief.sheet_coverage) {
      const reason = sheet.reason?.trim();
      lines.push(`- ${sheet.sheet_name}：${sheet.status}${reason ? `（${reason}）` : ""}`);
    }
    lines.push("");
  }
  return lines;
}

function renderBrief(brief: AttachmentBrief): string {
  const heading = `### 附件：${brief.filename}`;
  // full_context 附件的提取原文已经是可直接引用的成稿，原样给出。
  const body = brief.content?.trim()
    ? [brief.content.trim()]
    : renderSummarizedBrief(brief);
  const text = body.join("\n").trim();
  return text ? `${heading}\n\n${text}` : "";
}

/**
 * 把附件整理成可嵌入提示词的纯文本。
 *
 * 简单附件走提取原文，复杂附件走结构化字段摊平；两者都不再以 JSON 形式注入，
 * 因为大纲需要直接读到事实和数字才能现场计算派生指标。
 */
export function formatAttachmentSourcesForPrompt(
  context: AttachmentContext | null | undefined,
): string {
  const briefs = mainWorkflowAttachmentContext(context)?.attachment_context ?? [];
  const rendered = briefs.map(renderBrief).filter(Boolean);
  return rendered.length > 0 ? rendered.join("\n\n") : NO_ATTACHMENT_SOURCES;
}
