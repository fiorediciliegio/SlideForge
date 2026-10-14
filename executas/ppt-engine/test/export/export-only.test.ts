import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

import {
  runExportOnly,
  type ExportOnlyDependencies,
} from "../../src/export-only/index.ts";

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-export-only-test-"));
  const sourceRoot = path.join(root, "source");
  const outputDir = path.join(root, "output");
  await mkdir(path.join(sourceRoot, "slides"), { recursive: true });
  await writeFile(path.join(sourceRoot, "deck.html"), "<html><body>deck</body></html>", "utf8");
  await writeFile(path.join(sourceRoot, "slides", "one.html"), "<html><body>one</body></html>", "utf8");
  await writeFile(path.join(sourceRoot, "slides", "two.html"), "<html><body>two</body></html>", "utf8");
  return { root, sourceRoot, outputDir };
}

function dependencies(
  overrides: Partial<ExportOnlyDependencies> = {},
): ExportOnlyDependencies {
  return {
    async convertDeckHtmlToPptx(input) {
      await writeFile(`${input.outputPath}.tmp`, "pptx-data", "utf8");
      return {
        outputPath: `${input.outputPath}.tmp`,
        slideCount: input.expectedSlideCount ?? 0,
        sizeBytes: 9,
        warningCount: 1,
        fontEmbedWarnings: ["Missing Font (regular): unavailable"],
      };
    },
    async createPdfFromSlideHtmlPaths(_slideHtmlPaths, pdfPath, _timeoutMs) {
      await writeFile(pdfPath, "pdf-data", "utf8");
    },
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

test("export-only routes a fixed Deck HTML through the production PPTX dependency", async () => {
  const fixture = await createFixture();
  const calls: unknown[] = [];
  try {
    const result = await runExportOnly({
      request_id: "pptx-attempt-001",
      format: "pptx",
      source_root: fixture.sourceRoot,
      deck_html_file: "deck.html",
      expected_slide_count: 2,
      title: "Export Eval",
      output_dir: fixture.outputDir,
      timeout_ms: 600_000,
    }, dependencies({
      async convertDeckHtmlToPptx(input) {
        calls.push(input);
        await writeFile(`${input.outputPath}.tmp`, "pptx-data", "utf8");
        return {
          outputPath: `${input.outputPath}.tmp`,
          slideCount: 2,
          sizeBytes: 9,
          warningCount: 1,
          fontEmbedWarnings: ["Missing Font (regular): unavailable"],
        };
      },
    }));

    assert.equal(result.status, "completed");
    assert.equal(result.format, "pptx");
    assert.equal(result.slide_count, 2);
    assert.equal(result.output_path, path.join(fixture.outputDir, "pptx-attempt-001.pptx"));
    assert.equal(await readFile(result.output_path!, "utf8"), "pptx-data");
    assert.equal(result.warning_count, 2);
    assert.deepEqual(calls, [{
      htmlPath: path.join(fixture.sourceRoot, "deck.html"),
      outputPath: path.join(fixture.outputDir, "pptx-attempt-001.pptx"),
      title: "Export Eval",
      expectedSlideCount: 2,
      timeoutMs: 600_000,
    }]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("export-only normalizes and forwards a selected PPTX page range", async () => {
  const fixture = await createFixture();
  const calls: unknown[] = [];
  try {
    const result = await runExportOnly({
      request_id: "pptx-pages-002-003",
      format: "pptx",
      source_root: fixture.sourceRoot,
      deck_html_file: "deck.html",
      expected_slide_count: 3,
      page_numbers: [3, 2, 2],
      output_dir: fixture.outputDir,
    }, dependencies({
      async convertDeckHtmlToPptx(input) {
        calls.push(input);
        await writeFile(`${input.outputPath}.tmp`, "pptx-data", "utf8");
        return {
          outputPath: `${input.outputPath}.tmp`,
          slideCount: input.pageNumbers?.length ?? 0,
          sizeBytes: 9,
          warningCount: 0,
          fontEmbedWarnings: [],
        };
      },
    }));

    assert.equal(result.status, "completed");
    assert.equal(result.slide_count, 2);
    assert.deepEqual(calls, [{
      htmlPath: path.join(fixture.sourceRoot, "deck.html"),
      outputPath: path.join(fixture.outputDir, "pptx-pages-002-003.pptx"),
      title: "pptx-pages-002-003",
      expectedSlideCount: 3,
      pageNumbers: [2, 3],
      timeoutMs: 600_000,
    }]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("export-only routes ordered slide HTML files through the production PDF dependency", async () => {
  const fixture = await createFixture();
  const calls: unknown[] = [];
  try {
    const result = await runExportOnly({
      request_id: "pdf-attempt-001",
      format: "pdf",
      source_root: fixture.sourceRoot,
      deck_html_file: "deck.html",
      slide_html_files: ["slides/one.html", "slides/two.html"],
      expected_slide_count: 2,
      output_dir: fixture.outputDir,
    }, dependencies({
      async createPdfFromSlideHtmlPaths(slideHtmlPaths, pdfPath, timeoutMs) {
        calls.push({ slideHtmlPaths, pdfPath, timeoutMs });
        await writeFile(pdfPath, "pdf-data", "utf8");
      },
    }));

    assert.equal(result.status, "completed");
    assert.equal(result.format, "pdf");
    assert.equal(result.slide_count, 2);
    assert.equal(await readFile(result.output_path!, "utf8"), "pdf-data");
    assert.deepEqual(calls, [{
      slideHtmlPaths: [
        path.join(fixture.sourceRoot, "slides", "one.html"),
        path.join(fixture.sourceRoot, "slides", "two.html"),
      ],
      pdfPath: path.join(fixture.outputDir, "pdf-attempt-001.pdf.tmp"),
      timeoutMs: 600_000,
    }]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("export-only reports conversion failures and removes only its temporary artifact", async () => {
  const fixture = await createFixture();
  const previousArtifact = path.join(fixture.root, "previous-success.pptx");
  await writeFile(previousArtifact, "previous", "utf8");
  try {
    const result = await runExportOnly({
      request_id: "failed-attempt",
      format: "pptx",
      source_root: fixture.sourceRoot,
      deck_html_file: "deck.html",
      expected_slide_count: 2,
      output_dir: fixture.outputDir,
    }, dependencies({
      async convertDeckHtmlToPptx(input) {
        await writeFile(`${input.outputPath}.tmp`, "partial", "utf8");
        throw new Error("synthetic conversion failure");
      },
    }));

    assert.equal(result.status, "failed");
    assert.equal(result.phase, "convert");
    assert.equal(result.error?.message, "synthetic conversion failure");
    await assert.rejects(stat(path.join(fixture.outputDir, "failed-attempt.pptx.tmp")), /ENOENT/u);
    assert.equal(await readFile(previousArtifact, "utf8"), "previous");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("export-only rejects source paths that escape source_root", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      runExportOnly({
        request_id: "unsafe-attempt",
        format: "pptx",
        source_root: fixture.sourceRoot,
        deck_html_file: "../outside.html",
        expected_slide_count: 1,
        output_dir: fixture.outputDir,
      }, dependencies()),
      /inside source_root/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
