import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { composeAssetSlots, ASSET_REGIONS } from "../../src/user-templates/asset-slots.ts";
import { createImageUserTemplate, saveUserTemplateHtml, saveUserTemplateProfileAsset } from "../../src/user-templates/index.ts";

test("composeAssetSlots fills named-region slots and survives the unknowns", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "asset-slots-test-"));
  try {
    const logo = await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 200, g: 30, b: 40, alpha: 1 } } })
      .png().toBuffer();
    const logoPath = path.join(temporary, "logo-1.png");
    await writeFile(logoPath, logo);
    const resolveAsset = async (filename: string) => filename === "logo-1.png" ? logoPath : undefined;

    const html = [
      '<!doctype html><html><body><div class="slide" style="position:relative">',
      '<div class="asset-slot" data-asset="logo-1.png" data-region="top-left"></div>',
      '<div class="asset-slot" data-asset="logo-1.png" data-region="bottom-right"></div>',
      '<div class="asset-slot" data-asset="missing.png" data-region="top-left"></div>',
      '<div class="asset-slot" data-asset="logo-1.png" data-region="nowhere"></div>',
      "</div></body></html>",
    ].join("");
    const out = await composeAssetSlots(html, resolveAsset);
    assert.equal((out.match(/data-composed-asset/g) ?? []).length, 2);
    assert.match(out, /data:image\/(webp|png);base64,/);
    assert.match(out, /left:96px/);
    assert.match(out, /left:1824px/);
    assert.match(out, /translateX\(-100%\)/);
    assert.ok(out.includes('class="asset-missing-marker"'), "unknown asset/region degrades to a visible marker");
    assert.doesNotMatch(out, /class="asset-slot"/);

    // Idempotent.
    assert.equal(await composeAssetSlots(out, resolveAsset), out);
    // No slots -> untouched.
    const plain = "<html><body><h1>hi</h1></body></html>";
    assert.equal(await composeAssetSlots(plain, resolveAsset), plain);
    assert.ok(ASSET_REGIONS["top-center"].align === "center");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("saveUserTemplateHtml composites asset slots for the master and pages via assets/", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "asset-save-test-"));
  const previousRoot = process.env.ANNA_WORKSPACE_DIR;
  process.env.ANNA_WORKSPACE_DIR = temporary;
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
    const stagedPng = path.join(temporary, "logo.png");
    await writeFile(stagedPng, png);
    const record = await createImageUserTemplate({ files: [{ filename: "cover.png", staging_file_path: stagedPng, size_bytes: png.length }] });
    const id = record.id;
    const asset = await saveUserTemplateProfileAsset({ id, filename: "logo.png", staging_file_path: stagedPng, size_bytes: png.length });
    assert.equal(asset.filename, "logo-1.png");

    const render = async (_html: string, _file: string, image: string) => { await writeFile(image, "image"); };
    const MASTER = '<!doctype html><html><head></head><body><div class="slide"><div class="asset-slot" data-asset="logo-1.png" data-region="top-left"></div><h1>{{PAGE_TITLE}}</h1><div>{{PAGE_CONTENT}}</div></div></body></html>';
    await saveUserTemplateHtml({ id, staging_file_path: await stagedHtml(temporary, "master.html", MASTER) }, render);

    const saved = await readFile(path.join(temporary, "ppt", "user-templates", id, "html", "master.html"), "utf8");
    assert.match(saved, /data-composed-asset/);
    assert.doesNotMatch(saved, /class="asset-slot"/);
    assert.match(saved, /\{\{PAGE_CONTENT\}\}/);

    // Idempotent: re-saving the composed master must not double-compose.
    await saveUserTemplateHtml({ id, staging_file_path: await stagedHtml(temporary, "master2.html", saved) }, render);
    const resaved = await readFile(path.join(temporary, "ppt", "user-templates", id, "html", "master.html"), "utf8");
    assert.equal((resaved.match(/data-composed-asset/g) ?? []).length, 1);

    // Unknown asset degrades to a visible marker instead of failing the save.
    const BROKEN = '<!doctype html><html><body><div class="slide"><div class="asset-slot" data-asset="ghost.png" data-region="top-left"></div><h1>{{PAGE_TITLE}}</h1><div>{{PAGE_CONTENT}}</div></div></body></html>';
    await saveUserTemplateHtml({ id, staging_file_path: await stagedHtml(temporary, "master3.html", BROKEN) }, render);
    const degraded = await readFile(path.join(temporary, "ppt", "user-templates", id, "html", "master.html"), "utf8");
    assert.match(degraded, /asset-missing-marker/);
  } finally {
    process.env.ANNA_WORKSPACE_DIR = previousRoot;
    await rm(temporary, { recursive: true, force: true });
  }
});

async function stagedHtml(temporary: string, name: string, content: string) {
  const file = path.join(temporary, name);
  await writeFile(file, content);
  return file;
}
