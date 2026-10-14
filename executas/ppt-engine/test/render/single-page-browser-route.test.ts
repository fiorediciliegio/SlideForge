import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("single-page rendering uses one queued browser task and reopens the persisted HTML", async () => {
  const browserArtifacts = await readFile(
    new URL("../../src/render/browser-artifacts.ts", import.meta.url),
    "utf8",
  );
  const buildDeck = await readFile(
    new URL("../../src/render/build-deck-from-manifest.tsx", import.meta.url),
    "utf8",
  );
  const combined = browserArtifacts.slice(
    browserArtifacts.indexOf("export async function staticizeAndWriteSlideScreenshots("),
    browserArtifacts.indexOf("export interface StaticizeSlideScreenshotResult"),
  );
  const singleSlide = browserArtifacts.slice(browserArtifacts.indexOf("async function staticizeSingleSlide("),
    browserArtifacts.indexOf("export async function staticizeAndWriteSlideScreenshots("));
  const singlePage = buildDeck.slice(
    buildDeck.indexOf("export async function buildDeckPageScreenshotFromManifest("),
    buildDeck.indexOf("export async function buildDeckHtmlFromManifest("),
  );

  assert.equal(combined.match(/withQueuedManagedPage\(/g)?.length, 1);
  assert.equal(singleSlide.match(/page\.goto\(slideUrl/g)?.length, 2);
  assert.ok(singleSlide.indexOf("writeFile(slide.htmlPath") < singleSlide.lastIndexOf("page.goto(slideUrl"));
  assert.ok(singleSlide.lastIndexOf("page.goto(slideUrl") < singleSlide.indexOf("slideElement.screenshot"));
  assert.ok(singleSlide.lastIndexOf("page.goto(slideUrl") < singleSlide.indexOf("await slide.onStaticSlideReady"));
  assert.match(singlePage, /staticizeAndWriteSlideScreenshots\(\[\{ htmlPath, outputPath: screenshotPath, onStaticSlideReady: input.onStaticSlideReady \}\]\)/);
  assert.doesNotMatch(singlePage, /staticizeHtmlDocuments|writeSlideScreenshots/);
});
