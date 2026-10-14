import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("历史 v3 大纲迁移保留正文、页面标识和确认状态，重复读取不再改变", async () => {
  const previous = process.env.ANNA_WORKSPACE_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-outline-v3-"));
  process.env.ANNA_WORKSPACE_DIR = root;
  const engine = await import("../../src/app-workspace/index.ts");
  try {
    const workspace = await engine.createAppWorkspace({ title: "历史作品" });
    const outlinePath = path.join(workspace.workspace_dir, "outline.json");
    const variants = [
      { legacy: { required_content: "- 只有旧正文" }, expected: "- 只有旧正文" },
      { legacy: { required_content: "- 旧投影", content_text: "优先使用连续正文" }, expected: "优先使用连续正文" },
      { legacy: { required_content: "- 旧投影", content: [{ segments: [{ text: "第一" }, { text: "段" }] }, { segments: [{ text: "第二段" }] }] }, expected: "第一段\n第二段" },
      { legacy: { content: "已经是纯文本" }, expected: "已经是纯文本" },
    ];
    for (const status of ["draft", "confirmed"] as const) {
      for (const { legacy, expected } of variants) {
        const pageId = "page-12345678-1234-4123-8123-123456789abc";
        const item = { ...(status === "confirmed" ? { page_id: pageId } : {}), page_type: "standard", title: "页面", core_message: "核心", copy_rewrite_freedom: 4, selected_image_ids: ["image-a"], ...legacy };
        const original = { version: 3, status, title: "历史作品", items: [item], updated_at: "2026-09-01T00:00:00Z", confirmed_at: status === "confirmed" ? "2026-09-01T00:00:00Z" : null };
        await writeFile(outlinePath, JSON.stringify(original));
        const result = await engine.getAppWorkspaceOutline({ workspace_dir: workspace.workspace_dir });
        assert.equal(result.version, 4);
        assert.equal(result.status, status);
        assert.equal(result.confirmed_at, original.confirmed_at);
        assert.equal(result.items[0].content, expected);
        assert.equal("copy_rewrite_freedom" in result.items[0], false);
        assert.equal("core_message" in result.items[0], false);
        assert.equal(result.global_creation_requirements, "");
        assert.deepEqual(result.items[0].selected_image_ids, ["image-a"]);
        if (status === "confirmed") assert.equal(result.items[0].page_id, pageId);
        assert.equal("required_content" in result.items[0], false);
        const persisted = await readFile(outlinePath, "utf8");
        assert.deepEqual(JSON.parse(persisted), result);
        assert.deepEqual(await engine.getAppWorkspaceOutline({ workspace_dir: workspace.workspace_dir }), result);
        assert.equal(await readFile(outlinePath, "utf8"), persisted);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.ANNA_WORKSPACE_DIR; else process.env.ANNA_WORKSPACE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
