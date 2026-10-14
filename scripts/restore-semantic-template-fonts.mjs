import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PRESETS_ROOT = resolve("src/features/templates/presets");

// These URLs are reconstructed from the families, styles, and weight ranges in
// the original embedded Google Fonts CSS. They are fetched only by this local
// maintenance script. The resulting HTML keeps Google Fonts' @font-face rules
// with gstatic URLs, never a multi-megabyte base64 WOFF2 payload.
const GOOGLE_FONT_STYLESHEETS = new Map([
  ["134-Adaptive Systems Editorial Cover", "https://fonts.googleapis.com/css2?family=Archivo:wght@400..900&family=Bodoni+Moda:ital,opsz,wght@0,6..96,400..500;1,6..96,400..500&display=swap"],
  ["135-Next Quarter Strategic Plan Cover", "https://fonts.googleapis.com/css2?family=Archivo:wght@400..900&family=IBM+Plex+Sans:wght@400;500;600&display=swap"],
  ["141-Lightweight AI Brand Glass Cover", "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Space+Grotesk:wght@300..600&display=swap"],
  ["142-Spring Escape Travel Cover", "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Space+Grotesk:wght@300..700&display=swap"],
  ["143-Q4 Strategic Business Plan Cover", "https://fonts.googleapis.com/css2?family=Archivo:wght@400..800&family=IBM+Plex+Mono:wght@400;500&display=swap"],
  ["144-Coffee Culture Editorial Cover", "https://fonts.googleapis.com/css2?family=Archivo:wght@300..700&family=Bodoni+Moda:ital,opsz,wght@0,6..96,400..700;1,6..96,400..500&family=IBM+Plex+Mono:wght@400;500;600&display=swap"],
]);

const GOOGLE_FONT_LINK = /<link\b[^>]*\bhref\s*=\s*(?:"|')?https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/gi;
const EXTERNAL_FONT_BLOCK = /<style\s+data-external-template-fonts>\s*[\s\S]*?<\/style>\s*/gi;

export function restoreSemanticTemplateFonts(html, fontFaces) {
  // Some pages use the marker attribute while others only contain a dedicated
  // <style> block. Match on the actual data-font payload so a regular design
  // stylesheet is never removed.
  let removed = false;
  const withoutEmbeddedFonts = html
    .replace(/<!-- Embedded font resources:[^>]*-->\s*/gi, "")
    .replace(GOOGLE_FONT_LINK, "")
    .replace(EXTERNAL_FONT_BLOCK, "")
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style>\s*/gi, (block, css) => {
      if (!/data:font\/(?:woff2?|ttf|otf);base64,/i.test(css)) return block;
      removed = true;
      return "";
    });
  if (!removed && !/fonts\.(?:googleapis|gstatic)\.com|data-external-template-fonts/i.test(html)) {
    throw new Error("Expected an embedded template font block");
  }
  if (!/<\/head>/i.test(withoutEmbeddedFonts)) throw new Error("Expected a closing </head> tag");
  return withoutEmbeddedFonts.replace(
    /<\/head>/i,
    `<style data-external-template-fonts>\n${fontFaces}\n</style>\n</head>`,
  );
}

export function restoreSystemTemplateFonts(html) {
  return html
    .replace(GOOGLE_FONT_LINK, "")
    .replace(EXTERNAL_FONT_BLOCK, "")
    .replace(/(?:\"|')Noto Sans SC(?:\"|')\s*,\s*/gi, "")
    .replace(/\s*\.f-display,\s*\.f-body\s*\{\s*\}/gi, "");
}

async function fetchGoogleFontFaces(href) {
  const response = await fetch(href, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
    },
  });
  if (!response.ok) throw new Error(`Unable to fetch ${href}: ${response.status} ${response.statusText}`);
  const css = await response.text();
  const faces = [...css.matchAll(/@font-face\s*\{[\s\S]*?\}/gi)].map((match) => match[0]);
  if (faces.length === 0 || faces.some((face) => !/https:\/\/fonts\.gstatic\.com\//i.test(face))) {
    throw new Error(`Google Fonts stylesheet did not return usable gstatic font faces: ${href}`);
  }
  return faces.join("\n");
}

async function main() {
  for (const [presetId, href] of GOOGLE_FONT_STYLESHEETS) {
    const fontFaces = await fetchGoogleFontFaces(href);
    const htmlDirectory = resolve(PRESETS_ROOT, presetId, "html");
    const pages = (await readdir(htmlDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (pages.length === 0) throw new Error(`${presetId}: no HTML pages found`);
    for (const page of pages) {
      const htmlPath = resolve(htmlDirectory, page.name);
      const html = await readFile(htmlPath, "utf8");
      await writeFile(htmlPath, restoreSemanticTemplateFonts(html, fontFaces));
    }
    console.log(`Restored external Google Fonts for ${presetId} (${pages.length} pages)`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
