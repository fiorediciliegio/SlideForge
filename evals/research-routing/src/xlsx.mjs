import { inflateRawSync } from "node:zlib";

function readUInt16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function decodeXml(value) {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#(?:x([0-9a-fA-F]+)|([0-9]+));/gu, (_match, hex, decimal) =>
      String.fromCodePoint(Number.parseInt(hex ?? decimal, hex ? 16 : 10)),
    );
}

function xmlText(value) {
  return decodeXml(value.replace(/<[^>]+>/gu, ""));
}

function parseAttributes(value) {
  return Object.fromEntries([...value.matchAll(/([\w:]+)="([^"]*)"/gu)].map((match) => [match[1], decodeXml(match[2])]));
}

function entriesFromZip(buffer) {
  const endSignature = 0x06054b50;
  const start = Math.max(0, buffer.length - 0xFFFF - 22);
  let directoryOffset = -1;
  for (let index = buffer.length - 22; index >= start; index -= 1) {
    if (readUInt32(buffer, index) === endSignature) {
      directoryOffset = readUInt32(buffer, index + 16);
      break;
    }
  }
  if (directoryOffset < 0) throw new Error("Invalid XLSX: end-of-central-directory record is missing.");
  const files = new Map();
  let cursor = directoryOffset;
  while (cursor + 46 <= buffer.length && readUInt32(buffer, cursor) === 0x02014b50) {
    const compression = readUInt16(buffer, cursor + 10);
    const compressedSize = readUInt32(buffer, cursor + 20);
    const nameLength = readUInt16(buffer, cursor + 28);
    const extraLength = readUInt16(buffer, cursor + 30);
    const commentLength = readUInt16(buffer, cursor + 32);
    const localOffset = readUInt32(buffer, cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (readUInt32(buffer, localOffset) !== 0x04034b50) throw new Error(`Invalid XLSX local file header: ${name}`);
    const localNameLength = readUInt16(buffer, localOffset + 26);
    const localExtraLength = readUInt16(buffer, localOffset + 28);
    const compressed = buffer.subarray(localOffset + 30 + localNameLength + localExtraLength, localOffset + 30 + localNameLength + localExtraLength + compressedSize);
    files.set(name, compression === 0 ? compressed : compression === 8 ? inflateRawSync(compressed) : (() => { throw new Error(`Unsupported XLSX compression method: ${compression}`); })());
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu)].map((match) =>
    [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)].map((text) => xmlText(text[1])).join(""),
  );
}

function columnNumber(reference) {
  const letters = reference.replace(/\d/gu, "");
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gu)) {
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gu)) {
      const attributes = parseAttributes(cellMatch[1]);
      const value = /<v\b[^>]*>([\s\S]*?)<\/v>/u.exec(cellMatch[2])?.[1] ?? "";
      const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/u.exec(cellMatch[2])?.[1];
      const column = columnNumber(attributes.r ?? "A1");
      row[column] = attributes.t === "s" ? sharedStrings[Number(value)] ?? "" : inline ? xmlText(inline) : xmlText(value);
    }
    rows.push(row.map((value) => value ?? ""));
  }
  return rows;
}

export function parseXlsx(buffer) {
  const files = entriesFromZip(buffer);
  const workbook = files.get("xl/workbook.xml")?.toString("utf8");
  const relations = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (!workbook || !relations) throw new Error("Invalid XLSX: workbook metadata is missing.");
  const sharedStrings = parseSharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "");
  const relationMap = new Map([...relations.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/gu)].map((match) => {
    const attributes = parseAttributes(match[1]);
    return [attributes.Id, attributes.Target];
  }));
  const sheets = new Map();
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>(?:<\/sheet>)?/gu)) {
    const attributes = parseAttributes(match[1]);
    const target = relationMap.get(attributes["r:id"]);
    if (!target || !attributes.name) continue;
    const path = `xl/${target.replace(/^\//u, "")}`;
    const xml = files.get(path)?.toString("utf8");
    if (xml) sheets.set(attributes.name, parseSheet(xml, sharedStrings));
  }
  return sheets;
}
