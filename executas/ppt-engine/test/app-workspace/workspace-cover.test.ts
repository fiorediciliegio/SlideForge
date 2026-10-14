import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { randomInt } from "node:crypto";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeSlidePng(filePath: string, background: { r: number; g: number; b: number }) {
  const png = await sharp({
    create: { width: 1600, height: 900, channels: 3, background },
  })
    .png()
    .toBuffer();
  await writeFile(filePath, png);
}

async function createRenderedWorkspace(homeDir: string) {
  const suffix = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const workspaceDir = path.join(homeDir, "slideforge-workspace", "ppt", `ppt-20260630-${suffix}`);
  const outputDir = path.join(workspaceDir, "output", "app-render");
  const htmlPath = path.join(outputDir, "slide-1.html");
  const firstScreenshotPath = path.join(outputDir, "slide-1.png");
  const secondScreenshotPath = path.join(outputDir, "slide-2.png");

  await mkdir(outputDir, { recursive: true });
  await writeFile(htmlPath, "<!doctype html><title>Slide A</title>", "utf8");
  await writeSlidePng(firstScreenshotPath, { r: 12, g: 24, b: 48 });
  await writeSlidePng(secondScreenshotPath, { r: 200, g: 40, b: 40 });

  const pageIds = [
    "page-11111111-1111-4111-8111-111111111111",
    "page-22222222-2222-4222-8222-222222222222",
  ];

  await mkdir(path.join(workspaceDir, "slides"));
  await writeFile(path.join(workspaceDir, "slides", `${pageIds[0]}.html`), '<html><body><div data-presenton-slide-shell="true">Slide A</div></body></html>');

  await writeJson(path.join(workspaceDir, "task.json"), {
    title: "Cover fixture",
    workspace_format: "html-authoring-v1",
    updated_at: "2026-06-30T00:00:00.000Z",
  });
  await writeJson(path.join(workspaceDir, "setting.json"), {});
  await writeJson(path.join(workspaceDir, "outline.json"), {
    version: 4,
    title: "Cover fixture",
    status: "confirmed",
    items: pageIds.map((pageId, index) => ({
      page_id: pageId,
      page_type: index === 0 ? "cover" : "standard",
      title: `Slide ${index + 1}`,
      content: "Render the page.",
    })),
    updated_at: "2026-06-30T00:00:00.000Z",
    confirmed_at: "2026-06-30T00:00:00.000Z",
  });
  await writeJson(path.join(workspaceDir, "manifest.json"), {
    title: "Fixture Deck",
    slides: pageIds.map((pageId) => ({ id: pageId, source: `./slides/${pageId}.html` })),
  });
  await writeJson(path.join(workspaceDir, "page-progress.json"), {
    version: 1,
    status: "completed",
    final_deck_render: {
      status: "completed",
      message: null,
      error: null,
      output_dir: outputDir,
      deck_html_path: htmlPath,
      rendered_at: "2026-06-30T00:01:00.000Z",
      updated_at: "2026-06-30T00:01:00.000Z",
    },
    pages: pageIds.map((pageId, index) => ({
      page_id: pageId,
      status: "accepted",
      render_attempts: 0,
      visual_review_attempts: 0,
      agent_failures: 0,
      agent_infrastructure_failures: 0,
      last_html_path: htmlPath,
      last_screenshot_path: index === 0 ? firstScreenshotPath : secondScreenshotPath,
      last_error: "",
      visual_review: null,
      updated_at: "2026-06-30T00:01:00.000Z",
    })),
    updated_at: "2026-06-30T00:01:00.000Z",
  });

  return { workspaceDir, firstScreenshotPath, pageIds };
}

// The workspace root is resolved from HOME once per module load, so every test
// in this file shares one temporary home.
const previousHome = process.env.HOME;
const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
const homeDir = mkdtempSync(path.join(os.tmpdir(), "presenton-workspace-cover-home-"));
process.env.HOME = homeDir;
process.env.SLIDEFORGE_WORKSPACE_DIR = path.join(homeDir, "slideforge-workspace");

test.after(async () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
    if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
    else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
  }
  await rm(homeDir, { recursive: true, force: true });
});

test("workspace cover reads first-page HTML without a screenshot or any image cache", async () => {
  const { getAppWorkspacePageHtml } = await import("../../src/app-workspace/index.ts");
  const { workspaceDir, firstScreenshotPath, pageIds } = await createRenderedWorkspace(homeDir);
  await rm(firstScreenshotPath);
  const cover = await getAppWorkspacePageHtml({ workspace_dir: workspaceDir });
  assert.equal(cover.page_id, pageIds[0]);
  assert.match(cover.html, /Slide/);
  await assert.rejects(stat(path.join(workspaceDir, "output", "covers")), { code: "ENOENT" });
  await writeFile(cover.html_path, `<!doctype html><html><body><div data-presenton-slide-shell="true">Updated cover</div></body></html>`);
  const updated = await getAppWorkspacePageHtml({ workspace_dir: workspaceDir });
  assert.notEqual(updated.preview_source_fingerprint, cover.preview_source_fingerprint);
  assert.match(updated.html, /Updated cover/);
});

test("cover and first-page thumbnail share a WebP; manual revisions replace the same page cache", async () => {
  const { getAppWorkspacePageThumbnail, getAppWorkspacePageHtml } = await import("../../src/app-workspace/index.ts");
  const { ensurePageThumbnail } = await import("../../src/page-html-preview/thumbnail.ts");
  const { workspaceDir, firstScreenshotPath, pageIds } = await createRenderedWorkspace(homeDir);
  await rm(firstScreenshotPath);
  const page = await getAppWorkspacePageHtml({ workspace_dir: workspaceDir });
  const capture = async (slides: Array<{ outputPath: string }>) => {
    await sharp({ create: { width: 640, height: 360, channels: 3, background: "green" } }).webp().toFile(slides[0].outputPath);
  };
  const seed = await ensurePageThumbnail({ workspaceDir, pageId: pageIds[0], htmlPath: page.html_path }, capture);
  const cover = await getAppWorkspacePageThumbnail({ workspace_dir: workspaceDir });
  const thumbnail = await getAppWorkspacePageThumbnail({ workspace_dir: workspaceDir, page_id: pageIds[0] });
  assert.equal(cover.image_path, thumbnail.image_path);
  assert.equal(cover.image_path, seed.image_path);
  const manualDir = path.join(workspaceDir, "manual-edits", pageIds[0]);
  const manualHtml = path.join(manualDir, "current.html");
  await mkdir(manualDir, { recursive: true });
  await writeFile(manualHtml, `<html><body><div data-presenton-slide-shell="true">Edited page</div></body></html>`);
  await writeJson(path.join(manualDir, "manifest.json"), { version: 1, page_id: pageIds[0], revision: 1,
    manually_edited: true, current_html_path: manualHtml, base_html_path: page.html_path });
  await ensurePageThumbnail({ workspaceDir, pageId: pageIds[0], htmlPath: manualHtml }, capture);
  const updated = await getAppWorkspacePageThumbnail({ workspace_dir: workspaceDir });
  assert.notEqual(updated.preview_source_fingerprint, cover.preview_source_fingerprint);
  await assert.rejects(stat(cover.image_path), { code: "ENOENT" });
});
