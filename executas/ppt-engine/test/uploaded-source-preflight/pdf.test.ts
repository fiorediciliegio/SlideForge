import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";
import sharp from "sharp";
import { extractUploadedSource, resolvePdfJsResourceDirectories, selectPdfOcrLanguage } from "../../src/uploaded-source-preflight/extract.ts";
import type {
  PdfOcrBatchResult,
  PdfOcrDetectionResult,
  PdfOcrEngine,
  PdfOcrPageRequest,
  PdfOcrResult,
} from "../../src/uploaded-source-preflight/pdf-ocr.ts";
import type { UploadedSourceExtractionOptions } from "../../src/uploaded-source-preflight/types.ts";

function streamObject(content: Buffer | string, dictionary = "") {
  const payload = Buffer.isBuffer(content) ? content : Buffer.from(content, "ascii");
  return Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${payload.length} >>\nstream\n`, "ascii"),
    payload,
    Buffer.from("\nendstream", "ascii"),
  ]);
}

function makePdf(objects: Array<Buffer | string>) {
  const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary");
  const parts: Buffer[] = [header];
  const offsets = [0];
  let offset = header.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(offset);
    const body = Buffer.isBuffer(object) ? object : Buffer.from(object, "ascii");
    const wrapped = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "ascii"), body, Buffer.from("\nendobj\n", "ascii")]);
    parts.push(wrapped);
    offset += wrapped.length;
  }
  const xrefOffset = offset;
  const xref = [
    `xref\n0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((entry) => `${String(entry).padStart(10, "0")} 00000 n `),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    `startxref\n${xrefOffset}\n%%EOF\n`,
  ].join("\n");
  parts.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(parts);
}

function textPdf(text: string) {
  return makePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    streamObject(`BT /F1 20 Tf 20 150 Td (${text}) Tj ET`),
  ]);
}

function blankPdf() {
  return makePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>",
  ]);
}

async function imagePdf(pageCount = 1) {
  const image = await sharp({
    create: { width: 100, height: 40, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const source = `data:image/png;base64,${image.toString("base64")}`;
    const pages = Array.from({ length: pageCount }, (_, index) => (
      `<div class="page${index === pageCount - 1 ? " last" : ""}"><img alt="embedded image" src="${source}" /></div>`
    )).join("");
    await page.setContent(`<style>@page{margin:0;size:300px 300px}html,body{margin:0}.page{width:300px;height:300px;break-after:page}.page.last{break-after:auto}</style>${pages}`);
    return Buffer.from(await page.pdf({ width: "300px", height: "300px", margin: { top: "0", right: "0", bottom: "0", left: "0" } }));
  } finally {
    await browser.close();
  }
}

class StubPdfOcrEngine implements PdfOcrEngine {
  readonly images: Buffer[] = [];
  disposed = false;
  private readonly outcome: PdfOcrResult | Error;

  constructor(outcome: PdfOcrResult | Error) {
    this.outcome = outcome;
  }

  async recognizePage(image: Buffer): Promise<PdfOcrResult> {
    this.images.push(image);
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }

  async dispose() {
    this.disposed = true;
  }
}

class IsolatedPdfPathStub implements PdfOcrEngine {
  readonly requests: Array<{ sourcePath: string; pageNumber: number; language: string | undefined }> = [];

  async recognizePage(): Promise<PdfOcrResult> {
    throw new Error("The parent process must not rasterize a production PDF OCR page.");
  }

  async recognizePdfPage(sourcePath: string, pageNumber: number, _timeoutMs: number, language?: "chi_sim" | "eng"): Promise<PdfOcrResult> {
    this.requests.push({ sourcePath, pageNumber, language });
    return { text: "Text from isolated renderer", confidence: 95 };
  }
}

class BatchPdfOcrStub implements PdfOcrEngine {
  readonly detectionCalls: PdfOcrPageRequest[][] = [];
  readonly recognitionCalls: PdfOcrPageRequest[][] = [];
  private readonly hasVisualText: boolean;
  private readonly recognizedText: string;

  constructor(hasVisualText: boolean, recognizedText = "Detected screenshot text") {
    this.hasVisualText = hasVisualText;
    this.recognizedText = recognizedText;
  }

  async detectPdfPages(_sourcePath: string, pages: PdfOcrPageRequest[]): Promise<PdfOcrDetectionResult[]> {
    this.detectionCalls.push(pages);
    return pages.map((page) => ({ page_number: page.page_number, has_visual_text: this.hasVisualText }));
  }

  async recognizePdfPages(_sourcePath: string, pages: PdfOcrPageRequest[]): Promise<PdfOcrBatchResult[]> {
    this.recognitionCalls.push(pages);
    return pages.map((page) => ({ page_number: page.page_number, text: this.recognizedText, confidence: 96 }));
  }
}

async function extractFixture(name: string, contents: Buffer, engine: PdfOcrEngine, options: Omit<UploadedSourceExtractionOptions, "pdf_ocr_engine"> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "presenton-pdf-preflight-"));
  const filePath = path.join(directory, name);
  await writeFile(filePath, contents);
  try {
    return await extractUploadedSource(filePath, ".pdf", { ...options, pdf_ocr_engine: engine });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("PDF.js receives filesystem directories for its bundled WASM and standard-font resources", async () => {
  const resources = resolvePdfJsResourceDirectories();

  assert.match(resources.wasmUrl, /\/wasm\/$/);
  assert.match(resources.standardFontDataUrl, /\/standard_fonts\/$/);
  assert.doesNotMatch(resources.wasmUrl, /\\/);
  await access(path.join(resources.wasmUrl, "openjpeg.wasm"));
});

test("PDF OCR selects one stable language model from native page text", () => {
  assert.equal(selectPdfOcrLanguage("Annual report and financial results"), "eng");
  assert.equal(selectPdfOcrLanguage("年度报告与财务结果"), "chi_sim");
  assert.equal(selectPdfOcrLanguage(""), "chi_sim");
});

test("PDF preflight keeps native text without OCR when the page has sufficient text", async () => {
  const engine = new StubPdfOcrEngine({ text: "must not be used", confidence: 99 });
  const result = await extractFixture("native.pdf", textPdf("Native PDF content stays available"), engine);

  assert.equal(result.parse_status, "ready");
  assert.equal(engine.images.length, 0);
  assert.match(result.text, /## Native text[\s\S]*Native PDF content/);
  assert.equal(result.format_metrics.ocr_candidate_pages, 0);
});

test("PDF preflight OCRs embedded-image pages and retains the OCR section", async () => {
  const engine = new StubPdfOcrEngine({ text: "Screenshot text", confidence: 96 });
  const result = await extractFixture("image.pdf", await imagePdf(), engine);

  assert.equal(result.parse_status, "ready");
  assert.equal(engine.images.length, 1, JSON.stringify(result));
  assert.equal(engine.disposed, true);
  assert.match(result.text, /## OCR text[\s\S]*Screenshot text/);
  assert.equal(result.format_metrics.embedded_image_pages, 1);
  assert.ok(result.warnings.some((entry) => entry.code === "ocr_applied"));
});

test("PDF layout detection skips full OCR when an embedded image has no visual text", async () => {
  const engine = new BatchPdfOcrStub(false);
  const result = await extractFixture("photo.pdf", await imagePdf(), engine);

  assert.equal(engine.detectionCalls.length, 1);
  assert.equal(engine.recognitionCalls.length, 0);
  assert.equal(result.pdf_ocr_pending, false);
  assert.equal(result.format_metrics.ocr_skipped_pages, 1);
  assert.equal(result.format_metrics.ocr_attempted_pages, 0);
  assert.doesNotMatch(result.text, /## OCR text/);
});

test("PDF layout detection recognizes positive pages in one shared-worker batch", async () => {
  const engine = new BatchPdfOcrStub(true);
  const result = await extractFixture("screenshot.pdf", await imagePdf(3), engine);

  assert.equal(engine.detectionCalls.length, 1);
  assert.equal(engine.recognitionCalls.length, 1);
  assert.equal(engine.detectionCalls[0].length, 3);
  assert.equal(engine.recognitionCalls[0].length, 3);
  assert.equal(result.format_metrics.ocr_completed_pages, 3);
  assert.match(result.text, /## OCR text[\s\S]*Detected screenshot text/);
});

test("PDF preflight delegates production page rendering and OCR by source path", async () => {
  const engine = new IsolatedPdfPathStub();
  const result = await extractFixture("image-isolated.pdf", await imagePdf(), engine);

  assert.equal(engine.requests.length, 1, JSON.stringify(result));
  assert.match(engine.requests[0].sourcePath, /image-isolated\.pdf$/);
  assert.equal(engine.requests[0].pageNumber, 1);
  assert.match(result.text, /Text from isolated renderer/);
});

test("PDF preflight can persist native text and defer OCR without dropping candidate pages", async () => {
  const engine = new StubPdfOcrEngine({ text: "must not be used yet", confidence: 99 });
  const result = await extractFixture("image-deferred.pdf", await imagePdf(), engine, { defer_pdf_ocr: true });

  assert.equal(result.parse_status, "ready");
  assert.equal(result.pdf_ocr_deferred, true);
  assert.equal(engine.images.length, 0);
  assert.equal(result.format_metrics.ocr_candidate_pages, 1);
  assert.match(result.text, /# Page 1/);
});

test("PDF preflight resumes from persisted completed OCR pages", async () => {
  const engine = new StubPdfOcrEngine({ text: "must not be used", confidence: 99 });
  const result = await extractFixture("image-resume.pdf", await imagePdf(), engine, {
    pdf_ocr_page_results: new Map([[1, {
      page_number: 1,
      native_text: "",
      ocr_text: "Recovered OCR text",
      status: "completed",
    }]]),
  });

  assert.equal(engine.images.length, 0);
  assert.match(result.text, /Recovered OCR text/);
  assert.equal(result.format_metrics.ocr_completed_pages, 1);
});

test("a bounded OCR continuation leaves remaining candidate pages pending", async () => {
  const engine = new StubPdfOcrEngine({ text: "must not be used yet", confidence: 99 });
  const result = await extractFixture("image-bounded.pdf", await imagePdf(), engine, { pdf_ocr_page_limit: 0 });

  assert.equal(engine.images.length, 0);
  assert.equal(result.pdf_ocr_pending, true);
  assert.equal(result.format_metrics.ocr_completed_pages, 0);
});

test("a persisted failed OCR page is not retried after interruption", async () => {
  const engine = new StubPdfOcrEngine({ text: "must not be used", confidence: 99 });
  const result = await extractFixture("image-failed-resume.pdf", await imagePdf(), engine, {
    pdf_ocr_page_results: new Map([[1, {
      page_number: 1,
      native_text: "",
      ocr_text: "",
      status: "failed",
    }]]),
  });

  assert.equal(engine.images.length, 0);
  assert.equal(result.pdf_ocr_pending, false);
  assert.equal(result.format_metrics.ocr_failed_pages, 1);
  assert.ok(result.warnings.some((entry) => entry.code === "ocr_page_failed"));
});

test("an empty PDF page is a successful OCR result, not a partial attachment", async () => {
  const engine = new StubPdfOcrEngine({ text: "", confidence: 0 });
  const result = await extractFixture("blank.pdf", blankPdf(), engine);

  assert.equal(result.parse_status, "ready");
  assert.equal(engine.images.length, 1, JSON.stringify(result));
  assert.ok(result.warnings.some((entry) => entry.code === "ocr_no_text_detected"));
  assert.ok(result.warnings.some((entry) => entry.code === "pdf_no_readable_text"));
});

test("an OCR engine error is warning-only and does not block PDF attachment reading", async () => {
  const engine = new StubPdfOcrEngine(new Error("worker unavailable"));
  const result = await extractFixture("image-error.pdf", await imagePdf(), engine);

  assert.equal(result.parse_status, "ready");
  assert.ok(result.warnings.some((entry) => entry.code === "ocr_page_failed"));
  assert.equal(result.format_metrics.ocr_failed_pages, 1);
});
