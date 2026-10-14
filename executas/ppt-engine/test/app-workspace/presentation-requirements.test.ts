import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function draftRequirements() {
  return {
    version: 1,
    status: "draft",
    source: { brief: "Create a five-page Chinese investor presentation." },
    candidates: {
      slide_count: [5],
      output_language: ["简体中文"],
    },
    selections: {
      slide_count: 5,
      output_language: "简体中文",
    },
    research: {
      web: { recommended: true, reason: "Current facts improve the outline.", enabled: true },
      images: { recommended: false, reason: "The deck can rely on diagrams.", enabled: false },
    },
    updated_at: null,
    confirmed_at: null,
  };
}

test("Presentation Requirements own Workspace recovery and gate Outline Creation", async () => {
  const previousHome = process.env.HOME;
  const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "ppt-requirements-home-"));
  process.env.HOME = homeDir;
  process.env.SLIDEFORGE_WORKSPACE_DIR = path.join(homeDir, "slideforge-workspace");

  const {
    createAppWorkspace,
    confirmAppWorkspaceOutline,
    getAppWorkspaceRequirements,
    resetAppWorkspaceOutline,
    saveAppWorkspaceOutlineDraft,
    updateAppWorkspaceRequirements,
  } = await import("../../src/app-workspace/index.ts");

  try {
    const created = await createAppWorkspace({ title: "Requirements" });
    const empty = await getAppWorkspaceRequirements({ workspace_dir: created.workspace_dir });
    assert.equal(empty.status, "empty");
    assert.equal(empty.source, null);
    assert.deepEqual(empty.candidates.slide_count, []);
    assert.deepEqual(empty.research, {
      web: { recommended: null, reason: "", enabled: null },
      images: { recommended: null, reason: "", enabled: null },
    });

    const persistedFile = JSON.parse(
      await readFile(path.join(created.workspace_dir, "requirements.json"), "utf8"),
    ) as { status: string };
    assert.equal(persistedFile.status, "empty");

    const draft = draftRequirements();
    await updateAppWorkspaceRequirements({
      workspace_dir: created.workspace_dir,
      requirements: draft,
    });
    const persistedDraft = await getAppWorkspaceRequirements({ workspace_dir: created.workspace_dir });
    assert.equal(persistedDraft.status, "draft");
    assert.ok(persistedDraft.updated_at);
    assert.equal(persistedDraft.confirmed_at, null);

    const deferredTemplateChoice = {
      selection_required: true as const,
      confidence: "low" as const,
      trigger: "low_signal" as const,
      candidates: [{
        preset: { id: "neutral-one", version: 1, name: "Neutral one", description: "A general-purpose template." },
        score: 0,
        matched_axes: [],
      }],
    };
    await updateAppWorkspaceRequirements({
      workspace_dir: created.workspace_dir,
      requirements: {
        ...draft,
        selections: { ...draft.selections, visual_style_preset: null },
        template_recommendation: deferredTemplateChoice,
      },
    });
    const deferredDraft = await getAppWorkspaceRequirements({ workspace_dir: created.workspace_dir });
    assert.deepEqual(deferredDraft.template_recommendation, deferredTemplateChoice);
    await assert.rejects(updateAppWorkspaceRequirements({
      workspace_dir: created.workspace_dir,
      requirements: {
        ...deferredDraft,
        status: "confirmed",
        selections: {
          ...deferredDraft.selections,
          visual_style_preset: { id: "not-a-candidate", version: 1, name: "Other", description: "Not recommended." },
        },
      },
    }), /must select one of the template recommendation candidates/);

    await assert.rejects(
      saveAppWorkspaceOutlineDraft({
        workspace_dir: created.workspace_dir,
        outline: {
          title: "Blocked",
          items: [{ page_type: "standard", title: "Page", content: "Content" }],
        },
      }),
      /Confirmed Presentation Requirements are required/,
    );

    await updateAppWorkspaceRequirements({
      workspace_dir: created.workspace_dir,
      requirements: { ...draft, status: "confirmed" },
    });
    const confirmed = await getAppWorkspaceRequirements({ workspace_dir: created.workspace_dir });
    assert.equal(confirmed.status, "confirmed");
    assert.ok(confirmed.confirmed_at);

    const workspace = await saveAppWorkspaceOutlineDraft({
      workspace_dir: created.workspace_dir,
      outline: {
        title: "Allowed",
        global_creation_requirements: "图片至少占 80%",
        items: [
          {
            page_type: "standard",
            title: "Page one",
            content: "  第一段叙述，交代背景。   \n\n\n\n第二段叙述，给出结论。  ",
          },
          {
            page_type: "standard",
            title: "Page two",
            content: "单段叙述即可讲透这一页。",
            creation_requirements: "文案一字不改",
          },
        ],
      },
    });
    assert.equal((workspace.outline as { title: string }).title, "Allowed");
    assert.equal((workspace.outline as { status: string }).status, "draft");
    // 正文原样保留，包括用户指定的段落和空白。
    assert.equal(
      (workspace.outline as { items: Array<{ content: string }> }).items[0]?.content,
      "  第一段叙述，交代背景。   \n\n\n\n第二段叙述，给出结论。  ",
    );
    assert.equal(
      (workspace.outline as { items: Array<{ content: string }> }).items[1]?.content,
      "单段叙述即可讲透这一页。",
    );
    const savedOutline = workspace.outline as { global_creation_requirements: string; items: Array<{ creation_requirements?: string }> };
    assert.equal(savedOutline.global_creation_requirements, "图片至少占 80%");
    assert.equal(savedOutline.items[0]?.creation_requirements, undefined);
    assert.equal(savedOutline.items[1]?.creation_requirements, "文案一字不改");
    assert.equal(workspace.requirements.selections.slide_count, 2);

    const confirmedWorkspace = await confirmAppWorkspaceOutline({
      workspace_dir: created.workspace_dir,
      outline: {
        title: "Allowed",
        global_creation_requirements: "图片至少占 80%",
        items: (workspace.outline as { items: unknown[] }).items,
      },
    });
    assert.equal((confirmedWorkspace.outline as { status: string }).status, "confirmed");
    assert.ok((confirmedWorkspace.outline as { confirmed_at: string | null }).confirmed_at);
    const confirmedItems = (confirmedWorkspace.outline as { items: Array<{ page_id?: string; creation_requirements?: string }> }).items;
    assert.equal(confirmedItems.every((item) => /^page-[0-9a-f-]{36}$/.test(item.page_id ?? "")), true);
    assert.equal(new Set(confirmedItems.map((item) => item.page_id)).size, confirmedItems.length);
    assert.deepEqual(confirmedItems.map((item) => item.creation_requirements), [undefined, "文案一字不改"]);
    assert.equal((confirmedWorkspace.outline as { global_creation_requirements: string }).global_creation_requirements, "图片至少占 80%");

    const resetWorkspace = await resetAppWorkspaceOutline({ workspace_dir: created.workspace_dir });
    assert.deepEqual(resetWorkspace.outline, {
      version: 4,
      status: "empty",
      title: "",
      global_creation_requirements: "",
      items: [],
      updated_at: null,
      confirmed_at: null,
    });

    await assert.rejects(
      saveAppWorkspaceOutlineDraft({
        workspace_dir: created.workspace_dir,
        outline: {
          title: "Invalid",
          items: [{ page_type: "standard", title: "Page", content: "   " }],
        },
      }),
      /content must be a non-empty string/,
    );

    await assert.rejects(
      saveAppWorkspaceOutlineDraft({
        workspace_dir: created.workspace_dir,
        outline: {
          title: "Invalid requirement",
          items: [{ page_type: "standard", title: "Page", content: "Content", creation_requirements: ["not a string"] }],
        },
      }),
      /creation_requirements must be a string/,
    );

    await assert.rejects(
      updateAppWorkspaceRequirements({
        workspace_dir: created.workspace_dir,
        requirements: {
          ...draft,
          status: "confirmed",
          selections: { ...draft.selections, output_language: null },
        },
      }),
      /missing selections: output_language/,
    );

    await assert.rejects(
      updateAppWorkspaceRequirements({
        workspace_dir: created.workspace_dir,
        requirements: {
          ...draft,
          status: "confirmed",
          selections: { ...draft.selections, output_language: "auto" },
        },
      }),
      /concrete language/,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
    else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("confirmed Presentation Requirements require a Visual Style Preset without content goals", async () => {
  const previousHome = process.env.HOME;
  const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "ppt-requirements-visual-contract-home-"));
  process.env.HOME = homeDir;
  process.env.SLIDEFORGE_WORKSPACE_DIR = path.join(homeDir, "slideforge-workspace");

  const {
    confirmAppWorkspaceRequirements,
    createAppWorkspace,
    getAppWorkspaceRequirements,
  } = await import("../../src/app-workspace/index.ts");

  try {
    const created = await createAppWorkspace({ title: "Visual Contract" });
    const draft = draftRequirements();
    const preset = {
      id: "the-2026-world-cup",
      version: 1,
      name: "2026 世界杯编辑视觉",
      description: "深海军蓝、赛事红与金黄构成的强对比编辑设计。",
    };
    const snapshot = JSON.stringify({
      version: 1,
      preset,
      reference_html_pages: [{
        path: "html/cover.html",
        description: "深蓝与红色构成的编辑式封面。",
        html: "<!doctype html><html><body><main>Reference</main></body></html>",
      }],
    });
    const stagingPath = path.join(homeDir, "template-reference-snapshot.json");
    await writeFile(stagingPath, snapshot, "utf8");

    await confirmAppWorkspaceRequirements({
      workspace_dir: created.workspace_dir,
      requirements: {
        ...draft,
        status: "confirmed",
        selections: {
          ...draft.selections,
          visual_style_preset: preset,
        },
      },
      template_reference_staging_file_path: stagingPath,
      template_reference_expected_size_bytes: Buffer.byteLength(snapshot),
    });

    const confirmed = await getAppWorkspaceRequirements({ workspace_dir: created.workspace_dir });
    assert.equal(confirmed.status, "confirmed");
    assert.deepEqual(Object.keys(confirmed.selections).sort(), ["output_language", "slide_count", "visual_style_preset"]);
    assert.deepEqual(confirmed.selections.visual_style_preset, preset);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
    else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("confirming Presentation Requirements clears stale research artifacts", async () => {
  const previousHome = process.env.HOME;
  const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "ppt-template-requirements-home-"));
  process.env.HOME = homeDir;
  process.env.SLIDEFORGE_WORKSPACE_DIR = path.join(homeDir, "slideforge-workspace");

  const {
    confirmAppWorkspaceRequirements,
    createAppWorkspace,
  } = await import("../../src/app-workspace/index.ts");

  try {
    const created = await createAppWorkspace({ title: "Template Requirements" });
    const draft = draftRequirements();
    const templateRequirements = {
      ...draft,
      status: "confirmed" as const,
      selections: {
        ...draft.selections,
        visual_style_preset: {
          id: "red-blue-comparative",
          version: 1,
          name: "编辑感留白",
          description: "浅色背景、深色标题、强调留白和清晰页码层级。",
        },
      },
    };
    const snapshot = JSON.stringify({
      version: 1,
      preset: templateRequirements.selections.visual_style_preset,
      reference_html_pages: [{
        path: "html/cover.html",
        description: "编辑式封面。",
        html: "<!doctype html><html><body><main>Reference</main></body></html>",
      }],
    });
    const stagingPath = path.join(homeDir, "template-reference-snapshot.json");
    await writeFile(stagingPath, snapshot, "utf8");
    const staleResearchPath = path.join(created.workspace_dir, "research", "evidence", "web-summary.md");
    await mkdir(path.dirname(staleResearchPath), { recursive: true });
    await writeFile(staleResearchPath, "stale research", "utf8");
    await confirmAppWorkspaceRequirements({
      workspace_dir: created.workspace_dir,
      requirements: templateRequirements,
      template_reference_staging_file_path: stagingPath,
      template_reference_expected_size_bytes: Buffer.byteLength(snapshot),
    });

    await assert.rejects(readFile(staleResearchPath, "utf8"), { code: "ENOENT" });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
    else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("旧需求读取时丢弃内容目标，保存后只保留生成规格和研究选择", async () => {
  const { createAppWorkspace, getAppWorkspaceRequirements, updateAppWorkspaceRequirements } = await import("../../src/app-workspace/index.ts");
  const created = await createAppWorkspace({ title: "旧需求字段兼容" });
  try {
    const draft = draftRequirements();
    const retired = Object.fromEntries(["audience", "purpose", "desired_outcome", "visual_tone"].map((field) => [field, { label: "旧值", description: "不应进入后续提示词" }]));
    const legacy = {
      ...draft,
      status: "confirmed",
      candidates: { ...draft.candidates, ...Object.fromEntries(Object.entries(retired).map(([key, value]) => [key, [value]])) },
      selections: { ...draft.selections, ...retired },
    };
    await writeFile(path.join(created.workspace_dir, "requirements.json"), JSON.stringify(legacy), "utf8");
    const loaded = await getAppWorkspaceRequirements({ workspace_dir: created.workspace_dir });
    assert.equal(loaded.status, "confirmed");
    assert.deepEqual(loaded.candidates, draft.candidates);
    assert.deepEqual(loaded.selections, { ...draft.selections, visual_style_preset: null });
    assert.deepEqual(loaded.research, draft.research);
    await updateAppWorkspaceRequirements({ workspace_dir: created.workspace_dir, requirements: loaded });
    const persisted = await readFile(path.join(created.workspace_dir, "requirements.json"), "utf8");
    assert.doesNotMatch(persisted, /audience|purpose|desired_outcome|visual_tone|旧值/);
    await assert.rejects(updateAppWorkspaceRequirements({
      workspace_dir: created.workspace_dir,
      requirements: { ...loaded, candidates: { ...loaded.candidates, unexpected: [] } },
    }), /must contain exactly/);
    await assert.rejects(updateAppWorkspaceRequirements({
      workspace_dir: created.workspace_dir,
      requirements: { ...loaded, research: { ...loaded.research, images: { ...loaded.research.images, enabled: null } } },
    }), /Web and image research choices/);
  } finally {
    await rm(created.workspace_dir, { recursive: true, force: true });
  }
});
