import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SLIDE_FORMATS, slideFormatFromHtml } from "../../src/slide-format.js";

test("page size persists through requirements and source uploads, and cannot change after authoring", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-format-requirements-"));
  const previous = process.env.ANNA_WORKSPACE_DIR;
  process.env.ANNA_WORKSPACE_DIR = root;
  const api = await import("../../src/app-workspace/index.js");
  try {
    for (const aspect_ratio of Object.keys(SLIDE_FORMATS)) {
      const workspace = await api.createAppWorkspace({ title: aspect_ratio });
      const empty = await api.getAppWorkspaceRequirements({ workspace_dir: workspace.workspace_dir });
      await api.updateAppWorkspaceRequirements({ workspace_dir: workspace.workspace_dir,
        requirements: { ...empty, selections: { ...empty.selections, aspect_ratio } } });
      const saved = await api.getAppWorkspaceRequirements({ workspace_dir: workspace.workspace_dir });
      assert.equal(saved.selections.aspect_ratio, aspect_ratio);
      const requirements = { ...saved, status: "confirmed", source: { brief: "Test" },
        candidates: { slide_count: [1], output_language: ["中文"] },
        selections: { ...saved.selections, slide_count: 1, output_language: "中文" },
        research: { web: { recommended: false, enabled: false, reason: "" }, images: { recommended: false, enabled: false, reason: "" } } };
      await api.updateAppWorkspaceRequirements({ workspace_dir: workspace.workspace_dir, requirements });
      const confirmed = await api.confirmAppWorkspaceOutline({ workspace_dir: workspace.workspace_dir,
        outline: { title: "Test", items: [{ title: "Test", content: "Test", page_type: "standard" }] } });
      const pageId = (confirmed.outline as { items: { page_id: string }[] }).items[0]!.page_id;
      const staging = path.join(root, "upload.html");
      const source = "<!doctype html><html><body><div class=slide>Test</div></body></html>";
      await writeFile(staging, source);
      const uploaded = await api.recordAppWorkspacePageHtml({ workspace_dir: workspace.workspace_dir, page_id: pageId,
        staging_file_path: staging, expected_size_bytes: Buffer.byteLength(source) });
      const html = await readFile(uploaded.path, "utf8");
      assert.equal(slideFormatFromHtml(html).aspectRatio, aspect_ratio);
      assert.equal(uploaded.size_bytes, Buffer.byteLength(html));
      await assert.rejects(api.updateAppWorkspaceRequirements({ workspace_dir: workspace.workspace_dir,
        requirements: { ...requirements, selections: { ...requirements.selections, aspect_ratio: aspect_ratio === "16:9" ? "9:16" : "16:9" } } }), /Page size is fixed/);
    }
    const workspace = await api.createAppWorkspace({ title: "Personal template" });
    const preset = { id: "user-format", version: 1, name: "Personal", description: "Reference" };
    const empty = await api.getAppWorkspaceRequirements({ workspace_dir: workspace.workspace_dir });
    const requirements = { ...empty, status: "confirmed", source: { brief: "Test" },
      candidates: { slide_count: [1], output_language: ["中文"] },
      selections: { slide_count: 1, output_language: "中文", aspect_ratio: "9:16", visual_style_preset: preset },
      research: { web: { recommended: false, enabled: false, reason: "" }, images: { recommended: false, enabled: false, reason: "" } } };
    const master = '<!doctype html><html><body><div class="slide">{{PAGE_CONTENT}}</div></body></html>';
    const snapshot = JSON.stringify({ version: 1, preset, visual_master_html: master,
      reference_html_pages: [{ path: "html/1.html", description: "Reference", html: master }] });
    const snapshotPath = path.join(root, "snapshot.json");
    await writeFile(snapshotPath, snapshot);
    await api.confirmAppWorkspaceRequirements({ workspace_dir: workspace.workspace_dir, requirements,
      template_reference_staging_file_path: snapshotPath, template_reference_expected_size_bytes: Buffer.byteLength(snapshot) });
    await assert.rejects(readFile(path.join(workspace.workspace_dir, "visual-master.html")), { code: "ENOENT" });
    assert.match(await readFile(path.join(workspace.workspace_dir, "template-reference/html/1.html"), "utf8"), /PAGE_CONTENT/);
    await mkdir(path.join(workspace.workspace_dir, "slides"), { recursive: true });
    await writeFile(path.join(workspace.workspace_dir, "slides", "existing.html"), master);
    await assert.rejects(api.confirmAppWorkspaceRequirements({ workspace_dir: workspace.workspace_dir,
      requirements: { ...requirements, selections: { ...requirements.selections, aspect_ratio: "4:3" } },
      template_reference_staging_file_path: snapshotPath, template_reference_expected_size_bytes: Buffer.byteLength(snapshot) }), /Page size is fixed/);
  } finally {
    if (previous === undefined) delete process.env.ANNA_WORKSPACE_DIR;
    else process.env.ANNA_WORKSPACE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
