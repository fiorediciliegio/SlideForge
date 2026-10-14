import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { brotliDecompressSync, inflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { getPptWorkspaceRoot } from "../workspace-root.js";
import {
  buildGoogleStaticCssUrl,
  parseGoogleStaticCssFaces,
} from "../pptx-export/google-static-fonts.js";

// Full CJK faces are commonly larger than the old upload-only 20 MiB limit.
// Downloads still have a hard bound, but must not reject a valid complete
// cloud font merely because it is not a tiny web subset.
export const MANAGED_FONT_MAX_BYTES = 60 * 1024 * 1024;
export const MANAGED_FONT_STYLE_ATTRIBUTE = "data-ppt-editor-fonts";
export const MANAGED_FONT_FAMILY_ATTRIBUTE = "data-ppt-editor-font-family";

export type ManagedFontFormat = "ttf" | "otf" | "woff" | "woff2";
export type ManagedFontVariant = "regular" | "bold" | "italic" | "boldItalic";

export interface ManagedFontVariantFile {
  variant: ManagedFontVariant;
  format: ManagedFontFormat;
  mime_type: string;
  size_bytes: number;
  file_path: string;
  relative_path: string;
  unicode_range?: string;
}

export interface ManagedFontFamily {
  family: string;
  variants: Partial<Record<ManagedFontVariant, ManagedFontVariantFile[]>>;
}

export interface ManagedFontFamilySummary {
  family: string;
  variants: ManagedFontVariant[];
  source: "cloud" | "uploaded";
  /** The complete regular face is already present in the shared .fonts store. */
  cached: boolean;
}

export interface ManagedFontLibraryResult {
  families: ManagedFontFamilySummary[];
}

export interface CommitManagedFontUploadInput {
  workspace_dir: string;
  staging_file_path: string;
  filename: string;
  expected_size_bytes: number;
}

export interface CommitManagedFontUploadResult {
  library: ManagedFontLibraryResult;
  font: ManagedFontFamily;
}

interface StoredFontVariant {
  format: ManagedFontFormat;
  mime_type: string;
  size_bytes: number;
  relative_path: string;
  /** Workspace entries reference an immutable file in the shared .fonts store. */
  storage?: "shared";
  source_url?: string;
  sha256?: string;
  unicode_range?: string;
}

type StoredFontVariantEntry = StoredFontVariant | StoredFontVariant[];

interface StoredFontFamily {
  family: string;
  variants: Partial<Record<ManagedFontVariant, StoredFontVariantEntry>>;
}

interface UsableStoredFontFamily {
  family: string;
  variants: Partial<Record<ManagedFontVariant, StoredFontVariant[]>>;
}

interface StoredFontIndex {
  version: 1;
  families: StoredFontFamily[];
  cloud_font_catalog?: CloudFontCatalog;
}

export interface CloudFontCatalogEntry {
  family: string;
  provider: "google" | "fontsource";
  variants: ManagedFontVariant[];
  source_urls?: Partial<Record<ManagedFontVariant, string>>;
}

interface CloudFontCatalog {
  version: 1;
  entries: CloudFontCatalogEntry[];
}

export interface ParsedFontMetadata {
  family: string;
  variant: ManagedFontVariant;
  format: ManagedFontFormat;
}

const WORKSPACE_ROOT = getPptWorkspaceRoot();
const GLOBAL_FONT_DIR = path.join(WORKSPACE_ROOT, ".fonts");
const GLOBAL_FONT_INDEX_PATH = path.join(GLOBAL_FONT_DIR, "index.json");
const WORKSPACE_FONT_DIRNAME = "fonts";
const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".woff", ".woff2"]);
const MIME_BY_FORMAT: Record<ManagedFontFormat, string> = {
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};
const WOFF2_KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post",
  "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT",
  "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea",
  "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH",
  "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar",
  "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop",
  "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
] as const;
const REMOTE_FONT_TIMEOUT_MS = 20_000;
const REMOTE_FONT_CONCURRENCY = 4;
const cloudFontDownloads = new Map<string, Promise<StoredFontFamily>>();

// This is an allowlist, not a browser fallback list. Every entry has a
// resolver and is downloaded, validated and pinned before it can be applied.
const DEFAULT_CLOUD_FONT_CATALOG: CloudFontCatalog = {
  version: 1,
  entries: [
    "Archivo", "Baloo 2", "Barlow", "Barlow Condensed", "Bangers",
    "Bebas Neue", "Bowlby One", "Caveat", "Comic Neue",
    "Cormorant Garamond", "DM Sans", "DM Serif Display", "EB Garamond",
    "Figtree", "Fraunces", "IBM Plex Mono", "IBM Plex Sans",
    "Instrument Serif", "Inter", "JetBrains Mono", "Luckiest Guy",
    "Manrope", "Noto Sans SC", "Noto Serif SC", "Permanent Marker",
    "Playfair Display", "Plus Jakarta Sans", "Shadows Into Light",
    "Space Grotesk", "Space Mono",
  ].map((family) => ({ family, provider: "google" as const, variants: ["regular"] })),
};
DEFAULT_CLOUD_FONT_CATALOG.entries.splice(6, 0, {
  family: "Ma Shan Zheng",
  provider: "fontsource",
  variants: ["regular"],
  source_urls: {
    regular: "https://cdn.jsdelivr.net/npm/@fontsource/ma-shan-zheng@5.3.1/files/ma-shan-zheng-chinese-simplified-400-normal.woff2",
  },
});
DEFAULT_CLOUD_FONT_CATALOG.entries.splice(7, 0,
  {
    family: "ZCOOL KuaiLe",
    provider: "fontsource",
    variants: ["regular"],
    source_urls: { regular: "https://cdn.jsdelivr.net/npm/@fontsource/zcool-kuaile@5.2.5/files/zcool-kuaile-chinese-simplified-400-normal.woff2" },
  },
  {
    family: "Zhi Mang Xing",
    provider: "fontsource",
    variants: ["regular"],
    source_urls: { regular: "https://cdn.jsdelivr.net/npm/@fontsource/zhi-mang-xing@5.2.5/files/zhi-mang-xing-chinese-simplified-400-normal.woff2" },
  },
  {
    family: "Long Cang",
    provider: "fontsource",
    variants: ["regular"],
    source_urls: { regular: "https://cdn.jsdelivr.net/npm/@fontsource/long-cang@5.2.5/files/long-cang-chinese-simplified-400-normal.woff2" },
  },
  {
    family: "Liu Jian Mao Cao",
    provider: "fontsource",
    variants: ["regular"],
    source_urls: { regular: "https://cdn.jsdelivr.net/npm/@fontsource/liu-jian-mao-cao@5.2.5/files/liu-jian-mao-cao-chinese-simplified-400-normal.woff2" },
  },
);

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function safeFamilyPart(value: string): string {
  const base = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 48) || "font";
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${base}-${suffix}`;
}

function assertWorkspaceDir(workspaceDir: string): string {
  if (!path.isAbsolute(workspaceDir)) throw new Error('"workspace_dir" must be an absolute path');
  const normalized = path.normalize(workspaceDir);
  const relative = path.relative(WORKSPACE_ROOT, normalized);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !/^ppt-\d{8}-\d{6}$/.test(path.basename(normalized))
  ) {
    throw new Error('"workspace_dir" must point to a PPT workspace');
  }
  return normalized;
}

function emptyIndex(): StoredFontIndex {
  return { version: 1, families: [] };
}

async function readIndex(indexPath: string): Promise<StoredFontIndex> {
  try {
    const value = JSON.parse(await readFile(indexPath, "utf8")) as Partial<StoredFontIndex>;
    if (value.version !== 1 || !Array.isArray(value.families)) {
      throw new Error(`Invalid managed font index: ${indexPath}`);
    }
    return value as StoredFontIndex;
  } catch (error) {
    if (isMissingFileError(error)) return emptyIndex();
    throw error;
  }
}

async function writeAtomic(filePath: string, value: string | Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, value);
  await rename(temporaryPath, filePath);
}

function indexDirectory(indexPath: string): string {
  return path.dirname(indexPath);
}

function singleStoredVariant(value: StoredFontVariantEntry | undefined): StoredFontVariant | null {
  // The reverted cloud-font experiment persisted sources as an array so a
  // variant could hold multiple Unicode subsets. The current runtime has one
  // source slot per variant; accepting an array is safe only when it has one
  // source. Multiple files must not be exposed as a false single-font option.
  if (Array.isArray(value)) return value.length === 1 ? value[0] ?? null : null;
  return value ?? null;
}

/**
 * Global-library entries use paths relative to .fonts itself. Workspace
 * entries created before shared storage have no marker and remain relative to
 * that Workspace's fonts/ directory for backwards compatibility.
 */
function storedVariantPath(indexPath: string, stored: StoredFontVariant): string {
  const root = stored.storage === "shared" ? GLOBAL_FONT_DIR : indexDirectory(indexPath);
  return path.join(root, stored.relative_path);
}

function materializeFamily(indexPath: string, family: StoredFontFamily): ManagedFontFamily {
  const variants: ManagedFontFamily["variants"] = {};
  for (const [variant, entry] of Object.entries(family.variants) as Array<[ManagedFontVariant, StoredFontVariantEntry]>) {
    const storedFiles = Array.isArray(entry) ? entry : [entry];
    const files = storedFiles.filter((stored): stored is StoredFontVariant => Boolean(stored)).map((stored) => ({
      variant,
      ...stored,
      file_path: storedVariantPath(indexPath, stored),
    }));
    if (files.length > 0) variants[variant] = files;
  }
  return { family: family.family, variants };
}

function catalogFor(index: StoredFontIndex): CloudFontCatalog {
  const stored = index.cloud_font_catalog?.version === 1 && Array.isArray(index.cloud_font_catalog.entries)
    ? index.cloud_font_catalog.entries
    : [];
  // Existing workspaces have a persisted catalog. Merge, rather than replace
  // it, so newly shipped test fonts appear for those workspaces too while any
  // already-pinned source URLs remain authoritative.
  const entries = new Map(DEFAULT_CLOUD_FONT_CATALOG.entries.map((entry) => [entry.family, entry]));
  for (const entry of stored) {
    if (validCloudEntry(entry)) entries.set(entry.family, entry);
  }
  return { version: 1, entries: [...entries.values()] };
}

function summarize(index: StoredFontIndex): ManagedFontLibraryResult {
  const families = new Map<string, ManagedFontFamilySummary>();
  for (const entry of catalogFor(index).entries) {
    if (!entry.family || !entry.variants.includes("regular")) continue;
    families.set(entry.family, { family: entry.family, variants: [...entry.variants].sort(), source: "cloud", cached: false });
  }
  // Uploaded fonts are also managed fonts. They can be selected only when
  // their regular face survived validation, but do not need a catalog entry.
  for (const family of index.families) {
    if (!Object.hasOwn(family.variants, "regular")) continue;
    const existing = families.get(family.family);
    const variants = (Object.keys(family.variants) as ManagedFontVariant[]).sort();
    families.set(family.family, existing
      ? { ...existing, variants: [...new Set([...existing.variants, ...variants])].sort(), cached: true }
      : { family: family.family, variants, source: "uploaded", cached: true });
  }
  return {
    families: [...families.values()].sort((left, right) => left.family.localeCompare(right.family)),
  };
}

/**
 * The font picker is a promise, not just metadata: do not advertise a family
 * if its normal face is missing, damaged, or no longer matches its index.
 * Validate the global library at read time as files can be removed outside the
 * app after they were originally uploaded.
 */
async function usableStoredVariant(
  indexPath: string,
  family: string,
  variant: ManagedFontVariant,
  stored: StoredFontVariant,
): Promise<boolean> {
  try {
    const filePath = storedVariantPath(indexPath, stored);
    const info = await stat(filePath);
    if (!info.isFile() || info.size !== stored.size_bytes || info.size <= 0 || info.size > MANAGED_FONT_MAX_BYTES) {
      return false;
    }
    const metadata = parseFontMetadata(await readFile(filePath), filePath);
    return metadata.family === family && metadata.variant === variant && metadata.format === stored.format;
  } catch {
    return false;
  }
}

async function usableStoredFamily(
  indexPath: string,
  family: StoredFontFamily,
): Promise<UsableStoredFontFamily | null> {
  const entries = await Promise.all(
    (Object.entries(family.variants) as Array<[ManagedFontVariant, StoredFontVariantEntry]>).map(async ([variant, entry]) => {
      const stored = Array.isArray(entry) ? entry : [entry];
      const usable = stored.length > 0 && (await Promise.all(stored.map((source) => usableStoredVariant(
        indexPath,
        family.family,
        variant,
        source,
      )))).every(Boolean);
      return [
      variant,
      stored,
      usable,
      ] as const;
    }),
  );
  const variants: UsableStoredFontFamily["variants"] = {};
  for (const [variant, stored, usable] of entries) {
    if (usable && stored.length > 0) variants[variant] = stored;
  }
  // Selecting a font-family applies normal text first. A family without a
  // regular face would render through browser fallback and must not be offered.
  return variants.regular ? { family: family.family, variants } : null;
}

function readUInt16(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > buffer.length) throw new Error("Font table is truncated");
  return buffer.readUInt16BE(offset);
}

function readUInt32(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > buffer.length) throw new Error("Font table is truncated");
  return buffer.readUInt32BE(offset);
}

function decodeUtf16Be(buffer: Buffer): string {
  const evenLength = buffer.length - (buffer.length % 2);
  const swapped = Buffer.allocUnsafe(evenLength);
  for (let index = 0; index < evenLength; index += 2) {
    swapped[index] = buffer[index + 1]!;
    swapped[index + 1] = buffer[index]!;
  }
  return swapped.toString("utf16le").replace(/\0/g, "").trim();
}

function decodeNameValue(platformId: number, bytes: Buffer): string {
  if (platformId === 0 || platformId === 3) return decodeUtf16Be(bytes);
  return bytes.toString("latin1").replace(/\0/g, "").trim();
}

function parseNameTable(table: Buffer): { family: string; subfamily: string } {
  if (table.length < 6) throw new Error("Font name table is truncated");
  const count = readUInt16(table, 2);
  const stringOffset = readUInt16(table, 4);
  const records: Array<{
    nameId: number;
    platformId: number;
    languageId: number;
    value: string;
  }> = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 12;
    if (offset + 12 > table.length) break;
    const platformId = readUInt16(table, offset);
    const languageId = readUInt16(table, offset + 4);
    const nameId = readUInt16(table, offset + 6);
    const length = readUInt16(table, offset + 8);
    const valueOffset = stringOffset + readUInt16(table, offset + 10);
    if (valueOffset + length > table.length) continue;
    const value = decodeNameValue(platformId, table.subarray(valueOffset, valueOffset + length));
    if (value) records.push({ nameId, platformId, languageId, value });
  }
  const choose = (ids: number[]): string => {
    for (const nameId of ids) {
      const matches = records.filter((record) => record.nameId === nameId);
      const preferred = matches.find((record) => record.platformId === 3 && record.languageId === 0x0409)
        ?? matches.find((record) => record.platformId === 3)
        ?? matches.find((record) => record.platformId === 0)
        ?? matches[0];
      if (preferred) return preferred.value;
    }
    return "";
  };
  return { family: choose([16, 1]), subfamily: choose([17, 2]) };
}

function sfntTables(buffer: Buffer): Map<string, Buffer> {
  const tables = new Map<string, Buffer>();
  const count = readUInt16(buffer, 4);
  for (let index = 0; index < count; index += 1) {
    const offset = 12 + index * 16;
    if (offset + 16 > buffer.length) throw new Error("Font table directory is truncated");
    const tag = buffer.toString("latin1", offset, offset + 4);
    const tableOffset = readUInt32(buffer, offset + 8);
    const length = readUInt32(buffer, offset + 12);
    if (tableOffset + length > buffer.length) throw new Error(`Font table ${tag} is truncated`);
    tables.set(tag, buffer.subarray(tableOffset, tableOffset + length));
  }
  return tables;
}

function woffTables(buffer: Buffer): Map<string, Buffer> {
  const tables = new Map<string, Buffer>();
  const count = readUInt16(buffer, 12);
  for (let index = 0; index < count; index += 1) {
    const offset = 44 + index * 20;
    if (offset + 20 > buffer.length) throw new Error("WOFF table directory is truncated");
    const tag = buffer.toString("latin1", offset, offset + 4);
    const tableOffset = readUInt32(buffer, offset + 4);
    const compressedLength = readUInt32(buffer, offset + 8);
    const originalLength = readUInt32(buffer, offset + 12);
    if (tableOffset + compressedLength > buffer.length) throw new Error(`WOFF table ${tag} is truncated`);
    const bytes = buffer.subarray(tableOffset, tableOffset + compressedLength);
    const table = compressedLength < originalLength ? inflateSync(bytes) : bytes;
    if (table.length !== originalLength) throw new Error(`WOFF table ${tag} has an invalid length`);
    tables.set(tag, table);
  }
  return tables;
}

function readBase128(buffer: Buffer, cursor: { offset: number }): number {
  let result = 0;
  for (let index = 0; index < 5; index += 1) {
    if (cursor.offset >= buffer.length) throw new Error("WOFF2 table directory is truncated");
    const value = buffer[cursor.offset++]!;
    if (index === 0 && value === 0x80) throw new Error("Invalid WOFF2 UIntBase128 value");
    if ((result & 0xfe000000) !== 0) throw new Error("WOFF2 UIntBase128 overflow");
    result = result * 128 + (value & 0x7f);
    if ((value & 0x80) === 0) return result;
  }
  throw new Error("Invalid WOFF2 UIntBase128 value");
}

function woff2Tables(buffer: Buffer): Map<string, Buffer> {
  const count = readUInt16(buffer, 12);
  const totalCompressedSize = readUInt32(buffer, 20);
  const cursor = { offset: 48 };
  const entries: Array<{ tag: string; transformedLength: number }> = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor.offset >= buffer.length) throw new Error("WOFF2 table directory is truncated");
    const flags = buffer[cursor.offset++]!;
    const tagIndex = flags & 0x3f;
    const transformVersion = flags >>> 6;
    let tag: string;
    if (tagIndex === 0x3f) {
      if (cursor.offset + 4 > buffer.length) throw new Error("WOFF2 custom table tag is truncated");
      tag = buffer.toString("latin1", cursor.offset, cursor.offset + 4);
      cursor.offset += 4;
    } else {
      tag = WOFF2_KNOWN_TAGS[tagIndex] ?? "";
      if (!tag) throw new Error("WOFF2 contains an unknown table tag");
    }
    const originalLength = readBase128(buffer, cursor);
    const transformed =
      ((tag === "glyf" || tag === "loca") && transformVersion === 0) ||
      (tag === "hmtx" && transformVersion === 1);
    const transformedLength = transformed ? readBase128(buffer, cursor) : originalLength;
    entries.push({ tag, transformedLength });
  }
  const compressedEnd = cursor.offset + totalCompressedSize;
  if (compressedEnd > buffer.length) throw new Error("WOFF2 compressed font data is truncated");
  const decompressed = brotliDecompressSync(buffer.subarray(cursor.offset, compressedEnd));
  const tables = new Map<string, Buffer>();
  let tableOffset = 0;
  for (const entry of entries) {
    const end = tableOffset + entry.transformedLength;
    if (end > decompressed.length) throw new Error(`WOFF2 table ${entry.tag} is truncated`);
    tables.set(entry.tag, decompressed.subarray(tableOffset, end));
    tableOffset = end;
  }
  return tables;
}

function detectFontFormat(buffer: Buffer): ManagedFontFormat {
  if (buffer.length < 12) throw new Error("Font file is too small");
  const signature = buffer.toString("latin1", 0, 4);
  if (signature === "OTTO") return "otf";
  if (signature === "wOFF") return "woff";
  if (signature === "wOF2") return "woff2";
  if (buffer.readUInt32BE(0) === 0x00010000 || signature === "true") return "ttf";
  throw new Error("Unsupported or invalid font file");
}

function parseFontMetadata(buffer: Buffer, filename: string): ParsedFontMetadata {
  const extension = path.extname(filename).toLowerCase();
  if (!FONT_EXTENSIONS.has(extension)) {
    throw new Error("Font filename must use .ttf, .otf, .woff, or .woff2");
  }
  const format = detectFontFormat(buffer);
  if (`.${format}` !== extension) {
    throw new Error(`Font content does not match the ${extension} filename extension`);
  }
  const tables = format === "woff"
    ? woffTables(buffer)
    : format === "woff2"
      ? woff2Tables(buffer)
      : sfntTables(buffer);
  for (const required of ["name", "head", "maxp", "cmap"]) {
    if (!tables.has(required)) throw new Error(`Font does not contain a required ${required} table`);
  }
  if (!tables.has("glyf") && !tables.has("CFF ") && !tables.has("CFF2")) {
    throw new Error("Font does not contain a supported outline table");
  }
  const nameTable = tables.get("name");
  if (!nameTable) throw new Error("Font does not contain a readable name table");
  const names = parseNameTable(nameTable);
  const family = names.family.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!family || family.length > 128) throw new Error("Font family name is missing or too long");
  const os2 = tables.get("OS/2");
  const weight = os2 && os2.length >= 6 ? readUInt16(os2, 4) : 400;
  const head = tables.get("head");
  const macStyle = head && head.length >= 46 ? readUInt16(head, 44) : 0;
  const subfamily = names.subfamily.toLowerCase();
  const italic = /italic|oblique/.test(subfamily) || Boolean(macStyle & 0x0002);
  const bold = weight >= 600 || /bold|semibold|demibold|black|heavy/.test(subfamily) || Boolean(macStyle & 0x0001);
  const variant: ManagedFontVariant = bold && italic
    ? "boldItalic"
    : bold
      ? "bold"
      : italic
        ? "italic"
        : "regular";
  return { family, variant, format };
}

export function inspectManagedFontFile(
  buffer: Buffer,
  filename: string,
): ParsedFontMetadata {
  return parseFontMetadata(buffer, filename);
}

function workspaceIndexPath(workspaceDir: string): string {
  return path.join(assertWorkspaceDir(workspaceDir), WORKSPACE_FONT_DIRNAME, "index.json");
}

function referenceSharedVariant(stored: StoredFontVariant): StoredFontVariant {
  return { ...stored, storage: "shared" };
}

function validCloudEntry(value: CloudFontCatalogEntry): boolean {
  return typeof value.family === "string" && value.family.trim().length > 0 &&
    (value.provider === "google" || value.provider === "fontsource") &&
    Array.isArray(value.variants) && value.variants.includes("regular");
}

function extensionForFormat(format: ManagedFontFormat): string {
  return `.${format}`;
}

async function fetchCloudFont(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Cloud font source must use HTTPS");
  if (!/^(fonts\.gstatic\.com|cdn\.jsdelivr\.net)$/i.test(parsed.hostname)) {
    throw new Error(`Cloud font source is not allowlisted: ${parsed.hostname}`);
  }
  const response = await fetch(parsed, {
    headers: { "user-agent": "Mozilla/4.0 (compatible; MSIE 9.0; Windows NT 6.1)" },
    signal: AbortSignal.timeout(REMOTE_FONT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Cloud font download returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MANAGED_FONT_MAX_BYTES) {
    throw new Error(`Cloud font file must be between 1 and ${MANAGED_FONT_MAX_BYTES} bytes`);
  }
  return bytes;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]!, index);
    }
  }));
  return results;
}

async function resolveCloudSources(entry: CloudFontCatalogEntry, variant: ManagedFontVariant): Promise<Array<{ url: string; unicode_range?: string }>> {
  if (entry.provider === "fontsource") {
    const url = entry.source_urls?.[variant];
    if (!url) throw new Error(`No cloud source is registered for ${entry.family} (${variant})`);
    return [{ url }];
  }
  const bold = variant === "bold" || variant === "boldItalic";
  const italic = variant === "italic" || variant === "boldItalic";
  const request = { family: entry.family, weight: bold ? 700 : 400, style: italic ? "italic" : "normal" };
  const cssUrl = buildGoogleStaticCssUrl(request);
  if (!cssUrl) throw new Error(`Could not resolve Google Fonts CSS for ${entry.family}`);
  const response = await fetch(cssUrl, {
    headers: { "user-agent": "Mozilla/4.0 (compatible; MSIE 9.0; Windows NT 6.1)" },
    signal: AbortSignal.timeout(REMOTE_FONT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Google Fonts CSS returned HTTP ${response.status}`);
  const sources = parseGoogleStaticCssFaces(await response.text(), request);
  if (sources.length === 0) throw new Error(`Google Fonts has no regular source for ${entry.family}`);
  return sources.map(({ url, unicodeRange }) => ({ url, unicode_range: unicodeRange }));
}

async function downloadCloudFontFamily(entry: CloudFontCatalogEntry): Promise<StoredFontFamily> {
  const existing = cloudFontDownloads.get(entry.family);
  if (existing) return existing;
  const pending = (async () => {
    const index = await readIndex(GLOBAL_FONT_INDEX_PATH);
    const known = index.families.find((family) => family.family === entry.family);
    if (known && await usableStoredFamily(GLOBAL_FONT_INDEX_PATH, known)) return known;

    const variants: StoredFontFamily["variants"] = {};
    // The manual picker changes a family, not a weight. Pin its regular face
    // only; downloading four CJK weight/style files for one click would make
    // a normal family selection unexpectedly consume hundreds of MiB.
    for (const variant of entry.variants.filter((variant) => variant === "regular")) {
      const sources = await resolveCloudSources(entry, variant);
      const files = await mapWithConcurrency(sources, REMOTE_FONT_CONCURRENCY, async (source, sourceIndex) => {
        const bytes = await fetchCloudFont(source.url);
        // Google may return WOFF for the legacy static-font request. Determine
        // the extension from the bytes instead of assuming the modern CSS URL
        // always represents WOFF2.
        const format = detectFontFormat(bytes);
        const metadata = parseFontMetadata(bytes, `${safeFamilyPart(entry.family)}-${sourceIndex}${extensionForFormat(format)}`);
        if (metadata.family !== entry.family || metadata.variant !== variant) {
          throw new Error(`Downloaded font metadata does not match ${entry.family} (${variant})`);
        }
        const relativePath = path.join(safeFamilyPart(entry.family), `${variant}-${sourceIndex}${extensionForFormat(metadata.format)}`);
        await writeAtomic(path.join(GLOBAL_FONT_DIR, relativePath), bytes);
        return {
          format: metadata.format,
          mime_type: MIME_BY_FORMAT[metadata.format],
          size_bytes: bytes.length,
          relative_path: relativePath,
          source_url: source.url,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          unicode_range: source.unicode_range,
        } satisfies StoredFontVariant;
      });
      variants[variant] = files;
    }
    const downloaded: StoredFontFamily = { family: entry.family, variants };
    const current = await readIndex(GLOBAL_FONT_INDEX_PATH);
    const indexPosition = current.families.findIndex((family) => family.family === entry.family);
    if (indexPosition >= 0) current.families[indexPosition] = downloaded;
    else current.families.push(downloaded);
    current.families.sort((left, right) => left.family.localeCompare(right.family));
    current.cloud_font_catalog = catalogFor(current);
    await writeAtomic(GLOBAL_FONT_INDEX_PATH, `${JSON.stringify(current, null, 2)}\n`);
    return downloaded;
  })().finally(() => cloudFontDownloads.delete(entry.family));
  cloudFontDownloads.set(entry.family, pending);
  return pending;
}

export async function listManagedFontLibrary(): Promise<ManagedFontLibraryResult> {
  let index = await readIndex(GLOBAL_FONT_INDEX_PATH);
  // First access initializes the durable catalog. This keeps a brand-new
  // Agent workspace from collapsing to an empty picker while preserving any
  // previously uploaded families in the same index.
  const mergedCatalog = catalogFor(index);
  if (!index.cloud_font_catalog || index.cloud_font_catalog.entries.length !== mergedCatalog.entries.length) {
    index = { ...index, cloud_font_catalog: mergedCatalog };
    await writeAtomic(GLOBAL_FONT_INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`);
  }
  const families = (await Promise.all(index.families.map((family) => usableStoredFamily(
    GLOBAL_FONT_INDEX_PATH,
    family,
  )))).filter((family): family is UsableStoredFontFamily => Boolean(family));
  // The catalog describes selectable cloud fonts; files only describe cached
  // copies. Keep those concerns separate so an empty cache still has options.
  return summarize({ ...index, families });
}

export async function listWorkspaceManagedFonts(workspaceDir: string): Promise<ManagedFontFamily[]> {
  const indexPath = workspaceIndexPath(workspaceDir);
  const index = await readIndex(indexPath);
  return index.families
    .sort((left, right) => left.family.localeCompare(right.family))
    .map((family) => materializeFamily(indexPath, family));
}

/** Families that have been fully pinned to this Workspace, not merely cached
 * in the shared cloud-font directory. */
export async function listWorkspaceManagedFontLibrary(workspaceDir: string): Promise<ManagedFontLibraryResult> {
  const indexPath = workspaceIndexPath(workspaceDir);
  const index = await readIndex(indexPath);
  const families = (await Promise.all(index.families.map((family) => usableStoredFamily(indexPath, family))))
    .filter((family): family is UsableStoredFontFamily => Boolean(family));
  return {
    families: families
      .map((family) => ({
        family: family.family,
        variants: Object.keys(family.variants) as ManagedFontVariant[],
        source: "uploaded" as const,
        cached: true,
      }))
      .sort((left, right) => left.family.localeCompare(right.family)),
  };
}

export async function pinManagedFontToWorkspace(
  workspaceDir: string,
  familyName: string,
  replaceVariant?: ManagedFontVariant,
): Promise<ManagedFontFamily> {
  const normalizedWorkspace = assertWorkspaceDir(workspaceDir);
  let globalIndex = await readIndex(GLOBAL_FONT_INDEX_PATH);
  let storedFamily = globalIndex.families.find((entry) => entry.family === familyName);
  if (!storedFamily || !await usableStoredFamily(GLOBAL_FONT_INDEX_PATH, storedFamily)) {
    const cloudEntry = catalogFor(globalIndex).entries.find((entry) => entry.family === familyName && validCloudEntry(entry));
    if (!cloudEntry) throw new Error(`Managed font family not found: ${familyName}`);
    storedFamily = await downloadCloudFontFamily(cloudEntry);
    globalIndex = await readIndex(GLOBAL_FONT_INDEX_PATH);
  }
  const globalFamily = await usableStoredFamily(GLOBAL_FONT_INDEX_PATH, storedFamily);
  if (!globalFamily) throw new Error(`Managed font family is not available: ${familyName}`);
  const targetIndexPath = workspaceIndexPath(normalizedWorkspace);
  const targetIndex = await readIndex(targetIndexPath);
  let targetFamily = targetIndex.families.find((entry) => entry.family === familyName);
  if (!targetFamily) {
    targetFamily = { family: familyName, variants: {} };
    targetIndex.families.push(targetFamily);
  }
  const usableTargetFamily = await usableStoredFamily(targetIndexPath, targetFamily);
  for (const [variant, storedFiles] of Object.entries(globalFamily.variants) as Array<[ManagedFontVariant, StoredFontVariant[]]>) {
    if (usableTargetFamily?.variants[variant] && replaceVariant !== variant) continue;
    // A Workspace pin is metadata, not another font-file copy. The shared
    // library owns the immutable bytes; the pin records exactly which files
    // this Workspace is allowed to resolve during editing and export.
    targetFamily.variants[variant] = storedFiles.map(referenceSharedVariant);
  }
  targetIndex.families.sort((left, right) => left.family.localeCompare(right.family));
  await writeAtomic(targetIndexPath, `${JSON.stringify(targetIndex, null, 2)}\n`);
  return materializeFamily(targetIndexPath, targetFamily);
}

export async function commitManagedFontUpload(
  input: CommitManagedFontUploadInput,
): Promise<CommitManagedFontUploadResult> {
  const workspaceDir = assertWorkspaceDir(input.workspace_dir);
  if (!path.isAbsolute(input.staging_file_path)) {
    throw new Error('"staging_file_path" must be an absolute path');
  }
  const fileStat = await stat(input.staging_file_path);
  if (!fileStat.isFile() || fileStat.size !== Math.floor(input.expected_size_bytes)) {
    throw new Error("Managed font upload size does not match the staged file");
  }
  if (fileStat.size <= 0 || fileStat.size > MANAGED_FONT_MAX_BYTES) {
    throw new Error(`Managed font file must be between 1 and ${MANAGED_FONT_MAX_BYTES} bytes`);
  }
  const bytes = await readFile(input.staging_file_path);
  const metadata = parseFontMetadata(bytes, input.filename);
  const globalIndex = await readIndex(GLOBAL_FONT_INDEX_PATH);
  let family = globalIndex.families.find((entry) => entry.family === metadata.family);
  if (metadata.variant !== "regular" && !family?.variants.regular) {
    throw new Error(`Upload the regular face for ${metadata.family} before adding other variants`);
  }
  if (!family) {
    family = { family: metadata.family, variants: {} };
    globalIndex.families.push(family);
  }
  const relativePath = path.join(
    safeFamilyPart(metadata.family),
    `${metadata.variant}.${metadata.format}`,
  );
  const previous = singleStoredVariant(family.variants[metadata.variant]);
  const destination = path.join(GLOBAL_FONT_DIR, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeAtomic(destination, bytes);
  family.variants[metadata.variant] = {
    format: metadata.format,
    mime_type: MIME_BY_FORMAT[metadata.format],
    size_bytes: bytes.length,
    relative_path: relativePath,
  };
  globalIndex.families.sort((left, right) => left.family.localeCompare(right.family));
  await writeAtomic(GLOBAL_FONT_INDEX_PATH, `${JSON.stringify(globalIndex, null, 2)}\n`);
  if (previous && previous.relative_path !== relativePath) {
    await rm(path.join(GLOBAL_FONT_DIR, previous.relative_path), { force: true });
  }
  const font = await pinManagedFontToWorkspace(workspaceDir, metadata.family, metadata.variant);
  return { library: await listManagedFontLibrary(), font };
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}

function fontFaceRule(family: string, file: ManagedFontVariantFile): string {
  const bold = file.variant === "bold" || file.variant === "boldItalic";
  const italic = file.variant === "italic" || file.variant === "boldItalic";
  const format = file.format === "ttf"
    ? "truetype"
    : file.format === "otf"
      ? "opentype"
      : file.format;
  return [
    "@font-face {",
    `  font-family: "${escapeCssString(family)}";`,
    `  src: url("${pathToFileURL(file.file_path).href}") format("${format}");`,
    `  font-weight: ${bold ? 700 : 400};`,
    `  font-style: ${italic ? "italic" : "normal"};`,
    ...(file.unicode_range ? [`  unicode-range: ${file.unicode_range};`] : []),
    "  font-display: block;",
    "}",
  ].join("\n");
}

function usedManagedFamilies(html: string): Set<string> {
  const values = new Set<string>();
  const pattern = new RegExp(
    `${MANAGED_FONT_FAMILY_ATTRIBUTE}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`,
    "gi",
  );
  for (const match of html.matchAll(pattern)) {
    const value = (match[1] ?? match[2] ?? "").trim();
    if (value) values.add(value);
  }
  return values;
}

export async function managedFontsUsedByHtml(
  workspaceDir: string,
  html: string,
): Promise<ManagedFontFamily[]> {
  const used = usedManagedFamilies(html);
  if (used.size === 0) return [];
  const workspaceFonts = await listWorkspaceManagedFonts(workspaceDir);
  return workspaceFonts.filter((font) => used.has(font.family));
}

export async function managedFontVariantWarningsForHtml(
  workspaceDir: string,
  html: string,
): Promise<string[]> {
  const usedFonts = await managedFontsUsedByHtml(workspaceDir, html);
  const variants: ManagedFontVariant[] = ["regular", "bold", "italic", "boldItalic"];
  return usedFonts.flatMap((font) => {
    const missing = variants.filter((variant) => !font.variants[variant]);
    return missing.length > 0 ? [`${font.family}: ${missing.join(", ")}`] : [];
  });
}

export async function injectWorkspaceManagedFontCss(
  workspaceDir: string,
  html: string,
  options: { injectInto?: "shell" | "head" } = {},
): Promise<string> {
  const withoutOld = html.replace(
    new RegExp(`<style\\b[^>]*${MANAGED_FONT_STYLE_ATTRIBUTE}=["']true["'][^>]*>[\\s\\S]*?<\\/style\\s*>`, "gi"),
    "",
  );
  const used = usedManagedFamilies(withoutOld);
  if (used.size === 0) return withoutOld;
  const workspaceFonts = await listWorkspaceManagedFonts(workspaceDir);
  const rules: string[] = [];
  for (const familyName of used) {
    const family = workspaceFonts.find((entry) => entry.family === familyName);
    if (!family) throw new Error(`Managed font is missing from this workspace: ${familyName}`);
    for (const files of Object.values(family.variants)) {
      for (const file of files ?? []) rules.push(fontFaceRule(family.family, file));
    }
  }
  const style = `<style ${MANAGED_FONT_STYLE_ATTRIBUTE}="true">\n${rules.join("\n")}\n</style>`;
  if (options.injectInto === "head") {
    // Headless render plans have no static slide shell (the shell is created
    // at runtime by the page bootstrap); a document-scoped <head> injection
    // still applies to every glyph, and the staticizer later merges the rule
    // into the snapshot head.
    const headClose = /<\/head\s*>/i;
    if (headClose.test(withoutOld)) return withoutOld.replace(headClose, `${style}\n</head>`);
    return withoutOld.replace(/<html\b[^>]*>/i, (opening) => `${opening}<head>${style}</head>`);
  }
  const shellPattern = /<div\b[^>]*data-presenton-slide-shell\s*=\s*["']true["'][^>]*>/i;
  if (!shellPattern.test(withoutOld)) throw new Error("Managed font CSS requires a slide shell");
  return withoutOld.replace(shellPattern, (opening) => `${opening}\n${style}`);
}
