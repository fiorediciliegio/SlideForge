import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUserTemplate, deleteUserTemplate, getUserTemplate, getUserTemplateAsset, listUserTemplates, publishUserTemplate, saveUserTemplateHtml, selectUserTemplatePages, validateTemplateHtml, USER_TEMPLATE_MAX_BYTES } from "../../src/user-templates/index.ts";
import { rasterizePptxToImages } from "../../src/pptx-rasterization/index.ts";

test("personal template publication requires all previews and produces a complete reusable snapshot", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "personal-template-test-"));
  const previousRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
  process.env.SLIDEFORGE_WORKSPACE_DIR = temporary;
  try {
    const source = path.join(temporary, "source.pptx");
    await writeFile(source, "PKsource");
    await assert.rejects(createUserTemplate({ filename: "source.pptx", staging_file_path: source, size_bytes: USER_TEMPLATE_MAX_BYTES + 1 }), /20 MB/);
    await assert.rejects(createUserTemplate({ filename: "../source.pptx", staging_file_path: source, size_bytes: 8 }), /PPTX/);
    const record = await createUserTemplate({ filename: "source.pptx", staging_file_path: source, size_bytes: 8 });
    assert.equal((await listUserTemplates()).length, 1);
    await assert.rejects(getUserTemplateAsset("../../escape", "source"), /Invalid/);
    const selected = [91, 2];
    await selectUserTemplatePages(record.id, selected, (input) => rasterizePptxToImages(input, {
      loadPptxSvgSlides: async (_file, pageNumbers) => {
        assert.deepEqual(pageNumbers, selected);
        return selected.map((page_number) => ({ page_number, svg: "<svg/>" }));
      },
      convertSvgToPng: async ({ outputPath }) => { await writeFile(outputPath, "image"); return { width: 1920, height: 1080 }; },
    }));
    const master = "<!doctype html><html><body><div class='slide'>{{PAGE_TITLE}}{{PAGE_CONTENT}}</div></body></html>";
    const staging = path.join(temporary, "template.html");
    await writeFile(staging, master);
    const render = async (html: string, file: string, image: string) => {
      assert.match(html, /presentation-slides-wrapper/);
      assert.match(await readFile(file, "utf8"), /data-presenton-runtime="html-page-shell"/);
      await writeFile(image, "image");
    };
    await assert.rejects(saveUserTemplateHtml({ id: record.id, staging_file_path: staging }, async () => { throw new Error("render failed"); }), /render failed/);
    assert.equal((await getUserTemplate(record.id)).master_ready, false);
    await saveUserTemplateHtml({ id: record.id, staging_file_path: staging }, render);
    const metadata = { name: "Personal", description: "A clear visual system.", pages: selected.map((page_number) => ({ page_number, description: "A balanced content page." })) };
    await assert.rejects(publishUserTemplate(record.id, metadata), /not complete/);
    for (const page_number of selected) await saveUserTemplateHtml({ id: record.id, page_number, staging_file_path: staging }, render);
    await assert.rejects(publishUserTemplate(record.id, { ...metadata, pages: [{ page_number: 1, description: "wrong" }] }), /exactly/);
    const published = await publishUserTemplate(record.id, metadata);
    assert.equal(published.status, "ready");
    const asset = await getUserTemplateAsset(record.id, "snapshot");
    const snapshot = JSON.parse(await readFile(asset.file_path, "utf8"));
    assert.equal(snapshot.visual_master_html, master);
    assert.equal(snapshot.reference_html_pages.length, 2);
    assert.equal(snapshot.reference_html_pages[0].path, "html/page-091.html");
    // Ready templates accept master edits (master workbench); the change takes
    // effect on re-publish, which bumps the version and rebuilds the snapshot.
    const editedMaster = master.replace("</body>", "<style>/* tuned */</style></body>");
    const editedStaging = path.join(temporary, "edited-master.html");
    await writeFile(editedStaging, editedMaster);
    const edited = await saveUserTemplateHtml({ id: record.id, staging_file_path: editedStaging }, render);
    assert.equal(edited.status, "ready");
    const republished = await publishUserTemplate(record.id, metadata);
    assert.equal(republished.version, 2);
    const snapshotV2 = JSON.parse(await readFile((await getUserTemplateAsset(record.id, "snapshot")).file_path, "utf8"));
    assert.match(snapshotV2.visual_master_html, /tuned/);
    await assert.rejects(getUserTemplateAsset(record.id, "page", 999), /Unknown/);
    assert.throws(() => validateTemplateHtml("<html><body>truncated"), /complete/);
    assert.throws(() => validateTemplateHtml(master + master), /complete/);
    await assert.rejects(deleteUserTemplate("../../escape"), /Invalid/);
    assert.deepEqual(await deleteUserTemplate(record.id), { deleted: true, id: record.id });
    assert.equal((await listUserTemplates()).length, 0);
    await assert.rejects(deleteUserTemplate(record.id), /Unknown/);
  } finally {
    if (previousRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
    else process.env.SLIDEFORGE_WORKSPACE_DIR = previousRoot;
    await rm(temporary, { recursive: true, force: true });
  }
});
