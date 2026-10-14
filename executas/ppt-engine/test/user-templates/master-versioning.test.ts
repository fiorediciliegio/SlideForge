import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createImageUserTemplate,
  getUserTemplateAsset,
  getUserTemplateHtmls,
  publishUserTemplate,
  saveUserTemplateHtml,
  saveUserTemplateProfile,
  selectUserTemplatePages,
} from "../../src/user-templates/index.ts";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const HTML_V1 = "<!doctype html><html><body><div>{{PAGE_TITLE}}{{#0E1420}} {{PAGE_CONTENT}}</div></body></html>";
const HTML_V2 = "<!doctype html><html><body><div>{{PAGE_TITLE}}{{#163A7A}} {{PAGE_CONTENT}}</div></body></html>";
const HTML_V3 = "<!doctype html><html><body><div>{{PAGE_TITLE}}{{#B02A30}} {{PAGE_CONTENT}}</div></body></html>";

async function staged(temporary: string, name: string, content: string | Buffer) {
  const file = path.join(temporary, name);
  await writeFile(file, content);
  return file;
}

async function saveMaster(temporary: string, id: string, html: string) {
  const staging = await staged(temporary, `master-${Math.random().toString(36).slice(2)}.html`, html);
  const render = async (_html: string, _file: string, image: string) => { await writeFile(image, "image"); };
  return saveUserTemplateHtml({ id, staging_file_path: staging }, render);
}

test("master two-slot versioning and ready re-publish", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "master-versioning-test-"));
  const previousRoot = process.env.ANNA_WORKSPACE_DIR;
  process.env.ANNA_WORKSPACE_DIR = temporary;
  try {
    const coverPath = await staged(temporary, "cover.png", PNG_BYTES);
    const record = await createImageUserTemplate({ files: [{ filename: "cover.png", staging_file_path: coverPath, size_bytes: PNG_BYTES.length }] });
    const id = record.id;
    await selectUserTemplatePages(id, [1]);
    await saveUserTemplateProfile(id, { colors: [{ token: "primary", hex: "#163A7A", role: "主色" }] });

    // First save: no previous slot yet.
    await saveMaster(temporary, id, HTML_V1);
    const pageStaging = await staged(temporary, "page-1.html", "<!doctype html><html><body><div class='slide'>{{PAGE_TITLE}}{{PAGE_CONTENT}}</div></body></html>");
    const pageRender = async (_html: string, file: string, image: string) => { await writeFile(file, "<html data-presenton-runtime=\"html-page-shell\"><body><div class=\"presentation-slides-wrapper\"></div></body></html>"); await writeFile(image, "image"); };
    await saveUserTemplateHtml({ id, page_number: 1, staging_file_path: pageStaging }, pageRender);
    let masters = await getUserTemplateHtmls(id);
    assert.equal(masters.html, HTML_V1);
    assert.equal(masters.previous_html, null);

    // Second save: v1 slides into the previous slot.
    await saveMaster(temporary, id, HTML_V2);
    masters = await getUserTemplateHtmls(id);
    assert.equal(masters.html, HTML_V2);
    assert.equal(masters.previous_html, HTML_V1);

    // Publish freezes snapshot v2.
    const published = await publishUserTemplate(id, { name: "Brand", description: "v2.", pages: [{ page_number: 1, description: "Cover." }] });
    assert.equal(published.status, "ready");
    assert.equal(published.version, 1);
    const snapshotV2 = JSON.parse(await readFile((await getUserTemplateAsset(id, "snapshot")).file_path, "utf8"));
    assert.match(snapshotV2.visual_master_html, /#163A7A/);

    // Ready templates accept master edits and re-publish bumps the version.
    await saveMaster(temporary, id, HTML_V3);
    const republished = await publishUserTemplate(id, { name: "ignored", description: "ignored", pages: [{ page_number: 1, description: "ignored" }] });
    assert.equal(republished.version, 2);
    assert.equal(republished.name, "Brand");
    const snapshotV3 = JSON.parse(await readFile((await getUserTemplateAsset(id, "snapshot")).file_path, "utf8"));
    assert.match(snapshotV3.visual_master_html, /#B02A30/);
    assert.equal(snapshotV3.preset.version, 2);

    // Revert = save the previous slot back; slots swap again (undo is undoable).
    const beforeRevert = await getUserTemplateHtmls(id);
    await saveMaster(temporary, id, beforeRevert.previous_html as string);
    const afterRevert = await getUserTemplateHtmls(id);
    assert.equal(afterRevert.html, HTML_V2);
    assert.equal(afterRevert.previous_html, HTML_V3);

    // The two-slot applies to pages as well, and page reads require a known number.
    const pageV2 = "<!doctype html><html><body><div class='slide'>v2 {{PAGE_TITLE}}</div></body></html>";
    const pageStaging2 = await staged(temporary, "page-1-v2.html", pageV2);
    await saveUserTemplateHtml({ id, page_number: 1, staging_file_path: pageStaging2 }, pageRender);
    const pageHtmls = await getUserTemplateHtmls(id, 1);
    assert.equal(pageHtmls.html, pageV2);
    assert.match(pageHtmls.previous_html ?? "", /v1|slide/);
    await assert.rejects(getUserTemplateHtmls(id, 99), /Unknown/);
  } finally {
    process.env.ANNA_WORKSPACE_DIR = previousRoot;
    await rm(temporary, { recursive: true, force: true });
  }
});
