/** Shared, browser-safe page geometry. A presentation has one format. */
export const SLIDE_FORMATS = {
  "16:9": { width: 1920, height: 1080, widthInches: 13.333333, heightInches: 7.5 },
  "4:3": { width: 1440, height: 1080, widthInches: 10, heightInches: 7.5 },
  "9:16": { width: 1080, height: 1920, widthInches: 7.5, heightInches: 13.333333 },
  "3:4": { width: 1080, height: 1440, widthInches: 7.5, heightInches: 10 },
} as const;

export type SlideAspectRatio = keyof typeof SLIDE_FORMATS;

export function normalizeSlideAspectRatio(value?: unknown): SlideAspectRatio {
  if (value === undefined || value === null) return "16:9";
  if (typeof value === "string" && Object.hasOwn(SLIDE_FORMATS, value)) return value as SlideAspectRatio;
  throw new Error(`Unsupported slide aspect ratio: ${String(value)}`);
}

export function slideFormat(value?: unknown) {
  const aspectRatio = normalizeSlideAspectRatio(value);
  return { aspectRatio, ...SLIDE_FORMATS[aspectRatio] };
}

/** Engine-owned metadata survives staticization, transport, and manual edits. */
export function slideFormatFromHtml(html: string) {
  const root = /<html\b[^>]*>/i.exec(html)?.[0] ?? "";
  return slideFormat(/\bdata-ppt-aspect-ratio\s*=\s*["']([^"']+)["']/i.exec(root)?.[1]);
}

export function stampSlideFormat(html: string, aspectRatio?: SlideAspectRatio): string {
  const format = slideFormat(aspectRatio);
  return html.replace(/<html\b[^>]*>/i, (root) => `${root
    .replace(/\sdata-ppt-aspect-ratio\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .slice(0, -1)} data-ppt-aspect-ratio="${format.aspectRatio}">`);
}
