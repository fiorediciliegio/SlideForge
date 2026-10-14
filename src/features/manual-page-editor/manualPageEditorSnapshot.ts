import { localizeEditorSnapshot } from "./manualPageEditorResources";
import { MOVEABLE_EDITOR_CLASS } from "./manualPageEditorInteractions";

const TEXT_SESSION = "data-ppt-editor-text-session";
const TEMPORARY_STYLES = ["caret-color", "outline"] as const;

/** Keep interaction-only attributes out of saved documents and undo history. */
export function beginTextSession(element: HTMLElement): void {
  if (element.hasAttribute(TEXT_SESSION)) return;
  const original = {
    editable: element.getAttribute("contenteditable"),
    style: element.getAttribute("style"),
    styles: TEMPORARY_STYLES.map((property) => [
      property, element.style.getPropertyValue(property), element.style.getPropertyPriority(property),
    ]),
  };
  element.contentEditable = "true";
  element.style.caretColor = "transparent";
  element.style.outline = "none";
  element.setAttribute(TEXT_SESSION, JSON.stringify({ ...original, editingStyle: element.style.cssText }));
}

export function endTextSession(element: HTMLElement): void {
  const encoded = element.getAttribute(TEXT_SESSION);
  if (!encoded) return;
  const original = JSON.parse(encoded) as {
    editable: string | null;
    style: string | null;
    editingStyle: string;
    styles: [string, string, string][];
  };
  if (original.editable === null) element.removeAttribute("contenteditable");
  else element.setAttribute("contenteditable", original.editable);
  if (element.style.cssText === original.editingStyle) {
    // CSSOM normalizes inline CSS even on focus. Preserve its original spelling
    // when no style was edited so this normalization cannot dirty the page.
    if (original.style === null) element.removeAttribute("style");
    else element.setAttribute("style", original.style);
  } else {
    for (const [property, value, priority] of original.styles) {
      if (value) element.style.setProperty(property, value, priority);
      else element.style.removeProperty(property);
    }
    if (original.style === null && !element.getAttribute("style")) element.removeAttribute("style");
  }
  element.removeAttribute(TEXT_SESSION);
}

export function serializeDocument(doc: Document): string {
  const root = doc.documentElement.cloneNode(true) as HTMLElement;
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(`[${TEXT_SESSION}]`))) {
    endTextSession(element);
  }
  for (const node of Array.from(root.querySelectorAll(
    // Moveable injects its interaction stylesheet into the slide document when
    // an element is selected. It is editor runtime state and must not affect
    // the persisted document or dirty-state comparison.
    `style[data-styled-id], style[data-ppt-editor-fonts], .${MOVEABLE_EDITOR_CLASS}, .manual-editor-svg-text-input, .manual-editor-caret`,
  ))) node.remove();
  localizeEditorSnapshot(doc, root);
  return `<!doctype html>\n${root.outerHTML}`;
}
