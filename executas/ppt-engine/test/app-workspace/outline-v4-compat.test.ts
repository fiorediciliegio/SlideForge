import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("v4 outline preserves plain content and drops known legacy fields", async () => {
  const previousHome = process.env.HOME;
  const previousAnnaWorkspaceDir = process.env.SLIDEFORGE_WORKSPACE_DIR;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "ppt-outline-v4-home-"));
  process.env.HOME = homeDir;
  process.env.SLIDEFORGE_WORKSPACE_DIR = homeDir;

  const {
    createAppWorkspace,
    getAppWorkspaceOutline,
  } = await import("../../src/app-workspace/index.ts");

  try {
    const created = await createAppWorkspace({ title: "V4 outline" });
    const v4 = {
      version: 4,
      status: "confirmed",
      title: "極限運用の戦略的展開",
      items: [
        {
          page_id: "page-63846023-d714-47c6-be6d-0904f69ff5be",
          page_type: "cover",
          title: "極限運用の戦略的展開",
          core_message: "限られた経営資源から最大の成果を引き出す",
          content: "- 现状盘点\n- 目标定义",
          copy_rewrite_freedom: 3,
        },
        {
          page_id: "page-018cf7ad-d40b-4ea5-b279-6eb0b5ca53b5",
          page_type: "standard",
          title: "第二页",
          core_message: "要点",
          content: "第一行\n第二行",
        },
      ],
      updated_at: "2026-09-17T03:14:00.000Z",
      confirmed_at: "2026-09-17T03:14:00.000Z",
    };
    await writeFile(
      path.join(created.workspace_dir, "outline.json"),
      JSON.stringify(v4, null, 2),
      "utf8",
    );

    const outline = await getAppWorkspaceOutline({ workspace_dir: created.workspace_dir });
    assert.equal(outline.version, 4);
    assert.equal(outline.status, "confirmed");
    assert.equal(outline.items.length, 2);
    assert.equal(outline.items[0].page_id, "page-63846023-d714-47c6-be6d-0904f69ff5be");
    assert.equal(outline.items[0].content, "- 现状盘点\n- 目标定义");
    assert.equal(outline.items[1].content, "第一行\n第二行");
    assert.equal("core_message" in outline.items[0], false);
    assert.equal("copy_rewrite_freedom" in outline.items[0], false);
    assert.equal("required_content" in outline.items[0], false);
    await writeFile(path.join(created.workspace_dir, "outline.json"), JSON.stringify({
      ...v4, items: [{ ...v4.items[0], unknown_field: "rejected" }],
    }));
    await assert.rejects(getAppWorkspaceOutline({ workspace_dir: created.workspace_dir }), /unsupported fields: unknown_field/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAnnaWorkspaceDir === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
    else process.env.SLIDEFORGE_WORKSPACE_DIR = previousAnnaWorkspaceDir;
    await rm(homeDir, { recursive: true, force: true });
  }
});
