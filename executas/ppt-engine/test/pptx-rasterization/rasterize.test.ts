import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PPTX_RASTERIZATION_MAX_SLIDES,
  convertSvgToPng,
  rasterizePptxToImages,
} from "../../src/pptx-rasterization/index.ts";

async function makeTempDir() {
  return mkdtemp(path.join(os.tmpdir(), "pptx-rasterization-test-"));
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="white"/></svg>`;

test("convertSvgToPng writes a sharp PNG at the requested height", async () => {
  const dir = await makeTempDir();
  const outputPath = path.join(dir, "slide.png");

  try {
    const result = await convertSvgToPng({
      svg,
      outputPath,
      targetHeight: 1440,
    });

    assert.equal(result.width, 2560);
    assert.equal(result.height, 1440);
    assert.equal(result.sourceWidth, 1280);
    assert.equal(result.sourceHeight, 720);
    assert.match(await readFile(outputPath, "hex"), /^89504e470d0a1a0a/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const textSvg = (span: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><text x="20" y="90" font-family="sans-serif" font-size="40">X${span}Y</text></svg>`;

test("rasterization repairs pptx-svg script sizes without changing their rendered size or baseline", async () => {
  const dir = await makeTempDir();
  try {
    // "sub" also covers a normAutofit-scaled run, whose rendered size is smaller
    // than data-ooxml-font-size.
    for (const [shift, sourceSize, renderedSize] of [["super", 900, 9], ["sub", 1250, 9.375]] as const) {
      const span = `<tspan font-size="${renderedSize}" baseline-shift="${shift}" data-ooxml-font-size="${sourceSize}">2</tspan>`;
      // Exercise both attribute orders emitted around the absolute font size.
      const broken = shift === "super"
        ? span.replace(' data-ooxml', ' font-size="70%" data-ooxml')
        : span.replace('<tspan', '<tspan font-size="70%"');
      const originalSvg = textSvg(broken);
      const result = await rasterizePptxToImages({
        pptx_path: path.join(dir, "input.pptx"),
        output_dir: path.join(dir, shift),
        page_numbers: [13],
        target_height: 360,
      }, {
        loadPptxSvgSlides: async () => [{ svg: originalSvg, page_number: 13 }],
      });
      const expectedPath = path.join(dir, `${shift}-expected.png`);
      await convertSvgToPng({ svg: textSvg(span), outputPath: expectedPath, targetHeight: 360 });

      assert.equal(result.slides[0].page_number, 13);
      assert.deepEqual(await readFile(result.slides[0].image_path), await readFile(expectedPath));
      assert.equal(await readFile(result.slides[0].svg_path, "utf8"), originalSvg);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("convertSvgToPng preserves valid relative script sizes", async () => {
  const dir = await makeTempDir();
  try {
    const span = '<tspan font-size="70%" baseline-shift="super">2</tspan>';
    const expectedPath = path.join(dir, "expected.png");
    const actualPath = path.join(dir, "actual.png");
    await convertSvgToPng({ svg: textSvg(span), outputPath: expectedPath, targetHeight: 180 });
    await convertSvgToPng({
      svg: textSvg(span.replace('<tspan', '<tspan data-ooxml-font-size="900"')),
      outputPath: actualPath,
      targetHeight: 180,
    });
    assert.deepEqual(await readFile(actualPath), await readFile(expectedPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("convertSvgToPng still rejects duplicate attributes outside the known pptx-svg defect", async () => {
  const dir = await makeTempDir();
  try {
    const known = '<tspan font-size="9" baseline-shift="super" font-size="70%" data-ooxml-font-size="900">2</tspan>';
    for (const span of [
      known.replace(' baseline-shift="super"', ''),
      known.replace('baseline-shift="super"', 'baseline-shift="30%"'),
      known.replace('font-size="70%"', 'font-size="80%"'),
      known.replace('font-size="70%"', 'font-size="10"'),
      known.replace('<tspan', '<tspan font-size="8"'),
      known.replace('<tspan', '<tspan fill="red" fill="blue"'),
    ]) {
      await assert.rejects(convertSvgToPng({
        svg: textSvg(span),
        outputPath: path.join(dir, "invalid.png"),
        targetHeight: 180,
      }), /redefined|duplicate attribute/i);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rasterizePptxToImages writes SVG, PNG, and rasterization manifest", async () => {
  const dir = await makeTempDir();
  const pptxPath = path.join(dir, "input.pptx");
  const outputDir = path.join(dir, "out");
  await writeFile(pptxPath, "fake pptx", "utf8");

  try {
    const result = await rasterizePptxToImages(
      {
        pptx_path: pptxPath,
        output_dir: outputDir,
      },
      {
        now: () => new Date("2026-07-08T00:00:00.000Z"),
        loadPptxSvgSlides: async () => [{ svg }],
        convertSvgToPng: async ({ outputPath, targetHeight }) => {
          await writeFile(outputPath, "fake png", "utf8");
          return {
            width: 1280,
            height: targetHeight,
            sourceWidth: 1280,
            sourceHeight: 720,
          };
        },
      },
    );

    assert.equal(result.slide_count, 1);
    assert.equal(result.target_height, 720);
    assert.equal(path.basename(result.slides[0]?.svg_path ?? ""), "page-001.svg");
    assert.equal(path.basename(result.slides[0]?.image_path ?? ""), "page-001.png");
    assert.equal(await readFile(path.join(outputDir, "page-001.svg"), "utf8"), svg);
    assert.equal(await readFile(path.join(outputDir, "page-001.png"), "utf8"), "fake png");

    const manifest = JSON.parse(
      await readFile(path.join(outputDir, "rasterization-manifest.json"), "utf8"),
    ) as {
      created_at: string;
      source_pptx_path: string;
      target_height: number;
      slide_count: number;
      slides: Array<{ page_index: number; page_number: number; width: number; height: number }>;
    };
    assert.equal(manifest.created_at, "2026-07-08T00:00:00.000Z");
    assert.equal(manifest.source_pptx_path, pptxPath);
    assert.equal(manifest.target_height, 720);
    assert.equal(manifest.slide_count, 1);
    assert.deepEqual(manifest.slides[0], {
      page_index: 0,
      page_number: 1,
      image_path: path.join(outputDir, "page-001.png"),
      svg_path: path.join(outputDir, "page-001.svg"),
      width: 1280,
      height: 720,
      source_width: 1280,
      source_height: 720,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rasterizePptxToImages rejects unsupported file extensions before loading", async () => {
  const dir = await makeTempDir();
  const pptPath = path.join(dir, "legacy.ppt");
  await writeFile(pptPath, "fake ppt", "utf8");

  try {
    await assert.rejects(
      () => rasterizePptxToImages(
        {
          pptx_path: pptPath,
          output_dir: path.join(dir, "out"),
        },
        {
          loadPptxSvgSlides: async () => {
            throw new Error("should not load");
          },
        },
      ),
      /\.pptx files/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rasterizePptxToImages enforces the max slide count", async () => {
  const dir = await makeTempDir();
  const pptxPath = path.join(dir, "input.pptx");
  await writeFile(pptxPath, "fake pptx", "utf8");

  try {
    await assert.rejects(
      () => rasterizePptxToImages(
        {
          pptx_path: pptxPath,
          output_dir: path.join(dir, "out"),
        },
        {
          loadPptxSvgSlides: async () =>
            Array.from({ length: PPTX_RASTERIZATION_MAX_SLIDES + 1 }, () => ({ svg })),
        },
      ),
      /exceeds the rasterization limit/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rasterizePptxToImages refuses to overwrite generated files by default", async () => {
  const dir = await makeTempDir();
  const pptxPath = path.join(dir, "input.pptx");
  const outputDir = path.join(dir, "out");
  await writeFile(pptxPath, "fake pptx", "utf8");
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "page-001.png"), "existing", "utf8");

  try {
    await assert.rejects(
      () => rasterizePptxToImages(
        {
          pptx_path: pptxPath,
          output_dir: outputDir,
        },
        {
          loadPptxSvgSlides: async () => [{ svg }],
        },
      ),
      /output already exists/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rasterizePptxToImages refuses stale page files outside the current slide range", async () => {
  const dir = await makeTempDir();
  const pptxPath = path.join(dir, "input.pptx");
  const outputDir = path.join(dir, "out");
  await writeFile(pptxPath, "fake pptx", "utf8");
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "page-999.svg"), "stale", "utf8");

  try {
    await assert.rejects(
      () => rasterizePptxToImages(
        {
          pptx_path: pptxPath,
          output_dir: outputDir,
        },
        {
          loadPptxSvgSlides: async () => [{ svg }],
        },
      ),
      /page-999\.svg/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rasterizePptxToImages wraps PNG conversion failures with page and stage", async () => {
  const dir = await makeTempDir();
  const pptxPath = path.join(dir, "input.pptx");
  await writeFile(pptxPath, "fake pptx", "utf8");

  try {
    await assert.rejects(
      () => rasterizePptxToImages(
        {
          pptx_path: pptxPath,
          output_dir: path.join(dir, "out"),
        },
        {
          loadPptxSvgSlides: async () => [{ svg }],
          convertSvgToPng: async () => {
            throw new Error("sharp failed");
          },
        },
      ),
      /render_png for page 1: sharp failed/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
