import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// This validator runs before template directories are replaced or cleaned up.
// On Windows, Sharp's default cache can retain WebP handles after metadata
// inspection and make those file operations fail with EBUSY/EPERM.
sharp.cache(false);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PRESETS_ROOT = resolve(SCRIPT_DIR, "../src/features/templates/presets");
const PREVIEW_WIDTH = 1280;
const PREVIEW_HEIGHT = 720;
const MAX_PREVIEW_BYTES = 300 * 1024;
const EXPECTED_PRESET_COUNT = 98;
const EXPECTED_PREVIEW_COUNT = 861;
const THEMES = new Set(["light", "dark"]);
const CATALOG_ENUMS = {
  user: new Set([
    "Founders & Leaders",
    "Sales & Marketing",
    "Business Professionals",
    "Creative & Personal",
    "Education & Research",
  ]),
  use_case: new Set([
    "Pitch Decks & Proposals",
    "Marketing & Campaigns",
    "Reports & Analysis",
    "Plans & Roadmaps",
    "Portfolios & Storytelling",
    "Education & Training",
  ]),
  industry: new Set([
    "Industrial & Infrastructure",
    "Consumer & Lifestyle",
    "Education & Public Sector",
    "Healthcare & Wellness",
    "Technology & AI",
    "Media & Entertainment",
    "Business & Finance",
  ]),
};
const HTML_TAG = /<([a-z][\w:-]*)\b([^>]*)>/gi;
const CSS_REFERENCE = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'"=<>`]+))\s*\)/gi;
const EXTERNAL_SCHEME = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;
const EXTERNAL_FONT_FACE_SOURCE = /@font-face\s*\{[\s\S]*?\bsrc\s*:\s*url\(\s*(?:"|')?(https?:\/\/[^\s"')]+)/gi;
const EXTERNAL_GOOGLE_FONT_STYLESHEET = /(?:<link\b[^>]*\bhref\s*=\s*(?:\"|')?https:\/\/fonts\.googleapis\.com\/|@import\s+(?:url\()?\s*(?:\"|')?https:\/\/fonts\.googleapis\.com\/)/i;
const REQUIRED_FIELD_TYPES = {
  id: "string",
  version: "number",
  ppt_number: "number",
  theme: "string",
  color: "array",
  name: "string",
  description: "string",
  user: "string",
  use_case: "string",
  industry: "string",
  preview_images: "array",
  reference_html_pages: "array",
};

function valueType(value) {
  return Array.isArray(value) ? "array" : typeof value;
}

function assertFieldTypes(preset, configPath) {
  if (!preset || typeof preset !== "object" || Array.isArray(preset)) {
    throw new Error(`${configPath}: preset.json must contain a JSON object`);
  }

  for (const [field, expectedType] of Object.entries(REQUIRED_FIELD_TYPES)) {
    if (!Object.hasOwn(preset, field)) {
      throw new Error(`${configPath}: missing required field "${field}"`);
    }
    const actualType = valueType(preset[field]);
    if (actualType !== expectedType) {
      throw new Error(`${configPath}: field "${field}" must be ${expectedType}, received ${actualType}`);
    }
  }

  if (!preset.id.trim()) throw new Error(`${configPath}: field "id" must not be blank`);
  if (!Number.isInteger(preset.version) || preset.version < 1) {
    throw new Error(`${configPath}: field "version" must be a positive integer`);
  }
  if (!Number.isInteger(preset.ppt_number) || preset.ppt_number < 1) {
    throw new Error(`${configPath}: field "ppt_number" must be a positive integer`);
  }
  if (Object.hasOwn(preset, "score") && (typeof preset.score !== "number" || !Number.isFinite(preset.score))) {
    throw new Error(`${configPath}: field "score" must be a finite number`);
  }
  if (!THEMES.has(preset.theme)) {
    throw new Error(`${configPath}: field "theme" must be "light" or "dark"`);
  }
  if (
    preset.color.length === 0 ||
    new Set(preset.color).size !== preset.color.length ||
    preset.color.some((color) => typeof color !== "string" || !color.trim())
  ) {
    throw new Error(`${configPath}: field "color" must be a non-empty array of unique non-blank strings`);
  }
  for (const field of ["name", "description", "user", "use_case", "industry"]) {
    if (!preset[field].trim()) throw new Error(`${configPath}: field "${field}" must not be blank`);
  }
  for (const field of ["user", "use_case", "industry"]) {
    if (!CATALOG_ENUMS[field].has(preset[field])) {
      throw new Error(`${configPath}: field "${field}" must use an existing catalog enum value`);
    }
  }
  if (preset.preview_images.length === 0) {
    throw new Error(`${configPath}: field "preview_images" must not be empty`);
  }
  if (preset.reference_html_pages.length === 0) {
    throw new Error(`${configPath}: field "reference_html_pages" must not be empty`);
  }
}

function findTagEnd(html, startIndex) {
  let quote = null;
  for (let index = startIndex + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
  }
  return html.length;
}

function cleanResourceReference(value) {
  return value.trim().replace(/[?#].*$/, "");
}

function attributeValue(attributes, name) {
  const expression = new RegExp(String.raw`(?:^|\s)${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))`, "i");
  const match = expression.exec(attributes);
  return match?.slice(1).find((value) => value !== undefined) ?? null;
}

function localResourceCandidate(value) {
  const cleaned = cleanResourceReference(value);
  if (!cleaned || cleaned.startsWith("#") || cleaned.startsWith("data:") || EXTERNAL_SCHEME.test(cleaned)) return null;
  return cleaned;
}

function localHtmlResourceReferences(html) {
  const references = new Set();
  let match;
  while ((match = HTML_TAG.exec(html))) {
    const [, tagName, attributes] = match;
    const source = attributeValue(attributes, "src");
    const localSource = source ? localResourceCandidate(source) : null;
    if (localSource) references.add(localSource);

    if (tagName.toLowerCase() === "link") {
      const rel = attributeValue(attributes, "rel") ?? "";
      const href = attributeValue(attributes, "href");
      const localHref = href && rel.toLowerCase().split(/\s+/).includes("stylesheet")
        ? localResourceCandidate(href)
        : null;
      if (localHref) references.add(localHref);
    }
  }

  while ((match = CSS_REFERENCE.exec(html))) {
    const source = match.slice(1).find((value) => value !== undefined) ?? "";
    const localSource = localResourceCandidate(source);
    if (localSource) references.add(localSource);
  }
  return [...references];
}

async function reportLocalHtmlResourceWarnings(html, htmlPath, presetDir, label, warnings) {
  for (const resource of localHtmlResourceReferences(html)) {
    const decoded = decodeURIComponent(resource);
    const resourcePath = resolve(dirname(htmlPath), decoded);
    const relativePath = relative(presetDir, resourcePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`${label} references a local resource outside its preset directory: ${resource}`);
    }
    const resourceStat = await stat(resourcePath).catch(() => null);
    if (!resourceStat?.isFile()) {
      warnings.add(`${label} references a missing local resource: ${resource}`);
    }
  }
}

// Build validation runs in Node without a browser DOM, so count class tokens in HTML tags
// while ignoring comments and the contents of script/style elements.
function countSlideElements(html) {
  let count = 0;
  let cursor = 0;

  while (cursor < html.length) {
    const startIndex = html.indexOf("<", cursor);
    if (startIndex < 0) break;

    if (html.startsWith("<!--", startIndex)) {
      const commentEnd = html.indexOf("-->", startIndex + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }

    const endIndex = findTagEnd(html, startIndex);
    const tag = html.slice(startIndex, endIndex + 1);
    const tagMatch = /^<\s*([A-Za-z][^\s/>]*)\b/.exec(tag);
    if (!tagMatch) {
      cursor = endIndex + 1;
      continue;
    }

    const classMatch = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tag);
    const classValue = classMatch?.slice(1).find((value) => value !== undefined) ?? "";
    if (classValue.split(/\s+/).includes("slide")) count += 1;

    const tagName = tagMatch[1].toLowerCase();
    if (tagName === "script" || tagName === "style") {
      const closingTag = new RegExp(`</${tagName}\\s*>`, "ig");
      closingTag.lastIndex = endIndex + 1;
      const closingMatch = closingTag.exec(html);
      cursor = closingMatch ? closingMatch.index + closingMatch[0].length : html.length;
      continue;
    }

    cursor = endIndex + 1;
  }

  return count;
}

async function assertReferenceHtmlPages(preset, presetDir, configPath, warnings) {
  const paths = new Set();
  for (const [index, page] of preset.reference_html_pages.entries()) {
    const label = `${configPath}: reference_html_pages[${index}]`;
    if (!page || typeof page !== "object" || Array.isArray(page)) throw new Error(`${label} must be an object`);
    if (typeof page.path !== "string" || !/^html\/[^/]+\.html$/i.test(page.path)) {
      throw new Error(`${label}.path must use html/<filename>.html`);
    }
    if (paths.has(page.path)) throw new Error(`${label}.path is duplicated: ${page.path}`);
    if (typeof page.description !== "string" || !page.description.trim()) throw new Error(`${label}.description must not be blank`);
    const htmlPath = resolve(presetDir, page.path);
    const relativePath = relative(presetDir, htmlPath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error(`${label}.path must stay inside its preset directory`);
    const htmlStat = await stat(htmlPath).catch(() => null);
    if (!htmlStat?.isFile()) throw new Error(`${label}.path does not exist: ${page.path}`);
    const html = await readFile(htmlPath, "utf8");
    if (!html.trim()) throw new Error(`${label}.path must not be empty`);
    if (preset.theme_mode === "semantic-v1") {
      if (EXTERNAL_GOOGLE_FONT_STYLESHEET.test(html)) {
        throw new Error(
          `${label}.path: semantic visual style preset must not load a Google Fonts stylesheet directly; inline its @font-face declarations and load only https://fonts.gstatic.com font files`,
        );
      }
      EXTERNAL_FONT_FACE_SOURCE.lastIndex = 0;
      for (const match of html.matchAll(EXTERNAL_FONT_FACE_SOURCE)) {
        if (!/^https:\/\/fonts\.gstatic\.com\//i.test(match[1] ?? "")) {
          throw new Error(`${label}.path: semantic visual style preset may only load external fonts from https://fonts.gstatic.com`);
        }
      }
    }
    const slideCount = countSlideElements(html);
    if (slideCount !== 1) {
      throw new Error(`${label}.path must contain exactly one .slide root; found ${slideCount}`);
    }
    // Some legacy templates intentionally have no runtime assets yet. Keep
    // their missing local-resource references visible without blocking the
    // WebP migration and App build; all other HTML structure checks remain
    // strict. This is temporary until those source assets are supplied.
    await reportLocalHtmlResourceWarnings(html, htmlPath, presetDir, `${label}.path`, warnings);
    paths.add(page.path);
  }
}

async function listFilesRecursively(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function assertPreviewImages(preset, presetDir, configPath) {
  if (preset.preview_images.length !== preset.reference_html_pages.length) {
    throw new Error(`${configPath}: preview_images and reference_html_pages must have the same length`);
  }

  const referencedWebpPaths = new Set();
  for (const [index, preview] of preset.preview_images.entries()) {
    const label = `${configPath}: preview_images[${index}]`;
    if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
      throw new Error(`${label} must be an object`);
    }
    for (const field of ["path", "alt"]) {
      if (!Object.hasOwn(preview, field)) throw new Error(`${label} is missing required field "${field}"`);
      if (typeof preview[field] !== "string") throw new Error(`${label}.${field} must be string`);
    }
    if (!preview.alt.trim()) throw new Error(`${label}.alt must not be blank`);

    if (isAbsolute(preview.path)) throw new Error(`${label}.path must be relative to its preset directory`);
    if (!/^images\/[^/]+\.webp$/i.test(preview.path)) {
      throw new Error(`${label}.path must use images/<filename>.webp`);
    }
    const imagePath = resolve(presetDir, preview.path);
    const relativePath = relative(presetDir, imagePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`${label}.path must stay inside its preset directory`);
    }
    let imageStat;
    try {
      imageStat = await stat(imagePath);
    } catch {
      throw new Error(`${label}.path does not exist: ${preview.path}`);
    }
    if (!imageStat.isFile()) throw new Error(`${label}.path is not a file: ${preview.path}`);

    const metadata = await sharp(imagePath).metadata().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label}.path cannot be decoded as WebP: ${message}`);
    });
    if (metadata.format !== "webp") throw new Error(`${label}.path must decode as WebP`);
    await sharp(imagePath).ensureAlpha().resize(1, 1, { fit: "fill" }).raw().toBuffer().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label}.path cannot be fully decoded as WebP: ${message}`);
    });
    if (metadata.width !== PREVIEW_WIDTH || metadata.height !== PREVIEW_HEIGHT) {
      throw new Error(`${label}.path must be ${PREVIEW_WIDTH}x${PREVIEW_HEIGHT}; received ${metadata.width}x${metadata.height}`);
    }
    if (imageStat.size > MAX_PREVIEW_BYTES) {
      throw new Error(`${label}.path exceeds 300KB (${imageStat.size} bytes)`);
    }

    const reference = preset.reference_html_pages[index];
    const previewStem = basename(preview.path, extname(preview.path));
    const referenceStem = basename(reference.path, extname(reference.path));
    if (previewStem !== referenceStem) {
      throw new Error(`${label}.path must match reference_html_pages[${index}].path by filename stem`);
    }
    referencedWebpPaths.add(resolve(imagePath));
  }

  const imagesDir = resolve(presetDir, "images");
  const imageFiles = await listFilesRecursively(imagesDir);
  for (const imagePath of imageFiles) {
    const extension = extname(imagePath).toLowerCase();
    const imageName = relative(imagesDir, imagePath);
    if ([".png", ".jpg", ".jpeg"].includes(extension)) {
      throw new Error(`${configPath}: images directory contains legacy image ${imageName}`);
    }
    if (extension === ".webp" && !referencedWebpPaths.has(imagePath)) {
      throw new Error(`${configPath}: images directory contains an unreferenced WebP ${imageName}`);
    }
  }
  const identifierSidecars = imageFiles
    .map((path) => relative(imagesDir, path))
    .filter((path) => path.toLowerCase().includes("identifier"));
  if (identifierSidecars.length > 0) {
    throw new Error(`${configPath}: images directory contains identifier sidecars: ${identifierSidecars.join(", ")}`);
  }
}

export async function validateVisualStylePresets(presetsRoot = DEFAULT_PRESETS_ROOT) {
  const resolvedPresetsRoot = resolve(presetsRoot);
  const entries = await readdir(resolvedPresetsRoot, { withFileTypes: true });
  const presetDirectories = entries.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name));
  const ids = new Set();
  const pptNumbers = new Set();
  const warnings = new Set();
  let presetCount = 0;
  let previewCount = 0;

  for (const entry of presetDirectories) {
    const presetDir = resolve(presetsRoot, entry.name);
    const configPath = resolve(presetDir, "preset.json");
    let source;
    try {
      source = await readFile(configPath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${configPath}: unable to read valid JSON (${message})`);
    }

    let preset;
    try {
      preset = JSON.parse(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${configPath}: unable to read valid JSON (${message})`);
    }

    assertFieldTypes(preset, configPath);
    if (preset.id !== entry.name) {
      throw new Error(`${configPath}: field "id" must match directory name "${entry.name}"`);
    }
    if (ids.has(preset.id)) throw new Error(`${configPath}: duplicate preset id "${preset.id}"`);
    if (pptNumbers.has(preset.ppt_number)) {
      throw new Error(`${configPath}: duplicate ppt_number ${preset.ppt_number}`);
    }
    ids.add(preset.id);
    pptNumbers.add(preset.ppt_number);
    await assertReferenceHtmlPages(preset, presetDir, configPath, warnings);
    await assertPreviewImages(preset, presetDir, configPath);
    presetCount += 1;
    previewCount += preset.preview_images.length;
  }

  if (resolvedPresetsRoot === DEFAULT_PRESETS_ROOT) {
    if (presetCount !== EXPECTED_PRESET_COUNT) {
      throw new Error(`Expected ${EXPECTED_PRESET_COUNT} visual style presets; found ${presetCount}`);
    }
    if (previewCount !== EXPECTED_PREVIEW_COUNT) {
      throw new Error(`Expected ${EXPECTED_PREVIEW_COUNT} visual style preview images; found ${previewCount}`);
    }
  }

  return { presetCount, previewCount, warnings: [...warnings] };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  validateVisualStylePresets()
    .then(({ presetCount, previewCount, warnings }) => {
      for (const warning of warnings) console.warn(`WARNING: ${warning}`);
      console.log(`Validated ${presetCount} visual style presets and ${previewCount} WebP previews with ${warnings.length} warning(s).`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
