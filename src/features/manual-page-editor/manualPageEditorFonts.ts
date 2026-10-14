import type {
  ManagedFontRuntimeFamily,
  ManagedFontRuntimeVariant,
} from "../../api/types";
import { MOVEABLE_EDITOR_CLASS } from "./manualPageEditorInteractions";
import type { EditorResources } from "./manualPageEditorResources";

export const MANAGED_FONT_FAMILY_ATTRIBUTE = "data-ppt-editor-font-family";
export const MANAGED_FONT_STYLE_ATTRIBUTE = "data-ppt-editor-fonts";
export const FONT_UPLOAD_VALUE = "__upload_managed_font__";

function escapeCssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}

function variantRule(family: string, variant: ManagedFontRuntimeVariant, source: ManagedFontRuntimeVariant["sources"][number]): string {
  const bold = variant.variant === "bold" || variant.variant === "boldItalic";
  const italic = variant.variant === "italic" || variant.variant === "boldItalic";
  const format = source.format === "ttf"
    ? "truetype"
    : source.format === "otf"
      ? "opentype"
      : source.format;
  return [
    "@font-face {",
    `  font-family: "${escapeCssString(family)}";`,
    `  src: url("${escapeCssString(source.source_url)}") format("${format}");`,
    `  font-weight: ${bold ? 700 : 400};`,
    `  font-style: ${italic ? "italic" : "normal"};`,
    ...(source.unicode_range ? [`  unicode-range: ${source.unicode_range};`] : []),
    "  font-display: block;",
    "}",
  ].join("\n");
}

export function runtimeManagedFontCss(fonts: readonly ManagedFontRuntimeFamily[]): string {
  return fonts.flatMap((font) =>
    Object.values(font.variants)
      .filter((variant): variant is ManagedFontRuntimeVariant => Boolean(variant))
      .flatMap((variant) => variant.sources.map((source) => variantRule(font.family, variant, source)))
  ).join("\n");
}

export function installRuntimeManagedFonts(
  document: Document,
  fonts: readonly ManagedFontRuntimeFamily[],
): void {
  for (const node of Array.from(document.querySelectorAll(
    `style[${MANAGED_FONT_STYLE_ATTRIBUTE}="true"], style[data-ppt-editor-runtime-fonts="true"]`,
  ))) {
    node.remove();
  }
  const css = runtimeManagedFontCss(fonts);
  if (!css) return;
  const style = document.createElement("style");
  style.className = MOVEABLE_EDITOR_CLASS;
  style.dataset.pptEditorRuntimeFonts = "true";
  style.textContent = css;
  document.head.append(style);
}

export async function verifyRuntimeManagedFonts(
  document: Document,
  fonts: readonly ManagedFontRuntimeFamily[],
): Promise<void> {
  if (!document.fonts) throw new Error("This browser cannot verify managed fonts.");
  for (const font of fonts) {
    const family = `"${escapeCssString(font.family)}"`;
    for (const variant of Object.values(font.variants)) {
      if (!variant) continue;
      const bold = variant.variant === "bold" || variant.variant === "boldItalic";
      const italic = variant.variant === "italic" || variant.variant === "boldItalic";
      for (const source of variant.sources) {
        const faces = await document.fonts.load(
          `${italic ? "italic" : "normal"} ${bold ? 700 : 400} 16px ${family}`,
          sampleTextForUnicodeRange(source.unicode_range),
        );
        if (faces.length === 0 || faces.some((face) => face.status !== "loaded")) {
          throw new Error(`Managed font failed to load: ${font.family} (${variant.variant})`);
        }
      }
    }
  }
}

export function mergeRuntimeFontFamily(
  current: readonly ManagedFontRuntimeFamily[],
  next: ManagedFontRuntimeFamily,
): ManagedFontRuntimeFamily[] {
  return [
    ...current.filter((font) => font.family !== next.family),
    next,
  ].sort((left, right) => left.family.localeCompare(right.family));
}

/** A refreshed address and its expiry are one piece of transport state. */
export function refreshRuntimeFontResources(
  fonts: readonly ManagedFontRuntimeFamily[],
  resources: EditorResources,
): ManagedFontRuntimeFamily[] {
  return fonts.map((font) => ({
    ...font,
    variants: Object.fromEntries(Object.entries(font.variants).map(([key, variant]) => {
      return [key, variant && {
        ...variant,
        sources: variant.sources.map((source) => {
          const resource = resources.resource(source.local_url);
          return resource ? { ...source, source_url: resource.url, expires_at: resource.expires_at } : source;
        }),
      }];
    })),
  }));
}

function sampleTextForUnicodeRange(range?: string): string {
  const match = /U\+([0-9a-f]{1,6})(?:-[0-9a-f]{1,6})?/i.exec(range ?? "");
  if (!match) return "BESbswy";
  const codePoint = Number.parseInt(match[1]!, 16);
  try { return String.fromCodePoint(codePoint); } catch { return "BESbswy"; }
}

export function managedFontFileMimeType(filename: string): string | null {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (extension === ".ttf") return "font/ttf";
  if (extension === ".otf") return "font/otf";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  return null;
}
