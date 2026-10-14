import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareBeautificationSource } from "../src/page-regeneration/beautification.ts";
import { fingerprint } from "../src/page-regeneration/store.ts";

const pageId = `page-${randomUUID()}`;
const source = '<!doctype html><html><body><div class="slide">原文</div></body></html>';

test("beautification captures slides source and only reuses a matching snapshot, including saved manual pages", async (t) => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "ppt-beautification-"));
  try {
    await mkdir(path.join(workspaceDir, "slides"));
    await mkdir(path.join(workspaceDir, "output", "page-preview-html"), { recursive: true });
    await writeFile(path.join(workspaceDir, "slides", `${pageId}.html`), source);
    await writeFile(path.join(workspaceDir, "output", "page-preview-html", `${pageId}.html`), "polluted preview @font-face");
    await writeFile(path.join(workspaceDir, "manifest.json"), JSON.stringify({ title: "Deck", slides: [{ id: "other" }, { id: pageId, source: `./slides/${pageId}.html` }] }));
    const snapshotHtmlPath = path.join(workspaceDir, "current.html");
    await writeFile(snapshotHtmlPath, "matching snapshot");
    for (const scenario of ["matching", "manual", "stale", "missing"] as const) {
      await t.test(scenario, async () => {
        let renders = 0;
        const result = await prepareBeautificationSource({
          workspaceDir, pageId, pageIndex: 1, batchId: randomUUID(), manuallyEdited: scenario === "manual",
          snapshotHtmlPath: scenario === "missing" ? path.join(workspaceDir, "missing.html") : snapshotHtmlPath, renderedSourceHash: fingerprint(source), snapshotSourceHash: scenario === "stale" ? "old" : fingerprint(source),
          render: async (input) => {
            renders++;
            assert.equal(input.page, 2);
            assert.equal(await readFile(path.join(path.dirname(input.manifestPath), "slides", `${pageId}.html`), "utf8"), source);
            const rendered = path.join(input.outputDir, "new.html");
            await writeFile(rendered, "source render");
            return { htmlPath: rendered };
          },
        });
        assert.equal(await readFile(result.source_html_path, "utf8"), source);
        assert.equal(await readFile(result.source_snapshot_html_path, "utf8"), ["matching", "manual"].includes(scenario) ? "matching snapshot" : "source render");
        assert.equal(renders, ["matching", "manual"].includes(scenario) ? 0 : 1);
        assert.equal(await readFile(path.join(workspaceDir, "slides", `${pageId}.html`), "utf8"), source);
      });
    }
  } finally { await rm(workspaceDir, { recursive: true, force: true }); }
});
