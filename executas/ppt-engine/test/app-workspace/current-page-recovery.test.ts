import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ids = ["page-11111111-1111-4111-8111-111111111111", "page-22222222-2222-4222-8222-222222222222"];
const date = "2026-09-18T03:00:00.000Z";
const html = (text: string) => `<!doctype html><html><head></head><body><div data-presenton-slide-shell="true"><div class="slide">${text}</div></div></body></html>`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

test("恢复后的人工修订、预览指纹和整份演示使用同一当前版本", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ppt-current-page-recovery-")));
  const previousRoot = process.env.ANNA_WORKSPACE_DIR;
  process.env.ANNA_WORKSPACE_DIR = root;
  const api = await import("../../src/app-workspace/index.js");
  const { buildStaticDeckHtml } = await import("../../src/render/build-deck.js");
  const { resolveCurrentPageSnapshot } = await import("../../src/page-html-preview/current-page.js");
  let sequence = 100000;
  async function fixture(completed = true) {
    const workspaceDir = path.join(root, "ppt", `ppt-20260918-${sequence++}`);
    const output = path.join(workspaceDir, "output");
    const taskPath = path.join(workspaceDir, "task.json");
    const progressPath = path.join(workspaceDir, "page-progress.json");
    const sources = ids.map((_, index) => html(`原始内容 ${index + 1}`));
    const manualPath = path.join(workspaceDir, "manual-edits", ids[1], "current.html");
    const manualManifest = path.join(path.dirname(manualPath), "manifest.json");
    await mkdir(path.join(workspaceDir, "slides"), { recursive: true });
    await mkdir(output);
    for (const [index, id] of ids.entries()) {
      await writeFile(path.join(workspaceDir, "slides", `${id}.html`), sources[index]);
      await writeFile(path.join(output, `${id}.html`), sources[index]);
    }
    await json(taskPath, { workspace_format: "html-authoring-v1", title: "恢复测试", updated_at: date,
      artifacts: { pptx: { path: path.join(output, "deck.pptx") }, pdf: { path: path.join(output, "deck.pdf") } } });
    await writeFile(path.join(output, "deck.pptx"), "保留历史导出文件");
    await writeFile(path.join(output, "deck.pdf"), "保留历史导出文件");
    await json(path.join(output, "pptx-export.json"), { status: "completed" });
    await json(path.join(workspaceDir, "outline.json"), { version: 4, status: "empty", title: "", items: [],
      global_creation_requirements: "", updated_at: null, confirmed_at: null });
    await json(path.join(workspaceDir, "manifest.json"), { title: "恢复测试", slides: ids.map((id) => ({ id, source: `./slides/${id}.html` })) });
    await json(manualManifest, { version: 1, page_id: ids[1], revision: 2, manually_edited: true,
      base_source_sha256: hash(sources[1]), base_html_sha256: hash(sources[1]), current_html_sha256: hash(html("已保存的人工内容")),
      current_html_path: manualPath, base_html_path: path.join(path.dirname(manualPath), "base.html"), updated_at: date });
    await writeFile(manualPath, html("已保存的人工内容"));
    await writeFile(path.join(path.dirname(manualPath), "base.html"), sources[1]);
    await writeFile(path.join(output, "old-deck.html"), buildStaticDeckHtml({ title: "恢复测试", pages: sources }));
    await json(progressPath, { version: 1, status: completed ? "completed" : "running", updated_at: date,
      recovery: { status: completed ? "completed" : "interrupted", run_kind: "final-deck-render", step: "complete" },
      final_deck_render: { status: "completed", output_dir: output, deck_html_path: path.join(output, "old-deck.html") },
      pages: ids.map((id, index) => ({ page_id: id, status: "interrupted", render_attempts: 0,
        last_html_path: path.join(output, `${id}.html`), render_source_sha256: hash(sources[index]),
        snapshot_source_sha256: hash(sources[index]), updated_at: date })) });
    return { workspaceDir, output, taskPath, progressPath, manualPath, manualManifest };
  }
  try {
    await t.test("旧修订迁入 slides，删除 output 后仍保留已保存内容", async () => {
      const f = await fixture();
      const source = path.join(f.workspaceDir, "slides", `${ids[1]}.html`);
      const listing = await api.getRenderedAppWorkspaceDeckHtml({ workspace_dir: f.workspaceDir });
      assert.equal(listing.slides[1].html_path, source);
      assert.match(await readFile(source, "utf8"), /已保存的人工内容/);
      await assert.rejects(readFile(f.manualPath), { code: "ENOENT" });
      const before = await readFile(f.manualManifest, "utf8");
      assert.equal(JSON.parse(before).source_authority, "slides");
      assert.equal(JSON.parse(before).revision, 2);
      await rm(f.output, { recursive: true });
      assert.match((await api.getAppWorkspacePageHtml({ workspace_dir: f.workspaceDir, page_id: ids[1] })).html, /已保存的人工内容/);
      assert.equal(await readFile(f.manualManifest, "utf8"), before);
    });
    await t.test("打开完成作品不重建缺失预览、不迁移页面正文且重复打开幂等", async () => {
      const f = await fixture();
      await rm(f.output, { recursive: true });
      const source = path.join(f.workspaceDir, "slides", `${ids[1]}.html`);
      const sourceBefore = await readFile(source, "utf8");
      const manualBefore = await readFile(f.manualPath, "utf8");
      const opened = await api.openAppWorkspace({ workspace_dir: f.workspaceDir });
      const progress = opened.page_progress as any;
      assert.equal(progress.status, "completed");
      assert.deepEqual(progress.pages.map((page: any) => page.status), ["interrupted", "interrupted"]);
      await assert.rejects(readFile(progress.final_deck_render.deck_html_path), { code: "ENOENT" });
      assert.equal(await readFile(source, "utf8"), sourceBefore);
      assert.equal(await readFile(f.manualPath, "utf8"), manualBefore);
      assert.ok(JSON.parse(await readFile(f.taskPath, "utf8")).artifacts.pptx);
      assert.equal(JSON.parse(await readFile(f.taskPath, "utf8")).updated_at, date);
      const before = await readFile(f.progressPath, "utf8");
      await api.openAppWorkspace({ workspace_dir: f.workspaceDir });
      assert.equal(await readFile(f.progressPath, "utf8"), before);
    });
    await t.test("历史指纹失配不阻止恢复当前正式源码", async () => {
      const f = await fixture();
      const source = html("当前正式内容");
      await writeFile(path.join(f.workspaceDir, "slides", `${ids[0]}.html`), source);
      await rm(f.output, { recursive: true });
      const result = await api.performAppWorkspacePagePreviews({ workspace_dir: f.workspaceDir });
      assert.ok(result.pages.every((page) => page.status !== "render_failed"));
      const progress = await api.getAppPageProgress({ workspace_dir: f.workspaceDir });
      assert.equal(progress.pages[0].snapshot_source_sha256, hash(source));
      assert.match((await api.getAppWorkspacePageHtml({ workspace_dir: f.workspaceDir, page_id: ids[0] })).html, /当前正式内容/);
    });
    await t.test("未完成创作不因缓存重建被自动接受", async () => {
      const f = await fixture(false);
      await api.performAppWorkspacePagePreviews({ workspace_dir: f.workspaceDir });
      const after = await api.getAppPageProgress({ workspace_dir: f.workspaceDir });
      assert.equal(after.status, "running");
      assert.deepEqual(after.pages.map((page) => page.status), ["interrupted", "interrupted"]);
    });
    await t.test("旧人工正文缺失不静默回退源码", async () => {
      const f = await fixture();
      await rm(f.manualPath);
      await assert.rejects(api.getAppWorkspacePageHtml({ workspace_dir: f.workspaceDir, page_id: ids[1] }), { code: "ENOENT" });
      assert.match(await readFile(path.join(f.workspaceDir, "slides", `${ids[1]}.html`), "utf8"), /原始内容 2/);
    });
    await t.test("完成分类不依赖预览文件", async () => {
      const f = await fixture();
      await rm(f.output, { recursive: true });
      const listing = await api.listAppWorkspaces();
      const item = listing.workspaces.find((item) => item.workspace_dir === f.workspaceDir)!;
      assert.equal(item.generation_completed, true);
      assert.equal(item.has_deck_html, false);
    });
    await t.test("恢复使用当前源码而非编辑前版本", async () => {
      const f = await fixture();
      const option = await api.prepareAppPageRecovery({ workspace_dir: f.workspaceDir, page_id: ids[1] });
      assert.equal(option.source, "original_source");
      const restored = await api.restoreAppPageSourceVersion({ workspace_dir: f.workspaceDir, page_id: ids[1], recovery_token: option.recovery_token });
      assert.equal(restored.restored, true);
      const preview = await api.getAppWorkspacePageHtml({ workspace_dir: f.workspaceDir, page_id: ids[1], expected_preview_fingerprint: restored.preview_source_fingerprint });
      assert.match(preview.html, /已保存的人工内容/);
      await rm(f.output, { recursive: true });
      assert.match((await api.getAppWorkspacePageHtml({ workspace_dir: f.workspaceDir, page_id: ids[1] })).html, /已保存的人工内容/);
    });
    await t.test("确认期间源码变化时拒绝覆盖", async () => {
      const f = await fixture();
      const option = await api.prepareAppPageRecovery({ workspace_dir: f.workspaceDir, page_id: ids[1] });
      const file = path.join(f.workspaceDir, "slides", `${ids[1]}.html`);
      await writeFile(file, html("较新的保存"));
      await assert.rejects(api.restoreAppPageSourceVersion({ workspace_dir: f.workspaceDir, page_id: ids[1], recovery_token: option.recovery_token }), /PAGE_RECOVERY_CONFLICT/);
      assert.match(await readFile(file, "utf8"), /较新的保存/);
    });
    await t.test("生成替换旧人工页面后不会再次迁入旧编辑", async () => {
      const f = await fixture();
      await json(path.join(f.workspaceDir, "outline.json"), { version: 4, status: "confirmed", title: "测试", updated_at: date, confirmed_at: date,
        items: ids.map((page_id) => ({ page_id, title: page_id, content: "测试", page_type: "standard" })) });
      const content = html("新生成的正式页面");
      const staging = path.join(root, "generated.html");
      await writeFile(staging, content);
      await api.recordAppWorkspacePageHtml({ workspace_dir: f.workspaceDir, page_id: ids[1],
        staging_file_path: staging, expected_size_bytes: Buffer.byteLength(content) });
      const result = await api.getAppWorkspacePageHtml({ workspace_dir: f.workspaceDir, page_id: ids[1] });
      assert.match(result.html, /新生成的正式页面/);
      assert.doesNotMatch(result.html, /已保存的人工内容/);
    });
    await t.test("重复恢复令牌只能提交一次且不重置保存版本", async () => {
      const f = await fixture();
      const option = await api.prepareAppPageRecovery({ workspace_dir: f.workspaceDir, page_id: ids[1] });
      const before = await readFile(f.manualManifest, "utf8");
      const results = await Promise.allSettled([1, 2].map(() => api.restoreAppPageSourceVersion({
        workspace_dir: f.workspaceDir, page_id: ids[1], recovery_token: option.recovery_token })));
      assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
      assert.equal(await readFile(f.manualManifest, "utf8"), before);
    });
    await t.test("发布失败时保留当前源码与进度", async () => {
      const f = await fixture();
      const option = await api.prepareAppPageRecovery({ workspace_dir: f.workspaceDir, page_id: ids[1] });
      const source = path.join(f.workspaceDir, "slides", `${ids[1]}.html`);
      const before = await readFile(source, "utf8");
      const progress = await readFile(f.progressPath, "utf8");
      await mkdir(path.join(f.output, "app-render", `${path.basename(f.workspaceDir)}-review-deck.html`), { recursive: true });
      await assert.rejects(api.restoreAppPageSourceVersion({ workspace_dir: f.workspaceDir, page_id: ids[1], recovery_token: option.recovery_token }));
      assert.equal(await readFile(source, "utf8"), before);
      assert.equal(await readFile(f.progressPath, "utf8"), progress);
    });
    await t.test("迁移拒绝越界符号链接", async () => {
      const f = await fixture();
      const outside = path.join(root, "outside.html");
      await writeFile(outside, html("外部文件"));
      await rm(f.manualPath);
      await symlink(outside, f.manualPath);
      await assert.rejects(resolveCurrentPageSnapshot({ workspaceDir: f.workspaceDir, pageId: ids[1] }), /outside its Workspace/);
      assert.match(await readFile(path.join(f.workspaceDir, "slides", `${ids[1]}.html`), "utf8"), /原始内容 2/);
    });
  } finally {
    if (previousRoot === undefined) delete process.env.ANNA_WORKSPACE_DIR;
    else process.env.ANNA_WORKSPACE_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
