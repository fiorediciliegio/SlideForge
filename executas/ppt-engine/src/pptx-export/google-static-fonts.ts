import os from "node:os";
import path from "node:path";
import { unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const FONT_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
const REMOTE_FONT_FETCH_TIMEOUT_MS = 10_000;
// Google Fonts sends one static face per requested weight to clients which do
// not support variable fonts. This is intentionally an old-but-valid browser
// UA, not an IE compatibility claim made by the exported deck.
const LEGACY_STATIC_FONT_UA = "Mozilla/4.0 (compatible; MSIE 9.0; Windows NT 6.1)";

export interface StaticFontRequest {
  family: string;
  weight?: string | number;
  style?: string;
}

export interface ResolvedStaticFontSource {
  url: string;
}

export interface GoogleStaticCssFace {
  url: string;
  unicodeRange?: string;
}

export interface GoogleStaticFontResolver {
  resolve(request: StaticFontRequest): Promise<ResolvedStaticFontSource[] | null>;
  cleanup(): Promise<void>;
}

function normalizeWeight(value: string | number | undefined): number {
  const text = String(value ?? "400").trim().toLowerCase();
  if (text === "bold" || text === "bolder") return 700;
  if (text === "lighter") return 300;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 1000 ? parsed : 400;
}

function isItalicStyle(value: string | undefined): boolean {
  return /^(italic|oblique)/i.test(String(value ?? "normal").trim());
}

/** Build a CSS2 request that asks Google Fonts for one static face. */
export function buildGoogleStaticCssUrl(request: StaticFontRequest): string | null {
  const family = request.family.trim().replace(/^['"]|['"]$/g, "");
  if (!family) return null;
  const weight = normalizeWeight(request.weight);
  const selector = isItalicStyle(request.style)
    ? `${family}:ital,wght@1,${weight}`
    : `${family}:wght@${weight}`;
  const url = new URL("https://fonts.googleapis.com/css2");
  url.searchParams.set("family", selector);
  url.searchParams.set("display", "swap");
  return url.href;
}

function cssProperty(block: string, property: string): string {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i").exec(block);
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
}

/**
 * Extract every Unicode-range slice for exactly one face from a CSS2 result.
 * Returning all slices is important: taking only the first Latin slice would
 * make previously-valid CJK and Cyrillic text fall back in PowerPoint.
 */
export function parseGoogleStaticCssFaces(css: string, request: StaticFontRequest): GoogleStaticCssFace[] {
  const wantedWeight = String(normalizeWeight(request.weight));
  const wantedStyle = isItalicStyle(request.style) ? "italic" : "normal";
  const faces = new Map<string, GoogleStaticCssFace>();
  for (const match of css.matchAll(/@font-face\s*\{([\s\S]*?)\}/gi)) {
    const block = match[1] ?? "";
    if (cssProperty(block, "font-weight") !== wantedWeight) continue;
    if (cssProperty(block, "font-style").toLowerCase() !== wantedStyle) continue;
    const src = cssProperty(block, "src");
    for (const urlMatch of src.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
      const url = urlMatch[2]?.trim();
      if (/^https:\/\/fonts\.gstatic\.com\//i.test(url)) {
        const unicodeRange = cssProperty(block, "unicode-range") || undefined;
        // A URL can be intentionally shared by adjacent declarations. Keep
        // each range so the browser does not accidentally treat a CJK subset
        // as a replacement for the Latin subset.
        faces.set(`${url}\0${unicodeRange ?? ""}`, { url, unicodeRange });
      }
    }
  }
  return [...faces.values()];
}

export function parseGoogleStaticCss(css: string, request: StaticFontRequest): string[] {
  return parseGoogleStaticCssFaces(css, request).map((face) => face.url);
}

function fileExtension(sourceUrl: string): string {
  try {
    const extension = path.extname(new URL(sourceUrl).pathname).toLowerCase();
    return [".ttf", ".otf", ".woff", ".woff2"].includes(extension) ? extension : ".woff";
  } catch {
    return ".woff";
  }
}

async function fetchFont(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { "user-agent": LEGACY_STATIC_FONT_UA },
    signal: AbortSignal.timeout(REMOTE_FONT_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("Google Fonts returned an empty font source");
  if (bytes.byteLength > FONT_SOURCE_MAX_BYTES) {
    throw new Error(`Font source exceeds ${FONT_SOURCE_MAX_BYTES} bytes`);
  }
  return bytes;
}

/**
 * Materialize Google Fonts static instances into per-export temporary files.
 * The browser cannot fetch file: URLs, but dom-to-pptx already has a host
 * font-reader bridge for those files. A per-face promise cache ensures that
 * repeated Unicode-range declarations do not refetch the same CSS or files.
 */
export function createGoogleStaticFontResolver(): GoogleStaticFontResolver {
  const temporaryFiles = new Set<string>();
  const cached = new Map<string, Promise<ResolvedStaticFontSource[] | null>>();

  async function resolveUncached(request: StaticFontRequest): Promise<ResolvedStaticFontSource[] | null> {
    const cssUrl = buildGoogleStaticCssUrl(request);
    if (!cssUrl) return null;
    const response = await fetch(cssUrl, {
      headers: { "user-agent": LEGACY_STATIC_FONT_UA },
      signal: AbortSignal.timeout(REMOTE_FONT_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Google Fonts CSS returned HTTP ${response.status}`);
    const sourceFaces = parseGoogleStaticCssFaces(await response.text(), request);
    if (sourceFaces.length === 0) return null;

    return await Promise.all(sourceFaces.map(async ({ url: sourceUrl }, index) => {
      const extension = fileExtension(sourceUrl);
      const target = path.join(
        os.tmpdir(),
        `pptx-google-static-${process.pid}-${Date.now()}-${temporaryFiles.size}-${index}${extension}`,
      );
      await writeFile(target, await fetchFont(sourceUrl));
      temporaryFiles.add(target);
      return { url: pathToFileURL(target).href };
    }));
  }

  return {
    async resolve(request) {
      const key = `${request.family.trim().toLowerCase()}\0${normalizeWeight(request.weight)}\0${isItalicStyle(request.style)}`;
      let pending = cached.get(key);
      if (!pending) {
        pending = resolveUncached(request).catch((error) => {
          cached.delete(key);
          throw error;
        });
        cached.set(key, pending);
      }
      return await pending;
    },
    async cleanup() {
      const files = [...temporaryFiles];
      temporaryFiles.clear();
      cached.clear();
      await Promise.all(files.map(async (file) => {
        await unlink(file).catch(() => undefined);
      }));
    },
  };
}
