import { readFile } from "node:fs/promises";
import { slideFormat, slideFormatFromHtml, type SlideAspectRatio } from "../slide-format.js";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  closeManagedBrowser,
  closeManagedPage,
  launchManagedBrowser,
} from "../runtime/browser-runtime.js";

interface PdfSlideElementLike {
  screenshot(options: { type: "png" }): Promise<Uint8Array | null>;
}

export interface PdfSlidePageLike {
  setViewport(viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
  }): Promise<void>;
  goto(url: string, options: { waitUntil: "networkidle0"; timeout: number }): Promise<unknown>;
  waitForSelector(
    selector: string,
    options: { timeout: number },
  ): Promise<PdfSlideElementLike | null>;
}

export function buildPdfHtmlFromDataUrls(imageDataUrls: string[], aspectRatio?: SlideAspectRatio): string {
  const format = slideFormat(aspectRatio);
  const width = format.widthInches * 96;
  const height = format.heightInches * 96;
  const slides = imageDataUrls.map((dataUrl, index) => [
    `<section class="page" data-page="${index + 1}">`,
    `<img alt="Slide ${index + 1}" src="${dataUrl}" />`,
    "</section>",
  ].join("\n")).join("\n");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8" />',
    `  <meta name="viewport" content="width=${width}, initial-scale=1" />`,
    "  <style>",
    "    @page {",
    `      size: ${format.widthInches}in ${format.heightInches}in;`,
    "      margin: 0;",
    "    }",
    "    html, body {",
    "      margin: 0;",
    "      padding: 0;",
    "      width: 100%;",
    "      background: #ffffff;",
    "    }",
    "    body {",
    "      -webkit-print-color-adjust: exact;",
    "      print-color-adjust: exact;",
    "    }",
    "    .page {",
    `      width: ${width}px;`,
    `      height: ${height}px;`,
    "      overflow: hidden;",
    "      page-break-after: always;",
    "    }",
    "    .page:last-child {",
    "      page-break-after: auto;",
    "    }",
    "    img {",
    "      display: block;",
    `      width: ${width}px;`,
    `      height: ${height}px;`,
    "      object-fit: cover;",
    "    }",
    "  </style>",
    "</head>",
    "<body>",
    slides,
    "</body>",
    "</html>",
  ].join("\n");
}

export async function capturePdfSlideScreenshot(
  page: PdfSlidePageLike,
  slideHtmlPath: string,
  timeoutMs = 120_000,
  aspectRatio?: SlideAspectRatio,
): Promise<Uint8Array> {
  const { width, height } = slideFormat(aspectRatio);
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(slideHtmlPath).href, {
    waitUntil: "networkidle0",
    timeout: timeoutMs,
  });
  const slideElement = await page.waitForSelector(
    "#presentation-slides-wrapper[data-presenton-render-status='ready']",
    { timeout: timeoutMs },
  );
  if (!slideElement) {
    throw new Error("PDF export slide element was not found after render readiness");
  }
  const screenshot = await slideElement.screenshot({ type: "png" });
  if (!screenshot) {
    throw new Error("PDF export slide screenshot failed");
  }
  return screenshot;
}

async function launchPdfBrowser(): Promise<any> {
  const puppeteerModule = await import("puppeteer");
  const puppeteer = puppeteerModule.default ?? puppeteerModule;
  return launchManagedBrowser(puppeteer, {
    purpose: "app PDF export",
  });
}

export async function createPdfFromSlideHtmlPaths(
  slideHtmlPaths: string[],
  pdfPath: string,
  timeoutMs = 600_000,
): Promise<void> {
  const formats = await Promise.all(slideHtmlPaths.map(async (file) => slideFormatFromHtml(await readFile(file, "utf8"))));
  const format = formats[0] ?? slideFormat();
  if (formats.some((item) => item.aspectRatio !== format.aspectRatio)) throw new Error("PDF cannot mix page sizes");
  const browser = await launchPdfBrowser();
  const deadline = Date.now() + timeoutMs;
  const remainingTimeout = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`PDF conversion timed out after ${timeoutMs}ms`);
    return remaining;
  };

  try {
    const slideDataUrls: string[] = [];

    for (const slideHtmlPath of slideHtmlPaths) {
      const slideBrowserPage = await browser.newPage();
      try {
        const screenshot = await capturePdfSlideScreenshot(
          slideBrowserPage,
          slideHtmlPath,
          Math.min(120_000, remainingTimeout()),
          format.aspectRatio,
        );
        slideDataUrls.push(`data:image/png;base64,${Buffer.from(screenshot).toString("base64")}`);
      } finally {
        await closeManagedPage(slideBrowserPage, {
          purpose: `app PDF export slide ${path.basename(slideHtmlPath)}`,
        });
      }
    }

    const pdfPage = await browser.newPage();
    try {
      await pdfPage.setViewport({ width: Math.round(format.widthInches * 96), height: Math.round(format.heightInches * 96), deviceScaleFactor: 1 });
      await pdfPage.setContent(buildPdfHtmlFromDataUrls(slideDataUrls, format.aspectRatio), {
        waitUntil: "load",
        timeout: remainingTimeout(),
      });
      await pdfPage.pdf({
        path: pdfPath,
        printBackground: true,
        preferCSSPageSize: true,
        timeout: remainingTimeout(),
      });
    } finally {
      await closeManagedPage(pdfPage, {
        purpose: "app PDF export document",
      });
    }
  } finally {
    await closeManagedBrowser({
      purpose: "app PDF export",
      browser,
    });
  }
}
