import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGenerateOutlineLlmRequest, buildOutlineRepairRequest, buildReviseOutlineLlmRequest } from "../../src/ai/outlinePrompt.ts";
import { parseOutlineJson, validateGeneratedOutline, validateRevisedOutline, validateOutlineChunk } from "../../src/ai/outlineParser.ts";
import { buildOutlineChunkPrompt, buildOutlineRepairPrompt } from "../../src/ai/outlinePromptMessages.ts";
import type { GenerateOutlineInput } from "../../src/ai/types.ts";
import type { AttachmentContext, PresentationRequirements } from "../../src/api/types.ts";

function confirmedRequirements(): PresentationRequirements {
  return {
    version: 1,
    status: "confirmed",
    source: { brief: "为投资人制作一份 8 页的 AI 客服方案。" },
    candidates: {
      slide_count: [8],
      output_language: ["中文"],
    },
    selections: {
      slide_count: 8,
      output_language: "中文",
      visual_style_preset: {
        id: "editorial-sports",
        version: 1,
        name: "Editorial Sports",
        description: "强视觉编辑风格。",
      },
    },
    research: {
      web: { recommended: true, reason: "需要最新市场资料。", enabled: true },
      images: { recommended: true, reason: "真实产品图有助于表达。", enabled: true },
    },
    updated_at: "2026-07-17T00:00:00.000Z",
    confirmed_at: "2026-07-17T00:00:00.000Z",
  };
}

describe("outline prompts", () => {
  it("passes uploaded source analysis once to creation and revision without appending another attachment summary", () => {
    const attachmentContext: AttachmentContext = {
      version: 1,
      user_brief: "persisted brief should not be repeated",
      attachment_context: [{
        version: 1,
        source_id: "source-1",
        filename: "source.md",
        content_strategy: "summarized_context",
        original_reading_method: "document_retrieval",
        relationship_to_task: "支持当前任务",
        main_message: "复购是增长主引擎",
        key_facts: [{ evidence_id: "evidence-1", fact: "复购率达到 42%", source_label: "段落 1", excerpt: "原文摘录显示复购率 42%" }],
        must_include: [{ requirement: "必须包含", evidence_ids: ["evidence-1"] }],
        must_avoid: [],
        recommended_storyline: ["推荐叙事"],
        gaps: [],
        unread_content: ["未读取内容"],
        updated_at: "2026-09-04T00:00:00.000Z",
      }],
      updated_at: "2026-09-04T00:00:00.000Z",
    };
    const input: GenerateOutlineInput = { requirements: confirmedRequirements(), attachmentContext };
    const requests = [
      buildGenerateOutlineLlmRequest(input),
      buildReviseOutlineLlmRequest({ ...input, title: "Demo", outline: [], feedback: "保留附件事实并调整顺序" }),
    ];
    for (const request of requests) {
      const prompt = request.messages[1]?.content.text ?? "";
      assert.ok(prompt.includes("## 上传资料"));
      assert.ok(prompt.includes("source.md"));
      for (const value of ["支持当前任务", "复购是增长主引擎", "复购率达到 42%", "原文摘录显示复购率 42%", "必须包含", "推荐叙事", "未读取内容"]) {
        assert.equal(prompt.split(value).length - 1, 1, `Repeated or missing attachment content: ${value}`);
      }
      // 附件是纯文本，不再以 JSON 注入，也不重复 Brief。
      assert.doesNotMatch(prompt, /## 用户附件内容|## User Attachments|persisted brief should not be repeated/);
      assert.doesNotMatch(prompt, /"content_strategy"|"evidence_id"/);
      // 提示词里不能出现字面 \n，否则页面 Agent 会拿到一行超长文本。
      assert.doesNotMatch(prompt, /\\n/);
    }
  });

  it("passes confirmed selections and Web research into the generation request", () => {
    const requirements = confirmedRequirements();
    const request = buildGenerateOutlineLlmRequest({ requirements, webResearchSummary: "官方报告：市场增长 18%。" });
    const prompt = request.messages[1]?.content.text ?? "";
    assert.deepEqual(request.messages.map((message) => message.role), ["system", "user"]);
    for (const value of [requirements.source!.brief, "投资人", "中文", "官方报告：市场增长 18%。"]) {
      assert.ok(prompt.includes(value), value);
    }
    assert.match(prompt, /"slide_count"\s*:\s*8/);
  });

  it("uses Chinese system and user prompts", () => {
    const request = buildGenerateOutlineLlmRequest({ requirements: confirmedRequirements() });
    const systemPrompt = request.messages[0]?.content.text ?? "";
    const userPrompt = request.messages[1]?.content.text ?? "";
    assert.match(systemPrompt, /资深演示文稿策略顾问/);
    assert.match(systemPrompt, /content 必须是字符串，不是数组/);
    assert.match(userPrompt, /逐页大纲/);
    assert.doesNotMatch(systemPrompt, /You are a senior presentation strategist/);
    assert.doesNotMatch(userPrompt, /Create a presentation outline/);
    assert.doesNotMatch(`${systemPrompt}\n${userPrompt}`, /copy_rewrite_freedom/);
    assert.doesNotMatch(systemPrompt, /只能包含 page_type、title、content、research 和 copy_rewrite_freedom/);
  });

  it("uses transcribed image facts in outline generation without raw image attachments", () => {
    const request = buildGenerateOutlineLlmRequest({
      requirements: confirmedRequirements(),
      attachmentContext: {
        version: 1,
        user_brief: "Introduce the team.",
        attachment_context: [{
          version: 1,
          source_id: "resume-image",
          filename: "team.png",
          content_strategy: "full_context",
          original_reading_method: "image_multimodal_read",
          use_in_ppt: false,
          image_usage_reason: "This image supplies team facts rather than a visual asset.",
          content: "张明 | 产品总监",
          main_message: "团队成员简历",
          key_facts: [],
          must_include: [],
          must_avoid: [],
          recommended_storyline: [],
          gaps: [],
          unread_content: [],
          updated_at: "2026-09-09T00:00:00.000Z",
        }],
        updated_at: "2026-09-09T00:00:00.000Z",
      },
    });
    const prompt = request.messages[1]?.content.text ?? "";
    assert.match(prompt, /张明/);
    assert.match(prompt, /team\.png/);
  });

  it("requires generation-only notes before content in creation, revision, and repair prompts", () => {
    const input = { requirements: confirmedRequirements() };
    const generation = buildGenerateOutlineLlmRequest(input);
    const revision = buildReviseOutlineLlmRequest({ ...input, outline: [], feedback: "调整表达" });
    for (const request of [generation, revision]) {
      const system = request.messages[0]!.content.text;
      const shape = JSON.parse(system.split("\n").find((line) => line.startsWith('{"items":'))!);
      assert.deepEqual(Object.keys(shape.items[0]), ["page_number", "page_type", "title", "generation_notes", "content", "creation_requirements"]);
      assert.doesNotMatch(system, /core_message|核心信息/);
      assert.match(system, /原始输入及其来源、算式、计算结果/);
      assert.match(system, /不保存到大纲，也不传给页面设计 Agent/);
      assert.match(system, /必须同时写进 content，使正文自包含/);
      assert.match(buildOutlineChunkPrompt(21, 40, 60), /generation_notes 是否为字符串/);
    }
    const repair = buildOutlineRepairRequest(generation, "{}", ["missing generation_notes"]);
    assert.match(repair.messages.at(-1)!.content.text, /generation_notes 必须是字符串/);
    assert.doesNotMatch(repair.messages.at(-1)!.content.text, /core_message|核心信息/);
    const chunkRepair = buildOutlineRepairPrompt(["missing generation_notes"], buildOutlineChunkPrompt(21, 40, 60));
    assert.match(chunkRepair, /missing generation_notes/);
    assert.match(chunkRepair, /第 21～40 页/);
  });

  it("passes current unsaved outline content and feedback into rewrite requests", () => {
    const request = buildReviseOutlineLlmRequest({
      title: "Demo",
      outline: [{
        page_type: "standard",
        title: "Intro",
        content: "Current unsaved content",
        creation_requirements: "保留原文",
      }],
      feedback: "增加一页并重排顺序",
      requirements: confirmedRequirements(),
    });
    const prompt = request.messages[1]?.content.text ?? "";
    for (const value of ["Demo", "Intro", "Current unsaved content", "增加一页并重排顺序"]) {
      assert.ok(prompt.includes(value), value);
    }

  });
});

const validOutline = {
  title: "品牌分析",
      global_creation_requirements: "",
  items: [{
    page_type: "cover",
    title: "增长逻辑",
    generation_notes: "来源：用户需求。说明：只整理叙事，不推断经营指标。",
    content: "先说明用户问题。\n再说明解决方案如何带来增长。",
  }],
};

describe("outline validation", () => {
  it("normalizes the same production protocol for creation and revision", () => {
    const generated = validateGeneratedOutline(validOutline);
    assert.deepEqual(validateRevisedOutline(validOutline), generated);
    assert.deepEqual(generated, {
      title: "品牌分析",
  global_creation_requirements: "",
      items: [{
        page_type: "cover",
        title: "增长逻辑",
        content: "先说明用户问题。\n再说明解决方案如何带来增长。",
      }],
    });
  });

  it("does not salvage an inner item from a truncated top-level outline", () => {
    assert.throws(
      () => parseOutlineJson('{"title":"Demo","items":[{"title":"Page"}'),
      /顶层 JSON 不完整或格式无效/,
    );
  });

  it("accepts empty notes and strips populated notes without changing page content", () => {
    for (const validate of [validateGeneratedOutline, validateRevisedOutline]) {
      const expected = validate(validOutline);
      for (const generation_notes of ["", "来源：财务表。统计口径：1—2 月，万元。计算：10 + 20 = 30。", "多行说明\n不传给页面"]) {
        const result = validate({ ...validOutline, items: [{ ...validOutline.items[0], generation_notes }] });
        assert.deepEqual(result, expected);
        assert.equal(Object.hasOwn(result.items[0]!, "generation_notes"), false);
      }
    }
  });

  it("rejects missing or non-string notes in both creation and revision", () => {
    const { generation_notes: _notes, ...withoutNotes } = validOutline.items[0]!;
    for (const validate of [validateGeneratedOutline, validateRevisedOutline]) {
      for (const item of [withoutNotes, ...[null, undefined, 42, false, [], {}].map((generation_notes) => ({ ...withoutNotes, generation_notes }))]) {
        assert.throws(() => validate({ ...validOutline, items: [item] }), /generation_notes/);
      }
    }
  });

  it("rejects unsupported protocols, missing content, and unexpected analysis metadata", () => {
    const item = validOutline.items[0]!;
    for (const value of [
      { presentation_title: "Demo", pages: [{ title: "Page", content: "Old protocol" }] },
      { title: "Demo", items: [] },
      { ...validOutline, items: [{ ...item, core_message: "" }] },
      { ...validOutline, items: [{ ...item, content: ["Wrong protocol"] }] },
      { ...validOutline, items: [{ ...item, content: "" }] },
      { ...validOutline, items: [{ ...item, required_content: ["Old protocol"] }] },
      { ...validOutline, items: [{ ...item, analysis: { focus: "Old analysis" } }] },
    ]) {
      assert.throws(() => validateGeneratedOutline(value), { name: "OutlineValidationError" });
    }
  });
});

for (const count of [1, 8, 12]) it(`uses the confirmed total page budget ${count}`, () => {
  const requirements = confirmedRequirements();
  requirements.selections.slide_count = count;
  const prompt = buildGenerateOutlineLlmRequest({ requirements }).messages[1]!.content.text;
  assert.match(prompt, new RegExp(`总共生成 ${count} 页`));
  assert.match(prompt, new RegExp(`从 1 连续递增到 ${count}`));
  assert.match(prompt, /本轮只返回 title、total_pages 和 global_creation_requirements/);
  if (count === 1) assert.match(prompt, /不另设封面/);
  else assert.match(prompt, new RegExp(`其余页面合计只能有 ${count - 1} 页`));
});

it("validates consecutive temporary numbering and never persists it", () => {
  const item = { page_number: 1, page_type: "cover", title: "标题", generation_notes: "", content: "正文" };
  const valid = { items: [item] };
  const result = validateOutlineChunk(valid, 1, 1);
  assert.equal(Object.hasOwn(result[0]!, "page_number"), false);
  for (const number of [undefined, 0, 2, "1"]) {
    assert.throws(() => validateOutlineChunk({ ...valid, items: [{ ...item, page_number: number }] }, 1, 1));
  }
  assert.throws(() => validateOutlineChunk({ ...valid, items: [item, item] }, 1, 2));
  assert.throws(() => validateOutlineChunk({ ...valid, items: [] }, 1, 2));
});
