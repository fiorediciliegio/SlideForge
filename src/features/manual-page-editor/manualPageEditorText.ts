import { isSvgElement } from "./manualPageEditorInteractions";

/**
 * Text styling helpers for the manual page editor.
 *
 * Generated slides pin their typography in CSS classes (`font-size: var(--f-*)`,
 * class-level `line-height`, …) and nest text several levels deep, so writing an
 * inline style onto the selected box alone is either invisible (descendant class
 * rules win over inheritance) or inconsistent (only some runs change). The
 * helpers below push the change into the subtree while preserving the internal
 * visual hierarchy.
 */

const PARAGRAPH_DISPLAY = /^(block|flow-root|flex|grid|list-item)$/;

function htmlDescendants(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("*")).filter(
    (element) => !isSvgElement(element),
  );
}

function computedFontSize(view: Window, element: HTMLElement): number {
  return Number.parseFloat(view.getComputedStyle(element).fontSize) || 0;
}

function hasDirectText(element: HTMLElement): boolean {
  return Array.from(element.childNodes).some(
    (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
  );
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The size the reader perceives as "the text size" of a box: its own computed
 * size when it holds text directly, otherwise the largest text run inside.
 * A wrapper that inherits a small default (16px) would otherwise act as the
 * scaling base and quadruple the actual content when the user picks 64px.
 */
export function representativeFontSize(root: HTMLElement, view: Window): number {
  const own = computedFontSize(view, root);
  if (hasDirectText(root)) return own;
  let largest = 0;
  for (const element of htmlDescendants(root)) {
    if (hasDirectText(element)) largest = Math.max(largest, computedFontSize(view, element));
  }
  return largest > 0 ? largest : own;
}

/**
 * Sets an explicit pixel font size on the selected box and rescales every
 * descendant that brings its own font size (class or inline) by the same ratio,
 * so the change is always visible and relative emphasis (title vs body) stays
 * intact. The ratio is anchored on the box's representative text size, so the
 * dominant text lands exactly on the picked size. Descendants that simply
 * inherit follow the box automatically.
 */
export function applyProportionalFontSize(
  root: HTMLElement,
  view: Window,
  sizePx: number,
): void {
  if (!(sizePx > 0)) return;
  const descendants = htmlDescendants(root);
  const base = representativeFontSize(root, view);
  if (base <= 0) {
    root.style.fontSize = `${sizePx}px`;
    return;
  }
  // Measure before mutating: inheritance shifts the moment the root changes.
  const before = new Map<HTMLElement, number>();
  for (const element of [root, ...descendants]) {
    before.set(element, computedFontSize(view, element));
  }
  const ratio = sizePx / base;
  const rootBefore = before.get(root) ?? base;
  // The root itself scales by the same ratio rather than jumping to sizePx, so
  // text runs that inherit straight from the box scale proportionally too.
  root.style.fontSize = `${roundTenth(rootBefore * ratio)}px`;
  for (const element of descendants) {
    const parent = element.parentElement;
    const own = before.get(element) ?? 0;
    const inherited = (parent && before.get(parent)) ?? base;
    // Only elements whose size differed from their parent carried their own
    // font-size rule; those are the ones inheritance cannot reach.
    if (Math.abs(own - inherited) > 0.01 && own > 0) {
      element.style.fontSize = `${roundTenth(Math.max(6, own * ratio))}px`;
    }
  }
}

/**
 * Applies a unitless line height to the box and every descendant. Unitless
 * values multiply each element's own font size, so writing the same value
 * everywhere is equivalent to inheritance — except it also overrides the
 * class-level `line-height` rules that made the toolbar control look dead.
 */
export function applyInheritedLineHeight(root: HTMLElement, value: string): void {
  if (!value) return;
  root.style.lineHeight = value;
  for (const element of htmlDescendants(root)) {
    element.style.lineHeight = value;
  }
}

/**
 * A paragraph block is a flow box that holds text of its own — exactly the
 * things readers perceive as paragraphs in the generated markup, regardless of
 * whether the template used <p>, <li>, headings, or classed divs.
 */
function isParagraphBlock(view: Window, element: HTMLElement): boolean {
  if (!PARAGRAPH_DISPLAY.test(view.getComputedStyle(element).display)) return false;
  return Array.from(element.childNodes).some(
    (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
  );
}

/**
 * Current space-after as the toolbar should display it. Read from exactly the
 * place applySpaceAfter writes: the first inner paragraph's margin when the
 * box has paragraphs, otherwise the box's own padding — a single-paragraph
 * box gets padding instead of a margin, so reading marginBottom there would
 * always snap the toolbar back to 0.
 */
export function currentSpaceAfter(root: HTMLElement, view: Window): number {
  const paragraphs = htmlDescendants(root).filter((element) => isParagraphBlock(view, element));
  if (!paragraphs.length) {
    return Math.round(Number.parseFloat(view.getComputedStyle(root).paddingBottom) || 0);
  }
  return Math.round(Number.parseFloat(view.getComputedStyle(paragraphs[0]).marginBottom) || 0);
}

/**
 * Space-after is spacing *between paragraphs inside the selected text*, so the
 * margin lands on the paragraph blocks within the box rather than on the box
 * itself (a container margin is both invisible and pushes sibling elements
 * around). A single-paragraph selection has no inner spacing to adjust, so the
 * value becomes padding on the box itself — perceivable, and contained.
 */
export function applySpaceAfter(root: HTMLElement, view: Window, spacePx: number): void {
  if (!(spacePx >= 0)) return;
  const paragraphs = htmlDescendants(root).filter((element) => isParagraphBlock(view, element));
  if (!paragraphs.length) {
    root.style.paddingBottom = `${spacePx}px`;
    return;
  }
  for (const paragraph of paragraphs) {
    paragraph.style.marginBottom = `${spacePx}px`;
  }
}
