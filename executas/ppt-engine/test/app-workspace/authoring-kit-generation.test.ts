import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function candidate(label: string) {
  return { label, description: `${label} description` };
}

test("authoring-kit-v1 persists style guide, Page Sources, and minimal Page Progress", async () => {
  const previousHome = process.env.HOME;
  const previousWorkspaceRoot = process.env.ANNA_WORKSPACE_DIR;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "ppt-authoring-generation-home-"));
  process.env.HOME = homeDir;
  process.env.ANNA_WORKSPACE_DIR = path.join(homeDir, "anna-workspace");
  const api = await import("../../src/app-workspace/index.ts");
  const kit = await import("../../src/authoring-kit-workspace/index.ts");
  try {
    const created = await api.createAppWorkspace({ title: "Authoring generation" });
    const task = JSON.parse(await readFile(path.join(created.workspace_dir, "task.json"), "utf8"));
    assert.equal(task.workspace_format, "authoring-kit-v1");
    await assert.rejects(() => readFile(path.join(created.workspace_dir, "pages.json"), "utf8"), /ENOENT/);
    await assert.rejects(() => readFile(path.join(created.workspace_dir, "page-plan.json"), "utf8"), /ENOENT/);
    const legacyDir = path.join(homeDir, "anna-workspace", "ppt", "ppt-20260718-000001");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, "task.json"), `${JSON.stringify({ title: "Legacy" })}\n`, "utf8");
    await assert.rejects(
      api.openAppWorkspace({ workspace_dir: legacyDir }),
      /legacy Workspace migration is not available/,
    );

    const requirements = {
      version: 1 as const,
      status: "confirmed" as const,
      source: { brief: "Create a concise product strategy presentation." },
      candidates: {
        slide_count: [2],
        output_language: ["简体中文"],
      },
      selections: {
        slide_count: 2,
        output_language: "简体中文",
      },
      updated_at: null,
      confirmed_at: null,
    };
    await api.updateAppWorkspaceRequirements({ workspace_dir: created.workspace_dir, requirements });
    const confirmed = await api.confirmAppWorkspaceOutline({
      workspace_dir: created.workspace_dir,
      outline: {
        title: "Product strategy",
        items: [
          { title: "Choice", content: "Explain the choice" },
          { title: "Action", content: "State the action" },
        ],
      },
    });
    const firstPageIds = (confirmed.outline as { items: Array<{ page_id: string }> }).items.map((item) => item.page_id);

    await kit.installWorkspaceAuthoringKit({ workspace_dir: created.workspace_dir });
    const stagingPath = path.join(homeDir, "style-guide.md");
    const markdown = "# 艺术指导\n\n使用 #112233 作为主文字色。\n";
    await writeFile(stagingPath, markdown, "utf8");
    const recorded = await api.recordAppWorkspaceStyleGuide({
      workspace_dir: created.workspace_dir,
      staging_file_path: stagingPath,
      expected_size_bytes: Buffer.byteLength(markdown),
    });
    assert.equal(recorded.size_bytes, Buffer.byteLength(markdown));
    assert.equal((await api.getAppWorkspaceStyleGuideStatus({ workspace_dir: created.workspace_dir })).non_empty, true);

    const reconfirmed = await api.confirmAppWorkspaceOutline({
      workspace_dir: created.workspace_dir,
      outline: {
        title: "Product strategy",
        items: [
          { title: "Choice", content: "Explain the choice" },
          { title: "Action", content: "State the action" },
        ],
      },
    });
    const pageIds = (reconfirmed.outline as { items: Array<{ page_id: string }> }).items.map((item) => item.page_id);
    assert.notDeepEqual(pageIds, firstPageIds);
    assert.equal((await api.getAppWorkspaceStyleGuideStatus({ workspace_dir: created.workspace_dir })).non_empty, true);

    const prepared = await kit.prepareWorkspacePageSources({
      workspace_dir: created.workspace_dir,
      reset_existing: true,
    });
    assert.deepEqual(prepared.manifest.slides.map((slide) => slide.id), pageIds);
    const progress = await api.initializeAppPageProgress({ workspace_dir: created.workspace_dir });
    assert.deepEqual(progress.pages.map((page) => Object.keys(page).sort()), progress.pages.map(() => [
      "agent_failures",
      "agent_infrastructure_failures",
      "last_error",
      "last_html_path",
      "last_screenshot_path",
      "page_id",
      "render_attempts",
      "status",
      "updated_at",
      "visual_review",
      "visual_review_attempts",
    ].sort()));
    assert.deepEqual(progress.pages.map((page) => page.page_id), pageIds);

    await api.saveAppWorkspaceOutlineDraft({
      workspace_dir: created.workspace_dir,
      outline: {
        title: "Changed product strategy",
        items: [
          { title: "Choice", content: "Explain the choice" },
          { title: "Action", content: "State the action" },
        ],
      },
    });
    assert.equal((await api.getAppWorkspaceStyleGuideStatus({ workspace_dir: created.workspace_dir })).exists, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousWorkspaceRoot === undefined) delete process.env.ANNA_WORKSPACE_DIR;
    else process.env.ANNA_WORKSPACE_DIR = previousWorkspaceRoot;
    await rm(homeDir, { recursive: true, force: true });
  }
});
