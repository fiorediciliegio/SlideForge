import path from "node:path";
import { normalizeSlideAspectRatio } from "../slide-format.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { sanitizeFileNamePart } from "./file-names.js";
import { injectWorkspaceManagedFontCss } from "../font-library/index.js";
import {
  buildHtmlPageSourceDocumentHtml,
  createPageSourceRenderContext,
} from "./page-source-document.js";
import type {
  BrowserRenderContext,
  DeckManifestInput,
  DeckManifestSlideInput,
} from "./types.js";

const PAGE_ID_PATTERN = /^page-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MANIFEST_FIELDS = new Set(["title", "slides", "aspect_ratio"]);
const SLIDE_FIELDS = new Set(["id", "source"]);

type PreparedManifestSlide = {
  context: BrowserRenderContext;
  html: string;
  sourceIndex: number;
  pageNumber: number;
  slideId: string;
  layoutId: string;
  runtimeLayoutId: string;
  fileName: string;
  outputPath: string;
  speaker_note: string;
  localEntryPath: string;
};

export interface ManifestRenderPlan {
  manifestPath: string;
  manifestCwd: string;
  outputDir: string;
  deckBaseName: string;
  title: string;
  singlePageIndex: number | null;
  slideCount: number;
  slides: PreparedManifestSlide[];
  deckRuntimeBundle: string | null;
  tailwindRuntimeBundle: string;
}

function resolveAbsolutePath(targetPath: string, fieldName: string): string {
  if (!targetPath || typeof targetPath !== "string") {
    throw new Error(`Field "${fieldName}" must be a non-empty string`);
  }
  if (!path.isAbsolute(targetPath)) {
    throw new Error(`Field "${fieldName}" must be an absolute path`);
  }
  return path.normalize(targetPath);
}

function resolveOptionalAbsolutePath(
  targetPath: string | null | undefined,
  fieldName: string,
): string | undefined {
  return targetPath === undefined || targetPath === null
    ? undefined
    : resolveAbsolutePath(targetPath, fieldName);
}

/**
 * Headless previews render the page source with the same managed-font
 * attributes as the editor, but unlike the manual-save / editor-serve paths
 * nobody injected the matching @font-face rules, so screenshots silently
 * fell back to system fonts. Injection stays best-effort: export flows can
 * point cwd at a directory without a font library, which must not fail a
 * render that previously succeeded.
 */
async function withManagedFontCssBestEffort(
  workspaceDir: string | null | undefined,
  html: string,
): Promise<string> {
  if (!workspaceDir) return html;
  try {
    // Render plans have no static slide shell (it is created at runtime by
    // the page bootstrap), so inject document-scoped into <head>.
    return await injectWorkspaceManagedFontCss(workspaceDir, html, { injectInto: "head" });
  } catch (error) {
    console.warn(
      `[render-plan] managed font css skipped: ${(error as Error).message}`,
    );
    return html;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyFields(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
) {
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    throw new Error(`${label} contains unsupported field "${unsupported[0]}"`);
  }
}

function expectedPageSource(pageId: string): string {
  return `./slides/${pageId}.html`;
}

/**
 * Page Sources can be authored in the Linux Agent workspace and later opened
 * from a local checkout. Keep the source authoritative, but rebase the known
 * persisted workspace prefix in the derived browser document so local assets
 * remain loadable during staticization. The normal preview resource pass will
 * publish these file URLs to HTTPS before the HTML reaches the frontend.
 */
function rebasePersistedWorkspaceAssetPaths(html: string, workspaceDir: string): string {
  const workspaceName = path.basename(path.normalize(workspaceDir));
  if (!workspaceName) return html;
  const remotePrefix = `/data/workspace/ppt/${workspaceName}/`;
  const localPrefix = pathToFileURL(`${path.resolve(workspaceDir)}${path.sep}`).href;
  return html.replaceAll(remotePrefix, localPrefix);
}

export function validateDeckManifest(value: unknown): asserts value is DeckManifestInput {
  if (!isPlainRecord(value)) {
    throw new Error('Field "manifest" must be an object');
  }
  assertOnlyFields(value, MANIFEST_FIELDS, "Manifest");
  normalizeSlideAspectRatio(value.aspect_ratio);
  if (typeof value.title !== "string" || value.title.trim().length === 0) {
    throw new Error('Field "manifest.title" must be a non-empty string');
  }
  if (!Array.isArray(value.slides) || value.slides.length === 0) {
    throw new Error('Field "manifest.slides" must be a non-empty array');
  }

  const seenPageIds = new Set<string>();
  value.slides.forEach((slideValue, index) => {
    if (!isPlainRecord(slideValue)) {
      throw new Error(`Slide at index ${index} must be an object`);
    }
    assertOnlyFields(slideValue, SLIDE_FIELDS, `Slide at index ${index}`);
    if (typeof slideValue.id !== "string" || !PAGE_ID_PATTERN.test(slideValue.id)) {
      throw new Error(`Slide at index ${index} field "id" must be an opaque page UUID`);
    }
    if (seenPageIds.has(slideValue.id)) {
      throw new Error(`Duplicate manifest slide id "${slideValue.id}"`);
    }
    seenPageIds.add(slideValue.id);
    const expectedSource = expectedPageSource(slideValue.id);
    if (slideValue.source !== expectedSource) {
      throw new Error(
        `Slide "${slideValue.id}" field "source" must equal "${expectedSource}"`,
      );
    }
  });
}

function parseSinglePageIndex(
  input: { singlePage?: boolean | null; page?: number | null },
  slideCount: number,
): number | null {
  if (!input.singlePage) return null;
  if (input.page === undefined || input.page === null) {
    throw new Error('Field "page" is required when "singlePage" is true');
  }
  if (!Number.isInteger(input.page)) {
    throw new Error('Field "page" must be an integer');
  }
  if (input.page < 1 || input.page > slideCount) {
    throw new Error(`Field "page" must be between 1 and ${slideCount}`);
  }
  return input.page - 1;
}

async function resolvePageSource(
  slide: DeckManifestSlideInput,
  manifestCwd: string,
): Promise<string> {
  const absolutePath = path.resolve(manifestCwd, slide.source);
  const relative = path.relative(manifestCwd, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Slide "${slide.id}" source must remain inside the Workspace`);
  }
  await readFile(absolutePath, "utf8");
  return absolutePath;
}

export async function prepareManifestRenderPlan(input: {
  manifestPath: string;
  outputDir: string;
  name?: string | null;
  singlePage?: boolean | null;
  page?: number | null;
  cwd?: string | null;
}): Promise<ManifestRenderPlan> {
  if (!input || typeof input !== "object") {
    throw new Error("Manifest build input must be an object");
  }
  resolveOptionalAbsolutePath(input.cwd, "cwd");
  const manifestPath = resolveAbsolutePath(input.manifestPath, "manifestPath");
  const outputDir = resolveAbsolutePath(input.outputDir, "outputDir");
  const manifestValue = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  validateDeckManifest(manifestValue);
  const manifest = manifestValue;
  const manifestCwd = path.dirname(manifestPath);
  const deckBaseName = sanitizeFileNamePart(input.name ?? manifest.title);
  const singlePageIndex = parseSinglePageIndex(input, manifest.slides.length);
  const selected = singlePageIndex === null
    ? manifest.slides.map((slide, sourceIndex) => ({ slide, sourceIndex }))
    : [{ slide: manifest.slides[singlePageIndex]!, sourceIndex: singlePageIndex }];

  const resolved = await Promise.all(selected.map(async ({ slide, sourceIndex }) => ({
    slide,
    sourceIndex,
    absolutePath: await resolvePageSource(slide, manifestCwd),
  })));
  const slides: PreparedManifestSlide[] = await Promise.all(resolved.map(async ({ slide, sourceIndex, absolutePath }) => {
    const pageNumber = sourceIndex + 1;
    const context = createPageSourceRenderContext({
      id: slide.id,
      aspect_ratio: manifest.aspect_ratio,
      title: `${manifest.title} – ${pageNumber}`,
      pageNumber,
      totalPages: manifest.slides.length,
    });
    const fileName = `${pageNumber}-${deckBaseName}-${sanitizeFileNamePart(slide.id)}.png`;
    const sourceHtml = rebasePersistedWorkspaceAssetPaths(
      await readFile(absolutePath, "utf8"),
      manifestCwd,
    );
    return {
      context,
      html: await withManagedFontCssBestEffort(input.cwd ?? manifestCwd,
        buildHtmlPageSourceDocumentHtml({ sourceHtml, context })),
      sourceIndex,
      pageNumber,
      slideId: slide.id,
      layoutId: slide.id,
      runtimeLayoutId: slide.id,
      fileName,
      outputPath: path.join(outputDir, fileName),
      speaker_note: "",
      localEntryPath: absolutePath,
    };
  }));

  return {
    manifestPath,
    manifestCwd,
    outputDir,
    deckBaseName,
    title: manifest.title,
    singlePageIndex,
    slideCount: manifest.slides.length,
    slides,
    deckRuntimeBundle: null,
    tailwindRuntimeBundle: "",
  };
}
