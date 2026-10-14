import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertSelfContainedHtml, localResourceReferences } from "../src/html-resources.mjs";

test("self-contained HTML rejects local resources that are not published", async () => {
  const root = await mkdtemp(join(tmpdir(), "slideforge-preview-renderer-"));
  try {
    const htmlPath = join(root, "page.html");
    await writeFile(htmlPath, '<img src="../assets/image.png"><style>.x{background:url(../assets/image.png)}</style>');
    await assert.rejects(() => assertSelfContainedHtml(htmlPath), /must be self-contained/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resource parser ignores external, fragment, and data URLs", () => {
  const resources = localResourceReferences([
    '<link rel="stylesheet" href="https://fonts.example/a.css">',
    '<img src="data:image/png;base64,abc">',
    '<svg><use href="#symbol"></use></svg>',
  ].join(""));
  assert.deepEqual(resources, []);
});

test("resource parser finds stylesheets, images, posters, and CSS URLs", () => {
  const resources = localResourceReferences([
    '<a href="local-page.html">Link</a>',
    '<link rel="stylesheet" href="../assets/template.css">',
    '<img src="../assets/cover.jpg">',
    '<video poster="../assets/poster.jpg"></video>',
    '<style>.hero{background:url("../assets/background.png")}</style>',
  ].join(""));
  assert.deepEqual(resources, [
    "../assets/template.css",
    "../assets/cover.jpg",
    "../assets/poster.jpg",
    "../assets/background.png",
  ]);
});
