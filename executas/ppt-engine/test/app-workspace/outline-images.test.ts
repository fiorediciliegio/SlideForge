import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import sharp from "sharp";

test("outline images survive save, confirmation and reopen; invalid images and unsafe previews are rejected", async () => {
  const previous = process.env.SLIDEFORGE_WORKSPACE_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-outline-images-"));
  process.env.SLIDEFORGE_WORKSPACE_DIR = root;
  const engine = await import("../../src/app-workspace/index.ts");
  try {
    const created = await engine.createAppWorkspace({ title: "Images" });
    const workspace_dir = created.workspace_dir;
    const candidate = { label: "Review", description: "Review the match" };
    await engine.updateAppWorkspaceRequirements({ workspace_dir, requirements: {
      version: 1, status: "confirmed", source: { brief: "Tennis final" },
      candidates: { slide_count: [2], output_language: ["中文"] },
      selections: { slide_count: 2, output_language: "中文" },
      research: { web: { recommended: false, reason: "", enabled: false }, images: { recommended: true, reason: "", enabled: true } },
      updated_at: null, confirmed_at: null,
    } });
    const context = await engine.getAppSharedResearchContext({ workspace_dir });
    await mkdir(context.images_dir, { recursive: true });
    const file = path.join(context.images_dir, "portrait.png");
    await sharp({ create: { width: 800, height: 500, channels: 3, background: "#aabbcc" } }).png().toFile(file);
    const image = { asset_id: "portrait", file_path: file, sha256: "abc", mime_type: "image/png", bytes_size: 100, description: "A portrait", title: "Final preview", reason: "Player", source_url: "https://example.test", matched_queries: [] };
    await writeFile(context.image_catalog_path, JSON.stringify({ schema_version: 2, assets: [image] }));
    const page = (id: string[]) => ({ page_type: "standard" as const, title: "Player", content: "Player background", selected_image_ids: id });
    const outline = { title: "Tennis", items: [page(["portrait"]), page([])] };
    const saved = await engine.saveAppWorkspaceOutlineDraft({ workspace_dir, outline });
    assert.deepEqual((saved.outline as any).items[0].selected_image_ids, ["portrait"]);
    const confirmed = await engine.confirmAppWorkspaceOutline({ workspace_dir, outline: { ...outline, items: [...outline.items].reverse() } });
    assert.deepEqual((confirmed.outline as any).items[1].selected_image_ids, ["portrait"]);
    const reopened = await engine.getAppWorkspaceOutline({ workspace_dir });
    assert.deepEqual(reopened.items[1]?.selected_image_ids, ["portrait"]);
    const sharedOutline = { ...outline, items: [page(["portrait"]), page(["portrait"])] };
    await engine.saveAppWorkspaceOutlineDraft({ workspace_dir, outline: sharedOutline });
    await engine.confirmAppWorkspaceOutline({ workspace_dir, outline: sharedOutline });
    const shared = await engine.getAppWorkspaceOutline({ workspace_dir });
    assert.deepEqual(shared.items.map((item) => item.selected_image_ids), [["portrait"], ["portrait"]]);
    await assert.rejects(engine.saveAppWorkspaceOutlineDraft({ workspace_dir, outline: { ...outline, items: [page(["missing"])] } }), /unavailable/);
    await assert.rejects(engine.saveAppWorkspaceOutlineDraft({ workspace_dir, outline: { ...outline, items: [page(["portrait", "portrait"])] } }), /unique/);
    const preview = await engine.getAppOutlineImagePreview({ workspace_dir, asset_id: "portrait" });
    assert.deepEqual(await engine.resolveAppOutlineImage({ workspace_dir, asset_id: "portrait" }), { file_path: await realpath(file), mime_type: "image/png" });
    await assert.rejects(engine.resolveAppOutlineImage({ workspace_dir, asset_id: "missing" }), /Unknown/);
    assert.match(preview.preview_url, /^data:image\/webp;base64,/);
    assert.ok(preview.preview_url.length < 64000);
    const large = await engine.getAppOutlineImagePreview({ workspace_dir, asset_id: "portrait", size: "large" });
    const dimensions = async (url: string) => sharp(Buffer.from(url.split(",")[1], "base64")).metadata();
    assert.equal((await dimensions(preview.preview_url)).width, 400);
    assert.equal((await dimensions(large.preview_url)).width, 800);
    assert.ok(large.preview_url.length < 64000);
    await assert.rejects(engine.getAppOutlineImagePreview({ workspace_dir, asset_id: "missing" }), /Unknown/);
    const external = path.join(root, "external.png");
    await writeFile(external, await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer());
    const link = path.join(context.images_dir, "link.png");
    await symlink(external, link);
    await writeFile(context.image_catalog_path, JSON.stringify({ schema_version: 2, assets: [{ ...image, file_path: link }] }));
    await assert.rejects(engine.resolveAppOutlineImage({ workspace_dir, asset_id: "portrait" }), /belong to this workspace/);
    for (const size of ["thumbnail", "large"] as const) await assert.rejects(engine.getAppOutlineImagePreview({ workspace_dir, asset_id: "portrait", size }), /belong to this workspace/);
  } finally {
    if (previous === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR; else process.env.SLIDEFORGE_WORKSPACE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
