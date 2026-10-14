import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dedupeEmbeddedFontFaces } from "./dedupe-embedded-template-fonts.mjs";

const presetsRoot = resolve("src/features/templates/presets");
const targetPresetIds = process.argv.slice(2);
const fontLink = /<link\b([^>]*)>/gi;
const hrefAttribute = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i;
const relAttribute = /\brel\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i;
const preconnectLink = /<link\b[^>]*\bhref\s*=\s*(?:"|')?(?:https?:)?\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/gi;
const fontFace = /@font-face\s*\{[\s\S]*?\}/gi;
const urlInFace = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/i;
const latinRange = /unicode-range\s*:\s*U\+0000-00FF/i;
const resourceCache = new Map();

function stylesheetLinks(html) {
  const links = [];
  fontLink.lastIndex = 0;
  let match;
  while ((match = fontLink.exec(html))) {
    const attributes = match[1];
    const rel = relAttribute.exec(attributes)?.slice(1).find((value) => value !== undefined) ?? "";
    const href = hrefAttribute.exec(attributes)?.slice(1).find((value) => value !== undefined) ?? "";
    if (rel.split(/\s+/).includes("stylesheet") && /^https:\/\/fonts\.googleapis\.com\//i.test(href)) links.push(href);
  }
  return links;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36" },
  });
  if (!response.ok) throw new Error(`Unable to fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

async function embedFace(face) {
  const source = urlInFace.exec(face)?.[1];
  if (!source) return face;
  let encoded = resourceCache.get(source);
  if (!encoded) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Unable to fetch ${source}: ${response.status} ${response.statusText}`);
    encoded = Buffer.from(await response.arrayBuffer()).toString("base64");
    resourceCache.set(source, encoded);
  }
  return face.replace(source, `data:font/woff2;base64,${encoded}`);
}

async function embeddedFontCss(links) {
  const stylesheets = await Promise.all(links.map(fetchText));
  const faces = [];
  for (const stylesheet of stylesheets) {
    fontFace.lastIndex = 0;
    let match;
    while ((match = fontFace.exec(stylesheet))) {
      if (latinRange.test(match[0])) faces.push(await embedFace(match[0]));
    }
  }
  return faces.join("\n");
}

if (targetPresetIds.length === 0) {
  throw new Error("Usage: node scripts/embed-semantic-template-fonts.mjs <preset-id> [...preset-id]");
}

for (const presetId of targetPresetIds) {
  const presetDir = resolve(presetsRoot, presetId);
  const preset = JSON.parse(await readFile(resolve(presetDir, "preset.json"), "utf8"));
  if (preset.theme_mode !== "semantic-v1") throw new Error(`${presetId} is not a semantic-v1 preset`);
  for (const page of preset.reference_html_pages) {
    const htmlPath = resolve(presetDir, page.path);
    const html = await readFile(htmlPath, "utf8");
    const links = stylesheetLinks(html);
    if (links.length === 0) continue;
    const css = await embeddedFontCss(links);
    if (!css) throw new Error(`${presetId}/${page.path} has no Latin font faces to embed`);
    const withoutLinks = html
      .replace(preconnectLink, "")
      .replace(fontLink, (tag, attributes) => {
        const href = hrefAttribute.exec(attributes)?.slice(1).find((value) => value !== undefined) ?? "";
        return /^https:\/\/fonts\.googleapis\.com\//i.test(href) ? "" : tag;
      });
    const replacement = `<!-- Embedded font resources: Google Fonts OFL families required by this cover. -->\n<style data-embedded-template-fonts>\n${css}\n</style>`;
    const embeddedHtml = withoutLinks.replace("</head>", `${replacement}\n</head>`);
    await writeFile(htmlPath, dedupeEmbeddedFontFaces(embeddedHtml).html);
    console.log(`Embedded ${links.length} stylesheet(s) in ${presetId}/${page.path}`);
  }
}
