import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import JSZip from "jszip";

const SLIDE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";

function usage(): never {
  throw new Error(
    "Usage: merge-single-slide-pptx.ts <absolute-output.pptx> <absolute-font-reference.pptx> <absolute-single-slide-1.pptx> ...",
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertAbsolute(value: string, label: string): void {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
}

async function fileText(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name);
  if (!entry) throw new Error(`PPTX is missing required part: ${name}`);
  return entry.async("string");
}

async function fileBytes(zip: JSZip, name: string): Promise<Buffer> {
  const entry = zip.file(name);
  if (!entry) throw new Error(`PPTX is missing required part: ${name}`);
  return Buffer.from(await entry.async("nodebuffer"));
}

function nextNumericRelationshipId(relsXml: string): number {
  return [...relsXml.matchAll(/\bId="rId(\d+)"/g)].reduce((max, match) => Math.max(max, Number(match[1])), 0) + 1;
}

function nextSlideId(presentationXml: string): number {
  return [...presentationXml.matchAll(/<p:sldId\b[^>]*\bid="(\d+)"/g)]
    .reduce((max, match) => Math.max(max, Number(match[1])), 255) + 1;
}

function replaceEmbeddedFonts(
  targetPresentationXml: string,
  targetPresentationRelsXml: string,
  fontPresentationXml: string,
  fontPresentationRelsXml: string,
): { presentationXml: string; presentationRelsXml: string } {
  const fontList = fontPresentationXml.match(/<p:embeddedFontLst>.*?<\/p:embeddedFontLst>/s)?.[0] ?? "";
  const presentationXml = targetPresentationXml.replace(/<p:embeddedFontLst>.*?<\/p:embeddedFontLst>/s, fontList);
  const withoutFonts = targetPresentationRelsXml.replace(
    /<Relationship\b[^>]*\bType="[^"]*\/relationships\/font"[^>]*\/>/g,
    "",
  );
  const fontRelationships = [...fontPresentationRelsXml.matchAll(/<Relationship\b[^>]*\bType="[^"]*\/relationships\/font"[^>]*\/>/g)]
    .map((match) => match[0])
    .join("");
  return {
    presentationXml,
    presentationRelsXml: withoutFonts.replace("</Relationships>", `${fontRelationships}</Relationships>`),
  };
}

function addContentTypeOverrides(contentTypesXml: string, slideNumbers: number[]): string {
  const additions = slideNumbers.flatMap((number) => [
    `<Override PartName="/ppt/slides/slide${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    `<Override PartName="/ppt/notesSlides/notesSlide${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
  ]).join("");
  return contentTypesXml.replace("</Types>", `${additions}</Types>`);
}

async function main(): Promise<void> {
  const [outputPath, fontReferencePath, ...inputPaths] = process.argv.slice(2);
  if (!outputPath || !fontReferencePath || inputPaths.length < 2) usage();
  for (const [index, value] of [outputPath, fontReferencePath, ...inputPaths].entries()) {
    assertAbsolute(value, index === 0 ? "output path" : "input path");
  }
  try {
    await access(outputPath);
    throw new Error(`Refusing to overwrite an existing output: ${outputPath}`);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  let peakRssBytes = 0;
  let peakHeapBytes = 0;
  let peakExternalBytes = 0;
  const sampleMemory = () => {
    const memory = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, memory.rss);
    peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed);
    peakExternalBytes = Math.max(peakExternalBytes, memory.external);
  };
  const timer = setInterval(sampleMemory, 20);
  const startedAt = performance.now();
  sampleMemory();

  try {
    const target = await JSZip.loadAsync(await readFile(inputPaths[0]));
    const fontReference = await JSZip.loadAsync(await readFile(fontReferencePath));
    const sourceZips = await Promise.all(inputPaths.slice(1).map(async (inputPath) => (
      JSZip.loadAsync(await readFile(inputPath))
    )));

    // Use a deck-wide font bundle created by the normal export path.  Single
    // pages carry different subsets of the same face; choosing one page's
    // subset would silently drop glyphs used on other pages.
    for (const name of Object.keys(target.files)) {
      if (name.startsWith("ppt/fonts/")) target.remove(name);
    }
    for (const name of Object.keys(fontReference.files)) {
      if (!name.startsWith("ppt/fonts/") || name.endsWith("/")) continue;
      target.file(name, await fileBytes(fontReference, name));
    }

    let presentationXml = await fileText(target, "ppt/presentation.xml");
    let presentationRelsXml = await fileText(target, "ppt/_rels/presentation.xml.rels");
    const referencePresentationXml = await fileText(fontReference, "ppt/presentation.xml");
    const referencePresentationRelsXml = await fileText(fontReference, "ppt/_rels/presentation.xml.rels");
    ({ presentationXml, presentationRelsXml } = replaceEmbeddedFonts(
      presentationXml,
      presentationRelsXml,
      referencePresentationXml,
      referencePresentationRelsXml,
    ));

    let contentTypesXml = await fileText(target, "[Content_Types].xml");
    const mediaByHash = new Map<string, string>();
    let nextMediaNumber = 1;
    for (const name of Object.keys(target.files)) {
      if (!name.startsWith("ppt/media/") || name.endsWith("/")) continue;
      const bytes = await fileBytes(target, name);
      mediaByHash.set(createHash("sha256").update(bytes).digest("hex"), path.basename(name));
      nextMediaNumber++;
    }

    let nextRelationshipId = nextNumericRelationshipId(presentationRelsXml);
    let nextGlobalSlideId = nextSlideId(presentationXml);
    const addedSlideNumbers: number[] = [];

    for (const [sourceIndex, source] of sourceZips.entries()) {
      const slideNumber = sourceIndex + 2;
      let slideRelsXml = await fileText(source, "ppt/slides/_rels/slide1.xml.rels");
      const sourceMediaNames = [...slideRelsXml.matchAll(/Target="\.\.\/media\/([^"]+)"/g)]
        .map((match) => match[1]);
      const mediaNameMap = new Map<string, string>();
      for (const sourceMediaName of new Set(sourceMediaNames)) {
        const bytes = await fileBytes(source, `ppt/media/${sourceMediaName}`);
        const hash = createHash("sha256").update(bytes).digest("hex");
        let targetMediaName = mediaByHash.get(hash);
        if (!targetMediaName) {
          const extension = path.extname(sourceMediaName) || ".bin";
          targetMediaName = `merged-media-${nextMediaNumber++}${extension}`;
          target.file(`ppt/media/${targetMediaName}`, bytes);
          mediaByHash.set(hash, targetMediaName);
        }
        mediaNameMap.set(sourceMediaName, targetMediaName);
      }
      for (const [sourceMediaName, targetMediaName] of mediaNameMap) {
        slideRelsXml = slideRelsXml.replace(
          new RegExp(`Target="\.\.\/media\/${escapeRegex(sourceMediaName)}"`, "g"),
          `Target="../media/${targetMediaName}"`,
        );
      }
      slideRelsXml = slideRelsXml.replace(
        /Target="\.\.\/notesSlides\/notesSlide1\.xml"/g,
        `Target="../notesSlides/notesSlide${slideNumber}.xml"`,
      );

      target.file(`ppt/slides/slide${slideNumber}.xml`, await fileBytes(source, "ppt/slides/slide1.xml"));
      target.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`, slideRelsXml);

      // PptxGenJS creates a notes slide even when it has no user note. Retain
      // it so the slide relation graph remains valid and future note support
      // has the correct structure.
      const notePart = "ppt/notesSlides/notesSlide1.xml";
      const noteRelsPart = "ppt/notesSlides/_rels/notesSlide1.xml.rels";
      if (source.file(notePart)) {
        target.file(`ppt/notesSlides/notesSlide${slideNumber}.xml`, await fileBytes(source, notePart));
        if (source.file(noteRelsPart)) {
          const noteRels = (await fileText(source, noteRelsPart)).replace(
            /Target="\.\.\/slides\/slide1\.xml"/g,
            `Target="../slides/slide${slideNumber}.xml"`,
          );
          target.file(`ppt/notesSlides/_rels/notesSlide${slideNumber}.xml.rels`, noteRels);
        }
      }

      const relationshipId = `rId${nextRelationshipId++}`;
      const slideRelationship = `<Relationship Id="${relationshipId}" Type="${SLIDE_REL_TYPE}" Target="slides/slide${slideNumber}.xml"/>`;
      presentationRelsXml = presentationRelsXml.replace("</Relationships>", `${slideRelationship}</Relationships>`);
      const slideId = `<p:sldId id="${nextGlobalSlideId++}" r:id="${relationshipId}"/>`;
      presentationXml = presentationXml.replace("</p:sldIdLst>", `${slideId}</p:sldIdLst>`);
      addedSlideNumbers.push(slideNumber);
      sampleMemory();
    }

    contentTypesXml = addContentTypeOverrides(contentTypesXml, addedSlideNumbers);
    const appXml = await fileText(target, "docProps/app.xml");
    target.file("ppt/presentation.xml", presentationXml);
    target.file("ppt/_rels/presentation.xml.rels", presentationRelsXml);
    target.file("[Content_Types].xml", contentTypesXml);
    target.file("docProps/app.xml", appXml.replace(/<Slides>\d+<\/Slides>/, `<Slides>${inputPaths.length}</Slides>`));

    const outputBytes = await target.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    sampleMemory();
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, outputBytes, { flag: "wx" });
    const durationMs = performance.now() - startedAt;
    process.stdout.write(`${JSON.stringify({
      output_path: outputPath,
      slide_count: inputPaths.length,
      size_bytes: outputBytes.byteLength,
      duration_ms: Math.round(durationMs * 10) / 10,
      peak_rss_bytes: peakRssBytes,
      peak_heap_bytes: peakHeapBytes,
      peak_external_bytes: peakExternalBytes,
      media_parts_after_dedupe: mediaByHash.size,
    })}\n`);
  } finally {
    clearInterval(timer);
  }
}

void main();
