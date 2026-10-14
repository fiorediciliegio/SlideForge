import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createImageUserTemplate, createUserTemplate, getUserTemplate, getUserTemplateAsset, publishUserTemplate, saveUserTemplateHtml, selectUserTemplatePages } from "../../src/user-templates/index.ts";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

async function staged(temporary: string, name: string, bytes: Buffer) {
  const file = path.join(temporary, name);
  await writeFile(file, bytes);
  return { filename: name, staging_file_path: file, size_bytes: bytes.length };
}

test("image sources create a template whose references are the images themselves", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "image-template-test-"));
  const previousRoot = process.env.ANNA_WORKSPACE_DIR;
  process.env.ANNA_WORKSPACE_DIR = temporary;
  try {
    await assert.rejects(createImageUserTemplate({ files: [] }), /between 1 and 6/);
    await assert.rejects(createImageUserTemplate({ files: Array.from({ length: 7 }, (_, i) => ({ filename: `${i}.png`, staging_file_path: path.join(temporary, "missing"), size_bytes: 1 })) }), /between 1 and 6/);
    await assert.rejects(createImageUserTemplate({ files: [await staged(temporary, "notes.txt", PNG_BYTES)] }), /PNG, JPEG or WebP/);
    await assert.rejects(createImageUserTemplate({ files: [await staged(temporary, "fake.png", JPEG_BYTES)] }), /does not match/);

    const record = await createImageUserTemplate({ files: [
      await staged(temporary, "cover.png", PNG_BYTES),
      await staged(temporary, "content.jpg", JPEG_BYTES),
    ] });
    assert.equal(record.source_kind, "images");
    assert.equal(record.source_files?.length, 2);
    assert.match(record.filename, /cover\.png/);

    // References resolve straight to the stored sources with the right mime.
    const ref1 = await getUserTemplateAsset(record.id, "reference", 1);
    assert.equal(ref1.filename, "source-1.png");
    assert.match(ref1.mime_type, /png/);
    const ref2 = await getUserTemplateAsset(record.id, "reference", 2);
    assert.match(ref2.mime_type, /jpeg/);
    await assert.rejects(getUserTemplateAsset(record.id, "reference", 3), /Unknown/);
    assert.equal((await getUserTemplateAsset(record.id, "source")).filename, "source-1.png");

    // Subset page selection is allowed for images and skips rasterization.
    const selected = await selectUserTemplatePages(record.id, [2]);
    assert.deepEqual(selected.pages.map((p) => p.page_number), [2]);
    await assert.rejects(selectUserTemplatePages(record.id, [5]), /Unknown/);

    // Publish path works end to end.
    const html = "<!doctype html><html><body><div class='slide'>{{PAGE_TITLE}}{{PAGE_CONTENT}}</div></body></html>";
    const staging = path.join(temporary, "template.html");
    await writeFile(staging, html);
    const render = async (_html: string, _file: string, image: string) => { await writeFile(image, "image"); };
    await saveUserTemplateHtml({ id: record.id, staging_file_path: staging }, render);
    await saveUserTemplateHtml({ id: record.id, page_number: 2, staging_file_path: staging }, render);
    const published = await publishUserTemplate(record.id, { name: "Image brand", description: "From two reference images.", pages: [{ page_number: 2, description: "A cover-like reference." }] });
    assert.equal(published.status, "ready");
    const snapshot = JSON.parse(await readFile((await getUserTemplateAsset(record.id, "snapshot")).file_path, "utf8"));
    assert.equal(snapshot.reference_html_pages.length, 1);

    // PPTX path is untouched by the image additions.
    const pptx = await staged(temporary, "deck.pptx", Buffer.from("PKdeck"));
    const pptxRecord = await createUserTemplate({ filename: "deck.pptx", staging_file_path: pptx.staging_file_path, size_bytes: pptx.size_bytes });
    assert.equal(pptxRecord.source_kind, undefined);
  } finally {
    if (previousRoot === undefined) delete process.env.ANNA_WORKSPACE_DIR;
    else process.env.ANNA_WORKSPACE_DIR = previousRoot;
    await rm(temporary, { recursive: true, force: true });
  }
});
