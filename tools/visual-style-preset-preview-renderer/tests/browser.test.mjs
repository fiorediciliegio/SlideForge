import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { renderPreviews } from "../src/operations.mjs";

const browserExecutable = process.env.ANNA_PREVIEW_BROWSER_EXECUTABLE;

test("render creates and publishes a WebP with real Chromium", {
  skip: browserExecutable ? false : "ANNA_PREVIEW_BROWSER_EXECUTABLE is not set",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-preview-browser-"));
  try {
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    const presetRoot = join(sourceRoot, "example");
    await mkdir(join(presetRoot, "html"), { recursive: true });
    await mkdir(outputRoot);
    await writeFile(join(presetRoot, "preset.json"), `${JSON.stringify({
      id: "example",
      version: 1,
      ppt_number: 1,
      theme: "dark",
      color: ["blue", "orange"],
      name: "Example",
      description: "Browser smoke fixture",
      user: "Founders",
      use_case: "Pitch deck",
      industry: "Technology",
      preview_images: [{ path: "images/1-cover.webp", alt: "Blue and orange fixture cover" }],
      reference_html_pages: [{ path: "html/1-cover.html", description: "Blue cover with an orange panel" }],
    }, null, 2)}\n`);
    await writeFile(join(presetRoot, "html", "1-cover.html"), [
      "<!doctype html>",
      '<html><head><style>html,body{margin:0;width:100%;height:100%}body{display:grid;place-items:center}.slide{width:1920px;height:1080px;background:linear-gradient(90deg,#f00 0 25%,#0f0 25% 75%,#00f 75%);color:#fff;display:flex;flex:none;align-items:center;justify-content:center;font:700 96px Arial}.panel{padding:80px;background:#e56b2f}</style></head>',
      '<body><div class="slide"><div class="panel">Preview</div></div></body></html>',
    ].join(""));

    const report = await renderPreviews({
      sourceRoot,
      outputRoot,
      browserExecutable,
      quality: 90,
      timeoutMs: 30_000,
    });

    assert.equal(report.status, "passed");
    assert.equal(report.publication.status, "published");
    const previewPath = join(outputRoot, "example", "images", "1-cover.webp");
    await assert.doesNotReject(access(previewPath));
    const { data: edgePixels } = await sharp(previewPath)
      .extract({ left: 80, top: 360, width: 1121, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const left = edgePixels.subarray(0, 3);
    const right = edgePixels.subarray(edgePixels.length - 3);
    assert.ok(left[0] > 200 && left[1] < 80 && left[2] < 80, `unexpected left pixel: ${[...left]}`);
    assert.ok(right[2] > 200 && right[0] < 80 && right[1] < 80, `unexpected right pixel: ${[...right]}`);
    const outputPreset = JSON.parse(await readFile(join(outputRoot, "example", "preset.json"), "utf8"));
    assert.equal(outputPreset.preview_images[0].path, "images/1-cover.webp");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
