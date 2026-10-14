import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCurrentPageSnapshot } from "../../src/page-html-preview/current-page.js";
import { readPagePreviewFallbacks } from "../../src/page-html-preview/fallback.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("新预览缓存按页面隔离，旧缓存仍可读取", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-current-page-cache-"));
  const ids = ["page-a", "page-b"];
  const source = "<!doctype html><html><body>dynamic source</body></html>";
  const manifest = JSON.stringify({ slides: ids.map((id) => ({ id, source: `./slides/${id}.html` })) });
  try {
    await mkdir(path.join(root, "slides"));
    for (const id of ids) await writeFile(path.join(root, "slides", `${id}.html`), source);
    await writeFile(path.join(root, "manifest.json"), manifest);
    const renderHash = hash(ids[0] + hash(source) + manifest).slice(0, 24);
    const newCache = path.join(root, "output", "page-preview-html", `${ids[0]}-current-${renderHash}.html`);
    await mkdir(path.dirname(newCache), { recursive: true });
    await writeFile(newCache, '<html><body><div data-presenton-slide-shell="true" data-presenton-page-id="page-a">A</div></body></html>');
    const first = await resolveCurrentPageSnapshot({ workspaceDir: root, pageId: ids[0] });
    assert.equal(first.htmlPath, await realpath(newCache));
    const fallbacks = readPagePreviewFallbacks({ workspaceDir: root, pageId: ids[0] });
    assert.equal((await fallbacks.next()).value?.html_path, await realpath(newCache));

    const oldHash = hash(hash(source) + manifest).slice(0, 24);
    const legacy = path.join(root, "output", "current-page-previews", oldHash, "current.html");
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, '<html><body><div data-presenton-slide-shell="true" data-presenton-page-id="page-b">B</div></body></html>');
    const second = await resolveCurrentPageSnapshot({ workspaceDir: root, pageId: ids[1] });
    assert.equal(second.htmlPath, await realpath(legacy));
    assert.notEqual(first.htmlPath, second.htmlPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
