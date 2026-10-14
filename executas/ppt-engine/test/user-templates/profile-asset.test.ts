import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createImageUserTemplate,
  getUserTemplateAsset,
  PROFILE_ASSET_MAX_BYTES,
  publishUserTemplate,
  saveUserTemplateHtml,
  saveUserTemplateProfile,
  saveUserTemplateProfileAsset,
  selectUserTemplatePages,
  validateDesignProfile,
} from "../../src/user-templates/index.ts";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

async function staged(temporary: string, name: string, bytes: Buffer) {
  const file = path.join(temporary, name);
  await writeFile(file, bytes);
  return { filename: name, staging_file_path: file, size_bytes: bytes.length };
}

test("profile assets store under assets/ with validation and safe readback", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "profile-asset-test-"));
  const previousRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
  process.env.SLIDEFORGE_WORKSPACE_DIR = temporary;
  try {
    const record = await createImageUserTemplate({ files: [await staged(temporary, "cover.png", PNG_BYTES)] });
    const id = record.id;

    // Rejection paths: bad names, bad content, oversize.
    await assert.rejects(saveUserTemplateProfileAsset({ id, filename: "../evil.png", staging_file_path: path.join(temporary, "missing"), size_bytes: 1 }), /Invalid asset filename/);
    await assert.rejects(saveUserTemplateProfileAsset({ id, filename: "notes.txt", ...(await staged(temporary, "notes.txt", PNG_BYTES)) }), /PNG, JPEG or WebP/);
    await assert.rejects(saveUserTemplateProfileAsset({ id, filename: "fake.png", ...(await staged(temporary, "fake.png", JPEG_BYTES)) }), /does not match/);
    await assert.rejects(saveUserTemplateProfileAsset({ id, filename: "big.png", ...(await staged(temporary, "big.png", Buffer.concat([PNG_BYTES, Buffer.alloc(PROFILE_ASSET_MAX_BYTES)]))) }), /at most/);

    // Happy path: stored with a sequential safe name, readable back with mime.
    const first = await saveUserTemplateProfileAsset({ id, filename: "brand logo.png", ...(await staged(temporary, "brand logo.png", PNG_BYTES)) });
    assert.equal(first.filename, "logo-1.png");
    assert.equal(first.mime_type, "image/png");
    const second = await saveUserTemplateProfileAsset({ id, filename: "alt.jpg", ...(await staged(temporary, "alt.jpg", JPEG_BYTES)) });
    assert.equal(second.filename, "logo-1.jpg");
    const asset = await getUserTemplateAsset(id, "profile_asset", undefined, "logo-1.png");
    assert.equal(asset.filename, "logo-1.png");
    assert.match(asset.mime_type, /png/);
    await access(asset.file_path);

    // Traversal and unknown names are refused at readback time.
    await assert.rejects(getUserTemplateAsset(id, "profile_asset", undefined, "../profile.json"), /safe asset filename/);
    await assert.rejects(getUserTemplateAsset(id, "profile_asset", undefined, "missing.png"), /Unknown|ENOENT/);

    // Profile validation accepts the metadata shape and rejects junk.
    const colors = [{ token: "primary", hex: "#1B4F9C", role: "主色" }];
    const withImage = validateDesignProfile({ colors, fixed_assets: [{ kind: "logo", label: "NASA", image: first }] });
    assert.equal(withImage.fixed_assets?.[0].image?.filename, "logo-1.png");
    assert.throws(() => validateDesignProfile({ colors, fixed_assets: [{ kind: "logo", image: { filename: "../x.png", mime_type: "image/png", size_bytes: 3 } }] }), /safe basename/);
    assert.throws(() => validateDesignProfile({ colors, fixed_assets: [{ kind: "logo", image: { filename: "a.png", mime_type: "image/png", size_bytes: 0 } }] }), /bytes/);

    // Profile save with an asset reference persists; published templates stay immutable.
    await saveUserTemplateProfile(id, withImage);
    await selectUserTemplatePages(id, [1]);
    const html = "<!doctype html><html><body><div class='slide'>{{PAGE_TITLE}}{{PAGE_CONTENT}}</div></body></html>";
    const staging = path.join(temporary, "template.html");
    await writeFile(staging, html);
    const render = async (_html: string, _file: string, image: string) => { await writeFile(image, "image"); };
    await saveUserTemplateHtml({ id, staging_file_path: staging }, render);
    await saveUserTemplateHtml({ id, page_number: 1, staging_file_path: staging }, render);
    await publishUserTemplate(id, { name: "Brand", description: "With logo.", pages: [{ page_number: 1, description: "Cover." }] });
    await assert.rejects(saveUserTemplateProfileAsset({ id, filename: "late.png", ...(await staged(temporary, "late.png", PNG_BYTES)) }), /immutable/);
  } finally {
    process.env.SLIDEFORGE_WORKSPACE_DIR = previousRoot;
    await rm(temporary, { recursive: true, force: true });
  }
});
