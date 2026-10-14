import assert from "node:assert/strict";
import test from "node:test";
import { validateGeneratedOutline, validateRevisedOutline } from "../../src/ai/outlineParser.ts";
import { buildOutlineSystemPrompt, buildOutlineRepairPrompt } from "../../src/ai/outlinePromptMessages.ts";
import { normalizeValidOutline } from "../../src/features/outline/model.ts";
import { parseImageAssignments } from "../../src/features/outline/imageAssignment.ts";
import { authoringDeckFromConfirmedOutline } from "../../src/features/deck-generation/deckGenerationStartArtifacts.ts";
import { buildPageHtmlPrompt, buildPageHtmlRefinementPrompt, buildVisualMasterHtmlPrompt } from "../../src/features/deck-generation/htmlPrompts.ts";
import { buildPageLayoutRewritePrompt } from "../../src/features/deck-generation/pageLayoutRewrite.ts";
import type { WorkspaceOutline, PresentationRequirements } from "../../src/api/types.ts";

const globalRequirements = "每页图片至少占 80%。\n指定文案一字不改。";
const pageRequirements = "第三页图片不要裁切。";
const exactCopy = "  第一项：保持标点！\n\n\n第二项：保留原文。  ";
const response = {
  title: "图片演示",
  global_creation_requirements: globalRequirements,
  items: ["封面", "第二页", "第三页"].map((title, index) => ({
    page_type: index === 0 ? "cover" : "standard",
    title, generation_notes: "来源说明不进入页面", content: exactCopy,
    ...(index === 2 ? { creation_requirements: pageRequirements } : {}),
  })),
};

test("生成、改写、编辑规范化和图片分配完整保留指令及指定原文", () => {
  for (const parse of [validateGeneratedOutline, validateRevisedOutline]) {
    const normalized = normalizeValidOutline(parse(response));
    const assigned = parseImageAssignments({ pages: [1, 2, 3].map((page_number) => ({ page_number, image_ids: [] })) }, normalized, []);
    assert.equal(assigned.global_creation_requirements, globalRequirements);
    assert.equal(assigned.items[2]?.creation_requirements, pageRequirements);
    assert.ok(!Object.hasOwn(assigned.items[0]!, "creation_requirements"));
    for (const item of assigned.items) {
      assert.equal(item.content, exactCopy);
      assert.ok(!Object.hasOwn(item, "generation_notes"));
      assert.ok(!Object.hasOwn(item, "copy_rewrite_freedom"));
    }
  }
});

test("创作要求只接受字符串，无单页要求时省略字段", () => {
  for (const parse of [validateGeneratedOutline, validateRevisedOutline]) {
    for (const invalid of [[], {}, null, 42]) {
      assert.throws(() => parse({ ...response, global_creation_requirements: invalid }), /global_creation_requirements/);
      assert.throws(() => parse({ ...response, items: [{ ...response.items[0], creation_requirements: invalid }] }), /creation_requirements/);
    }
    const { global_creation_requirements: _, ...missing } = response;
    assert.throws(() => parse(missing), /global_creation_requirements/);
    const empty = parse({ ...response, global_creation_requirements: "", items: [{ ...response.items[0], creation_requirements: "" }] });
    assert.equal(empty.global_creation_requirements, "");
    assert.ok(!Object.hasOwn(empty.items[0]!, "creation_requirements"));
  }
});

test("封面、普通页、精修和布局修复只收到全局及对应页要求", () => {
  const parsed = validateGeneratedOutline(response);
  // 重排后，要求跟随页面而不是原页序。
  const outline: WorkspaceOutline = { ...parsed, version: 4, status: "confirmed", updated_at: null, confirmed_at: null,
    items: [parsed.items[2]!, parsed.items[0]!, parsed.items[1]!].map((item, index) => ({ ...item, page_id: `page-${index}` })),
  };
  const pages = authoringDeckFromConfirmedOutline(outline).pages;
  for (const page of pages) {
    const input = { outline, page, visualMasterHtml: "MASTER", referenceHtml: "REFERENCE" };
    const currentRequirements = outline.items[page.index]?.creation_requirements;
    const prompts = [buildPageHtmlPrompt(input), buildPageHtmlRefinementPrompt({ ...input, originalHtml: "<html>原页面</html>", refinementRequest: "只调整字体" }),
      buildPageLayoutRewritePrompt("<html>原页面</html>", "16:9", { global_creation_requirements: globalRequirements, creation_requirements: currentRequirements })];
    for (const prompt of prompts) {
      assert.ok(prompt.includes(globalRequirements));
      assert.equal(prompt.includes(pageRequirements), page.index === 0);
      assert.ok(!prompt.includes("来源说明不进入页面"));
    }
    assert.equal(page.outline, exactCopy);
  }
  const master = buildVisualMasterHtmlPrompt({ outline, requirements: { selections: { output_language: "中文" } } as PresentationRequirements, referenceHtml: "REFERENCE" });
  assert.ok(master.includes(globalRequirements));
  assert.ok(!master.includes(pageRequirements));
});

test("大纲默认散文可由用户覆盖，修复和改写不得恢复旧的绝对限制", () => {
  for (const mode of ["generate", "revise"] as const) {
    const prompt = buildOutlineSystemPrompt({ mode });
    assert.match(prompt, /没有相关特别要求时.*300 到 600 字/);
    assert.match(prompt, /不得扩写、推断、弱化或泛化总结/);
    assert.match(prompt, /从大纲阶段就原样保留/);
    assert.match(prompt, /全局要求不重复写入每页/);
    assert.doesNotMatch(prompt, /宁可写详细|不能多也不能少，按此顺序输出|不需要你操心/);
    if (mode === "revise") assert.match(prompt, /不得从原始需求重新引入已经取消的要求/);
  }
  assert.match(buildOutlineRepairPrompt(["invalid JSON"]), /用户指定的形式、长度和原文要求优先/);
});
