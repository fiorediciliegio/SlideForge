import assert from "node:assert/strict";
import test from "node:test";
import { confirmedRequirements } from "../fixtures/imageRequirements";
import { formatConfirmedRequirementsForPrompt, formatResearchRequirements, formatWebResearchRequirements, requirementsForPrompt } from "../../src/ai/requirementsFormatting";
import { buildGenerateOutlineLlmRequest, buildReviseOutlineLlmRequest } from "../../src/ai/outlinePrompt";
import { buildVisualStylePresetColorRequest, buildVisualStylePresetRequest } from "../../src/ai/visualStylePresetSelectionPrompt";
import { buildVisualMasterHtmlPrompt } from "../../src/features/deck-generation/htmlPrompts";
import { createResearchAiClient } from "../../src/ai/researchAiClient";
import { createAnnaAiClient } from "../../src/ai/hostAiClient";
import type { WorkspaceOutline } from "../../src/api/types";
import type { HostRuntime } from "../../src/runtime/hostRuntime";

const removed = ["audience", "purpose", "desired_outcome", "visual_tone"];
const legacyFields = Object.fromEntries(removed.map((field) => [field, { label: "REMOVED_CONTENT_GOAL", description: "REMOVED_DESCRIPTION" }]));
const original = confirmedRequirements();
const requirements = {
  ...original,
  candidates: { ...original.candidates, ...Object.fromEntries(Object.entries(legacyFields).map(([key, value]) => [key, [value]])) },
  selections: { ...original.selections, ...legacyFields },
};
const outline: WorkspaceOutline = {
  version: 4, status: "confirmed", title: "原始主题", items: [], updated_at: null, confirmed_at: null,
};
function noGoals(prompt: string) {
  assert.doesNotMatch(prompt, /REMOVED_CONTENT_GOAL|REMOVED_DESCRIPTION|"audience"|"purpose"|"desired_outcome"|"visual_tone"/);
}

test("大纲、研究及视觉提示词忽略旧内容目标，同时保留原始需求与生成规格", () => {
  assert.deepEqual(requirementsForPrompt(requirements), original);
  const requests = [
    buildGenerateOutlineLlmRequest({ requirements }),
    buildReviseOutlineLlmRequest({ requirements, outline: [], feedback: "保留原始事实" }),
    buildVisualStylePresetColorRequest({ brief: requirements.source!.brief, requirements, colors: ["blue"] }),
    buildVisualStylePresetRequest({ brief: requirements.source!.brief, requirements, color: "blue", candidates: [] }),
  ];
  for (const request of requests) {
    const prompt = request.messages.map((message) => message.content.text).join("\n");
    noGoals(prompt);
    assert.ok(prompt.includes(requirements.source!.brief));
    assert.match(prompt, /"slide_count":\s*8/);
    assert.ok(prompt.includes("中文"));
  }
  for (const prompt of [
    formatResearchRequirements(requirements),
    formatWebResearchRequirements(requirements),
    formatConfirmedRequirementsForPrompt(requirements),
    buildVisualMasterHtmlPrompt({ requirements, outline, referenceHtml: "REFERENCE_HTML" }),
  ]) noGoals(prompt);
  const master = buildVisualMasterHtmlPrompt({ requirements, outline, referenceHtml: "REFERENCE_HTML" });
  assert.ok(master.includes(requirements.source!.brief));
  assert.match(master, /REFERENCE_HTML/);
});

test("研究推荐和美学参考选择不会透传旧内容目标", async () => {
  const prompts: string[] = [];
  const runtime = {
    llm: { complete: async (request: { messages: Array<{ content: { text: string } }> }) => {
      prompts.push(request.messages.map((message) => message.content.text).join("\n"));
      return { text: prompts.length === 1
        ? '{"web":{"recommended":false,"reason":"No"},"images":{"recommended":false,"reason":"No"}}'
        : '{"path":"html/reference.html"}' };
    } },
  } as HostRuntime;
  await createResearchAiClient(runtime).recommendResearch({ brief: requirements.source!.brief, requirements, locale: "zh" });
  await createAnnaAiClient(runtime).selectDominantAestheticReference({
    requirements, outline, target: "visual-master",
    candidates: [{ path: "html/reference.html", description: "参考页" }, { path: "html/other.html", description: "另一参考页" }],
  });
  assert.equal(prompts.length, 2);
  prompts.forEach(noGoals);
  assert.ok(prompts[0]!.includes(requirements.source!.brief));
  assert.ok(prompts[1]!.includes(requirements.selections.visual_style_preset!.name));
});
