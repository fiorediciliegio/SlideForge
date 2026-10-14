import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function confirmedRequirements(preset: {
  id: string;
  version: number;
  name: string;
  description: string;
}) {
  return {
    version: 1,
    status: "confirmed" as const,
    source: { brief: "Create a concise investor presentation." },
    candidates: {
      slide_count: [2],
      output_language: ["English"],
    },
    selections: {
      slide_count: 2,
      output_language: "English",
      visual_style_preset: preset,
    },
    research: {
      web: { recommended: false, reason: "Not required.", enabled: false },
      images: { recommended: false, reason: "Not required.", enabled: false },
    },
    updated_at: null,
    confirmed_at: null,
  };
}

test("template reference RPC reads metadata and selected HTML separately", async () => {
  const previousHome = process.env.HOME;
  const previousWorkspaceRoot = process.env.ANNA_WORKSPACE_DIR;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "ppt-template-reference-access-home-"));
  process.env.HOME = homeDir;
  process.env.ANNA_WORKSPACE_DIR = path.join(homeDir, "anna-workspace");

  const {
    confirmAppWorkspaceRequirements,
    createAppWorkspace,
    getAppWorkspaceTemplateReferenceHtml,
    listAppWorkspaceTemplateReferences,
  } = await import("../../src/app-workspace/index.ts");

  try {
    const created = await createAppWorkspace({ title: "Template Reference Access" });
    const preset = {
      id: "bounded-reference-rpc",
      version: 1,
      name: "Bounded Reference RPC",
      description: "Reference HTML stays in the Workspace until selected.",
    };
    const coverHtml = `<!doctype html><html><body>COVER_SENTINEL_${"x".repeat(80_000)}</body></html>`;
    const contentHtml = `<!doctype html><html><body>CONTENT_SENTINEL_${"y".repeat(80_000)}</body></html>`;
    const snapshot = JSON.stringify({
      version: 1,
      preset,
      reference_html_pages: [
        { path: "html/cover.html", description: "Editorial cover.", html: coverHtml },
        { path: "html/content.html", description: "Editorial content page.", html: contentHtml },
      ],
    });
    const stagingPath = path.join(homeDir, "template-reference-snapshot.json");
    await writeFile(stagingPath, snapshot, "utf8");

    const confirmed = await confirmAppWorkspaceRequirements({
      workspace_dir: created.workspace_dir,
      requirements: confirmedRequirements(preset),
      template_reference_staging_file_path: stagingPath,
      template_reference_expected_size_bytes: Buffer.byteLength(snapshot),
    });
    assert.equal(JSON.stringify(confirmed).includes("COVER_SENTINEL"), false);
    assert.equal(JSON.stringify(confirmed).includes("CONTENT_SENTINEL"), false);

    const references = await listAppWorkspaceTemplateReferences({
      workspace_dir: created.workspace_dir,
    });
    assert.deepEqual(references, {
      version: 1,
      preset,
      reference_html_pages: [
        { path: "html/cover.html", description: "Editorial cover." },
        { path: "html/content.html", description: "Editorial content page." },
      ],
    });
    assert.ok(Buffer.byteLength(JSON.stringify(references)) < 4_096);

    const selected = await getAppWorkspaceTemplateReferenceHtml({
      workspace_dir: created.workspace_dir,
      path: "html/content.html",
    });
    assert.deepEqual(selected, {
      path: "html/content.html",
      description: "Editorial content page.",
      html: contentHtml,
    });

    await assert.rejects(
      getAppWorkspaceTemplateReferenceHtml({
        workspace_dir: created.workspace_dir,
        path: "html/missing.html",
      }),
      /Unknown template reference HTML path/,
    );
    await assert.rejects(
      getAppWorkspaceTemplateReferenceHtml({
        workspace_dir: created.workspace_dir,
        path: "../requirements.json",
      }),
      /Unknown template reference HTML path/,
    );

    const master = "<!doctype html><html><body>{{PAGE_TITLE}}{{PAGE_CONTENT}}</body></html>";
    const personalSnapshot = JSON.stringify({ ...JSON.parse(snapshot), visual_master_html: master });
    await writeFile(stagingPath, personalSnapshot);
    await confirmAppWorkspaceRequirements({
      workspace_dir: created.workspace_dir,
      requirements: confirmedRequirements(preset),
      template_reference_staging_file_path: stagingPath,
      template_reference_expected_size_bytes: Buffer.byteLength(personalSnapshot),
    });
    assert.equal(await readFile(path.join(created.workspace_dir, "visual-master.html"), "utf8"), master);
    const wrongSnapshot = JSON.stringify({ ...JSON.parse(personalSnapshot), preset: { ...preset, id: "wrong-template" } });
    await writeFile(stagingPath, wrongSnapshot);
    await assert.rejects(confirmAppWorkspaceRequirements({
      workspace_dir: created.workspace_dir,
      requirements: confirmedRequirements(preset),
      template_reference_staging_file_path: stagingPath,
      template_reference_expected_size_bytes: Buffer.byteLength(wrongSnapshot),
    }), /does not match/);
    assert.equal((await listAppWorkspaceTemplateReferences({ workspace_dir: created.workspace_dir })).preset.id, preset.id);
    // Changing the catalog source cannot change the already-confirmed master.
    await writeFile(stagingPath, snapshot);
    assert.equal(await readFile(path.join(created.workspace_dir, "visual-master.html"), "utf8"), master);
    // A later built-in selection must not inherit the personal template master.
    await confirmAppWorkspaceRequirements({
      workspace_dir: created.workspace_dir,
      requirements: confirmedRequirements(preset),
      template_reference_staging_file_path: stagingPath,
      template_reference_expected_size_bytes: Buffer.byteLength(snapshot),
    });
    await assert.rejects(readFile(path.join(created.workspace_dir, "visual-master.html")), /ENOENT/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousWorkspaceRoot === undefined) delete process.env.ANNA_WORKSPACE_DIR;
    else process.env.ANNA_WORKSPACE_DIR = previousWorkspaceRoot;
    await rm(homeDir, { recursive: true, force: true });
  }
});
