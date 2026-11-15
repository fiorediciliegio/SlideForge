import { slideFormatFromHtml } from "../slide-format.js";
import path from "node:path";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  closeManagedBrowser,
  launchManagedBrowser,
} from "../runtime/browser-runtime.js";
import { extractCssImageUrls } from "./css-image-url.js";
import { createGoogleStaticFontResolver } from "./google-static-fonts.js";
import { mergePptxPages } from "./pptx-page-merger.js";
import { createSystemFontResolver } from "./system-fonts.js";

const SLIDE_SELECTOR = '#presentation-slides-wrapper > [data-presenton-slide-shell="true"]';
const CHUNK_SIZE = 1024 * 1024;
const FONT_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
const REMOTE_FONT_FETCH_TIMEOUT_MS = 10_000;

export interface ConvertDeckHtmlToPptxInput {
  htmlPath: string;
  outputPath: string;
  title: string;
  expectedSlideCount?: number;
  /**
   * Diagnostic mode: retain exactly one zero-based slide shell before the
   * converter starts.  Each call owns its own browser, so callers can measure
   * the true per-page renderer peak without retaining previous slides.
   */
  singleSlideIndex?: number;
  /**
   * One-based source page numbers to export. Omit for the complete deck.
   * The export-only API currently accepts any ordered selection; the client
   * will restrict this to a continuous range.
   */
  pageNumbers?: number[];
  /** Internal deck-wide font plan used by isolated page exports. */
  fontUsageOverride?: Array<{ family: string; unicodes: number[] }>;
  /** Internal deck-wide CSS font-family plan used by isolated page exports. */
  fontFamiliesOverride?: string[];
  /** Called at stable page boundaries; no high-frequency rendering telemetry. */
  onPageProgress?: (progress: {
    phase: "rendering" | "merging";
    currentPage: number;
    totalPages: number;
    sourcePageNumber?: number;
  }) => void | Promise<void>;
  timeoutMs?: number;
}

export interface ConvertDeckHtmlToPptxResult {
  outputPath: string;
  slideCount: number;
  sizeBytes: number;
  warningCount: number;
  /**
   * Font families the converter could not embed, as `Family (variant): reason`.
   * Their text still exports, rendered with whatever the viewer substitutes.
   */
  fontEmbedWarnings: string[];
}

interface FontEmbedReport {
  embedded?: string[];
  failed?: Array<{ font?: string; reason?: string }>;
  backfilled?: Array<{ family?: string; from?: string }>;
}

/**
 * Read one font source for embedding, in the Node process rather than the
 * managed Chrome page.
 *
 * Workspace Managed Fonts are materialized on disk and referenced by
 * `file://` URL, and browsers refuse `fetch('file://...')` outright — the
 * page simply cannot read them. Routing remote sources through the same
 * function keeps one failure mode and one log site for both.
 */
export async function readPptxFontSource(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol === "file:") {
    const filePath = fileURLToPath(parsed);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Font source is not a file");
    if (fileStat.size > FONT_SOURCE_MAX_BYTES) {
      throw new Error(`Font source exceeds ${FONT_SOURCE_MAX_BYTES} bytes`);
    }
    return await readFile(filePath);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported font source protocol: ${parsed.protocol}`);
  }
  const signal = AbortSignal.timeout(REMOTE_FONT_FETCH_TIMEOUT_MS);
  const response = await fetch(parsed.href, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > FONT_SOURCE_MAX_BYTES) {
    throw new Error(`Font source exceeds ${FONT_SOURCE_MAX_BYTES} bytes`);
  }
  return bytes;
}

export function formatFontEmbedWarnings(report: FontEmbedReport | null): string[] {
  return (report?.failed ?? []).map((entry) => {
    const font = entry.font?.trim() || "unknown font";
    const reason = entry.reason?.trim();
    return reason ? `${font}: ${reason}` : font;
  });
}

function runtimePath(fileName: string): string {
  // Source modules resolve through `src`; bundled engine code resolves from `dist/index.js`.
  const candidates = [
    new URL(`./vendor/dom-to-pptx/${fileName}`, import.meta.url),
    new URL(`../vendor/dom-to-pptx/${fileName}`, import.meta.url),
    new URL(`../../dist/vendor/dom-to-pptx/${fileName}`, import.meta.url),
  ];
  for (const candidate of candidates) {
    const filePath = fileURLToPath(candidate);
    if (existsSync(filePath)) return filePath;
  }
  return fileURLToPath(candidates[0]);
}

export function resolveDomToPptxRuntimePath(fileName = "dom-to-pptx.bundle.js"): string {
  return runtimePath(fileName);
}

export interface PptxCaptureRequest {
  documentX: number;
  documentY: number;
  width: number;
  height: number;
  slideTop: number;
  slideLeft?: number;
  captureBelow?: boolean;
  rasterScale?: number;
}

export interface PptxCaptureViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

export function resolvePptxCaptureClip(
  request: PptxCaptureRequest,
  viewport: PptxCaptureViewport,
): { x: number; y: number; width: number; height: number; scale: number } {
  const values = [request.documentX, request.documentY, request.width, request.height, request.slideTop];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("PPTX capture request contains non-finite coordinates");
  }
  const viewportX = request.documentX - viewport.scrollX;
  const viewportY = request.documentY - viewport.scrollY;
  const width = request.width;
  const height = request.height;
  if (
    !(width > 0) ||
    !(height > 0) ||
    viewportX < 0 ||
    viewportY < 0 ||
    viewportX + width > viewport.width ||
    viewportY + height > viewport.height
  ) {
    throw new Error(
      `PPTX capture clip is outside the viewport: x=${viewportX}, y=${viewportY}, width=${width}, height=${height}, ` +
        `viewport=${viewport.width}x${viewport.height}`,
    );
  }
  return {
    // Puppeteer's clip uses document coordinates even after the page scrolls.
    // The viewport-relative coordinates above are only for bounds validation.
    x: request.documentX,
    y: request.documentY,
    width,
    height,
    scale: Math.max(Number(request.rasterScale) || 1, 0.01),
  };
}

async function convertDeckHtmlToPptxInBrowser(
  input: ConvertDeckHtmlToPptxInput,
): Promise<ConvertDeckHtmlToPptxResult> {
  const htmlPath = path.normalize(input.htmlPath);
  const format = slideFormatFromHtml(await readFile(htmlPath, "utf8"));
  const outputPath = path.normalize(input.outputPath);
  const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000;
  const htmlStat = await stat(htmlPath);
  if (!htmlStat.isFile()) throw new Error(`Deck HTML is not a file: ${htmlPath}`);

  const puppeteerModule = await import("puppeteer");
  const puppeteer = puppeteerModule.default ?? puppeteerModule;
  const browser = await launchManagedBrowser(puppeteer, {
    purpose: "PPTX export",
    // Page defaults do not cover long-running Runtime.callFunctionOn requests.
    launchOptions: { protocolTimeout: timeoutMs },
  }) as any;
  const temporaryPath = `${outputPath}.tmp`;
  const embeddedOnly=Boolean(process.env.SLIDEFORGE_EMBEDDED_EXPORT_ROOT);
  const systemSources=new Set<string>();
  const blockRemoteFonts = process.env.PPTX_BLOCK_REMOTE_FONTS === "1";
  const callbackName = `__presentonWritePptxChunk_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const cssImageUrlCallbackName = `__presentonExtractCssImageUrls_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const captureElementCallbackName = `__presentonCapturePptxElement_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const fontSourceCallbackName = `__presentonReadPptxFontSource_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const fontReportCallbackName = `__presentonReportPptxFontEmbed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const rasterizationCallbackName = `__presentonReportPptxRasterization_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const rasterizationLedgerPath = process.env.PPTX_RASTERIZATION_LEDGER_PATH?.trim() || null;
  const systemFontCallbackName = `__presentonResolvePptxSystemFont_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const systemFonts = createSystemFontResolver();
  const googleStaticFonts = createGoogleStaticFontResolver();
  let bytesWritten = 0;
  let warningCount = 0;
  let fontEmbedReport: FontEmbedReport | null = null;
  let page: any = null;

  await rm(temporaryPath, { force: true });
  if (rasterizationLedgerPath) {
    await mkdir(path.dirname(rasterizationLedgerPath), { recursive: true });
    await rm(rasterizationLedgerPath, { force: true });
  }

  try {
    page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.setViewport({ width: format.width, height: format.height });
    if (blockRemoteFonts&&!embeddedOnly) {
      await page.setRequestInterception(true);
      page.on("request", (request: any) => {
        const url = request.url();
        if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//i.test(url)) {
          void request.abort();
        } else {
          void request.continue();
        }
      });
    }
    page.on("console", (message: any) => {
      // Font embedding reports its failures through console.error, so
      // counting only warnings made a typography-less export look clean.
      const type = message.type();
      if (type === "warning" || type === "error") warningCount += 1;
    });
    await page.exposeFunction(callbackName, async (base64: string) => {
      const chunk = Buffer.from(base64, "base64");
      bytesWritten += chunk.byteLength;
      await appendFile(temporaryPath, chunk);
    });
    await page.exposeFunction(cssImageUrlCallbackName, (values: string[]) => (
      values.map((value) => extractCssImageUrls(value))
    ));
    await page.exposeFunction(fontSourceCallbackName, async (url: string) => {
      if(embeddedOnly&&!url.startsWith("data:")&&!systemSources.has(url))throw new Error("Snapshot font source must be embedded or a resolved system font");
      return (await readPptxFontSource(url)).toString("base64");
    });
    await page.exposeFunction(fontReportCallbackName, (report: FontEmbedReport) => {
      fontEmbedReport = report;
    });
    if (rasterizationLedgerPath) {
      await page.exposeFunction(rasterizationCallbackName, async (event: unknown) => {
        await appendFile(
          rasterizationLedgerPath,
          `${JSON.stringify({ timestamp: new Date().toISOString(), event })}\n`,
          "utf8",
        );
      });
    }
    // System fonts the browser rendered with have no @font-face url for the
    // converter to read; this callback lets the Node process find the face on
    // disk, subset it to the deck's code points, and hand back a file:// url
    // that the existing fetchFontBuffer path can read unchanged.
    await page.exposeFunction(systemFontCallbackName, async (family: string, request: { unicodes?: number[] }) => {
      const sources=await systemFonts.resolve(family,request?.unicodes??[]);
      for(const source of sources??[])systemSources.add(source.url);
      return sources;
    });
    const staticFontCallbackName = `__presentonResolvePptxGoogleStaticFont_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await page.exposeFunction(staticFontCallbackName, async (request: { family?: string; weight?: string | number; style?: string }) => {
      if (embeddedOnly||!request?.family) return null;
      return await googleStaticFonts.resolve({
        family: request.family,
        weight: request.weight,
        style: request.style,
      });
    });
    await page.exposeFunction(captureElementCallbackName, async (request: any) => {
      const traceStartedAt = rasterizationLedgerPath ? Date.now() : 0;
      const previousScroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      const scrollX = Math.max(0, Number(request?.slideLeft) || 0);
      const scrollY = Math.max(0, Number(request?.slideTop) || 0);

      try {
        await page.evaluate(({ x, y }: any) => window.scrollTo(x, y), { x: scrollX, y: scrollY });
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        const viewport = await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        }));
        const clip = resolvePptxCaptureClip(request, viewport);
        const opaque = request?.captureBelow === true;
        if (rasterizationLedgerPath) {
          await appendFile(rasterizationLedgerPath, `${JSON.stringify({
            timestamp: new Date().toISOString(),
            event: {
              event: "rasterization_start",
              operation: "puppeteer_screenshot",
              slide_number: Number(request?.slideIndex) + 1 || null,
              reason: request?.reason || "element_capture",
              clip,
              opaque,
            },
          })}\n`, "utf8");
        }
        const result = await page.screenshot({
          type: opaque ? "jpeg" : "png",
          ...(opaque ? { quality: 85 } : { omitBackground: true }),
          encoding: "base64",
          captureBeyondViewport: false,
          clip,
        });
        if (rasterizationLedgerPath) {
          await appendFile(rasterizationLedgerPath, `${JSON.stringify({
            timestamp: new Date().toISOString(),
            event: {
              event: "rasterization_end",
              operation: "puppeteer_screenshot",
              slide_number: Number(request?.slideIndex) + 1 || null,
              reason: request?.reason || "element_capture",
              duration_ms: Date.now() - traceStartedAt,
              ok: true,
              base64_bytes_estimate: Math.floor((String(result).length * 3) / 4),
              clip,
              opaque,
            },
          })}\n`, "utf8");
        }
        return result;
      } finally {
        await page.evaluate(({ x: restoreX, y: restoreY }: any) => window.scrollTo(restoreX, restoreY), previousScroll);
      }
    });
    // A static deck may retain a remote font import. The DOM itself is local,
    // so it is safe to proceed once its slide shells exist instead of waiting
    // indefinitely for an unrelated font host to become network-idle.
    try {
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "domcontentloaded", timeout: 15_000 });
    } catch (error) {
      await page.evaluate(() => window.stop()).catch(() => undefined);
      const hasSlideShell = await page.evaluate(
        (selector: string) => Boolean(document.querySelector(selector)),
        SLIDE_SELECTOR,
      );
      if (!hasSlideShell) throw error;
    }
    if (input.singleSlideIndex !== undefined) {
      if (!Number.isInteger(input.singleSlideIndex) || input.singleSlideIndex < 0) {
        throw new Error("singleSlideIndex must be a non-negative integer");
      }
      const retained = await page.evaluate(({ selector, index }: { selector: string; index: number }) => {
        const slides = Array.from(document.querySelectorAll(selector));
        const selected = slides[index];
        if (!selected) return false;
        for (const slide of slides) {
          if (slide !== selected) slide.remove();
        }
        return true;
      }, { selector: SLIDE_SELECTOR, index: input.singleSlideIndex });
      if (!retained) {
        throw new Error(`singleSlideIndex ${input.singleSlideIndex} is outside the deck slide range`);
      }
    }
    await page.waitForSelector(SLIDE_SELECTOR, { timeout: 180_000 });
    await page.evaluate("globalThis.__name = (target) => target");

    const validation = await page.evaluate(async ({
      selector,
      width,
      height,
      expectedSlideCount,
      cssImageUrlCallback,
    }: any) => {
      const wrapperMatches = document.querySelectorAll("#presentation-slides-wrapper");
      if (wrapperMatches.length !== 1) {
        throw new Error(`Deck HTML must contain exactly one #presentation-slides-wrapper; found ${wrapperMatches.length}`);
      }
      const slides = Array.from(document.querySelectorAll(selector));
      if (slides.length === 0) throw new Error("Deck HTML contains no slide shells");
      if (expectedSlideCount != null && slides.length !== expectedSlideCount) {
        throw new Error(`Deck HTML contains ${slides.length} slides; expected ${expectedSlideCount}`);
      }
      for (const [index, slide] of slides.entries()) {
        const rect = slide.getBoundingClientRect();
        const style = getComputedStyle(slide);
        if (Math.round(rect.width) !== width || Math.round(rect.height) !== height) {
          throw new Error(`Slide ${index + 1} must measure ${width}x${height}; measured ${rect.width}x${rect.height}`);
        }
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          throw new Error(`Slide ${index + 1} is not visible`);
        }
      }

      await Promise.race([
        document.fonts?.ready ?? Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);

      const normalizeFamily = (value: string) =>
        value.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
      const declaredManagedFamilies = new Set<string>();
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
            const family = normalizeFamily((rule as CSSFontFaceRule).style.fontFamily);
            if (family) declaredManagedFamilies.add(family);
          }
        } catch {
          // Cross-origin stylesheets are irrelevant to workspace-managed
          // fonts, whose rules are materialized directly in Deck HTML.
        }
      }
      const fontChecks = new Map<string, { family: string; descriptor: string; text: string; pageNumber: number }>();
      for (const element of Array.from(document.querySelectorAll<HTMLElement>("[data-ppt-editor-font-family]"))) {
        const family = element.dataset.pptEditorFontFamily?.trim() ?? "";
        if (!family) continue;
        const pageNumber = Math.max(1, slides.findIndex((slide) => slide.contains(element)) + 1);
        if (!declaredManagedFamilies.has(family)) {
          throw new Error(`Slide ${pageNumber} uses a managed font with no embedded source: ${family}`);
        }
        const style = getComputedStyle(element);
        const escapedFamily = family.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const descriptor = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} "${escapedFamily}"`;
        const key = `${family}\0${descriptor}`;
        fontChecks.set(key, {
          family,
          descriptor,
          text: element.textContent?.trim().slice(0, 64) || "BESbswy",
          pageNumber,
        });
      }
      for (const check of fontChecks.values()) {
        let faces: FontFace[];
        try {
          faces = await document.fonts.load(check.descriptor, check.text);
        } catch {
          throw new Error(`Slide ${check.pageNumber} could not load managed font: ${check.family}`);
        }
        if (faces.length === 0 || faces.some((face) => face.status !== "loaded")) {
          throw new Error(`Slide ${check.pageNumber} could not load managed font: ${check.family}`);
        }
      }

      const urls = new Map<string, number>();
      const cssImageValues: Array<{ value: string; pageNumber: number }> = [];
      const addCssImageValue = (value: string | null, pageNumber: number) => {
        if (value && value !== "none") cssImageValues.push({ value, pageNumber });
      };
      for (const [index, slide] of slides.entries()) {
        const pageNumber = index + 1;
        for (const element of [slide, ...Array.from(slide.querySelectorAll("*"))]) {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (!rect.width || !rect.height || style.display === "none" || style.visibility === "hidden") continue;
          addCssImageValue(style.backgroundImage, pageNumber);
          addCssImageValue(getComputedStyle(element, "::before").backgroundImage, pageNumber);
          addCssImageValue(getComputedStyle(element, "::after").backgroundImage, pageNumber);
          if (element instanceof HTMLImageElement) {
            if (!element.complete || element.naturalWidth <= 0 || element.naturalHeight <= 0) {
              throw new Error(`Slide ${pageNumber} contains an image that failed to load`);
            }
            urls.set(element.currentSrc || element.src, pageNumber);
          }
          if (element instanceof SVGImageElement) {
            const href = element.href?.baseVal || element.getAttribute("href");
            if (href) urls.set(href, pageNumber);
          }
        }
      }
      const parsedCssImageUrls = await (globalThis as any)[cssImageUrlCallback](
        cssImageValues.map(({ value }) => value),
      ) as string[][];
      for (const [index, extractedUrls] of parsedCssImageUrls.entries()) {
        const pageNumber = cssImageValues[index]?.pageNumber;
        if (pageNumber === undefined) continue;
        for (const url of extractedUrls) urls.set(url, pageNumber);
      }
      for (const [url, pageNumber] of urls) {
        try {
          const absoluteUrl = new URL(url, document.baseURI);
          if (absoluteUrl.protocol === "file:") {
            await new Promise<void>((resolve, reject) => {
              const image = new Image();
              image.onload = () => resolve();
              image.onerror = () => reject(new Error("Image load failed"));
              image.src = absoluteUrl.href;
            });
          } else {
            const response = await fetch(absoluteUrl.href);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            await response.blob();
          }
        } catch {
          const safeUrl = url.split("?")[0];
          throw new Error(`Slide ${pageNumber} contains an unreadable image: ${safeUrl}`);
        }
      }
      return { slideCount: slides.length };
    }, {
      selector: SLIDE_SELECTOR,
      width: format.width,
      height: format.height,
      expectedSlideCount: input.expectedSlideCount,
      cssImageUrlCallback: cssImageUrlCallbackName,
    });

    await page.addScriptTag({ path: runtimePath("dom-to-pptx.bundle.js") });
    const conversion = page.evaluate(async ({
      selector,
      widthInches, heightInches,
      callback,
      captureCallback,
      fontSourceCallback,
      fontReportCallback,
      systemFontCallback,
      staticFontCallback,
      rasterizationCallback,
      rasterizationEnabled,
      chunkSize,
      title,
      fontUsageOverride,
      fontFamiliesOverride,
    }: any) => {
      const converter = (window as any).domToPptx?.exportToPptx;
      if (typeof converter !== "function") throw new Error("dom-to-pptx browser runtime did not load");
      const slides = Array.from(document.querySelectorAll(selector));
      const blob = await converter(slides, {
        skipDownload: true,
        skipNormalize: false,
        autoEmbedFonts: true,
        embedSystemFonts: true,
        fontUsageOverride,
        fontFamiliesOverride,
        resolveFontSource: (family: string, request: unknown) => (
          (globalThis as any)[systemFontCallback](family, request)
        ),
        resolveStaticFontSource: (request: unknown) => (
          (globalThis as any)[staticFontCallback](request)
        ),
        svgAsVector: false,
        width: widthInches,
        height: heightInches,
        title,
        _maxRasterDpi: 150,
        fetchFontBuffer: (url: string) => (globalThis as any)[fontSourceCallback](url),
        onFontEmbedReport: (report: unknown) => (globalThis as any)[fontReportCallback](report),
        onRasterizationEvent: rasterizationEnabled
          ? (event: unknown) => (globalThis as any)[rasterizationCallback](event)
          : undefined,
        _captureElement: async (request: any) => {
          const base64 = await (globalThis as any)[captureCallback](request);
          const mimeType = request?.captureMimeType === "image/jpeg" ? "image/jpeg" : "image/png";
          return base64 ? `data:${mimeType};base64,${base64}` : null;
        },
      });
      let total = 0;
      for (let offset = 0; offset < blob.size; offset += chunkSize) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        await (window as any)[callback](btoa(binary));
        total += bytes.length;
      }
      return total;
    }, {
      selector: SLIDE_SELECTOR,
      widthInches: format.widthInches, heightInches: format.heightInches,
      callback: callbackName,
      captureCallback: captureElementCallbackName,
      fontSourceCallback: fontSourceCallbackName,
      fontReportCallback: fontReportCallbackName,
      systemFontCallback: systemFontCallbackName,
      staticFontCallback: staticFontCallbackName,
      rasterizationCallback: rasterizationCallbackName,
      rasterizationEnabled: Boolean(rasterizationLedgerPath),
      chunkSize: CHUNK_SIZE,
      title: input.title,
      fontUsageOverride: input.fontUsageOverride,
      fontFamiliesOverride: input.fontFamiliesOverride,
    });
    let conversionTimeout: ReturnType<typeof setTimeout> | undefined;
    const reportedBytes = await Promise.race([
      conversion,
      new Promise<never>((_, reject) => {
        conversionTimeout = setTimeout(
          () => reject(new Error(`PPTX conversion timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]).finally(() => {
      if (conversionTimeout) clearTimeout(conversionTimeout);
    });

    if (!reportedBytes || reportedBytes !== bytesWritten) {
      throw new Error(`PPTX transfer was incomplete: browser=${reportedBytes}, node=${bytesWritten}`);
    }
    const handle = await open(temporaryPath, "r");
    const headerBytes = Buffer.alloc(2);
    try {
      await handle.read(headerBytes, 0, 2, 0);
    } finally {
      await handle.close();
    }
    const header = headerBytes.toString("ascii");
    if (header !== "PK") throw new Error("Generated PPTX is not a ZIP file");

    return {
      outputPath: temporaryPath,
      slideCount: validation.slideCount,
      sizeBytes: bytesWritten,
      warningCount,
      fontEmbedWarnings: formatFontEmbedWarnings(fontEmbedReport),
    };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    await closeManagedBrowser({
      purpose: "PPTX export",
      page,
      browser,
    });
    await systemFonts.cleanup();
    await googleStaticFonts.cleanup();
  }
}

interface IsolatedExportInspection {
  slideCount: number;
  fontUsage: Array<{ family: string; unicodes: number[] }>;
  fontFamilies: string[];
}

/**
 * Inspect text once before rendering isolated pages. Every page exporter gets
 * this deck-wide plan so the first archive's font collection is safe to use
 * as the merged deck's embedded-font collection.
 */
async function inspectDeckForIsolatedExport(
  htmlPath: string,
  timeoutMs: number,
): Promise<IsolatedExportInspection> {
  const format = slideFormatFromHtml(await readFile(htmlPath, "utf8"));
  const puppeteerModule = await import("puppeteer");
  const puppeteer = puppeteerModule.default ?? puppeteerModule;
  const browser = await launchManagedBrowser(puppeteer, {
    purpose: "PPTX export font preflight",
    launchOptions: { protocolTimeout: timeoutMs },
  }) as any;
  const blockRemoteFonts = process.env.PPTX_BLOCK_REMOTE_FONTS === "1";
  let page: any = null;
  try {
    page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.setViewport({ width: format.width, height: format.height });
    if (blockRemoteFonts&&!process.env.SLIDEFORGE_EMBEDDED_EXPORT_ROOT) {
      await page.setRequestInterception(true);
      page.on("request", (request: any) => {
        const url = request.url();
        if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//i.test(url)) void request.abort();
        else void request.continue();
      });
    }
    try {
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "domcontentloaded", timeout: 15_000 });
    } catch (error) {
      await page.evaluate(() => window.stop()).catch(() => undefined);
      const hasSlideShell = await page.evaluate(
        (selector: string) => Boolean(document.querySelector(selector)),
        SLIDE_SELECTOR,
      );
      if (!hasSlideShell) throw error;
    }
    await page.waitForSelector(SLIDE_SELECTOR, { timeout: 180_000 });
    // tsx/esbuild annotates evaluate callbacks with __name; supply the same
    // browser-side helper used by the converter path below.
    await page.evaluate("globalThis.__name = (target) => target");
    return await page.evaluate(async (selector: string) => {
      await Promise.race([
        document.fonts?.ready ?? Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
      const genericFamilies = new Set([
        "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
        "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji",
        "fangsong", "-apple-system", "blinkmacsystemfont",
      ]);
      const knownCjkFamilies = new Set([
        "pingfang sc", "pingfang tc", "pingfang hk", "pingfang mo", "microsoft yahei",
        "microsoft jhenghei", "msyh", "微软雅黑", "新細明體", "微软正黑体", "simhei", "黑体",
        "simsun", "宋体", "nsimsun", "kaiti", "楷体", "fangsong", "仿宋", "dengxian", "等线",
        "yu gothic", "yu mincho", "meiryo", "malgun gothic", "맑은 고딕", "noto sans cjk sc",
        "noto sans cjk tc", "noto sans cjk jp", "noto sans cjk kr", "noto sans sc", "noto sans tc",
        "noto sans jp", "noto sans kr", "source han sans", "source han serif", "source han sans sc",
        "source han serif sc", "sarasa gothic", "sarasa ui", "lxgw wenkai", "wenquanyi micro hei",
      ]);
      const canvas = document.createElement("canvas").getContext("2d");
      const normalize = (family: string) => family.trim().replace(/^['"]|['"]$/g, "");
      const split = (value: string) => value.split(",").map(normalize).filter(Boolean);
      const quoted = (family: string) => `"${family.replace(/"/g, '\\"')}"`;
      const isAvailable = (family: string) => {
        if (!canvas || genericFamilies.has(family.toLowerCase())) return false;
        for (const fallback of ["monospace", "serif"]) {
          for (const sample of ["MWil qB", "BESbswy"]) {
            canvas.font = `100px ${fallback}`;
            const baseline = canvas.measureText(sample).width;
            canvas.font = `100px ${quoted(family)}, ${fallback}`;
            if (Math.abs(canvas.measureText(sample).width - baseline) > 0.01) return true;
          }
        }
        return false;
      };
      const supportsCjk = (family: string) => {
        if (!canvas || !isAvailable(family)) return false;
        if (knownCjkFamilies.has(family.toLowerCase())) return true;
        for (const fallback of ["monospace", "serif"]) {
          canvas.font = `100px ${fallback}`;
          const baseline = canvas.measureText("永").width;
          canvas.font = `100px ${quoted(family)}, ${fallback}`;
          if (Math.abs(canvas.measureText("永").width - baseline) > 0.01) return true;
        }
        return false;
      };
      const usage = new Map<string, Set<number>>();
      const families = new Set<string>();
      const record = (family: string | null, value: string) => {
        if (!family || genericFamilies.has(family.toLowerCase())) return;
        let codepoints = usage.get(family);
        if (!codepoints) usage.set(family, codepoints = new Set());
        for (const character of value) codepoints.add(character.codePointAt(0)!);
      };
      const isVisible = (element: Element) => {
        for (let current: Element | null = element; current; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden") return false;
        }
        return true;
      };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const value = node.nodeValue ?? "";
        const parent = node.parentElement;
        if (!parent || !value.trim() || !isVisible(parent)) continue;
        const stack = split(getComputedStyle(parent).fontFamily);
        for (const family of stack) if (!genericFamilies.has(family.toLowerCase())) families.add(family);
        const primary = stack.find(isAvailable) ?? stack[0] ?? null;
        record(primary, value);
        if (primary && !supportsCjk(primary)) record(stack.slice(1).find(supportsCjk) ?? null, value);
      }
      return {
        slideCount: document.querySelectorAll(selector).length,
        fontUsage: [...usage.entries()].map(([family, unicodes]) => ({ family, unicodes: [...unicodes].sort((a, b) => a - b) })),
        fontFamilies: [...families].sort((a, b) => a.localeCompare(b)),
      };
    }, SLIDE_SELECTOR);
  } finally {
    await closeManagedBrowser({ purpose: "PPTX export font preflight", page, browser });
  }
}

function normalizePageNumbers(pageNumbers: number[] | undefined, slideCount: number): number[] {
  if (pageNumbers === undefined) return Array.from({ length: slideCount }, (_, index) => index + 1);
  if (!Array.isArray(pageNumbers) || pageNumbers.length === 0) {
    throw new Error("pageNumbers must be a non-empty array of one-based page numbers");
  }
  const normalized = [...new Set(pageNumbers)].sort((left, right) => left - right);
  for (const pageNumber of normalized) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > slideCount) {
      throw new Error(`pageNumbers contains an invalid source page: ${pageNumber}`);
    }
  }
  return normalized;
}

/**
 * Default PPTX path: export each selected source slide in a fresh renderer,
 * then join the single-slide archives. This bounds Chromium's peak live DOM,
 * canvas and screenshot memory to one slide while preserving a normal PPTX.
 */
export async function convertDeckHtmlToPptx(
  input: ConvertDeckHtmlToPptxInput,
): Promise<ConvertDeckHtmlToPptxResult> {
  // Keep the explicit one-page mode for diagnostics and preview utilities.
  if (input.singleSlideIndex !== undefined) return await convertDeckHtmlToPptxInBrowser(input);

  const htmlPath = path.normalize(input.htmlPath);
  const outputPath = path.normalize(input.outputPath);
  const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000;
  const htmlStat = await stat(htmlPath);
  if (!htmlStat.isFile()) throw new Error(`Deck HTML is not a file: ${htmlPath}`);
  const inspection = await inspectDeckForIsolatedExport(htmlPath, timeoutMs);
  if (inspection.slideCount === 0) throw new Error("Deck HTML contains no slide shells");
  if (input.expectedSlideCount !== undefined && inspection.slideCount !== input.expectedSlideCount) {
    throw new Error(`Deck HTML contains ${inspection.slideCount} slides; expected ${input.expectedSlideCount}`);
  }
  const selectedPageNumbers = normalizePageNumbers(input.pageNumbers, inspection.slideCount);
  const temporaryPath = `${outputPath}.tmp`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(path.dirname(outputPath), ".pptx-pages-"));
  const fontEmbedWarnings = new Set<string>();
  let warningCount = 0;
  try {
    await rm(temporaryPath, { force: true });
    const pagePaths: string[] = [];
    for (const [index, pageNumber] of selectedPageNumbers.entries()) {
      await input.onPageProgress?.({
        phase: "rendering",
        currentPage: index + 1,
        totalPages: selectedPageNumbers.length,
        sourcePageNumber: pageNumber,
      });
      const pagePath = path.join(temporaryDirectory, `slide-${String(index + 1).padStart(4, "0")}.pptx`);
      const result = await convertDeckHtmlToPptxInBrowser({
        ...input,
        htmlPath,
        outputPath: pagePath,
        expectedSlideCount: 1,
        singleSlideIndex: pageNumber - 1,
        pageNumbers: undefined,
        fontUsageOverride: inspection.fontUsage,
        fontFamiliesOverride: inspection.fontFamilies,
        timeoutMs,
      });
      await rename(result.outputPath, pagePath);
      pagePaths.push(pagePath);
      warningCount += result.warningCount;
      for (const warning of result.fontEmbedWarnings) fontEmbedWarnings.add(warning);
    }
    await input.onPageProgress?.({
      phase: "merging",
      currentPage: selectedPageNumbers.length,
      totalPages: selectedPageNumbers.length,
    });
    const merged = await mergePptxPages({
      outputPath: temporaryPath,
      pagePaths,
      fontReferencePath: pagePaths[0],
    });
    return {
      outputPath: temporaryPath,
      slideCount: merged.slideCount,
      sizeBytes: merged.sizeBytes,
      warningCount,
      fontEmbedWarnings: [...fontEmbedWarnings],
    };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
