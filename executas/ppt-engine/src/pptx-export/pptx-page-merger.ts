import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";

const SLIDE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";

export interface MergePptxPagesInput {
  outputPath: string;
  pagePaths: string[];
  /** The first page must include a deck-wide, not page-local, font subset. */
  fontReferencePath?: string;
}

async function text(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name);
  if (!entry) throw new Error(`PPTX is missing ${name}`);
  return entry.async("string");
}

async function bytes(zip: JSZip, name: string): Promise<Buffer> {
  const entry = zip.file(name);
  if (!entry) throw new Error(`PPTX is missing ${name}`);
  return Buffer.from(await entry.async("nodebuffer"));
}

function nextId(xml: string, pattern: RegExp, floor: number): number {
  return [...xml.matchAll(pattern)].reduce((maximum, match) => Math.max(maximum, Number(match[1])), floor) + 1;
}

function withDeckFonts(targetPresentation: string, targetRels: string, referencePresentation: string, referenceRels: string) {
  const fontList = referencePresentation.match(/<p:embeddedFontLst>.*?<\/p:embeddedFontLst>/s)?.[0] ?? "";
  const presentation = targetPresentation.replace(/<p:embeddedFontLst>.*?<\/p:embeddedFontLst>/s, fontList);
  const withoutFonts = targetRels.replace(/<Relationship\b[^>]*\bType="[^"]*\/relationships\/font"[^>]*\/>/g, "");
  const fontRels = [...referenceRels.matchAll(/<Relationship\b[^>]*\bType="[^"]*\/relationships\/font"[^>]*\/>/g)]
    .map((match) => match[0]).join("");
  return { presentation, rels: withoutFonts.replace("</Relationships>", `${fontRels}</Relationships>`) };
}

export async function mergePptxPages(input: MergePptxPagesInput): Promise<{ slideCount: number; sizeBytes: number }> {
  if (input.pagePaths.length === 0) throw new Error("At least one page PPTX is required");
  const [basePath, ...restPaths] = input.pagePaths;
  const target = await JSZip.loadAsync(await readFile(basePath));
  const fontReference = await JSZip.loadAsync(await readFile(input.fontReferencePath ?? basePath));
  const sources = await Promise.all(restPaths.map(async (filePath) => JSZip.loadAsync(await readFile(filePath))));

  for (const name of Object.keys(target.files)) if (name.startsWith("ppt/fonts/")) target.remove(name);
  for (const name of Object.keys(fontReference.files)) {
    if (name.startsWith("ppt/fonts/") && !name.endsWith("/")) target.file(name, await bytes(fontReference, name));
  }

  let presentation = await text(target, "ppt/presentation.xml");
  let presentationRels = await text(target, "ppt/_rels/presentation.xml.rels");
  ({ presentation, rels: presentationRels } = withDeckFonts(
    presentation, presentationRels,
    await text(fontReference, "ppt/presentation.xml"),
    await text(fontReference, "ppt/_rels/presentation.xml.rels"),
  ));
  let contentTypes = await text(target, "[Content_Types].xml");

  const mediaByHash = new Map<string, string>();
  let nextMedia = 1;
  for (const name of Object.keys(target.files)) {
    if (!name.startsWith("ppt/media/") || name.endsWith("/")) continue;
    mediaByHash.set(createHash("sha256").update(await bytes(target, name)).digest("hex"), path.basename(name));
    nextMedia++;
  }
  let nextRelationship = nextId(presentationRels, /\bId="rId(\d+)"/g, 0);
  let nextSlide = nextId(presentation, /<p:sldId\b[^>]*\bid="(\d+)"/g, 255);
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (const [index, source] of sources.entries()) {
    const slideNumber = index + 2;
    let slideRels = await text(source, "ppt/slides/_rels/slide1.xml.rels");
    const names = [...slideRels.matchAll(/Target="\.\.\/media\/([^"]+)"/g)].map((match) => match[1]);
    for (const sourceName of new Set(names)) {
      const sourceBytes = await bytes(source, `ppt/media/${sourceName}`);
      const hash = createHash("sha256").update(sourceBytes).digest("hex");
      let targetName = mediaByHash.get(hash);
      if (!targetName) {
        targetName = `merged-media-${nextMedia++}${path.extname(sourceName) || ".bin"}`;
        target.file(`ppt/media/${targetName}`, sourceBytes);
        mediaByHash.set(hash, targetName);
      }
      slideRels = slideRels.replace(new RegExp(`Target="\.\.\/media\/${escaped(sourceName)}"`, "g"), `Target="../media/${targetName}"`);
    }
    slideRels = slideRels.replace(/Target="\.\.\/notesSlides\/notesSlide1\.xml"/g, `Target="../notesSlides/notesSlide${slideNumber}.xml"`);
    target.file(`ppt/slides/slide${slideNumber}.xml`, await bytes(source, "ppt/slides/slide1.xml"));
    target.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`, slideRels);

    if (source.file("ppt/notesSlides/notesSlide1.xml")) {
      target.file(`ppt/notesSlides/notesSlide${slideNumber}.xml`, await bytes(source, "ppt/notesSlides/notesSlide1.xml"));
      const notesRels = await text(source, "ppt/notesSlides/_rels/notesSlide1.xml.rels");
      target.file(`ppt/notesSlides/_rels/notesSlide${slideNumber}.xml.rels`, notesRels.replace(/Target="\.\.\/slides\/slide1\.xml"/g, `Target="../slides/slide${slideNumber}.xml"`));
    }
    const relationshipId = `rId${nextRelationship++}`;
    presentationRels = presentationRels.replace("</Relationships>", `<Relationship Id="${relationshipId}" Type="${SLIDE_REL_TYPE}" Target="slides/slide${slideNumber}.xml"/></Relationships>`);
    presentation = presentation.replace("</p:sldIdLst>", `<p:sldId id="${nextSlide++}" r:id="${relationshipId}"/></p:sldIdLst>`);
    contentTypes = contentTypes.replace("</Types>", `<Override PartName="/ppt/slides/slide${slideNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/notesSlides/notesSlide${slideNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/></Types>`);
  }

  target.file("ppt/presentation.xml", presentation);
  target.file("ppt/_rels/presentation.xml.rels", presentationRels);
  target.file("[Content_Types].xml", contentTypes);
  target.file("docProps/app.xml", (await text(target, "docProps/app.xml")).replace(/<Slides>\d+<\/Slides>/, `<Slides>${input.pagePaths.length}</Slides>`));
  const result = await target.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  await mkdir(path.dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, result, { flag: "wx" });
  return { slideCount: input.pagePaths.length, sizeBytes: result.byteLength };
}
