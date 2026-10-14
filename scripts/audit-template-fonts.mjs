import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PRESETS_ROOT = resolve(SCRIPT_DIR, "../src/features/templates/presets");
const FONT_LINK = /<link\b([^>]*)>/gi;
const HREF_ATTRIBUTE = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i;
const REL_ATTRIBUTE = /\brel\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i;
const FONT_IMPORT = /@import\s+(?:url\()?\s*["']?([^"')\s]+)["']?\)?/gi;
const FONT_FACE = /@font-face\s*\{([\s\S]*?)\}/gi;
const FONT_FAMILY = /font-family\s*:\s*([^;]+);/i;
const FONT_FAMILY_DECLARATION = /font-family\s*:\s*([^;]+);/gi;
const FONT_SOURCE = /src\s*:\s*url\(\s*["']?([^"')\s]+)["']?\)/i;
const EXTERNAL_URL = /^(?:https?:)?\/\//i;
const INCLUDE_LEGACY = process.argv.includes("--all");

function isFontUrl(url) {
  return /(?:fonts\.googleapis\.com|fonts\.gstatic\.com|\.woff2?(?:[?#]|$)|\.ttf(?:[?#]|$)|\.otf(?:[?#]|$))/i.test(url);
}

function collectExternalFontResources(html) {
  const resources = new Set();
  FONT_LINK.lastIndex = 0;
  let match;
  while ((match = FONT_LINK.exec(html))) {
    const attributes = match[1];
    const rel = REL_ATTRIBUTE.exec(attributes)?.slice(1).find((value) => value !== undefined) ?? "";
    const url = HREF_ATTRIBUTE.exec(attributes)?.slice(1).find((value) => value !== undefined) ?? "";
    if (rel.split(/\s+/).includes("stylesheet") && EXTERNAL_URL.test(url) && isFontUrl(url)) resources.add(url);
  }
  FONT_IMPORT.lastIndex = 0;
  while ((match = FONT_IMPORT.exec(html))) {
    const url = match[1] ?? "";
    if (EXTERNAL_URL.test(url) && isFontUrl(url)) resources.add(url);
  }
  FONT_FACE.lastIndex = 0;
  while ((match = FONT_FACE.exec(html))) {
    const source = FONT_SOURCE.exec(match[1])?.[1] ?? "";
    if (EXTERNAL_URL.test(source)) resources.add(source);
  }
  return [...resources];
}

function collectEmbeddedFamilies(html) {
  const families = new Set();
  FONT_FACE.lastIndex = 0;
  let match;
  while ((match = FONT_FACE.exec(html))) {
    if (!/\bsrc\s*:\s*url\(\s*["']?data:font\//i.test(match[1])) continue;
    const family = FONT_FAMILY.exec(match[1])?.[1]?.trim().replace(/["']/g, "");
    if (family) families.add(family);
  }
  return [...families];
}

function collectDeclaredFamilies(html) {
  const families = new Set();
  const documentStyles = html.replace(FONT_FACE, "");
  FONT_FAMILY_DECLARATION.lastIndex = 0;
  let match;
  while ((match = FONT_FAMILY_DECLARATION.exec(documentStyles))) {
    const family = match[1].trim();
    if (family) families.add(family);
  }
  return [...families];
}

const rows = [];
for (const entry of await readdir(PRESETS_ROOT, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const presetDir = resolve(PRESETS_ROOT, entry.name);
  let preset;
  try {
    preset = JSON.parse(await readFile(resolve(presetDir, "preset.json"), "utf8"));
  } catch {
    continue;
  }
  if (!INCLUDE_LEGACY && preset.theme_mode !== "semantic-v1") continue;
  for (const page of preset.reference_html_pages ?? []) {
    const html = await readFile(resolve(presetDir, page.path), "utf8");
    const external = collectExternalFontResources(html);
    const embedded = collectEmbeddedFamilies(html);
    const declared = collectDeclaredFamilies(html);
    const implicitSystemFont = declared.length === 0;
    if (external.length || embedded.length || implicitSystemFont) {
      rows.push({
        ppt_number: preset.ppt_number,
        preset: preset.id,
        page: page.path,
        theme_mode: preset.theme_mode ?? "legacy",
        external_font_resources: external,
        embedded_font_families: embedded,
        declared_font_families: declared,
        implicit_system_font: implicitSystemFont,
      });
    }
  }
}

rows.sort((left, right) => left.ppt_number - right.ppt_number);
console.log(JSON.stringify(rows, null, 2));
