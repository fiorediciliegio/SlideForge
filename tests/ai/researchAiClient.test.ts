import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { createResearchAiClient } from "../../src/ai/researchAiClient.ts";
import { DEFAULT_LLM_MAX_ATTEMPTS, LlmRequestExecutionError } from "../../src/ai/llmRequestExecutor.ts";
import type { AnnaLlmCompleteInput, AnnaRuntime } from "../../src/runtime/annaRuntime.ts";
import type { AttachmentContext, PresentationRequirements } from "../../src/api/types.ts";
import { currentDatePromptLine } from "../../src/ai/promptContext.ts";
import { formatUserProvidedAttachmentContextForPrompt } from "../../src/ai/attachmentContextPrompt.ts";

function requirements(): PresentationRequirements {
  const semantic = (label: string, description: string) => ({ label, description });
  return {
    version: 1,
    status: "draft",
    source: { brief: "Brief" },
    candidates: {
      slide_count: [8],
      output_language: ["English"],
    },
    selections: {
      slide_count: 8,
      output_language: "English",
      visual_style_preset: {
        id: "preset",
        version: 1,
        name: "企业项目投标演示",
        description: "采用白色页面和蓝色侧边栏。",
      },
    },
    research: {
      web: { recommended: null, reason: "", enabled: null },
      images: { recommended: null, reason: "", enabled: null },
    },
    updated_at: null,
    confirmed_at: null,
  };
}

describe("Research AI Client", () => {

  it("preserves historical evaluation messages using output language instead of UI locale", async () => {
    let request: AnnaLlmCompleteInput | undefined;
    const runtime = { llm: { complete: async (input: AnnaLlmCompleteInput) => {
      request = input;
      return { text: '{"web":{"recommended":false,"reason":"No"},"images":{"recommended":false,"reason":"No"}}' };
    } } } as AnnaRuntime;
    for (let version = 1; version <= 10; version += 1) {
      const promptTemplate = readFileSync(new URL(`../../evals/research-routing/prompts/router-v${version}.txt`, import.meta.url), "utf8").trimEnd();
      const expected = promptTemplate
        .replaceAll("{Simplified Chinese 或 English}", "English")
        .replaceAll("{Simplified Chinese or English}", "English")
        .replaceAll("{用户输入的原始 Prompt}", "Brief text")
        .replaceAll("{User brief}", "Brief text")
        .replaceAll("{完整的 Presentation Requirements JSON}", JSON.stringify(requirements(), null, 2))
        .replaceAll("{Presentation Requirements JSON}", JSON.stringify(requirements(), null, 2));
      await createResearchAiClient(runtime).recommendResearchForEvaluation({
        brief: "Brief text", requirements: requirements(), locale: "zh", promptTemplate, promptVersion: `v${version}`,
      });
      assert.deepEqual(request?.messages, [{ role: "user", content: { type: "text", text: expected } }], `v${version}`);
    }
  });

  it("preserves v11 output language, message structure, date and optional attachments with a different UI locale", async () => {
    const v7 = readFileSync(new URL("../../evals/research-routing/prompts/router-v7.txt", import.meta.url), "utf8").trimEnd();
    const batch = JSON.parse(readFileSync(new URL("../../evals/research-routing/config/stage1-smoke-v11-batch-input.json", import.meta.url), "utf8"));
    const promptTemplate = batch.research_routing.prompts[0].prompt;
    const jsonConstraint = 'Return exactly one JSON object:\n\n{"web":{"recommended":false,"reason":"..."},"images":{"recommended":false,"reason":"..."}}';
    assert.equal(v7, `${promptTemplate}\n\n${jsonConstraint}`);
    const attachmentContext: AttachmentContext = {
      version: 1,
      user_brief: "Brief text",
      attachment_context: [{
        version: 1,
        source_id: "source-1",
        filename: "notes.txt",
        content_strategy: "summarized_context",
        original_reading_method: "document_retrieval",
        main_message: "Supplied facts",
        key_facts: [],
        must_include: [],
        must_avoid: [],
        recommended_storyline: [],
        gaps: [],
        unread_content: [],
        updated_at: "2026-09-08T00:00:00.000Z",
      }],
      updated_at: "2026-09-08T00:00:00.000Z",
    };
    let request: AnnaLlmCompleteInput | undefined;
    const runtime = { llm: { complete: async (input: AnnaLlmCompleteInput) => {
      request = input;
      return { text: '{"web":{"recommended":false,"reason":"No"},"images":{"recommended":false,"reason":"No"}}' };
    } } } as AnnaRuntime;
    for (const context of [null, attachmentContext]) {
      const date = currentDatePromptLine();
      await createResearchAiClient(runtime).recommendResearchForEvaluation({
        brief: "Brief text", requirements: requirements(), locale: "zh", promptTemplate, promptVersion: "v11", attachmentContext: context,
      });
      const body = promptTemplate.replaceAll("{Simplified Chinese or English}", "English")
        .replaceAll("{User brief}", "Brief text")
        .replaceAll("{Presentation Requirements JSON}", JSON.stringify(requirements(), null, 2));
      assert.deepEqual(request?.messages, [
        { role: "system", content: { type: "text", text: jsonConstraint.replaceAll("\n", "") } },
        { role: "user", content: { type: "text", text: [body, date, ...(context ? [formatUserProvidedAttachmentContextForPrompt(context, "en")] : [])].join("\n\n") } },
      ]);
    }
  });

  it("keeps production research prompts separate from evaluation prompt candidates", async () => {
    const prompts: string[] = [];
    const runtime = {
      llm: {
        complete: async ({ messages }: { messages: Array<{ content: { text: string } }> }) => {
          prompts.push(messages[0]?.content.text ?? "");
          return {
            model: "test/model",
            usage: { total_tokens: 12 },
            text: '{"web":{"recommended":true,"reason":"Current facts are required."},"images":{"recommended":false,"reason":"No real visuals are required."}}',
          };
        },
      },
    } as never;
    const result = await createResearchAiClient(runtime).recommendResearchForEvaluation({
      brief: "Brief text",
      requirements: requirements(),
      locale: "en",
      promptTemplate: "Use {User brief} and {Presentation Requirements JSON}. Return JSON.",
    });

    assert.equal(result.actual_model, "test/model");
    assert.deepEqual(result.token_usage, { total_tokens: 12 });
    assert.equal(result.retry_count, 0);
    assert.match(prompts[0] ?? "", /Brief text/);
    assert.match(prompts[0] ?? "", /\"slide_count\"/);
    assert.doesNotMatch(prompts[0] ?? "", /You decide whether this PPT generation/);
  });

  it("moves only the JSON constraint into the system prompt for v11 evaluation", async () => {
    const requests: AnnaLlmCompleteInput[] = [];
    const runtime: AnnaRuntime = {
      tools: { invoke: async () => ({}) },
      llm: {
        complete: async (request) => {
          requests.push(request);
          return { text: '{"web":{"recommended":false,"reason":"不需要网页研究。"},"images":{"recommended":false,"reason":"不需要图片研究。"}}' };
        },
      },
      agent: { session: async () => { throw new Error("not used"); } },
    };

    await createResearchAiClient(runtime).recommendResearchForEvaluation({
      brief: "Brief text",
      requirements: requirements(),
      locale: "en",
      promptVersion: "v11",
      promptTemplate: "Decide whether NEW external Web or image research is genuinely required.\n\nDo not recommend research only because:\n\n- the presentation mentions a known company, product, person, or place;\n- comparisons, examples, or visuals might be helpful;\n- the user asks for a polished or visually impressive presentation;\n- additional information could make the presentation more detailed;\n- images could be used decoratively;\n- the topic is broad or the brief is short.\n\nRecommend Web only when the user's requested result depends on missing current, external, or verifiable facts.\n\nRecommend images only when the request depends on actual real-world visual material rather than generated diagrams, illustrations, icons, or decorative graphics.\n\nDefault to false when the need is optional or uncertain. Evaluate Web and images independently.\n\nReturn concise reasons in the requested output locale.\n\nRecommendation reason language: {Simplified Chinese or English}\n\nUser brief:\n{User brief}\n\nPresentation requirements draft:\n{Presentation Requirements JSON}",
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.messages[0]?.role, "system");
    assert.equal(requests[0]?.messages[1]?.role, "user");
    assert.equal(requests[0]?.messages[0]?.content.text, 'Return exactly one JSON object:{"web":{"recommended":false,"reason":"..."},"images":{"recommended":false,"reason":"..."}}');
    assert.doesNotMatch(requests[0]?.messages[1]?.content.text ?? "", /Return exactly one JSON object:/);
    assert.match(requests[0]?.messages[1]?.content.text ?? "", /Current date \(Asia\/Shanghai\):/);
    assert.match(requests[0]?.messages[1]?.content.text ?? "", /User brief:/);
  });

  it("uses the shared LLM retry framework for evaluation responses", async () => {
    const requests: AnnaLlmCompleteInput[] = [];
    const runtime: AnnaRuntime = {
      tools: { invoke: async () => ({}) },
      llm: {
        complete: async (request) => {
          requests.push(request);
          return requests.length < DEFAULT_LLM_MAX_ATTEMPTS
            ? { text: "not JSON" }
            : { text: '{"web":{"recommended":false,"reason":"No current facts."},"images":{"recommended":false,"reason":"No real visuals."}}' };
        },
      },
      agent: { session: async () => { throw new Error("not used"); } },
    };

    const result = await createResearchAiClient(runtime).recommendResearchForEvaluation({
      brief: "Brief text",
      requirements: requirements(),
      locale: "en",
      promptTemplate: "Return one JSON object.",
    });

    assert.equal(result.retry_count, DEFAULT_LLM_MAX_ATTEMPTS - 1);
    assert.deepEqual(result.retry_reasons, Array.from({ length: DEFAULT_LLM_MAX_ATTEMPTS - 1 }, () => "json_format"));
    assert.equal(result.json_repair_count, DEFAULT_LLM_MAX_ATTEMPTS - 1);
    assert.equal(requests.length, DEFAULT_LLM_MAX_ATTEMPTS);
    assert.ok(requests.every((request) => JSON.stringify(request) === JSON.stringify(requests[0])));
  });

  it("uses the template-webp-eval research routing prompt for recommendations", async () => {
    const requests: AnnaLlmCompleteInput[] = [];
    const runtime = {
      llm: {
        complete: async (request: AnnaLlmCompleteInput) => {
          requests.push(request);
          return { text: '{"web":{"recommended":false,"reason":"不需要外部事实。"},"images":{"recommended":false,"reason":"不需要外部图片。"}}' };
        },
      },
    } as never;
    const result = await createResearchAiClient(runtime).recommendResearch({
      brief: "关于定价策略的领导层汇报。",
      requirements: requirements(),
      locale: "en",
    });

    assert.equal(result.web.recommended, false);
    assert.equal(result.images.recommended, false);
    assert.equal(requests[0]?.messages[0]?.role, "system");
    assert.equal(requests[0]?.messages[0]?.content.text, 'Return exactly one JSON object:{"web":{"recommended":false,"reason":"..."},"images":{"recommended":false,"reason":"..."}}');
    assert.equal(requests[0]?.messages[1]?.role, "user");
    const userPrompt = requests[0]?.messages[1]?.content.text ?? "";
    assert.match(userPrompt, /Decide whether NEW external Web or image research is genuinely required/);
    assert.match(userPrompt, /Do not recommend research only because:/);
    assert.match(userPrompt, /Recommend Web only when the user's requested result depends on missing current, external, or verifiable facts/);
    assert.match(userPrompt, /Recommend images only when the request depends on actual real-world visual material/);
    assert.match(userPrompt, /Default to false when the need is optional or uncertain/);
    assert.match(userPrompt, /Recommendation reason language: English/);
    assert.match(userPrompt, /Presentation requirements draft:/);
    assert.match(userPrompt, /\"candidates\"/);
    assert.doesNotMatch(userPrompt, /Return exactly one JSON object:/);
    assert.doesNotMatch(userPrompt, /判断是否需要进行新的外部网页研究或图片研究/);
  });

  it("writes recommendation reasons in the interface locale, not output_language", async () => {
    const requests: AnnaLlmCompleteInput[] = [];
    const runtime = {
      llm: {
        complete: async (request: AnnaLlmCompleteInput) => {
          requests.push(request);
          return { text: '{"web":{"recommended":false,"reason":"外部事実は不要です。"},"images":{"recommended":false,"reason":"外部画像は不要です。"}}' };
        },
      },
    } as never;
    // 夹具的 output_language 是 English；locale=ja 时理由语言必须是日本語（界面语言优先）
    await createResearchAiClient(runtime).recommendResearch({
      brief: "価格戦略についての経営報告。",
      requirements: requirements(),
      locale: "ja",
    });
    const userPrompt = requests[0]?.messages[1]?.content.text ?? "";
    assert.match(userPrompt, /Recommendation reason language: 日本語/);
    assert.doesNotMatch(userPrompt, /Recommendation reason language: English/);
  });

  it("includes only attachment_context JSON in research recommendations", async () => {
    const prompts: string[] = [];
    const runtime = {
      llm: {
        complete: async ({ messages }: { messages: Array<{ content: { text: string } }> }) => {
          prompts.push(messages[1]?.content.text ?? "");
          return { text: '{"web":{"recommended":false,"reason":"不需要外部事实。"},"images":{"recommended":false,"reason":"不需要外部图片。"}}' };
        },
      },
    } as never;
    const attachmentContext: AttachmentContext = {
      version: 1,
      user_brief: "persisted brief should not be repeated",
      attachment_context: [{
        version: 1,
        source_id: "source-1",
        filename: "source.md",
        content_strategy: "summarized_context",
        original_reading_method: "document_retrieval",
        main_message: "核心信息",
        key_facts: [],
        must_include: [],
        must_avoid: [],
        recommended_storyline: ["推荐叙事"],
        gaps: [],
        unread_content: [],
        updated_at: "2026-09-04T00:00:00.000Z",
      }],
      updated_at: "2026-09-04T00:00:00.000Z",
    };
    await createResearchAiClient(runtime).recommendResearch({
      brief: "当前 Brief",
      requirements: requirements(),
      attachmentContext,
      locale: "zh",
    });
    assert.match(prompts[0] ?? "", /## User Attachments/);
    assert.match(prompts[0] ?? "", /"source_id": "source-1"/);
    assert.match(prompts[0] ?? "", /"recommended_storyline": \[/);
    assert.doesNotMatch(prompts[0] ?? "", /persisted brief should not be repeated/);
  });

  it("omits attachment context when research recommendations have no attachments", async () => {
    const prompts: string[] = [];
    const runtime = {
      llm: {
        complete: async ({ messages }: { messages: Array<{ content: { text: string } }> }) => {
          prompts.push(messages[1]?.content.text ?? "");
          return { text: '{"web":{"recommended":false,"reason":"不需要外部事实。"},"images":{"recommended":false,"reason":"不需要外部图片。"}}' };
        },
      },
    } as never;
    await createResearchAiClient(runtime).recommendResearch({ brief: "当前 Brief", requirements: requirements(), locale: "zh" });
    assert.doesNotMatch(prompts[0] ?? "", /User Attachments|用户附件内容/);
  });

  it("retries semantic validation failures with the exact original request", async () => {
    const requests: AnnaLlmCompleteInput[] = [];
    const responses = [
      { text: '{"web":{"recommended":false,"reason":""},"images":{"recommended":false,"reason":"不需要图片。"}}' },
      { text: '{"web":{"recommended":false,"reason":"不需要网页研究。"},"images":{"recommended":false,"reason":"不需要图片。"}}' },
    ];
    const runtime: AnnaRuntime = {
      tools: { invoke: async () => ({}) },
      llm: {
        complete: async (request) => {
          requests.push(request);
          return responses[requests.length - 1];
        },
      },
      agent: { session: async () => { throw new Error("not used"); } },
    };

    const result = await createResearchAiClient(runtime).recommendResearch({
      brief: "关于定价策略的领导层汇报。",
      requirements: requirements(),
      locale: "en",
    });

    assert.equal(result.web.reason, "不需要网页研究。");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0]);
  });
});
