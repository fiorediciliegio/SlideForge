import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectManagedFontFile } from "../src/font-library/index.ts";
import {
  createSystemFontResolver,
  peelTtcFace,
  subsetFontBuffer,
} from "../src/pptx-export/system-fonts.ts";

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

function utf16be(value: string): Buffer {
  const littleEndian = Buffer.from(value, "utf16le");
  const result = Buffer.alloc(littleEndian.length);
  for (let index = 0; index < littleEndian.length; index += 2) {
    result[index] = littleEndian[index + 1]!;
    result[index + 1] = littleEndian[index]!;
  }
  return result;
}

function nameTable(family: string): Buffer {
  const familyBytes = utf16be(family);
  const table = Buffer.alloc(6 + 12 + familyBytes.length);
  table.writeUInt16BE(0, 0);
  table.writeUInt16BE(1, 2);
  table.writeUInt16BE(18, 4);
  table.writeUInt16BE(3, 6);
  table.writeUInt16BE(1, 8);
  table.writeUInt16BE(0x0409, 10);
  table.writeUInt16BE(1, 12);
  table.writeUInt16BE(familyBytes.length, 14);
  table.writeUInt16BE(0, 16);
  familyBytes.copy(table, 18);
  return table;
}

function minimalFace(family: string, weight: number, fsType: number): Buffer {
  const tables = [
    { tag: "name", bytes: nameTable(family) },
    { tag: "OS/2", bytes: Buffer.alloc(96) },
    { tag: "head", bytes: Buffer.alloc(54) },
    { tag: "maxp", bytes: Buffer.alloc(6) },
    { tag: "cmap", bytes: Buffer.alloc(4) },
    { tag: "glyf", bytes: Buffer.alloc(4) },
    { tag: "hmtx", bytes: Buffer.alloc(4) },
  ];
  tables[1]!.bytes.writeUInt16BE(weight, 4);
  tables[1]!.bytes.writeUInt16BE(fsType, 8);
  const directoryBytes = 12 + tables.length * 16;
  let total = directoryBytes;
  for (const table of tables) total += Math.ceil(table.bytes.length / 4) * 4;
  const font = Buffer.alloc(total);
  font.writeUInt32BE(0x00010000, 0);
  font.writeUInt16BE(tables.length, 4);
  let tableOffset = directoryBytes;
  tables.forEach((table, index) => {
    const directoryOffset = 12 + index * 16;
    font.write(table.tag, directoryOffset, "latin1");
    font.writeUInt32BE(tableOffset, directoryOffset + 8);
    font.writeUInt32BE(table.bytes.length, directoryOffset + 12);
    table.bytes.copy(font, tableOffset);
    tableOffset += Math.ceil(table.bytes.length / 4) * 4;
  });
  return font;
}

function rebaseFace(face: Buffer, delta: number): Buffer {
  const out = Buffer.from(face);
  const count = out.readUInt16BE(4);
  for (let index = 0; index < count; index += 1) {
    const rec = 12 + index * 16;
    out.writeUInt32BE(out.readUInt32BE(rec + 8) + delta, rec + 8);
  }
  return out;
}

function synthesizeTtc(faces: Buffer[]): Buffer {
  // Real collections store ABSOLUTE table offsets (measured from the file
  // start), so a face embedded at a nonzero base must be rebased — exactly
  // what a producer like fontTools does, and what peel relies on.
  const headerSize = 12 + faces.length * 4;
  const bases: number[] = [];
  let cursor = headerSize;
  for (const face of faces) {
    bases.push(cursor);
    cursor += Math.ceil(face.length / 4) * 4;
  }
  const parts: Buffer[] = [];
  const header = Buffer.alloc(headerSize);
  header.write("ttcf", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(faces.length, 8);
  bases.forEach((base, index) => header.writeUInt32BE(base, 12 + index * 4));
  parts.push(header);
  faces.forEach((face, index) => {
    const rebased = rebaseFace(face, bases[index]!);
    parts.push(rebased);
    const padding = Math.ceil(rebased.length / 4) * 4 - rebased.length;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  });
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// peelTtcFace
// ---------------------------------------------------------------------------

test("peels each face of a synthetic collection into a standalone sfnt", () => {
  const collection = synthesizeTtc([
    minimalFace("Peeled One", 400, 0x0008),
    minimalFace("Peeled Two", 700, 0x0008),
  ]);

  const face0 = peelTtcFace(collection, 0);
  assert.deepEqual(inspectManagedFontFile(face0, "face.ttf").family, "Peeled One");
  const face1 = peelTtcFace(collection, 1);
  assert.deepEqual(inspectManagedFontFile(face1, "face.ttf").family, "Peeled Two");
  // Weight and license survive the rebuild (OS/2 offset 4 / 8); peel sorts
  // the directory by tag, so locate OS/2 rather than assuming a slot.
  const os2 = tableOffsetOf(face0, "OS/2");
  assert.ok(os2 > 0);
  assert.equal(face0.readUInt16BE(os2 + 4), 400);
});

test("peel rejects out-of-range faces and non-collections", () => {
  const collection = synthesizeTtc([minimalFace("Only", 400, 0)]);
  assert.throws(() => peelTtcFace(collection, 1), /out of range/);
  assert.throws(() => peelTtcFace(Buffer.alloc(16), 0), /Not a TTC/);
});

// ---------------------------------------------------------------------------
// Real system fonts (Windows-only; skipped elsewhere so CI stays green)
// ---------------------------------------------------------------------------

const windows = process.platform === "win32";
const msyhPath = "C:/Windows/Fonts/msyh.ttc";

test("peels a real TTC face, subsets it, and keeps the head checksum consistent", { skip: !windows }, async () => {
  const collection = await readFile(msyhPath);
  assert.equal(collection.toString("latin1", 0, 4), "ttcf");
  const face0 = peelTtcFace(collection, 0);

  // A valid sfnt's uint32 sum over the whole file lands on 0xB1B0AFBA once
  // head.checkSumAdjustment is filled in; PowerPoint's stricter readers
  // and fonteditor both key off well-formed tables.
  const headOffset = tableOffsetOf(face0, "head");
  let sum = 0;
  for (let i = 0; i + 4 <= face0.length; i += 4) sum = (sum + face0.readUInt32BE(i)) >>> 0;
  assert.equal(sum, 0xb1b0afba, "peeled face checksum must be self-consistent");
  assert.ok(headOffset > 0);

  const subset = await subsetFontBuffer(face0, [0x4f60, 0x597d, 0x20, 0x41]);
  const metadata = inspectManagedFontFile(subset, "yahei-subset.ttf");
  assert.equal(metadata.family, "Microsoft YaHei");
  assert.ok(subset.length < face0.length / 10, "subset must be dramatically smaller");
});

function tableOffsetOf(sfnt: Buffer, tag: string): number {
  const count = sfnt.readUInt16BE(4);
  for (let i = 0; i < count; i += 1) {
    const rec = 12 + i * 16;
    if (sfnt.toString("latin1", rec, rec + 4) === tag) return sfnt.readUInt32BE(rec + 8);
  }
  return -1;
}

test("resolver finds installed families (incl. cross-file bold and localized aliases)", { skip: !windows }, async () => {
  const resolver = createSystemFontResolver();
  const created: string[] = [];
  try {
    const impact = await resolver.resolve("Impact", [72, 101, 108, 108, 111]);
    assert.ok(impact);
    assert.equal(impact.length, 1);
    assert.equal(impact[0]!.weight, 400);
    created.push(fileURLToPath(impact[0]!.url));
    assert.equal(inspectManagedFontFile(await readFile(created[0]!), "x.ttf").family, "Impact");

    const yahei = await resolver.resolve("Microsoft YaHei", [0x4f60, 0x597d]);
    assert.ok(yahei);
    // Regular lives in msyh.ttc, bold in msyhbd.ttc: a collection-peeling
    // resolver that only read one file would return just one of these.
    assert.deepEqual(yahei.map((source) => source.weight).sort((a, b) => a - b), [400, 700]);
    for (const source of yahei) {
      const file = fileURLToPath(source.url);
      created.push(file);
      assert.equal(inspectManagedFontFile(await readFile(file), "x.ttf").family, "Microsoft YaHei");
    }

    // Chinese CSS token resolves to the same SimHei face via localized names.
    const hei = await resolver.resolve("黑体", [0x9ed1, 0x4f53]);
    assert.ok(hei);
    created.push(fileURLToPath(hei[0]!.url));
    assert.equal(inspectManagedFontFile(await readFile(created[created.length - 1]!), "x.ttf").family, "SimHei");

    assert.equal(await resolver.resolve("Definitely Not Installed Font", [65]), null);
  } finally {
    await resolver.cleanup();
  }
  for (const file of created) {
    await assert.rejects(stat(file), { code: "ENOENT" }, `${file} must be deleted by cleanup`);
  }
});
