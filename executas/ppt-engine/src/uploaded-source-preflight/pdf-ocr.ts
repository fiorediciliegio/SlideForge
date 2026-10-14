import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PdfOcrResult {
  text: string;
  confidence: number | null;
}

export type PdfOcrLanguage = "chi_sim" | "eng";

export interface PdfOcrPageRequest {
  page_number: number;
  native_text: string;
  language: PdfOcrLanguage;
}

export interface PdfOcrDetectionResult {
  page_number: number;
  has_visual_text: boolean;
}

export interface PdfOcrBatchResult extends PdfOcrResult {
  page_number: number;
  error?: string;
}

/** Kept small so a future PP-OCR implementation can replace Tesseract without changing PDF extraction. */
export interface PdfOcrEngine {
  /** Detect visual text for several PDF pages while reusing one isolated worker. */
  detectPdfPages?(
    sourcePath: string,
    pages: PdfOcrPageRequest[],
    timeoutMs: number,
  ): Promise<PdfOcrDetectionResult[]>;
  /** Recognize several previously detected PDF pages while reusing one isolated worker. */
  recognizePdfPages?(
    sourcePath: string,
    pages: PdfOcrPageRequest[],
    timeoutMs: number,
  ): Promise<PdfOcrBatchResult[]>;
  /**
   * Legacy injection seam for tests and alternative engines that receive an
   * already-rasterized page. The production engine deliberately does not use
   * this path: PDF.js canvas rendering must not run in the long-lived Executa
   * process.
   */
  recognizePage?(image: Buffer, timeoutMs: number, language?: PdfOcrLanguage): Promise<PdfOcrResult>;
  /** Rasterize and recognize one page in an isolated child process. */
  recognizePdfPage?(sourcePath: string, pageNumber: number, timeoutMs: number, language?: PdfOcrLanguage): Promise<PdfOcrResult>;
  dispose?(): Promise<void>;
}

export class PdfOcrTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`PDF OCR exceeded the ${timeoutMs}ms per-page limit.`);
    this.name = "PdfOcrTimeoutError";
  }
}

class PdfOcrRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfOcrRunnerError";
  }
}

async function resolveRunnerPath() {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Packaged application: dist/index.js -> project root.
    path.resolve(moduleDirectory, "..", "pdf-ocr-runner.mjs"),
    // Source and tsx test execution: src/uploaded-source-preflight -> project root.
    path.resolve(moduleDirectory, "..", "..", "pdf-ocr-runner.mjs"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next layout. The final error names all supported layouts.
    }
  }
  throw new PdfOcrRunnerError(`PDF OCR runner was not found. Checked: ${candidates.join(", ")}`);
}

interface RunnerResponse {
  ok: boolean;
  text?: string;
  confidence?: number | null;
  detections?: PdfOcrDetectionResult[];
  results?: PdfOcrBatchResult[];
  error?: string;
}

interface RunnerInput {
  action?: "detect_pdf_pages" | "recognize_pdf_pages";
  language: PdfOcrLanguage;
  image_base64?: string;
  pdf_path?: string;
  page_number?: number;
  pages?: PdfOcrPageRequest[];
}

async function recognizeInIsolatedProcess(
  input: RunnerInput,
  timeoutMs: number,
): Promise<RunnerResponse> {
  const runnerPath = await resolveRunnerPath();
  // Keep this computed dynamic import so tsup preserves the `node:` scheme.
  // A static `node:sea` import is rewritten to the nonexistent package `sea`.
  const seaModuleSpecifier = ["node", "sea"].join(":");
  const isSeaProcess = (await import(seaModuleSpecifier)).isSea();
  return new Promise<RunnerResponse>((resolve, reject) => {
    const child = spawn(process.execPath, isSeaProcess ? [] : [runnerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PRESENTON_TEMPLATE_ENGINE_PDF_OCR_RUNNER: "1",
      },
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let settled = false;
    const settleResolve = (value: RunnerResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => {
      child.kill();
      settleReject(new PdfOcrTimeoutError(timeoutMs));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => errors.push(Buffer.from(chunk)));
    child.once("error", (error) => settleReject(error));
    child.once("close", (code) => {
      const raw = Buffer.concat(output).toString("utf8").trim();
      try {
        const response = JSON.parse(raw) as RunnerResponse;
        if (response.ok) {
          settleResolve(response);
          return;
        }
        settleReject(new PdfOcrRunnerError(response.error || "PDF OCR runner failed."));
      } catch {
        const detail = Buffer.concat(errors).toString("utf8").trim();
        settleReject(new PdfOcrRunnerError(
          `PDF OCR runner exited with code ${code ?? "unknown"}.${detail ? ` ${detail}` : ""}`,
        ));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/**
 * Runs each OCR batch in a short-lived ordinary Node process. Tesseract.js uses
 * worker_threads internally; batch isolation prevents an Executa-hosted
 * plugin's long-lived stdio process from retaining or blocking that worker.
 */
export class TesseractPdfOcrEngine implements PdfOcrEngine {
  async detectPdfPages(
    sourcePath: string,
    pages: PdfOcrPageRequest[],
    timeoutMs: number,
  ): Promise<PdfOcrDetectionResult[]> {
    if (pages.length === 0) return [];
    const response = await recognizeInIsolatedProcess({
      action: "detect_pdf_pages",
      pdf_path: sourcePath,
      pages,
      language: "eng",
    }, timeoutMs);
    if (!Array.isArray(response.detections)) {
      throw new PdfOcrRunnerError("PDF OCR runner returned no detection results.");
    }
    return response.detections;
  }

  async recognizePdfPages(
    sourcePath: string,
    pages: PdfOcrPageRequest[],
    timeoutMs: number,
  ): Promise<PdfOcrBatchResult[]> {
    if (pages.length === 0) return [];
    const response = await recognizeInIsolatedProcess({
      action: "recognize_pdf_pages",
      pdf_path: sourcePath,
      pages,
      language: pages[0]?.language ?? "chi_sim",
    }, timeoutMs);
    if (!Array.isArray(response.results)) {
      throw new PdfOcrRunnerError("PDF OCR runner returned no batch recognition results.");
    }
    return response.results;
  }

  async recognizePage(image: Buffer, timeoutMs: number, language: PdfOcrLanguage = "chi_sim"): Promise<PdfOcrResult> {
    const response = await recognizeInIsolatedProcess({ image_base64: image.toString("base64"), language }, timeoutMs);
    return {
      text: typeof response.text === "string" ? response.text : "",
      confidence: Number.isFinite(response.confidence) ? response.confidence! : null,
    };
  }

  async recognizePdfPage(
    sourcePath: string,
    pageNumber: number,
    timeoutMs: number,
    language: PdfOcrLanguage = "chi_sim",
  ): Promise<PdfOcrResult> {
    const response = await recognizeInIsolatedProcess({ pdf_path: sourcePath, page_number: pageNumber, language }, timeoutMs);
    return {
      text: typeof response.text === "string" ? response.text : "",
      confidence: Number.isFinite(response.confidence) ? response.confidence! : null,
    };
  }
}
