import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import sharp from "sharp";
import TurndownService from "turndown";
import WordExtractor from "word-extractor";
import * as XLSX from "xlsx";
import { PDF_NEAR_ZERO_TEXT_CHARACTERS, PDF_OCR_LIMITS } from "./config.js";
import { PdfOcrTimeoutError, TesseractPdfOcrEngine } from "./pdf-ocr.js";
import type { PdfOcrBatchResult, PdfOcrPageRequest } from "./pdf-ocr.js";
import type { ExtractedUploadedSource, PdfOcrPageResult, PdfOcrProgress, UploadedSourceExtractionOptions } from "./types.js";

const warning = (code: string, message: string, locations?: string[]) =>
  locations && locations.length > 0 ? { code, message, locations } : { code, message };

const requireFromExtractionModule = createRequire(import.meta.url);

/**
 * PDF.js does not infer these Node-side assets. Keeping the paths next to the
 * installed package lets it decode CID-encoded CJK text, JPEG2000/JPX images,
 * ICC color profiles, and fallback fonts.
 */
export function resolvePdfJsResourceDirectories() {
  const pdfjsRoot = path.dirname(requireFromExtractionModule.resolve("pdfjs-dist/package.json"));
  // PDF.js validates these as URL-style base paths, even when its Node factory
  // ultimately reads them through fs. Windows backslashes are therefore not
  // accepted as the required trailing slash.
  const directoryUrl = (directory: string) => `${directory.replace(/\\/g, "/")}/`;
  return {
    cMapUrl: directoryUrl(path.join(pdfjsRoot, "cmaps")),
    cMapPacked: true,
    iccUrl: directoryUrl(path.join(pdfjsRoot, "iccs")),
    wasmUrl: directoryUrl(path.join(pdfjsRoot, "wasm")),
    standardFontDataUrl: directoryUrl(path.join(pdfjsRoot, "standard_fonts")),
  };
}

function decodeText(bytes: Buffer): { text: string; warning?: ReturnType<typeof warning> } {
  const utf8Bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const utf16LeBom = bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]));
  const utf16BeBom = bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]));
  const encoding = utf16LeBom ? "utf-16le" : utf16BeBom ? "utf-16be" : "utf-8";
  const payload = utf8Bom ? bytes.subarray(3) : utf16LeBom || utf16BeBom ? bytes.subarray(2) : bytes;
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(payload).replace(/\r\n?/g, "\n");
    if (/\u0000/u.test(text)) {
      return { text, warning: warning("encoding_invalid", "文本包含 NUL 字符，无法确认其编码是否可用。") };
    }
    return { text };
  } catch {
    return { text: "", warning: warning("encoding_invalid", "文件不是可严格解码的 UTF-8/UTF-16 文本，未将可能乱码标记为成功。") };
  }
}

function decodeXml(value: string) {
  return value.replace(/&(?:amp|lt|gt|quot|apos);|&#(x[\da-fA-F]+|\d+);/g, (entity, code) => {
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (named[entity]) return named[entity];
    const numeric = String(code).startsWith("x") ? Number.parseInt(String(code).slice(1), 16) : Number.parseInt(String(code), 10);
    return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity;
  });
}

// This intentionally does not execute HTML. It removes non-visible source-code
// regions and common hidden nodes before counting the remaining rendered text.
function htmlVisibleText(value: string) {
  return decodeXml(value
    .replace(/<(?:script|style|template|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|template|noscript)>/gi, "")
    .replace(/<([\w-]+)\b[^>]*(?:\bhidden\b|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden))[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

function sanitizeDocxHtml(value: string) {
  return value
    .replace(/<(?:script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/(?:script|style|iframe|object|embed)>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

interface DocxTableRender {
  markdown: string;
  rowCount: number;
  mergedCellCount: number;
  hasNestedTable: boolean;
}

function findElementEnd(xml: string, start: number, tagName: string) {
  const tag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`<(/?)${tag}\\b[^>]*?(\/?)>`, "gi");
  matcher.lastIndex = start;
  let depth = 0;
  for (let match = matcher.exec(xml); match; match = matcher.exec(xml)) {
    const [token, closing, selfClosing] = match;
    if (closing) {
      depth -= 1;
      if (depth === 0) return matcher.lastIndex;
    } else if (!selfClosing && !/\/$/.test(token)) {
      depth += 1;
    }
  }
  return -1;
}

function findDirectWordElements(xml: string, parentTag: string, childTag: string) {
  const matcher = /<(\/?)(w:[\w-]+)\b[^>]*?(\/?)>/gi;
  const stack: string[] = [];
  const elements: string[] = [];
  for (let match = matcher.exec(xml); match; match = matcher.exec(xml)) {
    const [token, closing, tagName, selfClosing] = match;
    if (closing) {
      stack.pop();
      continue;
    }
    if (tagName === childTag && stack.at(-1) === parentTag) {
      const end = findElementEnd(xml, match.index, childTag);
      if (end > 0) {
        elements.push(xml.slice(match.index, end));
        matcher.lastIndex = end;
        continue;
      }
    }
    if (!selfClosing && !/\/$/.test(token)) stack.push(tagName);
  }
  return elements;
}

function directWordTables(xml: string) {
  const matcher = /<w:tbl\b[^>]*>/gi;
  const tables: string[] = [];
  for (let match = matcher.exec(xml); match; match = matcher.exec(xml)) {
    const end = findElementEnd(xml, match.index, "w:tbl");
    if (end < 0) continue;
    tables.push(xml.slice(match.index, end));
    matcher.lastIndex = end;
  }
  return tables;
}

function wordText(value: string, hyperlinkTargets: Map<string, string>): string {
  const withLinks: string = value.replace(/<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>/gi, (_match, attributes: string, content: string): string => {
    const relationId = attributes.match(/\br:id\s*=\s*["']([^"']+)["']/i)?.[1];
    const label: string = wordText(content, new Map<string, string>()).trim();
    const target = relationId ? hyperlinkTargets.get(relationId) : undefined;
    return target && label ? `${label} (${target})` : label;
  });
  return decodeXml(withLinks
    .replace(/<w:tab\b[^>]*\/?\s*>/gi, "\t")
    .replace(/<w:br\b[^>]*\/?\s*>/gi, "\n")
    .replace(/<w:p\b[^>]*>/gi, "")
    .replace(/<\/w:p>/gi, "\n")
    .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

function tableCellText(value: string, hyperlinkTargets: Map<string, string>) {
  return wordText(value, hyperlinkTargets).replace(/\s*\n\s*/g, " / ").replace(/\s{2,}/g, " ").trim();
}

function escapeTableCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function renderDocxTable(tableXml: string, tableNumber: number, hyperlinkTargets: Map<string, string>): DocxTableRender {
  const rows = findDirectWordElements(tableXml, "w:tbl", "w:tr");
  const renderedRows: Array<{ header: boolean; cells: string[] }> = [];
  let columnCount = 0;
  let mergedCellCount = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const header = /<w:tblHeader\b[^>]*\/?\s*>/i.test(row);
    const cells = findDirectWordElements(row, "w:tr", "w:tc");
    const values: string[] = [];
    for (const cell of cells) {
      const span = Math.max(1, Number.parseInt(cell.match(/<w:gridSpan\b[^>]*\bw:val\s*=\s*["'](\d+)["']/i)?.[1] ?? "1", 10));
      const verticalMerge = cell.match(/<w:vMerge\b([^>]*)\/?\s*>/i)?.[1];
      const mergeValue = verticalMerge?.match(/\bw:val\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
      let value = tableCellText(cell, hyperlinkTargets) || " ";
      if (verticalMerge !== undefined && mergeValue !== "restart") {
        value = "↑ merged from previous row";
        mergedCellCount += 1;
      }
      if (span > 1) {
        value = `${value} [colspan=${span}]`;
        mergedCellCount += 1;
      }
      values.push(escapeTableCell(value));
      for (let index = 1; index < span; index += 1) values.push(" ");
    }
    columnCount = Math.max(columnCount, values.length);
    renderedRows.push({ header, cells: values });
  }
  const hasNestedTable = /<w:tc\b[^>]*>[\s\S]*?<w:tbl\b/i.test(tableXml);
  if (renderedRows.length === 0 || columnCount === 0) {
    return { markdown: `## Table ${tableNumber}\n\n[Empty or unsupported table]`, rowCount: 0, mergedCellCount, hasNestedTable };
  }
  const lines = [`## Table ${tableNumber}`];
  for (const [index, row] of renderedRows.entries()) {
    if (row.header) lines.push(`> Header row ${index + 1}`);
    const cells = [...row.cells, ...Array.from({ length: Math.max(0, columnCount - row.cells.length) }, () => " ")];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  if (hasNestedTable) lines.push("\n> Nested table content is retained in its parent cell; nested layout is not fully modeled.");
  return { markdown: lines.join("\n"), rowCount: renderedRows.length, mergedCellCount, hasNestedTable };
}

function replaceDocxHtmlTables(html: string, tables: DocxTableRender[]) {
  let index = 0;
  let cursor = 0;
  let output = "";
  const matcher = /<table\b[^>]*>/gi;
  for (let match = matcher.exec(html); match; match = matcher.exec(html)) {
    const end = findElementEnd(html, match.index, "table");
    if (end < 0) break;
    output += html.slice(cursor, match.index);
    output += tables[index] ? `@@ANNA-DOCX-TABLE-${index}@@` : html.slice(match.index, end);
    cursor = end;
    index += 1;
    matcher.lastIndex = end;
  }
  return output + html.slice(cursor);
}

function createDocxMarkdown(html: string, tables: DocxTableRender[]) {
  const service = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    headingStyle: "atx",
  });
  const tableReadyHtml = replaceDocxHtmlTables(sanitizeDocxHtml(html), tables);
  let markdown = service.turndown(tableReadyHtml).replace(/\r\n?/g, "\n");
  for (const [index, table] of tables.entries()) {
    markdown = markdown.replace(`@@ANNA-DOCX-TABLE-${index}@@`, table.markdown);
  }
  return markdown.trim();
}

function extensionForMimeType(mimeType: string) {
  const known: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
  };
  return known[mimeType.toLowerCase()] ?? ".bin";
}

async function inspectDocx(bytes: Buffer) {
  const archive = await JSZip.loadAsync(bytes);
  const names = Object.keys(archive.files);
  const documentXml = await archive.file("word/document.xml")?.async("string") ?? "";
  const warnings = [] as ReturnType<typeof warning>[];
  let partial = false;
  const markPartial = (code: string, message: string) => {
    warnings.push(warning(code, message));
    partial = true;
  };
  if (names.some((name) => name.startsWith("word/embeddings/") || /<w:object\b/i.test(documentXml))) {
    markPartial("docx_ole_unread", "DOCX 包含嵌入式 OLE 对象；本轮未读取其内部内容。");
  }
  if (names.some((name) => name.startsWith("word/charts/") || name.startsWith("word/diagrams/"))) {
    markPartial("docx_visual_structure_unread", "DOCX 包含图表或 SmartArt 等视觉结构；本轮未提取其语义内容。");
  }
  if (/<m:oMath\b|<m:oMathPara\b/i.test(documentXml)) {
    markPartial("docx_equation_unread", "DOCX 包含公式对象；本轮未保证公式语义完整提取。");
  }
  const headerFooterCount = names.filter((name) => /^word\/(?:header|footer)\d+\.xml$/i.test(name)).length;
  if (false) {
    warnings.push(warning("docx_header_footer_not_extracted", "DOCX 包含页眉或页脚；本轮正文转换未将其并入附件正文。"));
  }
  const readRelationships = async (partName: string) => {
    const part = archive.file(partName);
    if (!part) return new Map<string, string>();
    const xml = await part.async("string");
    return new Map([...xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)].flatMap((relation) => {
      const attributes = relation[1];
      const id = attributes.match(/\bId\s*=\s*["']([^"']+)["']/i)?.[1];
      const target = attributes.match(/\bTarget\s*=\s*["']([^"']+)["']/i)?.[1];
      const mode = attributes.match(/\bTargetMode\s*=\s*["']([^"']+)["']/i)?.[1];
      return id && target && mode?.toLowerCase() === "external" ? [[id, decodeXml(target)] as const] : [];
    }));
  };
  const bodyHyperlinkTargets = await readRelationships("word/_rels/document.xml.rels");
  const bodyTables = directWordTables(documentXml).map((table, index) => renderDocxTable(table, index + 1, bodyHyperlinkTargets));
  const headerFooterParts = names.filter((name) => /^word\/(?:header|footer)\d+\.xml$/i.test(name)).sort();
  const headerFooters: string[] = [];
  const headerFooterFailures: string[] = [];
  for (const partName of headerFooterParts) {
    try {
      const xml = await archive.file(partName)?.async("string") ?? "";
      const fileName = partName.split("/").at(-1) ?? partName;
      const kind = fileName.startsWith("header") ? "Header" : "Footer";
      const text = wordText(xml, await readRelationships(`word/_rels/${fileName}.rels`));
      if (text) headerFooters.push(`## ${kind}: ${fileName}\n\n${text}`);
    } catch {
      headerFooterFailures.push(partName);
    }
  }
  if (headerFooterFailures.length > 0) {
    warnings.push(warning("docx_header_footer_parse_failed", "DOCX 的部分页眉或页脚无法读取。", headerFooterFailures));
    partial = true;
  }
  const nestedTables = bodyTables.filter((table) => table.hasNestedTable).length;
  if (nestedTables > 0) {
    warnings.push(warning("docx_nested_table_partial", `DOCX 包含 ${nestedTables} 个嵌套表格；已保留父单元格文字，但未完整建模嵌套布局。`));
  }
  const readNotes = async (partName: string, label: string) => {
    const part = archive.file(partName);
    if (!part) return "";
    const xml = await part.async("string");
    const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
      .map((paragraph) => [...paragraph[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
        .map((text) => decodeXml(text[1]))
        .join("")
        .trim())
      .filter(Boolean);
    return paragraphs.length > 0 ? `## ${label}\n\n${paragraphs.join("\n\n")}` : "";
  };
  const [footnotes, endnotes] = await Promise.all([
    readNotes("word/footnotes.xml", "Footnotes"),
    readNotes("word/endnotes.xml", "Endnotes"),
  ]);
  return {
    warnings,
    partial,
    headerFooterCount,
    headerFooters,
    bodyTables,
    tableCount: bodyTables.length,
    tableRowCount: bodyTables.reduce((total, table) => total + table.rowCount, 0),
    mergedTableCellCount: bodyTables.reduce((total, table) => total + table.mergedCellCount, 0),
    footnotes,
    endnotes,
  };
}

async function extractDocx(bytes: Buffer, options: UploadedSourceExtractionOptions): Promise<ExtractedUploadedSource> {
  const extractionStartedAt = performance.now();
  const inspectionStartedAt = performance.now();
  const inspection = await inspectDocx(bytes);
  const inspectionMs = Math.round(performance.now() - inspectionStartedAt);
  let extractedImages = 0;
  const assetDir = options.asset_dir;
  const assetSetupStartedAt = performance.now();
  if (assetDir) await mkdir(assetDir, { recursive: true });
  const assetSetupMs = Math.round(performance.now() - assetSetupStartedAt);
  const mammothStartedAt = performance.now();
  const result = await mammoth.convertToHtml({ buffer: bytes }, {
    externalFileAccess: false,
    convertImage: mammoth.images.imgElement(async (image) => {
      extractedImages += 1;
      const extension = extensionForMimeType(image.contentType);
      const filename = `image-${String(extractedImages).padStart(3, "0")}${extension}`;
      if (assetDir) {
        await writeFile(`${assetDir}/${filename}`, Buffer.from(await image.read("buffer")));
      }
      const prefix = options.asset_reference_prefix?.replace(/\/$/u, "") ?? "images";
      return { src: `${prefix}/${filename}` };
    }),
  } as never);
  const mammothConvertMs = Math.round(performance.now() - mammothStartedAt);
  const markdownStartedAt = performance.now();
  const text = [createDocxMarkdown(result.value, inspection.bodyTables), ...inspection.headerFooters, inspection.footnotes, inspection.endnotes].filter(Boolean).join("\n\n");
  const markdownConvertMs = Math.round(performance.now() - markdownStartedAt);
  const warnings = [
    ...inspection.warnings,
    ...result.messages.map((item) => warning("docx_conversion_warning", item.message)),
  ];
  if (extractedImages > 0) {
    warnings.push(warning("visual_content_not_analyzed", `DOCX 包含 ${extractedImages} 个已保存的图片资源；本轮未进行视觉理解或 OCR。`));
  }
  return {
    text,
    parse_status: inspection.partial ? "partial" : "ready",
    warnings,
    format_metrics: {
      embedded_images: extractedImages,
      header_footer_parts: inspection.headerFooterCount,
      header_footer_extracted: inspection.headerFooters.length,
      table_count: inspection.tableCount,
      table_rows: inspection.tableRowCount,
      merged_table_cells: inspection.mergedTableCellCount,
      footnotes_extracted: inspection.footnotes ? 1 : 0,
      endnotes_extracted: inspection.endnotes ? 1 : 0,
      docx_inspection_ms: inspectionMs,
      docx_asset_setup_ms: assetSetupMs,
      docx_mammoth_convert_ms: mammothConvertMs,
      docx_html_to_markdown_ms: markdownConvertMs,
      docx_extract_ms: Math.round(performance.now() - extractionStartedAt),
    },
    is_image: false,
    is_spreadsheet: false,
  };
}

/**
 * Legacy Word .doc is an OLE binary format, not a renamed DOCX archive.  This
 * intentionally extracts only its body text.  It must not imply that tables,
 * fields, links, drawings, or layout have been faithfully reconstructed.
 */
async function extractLegacyDoc(bytes: Buffer): Promise<ExtractedUploadedSource> {
  const extractionStartedAt = performance.now();
  const document = await new WordExtractor().extract(bytes);
  const text = document.getBody({ filterUnicode: false })
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) {
    return {
      text: "",
      parse_status: "failed",
      warnings: [warning("legacy_doc_no_body_text", "旧版 DOC 可打开，但未提取到可用正文文字。")],
      format_metrics: { legacy_doc_extract_ms: Math.round(performance.now() - extractionStartedAt) },
      is_image: false,
      is_spreadsheet: false,
    };
  }
  return {
    text,
    // "ready" means the promised text-only extraction finished.  The warning
    // prevents consumers from mistaking that result for DOCX-level fidelity.
    parse_status: "ready",
    warnings: [warning("legacy_doc_text_only", "旧版 DOC 已提取正文纯文本；未保证表格、页眉页脚、脚注、超链接、图片、OLE 与版式结构。")],
    format_metrics: {
      legacy_doc_body_characters: text.length,
      legacy_doc_extract_ms: Math.round(performance.now() - extractionStartedAt),
    },
    is_image: false,
    is_spreadsheet: false,
  };
}

function slideNumber(name: string) { return Number.parseInt(name.match(/slide(\d+)\.xml$/)?.[1] ?? "0", 10); }

async function extractPptx(bytes: Buffer): Promise<ExtractedUploadedSource> {
  const archive = await JSZip.loadAsync(bytes);
  const names = Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => slideNumber(a) - slideNumber(b));
  const warnings = [] as ReturnType<typeof warning>[];
  const slides: string[] = [];
  for (let index = 0; index < names.length; index += 1) {
    try {
      const xml = await archive.file(names[index])!.async("string");
      const text = [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map((p) => [...p[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((t) => decodeXml(t[1])).join("")).filter(Boolean).join("\n");
      slides.push(`# Slide ${index + 1}${text ? `\n${text}` : ""}`);
    } catch {
      warnings.push(warning("slide_parse_failed", `第 ${index + 1} 张幻灯片无法读取。`, [`slide:${index + 1}`]));
    }
  }
  return { text: slides.join("\n\n"), parse_status: warnings.length ? "partial" : "ready", warnings, format_metrics: { total_slides: names.length, parsed_slides: names.length - warnings.length }, is_image: false, is_spreadsheet: false };
}

function meaningfulCharacterCount(value: string) {
  return value.replace(/\s/gu, "").length;
}

/**
 * Tesseract v7 cannot reliably initialize chi_sim+eng together. Prefer the
 * page's native text as a deterministic hint; image-only pages retain the
 * Chinese-first default used by the application.
 */
export function selectPdfOcrLanguage(nativeText: string): "chi_sim" | "eng" {
  const chineseCharacters = (nativeText.match(/[\u3400-\u9fff]/gu) ?? []).length;
  const latinCharacters = (nativeText.match(/[A-Za-z]/gu) ?? []).length;
  return latinCharacters > chineseCharacters * 2 ? "eng" : "chi_sim";
}

function pageHasEmbeddedImage(operatorList: { fnArray: number[] }, ops: Record<string, number>) {
  const imageOperators = [
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
    ops.paintSolidColorImageMask,
  ].filter((value): value is number => Number.isInteger(value));
  return operatorList.fnArray.some((operator) => imageOperators.includes(operator));
}

function pageHasTextDrawingOperations(operatorList: { fnArray: number[] }, ops: Record<string, number>) {
  const textOperators = [
    ops.showText,
    ops.showSpacedText,
    ops.nextLineShowText,
    ops.nextLineSetSpacingShowText,
  ].filter((value): value is number => Number.isInteger(value));
  return operatorList.fnArray.some((operator) => textOperators.includes(operator));
}

async function renderPdfPage(page: any) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const initialScale = PDF_OCR_LIMITS.renderDpi / 72;
  const initialViewport = page.getViewport({ scale: initialScale });
  const pixelCount = initialViewport.width * initialViewport.height;
  const scale = pixelCount > PDF_OCR_LIMITS.maxRenderedPixels
    ? initialScale * Math.sqrt(PDF_OCR_LIMITS.maxRenderedPixels / pixelCount)
    : initialScale;
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
  // Passing the context directly bypasses PDF.js' Node canvas creation path,
  // whose optional 2D-context attributes are not supported by all canvas builds.
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas.toBuffer("image/png");
}

function renderPdfPageText(number: number, nativeText: string, ocrText: string) {
  const sections = [`# Page ${number}`];
  if (nativeText) sections.push(`## Native text\n\n${nativeText}`);
  if (ocrText) sections.push(`## OCR text\n\n${ocrText}`);
  return sections.join("\n\n");
}

async function extractPdf(
  filePath: string,
  bytes: Buffer,
  options: UploadedSourceExtractionOptions,
): Promise<ExtractedUploadedSource> {
  const extractionStartedAt = performance.now();
  await options.on_pdf_ocr_stage?.({ stage: "opening_pdf", page_number: null });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    ...resolvePdfJsResourceDirectories(),
  }).promise;
  const warnings = [] as ReturnType<typeof warning>[];
  const pages: string[] = [];
  const candidatePages: Array<{ number: number; page: Awaited<ReturnType<typeof document.getPage>>; nativeText: string }> = [];
  let parsedPages = 0;
  let embeddedImagePages = 0;
  let textDrawingPages = 0;

  await options.on_pdf_ocr_stage?.({ stage: "scanning_pages", page_number: null });
  for (let number = 1; number <= document.numPages; number += 1) {
    try {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const nativeText = content.items.map((item) => "str" in item ? item.str : "").filter(Boolean).join(" ").trim();
      const operatorList = await page.getOperatorList();
      const operators = pdfjs.OPS as Record<string, number>;
      const hasEmbeddedImage = pageHasEmbeddedImage(operatorList, operators);
      const hasTextDrawingOperations = pageHasTextDrawingOperations(operatorList, operators);
      if (hasEmbeddedImage) embeddedImagePages += 1;
      if (hasTextDrawingOperations) textDrawingPages += 1;
      const nativeCharacterCount = meaningfulCharacterCount(nativeText);
      // Do not spend an OCR pass on a genuinely blank page. Pages with an
      // image, a tiny native-text layer, or PDF text operators that failed to
      // decode can still contain visual text and remain OCR candidates.
      const needsVisualOcr = hasEmbeddedImage
        || (nativeCharacterCount > 0 && nativeCharacterCount < PDF_NEAR_ZERO_TEXT_CHARACTERS)
        || (nativeCharacterCount === 0 && hasTextDrawingOperations);
      if (needsVisualOcr) {
        candidatePages.push({ number, page, nativeText });
      } else {
        pages.push(renderPdfPageText(number, nativeText, ""));
      }
      parsedPages += 1;
    } catch {
      // A malformed page must not stop attachment processing for readable pages.
      warnings.push(warning("page_parse_failed", `第 ${number} 页无法读取；已继续处理其余页面。`, [`page:${number}`]));
      pages.push(renderPdfPageText(number, "", ""));
    }
  }

  const persistedPages = new Map(options.pdf_ocr_page_results ?? new Map());
  const terminalPageCount = () => [...persistedPages.values()]
    .filter((result) => result.status === "completed" || result.status === "failed" || result.status === "skipped").length;
  const completedPageCount = () => [...persistedPages.values()].filter((result) => result.status === "completed").length;
  const failedPageCount = () => [...persistedPages.values()].filter((result) => result.status === "failed").length;
  const skippedPageCount = () => [...persistedPages.values()].filter((result) => result.status === "skipped").length;
  const initialProgress: PdfOcrProgress = {
    total_pages: document.numPages,
    candidate_pages: candidatePages.length,
    processed_pages: terminalPageCount(),
    completed_pages: completedPageCount(),
    failed_pages: failedPageCount(),
    current_page: null,
  };
  if (options.defer_pdf_ocr) {
    for (const candidate of candidatePages) pages.push(renderPdfPageText(candidate.number, candidate.nativeText, ""));
    await document.destroy();
    return {
      text: pages.sort((left, right) => Number.parseInt(left.match(/^# Page (\d+)/m)?.[1] ?? "0", 10) - Number.parseInt(right.match(/^# Page (\d+)/m)?.[1] ?? "0", 10)).join("\n\n"),
      parse_status: "ready",
      warnings,
      format_metrics: {
        total_pages: document.numPages,
        parsed_pages: parsedPages,
        embedded_image_pages: embeddedImagePages,
        ocr_candidate_pages: candidatePages.length,
        ocr_attempted_pages: 0,
        ocr_completed_pages: 0,
        ocr_empty_pages: 0,
        ocr_failed_pages: 0,
        ocr_skipped_pages: 0,
        ocr_detected_pages: 0,
        ocr_extract_ms: 0,
        pdf_extract_ms: Math.round(performance.now() - extractionStartedAt),
      },
      is_image: false,
      is_spreadsheet: false,
      pdf_ocr_deferred: candidatePages.length > 0,
    };
  }

  let ocrAttemptedPages = completedPageCount() + failedPageCount();
  let ocrCompletedPages = completedPageCount();
  let ocrEmptyPages = 0;
  let ocrFailedPages = failedPageCount();
  let ocrProcessedPages = terminalPageCount();
  let ocrProcessedInThisCall = 0;
  let ocrEngine = options.pdf_ocr_engine;
  const ocrStartedAt = performance.now();
  const requestForCandidate = (candidate: (typeof candidatePages)[number]): PdfOcrPageRequest => ({
    page_number: candidate.number,
    native_text: candidate.nativeText,
    language: selectPdfOcrLanguage(candidate.nativeText),
  });
  const persistPageResult = async (result: PdfOcrPageResult) => {
    persistedPages.set(result.page_number, result);
    await options.on_pdf_ocr_page?.(result);
  };
  const refreshCounters = () => {
    ocrAttemptedPages = completedPageCount() + failedPageCount();
    ocrCompletedPages = completedPageCount();
    ocrEmptyPages = [...persistedPages.values()].filter((result) => result.status === "completed" && !result.ocr_text).length;
    ocrFailedPages = failedPageCount();
    ocrProcessedPages = terminalPageCount();
  };
  const reportProgress = async (currentPage: number | null) => {
    refreshCounters();
    await options.on_pdf_ocr_progress?.({
      total_pages: document.numPages,
      candidate_pages: candidatePages.length,
      processed_pages: ocrProcessedPages,
      completed_pages: ocrCompletedPages,
      failed_pages: ocrFailedPages,
      current_page: currentPage,
    });
  };
  try {
    await options.on_pdf_ocr_progress?.(initialProgress);
    ocrEngine ??= new TesseractPdfOcrEngine();
    if (ocrEngine.detectPdfPages && ocrEngine.recognizePdfPages) {
      const detectionCandidates = candidatePages
        .filter((candidate) => !persistedPages.has(candidate.number))
        .slice(0, options.pdf_ocr_detection_page_limit ?? candidatePages.length);
      if (detectionCandidates.length > 0) {
        await reportProgress(detectionCandidates[0].number);
        await options.on_pdf_ocr_stage?.({ stage: "detecting_pages", page_number: detectionCandidates[0].number });
        const requests = detectionCandidates.map(requestForCandidate);
        let detections;
        try {
          detections = await ocrEngine.detectPdfPages(filePath, requests, PDF_OCR_LIMITS.detectionBatchTimeoutMs);
        } catch {
          // Text detection only avoids unnecessary recognition. A failed
          // detection batch must fall back to OCR rather than drop content.
          detections = requests.map((request) => ({ page_number: request.page_number, has_visual_text: true }));
        }
        const detectionsByPage = new Map(detections.map((result) => [result.page_number, result]));
        for (const candidate of detectionCandidates) {
          const hasVisualText = detectionsByPage.get(candidate.number)?.has_visual_text ?? true;
          await persistPageResult({
            page_number: candidate.number,
            native_text: candidate.nativeText,
            ocr_text: "",
            status: hasVisualText ? "detected" : "skipped",
          });
        }
        await reportProgress(null);
      }

      const recognitionCandidates = candidatePages
        .filter((candidate) => persistedPages.get(candidate.number)?.status === "detected")
        .slice(0, options.pdf_ocr_page_limit ?? candidatePages.length);
      if (recognitionCandidates.length > 0) {
        await reportProgress(recognitionCandidates[0].number);
        await options.on_pdf_ocr_stage?.({ stage: "recognizing_page", page_number: recognitionCandidates[0].number });
        const requests = recognitionCandidates.map(requestForCandidate);
        let results: PdfOcrBatchResult[];
        try {
          results = await ocrEngine.recognizePdfPages(
            filePath,
            requests,
            PDF_OCR_LIMITS.pageTimeoutMs * requests.length + PDF_OCR_LIMITS.batchStartupGraceMs,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results = requests.map((request) => ({
            page_number: request.page_number,
            text: "",
            confidence: null,
            error: message,
          }));
        }
        const resultsByPage = new Map(results.map((result) => [result.page_number, result]));
        for (const candidate of recognitionCandidates) {
          const result = resultsByPage.get(candidate.number);
          await options.on_pdf_ocr_stage?.({ stage: "persisting_page", page_number: candidate.number });
          await persistPageResult({
            page_number: candidate.number,
            native_text: candidate.nativeText,
            ocr_text: result?.text ?? "",
            status: result?.error ? "failed" : "completed",
            ...(result?.error ? { error: result.error } : {}),
          });
        }
        await reportProgress(null);
      }
    } else {
    for (const candidate of candidatePages) {
      const persisted = persistedPages.get(candidate.number);
      if (persisted) {
        if (persisted.status === "failed") {
          warnings.push(warning("ocr_page_failed", `第 ${candidate.number} 页 OCR 曾未完成；已保留可提取的原生文字。`, [`page:${candidate.number}`]));
          pages.push(renderPdfPageText(candidate.number, candidate.nativeText, ""));
          continue;
        }
        if (!persisted.ocr_text) ocrEmptyPages += 1;
        pages.push(renderPdfPageText(candidate.number, candidate.nativeText, persisted.ocr_text));
        if (persisted.ocr_text) warnings.push(warning("ocr_applied", `第 ${candidate.number} 页已恢复已持久化的 OCR 结果。`, [`page:${candidate.number}`]));
        else warnings.push(warning("ocr_no_text_detected", `第 ${candidate.number} 页已恢复已持久化的空 OCR 结果。`, [`page:${candidate.number}`]));
        continue;
      }
      if (options.pdf_ocr_page_limit !== undefined && ocrProcessedInThisCall >= options.pdf_ocr_page_limit) {
        pages.push(renderPdfPageText(candidate.number, candidate.nativeText, ""));
        continue;
      }
      await options.on_pdf_ocr_progress?.({
        ...initialProgress,
        processed_pages: ocrProcessedPages,
        completed_pages: ocrCompletedPages,
        failed_pages: ocrFailedPages,
        current_page: candidate.number,
      });
      ocrEngine ??= new TesseractPdfOcrEngine();
      ocrAttemptedPages += 1;
      try {
        const language = selectPdfOcrLanguage(candidate.nativeText);
        await options.on_pdf_ocr_stage?.({ stage: "rendering_page", page_number: candidate.number });
        // PDF.js' page.render() can stall only when it runs inside the
        // long-lived Executa process. The production engine receives the file
        // path and performs both rasterization and OCR in its child process.
        // Retain the rasterized-image seam for deterministic unit tests and
        // future engines that explicitly implement only recognizePage().
        const result = ocrEngine.recognizePdfPage
          ? await ocrEngine.recognizePdfPage(
            filePath,
            candidate.number,
            PDF_OCR_LIMITS.pageTimeoutMs,
            language,
          )
          : await (async () => {
            if (!ocrEngine.recognizePage) throw new Error("PDF OCR engine does not implement a recognition method.");
            const image = await renderPdfPage(candidate.page);
            await options.on_pdf_ocr_stage?.({ stage: "recognizing_page", page_number: candidate.number });
            return ocrEngine.recognizePage(image, PDF_OCR_LIMITS.pageTimeoutMs, language);
          })();
        ocrCompletedPages += 1;
        if (!result.text) {
          ocrEmptyPages += 1;
          // An empty image or a logo is a valid OCR result, not a parse failure.
          warnings.push(warning("ocr_no_text_detected", `第 ${candidate.number} 页已完成 OCR，但未识别到文字。`, [`page:${candidate.number}`]));
        } else {
          warnings.push(warning("ocr_applied", `第 ${candidate.number} 页已执行 OCR。`, [`page:${candidate.number}`]));
          if (result.confidence !== null && result.confidence < 40) {
            warnings.push(warning("ocr_low_confidence", `第 ${candidate.number} 页 OCR 置信度较低（${Math.round(result.confidence)}%）；已保留识别文字供后续使用。`, [`page:${candidate.number}`]));
          }
        }
        pages.push(renderPdfPageText(candidate.number, candidate.nativeText, result.text));
        await options.on_pdf_ocr_stage?.({ stage: "persisting_page", page_number: candidate.number });
        await options.on_pdf_ocr_page?.({
          page_number: candidate.number,
          native_text: candidate.nativeText,
          ocr_text: result.text,
          status: "completed",
        });
        persistedPages.set(candidate.number, {
          page_number: candidate.number,
          native_text: candidate.nativeText,
          ocr_text: result.text,
          status: "completed",
        });
      } catch (error) {
        ocrFailedPages += 1;
        const code = error instanceof PdfOcrTimeoutError ? "ocr_page_timeout" : "ocr_page_failed";
        const detail = error instanceof Error && error.message ? ` 原因：${error.message}` : "";
        const message = code === "ocr_page_timeout"
          ? `第 ${candidate.number} 页 OCR 超时；已保留可提取的原生文字。`
          : `第 ${candidate.number} 页 OCR 未完成；已保留可提取的原生文字。${detail}`;
        warnings.push(warning(code, message, [`page:${candidate.number}`]));
        pages.push(renderPdfPageText(candidate.number, candidate.nativeText, ""));
        await options.on_pdf_ocr_page?.({
          page_number: candidate.number,
          native_text: candidate.nativeText,
          ocr_text: "",
          status: "failed",
        });
        persistedPages.set(candidate.number, {
          page_number: candidate.number,
          native_text: candidate.nativeText,
          ocr_text: "",
          status: "failed",
        });
      }
      ocrProcessedPages += 1;
      ocrProcessedInThisCall += 1;
      await options.on_pdf_ocr_progress?.({
        ...initialProgress,
        processed_pages: ocrProcessedPages,
        completed_pages: ocrCompletedPages,
        failed_pages: ocrFailedPages,
        current_page: null,
      });
    }
    }
    if (ocrEngine.detectPdfPages && ocrEngine.recognizePdfPages) {
      refreshCounters();
      for (const candidate of candidatePages) {
        const persisted = persistedPages.get(candidate.number);
        if (persisted?.status === "failed") {
          warnings.push(warning("ocr_page_failed", `第 ${candidate.number} 页 OCR 未完成；已保留可提取的原生文字。`, [`page:${candidate.number}`]));
        } else if (persisted?.status === "completed") {
          if (persisted.ocr_text) {
            warnings.push(warning("ocr_applied", `第 ${candidate.number} 页已执行 OCR。`, [`page:${candidate.number}`]));
          } else {
            warnings.push(warning("ocr_no_text_detected", `第 ${candidate.number} 页已完成 OCR，但未识别到文字。`, [`page:${candidate.number}`]));
          }
        }
        pages.push(renderPdfPageText(
          candidate.number,
          candidate.nativeText,
          persisted?.status === "completed" ? persisted.ocr_text : "",
        ));
      }
    }
  } finally {
    await ocrEngine?.dispose?.();
    await document.destroy();
  }

  pages.sort((left, right) => Number.parseInt(left.match(/^# Page (\d+)/m)?.[1] ?? "0", 10) - Number.parseInt(right.match(/^# Page (\d+)/m)?.[1] ?? "0", 10));
  const text = pages.join("\n\n");
  const plainText = text.replace(/^# Page \d+\s*$/gm, "").replace(/^## (?:Native|OCR) text\s*$/gm, "").trim();
  const nativeTextExtractionSuspicious = !plainText && textDrawingPages > 0;
  if (nativeTextExtractionSuspicious) {
    warnings.push(warning(
      "pdf_text_extraction_incomplete",
      "PDF 页面包含文字绘制命令，但未提取到可读文字；其字体编码或字符映射可能不受支持。",
    ));
  }
  if (!plainText) warnings.push(warning("pdf_no_readable_text", "PDF 已成功读取，但未提取到文字；其中可能仅包含空白页或无文字图片。"));
  return {
    text,
    // A genuinely blank/image-only PDF remains usable. Text-drawing operations
    // without recoverable text are a quality gap, not a clean read.
    parse_status: nativeTextExtractionSuspicious ? "partial" : "ready",
    warnings,
    format_metrics: {
      total_pages: document.numPages,
      parsed_pages: parsedPages,
      embedded_image_pages: embeddedImagePages,
      text_drawing_pages: textDrawingPages,
      ocr_candidate_pages: candidatePages.length,
      ocr_attempted_pages: ocrAttemptedPages,
      ocr_completed_pages: ocrCompletedPages,
      ocr_empty_pages: ocrEmptyPages,
      ocr_failed_pages: ocrFailedPages,
      ocr_skipped_pages: skippedPageCount(),
      ocr_detected_pages: [...persistedPages.values()].filter((result) => result.status === "detected").length,
      ocr_extract_ms: Math.round(performance.now() - ocrStartedAt),
      pdf_extract_ms: Math.round(performance.now() - extractionStartedAt),
    },
    is_image: false,
    is_spreadsheet: false,
    pdf_ocr_pending: candidatePages.some((candidate) => {
      const status = persistedPages.get(candidate.number)?.status;
      return !status || status === "detected";
    }),
  };
}

const SPREADSHEET_ROWS_PER_BLOCK = 200;

interface SpreadsheetCellValue {
  address: string;
  row: number;
  column: number;
  value: string;
  formulaWithoutCachedValue: boolean;
}

function isSpreadsheetCell(value: unknown): value is XLSX.CellObject {
  return value !== null && typeof value === "object" && ("v" in value || "f" in value);
}

function hasFormulaWithoutCachedValue(cell: XLSX.CellObject) {
  return Boolean(cell.f && (cell.v === undefined || cell.v === null || cell.t === "z"));
}

function spreadsheetCellDisplay(cell: XLSX.CellObject) {
  if (hasFormulaWithoutCachedValue(cell)) return `=${cell.f} [无缓存值]`;
  if (typeof cell.w === "string" && cell.w.trim()) return cell.w.trim();
  if (cell.v !== undefined && cell.v !== null) return String(cell.v).trim();
  return "";
}

function getSpreadsheetCells(sheet: XLSX.WorkSheet) {
  const cells: SpreadsheetCellValue[] = [];
  for (const [address, value] of Object.entries(sheet)) {
    if (address.startsWith("!") || !isSpreadsheetCell(value)) continue;
    const display = spreadsheetCellDisplay(value);
    if (!display) continue;
    const position = XLSX.utils.decode_cell(address);
    cells.push({
      address,
      row: position.r + 1,
      column: position.c + 1,
      value: display.replace(/\r?\n/g, " / ").replace(/\s{2,}/g, " "),
      formulaWithoutCachedValue: hasFormulaWithoutCachedValue(value),
    });
  }
  return cells.sort((left, right) => left.row - right.row || left.column - right.column);
}

function hasStoredSpreadsheetContent(sheet: XLSX.WorkSheet) {
  return Object.entries(sheet).some(([address, value]) => {
    if (address.startsWith("!") || !isSpreadsheetCell(value)) return false;
    if (value.f) return true;
    if (typeof value.v === "string") return value.v.trim().length > 0;
    return value.v !== undefined && value.v !== null;
  });
}

function spreadsheetSheetVisibility(workbook: XLSX.WorkBook, index: number) {
  const hidden = workbook.Workbook?.Sheets?.[index]?.Hidden ?? 0;
  return hidden === 0 ? "visible" : hidden === 2 ? "very_hidden" : "hidden";
}

function spreadsheetColumns(cells: SpreadsheetCellValue[]) {
  const headerRow = cells[0]?.row;
  const headers = new Map<number, string>();
  for (const cell of cells) {
    if (cell.row !== headerRow) break;
    headers.set(cell.column, cell.value);
  }
  const columns = [...new Set(cells.map((cell) => cell.column))].sort((left, right) => left - right);
  return {
    headerRow,
    labels: columns.map((column) => ({
      column,
      label: headers.get(column) || XLSX.utils.encode_col(column - 1),
    })),
  };
}

function renderSpreadsheetSheet(name: string, sheet: XLSX.WorkSheet) {
  const cells = getSpreadsheetCells(sheet);
  if (cells.length === 0) return { text: "", cells, formulaWithoutCachedValues: [] as string[], mergedCells: 0, rowCount: 0, columnCount: 0 };
  const rows = new Map<number, SpreadsheetCellValue[]>();
  for (const cell of cells) {
    const row = rows.get(cell.row) ?? [];
    row.push(cell);
    rows.set(cell.row, row);
  }
  const orderedRows = [...rows.entries()].sort(([left], [right]) => left - right);
  const columns = spreadsheetColumns(cells);
  const range = sheet["!ref"] ?? `${cells[0].address}:${cells.at(-1)!.address}`;
  const mergedRanges = Array.isArray(sheet["!merges"])
    ? sheet["!merges"].map((entry) => XLSX.utils.encode_range(entry)).length
    : 0;
  const formulaWithoutCachedValues = cells.filter((cell) => cell.formulaWithoutCachedValue).map((cell) => `${name}!${cell.address}`);
  const blocks: string[] = [];
  for (let start = 0; start < orderedRows.length; start += SPREADSHEET_ROWS_PER_BLOCK) {
    const blockRows = orderedRows.slice(start, start + SPREADSHEET_ROWS_PER_BLOCK);
    const firstRow = blockRows[0][0];
    const lastRow = blockRows.at(-1)![0];
    const lines = [
      start === 0 ? `# Sheet: ${name}` : "",
      start === 0 ? `Range: ${range}` : "",
      start === 0 && mergedRanges > 0 ? `Merged cells: ${mergedRanges}` : "",
      `## Rows: ${firstRow}-${lastRow}`,
      `Columns: ${columns.labels.map((column) => `${XLSX.utils.encode_col(column.column - 1)} = ${column.label}`).join(" | ")}`,
      ...blockRows.map(([rowNumber, rowCells]) => {
        const lastColumn = Math.max(...rowCells.map((cell) => cell.column));
        const sourceRange = `${XLSX.utils.encode_cell({ r: rowNumber - 1, c: 0 })}:${XLSX.utils.encode_cell({ r: rowNumber - 1, c: lastColumn - 1 })}`;
        return `[Row ${rowNumber} | ${sourceRange}] ${rowCells.map((cell) => `${XLSX.utils.encode_col(cell.column - 1)}: ${cell.value}`).join(" | ")}`;
      }),
    ].filter(Boolean);
    blocks.push(lines.join("\n"));
  }
  return {
    text: blocks.join("\n\n"),
    cells,
    formulaWithoutCachedValues,
    mergedCells: mergedRanges,
    rowCount: orderedRows.length,
    columnCount: columns.labels.length,
  };
}

async function inspectXlsxPackageContent(bytes: Buffer) {
  const archive = await JSZip.loadAsync(bytes);
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  return {
    embeddedImages: entries.filter((entry) => /^xl\/media\//i.test(entry.name)).length,
    charts: entries.filter((entry) => /^xl\/charts\//i.test(entry.name)).length,
    pivotTables: entries.filter((entry) => /^xl\/pivotTables\//i.test(entry.name)).length,
    powerPivotModels: entries.filter((entry) => /^xl\/model\/item\.data$/i.test(entry.name)).length,
  };
}

async function extractSpreadsheet(bytes: Buffer, extension: string): Promise<ExtractedUploadedSource> {
  const workbook = XLSX.read(bytes, {
    type: "buffer",
    cellText: true,
    cellFormula: true,
    // Retain formula cells that have no cached result in the workbook file.
    sheetStubs: true,
    // CSV values such as 2026-01 are identifiers in many business sheets;
    // preserve their source text instead of letting SheetJS coerce them to dates.
    raw: extension === ".csv",
  });
  const warnings = [] as ReturnType<typeof warning>[];
  const chunks: string[] = [];
  let nonEmpty = 0;
  let parsedSheets = 0;
  let hiddenSheets = 0;
  let mergedCells = 0;
  let formulaWithoutCachedValues = 0;
  let visibleRows = 0;
  let visibleColumns = 0;
  for (const [index, name] of workbook.SheetNames.entries()) {
    const visibility = spreadsheetSheetVisibility(workbook, index);
    if (visibility !== "visible") {
      hiddenSheets += 1;
      warnings.push(warning("hidden_sheet_excluded", `工作表 ${name} 处于${visibility === "very_hidden" ? "非常隐藏" : "隐藏"}状态，未纳入附件上下文。`, [`sheet:${name}`]));
      continue;
    }
    try {
      const rendered = renderSpreadsheetSheet(name, workbook.Sheets[name]);
      if (!rendered.text) {
        const isEmpty = !hasStoredSpreadsheetContent(workbook.Sheets[name]);
        warnings.push(warning(
          isEmpty ? "sheet_empty_excluded" : "sheet_no_readable_cells",
          isEmpty ? `工作表 ${name} 为空，未纳入附件上下文。` : `工作表 ${name} 含有内容但未提取到可用单元格。`,
          [`sheet:${name}`],
        ));
        continue;
      }
      parsedSheets += 1;
      nonEmpty += rendered.cells.length;
      mergedCells += rendered.mergedCells;
      formulaWithoutCachedValues += rendered.formulaWithoutCachedValues.length;
      visibleRows += rendered.rowCount;
      visibleColumns = Math.max(visibleColumns, rendered.columnCount);
      if (rendered.formulaWithoutCachedValues.length > 0) {
        warnings.push(warning(
          "formula_value_unavailable",
          `工作表 ${name} 有 ${rendered.formulaWithoutCachedValues.length} 个公式未保存可用计算结果；本轮不重新计算公式。`,
          rendered.formulaWithoutCachedValues.slice(0, 50),
        ));
      }
      chunks.push(rendered.text);
    } catch {
      warnings.push(warning("sheet_parse_failed", `工作表 ${name} 无法读取。`, [`sheet:${name}`]));
    }
  }
  if (extension === ".xlsx") {
    try {
      const packageContent = await inspectXlsxPackageContent(bytes);
      const { embeddedImages, charts, pivotTables, powerPivotModels } = packageContent;
      if (embeddedImages > 0 || charts > 0) {
        warnings.push(warning(
          "visual_content_needs_ocr",
          `工作簿包含 ${embeddedImages} 个嵌入图片和 ${charts} 个图表；当前仅提取单元格数据，视觉内容需要 OCR 或视觉分析。`,
          ["workbook:visual-content"],
        ));
      }
      if (pivotTables > 0 || powerPivotModels > 0) {
        warnings.push(warning(
          "pivot_content_not_extracted",
          `工作簿包含 ${pivotTables} 个透视表定义和 ${powerPivotModels} 个 Power Pivot 数据模型；当前仅提取工作表中已缓存的单元格值，未读取透视计算或模型数据。`,
          ["workbook:pivot-content"],
        ));
      }
      if (chunks.length === 0 && (embeddedImages > 0 || charts > 0)) {
        warnings.push(warning("spreadsheet_no_readable_cells", "工作簿只有视觉内容，当前没有可用于附件上下文的单元格文本。", ["workbook:cells"]));
      }
      return {
        text: chunks.join("\n\n"),
        parse_status: chunks.length === 0 ? "failed" : warnings.length > 0 ? "partial" : "ready",
        warnings,
        format_metrics: {
          total_sheets: workbook.SheetNames.length - hiddenSheets,
          parsed_sheets: parsedSheets,
          hidden_sheets: hiddenSheets,
          non_empty_cells: nonEmpty,
          merged_cells: mergedCells,
          formula_values_unavailable: formulaWithoutCachedValues,
          visible_rows: visibleRows,
          visible_columns: visibleColumns,
          embedded_images: embeddedImages,
          charts,
          pivot_tables: pivotTables,
          power_pivot_models: powerPivotModels,
        },
        is_image: false,
        is_spreadsheet: true,
      };
    } catch {
      warnings.push(warning("xlsx_visual_content_unread", "XLSX 的图片或图表目录无法完整检查；已继续读取可用单元格数据。", ["workbook:visual-content"]));
    }
  }
  return {
    text: chunks.join("\n\n"),
    parse_status: chunks.length === 0 ? "failed" : warnings.length > 0 ? "partial" : "ready",
    warnings,
    format_metrics: {
      total_sheets: workbook.SheetNames.length - hiddenSheets,
      parsed_sheets: parsedSheets,
      hidden_sheets: hiddenSheets,
      non_empty_cells: nonEmpty,
      merged_cells: mergedCells,
      formula_values_unavailable: formulaWithoutCachedValues,
      visible_rows: visibleRows,
      visible_columns: visibleColumns,
    },
    is_image: false,
    is_spreadsheet: true,
  };
}

async function extractImage(bytes: Buffer, extension: string): Promise<ExtractedUploadedSource> {
  const metadata = await sharp(bytes, { animated: extension === ".gif", failOn: "none" }).metadata();
  const formatMetrics: Record<string, number> = { width: metadata.width ?? 0, height: metadata.height ?? 0 };
  if (extension === ".gif") formatMetrics.frame_count = metadata.pages ?? 1;
  const partial = Boolean(metadata.pages && metadata.pageHeight && metadata.height && metadata.height % metadata.pageHeight !== 0);
  return { text: "", parse_status: partial ? "partial" : "ready", warnings: partial ? [warning("image_partial", "图片部分帧无法完整读取。")]: [], format_metrics: formatMetrics, is_image: true, is_spreadsheet: false };
}

export async function extractUploadedSource(filePath: string, extension: string, options: UploadedSourceExtractionOptions = {}): Promise<ExtractedUploadedSource> {
  const normalized = extension.toLowerCase();
  const sourceReadStartedAt = performance.now();
  const bytes = await readFile(filePath);
  const sourceReadMs = Math.round(performance.now() - sourceReadStartedAt);
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(normalized)) return extractImage(bytes, normalized);
  if ([".txt", ".md"].includes(normalized)) {
    const decoded = decodeText(bytes);
    return { text: decoded.text, parse_status: decoded.warning ? "failed" : "ready", warnings: decoded.warning ? [decoded.warning] : [], format_metrics: {}, is_image: false, is_spreadsheet: false };
  }
  if ([".html", ".htm"].includes(normalized)) {
    const decoded = decodeText(bytes);
    return { text: htmlVisibleText(decoded.text), parse_status: decoded.warning ? "failed" : "ready", warnings: decoded.warning ? [decoded.warning] : [], format_metrics: {}, is_image: false, is_spreadsheet: false };
  }
  if (normalized === ".docx") {
    const extracted = await extractDocx(bytes, options);
    return {
      ...extracted,
      format_metrics: {
        ...extracted.format_metrics,
        docx_file_read_ms: sourceReadMs,
      },
    };
  }
  if (normalized === ".doc") {
    // A DOCX occasionally arrives with a wrong .doc filename.  Preserve the
    // higher-fidelity OOXML path when its ZIP signature makes that unambiguous.
    if (bytes.subarray(0, 2).equals(Buffer.from([0x50, 0x4b]))) {
      const extracted = await extractDocx(bytes, options);
      return {
        ...extracted,
        format_metrics: {
          ...extracted.format_metrics,
          doc_file_read_ms: sourceReadMs,
          legacy_doc_extension_was_ooxml: 1,
        },
      };
    }
    const extracted = await extractLegacyDoc(bytes);
    return {
      ...extracted,
      format_metrics: {
        ...extracted.format_metrics,
        doc_file_read_ms: sourceReadMs,
      },
    };
  }
  if ([".xlsx", ".xls", ".csv"].includes(normalized)) {
    const result = await extractSpreadsheet(bytes, normalized);
    if (normalized === ".csv") {
      const csvWorkbook = XLSX.read(bytes, { type: "buffer", raw: true });
      const first = XLSX.utils.sheet_to_json(csvWorkbook.Sheets[csvWorkbook.SheetNames[0]], { header: 1 }) as unknown[][];
      result.format_metrics = { row_count: first.length, column_count: Math.max(0, ...first.map((row) => row.length)), non_empty_cells: result.format_metrics.non_empty_cells ?? 0 };
    }
    return result;
  }
  if (normalized === ".pptx") return extractPptx(bytes);
  if (normalized === ".pdf") return extractPdf(filePath, bytes, options);
  return { text: "", parse_status: "failed", warnings: [warning("unsupported_format", `不支持的文件格式：${normalized || "无扩展名"}。`)], format_metrics: {}, is_image: false, is_spreadsheet: false };
}
