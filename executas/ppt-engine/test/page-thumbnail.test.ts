import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { ensurePageThumbnail, preparePageThumbnail } from "../src/page-html-preview/thumbnail.ts";
import { writeSlideWebpThumbnail } from "../src/render/browser-artifacts.ts";
import { cleanupGeneratedPageImages } from "../src/page-html-preview/cleanup.ts";
import { fingerprintPageSnapshot } from "../src/page-html-preview/snapshot.ts";

test("page thumbnail is one reusable WebP per current page version, survives opening, and follows asset edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-thumbnail-"));
  try {
    await mkdir(path.join(root, "page-assets"));
    const asset = path.join(root, "page-assets", "photo.png");
    const htmlPath = path.join(root, "page.html");
    await writeFile(asset, "first image");
    await writeFile(htmlPath, '<html><body><img src="page-assets/photo.png">Original</body></html>');
    let captures = 0;
    const capture = async (slides: Array<{ outputPath: string }>, _purpose?: string, options?: { thumbnailMaxEdge?: number }) => {
      captures++;
      assert.equal(options?.thumbnailMaxEdge, 640);
      await sharp({ create: { width: 640, height: 360, channels: 3, background: "red" } }).webp().toFile(slides[0].outputPath);
    };
    const input = { workspaceDir: root, pageId: "page-a", htmlPath };
    const [first, same] = await Promise.all([ensurePageThumbnail(input, capture), ensurePageThumbnail(input, capture)]);
    assert.equal(captures, 1);
    assert.equal(first.image_path, same.image_path);
    assert.equal((await sharp(await readFile(first.image_path)).metadata()).format, "webp");
    await cleanupGeneratedPageImages(root, [{ last_html_path: htmlPath }]);
    assert.ok(await stat(first.image_path));
    await writeFile(asset, "different image");
    await assert.rejects(ensurePageThumbnail({ ...input, expectedFingerprint: first.preview_source_fingerprint }, capture), /version changed/);
    assert.equal(captures, 1);
    const updated = await ensurePageThumbnail(input, capture);
    assert.notEqual(updated.image_path, first.image_path);
    assert.equal(captures, 2);
    assert.equal((await readdir(path.dirname(updated.image_path))).filter((name) => name.endsWith(".webp")).length, 1);
    await assert.rejects(stat(first.image_path), { code: "ENOENT" });
    // The cached fingerprint remains valid when reopening without any screenshot PNG.
    assert.equal((await ensurePageThumbnail(input, capture)).preview_source_fingerprint, await fingerprintPageSnapshot(root, htmlPath));
    assert.equal(captures, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("thumbnail capture failure or concurrent edit never publishes partial/stale WebP and can retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-thumbnail-race-"));
  try {
    const htmlPath = path.join(root, "page.html");
    await writeFile(htmlPath, "<html>Before</html>");
    const input = { workspaceDir: root, pageId: "page-a", htmlPath };
    const bytes = await sharp({ create: { width: 360, height: 640, channels: 3, background: "blue" } }).webp().toBuffer();
    let directory = "";
    await assert.rejects(ensurePageThumbnail(input, async (slides) => {
      directory = path.dirname(slides[0].outputPath);
      await writeFile(slides[0].outputPath, bytes);
      await writeFile(htmlPath, "<html>After</html>");
    }), /changed during/);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(ensurePageThumbnail(input, async () => { throw new Error("capture failed"); }), /capture failed/);
    const result = await ensurePageThumbnail(input, async (slides) => { await writeFile(slides[0].outputPath, bytes); });
    assert.equal(result.width, 360);
    assert.equal(result.height, 640);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("browser capture writes only a small WebP at either aspect ratio", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-thumbnail-capture-"));
  try {
    for (const [width, height] of [[1920, 1080], [1080, 1920]]) {
      const source = await sharp({ create: { width, height, channels: 3, background: "white" } }).png().toBuffer();
      const file = path.join(root, `${width}.webp`);
      await writeSlideWebpThumbnail({ screenshot: async () => source, evaluate: async () => undefined as never }, file);
      const metadata = await sharp(await readFile(file)).metadata();
      assert.equal(metadata.format, "webp");
      assert.equal(Math.max(metadata.width!, metadata.height!), 640);
      assert.equal(metadata.width! / metadata.height!, width / height);
    }
    assert.ok((await readdir(root)).every((file) => file.endsWith(".webp")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("warming a thumbnail inside a browser task does not wait on another capture of that page", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-thumbnail-busy-"));
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  try {
    const htmlPath = path.join(root, "page.html");
    await writeFile(htmlPath, "<html>Page</html>");
    const input = { workspaceDir: root, pageId: "page-a", htmlPath };
    const first = ensurePageThumbnail(input, async (slides) => {
      started(); await wait;
      await sharp({ create: { width: 640, height: 360, channels: 3, background: "red" } }).webp().toFile(slides[0].outputPath);
    });
    await ready;
    await preparePageThumbnail(input, async () => { assert.fail("Should let the first request finish"); });
    release();
    assert.ok((await first).image_path.endsWith(".webp"));
  } finally { release?.(); await rm(root, { recursive: true, force: true }); }
});
