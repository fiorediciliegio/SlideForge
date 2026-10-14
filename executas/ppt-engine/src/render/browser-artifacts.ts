import { slideFormatFromHtml } from "../slide-format.js";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

import { waitForRenderReady } from "../runtime/browser-runtime.js";
import {
  scaleBrowserOperationTimeout,
  withQueuedManagedPage,
  type ManagedElementHandleLike,
  type ManagedPageLike,
} from "./managed-page.js";
import {
  installRenderReadinessTracking,
  serializeRenderedPageToStaticHtml,
  waitForRenderReadiness,
  type StaticHtmlDocumentKind,
} from "./static-html.js";

type PageLike = ManagedPageLike;
type ElementHandleLike = ManagedElementHandleLike;
export type StaticSlideReady = (htmlPath: string, element: ManagedElementHandleLike) => Promise<void>;

export async function writeSlideWebpThumbnail(element: ManagedElementHandleLike, outputPath: string, maxEdge = 640) {
  const bytes = await element.screenshot();
  if (!(bytes instanceof Uint8Array)) throw new Error("Thumbnail capture returned no image bytes");
  await sharp(Buffer.from(bytes)).resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78 }).toFile(outputPath);
}

const DEFAULT_RENDER_TIMEOUT_MS = 300_000;
const PAGE_BROWSER_OPERATION_TIMEOUT_MS = 50_000;
const DECK_BROWSER_OPERATION_TIMEOUT_MS = 100_000;
const MAX_BROWSER_OPERATION_TIMEOUT_MS = 10 * 60_000;
const SLIDE_RENDER_SELECTOR = "#presentation-slides-wrapper";

async function waitForSlideRenderReady(
  page: PageLike,
  timeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
): Promise<ElementHandleLike> {
  return (await waitForRenderReady(page, {
    selector: SLIDE_RENDER_SELECTOR,
    timeoutMs,
    kindLabel: "Slide",
  })) as ElementHandleLike;
}

export async function writeSlideScreenshots(
  slides: Array<{ html: string; outputPath: string; htmlPath?: string }>,
  purpose = "Page Source slide screenshots",
  options: { requireTailwind?: boolean; allowFailedImages?: boolean; validateManualSlideShell?: boolean; captureScreenshot?: boolean; thumbnailMaxEdge?: number } = {},
): Promise<void> {
  const operationTimeoutMs = scaleBrowserOperationTimeout(
    PAGE_BROWSER_OPERATION_TIMEOUT_MS,
    slides.length,
  );
  await withQueuedManagedPage(purpose, operationTimeoutMs, async (page) => {
    await installRenderReadinessTracking(page);

    for (const slide of slides) {
      const format = slideFormatFromHtml(slide.htmlPath ? await readFile(slide.htmlPath, "utf8") : slide.html);
      await page.setViewport?.({ width: format.width, height: format.height, deviceScaleFactor: options.thumbnailMaxEdge ? 1 : 2 });
      if (slide.htmlPath && page.goto) {
        await page.goto(pathToFileURL(slide.htmlPath).href, {
          waitUntil: "domcontentloaded",
          timeout: DEFAULT_RENDER_TIMEOUT_MS,
        });
      } else {
        await page.setContent(slide.html, {
          waitUntil: "domcontentloaded",
          timeout: DEFAULT_RENDER_TIMEOUT_MS,
        });
      }
      const slideElement = await waitForSlideRenderReady(page);
      await waitForRenderReadiness(page, {
        timeoutMs: 30_000,
        requireTailwind: options.requireTailwind,
        allowFailedImages: options.allowFailedImages,
      });
      if (options.validateManualSlideShell) {
        const missingFonts = await page.evaluate(async ({ width, height }: { width: number; height: number }) => {
          const shells = Array.from(document.querySelectorAll<HTMLElement>('[data-presenton-slide-shell="true"]'));
          if (shells.length !== 1) throw new Error(`Manual page must contain exactly one slide shell; found ${shells.length}`);
          const shell = shells[0]!;
          const rect = shell.getBoundingClientRect();
          const style = getComputedStyle(shell);
          if (Math.round(rect.width) !== width || Math.round(rect.height) !== height) {
            throw new Error(`Manual page slide shell must measure ${width}x${height}; measured ${rect.width}x${rect.height}`);
          }
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            throw new Error("Manual page slide shell must be visible");
          }
          const fontFamilies = new Set<string>();
          for (const element of [shell, ...Array.from(shell.querySelectorAll<HTMLElement>("*"))]) {
            const computed = getComputedStyle(element);
            if (computed.display !== "none" && computed.visibility !== "hidden" && element.textContent?.trim()) {
              const family = computed.fontFamily.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "");
              if (family) fontFamilies.add(family);
            }
          }
          const missing: string[] = [];
          for (const family of fontFamilies) {
            if (!document.fonts) continue;
            // Wait briefly so a slow but reachable webfont has time to finish
            // loading before declaring it missing.
            await Promise.race([
              document.fonts.load(`16px "${family}"`).catch(() => undefined),
              new Promise((resolve) => setTimeout(resolve, 5000)),
            ]);
            if (!document.fonts.check(`16px "${family}"`)) missing.push(family);
          }
          return missing;
        }, { width: format.width, height: format.height });
        if (missingFonts.length > 0) {
          // A webfont can be unreachable for environmental reasons (e.g. the
          // Google Fonts host is blocked on this network). Don't block the save;
          // the screenshot below still captures the true rendered output so the
          // user can see any fallback. The structural shell checks above stay hard.
          console.warn(`[manual-page-revision] font(s) unavailable, rendering with fallback: ${missingFonts.join(", ")}`);
        }
      }
      if (options.captureScreenshot === false) continue;
      if (options.thumbnailMaxEdge) {
        // Capture bytes in memory: only the small WebP is written to disk.
        await writeSlideWebpThumbnail(slideElement, slide.outputPath, options.thumbnailMaxEdge);
        continue;
      }
      const screenshot = await slideElement.screenshot({ path: slide.outputPath });
      if (!screenshot) {
        throw new Error(`Failed to write slide screenshot: ${slide.outputPath}`);
      }
    }
  });
}

async function staticizeSingleSlide(
  page: PageLike,
  slide: { htmlPath: string; outputPath: string; onStaticSlideReady?: StaticSlideReady },
): Promise<void> {
  if (!page.goto) {
    throw new Error("Static HTML generation requires browser file navigation support");
  }
  const format = slideFormatFromHtml(await readFile(slide.htmlPath, "utf8"));
  await page.setViewport?.({ width: format.width, height: format.height, deviceScaleFactor: 2 });
  const slideUrl = pathToFileURL(slide.htmlPath).href;
  await page.goto(slideUrl, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_RENDER_TIMEOUT_MS,
  });
  await waitForSlideRenderReady(page);
  await waitForRenderReadiness(page, { timeoutMs: 30_000, requireTailwind: false });
  const staticHtml = await serializeRenderedPageToStaticHtml(page, "page");
  await writeFile(slide.htmlPath, staticHtml, "utf8");

  if (!slide.outputPath && !slide.onStaticSlideReady) return;

  // The screenshot must come from the persisted snapshot, not the live
  // React document that produced it.
  try {
    await page.goto(slideUrl, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_RENDER_TIMEOUT_MS,
    });
    const slideElement = await waitForSlideRenderReady(page);
    await waitForRenderReadiness(page, { timeoutMs: 30_000, requireTailwind: false });
    await slide.onStaticSlideReady?.(slide.htmlPath, slideElement);
    if (!slide.outputPath) return;
    const screenshot = await slideElement.screenshot({ path: slide.outputPath });
    if (!screenshot) throw new Error(`Failed to write slide screenshot: ${slide.outputPath}`);
  } catch (error) {
    if (slide.outputPath) throw error;
    console.warn("Deferred optional slide thumbnail:", error instanceof Error ? error.message : String(error));
  }
}

export async function staticizeAndWriteSlideScreenshots(
  slides: Array<{ htmlPath: string; outputPath: string; onStaticSlideReady?: StaticSlideReady }>,
  purpose = "Page Source static HTML and slide screenshots",
): Promise<void> {
  const operationTimeoutMs = scaleBrowserOperationTimeout(
    PAGE_BROWSER_OPERATION_TIMEOUT_MS * 2,
    slides.length,
  );
  await withQueuedManagedPage(purpose, operationTimeoutMs, async (page) => {
    if (!page.goto) {
      throw new Error("Static HTML generation requires browser file navigation support");
    }
    await installRenderReadinessTracking(page);

    for (const slide of slides) {
      await staticizeSingleSlide(page, slide);
    }
  });
}

export interface StaticizeSlideScreenshotResult {
  htmlPath: string;
  outputPath: string;
  status: "ok" | "failed";
  error: string;
  durationMs: number;
}

export async function staticizeAndWriteSlideScreenshotsBestEffort(
  slides: Array<{ htmlPath: string; outputPath: string }>,
  purpose = "Page Source static HTML and slide screenshots (best effort)",
): Promise<StaticizeSlideScreenshotResult[]> {
  const results: StaticizeSlideScreenshotResult[] = [];
  const operationTimeoutMs = scaleBrowserOperationTimeout(
    PAGE_BROWSER_OPERATION_TIMEOUT_MS * 2,
    slides.length,
  );
  await withQueuedManagedPage(purpose, operationTimeoutMs, async (page) => {
    if (!page.goto) {
      throw new Error("Static HTML generation requires browser file navigation support");
    }
    await installRenderReadinessTracking(page);

    for (const slide of slides) {
      const startedAt = Date.now();
      try {
        await staticizeSingleSlide(page, slide);
        results.push({
          htmlPath: slide.htmlPath,
          outputPath: slide.outputPath,
          status: "ok",
          error: "",
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        results.push({
          htmlPath: slide.htmlPath,
          outputPath: slide.outputPath,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
        });
      }
    }
  });
  return results;
}

export async function staticizeHtmlDocuments(
  documents: Array<{ htmlPath: string; kind: StaticHtmlDocumentKind }>,
  purpose = "Page Source static HTML generation",
): Promise<void> {
  const operationTimeoutMs = Math.min(
    MAX_BROWSER_OPERATION_TIMEOUT_MS,
    documents.reduce(
      (total, document) => total + (
        document.kind === "deck"
          ? DECK_BROWSER_OPERATION_TIMEOUT_MS
          : PAGE_BROWSER_OPERATION_TIMEOUT_MS
      ),
      0,
    ) || PAGE_BROWSER_OPERATION_TIMEOUT_MS,
  );
  await withQueuedManagedPage(purpose, operationTimeoutMs, async (page) => {
    await installRenderReadinessTracking(page);
    for (const document of documents) {
      if (!page.goto) {
        throw new Error("Static HTML generation requires browser file navigation support");
      }
      const format = slideFormatFromHtml(await readFile(document.htmlPath, "utf8"));
      await page.setViewport?.({ width: format.width, height: format.height, deviceScaleFactor: 2 });
      await page.goto(pathToFileURL(document.htmlPath).href, {
        waitUntil: "domcontentloaded",
        timeout: DEFAULT_RENDER_TIMEOUT_MS,
      });
      await waitForSlideRenderReady(page);
      await waitForRenderReadiness(page, {
        timeoutMs: document.kind === "deck" ? 60_000 : 30_000,
        requireTailwind: false,
      });
      const staticHtml = await serializeRenderedPageToStaticHtml(
        page,
        document.kind,
      );
      await writeFile(document.htmlPath, staticHtml, "utf8");
    }
  });
}
