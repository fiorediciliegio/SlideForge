import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { getPagePreviewPreparationStatus, submitPagePreviewPreparation } from "../../src/page-html-preview/preparation.js";
import { ensurePageThumbnail } from "../../src/page-html-preview/thumbnail.js";

const ids = ["page-a", "page-b"];
const html = '<!doctype html><html><body><div data-presenton-slide-shell="true">same source</div></body></html>';

test("单页准备按页面去重且不改变创作进度", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-preview-preparation-"));
  try {
    await mkdir(path.join(root, "slides"));
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({ slides: ids.map((id) => ({ id, source: `./slides/${id}.html` })) }));
    for (const id of ids) await writeFile(path.join(root, "slides", `${id}.html`), html);
    const first = await submitPagePreviewPreparation({ workspaceDir: root, pageId: ids[0], priority: "background" });
    const duplicate = await submitPagePreviewPreparation({ workspaceDir: root, pageId: ids[0], priority: "foreground" });
    const other = await submitPagePreviewPreparation({ workspaceDir: root, pageId: ids[1], priority: "background" });
    assert.equal(first.task_id, duplicate.task_id);
    assert.notEqual(first.task_id, other.task_id);
    for (const task of [first, other]) {
      let state = getPagePreviewPreparationStatus({ workspaceDir: root, taskId: task.task_id });
      for (let attempt = 0; attempt < 50 && state.status !== "ready" && state.status !== "error"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        state = getPagePreviewPreparationStatus({ workspaceDir: root, taskId: task.task_id });
      }
      assert.equal(state.status, "ready", state.error);
      assert.match(state.preview_source_fingerprint ?? "", /^[a-f0-9]{64}$/);
    }
    assert.throws(() => getPagePreviewPreparationStatus({ workspaceDir: `${root}-other`, taskId: first.task_id }),
      /no longer available/);

    await ensurePageThumbnail({ workspaceDir: root, pageId: ids[0],
      htmlPath: path.join(root, "slides", `${ids[0]}.html`) }, async (slides) => {
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } })
        .webp().toFile(slides[0].outputPath);
    });
    const thumbnail = await submitPagePreviewPreparation({ workspaceDir: root, pageId: ids[0], kind: "thumbnail" });
    assert.notEqual(thumbnail.task_id, first.task_id);
    let thumbnailState = getPagePreviewPreparationStatus({ workspaceDir: root, taskId: thumbnail.task_id });
    for (let attempt = 0; attempt < 50 && thumbnailState.status !== "ready" && thumbnailState.status !== "error"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      thumbnailState = getPagePreviewPreparationStatus({ workspaceDir: root, taskId: thumbnail.task_id });
    }
    assert.equal(thumbnailState.status, "ready", thumbnailState.error);

    await writeFile(path.join(root, "slides", `${ids[1]}.html`), "<!doctype html><html><body>needs staticization</body></html>");
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({ slides: [{ id: ids[0], source: `./slides/${ids[0]}.html` }] }));
    const broken = await submitPagePreviewPreparation({ workspaceDir: root, pageId: ids[1] });
    const usable = await submitPagePreviewPreparation({ workspaceDir: root, pageId: ids[0] });
    const settle = async (taskId: string) => {
      let state = getPagePreviewPreparationStatus({ workspaceDir: root, taskId });
      for (let attempt = 0; attempt < 50 && state.status !== "ready" && state.status !== "error"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        state = getPagePreviewPreparationStatus({ workspaceDir: root, taskId });
      }
      return state;
    };
    assert.equal((await settle(broken.task_id)).status, "error");
    assert.equal((await settle(usable.task_id)).status, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
