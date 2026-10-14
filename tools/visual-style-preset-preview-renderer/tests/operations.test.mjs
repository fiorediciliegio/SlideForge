import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { convertImages } from "../src/operations.mjs";

function presetMetadata() {
  return {
    id: "example",
    version: 1,
    ppt_number: 1,
    theme: "light",
    color: ["blue"],
    name: "Example",
    description: "Example preset",
    user: "Founders",
    use_case: "Pitch deck",
    industry: "Technology",
    preview_images: [{ path: "images/1-cover.png", alt: "Blue cover" }],
    reference_html_pages: [{ path: "html/1-cover.html", description: "Blue cover layout" }],
  };
}

async function createSourcePreset(sourceRoot, html) {
  const presetRoot = join(sourceRoot, "example");
  await mkdir(join(presetRoot, "html"), { recursive: true });
  await mkdir(join(presetRoot, "images"), { recursive: true });
  await writeFile(join(presetRoot, "preset.json"), `${JSON.stringify(presetMetadata(), null, 2)}\n`);
  await writeFile(join(presetRoot, "html", "1-cover.html"), html);
  await sharp(Buffer.from('<svg width="16" height="9"><rect width="16" height="9" fill="#3355aa"/></svg>'))
    .png()
    .toFile(join(presetRoot, "images", "1-cover.png"));
}

test("convert-images publishes a complete WebP preset", async () => {
  const root = await mkdtemp(join(tmpdir(), "slideforge-preview-publish-"));
  try {
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    await mkdir(sourceRoot);
    await mkdir(outputRoot);
    await createSourcePreset(
      sourceRoot,
      '<!doctype html><html><body><div class="slide" style="width:1920px;height:1080px">Example</div></body></html>',
    );

    const report = await convertImages({ sourceRoot, outputRoot, quality: 90, timeoutMs: 30_000 });

    assert.equal(report.status, "passed");
    assert.equal(report.publication.status, "published");
    const outputPreset = JSON.parse(await readFile(join(outputRoot, "example", "preset.json"), "utf8"));
    assert.equal(outputPreset.preview_images[0].path, "images/1-cover.webp");
    await assert.doesNotReject(access(join(outputRoot, "example", "images", "1-cover.webp")));
    await assert.rejects(access(join(outputRoot, "example", "images", "1-cover.png")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed staging validation preserves the published preset", async () => {
  const root = await mkdtemp(join(tmpdir(), "slideforge-preview-rollback-"));
  try {
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    await mkdir(sourceRoot);
    await mkdir(join(outputRoot, "example"), { recursive: true });
    await writeFile(join(outputRoot, "example", "marker.txt"), "preserve me");
    await createSourcePreset(
      sourceRoot,
      '<!doctype html><html><body><div class="slide"><img src="../assets/missing.png"></div></body></html>',
    );

    const report = await convertImages({ sourceRoot, outputRoot, quality: 90, timeoutMs: 30_000 });

    assert.equal(report.status, "failed");
    assert.equal(report.publication.status, "not_published");
    assert.equal(await readFile(join(outputRoot, "example", "marker.txt"), "utf8"), "preserve me");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
