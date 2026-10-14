import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { buildStaticDeckHtml } from "./build-deck.js";
import {
  staticizeAndWriteSlideScreenshots,
  staticizeHtmlDocuments,
} from "./browser-artifacts.js";
import { sanitizeFileNamePart } from "./file-names.js";
import { prepareManifestRenderPlan, type ManifestRenderPlan } from "./manifest-render-plan.js";
import type {
  BuildDeckHtmlPagesAndScreenshotsFromManifestResult,
  BuildDeckHtmlPagesFromManifestResult,
  BuildDeckHtmlSnapshotFromManifestResult,
  BuildDeckPageScreenshotFromManifestInput,
  BuildDeckPageScreenshotFromManifestResult,
  BuildDeckHtmlFromManifestFileOutput,
  BuildDeckHtmlFromManifestInput,
  BuildDeckHtmlFromManifestResult,
} from "./types.js";

export interface BuildDeckHtmlSnapshotFromManifestOptions {
  transformDeckHtml?: (
    deckHtml: string,
    slides: BuildDeckHtmlSnapshotFromManifestResult["slides"],
  ) => Promise<string> | string;
}

export function buildSinglePagePreviewBaseFileName(input: {
  pageNumber: number;
  deckBaseName: string;
  slideId: string;
  layoutId: string;
}): string {
  const slidePart = sanitizeFileNamePart(input.slideId);
  const layoutPart = sanitizeFileNamePart(input.layoutId);
  // In the manifest render model slideId and layoutId both resolve to the page
  // id; emitting the id twice needlessly lengthens the path (and has exceeded
  // Windows' 260-char MAX_PATH inside generation-run shadow dirs).
  return `${String(input.pageNumber).padStart(2, "0")}-${input.deckBaseName}-${slidePart}${
    layoutPart === slidePart ? "" : `-${layoutPart}`
  }`;
}

function resolveAbsolutePath(targetPath: string, fieldName: string): string {
  if (!targetPath || typeof targetPath !== "string") {
    throw new Error(`Field "${fieldName}" must be a non-empty string`);
  }
  if (!path.isAbsolute(targetPath)) throw new Error(`Field "${fieldName}" must be an absolute path`);
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

async function writePreparedPageDocuments(prepared: ManifestRenderPlan) {
  await mkdir(prepared.outputDir, { recursive: true });
  return Promise.all(prepared.slides.map(async (slide) => {
    const baseFileName = `${String(slide.pageNumber).padStart(2, "0")}-${prepared.deckBaseName}-${sanitizeFileNamePart(slide.layoutId)}`;
    const htmlFileName = `${baseFileName}.html`;
    const htmlPath = path.join(prepared.outputDir, htmlFileName);
    const screenshotFileName = `${baseFileName}.png`;
    const screenshotPath = path.join(prepared.outputDir, screenshotFileName);
    slide.fileName = screenshotFileName;
    slide.outputPath = screenshotPath;
    await writeFile(htmlPath, slide.html, "utf8");
    return { slide, htmlFileName, htmlPath, screenshotFileName, screenshotPath };
  }));
}

async function writeDeckFromStaticPageFiles(input: {
  title: string;
  htmlPaths: string[];
  deckHtmlPath: string;
}) {
  const pages = await Promise.all(input.htmlPaths.map((htmlPath) => readFile(htmlPath, "utf8")));
  const deckHtml = buildStaticDeckHtml({ title: input.title, pages });
  await writeFile(input.deckHtmlPath, deckHtml, "utf8");
  return deckHtml;
}

export async function buildDeckHtmlPagesFromManifest(
  input: BuildDeckHtmlFromManifestInput,
): Promise<BuildDeckHtmlPagesFromManifestResult> {
  const prepared = await prepareManifestRenderPlan(input);
  const pages = await writePreparedPageDocuments(prepared);
  await staticizeHtmlDocuments(pages.map((page) => ({ htmlPath: page.htmlPath, kind: "page" })));
  return {
    outputDir: prepared.outputDir,
    slides: pages.map(({ slide, htmlFileName, htmlPath }) => ({
      slideId: slide.slideId,
      layoutId: slide.layoutId,
      title: slide.context.title,
      fileName: htmlFileName,
      outputPath: htmlPath,
      speakerNote: slide.speaker_note,
    })),
    slideCount: prepared.slideCount,
    title: prepared.title,
    manifestPath: prepared.manifestPath,
  };
}

export async function buildDeckHtmlPagesAndScreenshotsFromManifest(
  input: BuildDeckHtmlFromManifestInput,
): Promise<BuildDeckHtmlPagesAndScreenshotsFromManifestResult> {
  const prepared = await prepareManifestRenderPlan(input);
  const pages = await writePreparedPageDocuments(prepared);
  await staticizeAndWriteSlideScreenshots(
    pages.map((page) => ({ htmlPath: page.htmlPath, outputPath: page.screenshotPath })),
  );
  const deckHtmlPath = path.join(prepared.outputDir, `${prepared.deckBaseName}-deck.html`);
  await writeDeckFromStaticPageFiles({
    title: prepared.title,
    htmlPaths: pages.map((page) => page.htmlPath),
    deckHtmlPath,
  });
  return {
    outputDir: prepared.outputDir,
    deckHtmlPath,
    slides: pages.map(({ slide, htmlFileName, htmlPath, screenshotFileName, screenshotPath }) => ({
      slideId: slide.slideId,
      layoutId: slide.layoutId,
      title: slide.context.title,
      htmlFileName,
      htmlPath,
      screenshotFileName,
      screenshotPath,
      speakerNote: slide.speaker_note,
    })),
    slideCount: prepared.slideCount,
    title: prepared.title,
    manifestPath: prepared.manifestPath,
  };
}

export async function buildDeckHtmlSnapshotFromManifest(
  input: BuildDeckHtmlFromManifestInput,
  options: BuildDeckHtmlSnapshotFromManifestOptions = {},
): Promise<BuildDeckHtmlSnapshotFromManifestResult> {
  const prepared = await prepareManifestRenderPlan(input);
  const pages = await writePreparedPageDocuments(prepared);
  await staticizeHtmlDocuments(pages.map((page) => ({ htmlPath: page.htmlPath, kind: "page" })));
  const deckHtmlPath = path.join(prepared.outputDir, `${prepared.deckBaseName}-deck.html`);
  const slides = prepared.slides.map((slide) => ({
    slideId: slide.slideId,
    layoutId: slide.layoutId,
    title: slide.context.title,
    speakerNote: slide.speaker_note,
  }));
  let deckHtml = await writeDeckFromStaticPageFiles({
    title: prepared.title,
    htmlPaths: pages.map((page) => page.htmlPath),
    deckHtmlPath,
  });
  if (options.transformDeckHtml) {
    deckHtml = await options.transformDeckHtml(deckHtml, slides);
    await writeFile(deckHtmlPath, deckHtml, "utf8");
  }
  return {
    outputDir: prepared.outputDir,
    deckHtmlPath,
    slides,
    slideCount: prepared.slideCount,
    title: prepared.title,
    manifestPath: prepared.manifestPath,
  };
}

export async function buildDeckPageScreenshotFromManifest(
  input: BuildDeckPageScreenshotFromManifestInput,
): Promise<BuildDeckPageScreenshotFromManifestResult> {
  const outputDir = resolveAbsolutePath(input.outputDir, "outputDir");
  const htmlOutputDir = resolveOptionalAbsolutePath(input.htmlOutputDir, "htmlOutputDir") ?? outputDir;
  const prepared = await prepareManifestRenderPlan({
    manifestPath: input.manifestPath,
    outputDir,
    name: input.name,
    singlePage: true,
    page: input.page,
    cwd: input.cwd,
  });
  const slide = prepared.slides[0];
  if (!slide) throw new Error("Single-page render plan did not produce a slide");
  const baseFileName = buildSinglePagePreviewBaseFileName({
    pageNumber: slide.pageNumber,
    deckBaseName: prepared.deckBaseName,
    slideId: slide.slideId,
    layoutId: slide.layoutId,
  });
  await mkdir(outputDir, { recursive: true });
  await mkdir(htmlOutputDir, { recursive: true });
  const htmlFileName = `${baseFileName}.html`;
  const htmlPath = path.join(htmlOutputDir, htmlFileName);
  const screenshotFileName = input.screenshot === false ? "" : `${baseFileName}.png`;
  const screenshotPath = screenshotFileName ? path.join(outputDir, screenshotFileName) : "";
  await writeFile(htmlPath, slide.html, "utf8");
  await staticizeAndWriteSlideScreenshots([{ htmlPath, outputPath: screenshotPath, onStaticSlideReady: input.onStaticSlideReady }]);
  return {
    manifestPath: prepared.manifestPath,
    outputDir,
    htmlOutputDir,
    slideId: slide.slideId,
    layoutId: slide.layoutId,
    title: slide.context.title,
    htmlFileName,
    htmlPath,
    screenshotFileName,
    screenshotPath,
    page: slide.pageNumber,
    slideCount: prepared.slideCount,
  };
}

export async function buildDeckHtmlFromManifest(
  input: BuildDeckHtmlFromManifestInput,
): Promise<BuildDeckHtmlFromManifestResult> {
  const prepared = await prepareManifestRenderPlan(input);
  const pages = await writePreparedPageDocuments(prepared);
  await staticizeAndWriteSlideScreenshots(
    pages.map((page) => ({ htmlPath: page.htmlPath, outputPath: page.screenshotPath })),
  );
  const deckFileName = `${prepared.deckBaseName}-deck.html`;
  const deckOutputPath = path.join(prepared.outputDir, deckFileName);
  const deckHtml = prepared.singlePageIndex === null
    ? await writeDeckFromStaticPageFiles({
        title: prepared.title,
        htmlPaths: pages.map((page) => page.htmlPath),
        deckHtmlPath: deckOutputPath,
      })
    : "";
  return {
    deckHtml,
    deckFileName,
    deckOutputPath,
    outputDir: prepared.outputDir,
    deckGenerated: prepared.singlePageIndex === null,
    singlePage: prepared.singlePageIndex !== null,
    page: prepared.singlePageIndex === null ? null : prepared.singlePageIndex + 1,
    slideFiles: pages.map(({ slide, screenshotFileName, screenshotPath }): BuildDeckHtmlFromManifestFileOutput => ({
      fileName: screenshotFileName,
      outputPath: screenshotPath,
      slideId: slide.slideId,
      layoutId: slide.layoutId,
      kind: "image",
      mimeType: "image/png",
    })),
    slideCount: prepared.slideCount,
    title: prepared.title,
    manifestPath: prepared.manifestPath,
  };
}
