import { access, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  AgentAuditReport,
  AgentProblem,
  AgentSlideReport,
  AuditElement,
  AuditIssue,
  AuditRule,
  AuditSeverity,
  AuditSlideReport,
  AuditSourceHint,
  LayoutAuditReport,
} from "./types.js";

const SEVERITY_RANK: Record<AuditSeverity, number> = {
  info: 0,
  warning: 1,
  suspicious: 2,
  error: 3,
};

function maxSeverity(first: AuditSeverity, second: AuditSeverity): AuditSeverity {
  return SEVERITY_RANK[first] >= SEVERITY_RANK[second] ? first : second;
}

function issueTargets(issue: AuditIssue): number[] {
  return [...new Set(issue.elementIndices)];
}

function isRelatedElement(first: number, second: number, elementsByIndex: Map<number, AuditElement>): boolean {
  if (first === second) return true;
  const firstElement = elementsByIndex.get(first);
  const secondElement = elementsByIndex.get(second);
  if (!firstElement || !secondElement) return false;
  return firstElement.ancestorIndices.includes(second) || secondElement.ancestorIndices.includes(first);
}

function hasRelatedTarget(first: AuditIssue, second: AuditIssue, elementsByIndex: Map<number, AuditElement>): boolean {
  return issueTargets(first).some((firstIndex) => issueTargets(second)
    .some((secondIndex) => isRelatedElement(firstIndex, secondIndex, elementsByIndex)));
}

function overflowDirection(issue: AuditIssue): string | null {
  const overflow = issue.details?.overflow;
  if (!overflow || typeof overflow !== "object") return null;
  const values = overflow as Record<string, unknown>;
  const pairs = [
    ["left", values.left],
    ["right", values.right],
    ["top", values.top],
    ["bottom", values.bottom],
  ] as const;
  const positive = pairs
    .map(([name, value]) => ({ name, value: typeof value === "number" ? value : 0 }))
    .filter((item) => item.value > 1)
    .sort((first, second) => second.value - first.value);
  return positive[0]?.name ?? null;
}

function shouldGroupIssues(
  first: AuditIssue,
  second: AuditIssue,
  elementsByIndex: Map<number, AuditElement>,
): boolean {
  const firstOverlap = first.rule === "ELEMENT_OVERLAP";
  const secondOverlap = second.rule === "ELEMENT_OVERLAP";
  if (firstOverlap || secondOverlap) {
    return firstOverlap && secondOverlap && issueTargets(first).some((index) => issueTargets(second).includes(index));
  }

  if (first.rule === "BROKEN_IMAGE" || second.rule === "BROKEN_IMAGE") return false;
  if (!hasRelatedTarget(first, second, elementsByIndex)) {
    const sameOverflowDirection = overflowDirection(first) !== null && overflowDirection(first) === overflowDirection(second);
    return first.rule === "SLIDE_OUT_OF_BOUNDS" && second.rule === "SLIDE_OUT_OF_BOUNDS" && sameOverflowDirection;
  }
  return (
    first.rule === second.rule
    || first.rule === "SLIDE_OUT_OF_BOUNDS"
    || second.rule === "SLIDE_OUT_OF_BOUNDS"
    || first.rule === "CONTAINER_OVERFLOW"
    || second.rule === "CONTAINER_OVERFLOW"
    || first.rule === "TEXT_OVERFLOW"
    || second.rule === "TEXT_OVERFLOW"
  );
}

function createUnionFind(size: number): { find: (index: number) => number; union: (first: number, second: number) => void } {
  const parents = Array.from({ length: size }, (_, index) => index);
  const find = (index: number): number => {
    if (parents[index] === index) return index;
    parents[index] = find(parents[index]!);
    return parents[index]!;
  };
  const union = (first: number, second: number): void => {
    const firstRoot = find(first);
    const secondRoot = find(second);
    if (firstRoot !== secondRoot) parents[secondRoot] = firstRoot;
  };
  return { find, union };
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function choosePrimaryElement(
  targetIndices: number[],
  issueTargetsInGroup: number[],
  elementsByIndex: Map<number, AuditElement>,
  canvas: { width: number; height: number },
): AuditElement | null {
  const uniqueTargets = [...new Set(targetIndices)];
  const candidates = uniqueTargets
    .map((index) => elementsByIndex.get(index))
    .filter((element): element is AuditElement => Boolean(element))
    .filter((element) => element.rect.width * element.rect.height < canvas.width * canvas.height * 0.85);
  return (candidates.length > 0 ? candidates : uniqueTargets
    .map((index) => elementsByIndex.get(index))
    .filter((element): element is AuditElement => Boolean(element)))
    .sort((first, second) => {
      const firstCoverage = issueTargetsInGroup.filter((index) => elementsByIndex.get(index)?.ancestorIndices.includes(first.index)).length;
      const secondCoverage = issueTargetsInGroup.filter((index) => elementsByIndex.get(index)?.ancestorIndices.includes(second.index)).length;
      if (firstCoverage !== secondCoverage) return secondCoverage - firstCoverage;
      return (second.rect.width * second.rect.height) - (first.rect.width * first.rect.height);
    })[0] ?? null;
}

function inferTitle(rules: AuditRule[]): string {
  if (rules.includes("SLIDE_OUT_OF_BOUNDS") || rules.includes("CONTAINER_OVERFLOW")) return "内容区域超出可用空间";
  if (rules.includes("TEXT_RING_CONTACT")) return "文字与装饰环相触";
  if (rules.includes("TEXT_FRAME_CONTACT")) return "文字与边框带相触";
  if (rules.includes("TEXT_OVERFLOW")) return "文本内容超出文本框";
  if (rules.includes("BROKEN_IMAGE")) return "图片资源加载失败";
  if (rules.includes("ELEMENT_OVERLAP")) return "非祖先关系元素发生重叠";
  return "PPT 布局几何异常";
}

function inferDiagnosis(rules: AuditRule[], affectedElementCount: number): string {
  if (rules.includes("SLIDE_OUT_OF_BOUNDS") || rules.includes("CONTAINER_OVERFLOW")) {
    return `检测到内容超出 slide 或容器可用空间，${affectedElementCount} 个相关元素被归并为同一布局问题。`;
  }
  if (rules.includes("TEXT_RING_CONTACT")) return "文字字形与 bg-frame 装饰环真实重叠，属于口径 A 下的确定性溢出。";
  if (rules.includes("TEXT_FRAME_CONTACT")) return "文字字形与普通元素边框带真实重叠；该类压线/骑缝在正负样本中同构，先作为待复核提示。";
  if (rules.includes("TEXT_OVERFLOW")) return "文本的滚动尺寸超过了声明的文本框尺寸。";
  if (rules.includes("BROKEN_IMAGE")) return "图片元素已完成加载流程，但浏览器没有获得有效的自然尺寸。";
  if (rules.includes("ELEMENT_OVERLAP")) return `检测到非祖先关系元素的矩形相交，${affectedElementCount} 个相关元素被归并为同一重叠问题。`;
  return "检测到需要进一步检查的布局几何异常。";
}

function likelyFixes(rules: AuditRule[]): string[] {
  if (rules.includes("SLIDE_OUT_OF_BOUNDS") || rules.includes("CONTAINER_OVERFLOW")) {
    return [
      "检查父级布局的可用宽高与 gap/padding 总和",
      "检查 flex/grid 子项的 min-width/min-height 是否阻止收缩",
      "检查图片、卡片和 footer 是否共同竞争同一段空间",
    ];
  }
  if (rules.includes("TEXT_RING_CONTACT")) return ["调整 footer/正文与 bg-frame 装饰环的间距或层级，避免文字压入边框带"];
  if (rules.includes("TEXT_FRAME_CONTACT")) return ["复核轴标签、角标等文字与边框带的间距；若设计规范不允许骑线则调整位置"];
  if (rules.includes("TEXT_OVERFLOW")) return ["检查字体、行高、文本框尺寸和 white-space 设置"];
  if (rules.includes("BROKEN_IMAGE")) return ["检查图片路径、文件存在性、浏览器资源访问权限和图片格式"];
  if (rules.includes("ELEMENT_OVERLAP")) return ["检查两个内容模块的定位、尺寸、z-index 和间距"];
  return [];
}

function extractPageId(input: string, slide: AuditSlideReport): string | null {
  if (slide.pageId) return slide.pageId;
  const matches = input.match(/page-([0-9a-f]{8}-[0-9a-f-]{27,})/gi) ?? [];
  const last = matches.at(-1);
  return last ? last.slice("page-".length) : null;
}

async function resolveTsxFile(input: string, pageId: string | null): Promise<string | null> {
  if (!pageId) return null;
  const outputMarker = `${path.sep}output${path.sep}`;
  const outputIndex = input.indexOf(outputMarker);
  if (outputIndex < 0) return null;
  const workspaceRoot = input.slice(0, outputIndex);
  const normalizedPageId = pageId.startsWith("page-") ? pageId.slice("page-".length) : pageId;
  const candidate = path.join(workspaceRoot, "slides", `page-${normalizedPageId}.tsx`);
  try {
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function normalizeForSearch(value: string): string {
  return value.replace(/\s+/g, "").replace(/[“”‘’"']/g, "");
}

async function findSourceAnchor(
  tsxFile: string | null,
  elements: AuditElement[],
  targetIndices: number[],
): Promise<Pick<AuditSourceHint, "anchorText" | "likelyLineStart" | "likelyLineEnd">> {
  const targetTexts = targetIndices
    .map((index) => elements.find((element) => element.index === index)?.text ?? "")
    .map(compactText)
    .filter((text) => text.length >= 4);
  const anchorText = targetTexts[0] ?? null;
  if (!tsxFile || !anchorText) return { anchorText, likelyLineStart: null, likelyLineEnd: null };
  const source = await readFile(tsxFile, "utf8");
  const normalizedAnchor = normalizeForSearch(anchorText);
  const lines = source.split(/\r?\n/);
  const lineIndex = lines.findIndex((line) => normalizeForSearch(line).includes(normalizedAnchor));
  if (lineIndex >= 0) {
    return { anchorText, likelyLineStart: lineIndex + 1, likelyLineEnd: lineIndex + 1 };
  }
  const tokens = [
    ...(anchorText.match(/[\u4e00-\u9fff]{4,}/g) ?? []),
    ...anchorText.split(/[，。！？：:、/\\|\s]+/).filter((token) => token.length >= 4),
  ];
  const matched = tokens
    .map((token) => ({
      token,
      lineIndex: lines.findIndex((line) => normalizeForSearch(line).includes(normalizeForSearch(token))),
    }))
    .find((item) => item.lineIndex >= 0);
  const tokenIndex = matched?.lineIndex ?? -1;
  return {
    anchorText: matched?.token ?? anchorText,
    likelyLineStart: tokenIndex >= 0 ? tokenIndex + 1 : null,
    likelyLineEnd: tokenIndex >= 0 ? tokenIndex + 1 : null,
  };
}

async function buildSourceHint(
  input: string,
  slide: AuditSlideReport,
  elements: AuditElement[],
  targetIndices: number[],
): Promise<AuditSourceHint> {
  const pageId = extractPageId(input, slide);
  const tsxFile = await resolveTsxFile(input, pageId);
  const anchor = await findSourceAnchor(tsxFile, elements, targetIndices);
  return { pageId, tsxFile, ...anchor };
}

async function buildSlideProblems(
  input: string,
  slide: AuditSlideReport,
): Promise<AgentProblem[]> {
  const elementsByIndex = new Map(slide.elements.map((element) => [element.index, element]));
  const unionFind = createUnionFind(slide.issues.length);
  for (let firstIndex = 0; firstIndex < slide.issues.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < slide.issues.length; secondIndex += 1) {
      if (shouldGroupIssues(slide.issues[firstIndex]!, slide.issues[secondIndex]!, elementsByIndex)) {
        unionFind.union(firstIndex, secondIndex);
      }
    }
  }
  const grouped = new Map<number, AuditIssue[]>();
  slide.issues.forEach((issue, index) => {
    const root = unionFind.find(index);
    const group = grouped.get(root) ?? [];
    group.push(issue);
    grouped.set(root, group);
  });

  const problems: AgentProblem[] = [];
  for (const [groupIndex, issues] of grouped.entries()) {
    const rules = [...new Set(issues.map((issue) => issue.rule))];
    const allTargetIndices = [...new Set(issues.flatMap(issueTargets))];
    const primary = choosePrimaryElement(allTargetIndices, allTargetIndices, elementsByIndex, slide.canvas);
    const targetIndices = primary
      ? [primary.index, ...allTargetIndices.filter((index) => index !== primary.index).slice(0, rules.includes("ELEMENT_OVERLAP") ? 1 : 2)]
      : allTargetIndices.slice(0, 3);
    const targetElements = targetIndices
      .map((index) => elementsByIndex.get(index))
      .filter((element): element is AuditElement => Boolean(element));
    const severity = issues.reduce((current, issue) => maxSeverity(current, issue.severity), "info" as AuditSeverity);
    const sourceHint = await buildSourceHint(input, slide, slide.elements, targetIndices);
    const evidence = {
      overflows: issues.map((issue) => issue.details?.overflow).filter(Boolean).slice(0, 4),
      intersections: issues.map((issue) => issue.details?.intersection).filter(Boolean).slice(0, 4),
      sampleTexts: targetElements.map((element) => compactText(element.text)).filter(Boolean),
    };
    problems.push({
      problemId: `slide-${slide.slideIndex}-problem-${problems.length + 1}`,
      rules,
      severity,
      confidence: rules.includes("ELEMENT_OVERLAP") ? 0.75 : rules.includes("BROKEN_IMAGE") ? 0.7 : 0.9,
      title: inferTitle(rules),
      diagnosis: inferDiagnosis(rules, allTargetIndices.length),
      target: {
        elementIndices: targetIndices,
        selectors: targetElements.map((element) => element.selector),
        texts: targetElements.map((element) => compactText(element.text)).filter(Boolean),
        rects: targetElements.map((element) => element.rect),
      },
      affectedElementCount: allTargetIndices.length,
      evidence,
      sourceHint: {
        anchorText: sourceHint.anchorText,
        likelyLineStart: sourceHint.likelyLineStart,
        likelyLineEnd: sourceHint.likelyLineEnd,
      },
      detailsRef: `#/slides/${slide.slideIndex - 1}/issues`,
    });
    void groupIndex;
  }
  return problems;
}

export async function buildAgentAuditReport(report: LayoutAuditReport): Promise<AgentAuditReport> {
  const slides: AgentSlideReport[] = [];
  for (const slide of report.slides) {
    const pageId = extractPageId(report.input, slide);
    const tsxFile = await resolveTsxFile(report.input, pageId);
    slides.push({
      slideIndex: slide.slideIndex,
      pageId,
      tsxFile,
      renderState: slide.renderState,
      problems: await buildSlideProblems(report.input, slide),
    });
  }
  const problems = slides.flatMap((slide) => slide.problems);
  return {
    schemaVersion: 1,
    reportType: "agent",
    input: report.input,
    generatedAt: report.generatedAt,
    viewport: report.viewport,
    summary: {
      slideCount: slides.length,
      problemCount: problems.length,
      errorCount: problems.filter((problem) => problem.severity === "error").length,
      warningCount: problems.filter((problem) => problem.severity === "warning" || problem.severity === "suspicious").length,
      slidesWithProblems: slides.filter((slide) => slide.problems.length > 0).length,
    },
    slides,
    debugReport: {
      available: true,
      note: "完整元素索引和原始重叠对保留在同次审计生成的 debug JSON 中；Agent 默认只消费本精简报告。",
    },
  };
}
