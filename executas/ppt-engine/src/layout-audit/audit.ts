import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { waitForRenderReady } from "../runtime/browser-runtime.js";
import {
  installRenderReadinessTracking,
  waitForRenderReadiness,
} from "../render/static-html.js";
import {
  scaleBrowserOperationTimeout,
  withQueuedManagedPage,
  type ManagedPageLike,
} from "../render/managed-page.js";
import { classifyOverlapSeverity, intersectRects, isMeaningfulOverflow, overflowDelta, rectArea } from "./geometry.js";
import type {
  AuditBorderBand,
  AuditElement,
  AuditIssue,
  AuditOverlap,
  AuditRect,
  AuditSeverity,
  AuditTextLineRect,
  AuditSlideReport,
  LayoutAuditOptions,
  LayoutAuditReport,
} from "./types.js";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 100_000;
const MAX_ELEMENTS_PER_SLIDE = 800;

interface CollectedSlide {
  pageId: string | null;
  selector: string;
  rect: AuditRect;
  renderState: AuditSlideReport["renderState"];
  elements: AuditElement[];
}

function isDecorative(element: AuditElement): boolean {
  const classText = `${element.className} ${element.tagName}`.toLowerCase();
  return element.rect.width <= 3 || element.rect.height <= 3 ||
    /divider|separator|decoration|background|timeline-node|dot|icon|frame|line/.test(classText);
}

function isDecorativeLoose(element: AuditElement, maxOver: number): boolean {
  if (maxOver >= 30) return false;
  const classText = `${element.className} ${element.tagName}`.toLowerCase();
  return /card-badge|featured-badge|badge|tag|stamp|source-note|time-stamp/.test(classText);
}

function isTableInternal(element: AuditElement): boolean {
  const tableTags = new Set(["tbody", "thead", "tfoot", "tr", "td", "th", "col", "colgroup", "caption"]);
  return tableTags.has(element.tagName);
}

function isAncestorPair(first: AuditElement, second: AuditElement): boolean {
  return first.ancestorIndices.includes(second.index) || second.ancestorIndices.includes(first.index);
}

function isExpectedImageTextOverlay(first: AuditElement, second: AuditElement): boolean {
  const siblings = first.parentIndex !== null && first.parentIndex === second.parentIndex;
  return siblings && ((first.isImage && Boolean(second.text.trim())) || (second.isImage && Boolean(first.text.trim())));
}

function glyphRect(line: AuditTextLineRect): AuditRect {
  const ratio = Math.min(1, line.fontSize / line.lineHeight);
  const height = line.height * ratio;
  const y = line.y + (line.height - height) / 2;
  return { x: line.x, y, width: line.width, height, right: line.right, bottom: y + height };
}

function rectContactDepth(first: AuditRect, second: AuditRect): number {
  const intersection = intersectRects(first, second);
  return intersection ? Math.min(intersection.width, intersection.height) : 0;
}

function createIssue(
  rule: AuditIssue["rule"],
  severity: AuditSeverity,
  message: string,
  elementIndices: number[],
  details?: Record<string, unknown>,
): AuditIssue {
  return { rule, severity, message, elementIndices, details };
}

function analyzeSlide(
  collected: CollectedSlide,
  canvas: { width: number; height: number },
  thresholds: NonNullable<LayoutAuditOptions["overlapThresholds"]>,
): AuditSlideReport {
  const issues: AuditIssue[] = [];
  const rootIndex = collected.elements.find((element) => element.selector === collected.selector)?.index ?? 0;
  const elements = collected.elements;
  const root = elements.find((element) => element.index === rootIndex);

  if (collected.renderState !== "ready") {
    issues.push(createIssue(
      "RENDER_STATE",
      "error",
      `Slide 渲染状态为 ${collected.renderState}，几何结果可能不完整`,
      root ? [root.index] : [],
    ));
  }

  for (const element of elements) {
    if (element.index === rootIndex) continue;
    const delta = overflowDelta(element.rect, canvas);
    if (isMeaningfulOverflow(delta, 4)) {
      const maxOverflow = Math.max(delta.left, delta.top, delta.right, delta.bottom);
      // 无文本内容且溢出 < 10px 过滤（精度误差）
      if (!element.text.trim() && maxOverflow < 10) continue;
      // table 子元素过滤（非 table 本身）
      if (element.tagName !== "table" && element.ancestorIndices.some((ancestorIndex) => elements[ancestorIndex]?.tagName === "table")) continue;
      issues.push(createIssue(
        "SLIDE_OUT_OF_BOUNDS",
        maxOverflow > 12 ? "error" : "warning",
        `元素 ${element.selector} 超出 slide 画布边界`,
        [element.index],
        { overflow: delta, rect: element.rect },
      ));
    }
  }

  for (const container of elements) {
    if (container.index === rootIndex) continue;
    // 跳过 table 作为容器（table 子元素溢出由 SLIDE_OUT_OF_BOUNDS 统一处理）
    if (container.tagName === "table") continue;
    const scrollOverflow = {
      right: Math.max(0, container.scrollWidth - container.clientWidth),
      bottom: Math.max(0, container.scrollHeight - container.clientHeight),
    };
    const clipped = container.overflowX !== "visible" || container.overflowY !== "visible";
    const descendants = elements.filter((element) => element.ancestorIndices.includes(container.index));
    let maxChildOverflow = { left: 0, top: 0, right: 0, bottom: 0 };
    for (const child of descendants) {
      // 跳过 table 内部结构元素
      if (isTableInternal(child)) continue;
      maxChildOverflow = {
        left: Math.max(maxChildOverflow.left, container.rect.x - child.rect.x),
        top: Math.max(maxChildOverflow.top, container.rect.y - child.rect.y),
        right: Math.max(maxChildOverflow.right, child.rect.right - container.rect.right),
        bottom: Math.max(maxChildOverflow.bottom, child.rect.bottom - container.rect.bottom),
      };
    }
    const delta = {
      left: Math.max(0, maxChildOverflow.left),
      top: Math.max(0, maxChildOverflow.top),
      right: Math.max(scrollOverflow.right, maxChildOverflow.right),
      bottom: Math.max(scrollOverflow.bottom, maxChildOverflow.bottom),
    };
    if (clipped && isMeaningfulOverflow(delta, 4)) {
      issues.push(createIssue(
        "CONTAINER_OVERFLOW",
        Math.max(delta.left, delta.top, delta.right, delta.bottom) > 12 ? "error" : "warning",
        `容器 ${container.selector} 的内容超出自身边界${clipped ? "并可能被裁切" : ""}`,
        [container.index],
        { overflow: delta, rect: container.rect, overflowX: container.overflowX, overflowY: container.overflowY },
      ));
    }
  }

  // ABSOLUTE_POSITION_OVERFLOW: 检测绝对定位/固定定位元素是否超出定位上下文边界
  for (const element of elements) {
    if (element.index === rootIndex) continue;
    if (element.position !== "absolute" && element.position !== "fixed") continue;
    if (isDecorative(element)) continue;
    if (!element.text.trim()) continue;

    const contextIndex = element.positioningContextIndex;
    if (contextIndex === null || contextIndex === element.index) continue;
    const context = elements.find((e) => e.index === contextIndex);
    if (!context) continue;

    const leftOver = Math.max(0, context.rect.x - element.rect.x);
    const topOver = Math.max(0, context.rect.y - element.rect.y);
    const rightOver = Math.max(0, element.rect.right - context.rect.right);
    const bottomOver = Math.max(0, element.rect.bottom - context.rect.bottom);
    const maxOver = Math.max(leftOver, topOver, rightOver, bottomOver);

    if (isDecorativeLoose(element, maxOver)) continue;

    if (maxOver > 4) {
      issues.push(createIssue(
        "CONTAINER_OVERFLOW",
        maxOver > 12 ? "error" : "warning",
        `绝对定位元素 ${element.selector} 超出定位上下文 ${context.selector} 边界`,
        [element.index, context.index],
        { overflow: { left: leftOver, top: topOver, right: rightOver, bottom: bottomOver }, rect: element.rect, contextRect: context.rect },
      ));
    }
  }

  for (const element of elements) {
    if (!element.isTextLeaf || !element.text.trim() || element.index === rootIndex) continue;
    const scrollOverflow = {
      right: Math.max(0, element.scrollWidth - element.clientWidth),
      bottom: Math.max(0, element.scrollHeight - element.clientHeight),
    };
    if (scrollOverflow.right > 1 || scrollOverflow.bottom > 1) {
      issues.push(createIssue(
        "TEXT_OVERFLOW",
        Math.max(scrollOverflow.right, scrollOverflow.bottom) > 12 ? "error" : "warning",
        `文本元素 ${element.selector} 的实际内容超出文本框`,
        [element.index],
        { scrollOverflow, text: element.text },
      ));
    }
  }

  for (const element of elements) {
    if (!element.isImage) continue;
    if (!element.imageComplete || !element.imageNaturalWidth || !element.imageNaturalHeight) {
      issues.push(createIssue(
        "BROKEN_IMAGE",
        "error",
        `图片 ${element.selector} 未成功加载`,
        [element.index],
        {
          complete: element.imageComplete,
          naturalWidth: element.imageNaturalWidth,
          naturalHeight: element.imageNaturalHeight,
        },
      ));
    }
  }

  const rawOverlaps: AuditOverlap[] = [];
  for (let firstIndex = 0; firstIndex < elements.length; firstIndex += 1) {
    const first = elements[firstIndex]!;
    if (first.index === rootIndex) continue;
    for (let secondIndex = firstIndex + 1; secondIndex < elements.length; secondIndex += 1) {
      const second = elements[secondIndex]!;
      if (second.index === rootIndex || isAncestorPair(first, second)) continue;
      const intersection = intersectRects(first.rect, second.rect);
      if (!intersection) continue;
      const intersectionArea = rectArea(intersection);
      const smallerElementArea = Math.max(1, Math.min(rectArea(first.rect), rectArea(second.rect)));
      const smallerElementRatio = intersectionArea / smallerElementArea;
      const severity = classifyOverlapSeverity(smallerElementRatio, thresholds);
      const overlap: AuditOverlap = {
        firstIndex: first.index,
        secondIndex: second.index,
        intersection,
        intersectionArea: Number(intersectionArea.toFixed(3)),
        smallerElementArea: Number(smallerElementArea.toFixed(3)),
        smallerElementRatio: Number(smallerElementRatio.toFixed(4)),
        severity,
      };
      if (severity === "ignored") {
        overlap.reason = "交集占较小元素面积不足 1%";
      } else if (isExpectedImageTextOverlay(first, second)) {
        overlap.reason = "图片与文字叠加可能是 PPT 中的合法标注层；保留原始对但默认不生成问题";
      }
      rawOverlaps.push(overlap);
      if (severity !== "ignored" && !isDecorative(first) && !isDecorative(second) && !isExpectedImageTextOverlay(first, second)) {
        const issueSeverity: AuditSeverity = severity === "warning" ? "warning" : severity;
        issues.push(createIssue(
          "ELEMENT_OVERLAP",
          issueSeverity,
          `元素 ${first.selector} 与 ${second.selector} 发生非祖先关系重叠`,
          [first.index, second.index],
          {
            intersection,
            intersectionArea,
            smallerElementRatio,
            firstText: first.text,
            secondText: second.text,
          },
        ));
      }
    }
  }

  // 口径 A 分层落地：文字字形与可见边框带真实相触时输出问题。
  // bg-frame 装饰环与正样本形成稳定映射，直接报 ERROR；普通 class 边框相触在 GT 是/否两侧同构，先报 WARNING 供人工复核。
  const borderBandCandidates = elements
    .filter((element) => element.index !== rootIndex)
    .flatMap((element) => element.borderBands
      .filter((band) => band.width > 0 && band.colorAlpha >= 0.3)
      .map((band) => ({
        element,
        band,
        isRing: element.className.toLowerCase().includes("bg-frame"),
      })));
  const erroredElementIndices = new Set<number>();
  for (const issue of issues) {
    if (issue.severity !== "error") continue;
    for (const index of issue.elementIndices) erroredElementIndices.add(index);
  }
  const hasErroredAncestor = (element: AuditElement): boolean =>
    erroredElementIndices.has(element.index) || element.ancestorIndices.some((index) => erroredElementIndices.has(index));
  const contactReported = new Set<string>();

  for (const textElement of elements) {
    if (textElement.index === rootIndex || !textElement.isTextLeaf || !textElement.text.trim()) continue;
    if (textElement.textLineRects.length === 0 || hasErroredAncestor(textElement)) continue;

    // 任一文字行字形已出画布时，归 SLIDE_OUT_OF_BOUNDS / TEXT_OVERFLOW 口径，避免重复裁决。
    let selfOutOfCanvas = false;
    for (const line of textElement.textLineRects) {
      const glyph = glyphRect(line);
      if (glyph.bottom > canvas.height || glyph.y < 0 || glyph.right > canvas.width || glyph.x < 0) {
        selfOutOfCanvas = true;
        break;
      }
    }
    if (selfOutOfCanvas) continue;

    let ringHit: { element: AuditElement; band: AuditBorderBand; depth: number } | null = null;
    let frameHit: { element: AuditElement; band: AuditBorderBand; depth: number } | null = null;
    for (const candidate of borderBandCandidates) {
      if (candidate.element.index === textElement.index || isAncestorPair(textElement, candidate.element)) continue;
      for (const line of textElement.textLineRects) {
        const depth = rectContactDepth(glyphRect(line), candidate.band.rect);
        if (candidate.isRing) {
          if (depth >= 0.5 && (!ringHit || depth > ringHit.depth)) {
            ringHit = { element: candidate.element, band: candidate.band, depth };
          }
        } else if (candidate.element.hasNamedClass && depth >= 1 && (!frameHit || depth > frameHit.depth)) {
          frameHit = { element: candidate.element, band: candidate.band, depth };
        }
      }
    }

    const hit = ringHit ?? frameHit;
    if (!hit) continue;
    const contactKey = `${textElement.index}|${hit.element.index}`;
    if (contactReported.has(contactKey)) continue;
    contactReported.add(contactKey);
    const rule = ringHit ? "TEXT_RING_CONTACT" : "TEXT_FRAME_CONTACT";
    issues.push(createIssue(
      rule,
      ringHit ? "error" : "warning",
      `文字 ${textElement.selector} 与 ${hit.element.selector} 的${hit.band.side}边框带真实相触`,
      [textElement.index, hit.element.index],
      {
        text: textElement.text.slice(0, 80),
        frameSelector: hit.element.selector,
        frameClass: hit.element.className,
        side: hit.band.side,
        depth: Number(hit.depth.toFixed(1)),
        bandRect: hit.band.rect,
      },
    ));
  }

  return {
    slideIndex: 0,
    pageId: collected.pageId,
    selector: collected.selector,
    rect: collected.rect,
    canvas,
    renderState: collected.renderState,
    elements,
    rawOverlaps,
    issues,
  };
}

function collectSlideInBrowser({ selector, width, height, maxElements }: {
  selector: string | undefined;
  width: number;
  height: number;
  maxElements: number;
}): CollectedSlide[] {
  const visible = (element: HTMLElement): boolean => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const shortText = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const selectorFor = (element: Element, root: Element): string => {
    if (element === root) return selector ?? `[data-presenton-slide-shell="true"]`;
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== root && parts.length < 8) {
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      const parent: Element | null = current.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter((child: Element) => child.tagName === current!.tagName);
      const position = siblings.indexOf(current) + 1;
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${position})`);
      current = parent;
    }
    return `${selector ?? "[data-presenton-slide-shell=\"true\"]"} ${parts.join(" > ")}`.trim();
  };
  const detectRoots = (): Element[] => {
    if (selector) return Array.from(document.querySelectorAll(selector));
    const shells = Array.from(document.querySelectorAll('[data-presenton-slide-shell="true"]'));
    if (shells.length > 0) return shells;
    const wrapper = document.querySelector("#presentation-slides-wrapper");
    if (!wrapper) return [];
    const deckSlots = Array.from(wrapper.querySelectorAll(":scope > [data-layout], :scope > [data-presenton-deck-slot]"));
    if (deckSlots.length > 0) return deckSlots;
    if (wrapper.hasAttribute("data-layout")) return [wrapper];
    return [];
  };
  const roots = detectRoots();
  return roots.map((root, slideIndex) => {
    const rootElement = root as HTMLElement;
    const rootRect = rootElement.getBoundingClientRect();
    const renderState = !visible(rootElement)
      ? "hidden"
      : rootRect.width <= 0 || rootRect.height <= 0
        ? "invalid"
        : "ready";
    const candidates = [rootElement, ...Array.from(rootElement.querySelectorAll<HTMLElement>("*"))]
      .filter((element, index) => index === 0 || visible(element))
      .slice(0, maxElements);
    const indexByElement = new Map<Element, number>();
    candidates.forEach((element, index) => indexByElement.set(element, index));
    const relativeRect = (value: DOMRect): AuditRect => ({
      x: value.left - rootRect.left,
      y: value.top - rootRect.top,
      width: value.width,
      height: value.height,
      right: value.right - rootRect.left,
      bottom: value.bottom - rootRect.top,
    });
    const colorAlpha = (value: string): number => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) return 0;
      const parts = match[1]!.split(",").map((part) => Number.parseFloat(part));
      return parts.length === 4 ? parts[3]! : 1;
    };
    const collectTextLineRects = (element: HTMLElement, elementStyle: CSSStyleDeclaration): AuditTextLineRect[] => {
      if (element.children.length > 0) return [];
      const fontSize = Number.parseFloat(elementStyle.fontSize) || 16;
      const lineHeight = elementStyle.lineHeight === "normal"
        ? fontSize * 1.2
        : Number.parseFloat(elementStyle.lineHeight) || fontSize * 1.2;
      const lines: AuditTextLineRect[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (!(node.textContent ?? "").trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const lineRect of Array.from(range.getClientRects())) {
          if (lineRect.width <= 0.5 || lineRect.height <= 0.5) continue;
          lines.push({ ...relativeRect(lineRect), fontSize, lineHeight });
        }
        range.detach();
      }
      return lines;
    };
    const collectBorderBands = (
      elementRect: DOMRect,
      elementStyle: CSSStyleDeclaration,
    ): AuditBorderBand[] => {
      const widths = {
        top: Number.parseFloat(elementStyle.borderTopWidth) || 0,
        right: Number.parseFloat(elementStyle.borderRightWidth) || 0,
        bottom: Number.parseFloat(elementStyle.borderBottomWidth) || 0,
        left: Number.parseFloat(elementStyle.borderLeftWidth) || 0,
      };
      const defs = [
        {
          side: "top" as const,
          width: widths.top,
          alpha: colorAlpha(elementStyle.borderTopColor),
          rect: new DOMRect(elementRect.left, elementRect.top, elementRect.width, widths.top),
        },
        {
          side: "right" as const,
          width: widths.right,
          alpha: colorAlpha(elementStyle.borderRightColor),
          rect: new DOMRect(elementRect.right - widths.right, elementRect.top, widths.right, elementRect.height),
        },
        {
          side: "bottom" as const,
          width: widths.bottom,
          alpha: colorAlpha(elementStyle.borderBottomColor),
          rect: new DOMRect(elementRect.left, elementRect.bottom - widths.bottom, elementRect.width, widths.bottom),
        },
        {
          side: "left" as const,
          width: widths.left,
          alpha: colorAlpha(elementStyle.borderLeftColor),
          rect: new DOMRect(elementRect.left, elementRect.top, widths.left, elementRect.height),
        },
      ];
      return defs
        .filter((definition) => definition.width > 0 && definition.alpha >= 0.3)
        .map((definition) => ({
          side: definition.side,
          width: definition.width,
          colorAlpha: definition.alpha,
          rect: relativeRect(definition.rect),
        }));
    };
    const elements: AuditElement[] = candidates.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const parentIndex = element.parentElement
        ? indexByElement.get(element.parentElement) ?? null
        : null;
      const ancestorIndices: number[] = [];
      let ancestor = element.parentElement;
      while (ancestor) {
        const ancestorIndex = indexByElement.get(ancestor);
        if (ancestorIndex !== undefined) ancestorIndices.push(ancestorIndex);
        if (ancestor === root) break;
        ancestor = ancestor.parentElement;
      }
      const image = element instanceof HTMLImageElement ? element : null;
      const positioningContextIndex = (() => {
        let ancestor: Element | null = element.parentElement;
        while (ancestor) {
          const ancestorStyle = getComputedStyle(ancestor as HTMLElement);
          if (ancestorStyle.position !== "static") {
            return indexByElement.get(ancestor) ?? null;
          }
          if (ancestor === root) return 0;
          ancestor = ancestor.parentElement;
        }
        return 0;
      })();
      return {
        index,
        tagName: element.tagName.toLowerCase(),
        selector: selectorFor(element, root),
        text: shortText(element),
        rect: {
          x: rect.left - rootRect.left,
          y: rect.top - rootRect.top,
          width: rect.width,
          height: rect.height,
          right: rect.right - rootRect.left,
          bottom: rect.bottom - rootRect.top,
        },
        zIndex: style.zIndex === "auto" ? null : Number(style.zIndex),
        position: style.position,
        display: style.display,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        parentIndex,
        ancestorIndices,
        isImage: Boolean(image),
        isTextLeaf: element.children.length === 0,
        textLineRects: collectTextLineRects(element, style),
        borderBands: collectBorderBands(rect, style),
        hasNamedClass: typeof element.className === "string" && element.className.trim().length > 0,
        imageComplete: image?.complete,
        imageNaturalWidth: image?.naturalWidth,
        imageNaturalHeight: image?.naturalHeight,
        className: typeof element.className === "string" ? element.className : "",
        positioningContextIndex,
      };
    });
    return {
      pageId: rootElement.getAttribute("data-page-id")
        ?? rootElement.getAttribute("data-layout")
        ?? rootElement.querySelector<HTMLElement>("[data-page-id]")?.getAttribute("data-page-id")
        ?? rootElement.querySelector<HTMLElement>("[data-layout]")?.getAttribute("data-layout")
        ?? null,
      selector: selectorFor(root, root),
      rect: {
        x: 0,
        y: 0,
        width: rootRect.width,
        height: rootRect.height,
        right: rootRect.width,
        bottom: rootRect.height,
      },
      renderState,
      elements,
    };
  });
}

async function waitForAuditRoots(page: ManagedPageLike, selector: string | undefined, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const state = await page.evaluate((requestedSelector) => {
      const wrapper = document.querySelector("#presentation-slides-wrapper");
      const roots = requestedSelector
        ? Array.from(document.querySelectorAll(requestedSelector))
        : (() => {
          const shells = Array.from(document.querySelectorAll('[data-presenton-slide-shell="true"]'));
          if (shells.length > 0) return shells;
          if (!wrapper) return [];
          const slots = Array.from(wrapper.querySelectorAll(":scope > [data-layout], :scope > [data-presenton-deck-slot]"));
          if (slots.length > 0) return slots;
          return wrapper.hasAttribute("data-layout") ? [wrapper] : [];
        })();
      const wrapperStatus = wrapper?.getAttribute("data-presenton-render-status");
      return { count: roots.length, wrapperStatus };
    }, selector);
    if (state.count > 0 && state.wrapperStatus !== "loading") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    selector
      ? `未找到可审计的 slide 元素：${selector}`
      : "未找到可审计的 slide。请提供 --slide-selector，或确保 HTML 包含 data-presenton-slide-shell=\"true\" / data-layout。",
  );
}

export async function auditHtmlFile(options: LayoutAuditOptions): Promise<LayoutAuditReport> {
  const input = path.resolve(options.input);
  if (!path.isAbsolute(options.input)) {
    throw new Error("--input 必须是绝对本地 HTML 路径");
  }
  await access(input);
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("画布宽高必须是正数");
  }
  const thresholds = options.overlapThresholds ?? { warning: 0.01, suspicious: 0.1, error: 0.3 };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const collectedSlides = await withQueuedManagedPage(
    "PPT DOM layout audit",
    scaleBrowserOperationTimeout(DEFAULT_OPERATION_TIMEOUT_MS, 1),
    async (page) => {
      await page.setViewport?.({ width, height, deviceScaleFactor: 1 });
      await installRenderReadinessTracking(page);
      if (!page.goto) throw new Error("DOM layout audit requires browser file navigation support");
      await page.goto(pathToFileURL(input).href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      const wrapperStatus = await page.evaluate(() => document.querySelector("#presentation-slides-wrapper")?.getAttribute("data-presenton-render-status"));
      if (wrapperStatus === "loading" || wrapperStatus === null) {
        await waitForAuditRoots(page, options.slideSelector, Math.min(timeoutMs, 15_000));
      } else if (wrapperStatus === "ready") {
        await waitForAuditRoots(page, options.slideSelector, Math.min(timeoutMs, 15_000));
      } else if (wrapperStatus === "error") {
        await waitForRenderReady(page, { selector: "#presentation-slides-wrapper", timeoutMs, kindLabel: "Slide" });
      }
      await waitForRenderReadiness(page, { timeoutMs, requireTailwind: false, allowFailedImages: true });
      // 字体回退会造成行盒高度变化；等待 fonts.ready 与图片 settle，确保相触深度稳定。
      await page.evaluate(async () => {
        await Promise.race([
          document.fonts.ready,
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
        await Promise.race([
          Promise.all(Array.from(document.images).map((image) => {
            if (image.complete) return Promise.resolve();
            return new Promise((resolve) => {
              image.addEventListener("load", resolve, { once: true });
              image.addEventListener("error", resolve, { once: true });
            });
          })),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
        // 字体加载完成后等待两帧，确保 Range 行盒已完成最终布局。
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
      });
      // tsup/tsx may inject a Node-side __name helper into named functions. Puppeteer
      // serializes the function body into Chrome, so evaluate the source explicitly
      // to keep the browser context independent from Node bundler helpers.
      return page.evaluate<CollectedSlide[]>((source, input) => {
        const helper = "function __layoutAuditIdentity(value){return value;}";
        const helpers = ["__name", "__name2", "__name3", "__name4", "__name5", "__name6", "__name7", "__name8"]
          .map((name) => `var ${name}=__layoutAuditIdentity;`)
          .join("");
        const collector = new Function(
          "input",
          `${helper}${helpers}return (${String(source)})(input);`,
        ) as (value: {
          selector: string | undefined;
          width: number;
          height: number;
          maxElements: number;
        }) => CollectedSlide[];
        return collector(input);
      }, collectSlideInBrowser.toString(), {
        selector: options.slideSelector,
        width,
        height,
        maxElements: MAX_ELEMENTS_PER_SLIDE,
      });
    },
  );
  if (collectedSlides.length === 0) {
    throw new Error("未找到可审计的 slide");
  }
  const slides = collectedSlides.map((slide, index) => ({
    ...analyzeSlide(slide, { width, height }, thresholds),
    slideIndex: index + 1,
  }));
  const issues = slides.flatMap((slide) => slide.issues);
  return {
    schemaVersion: 1,
    input,
    generatedAt: new Date().toISOString(),
    viewport: { width, height },
    slideSelector: options.slideSelector ?? null,
    slides,
    summary: {
      slideCount: slides.length,
      visibleElementCount: slides.reduce((total, slide) => total + slide.elements.length, 0),
      issueCount: issues.length,
      errorCount: issues.filter((issue) => issue.severity === "error").length,
      warningCount: issues.filter((issue) => issue.severity === "warning" || issue.severity === "suspicious").length,
    },
    metadata: {
      engine: "ppt-engine-dom-geometry-auditor",
      readiness: "browser-rendered",
      heuristicNote: "重叠严重程度按交集占较小元素面积的比例估算；这是 PPT 布局启发式，不等同于设计语义判定。",
    },
  };
}

export function collectAuditIssueCounts(report: LayoutAuditReport): { errors: number; warnings: number } {
  return {
    errors: report.summary.errorCount,
    warnings: report.summary.warningCount,
  };
}
