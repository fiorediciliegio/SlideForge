import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/**
 * Locate and subset system fonts so PPTX exports embed the face the browser
 * actually rendered with — not the (possibly missing) first entry of the
 * CSS font-family stack that dom-to-pptx cannot find a @font-face url for.
 *
 * The index (family alias -> installed face) is built lazily on first use
 * and shared across exports; subset files are written per resolver instance
 * and deleted by cleanup().
 */

const FSTYPE_BLOCKS_EMBEDDING = 0x0001 | 0x0002 | 0x0100 | 0x0400;
const FONT_FILE_EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".otc"]);
const MAX_FACE_SCAN_BYTES = 80 * 1024 * 1024;
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

export interface ResolvedFontSource {
  url: string;
  weight: number;
  style: "normal" | "italic";
}

interface InstalledFace {
  file: string;
  faceIndex: number; // index within the TTC collection, 0 for plain sfnt
  isCollection: boolean;
  weight: number;
  italic: boolean;
  fsType: number;
}

export interface SystemFontResolver {
  /**
   * Return one source per embeddable variant (regular + bold when present),
   * or null when this machine simply has no font by that name. A font that
   * exists but forbids embedding throws with the license reason so the
   * export report carries it instead of a generic miss.
   */
  resolve(family: string, unicodes: number[]): Promise<ResolvedFontSource[] | null>;
  cleanup(): Promise<void>;
}

function platformFontDirectories(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return [
      path.join(process.env.SystemRoot ?? "C:\\Windows", "Fonts"),
      ...(local ? [path.join(local, "Microsoft", "Windows", "Fonts")] : []),
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/System/Library/Fonts",
      "/System/Library/Fonts/Supplemental",
      "/Library/Fonts",
      path.join(home, "Library", "Fonts"),
    ];
  }
  return [
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    path.join(home, ".local", "share", "fonts"),
  ];
}

function collectFontFiles(directory: string, into: string[], depth: number): void {
  if (depth > 6) return;
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(directory, { withFileTypes: true });
  } catch {
    return; // unreadable or absent directory — the platform list is best-effort
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFontFiles(full, into, depth + 1);
    } else if (FONT_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      into.push(full);
    }
  }
}

type FileHandle = Awaited<ReturnType<typeof open>>;

async function readRange(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error("Font file ended early");
  return buffer;
}

function decodeNameString(platformId: number, bytes: Buffer): string {
  if (platformId === 0 || platformId === 3) {
    const swapped = Buffer.alloc(bytes.length - (bytes.length % 2));
    for (let i = 0; i < swapped.length; i += 2) {
      swapped[i] = bytes[i + 1]!;
      swapped[i + 1] = bytes[i]!;
    }
    return swapped.toString("utf16le");
  }
  return bytes.toString("latin1");
}

interface FaceHeader {
  aliases: Set<string>;
  weight: number;
  italic: boolean;
  fsType: number;
}

async function readFaceHeader(handle: FileHandle, faceBase: number): Promise<FaceHeader> {
  const numTables = (await readRange(handle, faceBase + 4, 2)).readUInt16BE(0);
  if (numTables === 0 || numTables > 256) throw new Error("Bad table count");
  const directory = await readRange(handle, faceBase + 12, numTables * 16);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i += 1) {
    const off = i * 16;
    const tag = directory.toString("latin1", off, off + 4);
    tables.set(tag, {
      offset: directory.readUInt32BE(off + 8),
      length: directory.readUInt32BE(off + 12),
    });
  }
  if (!tables.has("glyf") && !tables.has("CFF ") && !tables.has("CFF2")) {
    throw new Error("No outline table");
  }

  const aliases = new Set<string>();
  const name = tables.get("name");
  if (name) {
    const table = await readRange(handle, name.offset, Math.min(name.length, 256 * 1024));
    const count = table.readUInt16BE(2);
    const stringsAt = table.readUInt16BE(4);
    for (let i = 0; i < count; i += 1) {
      const rec = 6 + i * 12;
      if (rec + 12 > table.length) break;
      const platformId = table.readUInt16BE(rec);
      const nameId = table.readUInt16BE(rec + 6);
      // Both family slots: name 1 is the legacy family, 16 the preferred
      // one; decks may use either. Localized records (微软雅黑, 黑体) are
      // just as real to CSS as the English one, so every platform is kept.
      if (nameId !== 1 && nameId !== 16) continue;
      const length = table.readUInt16BE(rec + 8);
      const start = stringsAt + table.readUInt16BE(rec + 10);
      if (start + length > table.length) continue;
      const value = decodeNameString(platformId, table.subarray(start, start + length))
        .normalize("NFKC")
        .replace(CONTROL_CHARS, "")
        .trim();
      if (value) aliases.add(value.toLowerCase());
    }
  }
  if (aliases.size === 0) throw new Error("No family name records");

  let weight = 400;
  let fsType = 0;
  const os2 = tables.get("OS/2");
  if (os2 && os2.length >= 64) {
    const table = await readRange(handle, os2.offset, 64);
    weight = table.readUInt16BE(4);
    fsType = table.readUInt16BE(8);
  }
  let italic = false;
  let bold = false;
  const head = tables.get("head");
  if (head && head.length >= 46) {
    const table = await readRange(handle, head.offset, 46);
    const macStyle = table.readUInt16BE(44);
    bold = Boolean(macStyle & 0x0001);
    italic = Boolean(macStyle & 0x0002);
  }
  if (bold) weight = Math.max(weight, 700);
  return { aliases, weight, italic, fsType };
}

/**
 * Parse only the identifying metadata of one font file (all faces when it
 * is a TTC collection). Any failure — unsupported format, corrupt table,
 * stray non-font file sharing the extension — disqualifies the file, not
 * the export, so the caller is expected to swallow the error.
 */
async function inspectFontFile(file: string): Promise<Array<InstalledFace & { aliases: Set<string> }>> {
  const handle = await open(file, "r");
  try {
    const signature = (await readRange(handle, 0, 16)).toString("latin1", 0, 4);
    const bases: number[] = [];
    if (signature === "ttcf") {
      const numFonts = (await readRange(handle, 8, 4)).readUInt32BE(0);
      if (numFonts === 0 || numFonts > 256) throw new Error("Bad TTC font count");
      const offsets = await readRange(handle, 12, numFonts * 4);
      for (let i = 0; i < numFonts; i += 1) bases.push(offsets.readUInt32BE(i * 4));
    } else if (
      signature === "OTTO" || signature === "true"
      || (signature.charCodeAt(0) === 0 && signature.charCodeAt(1) === 1)
    ) {
      bases.push(0);
    } else {
      throw new Error("Unsupported font format");
    }
    const faces: Array<InstalledFace & { aliases: Set<string> }> = [];
    for (let index = 0; index < bases.length; index += 1) {
      try {
        const header = await readFaceHeader(handle, bases[index]!);
        faces.push({
          file,
          faceIndex: index,
          isCollection: signature === "ttcf",
          weight: header.weight,
          italic: header.italic,
          fsType: header.fsType,
          aliases: header.aliases,
        });
      } catch {
        // A broken face inside a collection must not hide its healthy siblings.
      }
    }
    return faces;
  } finally {
    await handle.close();
  }
}

async function buildFontIndex(): Promise<Map<string, InstalledFace[]>> {
  const index = new Map<string, InstalledFace[]>();
  const files: string[] = [];
  for (const directory of platformFontDirectories()) collectFontFiles(directory, files, 0);
  for (const file of files) {
    try {
      const { size } = await stat(file);
      if (size <= 0 || size > MAX_FACE_SCAN_BYTES) continue;
      for (const face of await inspectFontFile(file)) {
        for (const alias of face.aliases) {
          const { aliases: _aliases, ...stored } = face;
          const bucket = index.get(alias);
          if (bucket) bucket.push(stored);
          else index.set(alias, [stored]);
        }
      }
    } catch {
      // Unreadable file: another copy of the same family usually exists.
    }
  }
  return index;
}

let sharedIndex: Promise<Map<string, InstalledFace[]>> | null = null;

function getFontIndex(): Promise<Map<string, InstalledFace[]>> {
  sharedIndex ??= buildFontIndex().catch((error) => {
    sharedIndex = null;
    throw error;
  });
  return sharedIndex;
}

/**
 * Rebuild one face of a TTC collection as a standalone sfnt.
 *
 * fonteditor-core and opentype.js cannot open 'ttcf', and shipping the whole
 * 19 MB collection to the embedder would be absurd anyway; the faces share
 * their glyf/loca data by offset, so a fresh header + table directory over
 * the same bytes is a complete font. Table and head checksums are recomputed
 * because the layout changed.
 */
export function peelTtcFace(buffer: Buffer, faceIndex: number): Buffer {
  if (buffer.toString("latin1", 0, 4) !== "ttcf") throw new Error("Not a TTC collection");
  const numFonts = buffer.readUInt32BE(8);
  if (faceIndex < 0 || faceIndex >= numFonts) throw new Error("TTC face index out of range");
  const faceBase = buffer.readUInt32BE(12 + faceIndex * 4);
  const sfntVersion = buffer.readUInt32BE(faceBase);
  const numTables = buffer.readUInt16BE(faceBase + 4);

  interface Entry { tag: string; data: Buffer }
  const entries: Entry[] = [];
  for (let i = 0; i < numTables; i += 1) {
    const rec = faceBase + 12 + i * 16;
    const tag = buffer.toString("latin1", rec, rec + 4);
    const offset = buffer.readUInt32BE(rec + 8);
    const length = buffer.readUInt32BE(rec + 12);
    entries.push({ tag, data: buffer.subarray(offset, offset + length) });
  }
  entries.sort((a, b) => (a.tag < b.tag ? -1 : 1));

  const headerSize = 12 + numTables * 16;
  let total = headerSize;
  for (const entry of entries) total += Math.ceil(entry.data.length / 4) * 4;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(sfntVersion, 0);
  out.writeUInt16BE(numTables, 4);
  let select = 0;
  while ((1 << (select + 1)) * 16 <= numTables * 16) select += 1;
  const searchRange = (1 << select) * 16;
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(select, 8);
  out.writeUInt16BE(numTables * 16 - searchRange, 10);

  let cursor = headerSize;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const checksum = tableChecksum(entry.data);
    const rec = 12 + i * 16;
    out.write(entry.tag, rec, "latin1");
    out.writeUInt32BE(checksum, rec + 4);
    out.writeUInt32BE(cursor, rec + 8);
    out.writeUInt32BE(entry.data.length, rec + 12);
    entry.data.copy(out, cursor);
    cursor += Math.ceil(entry.data.length / 4) * 4;
  }

  // head.checkSumAdjustment must make the whole-file sum land on 0xB1B0AFBA.
  const headRec = entries.findIndex((e) => e.tag === "head");
  if (headRec >= 0) {
    const headOffset = out.readUInt32BE(12 + headRec * 16 + 8);
    out.writeUInt32BE(0, headOffset + 8);
    let sum = 0;
    for (let i = 0; i + 4 <= out.length; i += 4) sum = (sum + out.readUInt32BE(i)) >>> 0;
    out.writeUInt32BE((0xb1b0afba - sum) >>> 0, headOffset + 8);
  }
  return out;
}

function tableChecksum(data: Buffer): number {
  let sum = 0;
  const aligned = Math.ceil(data.length / 4) * 4;
  for (let i = 0; i < aligned; i += 4) {
    const word = i + 4 <= data.length
      ? data.readUInt32BE(i)
      : readPaddedWord(data, i);
    sum = (sum + word) >>> 0;
  }
  return sum >>> 0;
}

function readPaddedWord(data: Buffer, offset: number): number {
  let word = 0;
  for (let i = 0; i < 4; i += 1) {
    const byte = offset + i < data.length ? data[offset + i]! : 0;
    word = word * 256 + byte;
  }
  return word >>> 0;
}

/**
 * Subset a (peeled if needed) TrueType/OpenType buffer to the given code
 * points. System CJK fonts carry ~30k glyphs; a deck uses a few hundred,
 * and embedding the whole face would bloat the PPTX by tens of megabytes.
 */
export async function subsetFontBuffer(buffer: Buffer, unicodes: number[]): Promise<Buffer> {
  const module = await import("fonteditor-core");
  const Font = (module as any).Font ?? (module as any).default?.Font;
  if (!Font) throw new Error("fonteditor-core did not expose Font");
  const sfntVersion = buffer.readUInt32BE(0);
  const type = sfntVersion === 0x4f54544f /* 'OTTO' */ ? "otf" : "ttf";
  const font = Font.create(buffer, {
    type,
    hinting: true,
    // Numbers are unicode code points; fonteditor matches them against cmap.
    subset: unicodes.length > 0 ? [...new Set(unicodes)] : undefined,
  });
  return font.write({ type, hinting: true, toBuffer: true });
}

export function createSystemFontResolver(): SystemFontResolver {
  const temporaryFiles = new Set<string>();

  async function materialize(face: InstalledFace, unicodes: number[]): Promise<string> {
    let buffer: Buffer = await readFile(face.file);
    if (face.isCollection) buffer = peelTtcFace(buffer, face.faceIndex);
    const subset = await subsetFontBuffer(buffer, unicodes);
    const slug = path.basename(face.file, path.extname(face.file)).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const tempPath = path.join(
      os.tmpdir(),
      `pptx-system-font-${slug}-${face.faceIndex}-${process.pid}-${Date.now()}-${temporaryFiles.size}.ttf`,
    );
    await writeFile(tempPath, subset);
    temporaryFiles.add(tempPath);
    return tempPath;
  }

  return {
    async resolve(family, unicodes) {
      const requested = family.trim().replace(/^['"]|['"]$/g, "").normalize("NFKC").toLowerCase();
      if (!requested) return null;
      const index = await getFontIndex();
      const candidates = index.get(requested);
      if (!candidates || candidates.length === 0) return null;

      const upright = candidates.filter((face) => !face.italic);
      // The converter asks once per family and maps weight >= 600 to the
      // bold slot; regular and bold cover what a deck without italic system
      // text actually renders (PowerPoint synthesizes the rest like a
      // browser does).
      const picks = [
        upright.filter((face) => face.weight < 600).sort((a, b) => Math.abs(a.weight - 400) - Math.abs(b.weight - 400))[0],
        upright.filter((face) => face.weight >= 600).sort((a, b) => Math.abs(a.weight - 700) - Math.abs(b.weight - 700))[0],
      ].filter((face): face is InstalledFace => Boolean(face));
      if (picks.length === 0) return null;

      const blocked = picks.find((face) => (face.fsType & FSTYPE_BLOCKS_EMBEDDING) !== 0);
      if (blocked) {
        throw new Error(
          `"${family}" is installed but its license forbids embedding (OS/2 fsType=0x${blocked.fsType.toString(16)})`,
        );
      }

      const sources: ResolvedFontSource[] = [];
      for (const face of picks) {
        const url = pathToFileURL(await materialize(face, unicodes)).href;
        sources.push({ url, weight: face.weight, style: "normal" });
      }
      return sources;
    },
    async cleanup() {
      const pending = [...temporaryFiles];
      temporaryFiles.clear();
      await Promise.all(pending.map(async (file) => {
        await unlink(file).catch(() => undefined);
      }));
    },
  };
}
