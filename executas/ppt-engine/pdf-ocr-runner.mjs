import crypto from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import Tesseract from "tesseract.js";

const requireFromRunner = createRequire(import.meta.url);
const PDF_IMAGE_OPERATORS = new Set();
const TEXT_LAYOUT_BLOCK_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
const MIN_IMAGE_DIMENSION = 128;
const DETECTION_DPI = 100;
const RECOGNITION_DPI = 200;
const MAX_RENDERED_PIXELS = 12_000_000;

function resolvePdfJsResourceDirectories() {
  const pdfjsRoot = path.dirname(requireFromRunner.resolve("pdfjs-dist/package.json"));
  const directoryUrl = (directory) => `${directory.replace(/\\/g, "/")}/`;
  return {
    cMapUrl: directoryUrl(path.join(pdfjsRoot, "cmaps")),
    cMapPacked: true,
    iccUrl: directoryUrl(path.join(pdfjsRoot, "iccs")),
    wasmUrl: directoryUrl(path.join(pdfjsRoot, "wasm")),
    standardFontDataUrl: directoryUrl(path.join(pdfjsRoot, "standard_fonts")),
  };
}

async function openPdfDocument(pdfPath) {
  const bytes = await readFile(pdfPath);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  PDF_IMAGE_OPERATORS.add(pdfjs.OPS.paintImageXObject);
  PDF_IMAGE_OPERATORS.add(pdfjs.OPS.paintInlineImageXObject);
  return pdfjs.getDocument({
    data: new Uint8Array(bytes),
    ...resolvePdfJsResourceDirectories(),
  }).promise;
}

async function renderPdfPage(document, pageNumber, dpi) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
    throw new Error(`PDF OCR runner received an invalid page number: ${pageNumber}.`);
  }
  const page = await document.getPage(pageNumber);
  const { createCanvas } = await import("@napi-rs/canvas");
  const initialScale = dpi / 72;
  const initialViewport = page.getViewport({ scale: initialScale });
  const pixelCount = initialViewport.width * initialViewport.height;
  const scale = pixelCount > MAX_RENDERED_PIXELS
    ? initialScale * Math.sqrt(MAX_RENDERED_PIXELS / pixelCount)
    : initialScale;
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas.toBuffer("image/png");
}

function getPdfImageObject(page, value) {
  if (value && typeof value === "object") return Promise.resolve(value);
  if (typeof value !== "string") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const immediate = page.objs.get(value, resolve);
      if (immediate) resolve(immediate);
    } catch {
      resolve(null);
    }
  });
}

function expandOneBitPixels(data, width, height) {
  const expanded = Buffer.alloc(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const byte = data[Math.floor(index / 8)] ?? 0;
    expanded[index] = byte & (128 >> (index % 8)) ? 0 : 255;
  }
  return expanded;
}

async function pdfImageToPng(image) {
  const width = Number(image?.width ?? 0);
  const height = Number(image?.height ?? 0);
  const data = image?.data;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || !data) return null;
  const pixels = Buffer.from(data.buffer, data.byteOffset ?? 0, data.byteLength ?? data.length);
  let channels;
  let input = pixels;
  if (pixels.length === width * height * 4) channels = 4;
  else if (pixels.length === width * height * 3) channels = 3;
  else if (pixels.length === width * height) channels = 1;
  else if (pixels.length === Math.ceil(width * height / 8)) {
    channels = 1;
    input = expandOneBitPixels(pixels, width, height);
  } else {
    return null;
  }
  return sharp(input, { raw: { width, height, channels } }).png().toBuffer();
}

async function extractMeaningfulPageImages(document, pageNumber) {
  const page = await document.getPage(pageNumber);
  const operatorList = await page.getOperatorList();
  const seenKeys = new Set();
  const images = [];
  let hadUnextractableImage = false;
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    if (!PDF_IMAGE_OPERATORS.has(operatorList.fnArray[index])) continue;
    const value = operatorList.argsArray[index]?.[0];
    if (typeof value === "string" && seenKeys.has(value)) continue;
    if (typeof value === "string") seenKeys.add(value);
    const image = await getPdfImageObject(page, value);
    const width = Number(image?.width ?? operatorList.argsArray[index]?.[1] ?? 0);
    const height = Number(image?.height ?? operatorList.argsArray[index]?.[2] ?? 0);
    if (width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION) continue;
    const png = await pdfImageToPng(image);
    if (!png) {
      hadUnextractableImage = true;
      continue;
    }
    images.push(png);
  }
  return { images, hadUnextractableImage };
}

function normalizedCharacterCount(value) {
  return typeof value === "string" ? value.replace(/\s/gu, "").length : 0;
}

async function getVisualTargets(document, request, dpi) {
  const extracted = await extractMeaningfulPageImages(document, request.page_number);
  if (extracted.images.length > 0) return extracted.images;
  if (extracted.hadUnextractableImage || normalizedCharacterCount(request.native_text) < 10) {
    return [await renderPdfPage(document, request.page_number, dpi)];
  }
  return [];
}

function imageHash(image) {
  return crypto.createHash("sha256").update(image).digest("hex");
}

async function detectVisualText(worker, image) {
  const result = await worker.recognize(
    image,
    { tessedit_pageseg_mode: Tesseract.PSM.AUTO },
    { text: false, blocks: false, layoutBlocks: true },
  );
  return (result.data.layoutBlocks ?? []).some((block) => TEXT_LAYOUT_BLOCK_TYPES.has(Number(block.blocktype)));
}

function normalizeLanguage(value) {
  return value === "eng" ? "eng" : "chi_sim";
}

async function detectPdfPages(input, cachePath) {
  const document = await openPdfDocument(input.pdf_path);
  const worker = await Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY, { cachePath, logger: () => undefined });
  const detectionCache = new Map();
  const detections = [];
  try {
    for (const request of input.pages) {
      let hasVisualText = false;
      try {
        const images = await getVisualTargets(document, request, DETECTION_DPI);
        for (const image of images) {
          const hash = imageHash(image);
          let detected = detectionCache.get(hash);
          if (detected === undefined) {
            detected = await detectVisualText(worker, image);
            detectionCache.set(hash, detected);
          }
          if (detected) {
            hasVisualText = true;
            break;
          }
        }
      } catch {
        // Detection is an optimization. Fall back to recognition rather than
        // lose visual text when one unusual PDF image cannot be inspected.
        hasVisualText = true;
      }
      detections.push({ page_number: request.page_number, has_visual_text: hasVisualText });
    }
    return detections;
  } finally {
    await worker.terminate();
    await document.destroy();
  }
}

async function recognizePdfPages(input, cachePath) {
  const document = await openPdfDocument(input.pdf_path);
  const firstLanguage = normalizeLanguage(input.pages[0]?.language);
  const worker = await Tesseract.createWorker(firstLanguage, Tesseract.OEM.LSTM_ONLY, { cachePath, logger: () => undefined });
  const recognitionCache = new Map();
  const results = [];
  let activeLanguage = firstLanguage;
  try {
    for (const request of input.pages) {
      const language = normalizeLanguage(request.language);
      if (language !== activeLanguage) {
        await worker.reinitialize(language, Tesseract.OEM.LSTM_ONLY);
        activeLanguage = language;
      }
      try {
        const images = await getVisualTargets(document, request, RECOGNITION_DPI);
        const texts = [];
        const confidences = [];
        for (const image of images) {
          const hash = `${language}:${imageHash(image)}`;
          let recognized = recognitionCache.get(hash);
          if (!recognized) {
            const hasVisualText = await detectVisualText(worker, image);
            recognized = hasVisualText
              ? await worker.recognize(image)
              : { data: { text: "", confidence: null } };
            recognitionCache.set(hash, recognized);
          }
          const text = typeof recognized.data.text === "string" ? recognized.data.text.replace(/\r\n?/g, "\n").trim() : "";
          if (text) texts.push(text);
          if (Number.isFinite(recognized.data.confidence)) confidences.push(recognized.data.confidence);
        }
        results.push({
          page_number: request.page_number,
          text: texts.join("\n\n"),
          confidence: confidences.length > 0
            ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
            : null,
        });
      } catch (error) {
        results.push({
          page_number: request.page_number,
          text: "",
          confidence: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  } finally {
    await worker.terminate();
    await document.destroy();
  }
}

function readInput() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.once("error", reject);
    process.stdin.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main() {
  const input = await readInput();
  if (!input || typeof input !== "object") throw new Error("OCR runner requires an input object.");
  const cachePath = path.join(os.tmpdir(), "presenton-template-engine", "tesseract");
  await mkdir(cachePath, { recursive: true });

  if (input.action === "detect_pdf_pages") {
    if (typeof input.pdf_path !== "string" || !Array.isArray(input.pages)) throw new Error("PDF detection requires pdf_path and pages.");
    writeResult({ ok: true, detections: await detectPdfPages(input, cachePath) });
    return;
  }
  if (input.action === "recognize_pdf_pages") {
    if (typeof input.pdf_path !== "string" || !Array.isArray(input.pages)) throw new Error("PDF recognition requires pdf_path and pages.");
    writeResult({ ok: true, results: await recognizePdfPages(input, cachePath) });
    return;
  }

  const language = normalizeLanguage(input.language);
  const worker = await Tesseract.createWorker(language, Tesseract.OEM.LSTM_ONLY, { cachePath, logger: () => undefined });
  let document;
  try {
    const image = typeof input.image_base64 === "string"
      ? Buffer.from(input.image_base64, "base64")
      : typeof input.pdf_path === "string"
        ? await (async () => {
          document = await openPdfDocument(input.pdf_path);
          return renderPdfPage(document, input.page_number, RECOGNITION_DPI);
        })()
        : (() => { throw new Error("OCR runner requires image_base64 or pdf_path with page_number."); })();
    const result = await worker.recognize(image);
    writeResult({
      ok: true,
      text: result.data.text.replace(/\r\n?/g, "\n").trim(),
      confidence: Number.isFinite(result.data.confidence) ? result.data.confidence : null,
    });
  } finally {
    await worker.terminate();
    await document?.destroy();
  }
}

main().catch((error) => {
  writeResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
