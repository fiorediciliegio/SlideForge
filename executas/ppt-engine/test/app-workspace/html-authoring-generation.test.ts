import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractSlideShell, replaceSinglePageSlideShell } from "../../src/manual-page-revisions/index.ts";
import { convertDeckHtmlToPptx } from "../../src/pptx-export/dom-to-pptx.ts";

function candidate(label: string) {
  return { label, description: `${label} description` };
}

test("html-authoring-v1 initializes Page Progress from the Visual Master and HTML Page Sources", async () => {
  const previousHome = process.env.HOME;
  const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "ppt-html-authoring-generation-home-"));
  process.env.HOME = homeDir;
  process.env.SLIDEFORGE_WORKSPACE_DIR = path.join(homeDir, "slideforge-workspace");
  const api = await import("../../src/app-workspace/index.ts");
  const kit = await import("../../src/authoring-kit-workspace/index.ts");

  try {
    const created = await api.createAppWorkspace({ title: "HTML generation" });
    await api.updateAppWorkspaceRequirements({
      workspace_dir: created.workspace_dir,
      requirements: {
        version: 1,
        status: "confirmed",
        source: { brief: "Create a concise strategy presentation." },
        candidates: {
          slide_count: [1],
          output_language: ["简体中文"],
        },
        selections: {
          slide_count: 1,
          output_language: "简体中文",
        },
        research: {
          web: { recommended: false, reason: "Not required.", enabled: false },
          images: { recommended: false, reason: "Not required.", enabled: false },
        },
        updated_at: null,
        confirmed_at: null,
      },
    });
    const confirmed = await api.confirmAppWorkspaceOutline({
      workspace_dir: created.workspace_dir,
      outline: {
        title: "Strategy",
        items: [{
          page_type: "standard",
          title: "Decision",
          content: "Decision owner\nNext action",
        }],
      },
    });
    const pageId = (confirmed.outline as { items: Array<{ page_id: string }> }).items[0]!.page_id;

    const visualMasterPath = path.join(homeDir, "visual-master.html");
    const visualMaster = "<!doctype html><html><body><div class=slide>{{PAGE_CONTENT}}</div></body></html>";
    await writeFile(visualMasterPath, visualMaster, "utf8");
    await api.recordAppWorkspaceVisualMasterHtml({
      workspace_dir: created.workspace_dir,
      staging_file_path: visualMasterPath,
      expected_size_bytes: Buffer.byteLength(visualMaster),
    });

    await kit.prepareWorkspacePageSources({ workspace_dir: created.workspace_dir, reset_existing: true });
    const progress = await api.initializeAppPageProgress({ workspace_dir: created.workspace_dir });
    assert.equal(progress.status, "running");
    assert.deepEqual(progress.pages.map((page) => page.page_id), [pageId]);
    assert.equal(progress.pages[0]?.status, "pending");

    const pageSourcePath = path.join(homeDir, "page.html");
    const pageSource = "<!doctype html><html><body><div class=slide>Decision</div></body></html>";
    await writeFile(pageSourcePath, pageSource, "utf8");
    await api.recordAppWorkspacePageHtml({
      workspace_dir: created.workspace_dir,
      page_id: pageId,
      staging_file_path: pageSourcePath,
      expected_size_bytes: Buffer.byteLength(pageSource),
    });

    const submitted = await api.renderAppWorkspacePagePreview({
      workspace_dir: created.workspace_dir,
      page_id: pageId,
    });
    assert.equal(submitted.status, "queued");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const latest = await api.getAppPageProgress({ workspace_dir: created.workspace_dir });
      const page = latest.pages[0];
      if (page?.status === "rendered") {
        assert.match(page.last_html_path, /page-preview-html/);
        assert.match(page.last_screenshot_path, /screenshots/);
        const editContext = await api.getAppPageEditContext({
          workspace_dir: created.workspace_dir,
          page_id: pageId,
        });
        assert.equal(editContext.manually_edited, false);
        assert.equal(editContext.html_path, page.last_html_path);
        assert.match(editContext.html, /data-presenton-slide-shell/);
        assert.ok(!("agent_html_path" in editContext));
        assert.equal(await readFile(path.join(created.workspace_dir, "slides", `${pageId}.html`), "utf8"), pageSource);
        await api.recordAppPageProgress({ workspace_dir: created.workspace_dir, page_id: pageId, patch: { status: "layout_checking" } });
        const auditInput = { workspace_dir: created.workspace_dir, page_id: pageId, expected_source_sha256: submitted.source_sha256 };
        await assert.rejects(() => api.auditAppWorkspacePageLayout({ ...auditInput, expected_source_sha256: "stale" }), /changed during layout audit/);
        const audit = await api.auditAppWorkspacePageLayout(auditInput);
        assert.equal(audit.source_html_path, await realpath(path.join(created.workspace_dir, "slides", `${pageId}.html`)));
        assert.equal(await readFile(audit.source_html_path, "utf8"), pageSource);
        assert.equal(audit.screenshot_path, await realpath(page.last_screenshot_path));
        const report = JSON.parse(await readFile(audit.report_path, "utf8"));
        assert.deepEqual(report.viewport, { width: 1920, height: 1080 });
        assert.equal(audit.error_count, report.summary.errorCount);
        assert.equal(audit.warning_count, report.summary.warningCount);
        assert.equal((await api.getAppPageProgress({ workspace_dir: created.workspace_dir })).pages[0]?.status, "layout_checking");

        // Exercise the durable manual HTML through real render, export and restore.
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        const shell = extractSlideShell(editContext.html).shell.replace(
          ">", `><p style="position:absolute;left:40px;top:40px;font:32px Arial">Manual round trip</p><img style="position:absolute;left:40px;top:100px;width:40px;height:40px" src="data:image/png;base64,${png}">`,
        );
        const manual = replaceSinglePageSlideShell(editContext.html, shell);
        const staging = path.join(homeDir, "manual.html");
        await writeFile(staging, manual);
        const saveInput = { workspace_dir: created.workspace_dir, page_id: pageId, base_revision: 0,
          staging_file_path: staging, expected_size_bytes: Buffer.byteLength(manual) };
        await api.recordAppPageProgress({ workspace_dir: created.workspace_dir, page_id: pageId, patch: { status: "accepted" } });
        const saved = await api.saveAppManualPageRevision(saveInput);
        const persisted = await readFile(saved.manifest.current_html_path, "utf8");
        assert.match(persisted, /Manual round trip/);
        assert.match(persisted, /file:\/\//);
        assert.doesNotMatch(persisted, /data:image|signature=/);
        assert.equal((await readFile(saved.manifest.screenshot_path)).subarray(1, 4).toString(), "PNG");
        const reopened = await api.getAppPageEditContext({ workspace_dir: created.workspace_dir, page_id: pageId });
        assert.equal(reopened.revision, 1);
        assert.match(reopened.html, /Manual round trip/);
        assert.doesNotMatch(reopened.html, /data:image|signature=/);
        await assert.rejects(api.saveAppManualPageRevision(saveInput), /revision conflict/i);
        assert.equal(await readFile(saved.manifest.current_html_path, "utf8"), persisted);
        await api.renderAppWorkspaceDeckHtml({ workspace_dir: created.workspace_dir });
        let deckHtmlPath = "";
        for (let attempt = 0; attempt < 200; attempt++) {
          const progress = await api.getAppPageProgress({ workspace_dir: created.workspace_dir });
          if (progress.final_deck_render.status === "completed") {
            deckHtmlPath = progress.final_deck_render.deck_html_path!;
            break;
          }
          if (progress.final_deck_render.status === "failed") throw new Error(progress.final_deck_render.error ?? "Deck render failed");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(deckHtmlPath, "manual page participates in final Deck render");
        assert.match(await readFile(deckHtmlPath, "utf8"), /Manual round trip/);
        const exportResult = await convertDeckHtmlToPptx({ htmlPath: deckHtmlPath,
          outputPath: path.join(homeDir, "manual.pptx"), title: "Manual round trip", expectedSlideCount: 1, timeoutMs: 60_000 });
        assert.equal(exportResult.slideCount, 1);
        assert.ok(exportResult.sizeBytes > 0);
        const pdf = await api.exportAppPdf({ workspace_dir: created.workspace_dir });
        assert.equal((await readFile(pdf.pdf_path)).subarray(0, 4).toString(), "%PDF");
        const restored = await api.restoreAppPageSourceVersion({ workspace_dir: created.workspace_dir, page_id: pageId });
        assert.equal(restored.restored, true);
        assert.doesNotMatch(await readFile(restored.html_path, "utf8"), /Manual round trip/);
        assert.equal(await readFile(path.join(created.workspace_dir, "slides", `${pageId}.html`), "utf8"), pageSource);
        const restoredContext = await api.getAppPageEditContext({ workspace_dir: created.workspace_dir, page_id: pageId });
        assert.equal(restoredContext.manually_edited, false);
        break;
      }
      if (page?.status === "render_failed") {
        throw new Error(page.last_error);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (attempt === 199) throw new Error("Timed out waiting for HTML Page Source preview");
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
    else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
    await rm(homeDir, { recursive: true, force: true });
  }
});
