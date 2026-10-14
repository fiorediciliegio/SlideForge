import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureSinglePageSlideShell,
  normalizeManualPageResources,
  storeManualPageImage,
  extractSlideShell,
  manualPageRevisionPaths,
  publishManualPageIntoDeck,
  publishManualPageRevision,
  readManualPageRevision,
  replaceSinglePageSlideShell,
  replaceSlideShellAtIndex,
  sanitizeManualPageHtml,
} from "../src/manual-page-revisions/index.js";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pageHtml(content: string): string {
  return `<!doctype html><html><head><style>.x{color:red}</style></head><body><div id="presentation-slides-wrapper">${content}</div></body></html>`;
}

test("wraps a single-page render in exactly one slide shell", () => {
  const html = ensureSinglePageSlideShell(pageHtml("<div class=\"x\">hello</div>"));
  const extracted = extractSlideShell(html);
  assert.match(extracted.shell, /data-presenton-slide-shell="true"/);
  assert.match(extracted.shell, />hello</);
});

test("keeps Workspace-local images as file URLs for durable HTML", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "manual-page-embed-"));
  try {
    const imagePath = path.join(workspaceDir, "research", "evidence", "images", "image.png");
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, Buffer.from(PNG_1X1, "base64"));
    const source = pageHtml(`<img src="${new URL(`file://${imagePath}`).href}">`);
    const result = await normalizeManualPageResources(workspaceDir, "page-test", source);
    assert.match(result, /src="file:\/\//);
    assert.doesNotMatch(result, /data:image/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("normalizes Workspace-local absolute image paths to file URLs", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "manual-page-absolute-image-"));
  try {
    const imagePath = path.join(workspaceDir, "research", "evidence", "images", "image.png");
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, Buffer.from(PNG_1X1, "base64"));
    const result = await normalizeManualPageResources(workspaceDir, "page-test", pageHtml(`<img src="${imagePath}">`));
    assert.match(result, /src="file:\/\//);
    assert.match(result, /research\/evidence\/images\/image\.png/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("keeps uploaded attachment images as durable local resource references", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "manual-page-uploaded-asset-"));
  try {
    const imagePath = path.join(workspaceDir, "uploaded-sources", "asset", "uploaded-image.png");
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, Buffer.from(PNG_1X1, "base64"));
    const result = await normalizeManualPageResources(workspaceDir, "page-test", pageHtml(`<img src="${imagePath}">`));
    assert.match(result, /src="file:\/\//);
    assert.match(result, /uploaded-sources\/asset\/uploaded-image\.png/);
    assert.doesNotMatch(result, /data:image/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("rejects local image paths outside the allowed Workspace image directories", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "manual-page-outside-image-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "manual-page-outside-image-file-"));
  try {
    const imagePath = path.join(outsideDir, "image.png");
    await writeFile(imagePath, Buffer.from(PNG_1X1, "base64"));
    await assert.rejects(
      () => normalizeManualPageResources(workspaceDir, "page-test", pageHtml(`<img src="${imagePath}">`)),
      /allowed Workspace assets/i,
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("sanitizes Workspace-local absolute image paths before saving a manual revision", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "manual-page-sanitize-image-"));
  try {
    const imagePath = path.join(workspaceDir, "research", "evidence", "images", "image.png");
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, Buffer.from(PNG_1X1, "base64"));
    const result = await sanitizeManualPageHtml(workspaceDir, "page-test", pageHtml(`<img src="${imagePath}">`));
    assert.match(result.currentHtml, /src="file:\/\//);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("replaces only the single page shell", () => {
  const base = ensureSinglePageSlideShell(pageHtml("<div>old</div>"));
  const replacement = '<div data-presenton-slide-shell="true"><div>new</div></div>';
  const result = replaceSinglePageSlideShell(base, replacement);
  assert.match(result, /<style>\.x\{color:red\}<\/style>/);
  assert.doesNotMatch(result, />old</);
  assert.match(result, />new</);
});

test("replaces a requested deck shell without changing other pages", () => {
  const deck = '<div id="presentation-slides-wrapper"><div data-presenton-slide-shell="true"><p>one</p></div><div data-presenton-slide-shell="true"><template data-pptx-notes>keep this note</template><p>two</p></div></div>';
  const result = replaceSlideShellAtIndex(deck, 1, '<div data-presenton-slide-shell="true"><div data-presenton-deck-slot="1"><p>changed</p></div></div>');
  assert.match(result, />one</);
  assert.doesNotMatch(result, />two</);
  assert.match(result, />changed</);
  assert.match(result, /<template data-pptx-notes>keep this note<\/template>/);
  assert.match(result, /data-presenton-manual-page-revision="true"/);
  assert.doesNotMatch(result, /data-presenton-deck-slot/);
});

test("keeps replacement speaker notes when the manual shell already carries them", () => {
  const deck = '<div data-presenton-slide-shell="true"><template data-pptx-notes>old note</template><p>old</p></div>';
  const replacement = '<div data-presenton-slide-shell="true"><template data-pptx-notes>manual note</template><p>changed</p></div>';
  const result = replaceSlideShellAtIndex(deck, 0, replacement);
  assert.match(result, /manual note/);
  assert.doesNotMatch(result, /old note/);
});

test("publishes concurrent manual pages into one deck without losing either update", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "manual-deck-publish-"));
  try {
    const deckPath = path.join(workspaceDir, "deck.html");
    const firstPagePath = path.join(workspaceDir, "first.html");
    const secondPagePath = path.join(workspaceDir, "second.html");
    await writeFile(
      deckPath,
      '<div id="presentation-slides-wrapper"><div data-presenton-slide-shell="true"><p>old one</p></div><div data-presenton-slide-shell="true"><p>old two</p></div></div>',
    );
    await writeFile(firstPagePath, ensureSinglePageSlideShell(pageHtml("<p>new one</p>")));
    await writeFile(secondPagePath, ensureSinglePageSlideShell(pageHtml("<p>new two</p>")));

    await Promise.all([
      publishManualPageIntoDeck({ deckHtmlPath: deckPath, pageHtmlPath: firstPagePath, pageIndex: 0 }),
      publishManualPageIntoDeck({ deckHtmlPath: deckPath, pageHtmlPath: secondPagePath, pageIndex: 1 }),
    ]);

    const deck = await readFile(deckPath, "utf8");
    assert.match(deck, />new one</);
    assert.match(deck, />new two</);
    assert.doesNotMatch(deck, />old one</);
    assert.doesNotMatch(deck, />old two</);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("does not publish a manual page when the requested Deck shell is missing", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "manual-deck-missing-shell-"));
  try {
    const deckPath = path.join(workspaceDir, "deck.html");
    const pagePath = path.join(workspaceDir, "page.html");
    const originalDeck = '<div id="presentation-slides-wrapper"><div data-presenton-slide-shell="true"><p>one</p></div></div>';
    await writeFile(deckPath, originalDeck);
    await writeFile(pagePath, ensureSinglePageSlideShell(pageHtml("<p>changed</p>")));

    await assert.rejects(
      () => publishManualPageIntoDeck({ deckHtmlPath: deckPath, pageHtmlPath: pagePath, pageIndex: 1 }),
      /missing slide shell 2/i,
    );
    assert.equal(await readFile(deckPath, "utf8"), originalDeck);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("sanitizes active content and extracts legacy image data URLs into current HTML", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "manual-page-test-"));
  try {
    const source = pageHtml(`<script>alert(1)</script><div><img onload="alert(1)" src="data:image/png;base64,${PNG_1X1}"></div>`);
    const result = await sanitizeManualPageHtml(workspaceDir, "page-test", source);
    assert.doesNotMatch(result.currentHtml, /<script/i);
    assert.doesNotMatch(result.currentHtml, /onload=/i);
    assert.doesNotMatch(result.currentHtml, /data:image/);
    assert.match(result.currentHtml, /file:\/\//);
    assert.ok(!("agentHtml" in result));
    const paths = manualPageRevisionPaths(workspaceDir, "page-test");
    const assets = await readdir(paths.assetsDirectory);
    assert.equal(assets.length, 1);
    assert.ok((await readFile(path.join(paths.assetsDirectory, assets[0]!))).length > 0);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("publishes monotonically and rejects a stale base revision", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "manual-page-publish-"));
  try {
    await mkdir(path.join(workspaceDir, "slides"), { recursive: true });
    await writeFile(path.join(workspaceDir, "slides", "page-test.html"), "source");
    const paths = manualPageRevisionPaths(workspaceDir, "page-test");
    await writeFile(path.join(workspaceDir, "shot.png"), Buffer.from(PNG_1X1, "base64"));
    const html = ensureSinglePageSlideShell(pageHtml("<div>current</div>"));
    const first = await publishManualPageRevision({
      workspaceDir,
      pageId: "page-test",
      baseRevision: 0,
      baseHtml: html,
      currentHtml: html,
      screenshotPath: path.join(workspaceDir, "shot.png"),
      sourceBytes: Buffer.from("source"),
    });
    assert.equal(first.revision, 1);
    assert.equal(await readFile(path.join(workspaceDir, "slides", "page-test.html"), "utf8"), html);
    assert.equal((await readManualPageRevision(workspaceDir, "page-test"))?.revision, 1);
    await assert.rejects(() => publishManualPageRevision({
      workspaceDir,
      pageId: "page-test",
      baseRevision: 0,
      baseHtml: html,
      currentHtml: html,
      screenshotPath: paths.screenshot,
      sourceBytes: Buffer.from("source"),
    }), /conflict/i);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("allows only one of two concurrent saves from the same base revision", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "manual-page-concurrent-"));
  try {
    await mkdir(path.join(workspaceDir, "slides"), { recursive: true });
    await writeFile(path.join(workspaceDir, "slides", "page-test.html"), "source");
    const html = ensureSinglePageSlideShell(pageHtml("<div>current</div>"));
    const publish = async (name: string) => {
      const screenshotPath = path.join(workspaceDir, `${name}.png`);
      await writeFile(screenshotPath, Buffer.from(PNG_1X1, "base64"));
      return publishManualPageRevision({
        workspaceDir,
        pageId: "page-test",
        baseRevision: 0,
        baseHtml: html,
        currentHtml: html.replace("current", name),
        screenshotPath,
        sourceBytes: Buffer.from("source"),
      });
    };
    const results = await Promise.allSettled([publish("first"), publish("second")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.match(String((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason), /conflict/i);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("stores verified images by content hash and rejects mismatched or oversized inputs", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "manual-image-store-"));
  try {
    const bytes = Buffer.from(PNG_1X1, "base64");
    const first = await storeManualPageImage(workspaceDir, "page-test", bytes, "image/png");
    const second = await storeManualPageImage(workspaceDir, "page-test", bytes, "image/png");
    assert.deepEqual(first, second);
    assert.equal(first.width, 1);
    assert.equal(first.height, 1);
    assert.match(first.local_url, /page-assets\/page-test\/[a-f0-9]{64}\.png$/);
    assert.equal((await readdir(manualPageRevisionPaths(workspaceDir, "page-test").assetsDirectory)).length, 1);
    await assert.rejects(storeManualPageImage(workspaceDir, "page-test", bytes, "image/jpeg"), /Invalid manual image/);
    await assert.rejects(storeManualPageImage(workspaceDir, "page-test", bytes, "image/svg+xml"), /PNG, JPEG or WebP/);
    await assert.rejects(storeManualPageImage(workspaceDir, "page-test", Buffer.alloc(20 * 1024 * 1024 + 1), "image/png"), /20 MiB/);
    await assert.rejects(storeManualPageImage(workspaceDir, "../escape", bytes, "image/png"), /Invalid page_id/);
  } finally { await rm(workspaceDir, { recursive: true, force: true }); }
});

test("normalizes legacy CSS, srcset, SVG and embedded fonts without retaining Base64", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "manual-resource-roundtrip-"));
  try {
    const data = `data:image/png;base64,${PNG_1X1}`;
    const source = `<html><head><style>@font-face{font-family:Demo;src:url(data:font/woff2;base64,dGVzdA==)}.bg{background-image:image-set(url('${data}') 1x)}</style></head><body><img srcset="${data} 1x, ${data} 2x"><svg><image xlink:href="${data}"/></svg></body></html>`;
    const normalized = await normalizeManualPageResources(workspaceDir, "page-test", source);
    assert.doesNotMatch(normalized, /data:|base64/);
    assert.match(normalized, /\.woff2/);
    assert.match(normalized, /srcset="file:\/\//);
    assert.match(normalized, /xlink:href="file:\/\//);
    assert.equal(await normalizeManualPageResources(workspaceDir, "page-test", normalized), normalized);
    assert.equal((await readdir(manualPageRevisionPaths(workspaceDir, "page-test").assetsDirectory)).length, 2);
  } finally { await rm(workspaceDir, { recursive: true, force: true }); }
});

test("saving an old revision removes the Agent derivative and keeps only local current HTML", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "manual-legacy-publish-"));
  try {
    await mkdir(path.join(workspaceDir, "slides"), { recursive: true });
    await writeFile(path.join(workspaceDir, "slides", "page-test.html"), "original source");
    const paths = manualPageRevisionPaths(workspaceDir, "page-test");
    await mkdir(paths.directory, { recursive: true });
    const legacyPath = path.join(paths.directory, "current.agent.html");
    await writeFile(legacyPath, "legacy");
    const html = (await sanitizeManualPageHtml(workspaceDir, "page-test", pageHtml(`<img src="data:image/png;base64,${PNG_1X1}">`))).currentHtml;
    const screenshotPath = path.join(workspaceDir, "shot.png");
    await writeFile(screenshotPath, Buffer.from(PNG_1X1, "base64"));
    const manifest = await publishManualPageRevision({ workspaceDir, pageId: "page-test", baseRevision: 0,
      baseHtml: html, currentHtml: html, screenshotPath, sourceBytes: Buffer.from("original source") });
    assert.equal(await readFile(path.join(workspaceDir, "slides", "page-test.html"), "utf8"), html);
    await assert.rejects(readFile(paths.currentHtml), { code: "ENOENT" });
    assert.doesNotMatch(await readFile(paths.manifest, "utf8"), /agent_html/);
    assert.ok(!("agent_html_path" in manifest));
    await assert.rejects(readFile(legacyPath), { code: "ENOENT" });
  } finally { await rm(workspaceDir, { recursive: true, force: true }); }
});

test("normalization keeps the page saveable when a stylesheet is unparseable", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "manual-page-bad-css-"));
  try {
    const source = pageHtml(`<style>700</style><div class="x">hello</div>`);
    const result = await normalizeManualPageResources(workspaceDir, "page-test", source);
    assert.match(result, /<style>700<\/style>/);
    assert.match(result, />hello</);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});


test("source changes during validation cannot be overwritten by a manual save", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "manual-source-conflict-"));
  try {
    await mkdir(path.join(workspaceDir, "slides"));
    const source = path.join(workspaceDir, "slides", "page-test.html");
    await writeFile(source, "newer content");
    const html = ensureSinglePageSlideShell(pageHtml("saved edit"));
    await assert.rejects(publishManualPageRevision({ workspaceDir, pageId: "page-test", baseRevision: 0,
      baseHtml: html, currentHtml: html, sourceBytes: Buffer.from("old source") }), /source changed/);
    assert.equal(await readFile(source, "utf8"), "newer content");
    assert.equal(await readManualPageRevision(workspaceDir, "page-test"), null);
  } finally { await rm(workspaceDir, { recursive: true, force: true }); }
});
