import type { AuditIssue, AuditOverlap, LayoutAuditReport } from "./types.js";

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function issueLine(issue: AuditIssue, elements: LayoutAuditReport["slides"][number]["elements"]): string {
  const selectors = issue.elementIndices
    .map((index) => elements.find((element) => element.index === index)?.selector ?? `#${index}`)
    .join(" 与 ");
  return `- **${issue.severity.toUpperCase()}** \`${issue.rule}\`：${issue.message}${selectors ? `（${selectors}）` : ""}`;
}

function overlapLine(overlap: AuditOverlap, elements: LayoutAuditReport["slides"][number]["elements"]): string {
  const first = elements.find((element) => element.index === overlap.firstIndex);
  const second = elements.find((element) => element.index === overlap.secondIndex);
  return `- ${overlap.severity === "ignored" ? "忽略" : overlap.severity}：${first?.selector ?? `#${overlap.firstIndex}`} ↔ ${second?.selector ?? `#${overlap.secondIndex}`}，交集 ${formatNumber(overlap.intersection.width)}×${formatNumber(overlap.intersection.height)}，占较小元素 ${(overlap.smallerElementRatio * 100).toFixed(1)}%`;
}

export function renderAuditMarkdown(report: LayoutAuditReport): string {
  const lines = [
    "# PPT DOM 几何审计报告",
    "",
    `- 输入：\`${report.input}\``,
    `- 生成时间：${report.generatedAt}`,
    `- 画布：${report.viewport.width} × ${report.viewport.height}`,
    `- slide 数量：${report.summary.slideCount}`,
    `- 可见元素：${report.summary.visibleElementCount}`,
    `- 问题：${report.summary.issueCount}（严重 ${report.summary.errorCount}，提示/可疑 ${report.summary.warningCount}）`,
    "",
    `> ${report.metadata.heuristicNote}`,
  ];
  for (const slide of report.slides) {
    lines.push("", `## Slide ${slide.slideIndex}`, "", `- 根选择器：\`${slide.selector}\``, `- 根尺寸：${formatNumber(slide.rect.width)} × ${formatNumber(slide.rect.height)}`, `- 渲染状态：${slide.renderState}`);
    lines.push("", "### 问题");
    if (slide.issues.length === 0) lines.push("", "无确定性几何问题。");
    else for (const issue of slide.issues) lines.push(issueLine(issue, slide.elements));
    lines.push("", `### 原始重叠对（${slide.rawOverlaps.length}）`);
    if (slide.rawOverlaps.length === 0) lines.push("", "无矩形相交。");
    else for (const overlap of slide.rawOverlaps) lines.push(overlapLine(overlap, slide.elements));
  }
  return `${lines.join("\n")}\n`;
}
