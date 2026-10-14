import { basename, extname, join, parse } from "node:path";
import { assertFile, listDirectories, readJson, resolveInside } from "./files.mjs";

const THEMES = new Set(["light", "dark"]);
const REQUIRED_STRING_FIELDS = ["id", "name", "description", "user", "use_case", "industry"];

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
}

function validateMetadata(preset, label) {
  for (const field of REQUIRED_STRING_FIELDS) assertNonEmptyString(preset[field], `${label}.${field}`);
  if (!Number.isInteger(preset.version) || preset.version < 1) {
    throw new Error(`${label}.version must be a positive integer.`);
  }
  if (!Number.isInteger(preset.ppt_number) || preset.ppt_number < 1) {
    throw new Error(`${label}.ppt_number must be a positive integer.`);
  }
  if (Object.hasOwn(preset, "score") && (typeof preset.score !== "number" || !Number.isFinite(preset.score))) {
    throw new Error(`${label}.score must be a finite number when present.`);
  }
  if (!THEMES.has(preset.theme)) throw new Error(`${label}.theme must be "light" or "dark".`);
  if (
    !Array.isArray(preset.color)
    || preset.color.length === 0
    || new Set(preset.color).size !== preset.color.length
    || preset.color.some((color) => typeof color !== "string" || !color.trim())
  ) {
    throw new Error(`${label}.color must contain unique non-empty strings.`);
  }
}

export function validatePreset(preset, label) {
  if (!preset || typeof preset !== "object" || Array.isArray(preset)) {
    throw new Error(`${label} must contain an object.`);
  }
  validateMetadata(preset, label);
  if (!Array.isArray(preset.preview_images) || preset.preview_images.length === 0) {
    throw new Error(`${label}.preview_images must be a non-empty array.`);
  }
  if (!Array.isArray(preset.reference_html_pages) || preset.reference_html_pages.length === 0) {
    throw new Error(`${label}.reference_html_pages must be a non-empty array.`);
  }
  if (preset.preview_images.length !== preset.reference_html_pages.length) {
    throw new Error(`${label} preview_images and reference_html_pages must have the same length.`);
  }
}

export function previewReferencePairs(preset, label) {
  validatePreset(preset, label);
  const previewPaths = new Set();
  const referencePaths = new Set();
  return preset.reference_html_pages.map((reference, index) => {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
      throw new Error(`${label}.reference_html_pages[${index}] must be an object.`);
    }
    assertNonEmptyString(reference.path, `${label}.reference_html_pages[${index}].path`);
    assertNonEmptyString(reference.description, `${label}.reference_html_pages[${index}].description`);
    if (!/^html\/[^/]+\.html$/i.test(reference.path)) {
      throw new Error(`${label}.reference_html_pages[${index}].path must use html/<filename>.html.`);
    }
    if (referencePaths.has(reference.path)) {
      throw new Error(`${label}.reference_html_pages[${index}].path is duplicated: ${reference.path}`);
    }
    referencePaths.add(reference.path);

    const preview = preset.preview_images[index];
    if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
      throw new Error(`${label}.preview_images[${index}] must be an object.`);
    }
    assertNonEmptyString(preview.path, `${label}.preview_images[${index}].path`);
    assertNonEmptyString(preview.alt, `${label}.preview_images[${index}].alt`);
    if (!/^images\/[^/]+\.(?:png|jpe?g|webp)$/i.test(preview.path)) {
      throw new Error(`${label}.preview_images[${index}].path must use images/<filename>.<png|jpg|jpeg|webp>.`);
    }
    if (previewPaths.has(preview.path)) {
      throw new Error(`${label}.preview_images[${index}].path is duplicated: ${preview.path}`);
    }
    previewPaths.add(preview.path);

    const previewStem = parse(basename(preview.path)).name;
    const referenceStem = parse(basename(reference.path)).name;
    if (previewStem !== referenceStem) {
      throw new Error(
        `${label} preview_images[${index}] and reference_html_pages[${index}] must use the same filename stem.`,
      );
    }
    return { index, preview, reference, fileStem: previewStem };
  });
}

export function outputPreset(preset, label) {
  return {
    ...preset,
    preview_images: previewReferencePairs(preset, label).map(({ preview }) => ({
      ...preview,
      path: preview.path.replace(/\.(png|jpe?g|webp)$/i, ".webp"),
    })),
  };
}

export async function loadPresets(root) {
  const presets = [];
  const pptNumbers = new Set();
  for (const directoryName of await listDirectories(root)) {
    const presetDirectory = join(root, directoryName);
    const presetPath = join(presetDirectory, "preset.json");
    await assertFile(presetPath, `Preset JSON for ${directoryName}`);
    const preset = await readJson(presetPath, `Preset JSON for ${directoryName}`);
    previewReferencePairs(preset, presetPath);
    if (preset.id !== directoryName) throw new Error(`${presetPath}.id must match its directory name.`);
    if (pptNumbers.has(preset.ppt_number)) {
      throw new Error(`${presetPath}.ppt_number is duplicated: ${preset.ppt_number}`);
    }
    pptNumbers.add(preset.ppt_number);
    presets.push({ directoryName, presetDirectory, presetPath, preset });
  }
  if (presets.length === 0) throw new Error(`${root} does not contain any preset directories.`);
  return presets;
}

export function sourceHtmlPath(presetDirectory, reference, label) {
  if (extname(reference.path).toLowerCase() !== ".html") throw new Error(`${label} must reference an HTML file.`);
  return resolveInside(presetDirectory, reference.path, label);
}

export function outputPreviewPath(outputRoot, presetId, previewPath) {
  const webpPath = previewPath.replace(/\.(png|jpe?g|webp)$/i, ".webp");
  if (webpPath === previewPath && extname(previewPath).toLowerCase() !== ".webp") {
    throw new Error(`Preview path must use an image extension: ${previewPath}`);
  }
  return resolveInside(join(outputRoot, presetId), webpPath, `Output preview path for ${presetId}`);
}
