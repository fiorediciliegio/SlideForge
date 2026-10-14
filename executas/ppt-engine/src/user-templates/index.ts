import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { composeImageSlots } from "./image-slots.js";
import { composeAssetSlots } from "./asset-slots.js";
import { userTemplateRoot as root, userTemplateDirectory as directory, resolveUserTemplateDirectory } from "./storage.js";
import { rasterizePptxToImages } from "../pptx-rasterization/index.js";
import { staticizeHtmlDocuments, writeSlideScreenshots } from "../render/browser-artifacts.js";
import { buildHtmlPageSourceDocumentHtml, createPageSourceRenderContext } from "../render/page-source-document.js";
import type { DesignProfile, UserTemplate, UserTemplateAsset, UserTemplateMetadata } from "./types.js";
export type { DesignProfile, DesignProfileColor, DesignProfileFixedAsset, DesignProfileTypography, UserTemplate, UserTemplateAsset, UserTemplateMetadata } from "./types.js";
export { appendUserTemplateLog, recordUserTemplateOperation } from "./diagnostics.js";
export { prepareUserTemplateDiagnosticBundle } from "./diagnostic-bundle.js";

export const USER_TEMPLATE_MAX_BYTES = 20 * 1024 * 1024;
/** Logo/profile assets stay small: they ride the same transfer stack and are
 *  composited after generation, so cap them well below source files. */
export const PROFILE_ASSET_MAX_BYTES = 5 * 1024 * 1024;
const pageBase = (n: number) => `page-${String(n).padStart(3, "0")}`;
async function exists(file: string) {
  try { return (await stat(file)).isFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function atomicWrite(file: string, content: string | Buffer) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
export function validateUserTemplatePages(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.length > 6 || value.some((n) => !Number.isInteger(n) || n < 1) || new Set(value).size !== value.length) {
    throw new Error("Select between 1 and 6 unique positive page numbers");
  }
  return value as number[];
}
export function validateTemplateHtml(html: string) {
  const documents = html.match(/(?:<!doctype\s+html[^>]*>\s*)?<html\b[^>]*>[\s\S]*?<\/html\s*>/gi) ?? [];
  if (documents.length !== 1 || documents[0].trim() !== html.trim()) throw new Error("Expected exactly one complete HTML document");
}
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
function optionalString(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error(`${label} must be a string of at most ${max} characters`);
  return value;
}
function optionalStringList(value: unknown, maxItems: number, maxLength: number, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || !item.trim() || item.length > maxLength)) throw new Error(`${label} must be a list of at most ${maxItems} non-empty strings of at most ${maxLength} characters`);
  return value.map((item) => item.trim());
}
export function validateDesignProfile(value: unknown): DesignProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Design profile must be an object");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.colors) || !record.colors.length || record.colors.length > 6) throw new Error("Design profile needs between 1 and 6 colors");
  const colors = record.colors.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Each color must be an object");
    const color = item as Record<string, unknown>;
    if (typeof color.token !== "string" || !color.token.trim() || color.token.length > 40) throw new Error("Color token must be a non-empty string of at most 40 characters");
    if (typeof color.hex !== "string" || !HEX_COLOR.test(color.hex)) throw new Error(`Color ${color.token} needs an exact hex value like #1B4F9C`);
    if (typeof color.role !== "string" || !color.role.trim() || color.role.length > 80) throw new Error("Color role must be a non-empty string of at most 80 characters");
    return {
      token: color.token.trim(),
      hex: color.hex.toUpperCase(),
      role: color.role.trim(),
      usage: optionalString(color.usage, 300, "Color usage"),
      source: optionalString(color.source, 300, "Color source"),
    };
  });
  if (new Set(colors.map((color) => color.token)).size !== colors.length) throw new Error("Color tokens must be unique");
  const profile: DesignProfile = { colors };
  if (record.typography !== undefined && record.typography !== null) {
    if (typeof record.typography !== "object" || Array.isArray(record.typography)) throw new Error("Typography must be an object");
    const typography = record.typography as Record<string, unknown>;
    profile.typography = {
      heading_font: optionalString(typography.heading_font, 80, "Heading font"),
      body_font: optionalString(typography.body_font, 80, "Body font"),
      fallback_fonts: optionalStringList(typography.fallback_fonts, 4, 80, "Fallback fonts"),
      notes: optionalString(typography.notes, 300, "Typography notes"),
    };
  }
  profile.layout_rules = optionalStringList(record.layout_rules, 12, 300, "Layout rules");
  if (record.fixed_assets !== undefined && record.fixed_assets !== null) {
    if (!Array.isArray(record.fixed_assets) || record.fixed_assets.length > 4) throw new Error("Fixed assets must be a list of at most 4 items");
    profile.fixed_assets = record.fixed_assets.map((item) => {
      if (!item || typeof item !== "object") throw new Error("Each fixed asset must be an object");
      const asset = item as Record<string, unknown>;
      if (asset.kind !== "logo") throw new Error("Only logo fixed assets are supported");
      const image = asset.image === undefined || asset.image === null ? undefined : (() => {
        if (typeof asset.image !== "object" || Array.isArray(asset.image)) throw new Error("Asset image must be an object");
        const record = asset.image as Record<string, unknown>;
        if (typeof record.filename !== "string" || !record.filename || path.basename(record.filename) !== record.filename || /[\\/]/.test(record.filename)) throw new Error("Asset image filename must be a safe basename");
        if (typeof record.mime_type !== "string" || !record.mime_type || record.mime_type.length > 80) throw new Error("Asset image mime type must be a string");
        if (typeof record.size_bytes !== "number" || !Number.isInteger(record.size_bytes) || record.size_bytes < 1 || record.size_bytes > PROFILE_ASSET_MAX_BYTES) throw new Error(`Asset image must be at most ${PROFILE_ASSET_MAX_BYTES} bytes`);
        return { filename: record.filename, mime_type: record.mime_type, size_bytes: record.size_bytes };
      })();
      return {
        kind: "logo" as const,
        label: optionalString(asset.label, 80, "Asset label"),
        position_rule: optionalString(asset.position_rule, 200, "Asset position rule"),
        notes: optionalString(asset.notes, 300, "Asset notes"),
        image,
      };
    });
  }
  profile.voice = optionalString(record.voice, 300, "Voice");
  profile.do = optionalStringList(record.do, 10, 200, "Do list");
  profile.dont = optionalStringList(record.dont, 10, 200, "Don't list");
  if (record.evidence !== undefined && record.evidence !== null) {
    if (typeof record.evidence !== "object" || Array.isArray(record.evidence)) throw new Error("Evidence must be an object");
    const entries = Object.entries(record.evidence);
    if (entries.length > 20 || entries.some(([, item]) => typeof item !== "string" || item.length > 300)) throw new Error("Evidence maps a field to a note of at most 300 characters");
    profile.evidence = Object.fromEntries(entries);
  }
  return profile;
}
export async function saveUserTemplateProfile(id: string, profile: DesignProfile): Promise<UserTemplate> {
  const record = await getUserTemplate(id);
  if (record.status === "ready") throw new Error("Published templates are immutable");
  const validated = validateDesignProfile(profile);
  await atomicWrite(path.join(directory(id), "profile.json"), JSON.stringify(validated));
  return getUserTemplate(id);
}
export async function getUserTemplate(id: string): Promise<UserTemplate> {
  const dir = await resolveUserTemplateDirectory(id);
  const record = JSON.parse(await readFile(path.join(dir, "template.json"), "utf8")) as UserTemplate;
  const profilePath = path.join(dir, "profile.json");
  const profile_ready = await exists(profilePath);
  return {
    ...record,
    profile: profile_ready ? JSON.parse(await readFile(profilePath, "utf8")) as DesignProfile : null,
    profile_ready,
    source_ready: record.source_kind === "images" ? (record.source_files?.length ?? 0) > 0 : await exists(path.join(dir, "source.pptx")),
    master_ready: await exists(path.join(dir, "previews", "master.png")),
    completed_pages: (await Promise.all(record.pages.map(async (p) => await exists(path.join(dir, "previews", `${pageBase(p.page_number)}.png`)) ? p.page_number : null))).filter((n): n is number => n !== null),
  };
}
export async function listUserTemplates(): Promise<UserTemplate[]> {
  await mkdir(root(), { recursive: true });
  const records: UserTemplate[] = [];
  for (const entry of await readdir(root(), { withFileTypes: true })) {
    if (entry.isDirectory() && /^user-[a-f0-9-]{36}$/.test(entry.name) && await exists(path.join(root(), entry.name, "template.json"))) records.push(await getUserTemplate(entry.name));
  }
  return records.sort((a, b) => b.created_at.localeCompare(a.created_at));
}
export async function deleteUserTemplate(id: string): Promise<{ deleted: true; id: string }> {
  const dir = await resolveUserTemplateDirectory(id);
  if (!await exists(path.join(dir, "template.json"))) throw new Error("Unknown user template");
  await rm(dir, { recursive: true, force: true });
  return { deleted: true, id };
}
function validateFilename(filename: string) {
  if (!filename || path.basename(filename) !== filename || /[\\/]/.test(filename) || !/\.pptx$/i.test(filename)) throw new Error("A single PPTX file is required");
}
async function readSource(input: { staging_file_path: string; size_bytes: number }) {
  const file = await readFile(input.staging_file_path);
  if (file.length !== input.size_bytes || file.length === 0 || file.length > USER_TEMPLATE_MAX_BYTES) throw new Error("PPTX must be non-empty and at most 20 MB");
  if (file[0] !== 0x50 || file[1] !== 0x4b) throw new Error("Invalid PPTX archive");
  return file;
}
/** Allocate the diagnostic owner before the first network upload. */
export async function createUserTemplateDraft(input: { filename: string }): Promise<UserTemplate> {
  validateFilename(input.filename);
  const id = `user-${randomUUID()}`;
  const dir = directory(id);
  await mkdir(dir, { recursive: true });
  const record: UserTemplate = { id, version: 1, name: input.filename.replace(/\.pptx$/i, ""), description: "", filename: input.filename, status: "draft", created_at: new Date().toISOString(), pages: [], master_ready: false, completed_pages: [], source_ready: false };
  await atomicWrite(path.join(dir, "template.json"), JSON.stringify(record));
  return record;
}
const IMAGE_EXTENSIONS: Record<string, { mime: string; matches: (buffer: Buffer) => boolean }> = {
  ".png": { mime: "image/png", matches: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  ".jpg": { mime: "image/jpeg", matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  ".jpeg": { mime: "image/jpeg", matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  ".webp": { mime: "image/webp", matches: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
};
export function validateImageTemplateFiles(files: { filename: string; size_bytes: number }[]) {
  if (!Array.isArray(files) || !files.length || files.length > 6) throw new Error("Select between 1 and 6 images");
  for (const file of files) {
    if (!IMAGE_EXTENSIONS[path.extname(file.filename).toLowerCase()]) throw new Error("Only PNG, JPEG or WebP images are supported");
    if (file.size_bytes <= 0 || file.size_bytes > USER_TEMPLATE_MAX_BYTES) throw new Error("Each image must be non-empty and at most 20 MB");
  }
}
export async function createImageUserTemplate(input: { files: { filename: string; staging_file_path: string; size_bytes: number }[] }): Promise<UserTemplate> {
  validateImageTemplateFiles(input.files);
  const buffers: Buffer[] = [];
  const names: string[] = [];
  for (const file of input.files) {
    if (!file.filename || path.basename(file.filename) !== file.filename) throw new Error("Invalid image filename");
    const ext = path.extname(file.filename).toLowerCase();
    const buffer = await readFile(file.staging_file_path);
    if (buffer.length !== file.size_bytes || buffer.length === 0 || buffer.length > USER_TEMPLATE_MAX_BYTES) throw new Error("Each image must be non-empty and at most 20 MB");
    if (!IMAGE_EXTENSIONS[ext].matches(buffer)) throw new Error("File content does not match its image extension");
    buffers.push(buffer);
    names.push(file.filename);
  }
  const id = `user-${randomUUID()}`;
  const dir = directory(id);
  await mkdir(dir, { recursive: true });
  const source_files = await Promise.all(buffers.map(async (buffer, index) => {
    const ext = path.extname(names[index]).toLowerCase();
    const stored = `source-${index + 1}${ext}`;
    await writeFile(path.join(dir, stored), buffer);
    return stored;
  }));
  const record: UserTemplate = { id, version: 1, name: names[0].replace(/\.[^.]+$/, ""), description: "", filename: names.join(", "), source_kind: "images", source_files, status: "draft", created_at: new Date().toISOString(), pages: [], master_ready: false, completed_pages: [] };
  await atomicWrite(path.join(dir, "template.json"), JSON.stringify(record));
  return record;
}
export async function saveUserTemplateSource(input: { id: string; filename: string; staging_file_path: string; size_bytes: number }): Promise<UserTemplate> {
  validateFilename(input.filename);
  const record = await getUserTemplate(input.id);
  if (record.status === "ready" || record.source_ready) throw new Error("Template source is already saved");
  if (input.filename !== record.filename) throw new Error("Select the original PPTX filename to continue this draft");
  const file = await readSource(input);
  await atomicWrite(path.join(await resolveUserTemplateDirectory(input.id), "source.pptx"), file);
  return getUserTemplate(input.id);
}
/** Store one imported profile asset (e.g. a logo) under the template's assets/
 *  directory. The engine disk is the single source of truth; profile.json only
 *  records the returned metadata. Mirrors the source-file transfer pattern. */
export async function saveUserTemplateProfileAsset(input: { id: string; filename: string; staging_file_path: string; size_bytes: number }): Promise<{ filename: string; mime_type: string; size_bytes: number }> {
  if (!input.filename || path.basename(input.filename) !== input.filename || /[\\/]/.test(input.filename)) throw new Error("Invalid asset filename");
  const record = await getUserTemplate(input.id);
  if (record.status === "ready") throw new Error("Published templates are immutable");
  const ext = path.extname(input.filename).toLowerCase();
  const kind = IMAGE_EXTENSIONS[ext];
  if (!kind) throw new Error("Only PNG, JPEG or WebP images are supported");
  const buffer = await readFile(input.staging_file_path);
  if (buffer.length !== input.size_bytes || buffer.length === 0 || buffer.length > PROFILE_ASSET_MAX_BYTES) throw new Error(`Asset must be non-empty and at most ${PROFILE_ASSET_MAX_BYTES} bytes`);
  if (!kind.matches(buffer)) throw new Error("File content does not match its image extension");
  const assetsDir = path.join(await resolveUserTemplateDirectory(input.id), "assets");
  await mkdir(assetsDir, { recursive: true });
  let index = 1;
  while (await exists(path.join(assetsDir, `logo-${index}${ext}`))) index += 1;
  const stored = `logo-${index}${ext}`;
  await atomicWrite(path.join(assetsDir, stored), buffer);
  return { filename: stored, mime_type: kind.mime, size_bytes: buffer.length };
}
export async function createUserTemplate(input: { filename: string; staging_file_path: string; size_bytes: number }): Promise<UserTemplate> {
  validateFilename(input.filename);
  await readSource(input);
  const record = await createUserTemplateDraft(input);
  return saveUserTemplateSource({ ...input, id: record.id });
}
export async function selectUserTemplatePages(id: string, numbers: number[], rasterize = rasterizePptxToImages): Promise<UserTemplate> {
  const pages = validateUserTemplatePages(numbers);
  const record = await getUserTemplate(id);
  if (record.status === "ready") throw new Error("Published templates are immutable");
  const dir = directory(id);
  if (record.source_kind === "images") {
    // Images are their own references: validating the selection is all we need.
    const available = record.source_files?.length ?? 0;
    if (pages.some((n) => n > available)) throw new Error("Unknown template page");
  } else {
    if (record.pages.length && JSON.stringify(record.pages.map((p) => p.page_number)) !== JSON.stringify(pages)) throw new Error("Cannot change selected pages during a template run");
    await rasterize({ pptx_path: path.join(dir, "source.pptx"), output_dir: path.join(dir, "references"), page_numbers: pages, target_height: 1080, overwrite: true });
  }
  record.pages = pages.map((page_number) => ({ page_number, description: "" }));
  await atomicWrite(path.join(dir, "template.json"), JSON.stringify(record));
  return getUserTemplate(id);
}
async function renderPreview(html: string, htmlPath: string, screenshotPath: string) {
  await staticizeHtmlDocuments([{ htmlPath, kind: "page" }], "User template preview");
  await writeSlideScreenshots([{ html, htmlPath, outputPath: screenshotPath }], "User template preview");
}
export async function saveUserTemplateHtml(input: { id: string; page_number?: number; staging_file_path: string }, render = renderPreview): Promise<UserTemplate> {
  const record = await getUserTemplate(input.id);
  // Ready templates accept HTML edits: decks consume the publish-time snapshot
  // and confirmed Workspaces keep their own copy, so editing here only takes
  // effect on the next re-publish (see publishUserTemplate).
  if (input.page_number !== undefined && !record.pages.some((p) => p.page_number === input.page_number)) throw new Error("Unknown template page");
  const html = await readFile(input.staging_file_path, "utf8");
  validateTemplateHtml(html);
  // Image protocol: fill model-emitted photo placeholders with the page's
  // original reference raster (the model cannot recreate photography; it
  // leaves a full-bleed slot, the engine inlines the real image).
  let composedHtml = html;
  if (input.page_number !== undefined) {
    let referencePath: string | undefined;
    try { referencePath = (await getUserTemplateAsset(input.id, "reference", input.page_number)).file_path; }
    catch { referencePath = undefined; }
    composedHtml = await composeImageSlots(html, referencePath);
  }
  // Fixed-asset protocol (master and pages alike): the model only leaves
  // <div class="asset-slot" data-asset data-region>; the engine resolves the
  // pristine asset from the template's assets/ dir and composites it at the
  // region grid's coordinates. Unknown assets degrade to a visible marker
  // instead of failing the save.
  composedHtml = await composeAssetSlots(composedHtml, async (filename) => {
    try { return (await getUserTemplateAsset(input.id, "profile_asset", undefined, filename)).file_path; }
    catch { return undefined; }
  });
  const dir = directory(input.id);
  const base = input.page_number === undefined ? "master" : pageBase(input.page_number);
  await mkdir(path.join(dir, "html"), { recursive: true });
  await mkdir(path.join(dir, "previews"), { recursive: true });
  // Two-slot versioning: the outgoing version slides into <base>.previous.html
  // (master and pages alike) so "revert" is a plain save of that content —
  // the slots swap back. One step of undo, zero extra tools.
  if (await exists(path.join(dir, "html", `${base}.html`))) {
    await atomicWrite(path.join(dir, "html", `${base}.previous.html`), await readFile(path.join(dir, "html", `${base}.html`), "utf8"));
  }
  await atomicWrite(path.join(dir, "html", `${base}.html`), composedHtml);
  const htmlPath = path.join(dir, "previews", `${base}.html`);
  const previewHtml = buildHtmlPageSourceDocumentHtml({ sourceHtml: composedHtml, context: createPageSourceRenderContext({ id: base, title: record.name, templateGroup: "user-template" }) });
  await writeFile(htmlPath, previewHtml, "utf8");
  const screenshotPath = path.join(dir, "previews", `${base}.png`);
  const temporaryScreenshot = path.join(dir, "previews", `${base}.${randomUUID()}.png`);
  await rm(screenshotPath, { force: true });
  try {
    await render(previewHtml, htmlPath, temporaryScreenshot);
    await rename(temporaryScreenshot, screenshotPath);
  } finally { await rm(temporaryScreenshot, { force: true }); }
  return getUserTemplate(input.id);
}
/** Current HTML for the master or one page, plus the two-slot previous version
 *  (null until that document has been saved twice). */
export async function getUserTemplateHtmls(id: string, pageNumber?: number): Promise<{ html: string; previous_html: string | null }> {
  const record = await getUserTemplate(id);
  if (pageNumber !== undefined && !record.pages.some((p) => p.page_number === pageNumber)) throw new Error("Unknown template page");
  const dir = directory(record.id);
  const base = pageNumber === undefined ? "master" : pageBase(pageNumber);
  const html = await readFile(path.join(dir, "html", `${base}.html`), "utf8");
  const previousPath = path.join(dir, "html", `${base}.previous.html`);
  const previous_html = await exists(previousPath) ? await readFile(previousPath, "utf8") : null;
  return { html, previous_html };
}
export async function publishUserTemplate(id: string, metadata: UserTemplateMetadata): Promise<UserTemplate> {
  const record = await getUserTemplate(id);
  // Re-publish: ready templates accept master/page HTML edits (e.g. from the
  // master workbench); rebuild the snapshot and bump the template version.
  // Already-confirmed Workspaces keep their own snapshot copy, so they are
  // unaffected. Metadata is reused from the published record.
  if (record.status === "ready") {
    if (!record.master_ready || !record.pages.length || record.completed_pages.length !== record.pages.length) throw new Error("Template HTML and previews are not complete");
    if (record.pages.some((p) => !p.description.trim())) throw new Error("Each template page needs a concise description");
    const version = record.version + 1;
    const result: UserTemplate = { ...record, version, status: "ready" };
    const dir = directory(id);
    const snapshot = {
      version: 1,
      preset: { id, version, name: result.name, description: result.description },
      fixed_assets: (record.profile?.fixed_assets ?? []).filter((asset) => asset.image).map((asset) => asset.image),
      visual_master_html: await readFile(path.join(dir, "html/master.html"), "utf8"),
      reference_html_pages: await Promise.all(record.pages.map(async (p) => ({ path: `html/${pageBase(p.page_number)}.html`, description: p.description, html: await readFile(path.join(dir, "html", `${pageBase(p.page_number)}.html`), "utf8") }))),
    };
    await atomicWrite(path.join(dir, "snapshot.json"), JSON.stringify(snapshot));
    await atomicWrite(path.join(dir, "template.json"), JSON.stringify(result));
    return result;
  }
  if (!record.master_ready || !record.pages.length || record.completed_pages.length !== record.pages.length) throw new Error("Template HTML and previews are not complete");
  if (typeof metadata.name !== "string" || !metadata.name.trim() || metadata.name.length > 160 || typeof metadata.description !== "string" || !metadata.description.trim() || metadata.description.length > 2000) throw new Error("Template name and description are required");
  const numbers = validateUserTemplatePages(metadata.pages?.map((p) => p.page_number));
  if (numbers.length !== record.pages.length || numbers.some((n) => !record.pages.some((p) => p.page_number === n))) throw new Error("Descriptions must cover exactly the selected pages");
  const pages = record.pages.map((p) => {
    const description = metadata.pages.find((item) => item.page_number === p.page_number)?.description;
    if (typeof description !== "string" || !description.trim() || description.length > 1000) throw new Error("Each template page needs a concise description");
    return { ...p, description: description.trim() };
  });
  const result: UserTemplate = { ...record, name: metadata.name.trim(), description: metadata.description.trim(), pages, status: "ready" };
  const dir = directory(id);
  const snapshot = {
    version: 1,
    preset: { id, version: 1, name: result.name, description: result.description },
    fixed_assets: (record.profile?.fixed_assets ?? []).filter((asset) => asset.image).map((asset) => asset.image),
    visual_master_html: await readFile(path.join(dir, "html/master.html"), "utf8"),
    reference_html_pages: await Promise.all(pages.map(async (p) => ({ path: `html/${pageBase(p.page_number)}.html`, description: p.description, html: await readFile(path.join(dir, "html", `${pageBase(p.page_number)}.html`), "utf8") }))),
  };
  await atomicWrite(path.join(dir, "snapshot.json"), JSON.stringify(snapshot));
  await atomicWrite(path.join(dir, "template.json"), JSON.stringify(result));
  return result;
}
export async function getUserTemplateAsset(id: string, asset: UserTemplateAsset, pageNumber?: number, filename?: string) {
  const record = await getUserTemplate(id);
  const dir = directory(id);
  if (pageNumber !== undefined && record.source_kind !== "images" && !record.pages.some((p) => p.page_number === pageNumber)) throw new Error("Unknown template page");
  let file: string;
  let mimeType: string;
  const base = pageNumber === undefined ? "master" : pageBase(pageNumber);
  const imageSourceFile = (n?: number) => {
    const sources = record.source_files ?? [];
    const stored = n === undefined ? sources[0] : sources[n - 1];
    if (!stored) throw new Error("Unknown template page");
    return { file: stored, mimeType: IMAGE_EXTENSIONS[path.extname(stored).toLowerCase()]?.mime ?? "application/octet-stream" };
  };
  switch (asset) {
    case "source":
      if (record.source_kind === "images") ({ file, mimeType } = imageSourceFile());
      else { file = "source.pptx"; mimeType = "application/vnd.openxmlformats-officedocument.presentationml.presentation"; }
      break;
    case "snapshot":
      if (record.status !== "ready") throw new Error("Template is not ready");
      file = "snapshot.json"; mimeType = "application/json"; break;
    case "profile":
      file = "profile.json"; mimeType = "application/json"; break;
    case "profile_asset": {
      if (!filename || path.basename(filename) !== filename || /[\\/]/.test(filename)) throw new Error("A safe asset filename is required");
      const resolved = path.join(dir, `assets/${filename}`);
      if (!await exists(resolved)) throw new Error("Unknown profile asset");
      file = `assets/${filename}`; mimeType = IMAGE_EXTENSIONS[path.extname(filename).toLowerCase()]?.mime ?? "application/octet-stream"; break;
    }
    case "reference":
      if (pageNumber === undefined) throw new Error("Reference page number required");
      if (record.source_kind === "images") ({ file, mimeType } = imageSourceFile(pageNumber));
      else { file = `references/${base}.png`; mimeType = "image/png"; }
      break;
    case "preview": file = `previews/${base}.png`; mimeType = "image/png"; break;
    case "master": file = "html/master.html"; mimeType = "text/html"; break;
    case "page":
      if (pageNumber === undefined) throw new Error("HTML page number required");
      file = `html/${base}.html`; mimeType = "text/html"; break;
    default: throw new Error("Unknown template asset");
  }
  return { file_path: path.join(dir, file), filename: path.basename(file), mime_type: mimeType };
}
