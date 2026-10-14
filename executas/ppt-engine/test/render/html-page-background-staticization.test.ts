import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { buildDeckPageScreenshotFromManifest } from "../../src/render/build-deck-from-manifest.tsx";

const PAGE_ID = "page-11111111-1111-4111-8111-111111111111";

test("HTML page staticization preserves a variable background beneath a background image", async () => {
  const tempRoot = path.join(process.cwd(), "test", ".tmp");
  await mkdir(tempRoot, { recursive: true });
  const workspaceDir = await mkdtemp(path.join(tempRoot, "html-page-background-"));
  const htmlOutputDir = path.join(workspaceDir, "output", "page-preview-html");
  const screenshotOutputDir = path.join(workspaceDir, "output", "screenshots");
  const manifestPath = path.join(workspaceDir, "manifest.json");
  const slidePath = path.join(workspaceDir, "slides", `${PAGE_ID}.html`);

  try {
    await mkdir(path.dirname(slidePath), { recursive: true });
    await writeFile(
      slidePath,
      `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    :root { --page-background: #fbf6ec; --empty-token: ; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #121212; display: flex; justify-content: center; align-items: center; height: 100vh; }
    .slide {
      flex-direction: column;
      width: 1920px;
      height: 1080px;
      padding: 60px 80px;
      background: var(--page-background);
      background-image: radial-gradient(rgba(26, 26, 26, 0.08) 1.5px, transparent 1.5px);
      background-size: 32px 32px;
    }
  </style>
</head>
<body>
  <main class="slide"></main>
</body>
</html>
`,
      "utf8",
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        title: "Background Staticization Test",
        slides: [{ id: PAGE_ID, source: `./slides/${PAGE_ID}.html` }],
      }, null, 2)}\n`,
      "utf8",
    );

    const result = await buildDeckPageScreenshotFromManifest({
      manifestPath,
      outputDir: screenshotOutputDir,
      htmlOutputDir,
      page: 1,
    });
    const staticHtml = await readFile(result.htmlPath, "utf8");
    assert.doesNotMatch(staticHtml, /background-color:\s*;/);
    assert.match(staticHtml, /--empty-token:\s*;/);
    assert.match(
      staticHtml,
      /<div id="presentation-slides-wrapper"[^>]*>\s*<div data-presenton-slide-shell="true"[^>]*>\s*<main class="slide" data-presenton-authored-slide="true"/,
    );
    assert.match(staticHtml, new RegExp(`\\[data-presenton-page-id="${PAGE_ID}"\\](?:, \\[data-presenton-page-id="${PAGE_ID}"\\])?\\{[^}]*display: flex`));
    assert.doesNotMatch(staticHtml, new RegExp(`\\[data-presenton-page-id="${PAGE_ID}"\\]\\.slide\\{[^}]*display: flex`));
    assert.match(staticHtml, /\.slide\{[^}]*padding-top:\s*60px/);

    const image = sharp(result.screenshotPath);
    const metadata = await image.metadata();
    assert.ok(metadata.width);
    assert.ok(metadata.height);
    const pixel = await image
      .extract({
        left: Math.floor((101 * metadata.width) / 1920),
        top: Math.floor((101 * metadata.height) / 1080),
        width: 1,
        height: 1,
      })
      .removeAlpha()
      .raw()
      .toBuffer();
    assert.deepEqual(Array.from(pixel.subarray(0, 3)), [251, 246, 236]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
