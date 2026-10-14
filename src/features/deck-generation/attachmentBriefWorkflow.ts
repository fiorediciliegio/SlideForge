import { isMainWorkflowAttachmentSource } from "../../ai/attachmentBriefPolicy";
import type {
  AttachmentBriefCompletionClient,
  AttachmentBriefCompletionInput,
} from "../../ai/attachmentBriefCompletion";
import { ATTACHMENT_BRIEF_COMPLETE_CONFIG } from "../../ai/attachmentBriefCompletion";
import {
  buildAttachmentBriefChunkPrompt,
  buildAttachmentBriefFinalPrompt,
  buildAttachmentBriefPrompt,
  buildSpreadsheetAttachmentBriefBatchPrompt,
  buildSpreadsheetAttachmentBriefFinalPrompt,
  buildSpreadsheetAttachmentBriefPrompt,
  type AttachmentBriefPromptChunk,
} from "../../ai/attachmentBriefPrompt";
import type { AiInteractionLogger } from "../../ai/interactionLog";
import { parseStructuredJson } from "../../ai/structuredJson";
import { LlmRequestExecutionError } from "../../ai/llmRequestExecutor";
import type { PptBackend } from "../../api/pptBackend";
import type {
  AttachmentBrief,
  AttachmentBriefSheetCoverage,
  UploadedSourceMaterial,
  UploadedSourcePreflightResult,
  WorkspaceResult,
} from "../../api/types";
import type {
  ImageAttachmentBriefClient,
  ImageAttachmentBriefCompletion,
} from "../../ai/imageAttachmentBriefTest";
import {
  ATTACHMENT_CONTEXT_TOTAL_TOKEN_LIMIT,
  estimateAttachmentContextInputTokens,
  estimateAttachmentContextTokens,
} from "./attachmentContextBudget";

type BriefBody = Omit<AttachmentBrief, "version" | "source_id" | "filename" | "updated_at">;
type PlainRecord = Record<string, unknown>;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
// Engine attachment-chunk reads are capped at this raw-character size. Keep
// grouped spreadsheet batches within the same contract before requesting them.
const ATTACHMENT_BRIEF_CHUNK_TRANSPORT_MAX_CHARACTERS = 300_000;

export interface AttachmentBriefProgress {
  phase: "reading" | "analyzing" | "completed";
  filename: string;
  sourceIndex: number;
  sourceCount: number;
  chunkIndex?: number;
  chunkCount?: number;
  /** A completed, validated model-produced summary, never raw JSON or hidden reasoning. */
  insight?: string;
}

export class AttachmentPreflightBlockedError extends Error {
  constructor(readonly results: UploadedSourcePreflightResult[]) {
    const failed = results.filter((result) => result.content_strategy === null);
    super(`Attachment processing cannot continue: ${failed.map((result) => result.filename).join(", ")}`);
    this.name = "AttachmentPreflightBlockedError";
  }
}

export class AttachmentContextBudgetExceededError extends Error {
  constructor() {
    super("Attachment context exceeds the 64,000 token limit after all files were summarized.");
    this.name = "AttachmentContextBudgetExceededError";
  }
}

export class AttachmentBriefInputBudgetExceededError extends Error {
  constructor(filename: string) {
    super(`Attachment Brief input for ${filename} still exceeds the ${ATTACHMENT_BRIEF_COMPLETE_CONFIG.maxInputTokens.toLocaleString()} token single-request limit after chunking.`);
    this.name = "AttachmentBriefInputBudgetExceededError";
  }
}

function asRecord(value: unknown): PlainRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Attachment Brief must be a JSON object.");
  }
  return value as PlainRecord;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Attachment Brief ${field} must be a non-empty string.`);
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Attachment Brief ${field} must be a string array.`);
  }
  return value;
}

function normalizeExcerptWhitespace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function conservativeAttachmentBriefTokenEstimate(text: string) {
  return Math.ceil(
    estimateAttachmentContextTokens(text) * ATTACHMENT_BRIEF_COMPLETE_CONFIG.estimateSafetyMultiplier,
  );
}

/**
 * Keep evidence verification literal while ignoring presentation-only
 * differences introduced when a model re-typesets a quotation.
 */
function normalizeExcerptForVerification(value: string) {
  return normalizeExcerptWhitespace(value
    // Link destinations are transport/presentation metadata, not the quoted
    // attachment prose. Models commonly retain the visible link text only.
    .replace(/\]\((?:\\.|[^)\r\n])*\)/gu, "]")
    .normalize("NFKC"))
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201C\u201D]/gu, "\"")
    .replace(/[\u2013\u2014\u2212]/gu, "-")
    .replace(/\u2026/gu, "...")
    .toLocaleLowerCase("en-US");
}

function trimExcerptSegmentBoundaryPunctuation(value: string) {
  return value
    .replace(/^["'(\[{]+/gu, "")
    .replace(/[\]"')},.;:!?\u3002\uFF01\uFF1F]+$/gu, "")
    .trim();
}

function sourceExcerptSegments(excerpt: string) {
  // A model may retain several complete Markdown bullets as evidence. Treat
  // the newline before each subsequent bullet as an explicit source boundary,
  // just like an ellipsis, while still requiring every retained piece to be
  // found in order in the extracted source.
  const withExplicitListBoundaries = excerpt.replace(/\r?\n\s*(?=-\s+)/gu, "\n...\n");
  return normalizeExcerptForVerification(withExplicitListBoundaries)
    .split(/(?:\.{3}|…)+/u)
    .map(trimExcerptSegmentBoundaryPunctuation)
    .filter(Boolean);
}

/**
 * An excerpt may omit text with an ellipsis, but every retained segment must
 * still be verbatim source text and appear in the same order. This avoids a
 * needless retry for harmless shortening while continuing to reject invented
 * or rewritten evidence.
 */
export function isSourceSupportedExcerpt(excerpt: string, extractedText: string) {
  const source = normalizeExcerptForVerification(extractedText);
  const segments = sourceExcerptSegments(excerpt);
  if (segments.length === 0) return false;
  let cursor = 0;
  for (const segment of segments) {
    const position = source.indexOf(segment, cursor);
    if (position < 0) return false;
    cursor = position + segment.length;
  }
  return true;
}

interface PdfPageSection {
  pageNumber: number;
  text: string;
}

function pdfPageSections(extractedText: string): PdfPageSection[] {
  const markers = [...extractedText.matchAll(/^# Page ([1-9]\d*)[ \t]*$/gmu)];
  return markers.map((marker, index) => ({
    pageNumber: Number.parseInt(marker[1]!, 10),
    text: extractedText.slice(
      marker.index! + marker[0].length,
      markers[index + 1]?.index ?? extractedText.length,
    ),
  }));
}

function formatPdfPageLabel(pageNumbers: number[]) {
  const pages = [...new Set(pageNumbers)].sort((left, right) => left - right);
  if (pages.length === 1) return `page:${pages[0]}`;
  const consecutive = pages.every((page, index) => index === 0 || page === pages[index - 1]! + 1);
  return consecutive
    ? `pages:${pages[0]}-${pages.at(-1)}`
    : `pages:${pages.join(",")}`;
}

/**
 * Derives a PDF physical-page citation from the already verified excerpt.
 * The model's source_label is never trusted as the citation authority.
 */
export function pdfSourceLabelForExcerpt(excerpt: string, extractedText: string): string | null {
  const sections = pdfPageSections(extractedText);
  const segments = sourceExcerptSegments(excerpt);
  if (sections.length === 0 || segments.length === 0) return null;

  const matchingPages = new Set<number>();
  for (const segment of segments) {
    const directMatches = sections.filter((section) => normalizeExcerptForVerification(section.text).includes(segment));
    if (directMatches.length > 0) {
      for (const section of directMatches) matchingPages.add(section.pageNumber);
      continue;
    }

    // A short verbatim segment can cross a physical page boundary. Limit this
    // fallback to adjacent pages so unrelated repeated text is not combined.
    let matchedAdjacentPages = false;
    for (let index = 0; index < sections.length - 1; index += 1) {
      const left = sections[index]!;
      const right = sections[index + 1]!;
      if (!normalizeExcerptForVerification(`${left.text}\n${right.text}`).includes(segment)) continue;
      matchingPages.add(left.pageNumber);
      matchingPages.add(right.pageNumber);
      matchedAdjacentPages = true;
    }
    if (!matchedAdjacentPages) return null;
  }

  return matchingPages.size > 0 ? formatPdfPageLabel([...matchingPages]) : null;
}

function isSupportedByEvidence(excerpt: string, verifiedExcerpts: ReadonlySet<string>) {
  const segments = sourceExcerptSegments(excerpt);
  return segments.length > 0
    && segments.every((segment) => [...verifiedExcerpts].some((candidate) => candidate.includes(segment)));
}

function normalizeSpreadsheetSheetName(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function spreadsheetSheetNameForChunk(chunk: Pick<AttachmentBriefPromptChunk, "headingPath">) {
  const heading = [...chunk.headingPath].reverse().find((item) => item.startsWith("Sheet:"));
  return heading?.slice("Sheet:".length).trim() || null;
}

export interface SpreadsheetAttachmentBriefBatchChunk extends Omit<AttachmentBriefPromptChunk, "content"> {
  startOffset: number;
  endOffset: number;
  tokenEstimate: number;
  sheetName?: string | null;
}

interface PlannedAttachmentBriefChunk extends SpreadsheetAttachmentBriefBatchChunk {}

export interface SpreadsheetAttachmentBriefBatch extends Omit<AttachmentBriefPromptChunk, "content"> {
  startOffset: number;
  endOffset: number;
  sheetNames: string[];
}

export function buildSpreadsheetAttachmentBriefBatches(chunks: SpreadsheetAttachmentBriefBatchChunk[]): SpreadsheetAttachmentBriefBatch[] {
  const rawBatches: PlannedAttachmentBriefChunk[][] = [];
  let active: PlannedAttachmentBriefChunk[] = [];
  let activeTokens = 0;
  const flush = () => {
    if (active.length === 0) return;
    rawBatches.push(active);
    active = [];
    activeTokens = 0;
  };
  for (const chunk of chunks) {
    if (!chunk.sheetName) throw new Error("Spreadsheet chunk plan did not preserve Sheet boundaries.");
    if (
      active.length > 0
      && (
        activeTokens + chunk.tokenEstimate > ATTACHMENT_BRIEF_COMPLETE_CONFIG.chunkTargetTokens
        || chunk.endOffset - active[0]!.startOffset > ATTACHMENT_BRIEF_CHUNK_TRANSPORT_MAX_CHARACTERS
      )
    ) flush();
    active.push(chunk);
    activeTokens += chunk.tokenEstimate;
  }
  flush();
  return rawBatches.map((batch, index) => {
    const first = batch[0]!;
    const last = batch.at(-1)!;
    return {
      chunkId: `batch-${String(index + 1).padStart(3, "0")}`,
      totalChunks: rawBatches.length,
      headingPath: first.headingPath,
      sourceRange: `characters:${first.startOffset}-${last.endOffset}`,
      startOffset: first.startOffset,
      endOffset: last.endOffset,
      sheetNames: [...new Set(batch.map((chunk) => chunk.sheetName!))],
    };
  });
}

export function normalizeStructuredBrief(
  value: unknown,
  isValidExcerpt: (excerpt: string) => boolean,
  originalReadingMethod: "document_retrieval" | "spreadsheet_read",
  expectedSpreadsheetSheets: string[] = [],
  sourceLabelForExcerpt?: (excerpt: string) => string | null,
): BriefBody {
  const raw = asRecord(value);
  if (raw.content_strategy !== "summarized_context") {
    throw new Error("Attachment Brief content_strategy must be summarized_context.");
  }
  if (raw.original_reading_method !== originalReadingMethod) {
    throw new Error(`Attachment Brief original_reading_method must be ${originalReadingMethod}.`);
  }
  const keyFacts = Array.isArray(raw.key_facts) ? raw.key_facts.map((item, index) => {
    const fact = asRecord(item);
    const excerpt = asString(fact.excerpt, `key_facts[${index}].excerpt`);
    if (!isValidExcerpt(excerpt)) {
      throw new Error(`Attachment Brief key_facts[${index}].excerpt must retain source text that can be found in the extracted attachment. Ellipses may only omit text between retained source segments; rewritten or invented text is rejected.`);
    }
    const verifiedSourceLabel = sourceLabelForExcerpt?.(excerpt);
    if (sourceLabelForExcerpt && !verifiedSourceLabel) {
      throw new Error(`Attachment Brief key_facts[${index}].excerpt could not be mapped to a PDF physical page.`);
    }
    return {
      evidence_id: asString(fact.evidence_id, `key_facts[${index}].evidence_id`),
      fact: asString(fact.fact, `key_facts[${index}].fact`),
      source_label: verifiedSourceLabel ?? asString(fact.source_label, `key_facts[${index}].source_label`),
      excerpt,
    };
  }) : (() => { throw new Error("Attachment Brief key_facts must be an array."); })();
  const evidenceIdSet = new Set(keyFacts.map((fact) => fact.evidence_id));
  const mustInclude = Array.isArray(raw.must_include) ? raw.must_include.map((item, index) => {
    const requirement = asRecord(item);
    const ids = asStringArray(requirement.evidence_ids, `must_include[${index}].evidence_ids`);
    const unknownIds = ids.filter((id) => !evidenceIdSet.has(id));
    if (unknownIds.length > 0) {
      throw new Error(`Attachment Brief must_include[${index}] references unknown evidence_id(s): ${unknownIds.join(", ")}. Every referenced ID must also appear in key_facts.`);
    }
    return { requirement: asString(requirement.requirement, `must_include[${index}].requirement`), evidence_ids: ids };
  }) : (() => { throw new Error("Attachment Brief must_include must be an array."); })();
  const sheetCoverage = expectedSpreadsheetSheets.length === 0
    ? undefined
    : (() => {
      if (!Array.isArray(raw.sheet_coverage)) {
        throw new Error("Spreadsheet Attachment Brief must include sheet_coverage.");
      }
      const expected = new Map(expectedSpreadsheetSheets.map((name) => [normalizeSpreadsheetSheetName(name), name]));
      const coverage = raw.sheet_coverage.map((item, index) => {
        const entry = asRecord(item);
        const sheetName = asString(entry.sheet_name, `sheet_coverage[${index}].sheet_name`);
        const expectedName = expected.get(normalizeSpreadsheetSheetName(sheetName));
        if (!expectedName) throw new Error(`Attachment Brief sheet_coverage[${index}] names an unexpected Sheet.`);
        const status = entry.status;
        if (status !== "covered" && status !== "not_relevant" && status !== "unreadable") {
          throw new Error(`Attachment Brief sheet_coverage[${index}].status is invalid.`);
        }
        const evidenceIds = asStringArray(entry.evidence_ids, `sheet_coverage[${index}].evidence_ids`);
        const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
        if (status === "covered") {
          if (evidenceIds.length === 0 || evidenceIds.some((id) => !evidenceIdSet.has(id))) {
            throw new Error(`Attachment Brief sheet_coverage[${index}] must reference known evidence when covered.`);
          }
          const matchingFacts = keyFacts.filter((fact) => evidenceIds.includes(fact.evidence_id));
          if (matchingFacts.some((fact) => !normalizeSpreadsheetSheetName(fact.source_label).includes(normalizeSpreadsheetSheetName(expectedName)))) {
            throw new Error(`Attachment Brief sheet_coverage[${index}] references evidence from another Sheet.`);
          }
        } else if (!reason) {
          throw new Error(`Attachment Brief sheet_coverage[${index}] must explain why the Sheet is not covered.`);
        }
        return {
          sheet_name: expectedName,
          status,
          ...(reason ? { reason } : {}),
          evidence_ids: evidenceIds,
        } as AttachmentBriefSheetCoverage;
      });
      if (coverage.length !== expected.size || new Set(coverage.map((item) => normalizeSpreadsheetSheetName(item.sheet_name))).size !== expected.size) {
        throw new Error("Spreadsheet Attachment Brief must cover every expected Sheet exactly once.");
      }
      return coverage;
    })();

  return {
    content_strategy: "summarized_context",
    original_reading_method: originalReadingMethod,
    ...(typeof raw.relationship_to_task === "string" ? { relationship_to_task: raw.relationship_to_task } : {}),
    ...(typeof raw.main_message === "string" ? { main_message: raw.main_message } : {}),
    key_facts: keyFacts,
    must_include: mustInclude,
    must_avoid: asStringArray(raw.must_avoid, "must_avoid"),
    recommended_storyline: asStringArray(raw.recommended_storyline, "recommended_storyline"),
    gaps: asStringArray(raw.gaps, "gaps"),
    unread_content: asStringArray(raw.unread_content, "unread_content"),
    ...(sheetCoverage ? { sheet_coverage: sheetCoverage } : {}),
  };
}

function parseJson(rawText: string, filename: string): unknown {
  try {
    return parseStructuredJson<unknown>(rawText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Attachment Brief Complete returned invalid JSON for ${filename}: ${detail}`);
  }
}

function completeBrief(source: UploadedSourceMaterial, brief: BriefBody): AttachmentBrief {
  return {
    version: 1,
    source_id: source.uploaded_source_id,
    filename: source.original_filename,
    ...brief,
    updated_at: "1970-01-01T00:00:00.000Z",
  };
}

function isImageSource(source: UploadedSourceMaterial) {
  return IMAGE_EXTENSIONS.has(source.extension.toLowerCase());
}

function imageBriefBody(brief: ImageAttachmentBriefCompletion["brief"]): BriefBody {
  const { version: _version, filename: _filename, ...body } = brief;
  return body;
}

async function appendImageBriefTelemetry(input: {
  backend: PptBackend;
  workspace: WorkspaceResult;
  source: UploadedSourceMaterial;
  durationMs: number;
  completion: ImageAttachmentBriefCompletion;
}) {
  await input.backend.appendWorkspaceLog({
    workspace_dir: input.workspace.workspace_dir,
    channel: "ai-requirements-interactions",
    entry: {
      event: "image_attachment_brief_completed",
      schema_version: 1,
      source_id: input.source.uploaded_source_id,
      filename: input.source.original_filename,
      requested_model: "google/gemini-3-flash-preview",
      actual_model: input.completion.actual_model,
      provider: input.completion.provider,
      duration_ms: input.durationMs,
      provider_latency_ms: input.completion.provider_latency_ms,
      quota_consumed: input.completion.quota_consumed,
      usage: input.completion.usage,
    },
  });
}

/**
 * Keep classified user image assets outside research/evidence. This directory
 * survives requirement confirmation and is read by Page Agents alongside the
 * image-research catalog.
 */
async function copyUploadedImageToAssetCatalog(input: {
  backend: PptBackend;
  workspace: WorkspaceResult;
  source: UploadedSourceMaterial;
  brief: AttachmentBrief;
}) {
  if (input.brief.use_in_ppt !== true) return;
  const candidateId = `uploaded-${input.source.uploaded_source_id}`;
  await input.backend.copyUploadedSourceImageToAsset({
    workspace_dir: input.workspace.workspace_dir,
    uploaded_source_id: input.source.uploaded_source_id,
    candidate_id: candidateId,
    description: input.brief.main_message || "User-uploaded image material.",
    reason: input.brief.image_usage_reason || "Classified as a user-provided PPT visual asset.",
  });
}

async function createImageAttachmentBrief(input: {
  backend: PptBackend;
  imageBriefClient: ImageAttachmentBriefClient;
  workspace: WorkspaceResult;
  source: UploadedSourceMaterial;
  userBrief: string;
}): Promise<AttachmentBrief> {
  const startedAt = performance.now();
  try {
    const uploaded = await input.backend.uploadUploadedSourceForAgent({
      workspace_dir: input.workspace.workspace_dir,
      uploaded_source_id: input.source.uploaded_source_id,
      operation_id: `image-attachment-brief:${input.source.uploaded_source_id}`,
    });
    const completion = await input.imageBriefClient.complete({
      filename: input.source.display_name || input.source.original_filename,
      userBrief: input.userBrief,
      attachment: {
        type: uploaded.host_upload.mime_type || input.source.mime_type,
        url: uploaded.host_upload.url,
        filename: input.source.original_filename,
        detail: "auto",
      },
    });
    const brief = completeBrief(input.source, imageBriefBody(completion.brief));
    await appendImageBriefTelemetry({
      backend: input.backend,
      workspace: input.workspace,
      source: input.source,
      durationMs: Math.round(performance.now() - startedAt),
      completion,
    }).catch(() => undefined);
    await copyUploadedImageToAssetCatalog({
      backend: input.backend,
      workspace: input.workspace,
      source: input.source,
      brief,
    });
    return brief;
  } catch (error) {
    await input.backend.appendWorkspaceLog({
      workspace_dir: input.workspace.workspace_dir,
      channel: "ai-requirements-interactions",
      entry: {
        event: "image_attachment_brief_failed",
        schema_version: 1,
        source_id: input.source.uploaded_source_id,
        filename: input.source.original_filename,
        duration_ms: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => undefined);
    throw error;
  }
}

function createFullContextBrief(preflight: UploadedSourcePreflightResult, content: string): BriefBody {
  return {
    content_strategy: "full_context",
    original_reading_method: preflight.original_reading_method === "spreadsheet_read" ? "spreadsheet_read" : "document_read",
    content,
    key_facts: [],
    must_include: [],
    must_avoid: [],
    recommended_storyline: [],
    gaps: [],
    unread_content: preflight.warnings.map((warning) => warning.message),
  };
}

async function readPreflightTextRange(input: {
  backend: PptBackend;
  workspaceDir: string;
  sourceId: string;
  startOffset: number;
  endOffset: number;
  attachmentChunk?: boolean;
}) {
  if (input.attachmentChunk) {
    const page = await input.backend.getUploadedSourcePreflightText({
      workspace_dir: input.workspaceDir,
      uploaded_source_id: input.sourceId,
      offset: input.startOffset,
      limit: input.endOffset - input.startOffset,
      attachment_chunk: true,
    });
    if (
      page.offset !== input.startOffset
      || page.content.length !== input.endOffset - input.startOffset
      || page.next_offset !== (input.endOffset < page.total_characters ? input.endOffset : null)
    ) {
      throw new Error("Attachment Brief chunk transport did not retrieve the requested persisted extraction range.");
    }
    return page.content;
  }
  const pages: string[] = [];
  let offset = input.startOffset;
  let totalCharacters: number | null = null;
  while (offset < input.endOffset) {
    const page = await input.backend.getUploadedSourcePreflightText({
      workspace_dir: input.workspaceDir,
      uploaded_source_id: input.sourceId,
      offset,
      limit: Math.min(120_000, input.endOffset - offset),
    });
    if (page.offset !== offset) throw new Error("Preflight text pagination returned an unexpected offset.");
    if (totalCharacters !== null && totalCharacters !== page.total_characters) {
      throw new Error("Preflight text changed while it was being read.");
    }
    totalCharacters = page.total_characters;
    pages.push(page.content);
    const nextOffset = page.next_offset ?? input.endOffset;
    if (nextOffset <= offset || nextOffset > input.endOffset) {
      throw new Error("Preflight text pagination did not make progress.");
    }
    offset = nextOffset;
  }
  const content = pages.join("");
  if (totalCharacters === null || content.length !== input.endOffset - input.startOffset) {
    throw new Error("Preflight text pagination did not retrieve the requested persisted extraction range.");
  }
  return content;
}

function sourcePromptData(source: UploadedSourceMaterial, preflight: UploadedSourcePreflightResult, userBrief: string) {
  const originalReadingMethod: "document_retrieval" | "spreadsheet_read" =
    preflight.original_reading_method === "spreadsheet_read" ? "spreadsheet_read" : "document_retrieval";
  return {
    sourceId: source.uploaded_source_id,
    filename: source.original_filename,
    userBrief,
    originalReadingMethod,
    warnings: preflight.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      ...(warning.locations ? { locations: warning.locations } : {}),
    })),
  };
}

function normalizeEvidencePacket(
  value: unknown,
  chunk: AttachmentBriefPromptChunk,
  expectedSheetName?: string,
  options: {
    verifyExcerpt?: boolean;
  } = {},
) {
  const packet = asRecord(value);
  const facts = Array.isArray(packet.key_facts) ? packet.key_facts : [];
  for (const [index, item] of facts.entries()) {
    const fact = asRecord(item);
    const excerpt = asString(fact.excerpt, `chunk ${chunk.chunkId} key_facts[${index}].excerpt`);
    if (options.verifyExcerpt !== false && !isSourceSupportedExcerpt(excerpt, chunk.content)) {
      throw new Error(`Attachment Brief ${chunk.chunkId} contains a source excerpt that could not be found in the extracted chunk.`);
    }
  }
  if (expectedSheetName) {
    if (packet.sheet_name !== expectedSheetName) {
      throw new Error(`Attachment Brief ${chunk.chunkId} must name the current Sheet exactly.`);
    }
    if (packet.sheet_status !== "covered" && packet.sheet_status !== "not_relevant" && packet.sheet_status !== "unreadable") {
      throw new Error(`Attachment Brief ${chunk.chunkId} must return a valid sheet_status.`);
    }
    const reason = typeof packet.sheet_reason === "string" ? packet.sheet_reason.trim() : "";
    if (packet.sheet_status === "covered" && facts.length === 0) {
      throw new Error(`Attachment Brief ${chunk.chunkId} must return evidence for a covered Sheet.`);
    }
    if (packet.sheet_status !== "covered" && !reason) {
      throw new Error(`Attachment Brief ${chunk.chunkId} must explain a non-covered Sheet.`);
    }
  }
  return packet;
}

function canonicalizePdfEvidencePacketSourceLabels(packets: unknown[], extractedText: string) {
  for (const [packetIndex, value] of packets.entries()) {
    const packet = asRecord(value);
    const facts = Array.isArray(packet.key_facts) ? packet.key_facts : [];
    for (const [factIndex, item] of facts.entries()) {
      const fact = asRecord(item);
      const excerpt = asString(fact.excerpt, `packet ${packetIndex + 1} key_facts[${factIndex}].excerpt`);
      const verifiedSourceLabel = pdfSourceLabelForExcerpt(excerpt, extractedText);
      if (!verifiedSourceLabel) {
        throw new Error(`Attachment Brief packet ${packetIndex + 1} key_facts[${factIndex}].excerpt could not be mapped to a PDF physical page after recombining the extracted chunks.`);
      }
      fact.source_label = verifiedSourceLabel;
    }
  }
}

export function normalizeSpreadsheetBatchEvidencePacket(
  value: unknown,
  batch: AttachmentBriefPromptChunk,
  expectedSheetNames: string[],
) {
  // Spreadsheet rows are serialized into a row-oriented text format. Models
  // reasonably reformat that structure while identifying a cell or row, so a
  // literal excerpt match is not reliable here. Keep the structural evidence
  // checks below (known IDs and the expected Sheet) instead. Text/PDF packets
  // still use the literal check in normalizeEvidencePacket's default path.
  const packet = normalizeEvidencePacket(value, batch, undefined, { verifyExcerpt: false });
  if (!Array.isArray(packet.sheet_coverage)) {
    throw new Error(`Attachment Brief ${batch.chunkId} must include sheet_coverage.`);
  }
  const facts = Array.isArray(packet.key_facts) ? packet.key_facts.map(asRecord) : [];
  const evidenceIds = new Set(facts.map((fact, index) => asString(fact.evidence_id, `batch ${batch.chunkId} key_facts[${index}].evidence_id`)));
  const expected = new Map(expectedSheetNames.map((name) => [normalizeSpreadsheetSheetName(name), name]));
  const coverage = packet.sheet_coverage.map((item, index) => {
    const entry = asRecord(item);
    const sheetName = asString(entry.sheet_name, `batch ${batch.chunkId} sheet_coverage[${index}].sheet_name`);
    const expectedName = expected.get(normalizeSpreadsheetSheetName(sheetName));
    if (!expectedName) throw new Error(`Attachment Brief ${batch.chunkId} names an unexpected Sheet.`);
    const status = entry.status;
    if (status !== "covered" && status !== "not_relevant" && status !== "unreadable") {
      throw new Error(`Attachment Brief ${batch.chunkId} has an invalid Sheet status.`);
    }
    const ids = asStringArray(entry.evidence_ids, `batch ${batch.chunkId} sheet_coverage[${index}].evidence_ids`);
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (status === "covered") {
      if (ids.length === 0 || ids.some((id) => !evidenceIds.has(id))) {
        throw new Error(`Attachment Brief ${batch.chunkId} must reference known evidence for a covered Sheet.`);
      }
      const matchingFacts = facts.filter((fact) => ids.includes(asString(fact.evidence_id, "key_facts[].evidence_id")));
      if (matchingFacts.some((fact) => !normalizeSpreadsheetSheetName(asString(fact.source_label, "key_facts[].source_label")).includes(normalizeSpreadsheetSheetName(expectedName)))) {
        throw new Error(`Attachment Brief ${batch.chunkId} references evidence from another Sheet.`);
      }
    } else if (!reason) {
      throw new Error(`Attachment Brief ${batch.chunkId} must explain a non-covered Sheet.`);
    }
    return expectedName;
  });
  if (coverage.length !== expected.size || new Set(coverage.map(normalizeSpreadsheetSheetName)).size !== expected.size) {
    throw new Error(`Attachment Brief ${batch.chunkId} must cover every expected Sheet exactly once.`);
  }
  return packet;
}

async function completeWithTelemetry<T>(input: {
  backend: PptBackend;
  completionClient: AttachmentBriefCompletionClient;
  workspace: WorkspaceResult;
  source: UploadedSourceMaterial;
  phase: "single" | "chunk" | "final";
  completion: AttachmentBriefCompletionInput<T>;
}): Promise<T> {
  const startedAt = performance.now();
  const appendWorkspaceLog = input.backend.appendWorkspaceLog;
  let completed;
  try {
    completed = await input.completionClient.complete(input.completion);
  } catch (error) {
    const attempts = error instanceof LlmRequestExecutionError ? error.attempts : [];
    if (typeof appendWorkspaceLog === "function") {
      await appendWorkspaceLog({
        workspace_dir: input.workspace.workspace_dir,
        channel: "attachment-preflight",
        entry: {
          event: "attachment_brief_complete_failed",
          schema_version: 1,
          source_id: input.source.uploaded_source_id,
          filename: input.source.original_filename,
          phase: input.phase,
          elapsed_ms: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
          attempts: attempts.map((attempt) => ({
            attempt: attempt.attempt,
            status: attempt.status,
            failure_kind: attempt.failure_kind ?? null,
            errors: attempt.errors,
            raw_text_length: attempt.raw_text?.length ?? 0,
            raw_text_preview: attempt.raw_text?.slice(0, 500) ?? "",
          })),
        },
      }).catch((logError) => {
        console.warn("Failed to record Attachment Brief completion failure telemetry", logError);
      });
    }
    throw error;
  }
  if (typeof appendWorkspaceLog === "function") {
    await appendWorkspaceLog({
      workspace_dir: input.workspace.workspace_dir,
      channel: "attachment-preflight",
      entry: {
        event: "attachment_brief_complete",
        schema_version: 1,
        source_id: input.source.uploaded_source_id,
        filename: input.source.original_filename,
        phase: input.phase,
        requested_model: completed.requested_model,
        actual_model: completed.actual_model,
        token_usage: completed.token_usage,
        elapsed_ms: Math.round(performance.now() - startedAt),
        attempts: completed.attempts.map((attempt) => ({
          attempt: attempt.attempt,
          status: attempt.status,
          failure_kind: attempt.failure_kind ?? null,
          errors: attempt.errors,
        })),
      },
    }).catch((error) => {
      // Observability must not discard an otherwise valid Attachment Brief.
      console.warn("Failed to record Attachment Brief completion telemetry", error);
    });
  }
  return completed.value;
}

async function createSummarizedBrief(input: {
  backend: PptBackend;
  completionClient: AttachmentBriefCompletionClient;
  aiLogger?: AiInteractionLogger | null;
  workspace: WorkspaceResult;
  source: UploadedSourceMaterial;
  preflight: UploadedSourcePreflightResult;
  userBrief: string;
  progress?: Omit<AttachmentBriefProgress, "phase" | "insight" | "chunkIndex" | "chunkCount">;
  onProgress?: (event: AttachmentBriefProgress) => void;
}): Promise<BriefBody> {
  const reportProgress = (event: Omit<AttachmentBriefProgress, "filename" | "sourceIndex" | "sourceCount">) => {
    if (!input.progress) return;
    input.onProgress?.({ ...input.progress, ...event });
  };
  const reportCompletedInsight = (text: string) => {
    try {
      const response = asRecord(parseStructuredJson<unknown>(text));
      const progressSummary = typeof response.progress_summary === "string" ? response.progress_summary.trim() : "";
      const mainMessage = typeof response.main_message === "string" ? response.main_message.trim() : "";
      const fallbackFact = Array.isArray(response.key_facts)
        ? response.key_facts.map(asRecord).map((fact) => typeof fact.fact === "string" ? fact.fact.trim() : "").find(Boolean) ?? ""
        : "";
      const insight = progressSummary || mainMessage || fallbackFact;
      if (insight) reportProgress({ phase: "analyzing", insight: insight.slice(0, 800) });
    } catch {
      // A response only reaches this callback after validation, but never let
      // a presentation-only update interrupt attachment processing.
    }
  };
  const promptData = sourcePromptData(input.source, input.preflight, input.userBrief);
  const logContext = input.aiLogger ? {
    logger: input.aiLogger,
    workspace_dir: input.workspace.workspace_dir,
    domain: "research" as const,
    operation: `attachment-brief:${input.source.uploaded_source_id}`,
  } : undefined;
  const sourceTokenEstimate = input.preflight.token_estimate;
  const sourceCharacterCount = input.preflight.character_count;
  const isSpreadsheet = promptData.originalReadingMethod === "spreadsheet_read";
  const isPdf = input.preflight.file_type.trim().toLocaleLowerCase("en-US") === "pdf"
    || input.source.extension.trim().toLocaleLowerCase("en-US") === ".pdf";
  const promptOverhead = estimateAttachmentContextTokens(buildAttachmentBriefPrompt({ ...promptData, content: "" }));
  const canReadWholeSourceForOneCall = !isSpreadsheet
    && sourceTokenEstimate !== undefined
    && sourceCharacterCount !== undefined
    && sourceCharacterCount <= ATTACHMENT_BRIEF_COMPLETE_CONFIG.chunkMaxCharacters
    && Math.ceil((sourceTokenEstimate + promptOverhead) * ATTACHMENT_BRIEF_COMPLETE_CONFIG.estimateSafetyMultiplier)
      <= ATTACHMENT_BRIEF_COMPLETE_CONFIG.maxInputTokens;
  if (canReadWholeSourceForOneCall) {
    const extractedText = await readPreflightTextRange({
      backend: input.backend,
      workspaceDir: input.workspace.workspace_dir,
      sourceId: input.source.uploaded_source_id,
      startOffset: 0,
      endOffset: input.preflight.character_count ?? 0,
      attachmentChunk: true,
    });
    const directPrompt = buildAttachmentBriefPrompt({ ...promptData, content: extractedText });
    if (conservativeAttachmentBriefTokenEstimate(directPrompt) > ATTACHMENT_BRIEF_COMPLETE_CONFIG.maxInputTokens) {
      throw new AttachmentBriefInputBudgetExceededError(input.source.original_filename);
    }
    reportProgress({ phase: "analyzing" });
    return completeWithTelemetry({
      backend: input.backend,
      completionClient: input.completionClient,
      workspace: input.workspace,
      source: input.source,
      phase: "single",
      completion: {
        prompt: directPrompt,
        logContext,
        metadata: { source_id: input.source.uploaded_source_id, filename: input.source.original_filename, mode: "single" },
        onCompletedText: reportCompletedInsight,
        accept: (raw) => normalizeStructuredBrief(
          parseJson(raw, input.source.original_filename),
          (excerpt) => isSourceSupportedExcerpt(excerpt, extractedText),
          promptData.originalReadingMethod,
          [],
          isPdf ? (excerpt) => pdfSourceLabelForExcerpt(excerpt, extractedText) : undefined,
        ),
      },
    });
  }

  const plan = await input.backend.getUploadedSourcePreflightChunks({
    workspace_dir: input.workspace.workspace_dir,
    uploaded_source_id: input.source.uploaded_source_id,
  });
  const chunks: PlannedAttachmentBriefChunk[] = plan.chunks.map((chunk) => {
    const promptChunk = {
      chunkId: chunk.chunk_id,
      totalChunks: plan.chunks.length,
      headingPath: chunk.heading_path,
      sourceRange: chunk.source_range,
      startOffset: chunk.start_offset,
      endOffset: chunk.end_offset,
      tokenEstimate: chunk.token_estimate,
    };
    return { ...promptChunk, ...(isSpreadsheet ? { sheetName: spreadsheetSheetNameForChunk(promptChunk) } : {}) };
  });
  if (chunks.length === 0) {
    throw new Error(`No extractable content was available to summarize ${input.source.original_filename}.`);
  }
  const spreadsheetSheetNames = isSpreadsheet
    ? [...new Set(chunks.map((chunk) => chunk.sheetName).filter((sheetName): sheetName is string => Boolean(sheetName)))]
    : [];
  if (isSpreadsheet && (spreadsheetSheetNames.length === 0 || chunks.some((chunk) => !chunk.sheetName))) {
    throw new Error(`Spreadsheet chunk plan did not preserve Sheet boundaries for ${input.source.original_filename}.`);
  }
  const spreadsheetBatches = isSpreadsheet ? buildSpreadsheetAttachmentBriefBatches(chunks) : [];
  if (isSpreadsheet && spreadsheetBatches.length === 1) {
    const batch = spreadsheetBatches[0]!;
    const content = await readPreflightTextRange({
      backend: input.backend,
      workspaceDir: input.workspace.workspace_dir,
      sourceId: input.source.uploaded_source_id,
      startOffset: batch.startOffset,
      endOffset: batch.endOffset,
      attachmentChunk: true,
    });
    const prompt = buildSpreadsheetAttachmentBriefPrompt({ ...promptData, content, sheetNames: spreadsheetSheetNames });
    if (conservativeAttachmentBriefTokenEstimate(prompt) > ATTACHMENT_BRIEF_COMPLETE_CONFIG.maxInputTokens) {
      throw new AttachmentBriefInputBudgetExceededError(input.source.original_filename);
    }
    reportProgress({ phase: "analyzing", chunkIndex: 1, chunkCount: 1 });
    return completeWithTelemetry({
      backend: input.backend,
      completionClient: input.completionClient,
      workspace: input.workspace,
      source: input.source,
      phase: "single",
      completion: {
        prompt,
        logContext,
        metadata: { source_id: input.source.uploaded_source_id, filename: input.source.original_filename, mode: "spreadsheet-single" },
        onCompletedText: reportCompletedInsight,
        accept: (raw) => normalizeStructuredBrief(
          parseJson(raw, input.source.original_filename),
          // See normalizeSpreadsheetBatchEvidencePacket: table evidence is
          // located by its Sheet/cell label, not by a verbatim row excerpt.
          () => true,
          promptData.originalReadingMethod,
          spreadsheetSheetNames,
        ),
      },
    });
  }
  const workItems: Array<Omit<AttachmentBriefPromptChunk, "content"> & { startOffset: number; endOffset: number; sheetNames?: string[] }> = isSpreadsheet
    ? spreadsheetBatches
    : chunks;
  const packets: unknown[] = [];
  const verifiedExcerpts = new Set<string>();
  const pdfChunkContents: string[] = [];
  for (const [chunkIndex, chunk] of workItems.entries()) {
    const content = await readPreflightTextRange({
      backend: input.backend,
      workspaceDir: input.workspace.workspace_dir,
      sourceId: input.source.uploaded_source_id,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      attachmentChunk: true,
    });
    if (isPdf) pdfChunkContents.push(content);
    const promptChunk: AttachmentBriefPromptChunk = {
      chunkId: chunk.chunkId,
      totalChunks: chunk.totalChunks,
      headingPath: chunk.headingPath,
      sourceRange: chunk.sourceRange,
      content,
    };
    const prompt = isSpreadsheet
      ? buildSpreadsheetAttachmentBriefBatchPrompt({ ...promptData, batch: promptChunk, sheetNames: chunk.sheetNames! })
      : buildAttachmentBriefChunkPrompt({ ...promptData, chunk: promptChunk });
    if (conservativeAttachmentBriefTokenEstimate(prompt) > ATTACHMENT_BRIEF_COMPLETE_CONFIG.maxInputTokens) {
      throw new AttachmentBriefInputBudgetExceededError(input.source.original_filename);
    }
    reportProgress({ phase: "analyzing", chunkIndex: chunkIndex + 1, chunkCount: workItems.length });
    const packet = await completeWithTelemetry({
      backend: input.backend,
      completionClient: input.completionClient,
      workspace: input.workspace,
      source: input.source,
      phase: "chunk",
      completion: {
        prompt,
        logContext,
        metadata: { source_id: input.source.uploaded_source_id, filename: input.source.original_filename, mode: isSpreadsheet ? "spreadsheet-batch" : "chunk", chunk_id: chunk.chunkId, total_chunks: chunk.totalChunks },
        onCompletedText: (text) => {
          reportProgress({ phase: "analyzing", chunkIndex: chunkIndex + 1, chunkCount: workItems.length });
          reportCompletedInsight(text);
        },
        accept: (raw) => isSpreadsheet
          ? normalizeSpreadsheetBatchEvidencePacket(
            parseJson(raw, input.source.original_filename),
            promptChunk,
            chunk.sheetNames!,
          )
          : normalizeEvidencePacket(
            parseJson(raw, input.source.original_filename),
            promptChunk,
          ),
      },
    });
    packets.push(packet);
    const packetFacts = asRecord(packet).key_facts;
    for (const fact of Array.isArray(packetFacts) ? packetFacts : []) {
      const excerpt = asRecord(fact).excerpt;
      // The final Brief validator uses normalizeExcerptForVerification. Store
      // evidence in that same canonical form so harmless re-typesetting
      // (case, curly quotes, line wrapping) cannot turn a verified quotation
      // into a false negative.
      if (typeof excerpt === "string") verifiedExcerpts.add(normalizeExcerptForVerification(excerpt));
    }
  }
  const recombinedPdfText = isPdf ? pdfChunkContents.join("\n") : "";
  if (isPdf) canonicalizePdfEvidencePacketSourceLabels(packets, recombinedPdfText);
  const finalPrompt = isSpreadsheet
    ? buildSpreadsheetAttachmentBriefFinalPrompt({ ...promptData, packets, sheetNames: spreadsheetSheetNames })
    : buildAttachmentBriefFinalPrompt({ ...promptData, packets });
  if (conservativeAttachmentBriefTokenEstimate(finalPrompt) > ATTACHMENT_BRIEF_COMPLETE_CONFIG.maxInputTokens) {
    throw new AttachmentBriefInputBudgetExceededError(input.source.original_filename);
  }
  reportProgress({ phase: "analyzing", chunkIndex: workItems.length, chunkCount: workItems.length });
  return completeWithTelemetry({
    backend: input.backend,
    completionClient: input.completionClient,
    workspace: input.workspace,
    source: input.source,
    phase: "final",
    completion: {
      prompt: finalPrompt,
      logContext,
      metadata: { source_id: input.source.uploaded_source_id, filename: input.source.original_filename, mode: "final", total_chunks: workItems.length },
      onCompletedText: reportCompletedInsight,
      accept: (raw) => normalizeStructuredBrief(
        parseJson(raw, input.source.original_filename),
        // Batch packets already retain their Sheet coverage and evidence-ID
        // relationships. Do not reapply prose-oriented literal matching to
        // a spreadsheet summary that may reformat table rows.
        isSpreadsheet ? () => true : (excerpt) => isSupportedByEvidence(excerpt, verifiedExcerpts),
        promptData.originalReadingMethod,
        spreadsheetSheetNames,
        isPdf
          ? (excerpt) => pdfSourceLabelForExcerpt(excerpt, recombinedPdfText)
          : undefined,
      ),
    },
  });
}

export async function ensureAttachmentBriefs(input: {
  backend: PptBackend;
  completionClient: AttachmentBriefCompletionClient;
  imageBriefClient?: ImageAttachmentBriefClient | null;
  aiLogger?: AiInteractionLogger | null;
  workspace: WorkspaceResult;
  userBrief: string;
  preflightRun?: { results: UploadedSourcePreflightResult[] };
  onProgress?: (event: AttachmentBriefProgress) => void;
}): Promise<AttachmentBrief[]> {
  const sourceList = await input.backend.listUploadedSources({
    workspace_dir: input.workspace.workspace_dir,
    include_removed: false,
  });
  const sources = sourceList.active.filter(isMainWorkflowAttachmentSource);
  if (sources.length === 0) {
    await input.backend.writeAttachmentContext({ workspace_dir: input.workspace.workspace_dir, user_brief: input.userBrief });
    return [];
  }
  const imageSources = sources.filter(isImageSource);
  const textSources = sources.filter((source) => !isImageSource(source));
  if (imageSources.length > 0 && !input.imageBriefClient) {
    throw new Error("Image Attachment Brief client is unavailable.");
  }

  const preflightRun = textSources.length > 0
    ? input.preflightRun ?? await input.backend.runUploadedSourcePreflight({ workspace_dir: input.workspace.workspace_dir })
    : { results: [] };
  const preflightById = new Map(preflightRun.results.map((result) => [result.source_id, result]));
  const relevant = textSources.map((source) => preflightById.get(source.uploaded_source_id)).filter((item): item is UploadedSourcePreflightResult => Boolean(item));
  if (relevant.length !== textSources.length || relevant.some((result) => result.content_strategy === null)) {
    throw new AttachmentPreflightBlockedError(relevant);
  }

  // Plan routing from Engine preflight metadata before fetching any persisted
  // extraction. In particular, a source selected for chunked summarization
  // must never first be paged in full through the browser bridge.
  const summarySourceIds = new Set(
    relevant
      .filter((result) => result.content_strategy === "summarized_context")
      .map((result) => result.source_id),
  );
  const estimatedContextTokens = () => {
    const provisional = textSources.map((source) => {
      const preflight = preflightById.get(source.uploaded_source_id)!;
      if (summarySourceIds.has(source.uploaded_source_id)) {
        return completeBrief(source, {
          content_strategy: "summarized_context",
          original_reading_method: preflight.original_reading_method === "spreadsheet_read" ? "spreadsheet_read" : "document_retrieval",
          key_facts: [],
          must_include: [],
          must_avoid: [],
          recommended_storyline: [],
          gaps: [],
          unread_content: [],
        });
      }
      return completeBrief(source, createFullContextBrief(preflight, ""));
    });
    const metadataTokens = estimateAttachmentContextInputTokens({ userBrief: input.userBrief, briefs: provisional });
    const fullTextTokens = textSources
      .filter((source) => !summarySourceIds.has(source.uploaded_source_id))
      .reduce((total, source) => total + (preflightById.get(source.uploaded_source_id)?.token_estimate ?? 0), 0);
    return metadataTokens + fullTextTokens;
  };
  const largestFullFirst = [...textSources]
    .filter((source) => !summarySourceIds.has(source.uploaded_source_id))
    .sort((left, right) => (preflightById.get(right.uploaded_source_id)?.token_estimate ?? 0) - (preflightById.get(left.uploaded_source_id)?.token_estimate ?? 0));
  for (const source of largestFullFirst) {
    if (estimatedContextTokens() <= ATTACHMENT_CONTEXT_TOTAL_TOKEN_LIMIT) break;
    summarySourceIds.add(source.uploaded_source_id);
  }
  if (estimatedContextTokens() > ATTACHMENT_CONTEXT_TOTAL_TOKEN_LIMIT) throw new AttachmentContextBudgetExceededError();

  const briefs = new Map<string, AttachmentBrief>();
  for (const [sourceIndex, source] of sources.entries()) {
    const progress = { filename: source.original_filename, sourceIndex: sourceIndex + 1, sourceCount: sources.length };
    if (isImageSource(source)) {
      input.onProgress?.({ ...progress, phase: "reading" });
      const brief = await createImageAttachmentBrief({
        backend: input.backend,
        imageBriefClient: input.imageBriefClient!,
        workspace: input.workspace,
        source,
        userBrief: input.userBrief,
      });
      briefs.set(source.uploaded_source_id, brief);
      input.onProgress?.({ ...progress, phase: "completed", insight: brief.main_message });
      continue;
    }
    const preflight = preflightById.get(source.uploaded_source_id)!;
    if (summarySourceIds.has(source.uploaded_source_id)) {
      input.onProgress?.({ ...progress, phase: "reading" });
      const brief = completeBrief(source, await createSummarizedBrief({ ...input, source, preflight, progress }));
      briefs.set(source.uploaded_source_id, brief);
      input.onProgress?.({ ...progress, phase: "completed", insight: brief.main_message });
      continue;
    }
    input.onProgress?.({ ...progress, phase: "reading" });
    const content = await readPreflightTextRange({
      backend: input.backend,
      workspaceDir: input.workspace.workspace_dir,
      sourceId: source.uploaded_source_id,
      startOffset: 0,
      endOffset: preflight.character_count ?? 0,
    });
    briefs.set(source.uploaded_source_id, completeBrief(source, createFullContextBrief(preflight, content)));
    input.onProgress?.({ ...progress, phase: "completed" });
  }

  const estimate = () => estimateAttachmentContextInputTokens({ userBrief: input.userBrief, briefs: [...briefs.values()] });
  let totalTokens = estimate();
  const materializedLargestFullFirst = [...textSources]
    .filter((source) => briefs.get(source.uploaded_source_id)?.content_strategy === "full_context")
    .sort((left, right) => estimateAttachmentContextTokens(briefs.get(right.uploaded_source_id)?.content ?? "") - estimateAttachmentContextTokens(briefs.get(left.uploaded_source_id)?.content ?? ""));
  for (const source of materializedLargestFullFirst) {
    if (totalTokens <= ATTACHMENT_CONTEXT_TOTAL_TOKEN_LIMIT) break;
    const preflight = preflightById.get(source.uploaded_source_id)!;
    const previous = briefs.get(source.uploaded_source_id)!;
    const progress = {
      filename: source.original_filename,
      sourceIndex: sources.findIndex((item) => item.uploaded_source_id === source.uploaded_source_id) + 1,
      sourceCount: sources.length,
    };
    input.onProgress?.({ ...progress, phase: "reading" });
    const summarized = completeBrief(source, await createSummarizedBrief({
      ...input,
      source,
      preflight,
      progress,
    }));
    briefs.set(source.uploaded_source_id, summarized);
    input.onProgress?.({ ...progress, phase: "completed", insight: summarized.main_message });
    const nextTotal = estimate();
    if (nextTotal < totalTokens) {
      totalTokens = nextTotal;
    } else {
      briefs.set(source.uploaded_source_id, previous);
    }
  }
  if (totalTokens > ATTACHMENT_CONTEXT_TOTAL_TOKEN_LIMIT) throw new AttachmentContextBudgetExceededError();

  const persisted: AttachmentBrief[] = [];
  for (const source of sources) {
    const brief = briefs.get(source.uploaded_source_id);
    if (!brief) continue;
    persisted.push(await input.backend.recordAttachmentBrief({
      workspace_dir: input.workspace.workspace_dir,
      uploaded_source_id: source.uploaded_source_id,
      brief,
    }));
  }
  await input.backend.writeAttachmentContext({ workspace_dir: input.workspace.workspace_dir, user_brief: input.userBrief });
  return persisted;
}
