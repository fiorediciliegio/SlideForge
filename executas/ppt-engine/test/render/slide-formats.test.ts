import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import JSZip from "jszip";
import { SLIDE_FORMATS, normalizeSlideAspectRatio, slideFormatFromHtml, stampSlideFormat, type SlideAspectRatio } from "../../src/slide-format.js";
import { buildDeckHtmlFromManifest } from "../../src/render/build-deck-from-manifest.js";
import { buildStaticDeckHtml } from "../../src/render/build-deck.js";
import { convertDeckHtmlToPptx } from "../../src/pptx-export/dom-to-pptx.js";
import { createPdfFromSlideHtmlPaths } from "../../src/app-workspace/pdf-export.js";
import { rebuildWorkspaceDeckManifest } from "../../src/authoring-kit-workspace/index.js";
import { sanitizeManualPageHtml } from "../../src/manual-page-revisions/index.js";

const PAGE_IDS = ["page-11111111-1111-4111-8111-111111111111", "page-22222222-2222-4222-8222-222222222222"];

test("legacy HTML defaults to widescreen, unsupported sizes and mixed decks are rejected", () => {
  assert.equal(slideFormatFromHtml("<html><body></body></html>").aspectRatio, "16:9");
  assert.throws(() => normalizeSlideAspectRatio("1:1"), /Unsupported/);
  const html = '<html><body><div data-presenton-slide-shell="true"></div></body></html>';
  assert.throws(() => buildStaticDeckHtml({ title: "Mixed", pages: [html, stampSlideFormat(html, "9:16")] }), /mix page sizes/);
});

for (const aspectRatio of Object.keys(SLIDE_FORMATS) as SlideAspectRatio[]) {
  test(`${aspectRatio}: requirements → manifest → static HTML → screenshots → edited HTML → PPTX / PDF`, { timeout: 180_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ppt-slide-format-"));
    const format = SLIDE_FORMATS[aspectRatio];
    const { width, height } = format;
    try {
      await mkdir(path.join(dir, "slides"));
      await writeFile(path.join(dir, "requirements.json"), JSON.stringify({ selections: { aspect_ratio: aspectRatio } }));
      const outline = {
        title: "Page size test", status: "confirmed" as const,
        items: PAGE_IDS.map((page_id) => ({ page_id, title: "Test", content: "Test", page_type: "standard", copy_rewrite_freedom: 3 })),
      };
      await rebuildWorkspaceDeckManifest({ workspace_dir: dir, outline: outline as never });
      for (const pageId of PAGE_IDS) {
        await writeFile(path.join(dir, "slides", `${pageId}.html`), `<!doctype html><html><head><style>
          *{box-sizing:border-box}body{margin:0}.slide{position:relative;width:${width}px;height:${height}px;background:#fff}
          .edge{position:absolute;right:0;bottom:0;width:80px;height:80px;background:#ff0000}
          </style></head><body><main class="slide"><div class="edge"></div></main></body></html>`);
      }
      const result = await buildDeckHtmlFromManifest({ manifestPath: path.join(dir, "manifest.json"), outputDir: path.join(dir, "output") });
      const deckHtml = await readFile(result.deckOutputPath, "utf8");
      assert.equal(slideFormatFromHtml(deckHtml).aspectRatio, aspectRatio);
      for (const screenshot of result.slideFiles) {
        const metadata = await sharp(screenshot.outputPath).metadata();
        assert.equal(metadata.width, width * 2);
        assert.equal(metadata.height, height * 2);
        const pixel = await sharp(screenshot.outputPath).extract({ left: width * 2 - 10, top: height * 2 - 10, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
        assert.deepEqual([...pixel], [255, 0, 0], "bottom-right content must survive without clipping");
      }
      const pageHtmlPaths = result.slideFiles.map((slide) => slide.outputPath.replace(/\.png$/, ".html"));
      const pageHtml = await readFile(pageHtmlPaths[0]!, "utf8");
      // Manual save takes the authoritative Workspace size, even if metadata is tampered with.
      const edited = await sanitizeManualPageHtml(dir, PAGE_IDS[0]!, stampSlideFormat(pageHtml, "4:3"));
      assert.equal(slideFormatFromHtml(edited.currentHtml).aspectRatio, aspectRatio);
      assert.match(edited.currentHtml, new RegExp(`width:${width}px;height:${height}px`));

      const pptxPath = path.join(dir, "deck.pptx");
      const exported = await convertDeckHtmlToPptx({ htmlPath: result.deckOutputPath, outputPath: pptxPath, title: "Page size test", expectedSlideCount: 2 });
      const zip = await JSZip.loadAsync(await readFile(exported.outputPath));
      const xml = await zip.file("ppt/presentation.xml")!.async("string");
      const size = /<p:sldSz\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(xml);
      assert.ok(size);
      assert.ok(Math.abs(Number(size[1]) - format.widthInches * 914400) <= 1);
      assert.ok(Math.abs(Number(size[2]) - format.heightInches * 914400) <= 1);
      assert.equal(Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 2);

      const pdfPath = path.join(dir, "deck.pdf");
      await createPdfFromSlideHtmlPaths(pageHtmlPaths, pdfPath);
      const pdf = (await readFile(pdfPath)).toString("latin1");
      const boxes = [...pdf.matchAll(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/g)];
      assert.equal(boxes.length, 2);
      for (const box of boxes) {
        assert.ok(Math.abs(Number(box[1]) - format.widthInches * 72) < 1);
        assert.ok(Math.abs(Number(box[2]) - format.heightInches * 72) < 1);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
