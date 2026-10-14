import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildWebResearchAgentInitialPrompt,
  WEB_RESEARCH_AGENT_SYSTEM_PROMPT,
  WebResearchAgentProtocolError,
  parseWebResearchAgentAction,
} from "../../src/ai/webResearchAgent.ts";
import { formatWebResearchRequirements } from "../../src/ai/requirementsFormatting.ts";
import type { PresentationRequirements } from "../../src/api/types.ts";

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
        id: "new-market-entry",
        version: 1,
        name: "New Market Entry Strategy",
        description: "Strategy-consulting design.",
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

describe("Web research Agent protocol", () => {
  it("emphasizes that finish Markdown follows the action header", () => {
    assert.match(
      WEB_RESEARCH_AGENT_SYSTEM_PROMPT,
      /Markdown 正文放到 \{"action":"finish"\} 动作头之后，不要将 Markdown 正文放到 json 字段中/,
    );
  });

  it("builds the initial prompt from the outline title and page research directions", () => {
    const prompt = buildWebResearchAgentInitialPrompt({
      outline: {
        version: 4,
        title: "电动汽车基础设施",
        status: "confirmed",
        items: [{
          page_type: "standard",
          title: "充电网络",
          content: "主要市场与趋势",
          research: {
            web: { directions: ["public charging network growth"], reason: "补充最新市场事实。" },
            images: null,
          },
        }],
        updated_at: null,
        confirmed_at: null,
      },
      outputLanguage: "中文",
      existingWebSummary: "",
    });
    assert.match(prompt, /演示主题：\n\n电动汽车基础设施/);
    assert.match(prompt, /public charging network growth/);
    assert.doesNotMatch(prompt, /用户原始需求|PPT brief/);
  });

  it("keeps Web research requirements focused on research scope", () => {
    const prompt = buildWebResearchAgentInitialPrompt({
      brief: "研究 AI 客服市场。",
      presentationTitle: "AI 客服市场进入策略",
      confirmedRequirementsText: formatWebResearchRequirements(confirmedRequirements()),
      slideCount: 8,
      outputLanguage: "Chinese",
      existingWebSummary: "# Web Research Summary\n",
    });
    assert.match(prompt, /目标页数：8/);
    assert.doesNotMatch(prompt, /目标受众：|演示用途：|预期效果：|视觉气质：/);
    assert.match(prompt, /输出语言：中文/);
    assert.match(prompt, /研究总结语言：\n\nChinese/);
    assert.match(prompt, /这份研究将用于支持一套约 8 页的演示文稿。你需要建立起足以支撑整套演示文稿的研究覆盖面。/);
    assert.doesNotMatch(prompt, /视觉风格预设|预设说明|Web 搜索：|图片搜索：/);
    assert.doesNotMatch(prompt, /已有 Web 研究总结/);
  });

  it("includes uploaded analysis and an existing summary only when they have content", () => {
    const prompt = buildWebResearchAgentInitialPrompt({
      brief: "研究 AI 客服市场。",
      presentationTitle: "AI 客服市场进入策略",
      confirmedRequirementsText: "目标页数：8",
      uploadedSourceAnalysisContext: "资料中提到重点客户为大型企业。",
      outputLanguage: "Chinese",
      existingWebSummary: "# Web Research Summary\n\n## 市场规模\n- 规模持续增长。",
    });
    assert.match(prompt, /## 上传资料分析：\n\n资料中提到重点客户为大型企业。/);
    assert.match(prompt, /## 已有 Web 研究总结：\n\n# Web Research Summary/);
  });

  it("accepts a JSON code fence and ignores leading chatter", () => {
    assert.deepEqual(
      parseWebResearchAgentAction('先执行搜索。\n```json\n{"action":"search","queries":["2026 Shanghai TI official announcement"]}\n```'),
      { action: "search", queries: ["2026 Shanghai TI official announcement"] },
    );
  });

  it("parses bounded batches for search and fetch", () => {
    assert.deepEqual(
      parseWebResearchAgentAction(JSON.stringify({
        action: "search",
        queries: ["market size", "policy update", "competitor launch"],
      })),
      { action: "search", queries: ["market size", "policy update", "competitor launch"] },
    );
    const urls = Array.from({ length: 5 }, (_, index) => `https://example.com/${index + 1}`);
    assert.deepEqual(
      parseWebResearchAgentAction(JSON.stringify({ action: "fetch", urls })),
      { action: "fetch", urls },
    );
  });

  it("parses finish as a JSON action header followed by free-form Markdown", () => {
    assert.deepEqual(
      parseWebResearchAgentAction('{"action":"finish"}\n# 研究结论\n\n- 事实\n\n## 来源\n\n- https://example.com'),
      {
        action: "finish",
        markdown: "# 研究结论\n\n- 事实\n\n## 来源\n\n- https://example.com",
      },
    );
    assert.deepEqual(
      parseWebResearchAgentAction('```json\n{"action":"finish"}\n# Wrapped summary\n```'),
      { action: "finish", markdown: "# Wrapped summary" },
    );
  });

  it("rejects extra fields, trailing action content, and an empty finish body", () => {
    const invalid = [
      '{"action":"search","query":"query","extra":true}',
      '{"action":"search","queries":[]}',
      '{"action":"search","queries":["a","a"]}',
      '{"action":"search","queries":["a","b","c","d"]}',
      '{"action":"fetch","urls":[]}',
      JSON.stringify({
        action: "fetch",
        urls: Array.from({ length: 6 }, (_, index) => `https://example.com/${index + 1}`),
      }),
      '{"action":"fetch","urls":["https://example.com"]}\nextra',
      '{"action":"finish"}',
    ];
    for (const value of invalid) {
      assert.throws(() => parseWebResearchAgentAction(value), WebResearchAgentProtocolError);
    }
  });
});
