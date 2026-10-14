import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("创作要求经过保存、确认、重排、重开和旧字段读取仍保持原文", async () => {
  const previous = process.env.SLIDEFORGE_WORKSPACE_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-creation-requirements-"));
  process.env.SLIDEFORGE_WORKSPACE_DIR = root;
  const engine = await import("../../src/app-workspace/index.ts");
  try {
    const { workspace_dir } = await engine.createAppWorkspace({ title: "指令保留" });
    await engine.updateAppWorkspaceRequirements({ workspace_dir, requirements: {
      version: 1, status: "confirmed", source: { brief: "图片至少占 80%，文案不改" },
      candidates: { slide_count: [2], output_language: ["中文"] },
      selections: { slide_count: 2, output_language: "中文" },
      research: { web: { recommended: false, reason: "", enabled: false }, images: { recommended: false, reason: "", enabled: false } },
      updated_at: null, confirmed_at: null,
    } });
    const copy = "第一段。  \n\n\n第二段。";
    const global = "每页图片至少占 80%。\n指定文案一字不改。";
    const outline = { title: "指令保留", global_creation_requirements: global, items: [
      { page_type: "standard", title: "第一页", content: copy },
      { page_type: "standard", title: "第二页", content: copy, creation_requirements: "本页不要裁切图片。" },
    ] };
    await engine.saveAppWorkspaceOutlineDraft({ workspace_dir, outline });
    await engine.confirmAppWorkspaceOutline({ workspace_dir, outline: { ...outline, items: [...outline.items].reverse() } });
    const reopened = await engine.getAppWorkspaceOutline({ workspace_dir });
    assert.equal(reopened.global_creation_requirements, global);
    assert.equal(reopened.items[0].creation_requirements, "本页不要裁切图片。");
    assert.ok(!Object.hasOwn(reopened.items[1], "creation_requirements"));
    assert.equal(reopened.items[0].content, copy);
    assert.equal(reopened.status, "confirmed");
    const pageId = reopened.items[0].page_id;
    const outlinePath = path.join(workspace_dir, "outline.json");
    await writeFile(outlinePath, JSON.stringify({ ...reopened, items: reopened.items.map((item) => ({ ...item, copy_rewrite_freedom: 1, core_message: "旧核心信息不再使用" })) }));
    const migrated = await engine.getAppWorkspaceOutline({ workspace_dir });
    assert.equal(migrated.items[0].page_id, pageId);
    assert.equal(migrated.status, "confirmed");
    assert.equal(migrated.global_creation_requirements, global);
    assert.ok(!Object.hasOwn(migrated.items[0], "copy_rewrite_freedom"));
    assert.ok(!Object.hasOwn(migrated.items[0], "core_message"));
    assert.equal(migrated.items[0].content, copy);
    assert.deepEqual(migrated, reopened);
    assert.deepEqual(JSON.parse(await readFile(outlinePath, "utf8")), migrated);
    for (const invalid of [[], null, 3]) {
      await assert.rejects(engine.saveAppWorkspaceOutlineDraft({ workspace_dir, outline: { ...outline, global_creation_requirements: invalid as any } }), /global_creation_requirements must be a string/);
      await assert.rejects(engine.saveAppWorkspaceOutlineDraft({ workspace_dir, outline: { ...outline, items: [{ ...outline.items[0], creation_requirements: invalid }] } }), /creation_requirements must be a string/);
    }
    await engine.saveAppWorkspaceOutlineDraft({ workspace_dir, outline: { title: outline.title, items: outline.items } });
    assert.equal((await engine.getAppWorkspaceOutline({ workspace_dir })).global_creation_requirements, "");
    await engine.saveAppWorkspaceOutlineDraft({ workspace_dir, outline: { ...outline, global_creation_requirements: "", items: [{ ...outline.items[1], creation_requirements: "" }] } });
    const cleared = await engine.getAppWorkspaceOutline({ workspace_dir });
    assert.equal(cleared.global_creation_requirements, "");
    assert.ok(!Object.hasOwn(cleared.items[0], "creation_requirements"));
  } finally {
    if (previous === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR; else process.env.SLIDEFORGE_WORKSPACE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
