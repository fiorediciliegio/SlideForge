import type { AppUploadedSourceParseStatus, AppUploadedSourcePreflightWarning } from "../app-workspace/types.js";
import type { PdfOcrEngine } from "./pdf-ocr.js";

export interface ExtractedUploadedSource {
  text: string;
  parse_status: AppUploadedSourceParseStatus;
  warnings: AppUploadedSourcePreflightWarning[];
  format_metrics: Record<string, number>;
  is_image: boolean;
  is_spreadsheet: boolean;
  pdf_ocr_deferred?: boolean;
  /** OCR work remains after a bounded, persisted continuation step. */
  pdf_ocr_pending?: boolean;
}

export interface PdfOcrProgress {
  total_pages: number;
  candidate_pages: number;
  processed_pages: number;
  completed_pages: number;
  failed_pages: number;
  current_page: number | null;
}

/** Persisted only while diagnosing an in-flight PDF OCR continuation. */
export interface PdfOcrStageProgress {
  stage: "opening_pdf" | "scanning_pages" | "detecting_pages" | "rendering_page" | "recognizing_page" | "persisting_page";
  page_number: number | null;
}

export interface PdfOcrPageResult {
  page_number: number;
  native_text: string;
  ocr_text: string;
  status: "detected" | "skipped" | "completed" | "failed";
  error?: string;
}

export interface UploadedSourceExtractionOptions {
  /** Directory where extracted DOCX image resources are persisted. */
  asset_dir?: string;
  /** Relative path prefix written into the persisted Markdown artifact. */
  asset_reference_prefix?: string;
  /** Test seam and future OCR-engine replacement point for PDF page OCR. */
  pdf_ocr_engine?: PdfOcrEngine;
  /** Parse native PDF text now and defer visual OCR to a persisted background job. */
  defer_pdf_ocr?: boolean;
  /** Called after the candidate list is known and after each OCR page completes. */
  on_pdf_ocr_progress?: (progress: PdfOcrProgress) => Promise<void> | void;
  /** Called at durable boundaries so a stalled continuation can be diagnosed. */
  on_pdf_ocr_stage?: (progress: PdfOcrStageProgress) => Promise<void> | void;
  /** Persisted page OCR from a prior interrupted job; completed and failed pages are not reprocessed. */
  pdf_ocr_page_results?: ReadonlyMap<number, PdfOcrPageResult>;
  /** Maximum pages inspected by one shared-worker layout-detection batch. */
  pdf_ocr_detection_page_limit?: number;
  /** Persist one completed page before advancing to the next candidate. */
  on_pdf_ocr_page?: (result: PdfOcrPageResult) => Promise<void> | void;
  /**
   * Bound one durable continuation call without imposing a document-wide OCR
   * limit. Remaining pages are continued by a later explicit tool invocation.
   */
  pdf_ocr_page_limit?: number;
}
