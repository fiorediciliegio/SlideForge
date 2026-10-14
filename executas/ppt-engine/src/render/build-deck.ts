import postcss from "postcss";

import { slideFormatFromHtml, stampSlideFormat } from "../slide-format.js";
import { getBrowserRenderDeckRuntimeBundle } from "./runtime-bundle.js";
import type { BrowserRenderContext, BuildDeckHtmlInput, BuildStandaloneDeckHtmlInput } from "./types.js";

const PRESENTATION_WRAPPER_ID = "presentation-slides-wrapper";

interface ParsedSlideInput {
  speakerNote: string;
  context: BrowserRenderContext | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}

function escapeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function extractContextFromHtml(html: string): BrowserRenderContext | null {
  const prefix = "window.__PRESENTON_RENDER_CONTEXT__ = ";
  const assignmentStart = html.indexOf(prefix);
  if (assignmentStart === -1) {
    return null;
  }

  const jsonStart = assignmentStart + prefix.length;
  let index = jsonStart;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;

  while (index < html.length) {
    const char = html[index];

    if (!started) {
      if (char === "{") {
        started = true;
        depth = 1;
      }
      index += 1;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const rawJson = html.slice(jsonStart, index + 1);
        return JSON.parse(rawJson) as BrowserRenderContext;
      }
    }

    index += 1;
  }

  throw new Error("Failed to parse window.__PRESENTON_RENDER_CONTEXT__ payload");
}

function extractSpeakerNote(html: string): string {
  const match = html.match(/\bdata-speaker-note\s*=\s*["']([^"']*)["']/i);
  return match ? match[1] : "";
}

function parseSlideInput(slide: BuildDeckHtmlInput["slides"][number]): ParsedSlideInput {
  const context = extractContextFromHtml(slide.html);
  return {
    speakerNote: slide.speaker_note ?? extractSpeakerNote(slide.html),
    context,
  };
}

function buildDeckReadyScript(): string {
  return `
    (() => {
      const wrapper = document.getElementById(${JSON.stringify(PRESENTATION_WRAPPER_ID)});
      wrapper?.setAttribute("data-presenton-render-status", "ready");
      window.dispatchEvent(new CustomEvent("presenton:render-ready"));
    })();
  `.trim();
}

function buildDeckDocumentHtml(input: {
  title: string;
  parsedSlides: ParsedSlideInput[];
  runtimeBundle?: string | null;
  tailwindRuntimeBundle?: string | null;
}): string {
  const runtimeBundle = input.runtimeBundle ?? getBrowserRenderDeckRuntimeBundle();
  const contexts = input.parsedSlides
    .map((slide) => slide.context)
    .filter((context): context is BrowserRenderContext => context !== null);
  const serializedContexts = escapeJsonForInlineScript(contexts);

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=1920, initial-scale=1" />',
    `  <title>${escapeHtml(input.title)}</title>`,
    "  <style>",
    "    html, body { margin: 0; padding: 0; width: 1920px; min-height: 1080px; }",
    `    #${PRESENTATION_WRAPPER_ID} { width: 1920px; margin: 0; padding: 0; }`,
    `    #${PRESENTATION_WRAPPER_ID} > [data-presenton-slide-shell="true"] {`,
    "      position: relative;",
    "      display: block;",
    "      visibility: visible;",
    "      width: 1920px;",
    "      height: 1080px;",
    "      margin: 0;",
    "      padding: 0;",
    "      overflow: hidden;",
    "    }",
    "    [data-presenton-render-status=\"error\"] {",
    "      display: flex;",
    "      align-items: center;",
    "      justify-content: center;",
    "      color: #991b1b;",
    "      background: #fef2f2;",
    "      font-size: 14px;",
    "      padding: 24px;",
    "      box-sizing: border-box;",
    "    }",
    "  </style>",
    ...(input.tailwindRuntimeBundle
      ? [
        '  <script data-presenton-runtime="tailwind">',
        input.tailwindRuntimeBundle,
        "  </script>",
      ]
      : [
        "  <script>",
        "    window.tailwind = window.tailwind || {};",
        "  </script>",
        '  <script src="https://cdn.tailwindcss.com"></script>',
      ]),
    "</head>",
    "<body>",
    `  <div id="${PRESENTATION_WRAPPER_ID}" data-presenton-render-status="loading">`,
    contexts
      .map((context, index) =>
        [
          `    <div data-presenton-slide-shell="true">`,
          ...(input.parsedSlides[index]?.speakerNote
            ? [`      <template data-pptx-notes>${escapeHtml(input.parsedSlides[index]?.speakerNote ?? "")}</template>`]
            : []),
          `      <div data-presenton-deck-slot="${index}" data-layout="${escapeHtmlAttribute(context.layoutId)}" data-group="${escapeHtmlAttribute(context.templateGroup)}" style="width:1920px;min-height:1080px;"></div>`,
          "    </div>",
        ].join("\n"),
      )
      .join("\n"),
    "  </div>",
    "  <script>",
    `    window.__PRESENTON_RENDER_CONTEXTS__ = ${serializedContexts};`,
    "  </script>",
    contexts.length > 0
      ? ["  <script>", runtimeBundle, "  </script>"].join("\n")
      : ["  <script>", buildDeckReadyScript(), "  </script>"].join("\n"),
    "</body>",
    "</html>",
  ].join("\n");
}

export function buildDeckHtml(input: BuildDeckHtmlInput): string {
  if (!input || typeof input !== "object") {
    throw new Error("Deck input must be an object");
  }

  if (!Array.isArray(input.slides) || input.slides.length === 0) {
    throw new Error('Field "slides" must be a non-empty array');
  }

  const parsedSlides = input.slides.map((slide, index) => {
    if (!slide || typeof slide !== "object" || typeof slide.html !== "string") {
      throw new Error(`Slide at index ${index} must contain an "html" string`);
    }

    const parsed = parseSlideInput(slide);
    if (!parsed.context) {
      throw new Error(`Slide at index ${index} does not contain a render context`);
    }
    return parsed;
  });

  const title =
    input.title ??
    "Presenton Deck";

  return buildDeckDocumentHtml({
    title,
    parsedSlides,
    runtimeBundle: input.runtimeBundle,
    tailwindRuntimeBundle: input.tailwindRuntimeBundle,
  });
}

export function buildStandaloneDeckHtml(
  input: BuildStandaloneDeckHtmlInput,
): string {
  return buildDeckHtml({
    title: input.title,
    slides: input.slides,
    runtimeBundle: input.runtimeBundle,
    tailwindRuntimeBundle: input.tailwindRuntimeBundle,
  });
}

function findMatchingElementEnd(html: string, startIndex: number, tagName: string): number {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagPattern = new RegExp(`<\\/?${escapedTagName}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = startIndex;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html))) {
    const tag = match[0];
    if (/^<\//.test(tag)) {
      depth -= 1;
    } else if (!/\/\s*>$/.test(tag)) {
      depth += 1;
    }
    if (depth === 0) return tagPattern.lastIndex;
  }
  throw new Error(`Static page shell <${tagName}> has no matching closing tag`);
}

function extractStaticPageShell(html: string, pageIndex: number): {
  shell: string;
  styles: string[];
  stylesheetLinks: string[];
} {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1]?.trim() ?? "";
  const shellCount = (body.match(/data-presenton-slide-shell=["']true["']/gi) ?? []).length;
  if (shellCount !== 1) {
    throw new Error(`Static page ${pageIndex + 1} must contain exactly one slide shell; found ${shellCount}`);
  }
  const opening = /<([a-z][\w:-]*)\b[^>]*data-presenton-slide-shell=["']true["'][^>]*>/i.exec(body);
  if (!opening || opening.index === undefined) {
    throw new Error(`Static page ${pageIndex + 1} is missing its slide shell element`);
  }
  const shellEnd = findMatchingElementEnd(body, opening.index, opening[1]!);
  const shell = body
    .slice(opening.index, shellEnd)
    .replace(/\s+id=["']presentation-slides-wrapper["']/i, "")
    .replace(/\s+data-presenton-render-status=["'][^"']*["']/i, "");
  const styles = Array.from(html.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi), (match) => match[0]);
  const stylesheetLinks = Array.from(html.matchAll(/<link\b[^>]*>/gi), (match) => match[0])
    .filter((link) => /\brel\s*=\s*["'][^"']*\bstylesheet\b[^"']*["']/i.test(link));
  return { shell, styles, stylesheetLinks };
}

function stylesheetLinkKey(link: string): string {
  const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(link)?.[1]?.trim();
  return href ? `href:${href}` : `tag:${link}`;
}

/**
 * Font faces are document-global, while every other snapshot rule stays scoped
 * to its source page. Hoist only top-level font faces and remove later rules
 * whose CSS serialization is exactly identical, preserving first-seen order.
 */
function hoistUniqueFontFaces(styles: string[]): { fontFaces: string[]; styles: string[] } {
  const seenFontFaces = new Set<string>();
  const fontFaces: string[] = [];
  const remainingStyles: string[] = [];

  for (const style of styles) {
    const match = /^(\s*<style\b[^>]*>)([\s\S]*)(<\/style>\s*)$/i.exec(style);
    if (!match) {
      remainingStyles.push(style);
      continue;
    }

    const [, openingTag, css, closingTag] = match;
    let root: postcss.Root;
    try {
      root = postcss.parse(css);
    } catch {
      // Preserve malformed or non-standard CSS exactly as supplied. Chromium
      // remains the compatibility authority for such a snapshot.
      remainingStyles.push(style);
      continue;
    }

    let extracted = false;
    for (const node of [...root.nodes]) {
      if (node.type !== "atrule" || node.name.toLowerCase() !== "font-face") continue;
      const fontFace = node.toString();
      if (!seenFontFaces.has(fontFace)) {
        seenFontFaces.add(fontFace);
        fontFaces.push(fontFace);
      }
      node.remove();
      extracted = true;
    }

    if (!extracted) {
      remainingStyles.push(style);
      continue;
    }

    const remainingCss = root.toString();
    if (remainingCss.trim()) remainingStyles.push(`${openingTag}${remainingCss}${closingTag}`);
  }

  return { fontFaces, styles: remainingStyles };
}

/** Build one export-oriented Deck document from already-static page snapshots. */
export function buildStaticDeckHtml(input: { title: string; pages: string[] }): string {
  if (!Array.isArray(input.pages) || input.pages.length === 0) {
    throw new Error("Static Deck requires at least one page snapshot");
  }
  const { width, height, aspectRatio } = slideFormatFromHtml(input.pages[0]!);
  if (input.pages.some((html) => slideFormatFromHtml(html).aspectRatio !== aspectRatio)) throw new Error("A Deck cannot mix page sizes");
  const pages = input.pages.map(extractStaticPageShell);
  const stylesheetLinks: string[] = [];
  const seenStylesheetLinks = new Set<string>();
  for (const page of pages) {
    for (const link of page.stylesheetLinks) {
      const key = stylesheetLinkKey(link);
      if (seenStylesheetLinks.has(key)) continue;
      seenStylesheetLinks.add(key);
      stylesheetLinks.push(link);
    }
  }
  const { fontFaces, styles } = hoistUniqueFontFaces(pages.flatMap((page) => page.styles));
  return stampSlideFormat([
    "<!doctype html>",
    '<html lang="en" data-presenton-render-document="static">',
    "<head>",
    '  <meta charset="utf-8" />',
    `  <meta name="viewport" content="width=${width}, initial-scale=1" />`,
    `  <title>${escapeHtml(input.title)}</title>`,
    "  <style>",
    `    html,body{margin:0;padding:0;width:${width}px;min-height:${height}px;background:#fff;}`,
    `    #${PRESENTATION_WRAPPER_ID}{width:${width}px;margin:0;padding:0;display:block;}`,
    `    #${PRESENTATION_WRAPPER_ID}>[data-presenton-slide-shell="true"]{position:relative;visibility:visible;width:${width}px;height:${height}px;min-width:${width}px;min-height:${height}px;overflow:hidden;box-sizing:border-box;}`,
    "  </style>",
    ...stylesheetLinks,
    ...(fontFaces.length > 0
      ? [
        '  <style data-presenton-deck-font-faces="true">',
        ...fontFaces,
        "  </style>",
      ]
      : []),
    ...styles,
    "</head>",
    "<body>",
    `  <div id="${PRESENTATION_WRAPPER_ID}" data-presenton-render-status="ready">`,
    ...pages.map((page) => page.shell),
    "  </div>",
    "</body>",
    "</html>",
  ].join("\n"), aspectRatio);
}
