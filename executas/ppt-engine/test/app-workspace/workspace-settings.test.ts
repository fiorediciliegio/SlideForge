import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function readJson(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

test("authoring-kit-v1 settings persist globally and workspace setting files are ignored", async () => {
  const previousHome = process.env.HOME;
  const previousWorkspaceRoot = process.env.ANNA_WORKSPACE_DIR;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "presenton-workspace-settings-home-"));
  process.env.HOME = homeDir;
  process.env.ANNA_WORKSPACE_DIR = path.join(homeDir, "anna-workspace");
  const {
    createAppWorkspace,
    getAppWorkspaceDefaults,
    patchAppWorkspaceSettings,
  } = await import("../../src/app-workspace/index.ts");
  try {
    const created = await createAppWorkspace({ title: "Settings" });
    assert.deepEqual(created.setting, {
      page_generation_concurrency: 5,
      research_image_session_concurrency: 5,
      research_web_max_rounds: 10,
      research_image_max_searches: 10,
    });

    const patched = await patchAppWorkspaceSettings({
      workspace_dir: created.workspace_dir,
      persist_as_default: true,
      setting: {
        page_generation_concurrency: 99,
        research_image_session_concurrency: 99,
        research_web_max_rounds: 99,
        research_image_max_searches: -1,
        output_language: "must be discarded",
        content_review_enabled: true,
      },
    });
    assert.deepEqual(Object.keys(patched.setting).sort(), [
      "page_generation_concurrency",
      "research_image_max_searches",
      "research_image_session_concurrency",
      "research_web_max_rounds",
      "updated_at",
    ]);
    assert.equal(patched.setting.page_generation_concurrency, 10);
    assert.equal(patched.setting.research_image_session_concurrency, 10);
    // Research limits clamp to 1–30 rather than the 1–10 concurrency range.
    assert.equal(patched.setting.research_web_max_rounds, 30);
    assert.equal(patched.setting.research_image_max_searches, 1);

    await assert.rejects(readFile(path.join(created.workspace_dir, "setting.json")));
    const defaults = await getAppWorkspaceDefaults();
    assert.deepEqual(defaults.setting, await readJson(path.join(homeDir, "anna-workspace", "ppt", "setting.json")));

    const inherited = await createAppWorkspace({ title: "Inherited" });
    assert.equal(inherited.setting.page_generation_concurrency, 10);
    assert.equal(inherited.setting.research_image_session_concurrency, 10);
    assert.equal(inherited.setting.research_web_max_rounds, 30);
    assert.equal(inherited.setting.research_image_max_searches, 1);

    await writeJson(path.join(inherited.workspace_dir, "setting.json"), { page_generation_concurrency: 1 });
    const reopened = await import("../../src/app-workspace/index.ts").then((api) => api.openAppWorkspace({ workspace_dir: inherited.workspace_dir }));
    assert.equal(reopened.setting.page_generation_concurrency, 10);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousWorkspaceRoot === undefined) delete process.env.ANNA_WORKSPACE_DIR;
    else process.env.ANNA_WORKSPACE_DIR = previousWorkspaceRoot;
    await rm(homeDir, { recursive: true, force: true });
  }
});

async function writeJson(filePath: string, value: unknown) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, JSON.stringify(value), "utf8");
}
