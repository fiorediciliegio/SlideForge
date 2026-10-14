import path from "node:path";
import { performance } from "node:perf_hooks";
import { mkdir, rename, rm, stat } from "node:fs/promises";

import { createPdfFromSlideHtmlPaths } from "../app-workspace/pdf-export.js";
import {
  convertDeckHtmlToPptx,
  type ConvertDeckHtmlToPptxInput,
  type ConvertDeckHtmlToPptxResult,
} from "../pptx-export/dom-to-pptx.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 600_000;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

export type ExportOnlyFormat = "pptx" | "pdf";
export type ExportOnlyPhase = "validate-input" | "prepare" | "convert" | "finalize";

interface ExportOnlyInputBase {
  request_id: string;
  format: ExportOnlyFormat;
  source_root: string;
  deck_html_file: string;
  expected_slide_count: number;
  title?: string;
  output_dir: string;
  timeout_ms?: number;
}

export interface RunPptxExportOnlyInput extends ExportOnlyInputBase {
  format: "pptx";
  /** One-based source pages. Omit to export the complete deck. */
  page_numbers?: number[];
  slide_html_files?: never;
}

export interface RunPdfExportOnlyInput extends ExportOnlyInputBase {
  format: "pdf";
  slide_html_files: string[];
}

export type RunExportOnlyInput = RunPptxExportOnlyInput | RunPdfExportOnlyInput;

export interface ExportOnlyTimings {
  validate_input: number;
  prepare: number;
  convert: number;
  finalize: number;
  total: number;
}

export interface RunExportOnlyResult {
  version: 1;
  request_id: string;
  format: ExportOnlyFormat;
  status: "completed" | "failed";
  phase: ExportOnlyPhase;
  output_path: string | null;
  slide_count: number;
  size_bytes: number | null;
  started_at: string;
  completed_at: string;
  timings_ms: ExportOnlyTimings;
  warning_count: number;
  warnings: string[];
  font_embed_warnings: string[];
  error: {
    phase: ExportOnlyPhase;
    message: string;
    stack?: string;
  } | null;
}

export interface ExportOnlyDependencies {
  convertDeckHtmlToPptx(input: ConvertDeckHtmlToPptxInput): Promise<ConvertDeckHtmlToPptxResult>;
  createPdfFromSlideHtmlPaths(
    slideHtmlPaths: string[],
    pdfPath: string,
    timeoutMs: number,
  ): Promise<void>;
  now(): Date;
}

const DEFAULT_DEPENDENCIES: ExportOnlyDependencies = {
  convertDeckHtmlToPptx,
  createPdfFromSlideHtmlPaths,
  now: () => new Date(),
};

interface NormalizedExportOnlyInput {
  requestId: string;
  format: ExportOnlyFormat;
  sourceRoot: string;
  deckHtmlPath: string;
  slideHtmlPaths: string[];
  expectedSlideCount: number;
  title: string;
  outputDir: string;
  outputPath: string;
  temporaryPath: string;
  pageNumbers?: number[];
  timeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`"${name}" must be a non-empty string`);
  }
  return value.trim();
}

function resolveContainedFile(root: string, relativeFile: string, field: string): string {
  if (path.isAbsolute(relativeFile)) {
    throw new Error(`"${field}" must be relative to source_root`);
  }
  const resolved = path.resolve(root, relativeFile);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`"${field}" must resolve to a file inside source_root`);
  }
  return resolved;
}

function normalizeInput(value: unknown): NormalizedExportOnlyInput {
  if (!isRecord(value)) throw new Error("Arguments must be an object");

  const requestId = requiredString(value, "request_id");
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('"request_id" may only contain letters, numbers, dots, underscores and hyphens');
  }

  const format = requiredString(value, "format");
  if (format !== "pptx" && format !== "pdf") {
    throw new Error('"format" must be "pptx" or "pdf"');
  }

  const sourceRoot = path.normalize(requiredString(value, "source_root"));
  const outputDir = path.normalize(requiredString(value, "output_dir"));
  if (!path.isAbsolute(sourceRoot)) throw new Error('"source_root" must be an absolute path');
  if (!path.isAbsolute(outputDir)) throw new Error('"output_dir" must be an absolute path');

  const expectedSlideCount = Number(value.expected_slide_count);
  if (!Number.isInteger(expectedSlideCount) || expectedSlideCount < 1) {
    throw new Error('"expected_slide_count" must be a positive integer');
  }

  const timeoutMs = value.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : Number(value.timeout_ms);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`"timeout_ms" must be an integer from 1000 to ${MAX_TIMEOUT_MS}`);
  }

  const deckHtmlFile = requiredString(value, "deck_html_file");
  const deckHtmlPath = resolveContainedFile(sourceRoot, deckHtmlFile, "deck_html_file");
  let pageNumbers: number[] | undefined;
  if (format === "pptx" && value.page_numbers !== undefined) {
    if (!Array.isArray(value.page_numbers) || value.page_numbers.length === 0) {
      throw new Error('"page_numbers" must be a non-empty array for PPTX export');
    }
    pageNumbers = [...new Set(value.page_numbers.map((pageNumber, index) => {
      const numericPageNumber = Number(pageNumber);
      if (!Number.isInteger(numericPageNumber) || numericPageNumber < 1 || numericPageNumber > expectedSlideCount) {
        throw new Error(`"page_numbers[${index}]" must be an integer from 1 to expected_slide_count`);
      }
      return numericPageNumber;
    }))].sort((left, right) => left - right);
  } else if (format === "pdf" && value.page_numbers !== undefined) {
    throw new Error('"page_numbers" is currently supported only for PPTX export');
  }
  const slideHtmlFiles = value.slide_html_files;
  let slideHtmlPaths: string[] = [];
  if (format === "pdf") {
    if (!Array.isArray(slideHtmlFiles) || slideHtmlFiles.length === 0) {
      throw new Error('"slide_html_files" must be a non-empty array for PDF export');
    }
    if (slideHtmlFiles.length !== expectedSlideCount) {
      throw new Error('"slide_html_files" length must equal expected_slide_count');
    }
    slideHtmlPaths = slideHtmlFiles.map((item, index) => {
      if (typeof item !== "string" || !item.trim()) {
        throw new Error(`"slide_html_files[${index}]" must be a non-empty string`);
      }
      return resolveContainedFile(sourceRoot, item.trim(), `slide_html_files[${index}]`);
    });
  } else if (slideHtmlFiles !== undefined) {
    throw new Error('"slide_html_files" is only supported for PDF export');
  }

  const title = typeof value.title === "string" && value.title.trim()
    ? value.title.trim()
    : requestId;
  const outputPath = path.join(outputDir, `${requestId}.${format}`);

  return {
    requestId,
    format,
    sourceRoot,
    deckHtmlPath,
    slideHtmlPaths,
    expectedSlideCount,
    title,
    outputDir,
    outputPath,
    temporaryPath: `${outputPath}.tmp`,
    pageNumbers,
    timeoutMs,
  };
}

async function assertFile(filePath: string, label: string): Promise<void> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
}

async function assertOutputDoesNotExist(outputPath: string): Promise<void> {
  try {
    await stat(outputPath);
    throw new Error(`Export output already exists: ${outputPath}`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export async function runExportOnly(
  rawInput: unknown,
  dependencies: ExportOnlyDependencies = DEFAULT_DEPENDENCIES,
): Promise<RunExportOnlyResult> {
  const input = normalizeInput(rawInput);
  const startedAt = dependencies.now();
  const totalStartedAt = performance.now();
  const timings: ExportOnlyTimings = {
    validate_input: 0,
    prepare: 0,
    convert: 0,
    finalize: 0,
    total: 0,
  };
  let phase: ExportOnlyPhase = "validate-input";
  let slideCount = input.pageNumbers?.length ?? input.expectedSlideCount;
  let sizeBytes: number | null = null;
  let warningCount = 0;
  let warnings: string[] = [];
  let fontEmbedWarnings: string[] = [];

  try {
    let phaseStartedAt = performance.now();
    const sourceStat = await stat(input.sourceRoot);
    if (!sourceStat.isDirectory()) throw new Error(`source_root is not a directory: ${input.sourceRoot}`);
    await assertFile(input.deckHtmlPath, "Deck HTML");
    await Promise.all(input.slideHtmlPaths.map((filePath) => assertFile(filePath, "Slide HTML")));
    await assertOutputDoesNotExist(input.outputPath);
    timings.validate_input = elapsed(phaseStartedAt);

    phase = "prepare";
    phaseStartedAt = performance.now();
    await mkdir(input.outputDir, { recursive: true });
    await rm(input.temporaryPath, { force: true });
    timings.prepare = elapsed(phaseStartedAt);

    phase = "convert";
    phaseStartedAt = performance.now();
    if (input.format === "pptx") {
      const converted = await dependencies.convertDeckHtmlToPptx({
        htmlPath: input.deckHtmlPath,
        outputPath: input.outputPath,
        title: input.title,
        expectedSlideCount: input.expectedSlideCount,
        ...(input.pageNumbers === undefined ? {} : { pageNumbers: input.pageNumbers }),
        timeoutMs: input.timeoutMs,
      });
      if (path.normalize(converted.outputPath) !== path.normalize(input.temporaryPath)) {
        throw new Error(`PPTX converter returned an unexpected temporary output path: ${converted.outputPath}`);
      }
      slideCount = converted.slideCount;
      sizeBytes = converted.sizeBytes;
      warningCount = converted.warningCount;
      fontEmbedWarnings = [...converted.fontEmbedWarnings];
    } else {
      await dependencies.createPdfFromSlideHtmlPaths(
        input.slideHtmlPaths,
        input.temporaryPath,
        input.timeoutMs,
      );
    }
    timings.convert = elapsed(phaseStartedAt);

    phase = "finalize";
    phaseStartedAt = performance.now();
    await rename(input.temporaryPath, input.outputPath);
    const outputStat = await stat(input.outputPath);
    if (!outputStat.isFile() || outputStat.size === 0) {
      throw new Error(`Export output is empty or invalid: ${input.outputPath}`);
    }
    sizeBytes = outputStat.size;
    timings.finalize = elapsed(phaseStartedAt);
    timings.total = elapsed(totalStartedAt);

    return {
      version: 1,
      request_id: input.requestId,
      format: input.format,
      status: "completed",
      phase,
      output_path: input.outputPath,
      slide_count: slideCount,
      size_bytes: sizeBytes,
      started_at: startedAt.toISOString(),
      completed_at: dependencies.now().toISOString(),
      timings_ms: timings,
      warning_count: warningCount + fontEmbedWarnings.length,
      warnings,
      font_embed_warnings: fontEmbedWarnings,
      error: null,
    };
  } catch (error) {
    await rm(input.temporaryPath, { force: true }).catch(() => undefined);
    timings.total = elapsed(totalStartedAt);
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error && error.stack ? error.stack : undefined;
    warnings = [...warnings];

    return {
      version: 1,
      request_id: input.requestId,
      format: input.format,
      status: "failed",
      phase,
      output_path: null,
      slide_count: slideCount,
      size_bytes: sizeBytes,
      started_at: startedAt.toISOString(),
      completed_at: dependencies.now().toISOString(),
      timings_ms: timings,
      warning_count: warningCount + fontEmbedWarnings.length,
      warnings,
      font_embed_warnings: fontEmbedWarnings,
      error: {
        phase,
        message,
        ...(stack ? { stack } : {}),
      },
    };
  }
}
