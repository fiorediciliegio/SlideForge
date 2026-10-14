import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { batchDirectory, candidateDirectory, fingerprint, readBatch, writeBatch } from "../../src/page-regeneration/store.ts";
import { prepareManifestRenderPlan } from "../../src/render/manifest-render-plan.ts";
import type { PageRegenerationBatch } from "../../src/page-regeneration/types.ts";

const PAGE1 = "page-11111111-1111-4111-8111-111111111111";
const PAGE2 = "page-22222222-2222-4222-8222-222222222222";
const snapshot = (content: string) => `<!doctype html><html data-presenton-render-document="static"><head><style>.slide{color:black}</style></head><body><div data-presenton-slide-shell="true"><div class="slide">${content}</div></div></body></html>`;
async function json(file: string, value: unknown) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2)); }

test("single-page regeneration persistence and adoption", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ppt-page-alternatives-test-"));
  const previousRoot = process.env.ANNA_WORKSPACE_DIR;
  process.env.ANNA_WORKSPACE_DIR = directory;
  const api = await import("../../src/app-workspace/index.ts");
  let sequence = 100000;
  async function fixture() {
    const workspaceDir = path.join(directory, "ppt", `ppt-20260911-${sequence++}`);
    const items = [PAGE1, PAGE2].map((id, index) => ({ page_id: id, page_type: "standard", title: `原始页 ${index + 1}`, content: "原始内容", copy_rewrite_freedom: 3 }));
    await json(path.join(workspaceDir, "task.json"), { workspace_format: "html-authoring-v1", title: "测试演示", artifacts: { pdf: { path: "old.pdf" }, pptx: { path: "old.pptx" } } });
    await json(path.join(workspaceDir, "outline.json"), { version: 4, title: "测试演示", status: "confirmed", items, updated_at: "2026-09-11T00:00:00.000Z", confirmed_at: "2026-09-11T00:00:00.000Z" });
    await json(path.join(workspaceDir, "manifest.json"), { title: "测试演示", slides: items.map((item) => ({ id: item.page_id, source: `./slides/${item.page_id}.html` })) });
    await mkdir(path.join(workspaceDir, "slides"));
    await mkdir(path.join(workspaceDir, "output"));
    for (const item of items) {
      await writeFile(path.join(workspaceDir, "slides", `${item.page_id}.html`), snapshot(item.title));
      await writeFile(path.join(workspaceDir, "output", `${item.page_id}.html`), snapshot(item.title));
      await writeFile(path.join(workspaceDir, "output", `${item.page_id}.png`), `screenshot ${item.title}`);
    }
    await writeFile(path.join(workspaceDir, "output", "deck.html"), "original deck");
    await json(path.join(workspaceDir, "page-progress.json"), { version: 1, status: "completed", updated_at: null,
      final_deck_render: { status: "completed", output_dir: path.join(workspaceDir, "output"), deck_html_path: path.join(workspaceDir, "output", "deck.html") },
      pages: items.map((item) => ({ page_id: item.page_id, status: "accepted", render_source_sha256: fingerprint(snapshot(item.title)), screenshot_source_sha256: fingerprint(snapshot(item.title)), last_html_path: path.join(workspaceDir, "output", `${item.page_id}.html`), last_screenshot_path: path.join(workspaceDir, "output", `${item.page_id}.png`) })),
    });
    await json(path.join(workspaceDir, "template-reference", "preset.json"), { id: "fixture", version: 1, name: "Fixture", description: "Test reference", reference_html_pages: [{ path: "html/reference.html", description: "Reference" }] });
    await mkdir(path.join(workspaceDir, "template-reference", "html"));
    await writeFile(path.join(workspaceDir, "template-reference", "html", "reference.html"), snapshot("Reference"));
    const workspace = await api.openAppWorkspace({ workspace_dir: workspaceDir });
    const item = { ...(workspace.outline as any).items[1], title: "新标题", content: "新内容" };
    const input = { workspace_dir: workspaceDir, page_id: PAGE2, count: 2, outline: item, reference_path: "html/reference.html", owner_id: randomUUID() };
    return { workspaceDir, workspace, input };
  }
  async function finishCandidates(workspaceDir: string, batch: PageRegenerationBatch) {
    for (const [index, candidate] of batch.candidates.entries()) {
      const candidateDir = candidateDirectory(workspaceDir, batch.id, candidate.id);
      await mkdir(path.join(candidateDir, "slides"), { recursive: true });
      const source = snapshot(`方案 ${index + 1}`);
      const image = Buffer.from(`rendered screenshot ${index + 1}`);
      Object.assign(candidate, { status: "ready", source_path: path.join(candidateDir, "slides", `${batch.page_id}.html`),
        html_path: path.join(candidateDir, "rendered.html"), screenshot_path: path.join(candidateDir, "preview.png"),
        source_sha256: fingerprint(source), html_sha256: fingerprint(source), screenshot_sha256: fingerprint(image) });
      await writeFile(candidate.source_path!, source);
      await writeFile(candidate.html_path!, source);
      // No screenshot is needed to preview or adopt a candidate.
    }
    batch.status = "ready";
    await writeBatch(workspaceDir, batch);
  }
  try {
    await t.test("creation validates bounds without changing official content; failures are isolated", async () => {
      const { workspaceDir, input } = await fixture();
      const outlineBefore = await readFile(path.join(workspaceDir, "outline.json"), "utf8");
      for (const count of [0, 11, 1.5]) await assert.rejects(api.createAppPageRegeneration({ ...input, count }), /INVALID_COUNT/);
      const batch = await api.createAppPageRegeneration(input);
      assert.equal(batch.candidates.length, 2);
      assert.equal(await readFile(path.join(workspaceDir, "outline.json"), "utf8"), outlineBefore);
      const failed = await api.failAppPageRegenerationCandidate({ workspace_dir: workspaceDir, batch_id: batch.id, candidate_id: batch.candidates[0].id, error: "test failure" });
      assert.equal(failed.candidates[0].status, "failed"); assert.equal(failed.candidates[1].status, "generating");
      await assert.rejects(api.adoptAppPageRegeneration({ workspace_dir: workspaceDir, batch_id: batch.id, candidate_id: batch.candidates[1].id }), /STILL_RUNNING/);
    });
    await t.test("beautification ignores edited outline and template inputs and adopts without changing either authority", async () => {
      const { workspaceDir, input } = await fixture();
      const outlinePath = path.join(workspaceDir, "outline.json");
      const referencePath = path.join(workspaceDir, "aesthetic-reference-selections.json");
      const outlineBefore = await readFile(outlinePath, "utf8");
      const referenceBefore = await readFile(referencePath, "utf8").catch(() => null);
      const batch = await api.createAppPageRegeneration({ ...input, mode: "beautify", reference_path: "unknown", outline: {} });
      assert.equal(batch.mode, "beautify");
      assert.equal(batch.outline.title, "原始页 2");
      assert.equal(await readFile(batch.source_html_path!, "utf8"), snapshot("原始页 2"));
      assert.equal(await readFile(batch.source_snapshot_html_path!, "utf8"), snapshot("原始页 2"));
      const regeneration = await api.createAppPageRegeneration(input);
      await mkdir(path.join(batchDirectory(workspaceDir, randomUUID()), "input"), { recursive: true });
      assert.equal((await api.getAppPageRegeneration({ workspace_dir: workspaceDir, page_id: PAGE2, mode: "beautify" }))?.id, batch.id);
      assert.equal((await api.getAppPageRegeneration({ workspace_dir: workspaceDir, page_id: PAGE2, mode: "regenerate" }))?.id, regeneration.id);
      await finishCandidates(workspaceDir, batch);
      const adopted = await api.adoptAppPageRegeneration({ workspace_dir: workspaceDir, batch_id: batch.id, candidate_id: batch.candidates[0].id });
      assert.equal(adopted.status, "adopted");
      assert.equal(await readFile(outlinePath, "utf8"), outlineBefore);
      assert.equal(await readFile(referencePath, "utf8").catch(() => null), referenceBefore);
      assert.match(await readFile(path.join(workspaceDir, "slides", `${PAGE2}.html`), "utf8"), /方案 1/);
      await assert.rejects(readFile(batch.source_html_path!), { code: "ENOENT" });
    });
    await t.test("expired generation and late submissions cannot publish", async () => {
      const { workspaceDir, input } = await fixture();
      const batch = await api.createAppPageRegeneration(input);
      batch.lease_expires_at = Date.now() - 1;
      await writeBatch(workspaceDir, batch);
      const expired = await api.getAppPageRegeneration({ workspace_dir: workspaceDir, batch_id: batch.id });
      assert.equal(expired?.status, "ready");
      assert.ok(expired?.candidates.every((candidate) => candidate.status === "failed"));
      const late = await api.submitAppPageRegenerationCandidate({ workspace_dir: workspaceDir, batch_id: batch.id, candidate_id: batch.candidates[0].id, staging_file_path: "/unused.html", expected_size_bytes: 1 });
      assert.equal(late.candidates[0].status, "failed");
    });
    await t.test("candidate rendering preserves real page number without copying other pages", async () => {
      const { workspaceDir, input } = await fixture();
      const batch = await api.createAppPageRegeneration(input);
      await finishCandidates(workspaceDir, batch);
      const candidateDir = candidateDirectory(workspaceDir, batch.id, batch.candidates[0].id);
      await writeFile(path.join(candidateDir, "manifest.json"), await readFile(path.join(workspaceDir, "manifest.json")));
      const plan = await prepareManifestRenderPlan({ manifestPath: path.join(candidateDir, "manifest.json"), outputDir: candidateDir, singlePage: true, page: 2 });
      assert.equal(plan.slides.length, 1); assert.equal(plan.slides[0].pageNumber, 2); assert.equal(plan.slides[0].context.totalPages, 2);
      await assert.rejects(readFile(path.join(candidateDir, "slides", `${PAGE1}.html`)), { code: "ENOENT" });
    });
    await t.test("adoption synchronizes outline, preserves other pages, invalidates exports, and is idempotent", async () => {
      const { workspaceDir, input } = await fixture();
      await json(path.join(workspaceDir, "manual-edits", PAGE2, "manifest.json"), { version: 1, page_id: PAGE2, revision: 1, manually_edited: true, current_html_path: "manual", agent_html_path: "manual.agent", screenshot_path: "manual.png" });
      await writeFile(path.join(workspaceDir, "manual-edits", PAGE2, "current.html"), snapshot("已保存的编辑"));
      const batch = await api.createAppPageRegeneration(input);
      await finishCandidates(workspaceDir, batch);
      const otherSource = await readFile(path.join(workspaceDir, "slides", `${PAGE1}.html`), "utf8");
      const result = await api.adoptAppPageRegeneration({ workspace_dir: workspaceDir, batch_id: batch.id, candidate_id: batch.candidates[1].id });
      assert.equal(result.status, "adopted");
      const workspace = await api.openAppWorkspace({ workspace_dir: workspaceDir });
      const outline = workspace.outline as any;
      assert.equal(outline.status, "confirmed");
      assert.deepEqual(outline.items.map((item: any) => item.page_id), [PAGE1, PAGE2]);
      assert.equal(outline.items[1].title, "新标题"); assert.equal(outline.items[1].content, "新内容");
      assert.equal(await readFile(path.join(workspaceDir, "slides", `${PAGE1}.html`), "utf8"), otherSource);
      assert.match(await readFile(path.join(workspaceDir, "slides", `${PAGE2}.html`), "utf8"), /方案 2/);
      assert.deepEqual((workspace.task as any).artifacts, {});
      const render = await api.getRenderedAppWorkspaceDeckHtml({ workspace_dir: workspaceDir });
      const deck = await readFile(render.deck_html_path, "utf8");
      assert.match(deck, /原始页 1/); assert.match(deck, /方案 2/); assert.doesNotMatch(deck, /原始页 2/);
      assert.equal(render.slides[1].manually_edited, false);
      await assert.rejects(readFile(path.join(batchDirectory(workspaceDir, batch.id), "candidates", batch.candidates[0].id, "rendered.html")), { code: "ENOENT" });
      const retry = await api.adoptAppPageRegeneration({ workspace_dir: workspaceDir, batch_id: batch.id, candidate_id: batch.candidates[1].id });
      assert.equal(retry.selected_id, result.selected_id);
      await assert.rejects(api.adoptAppPageRegeneration({ workspace_dir: workspaceDir, batch_id: batch.id, candidate_id: batch.candidates[0].id }), /ALREADY_ADOPTED/);
    });
    await t.test("manual image reuse is private until adoption and unavailable selections are rejected", async () => {
      const { workspaceDir, input } = await fixture();
      const context = await api.getAppSharedResearchContext({ workspace_dir: workspaceDir });
      await mkdir(context.images_dir, { recursive: true });
      const file = path.join(context.images_dir, "shared.png");
      await writeFile(file, "shared image");
      await json(context.image_catalog_path, { schema_version: 2, assets: [{ asset_id: "shared", file_path: file, sha256: "shared", mime_type: "image/png", bytes_size: 12, description: "Shared image", reason: "Relevant", source_url: "https://example.test", matched_queries: [] }] });
      const outlinePath = path.join(workspaceDir, "outline.json");
      const originalOutline = JSON.parse(await readFile(outlinePath, "utf8"));
      originalOutline.items[0].selected_image_ids = ["shared"];
      await json(outlinePath, originalOutline);
      await assert.rejects(api.createAppPageRegeneration({ ...input, outline: { ...input.outline, selected_image_ids: ["missing"] } }), /unavailable/);
      const batch = await api.createAppPageRegeneration({ ...input, outline: { ...input.outline, selected_image_ids: ["shared"] } });
      assert.equal(JSON.parse(await readFile(outlinePath, "utf8")).items[1].selected_image_ids, undefined);
      await finishCandidates(workspaceDir, batch);
      await json(context.image_catalog_path, { schema_version: 2, assets: [] });
      await assert.rejects(api.adoptAppPageRegeneration({ workspace_dir: workspaceDir, batch_id: batch.id, candidate_id: batch.candidates[0].id }), /unavailable/);
      await json(context.image_catalog_path, { schema_version: 2, assets: [{ asset_id: "shared", file_path: file, sha256: "shared", mime_type: "image/png", bytes_size: 12, description: "Shared image", reason: "Relevant", source_url: "https://example.test", matched_queries: [] }] });
      await api.adoptAppPageRegeneration({ workspace_dir: workspaceDir, batch_id: batch.id, candidate_id: batch.candidates[0].id });
      const adopted = JSON.parse(await readFile(outlinePath, "utf8"));
      assert.deepEqual(adopted.items.map((item: any) => item.selected_image_ids), [["shared"], ["shared"]]);
      assert.equal(await readFile(file, "utf8"), "shared image");
    });
    await t.test("changed official page or changed candidate rejects adoption and preserves alternatives", async () => {
      const { workspaceDir, input } = await fixture();
      const batch = await api.createAppPageRegeneration(input);
      await finishCandidates(workspaceDir, batch);
      await writeFile(path.join(workspaceDir, "slides", `${PAGE2}.html`), "newer user change");
      await assert.rejects(api.adoptAppPageRegeneration({ workspace_dir: workspaceDir, batch_id: batch.id, candidate_id: batch.candidates[0].id }), /CONFLICT/);
      assert.equal(await readFile(path.join(workspaceDir, "slides", `${PAGE2}.html`), "utf8"), "newer user change");
      assert.equal((await readBatch(workspaceDir, batch.id)).status, "ready");
      const another = await fixture();
      const altered = await api.createAppPageRegeneration(another.input);
      await finishCandidates(another.workspaceDir, altered);
      await writeFile(altered.candidates[0].source_path!, "different than the screenshot");
      await assert.rejects(api.adoptAppPageRegeneration({ workspace_dir: another.workspaceDir, batch_id: altered.id, candidate_id: altered.candidates[0].id }), /CONFLICT/);
    });
  } finally {
    if (previousRoot === undefined) delete process.env.ANNA_WORKSPACE_DIR; else process.env.ANNA_WORKSPACE_DIR = previousRoot;
    await rm(directory, { recursive: true, force: true });
  }
});
