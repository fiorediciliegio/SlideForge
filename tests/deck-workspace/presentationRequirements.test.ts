import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PresentationRequirementsPage } from "../../src/features/requirements/PresentationRequirementsPage";
import {
  confirmedRequirementsAllowOutline,
  createRequirementsDraft,
  requirementsAreComplete,
  createManualRequirementsDraft,
  requirementsAreCompleteWithoutVisualSelection,
  requiresTemplateRecommendationChoice,
  requirementsOwnedRecoveryStage,
} from "../../src/features/requirements/presentationRequirements";
import { messages } from "../../src/i18n/messages";

const candidates = {
  slide_count: [5],
  output_language: ["中文"],
};

const selectedPreset = {
  id: "editorial-sports",
  version: 1,
  name: "Editorial Sports",
  description: "强视觉、鲜明标题和编辑式阅读节奏。",
};

const research = {
  web: { recommended: true, reason: "需要最新资料。", enabled: true },
  images: { recommended: false, reason: "图形表达已经足够。", enabled: false },
};

test("defaults generation specifications without inferring content goals", () => {
  const draft = createRequirementsDraft("制作一份 5 页中文方案", candidates, selectedPreset, research);
  assert.deepEqual(draft.candidates, { slide_count: [5], output_language: ["中文"] });
  assert.deepEqual(draft.selections, { slide_count: 5, output_language: "中文", visual_style_preset: selectedPreset });
  assert.equal(draft.status, "draft");
  assert.equal(requirementsAreComplete(draft), true);
});

test("manual requirements validate specifications and both research choices", () => {
  const draft = createManualRequirementsDraft("测试");
  assert.equal(requirementsAreCompleteWithoutVisualSelection(draft), false);
  draft.selections.slide_count = 5;
  draft.selections.output_language = "中文";
  assert.equal(requirementsAreCompleteWithoutVisualSelection(draft), true);
  assert.equal(requirementsAreComplete(draft), false);
  draft.selections.visual_style_preset = selectedPreset;
  assert.equal(requirementsAreComplete(draft), true);
  draft.research.web.enabled = null;
  assert.equal(requirementsAreComplete(draft), false);
  draft.research.web.enabled = false;
  for (const count of [0, -1, 1.5, null]) {
    draft.selections.slide_count = count;
    assert.equal(requirementsAreComplete(draft), false);
  }
  draft.selections.slide_count = 5;
  for (const language of ["", "  ", "auto", " AUTO ", null]) {
    draft.selections.output_language = language;
    assert.equal(requirementsAreComplete(draft), false);
  }
});

test("only confirmed presentation requirements allow outline work", () => {
  assert.equal(confirmedRequirementsAllowOutline({ status: "draft" }), false);
  assert.equal(confirmedRequirementsAllowOutline({ status: "confirmed" }), true);
  assert.equal(confirmedRequirementsAllowOutline(null), false);
});

test("allows confirmation before the automatic visual preset selection", () => {
  const draft = createRequirementsDraft("制作一份 5 页中文方案", candidates, null, research);
  assert.equal(requirementsAreCompleteWithoutVisualSelection(draft), true);
});

test("requires an explicit template choice only for a deferred recommendation", () => {
  const draft = createRequirementsDraft("制作一份 5 页中文方案", candidates, null, research, {
    selection_required: true,
    confidence: "low",
    trigger: "low_signal",
    candidates: [{ preset: selectedPreset, score: 0, matched_axes: [] }],
  });
  assert.equal(requiresTemplateRecommendationChoice(draft), true);
  draft.selections.visual_style_preset = selectedPreset;
  assert.equal(requiresTemplateRecommendationChoice(draft), false);
});

test("draft presentation requirements own workspace recovery even when later artifacts exist", () => {
  assert.equal(requirementsOwnedRecoveryStage({ status: "empty" }), "brief");
  assert.equal(requirementsOwnedRecoveryStage({ status: "draft" }), "requirements");
  assert.equal(requirementsOwnedRecoveryStage({ status: "confirmed" }), null);
});

test("renders requirements without exposing the selected visual style summary", () => {
  const draft = createRequirementsDraft("制作一份 5 页中文方案", candidates, selectedPreset, research);
  const common = {
    t: messages.zh,
    brief: draft.source!.brief,
    requirements: draft,
    error: "",
    saving: false,
    confirming: false,
    dirty: true,
    hasSavedDraft: true,
    visualStylePresets: [],
    onSelect: () => undefined,
    onSelectResearch: () => undefined,
    onRetry: () => undefined,
    onManual: () => undefined,
    onBack: () => undefined,
    onForward: () => undefined,
    onSave: () => undefined,
    onConfirm: () => undefined,
  };
  const ready = renderToStaticMarkup(createElement(PresentationRequirementsPage, { ...common, status: "ready" }));
  assert.equal((ready.match(/>其他</g) ?? []).length, 2);
  assert.doesNotMatch(ready, /Editorial Sports/);
  assert.doesNotMatch(ready, /内容目标|受众|用途|预期效果|视觉气质/);
  assert.match(ready, /生成规格/);
  assert.match(ready, /研究选择/);
  const english = renderToStaticMarkup(createElement(PresentationRequirementsPage, { ...common, t: messages.en, status: "ready" }));
  assert.match(english, /Generation specifications/);
  assert.match(english, /Research choices/);
  assert.doesNotMatch(english, /Content goals|Audience|Purpose|Desired outcome|Visual tone/);
  assert.equal((english.match(/>Other</g) ?? []).length, 2);

  assert.match(ready, /<details class="requirements-brief">/);
  assert.match(ready, /用户需求/);
  assert.match(ready, />保存</);
  assert.match(ready, />返回</);
  assert.match(ready, /data-performance-id="requirements.forward"/);
  assert.match(ready, /确认并继续/);
  const loading = renderToStaticMarkup(createElement(PresentationRequirementsPage, { ...common, status: "loading" }));
  assert.match(loading, /正在梳理演示需求\.\.\./);
  assert.match(loading, /requirements-breathing-mark/);
  assert.doesNotMatch(loading, />返回</);
  for (const locale of ["zh", "en"] as const) {
    const t = messages[locale];
    const progress = [{ id: "attachments", label: t.processProgress.attachments, state: "running" as const,
      files: [{ name: "Operating_Data_EN.xlsx", state: "running" as const }] }];
    const processing = renderToStaticMarkup(createElement(PresentationRequirementsPage, { ...common, t, status: "loading", progress }));
    assert.equal((processing.match(/class="process-timeline"/g) ?? []).length, 1);
    assert.doesNotMatch(processing, /attachment-preparation-status/);
    assert.equal(processing.split("Operating_Data_EN.xlsx").length - 1, 1);
  }
});

test("shows a generated draft as saved until the user edits it", () => {
  const draft = createRequirementsDraft("制作一份 5 页中文方案", candidates, selectedPreset, research);
  const html = renderToStaticMarkup(createElement(PresentationRequirementsPage, {
    t: messages.zh,
    brief: draft.source!.brief,
    requirements: draft,
    status: "ready",
    error: "",
    saving: false,
    confirming: false,
    dirty: false,
    hasSavedDraft: true,
    visualStylePresets: [],
    onSelect: () => undefined,
    onSelectResearch: () => undefined,
    onRetry: () => undefined,
    onManual: () => undefined,
    onBack: () => undefined,
    onSave: () => undefined,
    onConfirm: () => undefined,
  }));

  assert.match(html, /草稿已保存/);
  assert.doesNotMatch(html, /有未保存的修改/);
  assert.match(html, /class="secondary-btn"[^>]*disabled=""/);
  assert.match(html, /data-performance-id="requirements.save"[^>]*disabled=""/);
});

test("renders Other as an independently selectable radio while preserving a custom draft", () => {
  const draft = createRequirementsDraft("制作一份 5 页中文方案", candidates, null, research);
  draft.selections.output_language = "日本語";
  const html = renderToStaticMarkup(createElement(PresentationRequirementsPage, {
    t: messages.zh,
    brief: draft.source!.brief,
    requirements: draft,
    status: "ready",
    error: "",
    saving: false,
    confirming: false,
    dirty: true,
    hasSavedDraft: true,
    visualStylePresets: [],
    onSelect: () => undefined,
    onSelectResearch: () => undefined,
    onRetry: () => undefined,
    onManual: () => undefined,
    onBack: () => undefined,
    onSave: () => undefined,
    onConfirm: () => undefined,
  }));

  assert.match(html, /requirement-custom selected" role="radio" aria-checked="true"/);
  assert.match(html, /value="日本語"/);
  assert.match(html, /requirement-custom" role="radio" aria-checked="false"/);
});

test("shows confirmation separately from draft saving", () => {
  const draft = createRequirementsDraft("制作一份 5 页中文方案", candidates, null, research);
  const html = renderToStaticMarkup(createElement(PresentationRequirementsPage, {
    t: messages.zh,
    brief: draft.source!.brief,
    requirements: draft,
    status: "ready",
    error: "",
    saving: false,
    confirming: true,
    dirty: false,
    hasSavedDraft: true,
    visualStylePresets: [],
    onSelect: () => undefined,
    onSelectResearch: () => undefined,
    onRetry: () => undefined,
    onManual: () => undefined,
    onBack: () => undefined,
    onSave: () => undefined,
    onConfirm: () => undefined,
  }));

  assert.match(html, /正在确认\.\.\./);
  assert.doesNotMatch(html, /正在保存草稿\.\.\./);
});

test("shows persisted low-confidence candidates and blocks confirmation until one is selected", () => {
  const draft = createRequirementsDraft("介绍一个新概念", candidates, null, research, {
    selection_required: true,
    confidence: "low",
    trigger: "low_signal",
    candidates: [{ preset: selectedPreset, score: 0, matched_axes: [] }],
  });
  const html = renderToStaticMarkup(createElement(PresentationRequirementsPage, {
    t: messages.zh,
    brief: draft.source!.brief,
    requirements: draft,
    status: "ready",
    error: "",
    saving: false,
    confirming: false,
    dirty: false,
    hasSavedDraft: true,
    visualStylePresets: [],
    onSelect: () => undefined,
    onSelectResearch: () => undefined,
    onRetry: () => undefined,
    onManual: () => undefined,
    onBack: () => undefined,
    onSave: () => undefined,
    onConfirm: () => undefined,
  }));

  assert.match(html, /请选择模板/);
  assert.doesNotMatch(html, /推荐把握：低/);
  assert.match(html, /Editorial Sports/);
  assert.match(html, /data-performance-id="requirements\.confirm"[^>]*disabled=""/);
});
