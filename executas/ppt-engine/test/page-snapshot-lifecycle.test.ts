import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fingerprintPageSnapshot, withTransientPageScreenshot } from "../src/page-html-preview/snapshot.ts";
import { cleanupGeneratedPageImages } from "../src/page-html-preview/cleanup.ts";

test("preview versions follow HTML and local asset bytes without PNGs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-snapshot-version-"));
  try {
    await mkdir(path.join(root, "page-assets"));
    const asset = path.join(root, "page-assets", "image.png"), htmlPath = path.join(root, "page.html");
    await writeFile(asset, "original");
    await writeFile(htmlPath, '<html><body><img src="page-assets/image.png">One</body></html>');
    const first = await fingerprintPageSnapshot(root, htmlPath);
    assert.equal(await fingerprintPageSnapshot(root, htmlPath), first);
    await writeFile(asset, "replaced");
    const second = await fingerprintPageSnapshot(root, htmlPath);
    assert.notEqual(second, first);
    await writeFile(htmlPath, '<html><body><img src="page-assets/image.png">Two</body></html>');
    assert.notEqual(await fingerprintPageSnapshot(root, htmlPath), second);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("session screenshots are removed after success, failure and version races", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-snapshot-temporary-"));
  try {
    const htmlPath = path.join(root, "page.html");
    for (const mode of ["success", "capture-failure", "upload-failure", "capture-race", "upload-race"]) {
      await writeFile(htmlPath, "<html><body>Original</body></html>");
      let temporary = "", consumed = false;
      const run = withTransientPageScreenshot(root, htmlPath, async (file) => {
        consumed = true;
        assert.equal(await readFile(file, "utf8"), "image bytes");
        assert.ok(!file.startsWith(root));
        if (mode === "upload-failure") throw new Error("upload failed");
        if (mode === "upload-race") await writeFile(htmlPath, "<html><body>Changed</body></html>");
        return "uploaded";
      }, { capture: async (slides) => {
        temporary = slides[0].outputPath;
        await writeFile(temporary, "image bytes");
        if (mode === "capture-failure") throw new Error("capture failed");
        if (mode === "capture-race") await writeFile(htmlPath, "<html><body>Changed</body></html>");
      } });
      if (mode === "success") assert.equal(await run, "uploaded");
      else await assert.rejects(run, mode.endsWith("failure") ? /failed/ : /Page changed/);
      assert.equal(consumed, mode !== "capture-race" && mode !== "capture-failure");
      await assert.rejects(stat(temporary), { code: "ENOENT" });
    }
    let captured = false;
    await assert.rejects(withTransientPageScreenshot(root, htmlPath, async () => "unused", {
      expectedFingerprint: "old", capture: async () => { captured = true; },
    }), /changed before/);
    assert.equal(captured, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("migration deletes generated images only after HTML is ready and preserves assets and symlink targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-snapshot-cleanup-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "ppt-snapshot-outside-"));
  try {
    const htmlPath = path.join(root, "page.html");
    for (const file of ["output/screenshots/page.png", "output/covers/cover.webp", "manual-edits/page/current.png", "page-assets/image.png"]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "preserve unless derived");
    }
    await writeFile(path.join(outside, "private.webp"), "private");
    await symlink(outside, path.join(root, "output", "page-previews"), "dir");
    await cleanupGeneratedPageImages(root, [{ last_html_path: htmlPath }]);
    assert.ok(await stat(path.join(root, "output/screenshots/page.png")));
    await writeFile(htmlPath, "<html>Static</html>");
    await writeFile(path.join(root, "manual-edits/page/current.html"), "<html>Edited</html>");
    await cleanupGeneratedPageImages(root, [{ last_html_path: htmlPath }]);
    for (const file of ["output/screenshots/page.png", "output/covers/cover.webp", "manual-edits/page/current.png"]) {
      await assert.rejects(stat(path.join(root, file)), { code: "ENOENT" });
    }
    assert.ok(await stat(path.join(root, "page-assets/image.png")));
    assert.equal(await readFile(path.join(outside, "private.webp"), "utf8"), "private");
    await cleanupGeneratedPageImages(root, [{ last_html_path: htmlPath }]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
