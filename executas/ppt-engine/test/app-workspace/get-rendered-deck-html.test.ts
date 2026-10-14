import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomInt } from "node:crypto";
import os from "node:os";
import path from "node:path";

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function createRenderedWorkspace(homeDir: string) {
  const suffix = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const workspaceDir = path.join(homeDir, "slideforge-workspace", "ppt", `ppt-20260630-${suffix}`);
  const outputDir = path.join(workspaceDir, "output", "app-render");
  const manifestPath = path.join(workspaceDir, "manifest.json");
  const htmlPath = path.join(outputDir, "slide-1.html");
  const screenshotPath = path.join(outputDir, "slide-1.png");

  await mkdir(outputDir, { recursive: true });
  await writeFile(htmlPath, "<!doctype html><title>Slide A</title>", "utf8");
  await writeFile(screenshotPath, "png fixture", "utf8");
  await mkdir(path.join(workspaceDir, "slides"));
  await writeFile(path.join(workspaceDir, "slides", "page-11111111-1111-4111-8111-111111111111.html"), '<html><body><div data-presenton-slide-shell="true">Slide A</div></body></html>');
  await writeJson(path.join(workspaceDir, "task.json"), {
    title: "Cached render fixture",
    workspace_format: "html-authoring-v1",
    updated_at: "2026-06-30T00:00:00.000Z",
  });
  await writeJson(path.join(workspaceDir, "setting.json"), {});
  await writeJson(path.join(workspaceDir, "outline.json"), {
    version: 4,
    title: "Cached render fixture",
    status: "confirmed",
    items: [{ page_id: "page-11111111-1111-4111-8111-111111111111", title: "Slide A", page_type: "standard", content: "Render the cached page." }],
    updated_at: "2026-06-30T00:00:00.000Z",
    confirmed_at: "2026-06-30T00:00:00.000Z",
  });
  await writeJson(manifestPath, {
    title: "Fixture Deck",
    slides: [{ id: "page-11111111-1111-4111-8111-111111111111", title: "Slide A", source: "./slides/page-11111111-1111-4111-8111-111111111111.html" }],
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
      updated_at: "2026-06-30T00:01:00.000Z"
    },
    pages: [
      {
        page_id: "page-11111111-1111-4111-8111-111111111111",
        status: "accepted",
        render_attempts: 0,
        visual_review_attempts: 0,
        agent_failures: 0,
        agent_infrastructure_failures: 0,
        last_html_path: htmlPath,
        last_screenshot_path: screenshotPath,
        last_error: "",
        visual_review: null,
        updated_at: "2026-06-30T00:01:00.000Z"
      },
    ],
    updated_at: "2026-06-30T00:01:00.000Z",
  });

  return { workspaceDir, screenshotPath };
}

test("getRenderedAppWorkspaceDeckHtml reads complete HTML pages even when screenshots are missing", async () => {
  const previousHome = process.env.HOME;
  const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "presenton-get-rendered-home-"));
  process.env.HOME = homeDir;
  process.env.SLIDEFORGE_WORKSPACE_DIR = path.join(homeDir, "slideforge-workspace");

  try {
    const { getRenderedAppWorkspaceDeckHtml, prepareAppWorkspacePagePreview,
      getAppWorkspacePagePreviewPreparation } = await import("../../src/app-workspace/index.ts");
    const { workspaceDir } = await createRenderedWorkspace(homeDir);

    const rendered = await getRenderedAppWorkspaceDeckHtml({ workspace_dir: workspaceDir });

    assert.equal(rendered.title, "Fixture Deck");
    assert.equal(rendered.slide_count, 1);
    assert.equal(rendered.slides[0]?.slide_id, "page-11111111-1111-4111-8111-111111111111");
    assert.equal(rendered.slides[0]?.screenshot_path, "");
    assert.match(rendered.slides[0]?.preview_source_fingerprint ?? "", /^[a-f0-9]{64}$/);

    const task = await readJson<{ updated_at: string }>(path.join(workspaceDir, "task.json"));
    assert.equal(task.updated_at, "2026-06-30T00:00:00.000Z");

    const missing = await createRenderedWorkspace(homeDir);
    await rm(missing.screenshotPath, { force: true });

    const withoutPng = await getRenderedAppWorkspaceDeckHtml({ workspace_dir: missing.workspaceDir });
    assert.equal(withoutPng.slide_count, 1);

    // Cloud restore discards output/. Listing the complete page order must be
    // independent of staticization, including when every snapshot is gone.
    await rm(path.join(workspaceDir, "output"), { recursive: true });
    const partial = await getRenderedAppWorkspaceDeckHtml({ workspace_dir: workspaceDir, allow_partial: true });
    assert.equal(partial.slide_count, 1);
    assert.equal(partial.slides[0]?.title, "Slide A");
    assert.equal(partial.slides[0]?.preview_unavailable, true);
    assert.equal(partial.slides[0]?.html_path, "");
    await assert.rejects(readFile(path.join(workspaceDir, "output", "app-render", "slide-1.html")), { code: "ENOENT" });
    const progressPath = path.join(workspaceDir, "page-progress.json");
    const progressBefore = await readFile(progressPath, "utf8");
    const submitted = await prepareAppWorkspacePagePreview({ workspace_dir: workspaceDir,
      page_id: partial.slides[0].slide_id });
    let state = submitted;
    for (let attempt = 0; attempt < 50 && state.status !== "ready" && state.status !== "error"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = getAppWorkspacePagePreviewPreparation({ workspace_dir: workspaceDir, task_id: submitted.task_id });
    }
    assert.equal(state.status, "ready", state.error);
    assert.equal(await readFile(progressPath, "utf8"), progressBefore);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
      if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
      else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
    }
    await rm(homeDir, { recursive: true, force: true });
  }
});
