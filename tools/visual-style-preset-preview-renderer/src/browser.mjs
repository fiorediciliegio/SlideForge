import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import {
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  SOURCE_SLIDE_HEIGHT,
  SOURCE_SLIDE_WIDTH,
} from "./constants.mjs";
import { assertFile } from "./files.mjs";

export async function launchBrowser(browserExecutable) {
  await assertFile(browserExecutable, "Chromium executable");
  return puppeteer.launch({
    executablePath: browserExecutable,
    headless: true,
    args: ["--allow-file-access-from-files"],
  });
}

function createObservers(page) {
  const consoleErrors = [];
  const failedRequests = [];
  const badResponses = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown request failure";
    if (failure !== "net::ERR_ABORTED") failedRequests.push(`${request.url()} (${failure})`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
  });
  return { consoleErrors, failedRequests, badResponses };
}

export async function inspectHtmlInChromium(browser, htmlPath, { timeoutMs, screenshotPath, quality }) {
  const page = await browser.newPage();
  const observer = createObservers(page);
  try {
    await page.setViewport({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle0", timeout: timeoutMs });
    const documentState = await page.evaluate(async () => {
      await document.fonts.ready;
      const slides = [...document.querySelectorAll(".slide")];
      const stylesheetFailures = [...document.querySelectorAll('link[rel~="stylesheet"]')]
        .filter((link) => !link.sheet)
        .map((link) => link.href);
      const brokenImages = [...document.images]
        .filter((image) => !image.complete || image.naturalWidth === 0)
        .map((image) => image.currentSrc || image.src);
      const slide = slides[0];
      const rect = slide?.getBoundingClientRect();
      return {
        slideCount: slides.length,
        slideWidth: rect?.width ?? 0,
        slideHeight: rect?.height ?? 0,
        fontsStatus: document.fonts.status,
        stylesheetFailures,
        brokenImages,
      };
    });

    if (documentState.slideCount !== 1) {
      throw new Error(`${htmlPath} must contain exactly one .slide element; found ${documentState.slideCount}.`);
    }
    if (
      Math.abs(documentState.slideWidth - SOURCE_SLIDE_WIDTH) > 0.5
      || Math.abs(documentState.slideHeight - SOURCE_SLIDE_HEIGHT) > 0.5
    ) {
      throw new Error(
        `${htmlPath} must have a ${SOURCE_SLIDE_WIDTH}x${SOURCE_SLIDE_HEIGHT} .slide; received ${documentState.slideWidth}x${documentState.slideHeight}.`,
      );
    }
    if (documentState.fontsStatus !== "loaded") throw new Error(`${htmlPath} fonts did not finish loading.`);
    if (documentState.stylesheetFailures.length > 0) {
      throw new Error(`${htmlPath} stylesheet load failed: ${documentState.stylesheetFailures.join(", ")}`);
    }
    if (documentState.brokenImages.length > 0) {
      throw new Error(`${htmlPath} contains broken images: ${documentState.brokenImages.join(", ")}`);
    }
    if (observer.consoleErrors.length > 0) {
      throw new Error(`${htmlPath} emitted console errors: ${observer.consoleErrors.join(" | ")}`);
    }
    if (observer.failedRequests.length > 0) {
      throw new Error(`${htmlPath} has failed requests: ${observer.failedRequests.join(" | ")}`);
    }
    if (observer.badResponses.length > 0) {
      throw new Error(`${htmlPath} has HTTP errors: ${observer.badResponses.join(" | ")}`);
    }

    if (screenshotPath) {
      const scale = PREVIEW_WIDTH / SOURCE_SLIDE_WIDTH;
      await page.evaluate(({ scale }) => {
        const slide = document.querySelector(".slide");
        document.documentElement.style.cssText = "margin:0!important;padding:0!important;width:1280px!important;height:720px!important;overflow:hidden!important;";
        document.body.style.cssText = "display:block!important;margin:0!important;padding:0!important;width:1280px!important;height:720px!important;overflow:hidden!important;";
        slide.style.setProperty("position", "absolute", "important");
        slide.style.setProperty("inset", "0 auto auto 0", "important");
        slide.style.setProperty("margin", "0", "important");
        slide.style.setProperty("transform-origin", "top left", "important");
        slide.style.setProperty("transform", `scale(${scale})`, "important");
      }, { scale });
      await page.screenshot({
        path: screenshotPath,
        type: "webp",
        quality,
        clip: { x: 0, y: 0, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT },
      });
    }

    return {
      resources: {
        consoleErrors: observer.consoleErrors,
        failedRequests: observer.failedRequests,
        badResponses: observer.badResponses,
      },
    };
  } finally {
    await page.close();
  }
}
