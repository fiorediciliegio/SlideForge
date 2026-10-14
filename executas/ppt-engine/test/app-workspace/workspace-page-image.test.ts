import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { createHash, randomInt } from "node:crypto";
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

/**
 * Mirrors an in-flight run: the second page has no screenshot yet, so the
 * generation page can only preview the page that already passed.
 */
async function createPartiallyRenderedWorkspace(homeDir: string) {
  const suffix = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const workspaceDir = path.join(homeDir, "slideforge-workspace", "ppt", `ppt-20260630-${suffix}`);
  const outputDir = path.join(workspaceDir, "output", "app-render");
  const htmlPath = path.join(outputDir, "slide-1.html");
  const firstScreenshotPath = path.join(outputDir, "slide-1.png");

  await mkdir(outputDir, { recursive: true });
  await writeFile(htmlPath, "<!doctype html><title>Slide A</title>", "utf8");
  await writeSlidePng(firstScreenshotPath, { r: 12, g: 24, b: 48 });

  const pageIds = [
    "page-11111111-1111-4111-8111-111111111111",
    "page-22222222-2222-4222-8222-222222222222",
  ];

  await mkdir(path.join(workspaceDir, "slides"));
  await writeFile(path.join(workspaceDir, "slides", `${pageIds[0]}.html`), '<html><body><div data-presenton-slide-shell="true">Slide A</div></body></html>');

  await writeJson(path.join(workspaceDir, "task.json"), {
    title: "Page image fixture",
    workspace_format: "html-authoring-v1",
    updated_at: "2026-06-30T00:00:00.000Z",
  });
  await writeJson(path.join(workspaceDir, "setting.json"), {});
  await writeJson(path.join(workspaceDir, "outline.json"), {
    version: 4,
    title: "Page image fixture",
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
    status: "running",
    final_deck_render: {
      status: "pending",
      message: null,
      error: null,
      output_dir: "",
      deck_html_path: "",
      rendered_at: null,
      updated_at: "2026-06-30T00:01:00.000Z",
    },
    pages: pageIds.map((pageId, index) => ({
      page_id: pageId,
      status: index === 0 ? "accepted" : "pending",
      render_attempts: 0,
      visual_review_attempts: 0,
      agent_failures: 0,
      agent_infrastructure_failures: 0,
      last_html_path: index === 0 ? htmlPath : "",
      last_screenshot_path: index === 0 ? firstScreenshotPath : "",
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
const homeDir = mkdtempSync(path.join(os.tmpdir(), "presenton-workspace-page-image-home-"));
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

test("HTML preview reads existing static artifacts and rejects a stale preview fingerprint", async () => {
  const { getAppWorkspacePageHtml } = await import("../../src/app-workspace/index.ts");
  const { workspaceDir, pageIds, firstScreenshotPath } = await createPartiallyRenderedWorkspace(homeDir);
  await rm(firstScreenshotPath);
  const first = await getAppWorkspacePageHtml({ workspace_dir: workspaceDir, page_id: pageIds[0] });
  const fingerprint = first.preview_source_fingerprint;
  const result = await getAppWorkspacePageHtml({ workspace_dir: workspaceDir, page_id: pageIds[0], expected_preview_fingerprint: fingerprint });
  assert.match(result.html, /Slide A/);
  assert.equal(result.preview_source_fingerprint, fingerprint);
  await assert.rejects(getAppWorkspacePageHtml({ workspace_dir: workspaceDir, page_id: pageIds[0], expected_preview_fingerprint: "old-version" }), /version changed/);
  await assert.rejects(getAppWorkspacePageHtml({ workspace_dir: workspaceDir, page_id: pageIds[1] }), /ENOENT/);
});

test("HTML preview migrates the latest manual revision into its source", async () => {
  const { getAppWorkspacePageHtml } = await import("../../src/app-workspace/index.ts");
  const { workspaceDir, pageIds, firstScreenshotPath } = await createPartiallyRenderedWorkspace(homeDir);
  const directory = path.join(workspaceDir, "manual-edits", pageIds[0]);
  await mkdir(directory, { recursive: true });
  const currentPath = path.join(directory, "current.html");
  await writeFile(currentPath, `<!doctype html><html><body><div data-presenton-slide-shell="true">用户修改后的内容</div></body></html>`);
  await writeJson(path.join(directory, "manifest.json"), { version: 1, page_id: pageIds[0], revision: 1,
    manually_edited: true, current_html_path: currentPath, screenshot_path: firstScreenshotPath });
  const result = await getAppWorkspacePageHtml({ workspace_dir: workspaceDir, page_id: pageIds[0] });
  assert.match(result.html, /用户修改后的内容/);
  assert.equal(result.html_path, await realpath(path.join(workspaceDir, "slides", `${pageIds[0]}.html`)));
});
