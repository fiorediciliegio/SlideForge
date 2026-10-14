import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createImageUserTemplate, saveUserTemplateHtml, selectUserTemplatePages } from "../../src/user-templates/index.ts";
import { composeImageSlots } from "../../src/user-templates/image-slots.ts";

const PAGE_HTML = (body: string) => `<!doctype html><html><head><style>.slide{position:relative;width:1920px;height:1080px;overflow:hidden}</style></head><body><div class="slide">${body}</div></body></html>`;

async function staged(temporary: string, name: string, content: string) {
  const file = path.join(temporary, name);
  await writeFile(file, content);
  return file;
}

test("composeImageSlots fills the photo placeholder with the page's reference raster", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "image-slots-test-"));
  const previousRoot = process.env.ANNA_WORKSPACE_DIR;
  process.env.ANNA_WORKSPACE_DIR = temporary;
  try {
    // A real photograph-like raster so the sharp compression path runs.
    const photo = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 24, g: 90, b: 160 } } })
      .composite([{ input: await sharp({ create: { width: 600, height: 300, channels: 3, background: { r: 230, g: 170, b: 40 } } }).png().toBuffer(), left: 500, top: 300 }])
      .png()
      .toBuffer();
    const record = await createImageUserTemplate({ files: [{ filename: "photo.png", staging_file_path: await staged(temporary, "photo.png", photo), size_bytes: photo.length }] });
    const id = record.id;
    await selectUserTemplatePages(id, [1]);

    const render = async (_html: string, _file: string, image: string) => { await writeFile(image, "image"); };
    const htmlWithSlot = PAGE_HTML('<div class="image-slot" data-photo></div><h1 style="position:relative;z-index:1">大文件测试页 1</h1>');
    await saveUserTemplateHtml({ id, page_number: 1, staging_file_path: await staged(temporary, "page.html", htmlWithSlot) }, render);

    const saved = await readFile(path.join(temporary, "ppt", "user-templates", id, "html", "page-001.html"), "utf8");
    assert.match(saved, /data-composed data-photo src="data:image\/jpeg;base64,/);
    assert.doesNotMatch(saved, /class="image-slot"/);
    // Compressed inline stays well under the raw PNG size.
    const inlineBytes = (saved.match(/base64,([A-Za-z0-9+/=]+)/)?.[1] ?? "").length;
    assert.ok(inlineBytes * 0.75 < photo.length, "inline image should be compressed below the source raster");

    // Idempotent: re-saving the composed document must not double-compose.
    await saveUserTemplateHtml({ id, page_number: 1, staging_file_path: await staged(temporary, "page2.html", saved) }, render);
    const resaved = await readFile(path.join(temporary, "ppt", "user-templates", id, "html", "page-001.html"), "utf8");
    assert.equal((resaved.match(/<img data-composed data-photo/g) ?? []).length, 1);

    // Pass-through: no slot, or master saves, are untouched.
    const plain = PAGE_HTML("<h1>纯文字页</h1>");
    assert.equal(await composeImageSlots(plain, "/does/not/matter.png"), plain);
    assert.equal(await composeImageSlots(saved, undefined), saved);

    // P4 dedup: the redraw layer is visually hidden but kept in the DOM,
    // asset slots stay visible, and re-saving stays idempotent.
    assert.match(saved, /data-photo-dedup/);
    assert.match(saved, /visibility:hidden/);
    assert.match(saved, /<h1[^>]*>大文件测试页 1<\/h1>/, "redrawn element must remain in the DOM");
    const reSaveCount = (resaved.match(/data-photo-dedup/g) ?? []).length;
    assert.equal(reSaveCount, 1, "dedup style must not duplicate on re-save");
  } finally {
    process.env.ANNA_WORKSPACE_DIR = previousRoot;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("P4 dedup spares asset slots while hiding the redraw layer", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "image-slots-dedup-"));
  const previousRoot = process.env.ANNA_WORKSPACE_DIR;
  process.env.ANNA_WORKSPACE_DIR = temporary;
  try {
    const photo = await sharp({ create: { width: 640, height: 360, channels: 3, background: { r: 60, g: 60, b: 60 } } }).png().toBuffer();
    const record = await createImageUserTemplate({ files: [{ filename: "photo.png", staging_file_path: await staged(temporary, "photo.png", photo), size_bytes: photo.length }] });
    await selectUserTemplatePages(record.id, [1]);

    const render = async (_html: string, _file: string, image: string) => { await writeFile(image, "image"); };
    // Model output on a logo page: full-bleed photo slot + redrawn header +
    // an asset slot the asset stage will fill later.
    const htmlWithSlot = PAGE_HTML('<div class="image-slot" data-photo></div><header class="slide-header"><h1>目录</h1></header><div class="asset-slot" data-asset="logo-1.png" data-region="top-left"></div>');
    await saveUserTemplateHtml({ id: record.id, page_number: 1, staging_file_path: await staged(temporary, "page.html", htmlWithSlot) }, render);

    const saved = await readFile(path.join(temporary, "ppt", "user-templates", record.id, "html", "page-001.html"), "utf8");
    // Redraw layer hidden, DOM kept, asset slot NOT hidden by the dedup rule.
    assert.match(saved, /data-photo-dedup/);
    assert.match(saved, /<h1>目录<\/h1>/);
    assert.doesNotMatch(saved, /\.asset-slot\{visibility:hidden/);
    // The dedup selector must exclude asset-slot / composed assets.
    assert.match(saved, /:not\(\.asset-slot\)/);
    assert.match(saved, /:not\(\[data-composed-asset\]\)/);
  } finally {
    process.env.ANNA_WORKSPACE_DIR = previousRoot;
    await rm(temporary, { recursive: true, force: true });
  }
});
