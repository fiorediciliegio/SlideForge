import assert from "node:assert/strict";
import test from "node:test";

import type { VisualStylePreset } from "../../src/api/types";
import {
  recommendVisualStylePresetByIntent,
  recommendVisualStylePresetByRules,
  recommendVisualStylePresetWithIntent,
} from "../../src/features/templates/visualStylePresetRecommendation";
import { toReadyUserVisualStylePresets } from "../../src/features/user-templates/userTemplateVisualStylePresets";

function preset(overrides: Partial<VisualStylePreset> = {}): VisualStylePreset {
  return {
    id: "generic",
    version: 1,
    ppt_number: 1,
    theme: "light",
    color: ["blue"],
    name: "Generic presentation",
    description: "General purpose presentation template.",
    user: "General audience",
    use_case: "General presentation",
    industry: "General",
    recommendation_profile: {
      use_cases: ["culture-story"],
      industries: ["business"],
      audiences: ["employee"],
      formats: [],
      styles: ["formal"],
    },
    preview_images: [{ url: "/preview.webp", alt: "Preview" }],
    reference_html_pages: [{ path: "html/cover.html", description: "General cover and content pages." }],
    ...overrides,
  };
}

test("uses aliases as soft signals instead of filtering candidates by a literal keyword", () => {
  const funding = preset({
    id: "funding",
    name: "Consumer Fundraising Pitch",
    description: "A formal investor presentation for a consumer company.",
    user: "Founders and investors",
    use_case: "Fundraising and investment",
    industry: "Retail and consumer",
    recommendation_profile: {
      use_cases: ["fundraising"],
      industries: ["consumer"],
      audiences: ["investor", "executive"],
      formats: ["pitch-deck"],
      styles: ["formal"],
    },
    color: ["cream"],
  });
  const travel = preset({
    id: "travel",
    name: "Spring travel guide",
    description: "A fresh guide for short trips.",
    user: "Travelers",
    use_case: "Travel guide",
    industry: "Tourism",
    recommendation_profile: {
      use_cases: ["travel-guide"],
      industries: ["travel"],
      audiences: ["public"],
      formats: ["guide"],
      styles: ["fresh"],
    },
    color: ["green"],
  });

  const result = recommendVisualStylePresetByRules("DTC 消费品牌 A轮融资，面向董事会汇报", [travel, funding]);

  assert.equal(result.preset.id, "funding");
  assert.deepEqual(result.trace.input_tags.use_case, ["fundraising"]);
  assert.deepEqual(result.trace.input_tags.audience, ["executive"]);
  assert.equal(result.trace.candidates[0]?.use_case_match, 1);
});

test("maps 财报 to financial results without using arbitrary Chinese character pairs", () => {
  const finance = preset({
    id: "finance",
    score: 8,
    name: "Quarterly Business Review",
    description: "Annual financial results with revenue, profit, and cash-flow analysis.",
    use_case: "Financial results",
    recommendation_profile: {
      use_cases: ["financial-results"],
      industries: ["finance"],
      audiences: ["executive"],
      formats: ["quarterly-report"],
      styles: ["formal"],
    },
  });
  const tropicalTravel = preset({
    id: "tropical-travel",
    score: 10,
    name: "Tropical Island Vacation Planner",
    description: "Playful island travel planner.",
    use_case: "Travel guide",
    recommendation_profile: {
      use_cases: ["travel-guide"],
      industries: ["travel"],
      audiences: ["public"],
      formats: ["guide"],
      styles: ["playful"],
    },
    reference_html_pages: [{
      path: "html/route.html",
      description: "构成一日路线，并介绍海岛景点。",
    }],
  });

  const result = recommendVisualStylePresetByRules("生成一个三页的财报介绍ppt", [tropicalTravel, finance]);

  assert.equal(result.preset.id, "finance");
  assert.deepEqual(result.trace.input_tags.use_case, ["financial-results"]);
  assert.equal(result.trace.candidates[0]?.use_case_match, 1);
  assert.equal("text_match" in result.trace.candidates[0]!, false);
});

test("does not classify an official investment template as a financial-results template from an incidental chart description", () => {
  const finance = preset({
    id: "finance",
    score: 8,
    name: "Annual Financial Results",
    use_case: "Reports and analysis",
    recommendation_profile: {
      use_cases: ["financial-results"],
      industries: ["finance"],
      audiences: ["executive"],
      formats: ["annual-report"],
      styles: ["formal"],
    },
  });
  const investment = preset({
    id: "investment",
    score: 10,
    name: "Renewable Energy Investment Deck",
    use_case: "Pitch decks and proposals",
    recommendation_profile: {
      use_cases: ["fundraising"],
      industries: ["finance"],
      audiences: ["investor"],
      formats: ["pitch-deck"],
      styles: ["formal"],
    },
    reference_html_pages: [{
      path: "html/financial-chart.html",
      description: "现金流柱线组合图配右侧财务表。",
    }],
  });

  const result = recommendVisualStylePresetByRules("生成一个三页的财报介绍ppt", [investment, finance]);

  assert.equal(result.preset.id, "finance");
  assert.equal(result.trace.candidates.find((candidate) => candidate.id === "investment")?.use_case_match, 0);
});

test("includes a ready user preset in ranking when its existing descriptions provide usable signals", () => {
  const official = preset({
    id: "official-finance",
    name: "Annual Financial Results",
    description: "Formal annual financial report.",
    user: "Board and management",
    use_case: "Financial results",
    industry: "Business",
    recommendation_profile: {
      use_cases: ["financial-results"],
      industries: ["finance"],
      audiences: ["executive"],
      formats: ["quarterly-report"],
      styles: ["formal"],
    },
  });
  const user = preset({
    id: "user-acme-board",
    source: "user",
    name: "Acme Board Quarterly Review",
    description: "Formal board review for Acme quarterly revenue, profit and cash flow.",
    user: "",
    recommendation_profile: undefined,
    use_case: "",
    industry: "",
    color: [],
    reference_html_pages: [{ path: "html/page-001.html", description: "Board-level quarterly revenue, profit and cash-flow review." }],
  });

  const result = recommendVisualStylePresetByRules("Acme 董事会季度收入、利润和现金流复盘", [official, user]);

  const userCandidate = result.trace.candidates.find((candidate) => candidate.id === "user-acme-board");
  assert.ok(userCandidate);
  assert.equal(userCandidate.use_case_match, 1);
  assert.equal(userCandidate.audience_match, 1);
});

test("keeps incomplete user presets out of automatic recommendation", () => {
  const official = preset({
    id: "official",
    name: "Formal strategy",
    description: "Formal strategy presentation.",
    recommendation_profile: { use_cases: ["strategy"], industries: ["business"], audiences: ["executive"], formats: ["roadmap"], styles: ["formal"] },
  });
  const incompleteUser = preset({
    id: "user-incomplete",
    source: "user",
    name: "Incomplete user template",
    description: "",
    reference_html_pages: [],
  });

  const result = recommendVisualStylePresetByRules("正式战略计划", [incompleteUser, official]);

  assert.equal(result.preset.id, "official");
  assert.deepEqual(result.trace.candidates.map((candidate) => candidate.id), ["official"]);
});

test("maps only ready user templates into recommendation candidates", () => {
  const templates = [
    {
      id: "user-ready",
      version: 1 as const,
      name: "Ready user template",
      description: "A complete formal board review template.",
      filename: "ready.pptx",
      status: "ready" as const,
      created_at: "2026-09-17T00:00:00.000Z",
      pages: [{ page_number: 1, description: "Board review cover." }],
      master_ready: true,
      completed_pages: [1],
      preview_images: [{ url: "/ready.webp", alt: "Ready" }],
    },
    {
      id: "user-draft",
      version: 1 as const,
      name: "Draft user template",
      description: "Not published.",
      filename: "draft.pptx",
      status: "draft" as const,
      created_at: "2026-09-17T00:00:00.000Z",
      pages: [],
      master_ready: false,
      completed_pages: [],
      preview_images: [],
    },
  ];

  const candidates = toReadyUserVisualStylePresets(templates);

  assert.deepEqual(candidates.map((candidate) => candidate.id), ["user-ready"]);
  assert.equal(candidates[0]?.source, "user");
});

test("records low-signal input and resolves ties deterministically", () => {
  const beta = preset({ id: "beta", score: 9 });
  const alpha = preset({ id: "alpha", score: 9 });

  const first = recommendVisualStylePresetByRules("罕见术语", [beta, alpha]);
  const second = recommendVisualStylePresetByRules("罕见术语", [beta, alpha]);

  assert.equal(first.trace.low_signal, true);
  assert.equal(first.preset.id, "alpha");
  assert.deepEqual(first, second);
});

test("does not rank a template from incidental two-character overlap when no candidate matches the input tags", () => {
  const highScore = preset({ id: "professional", score: 10 });
  const incidentalTravel = preset({
    id: "travel",
    score: 9,
    reference_html_pages: [{
      path: "html/route.html",
      description: "构成一日路线，并介绍旅行中的发现。",
    }],
  });

  const result = recommendVisualStylePresetByRules("做一个三页的介绍最新科学发现的ppt", [incidentalTravel, highScore]);

  assert.equal(result.trace.low_signal, false);
  assert.equal(result.preset.id, "professional");
});

test("an explicit requested style can decide the recommendation and an excluded style is never ranked", () => {
  const formal = preset({
    id: "formal",
    recommendation_profile: { use_cases: ["travel-guide"], industries: ["travel"], audiences: [], formats: [], styles: ["formal", "minimal"] },
  });
  const playful = preset({
    id: "playful",
    score: 10,
    recommendation_profile: { use_cases: ["travel-guide"], industries: ["travel"], audiences: [], formats: [], styles: ["playful"] },
  });

  const result = recommendVisualStylePresetByIntent({
    use_cases: [], industries: ["travel"], audiences: [], formats: [],
    explicit_styles: ["formal"], inferred_styles: [], excluded_styles: ["playful"],
  }, [playful, formal]);

  assert.equal(result.preset.id, "formal");
  assert.deepEqual(result.trace.excluded_candidate_ids, ["playful"]);
  assert.equal(result.trace.source, "llm-intent");
});

test("hard-excludes a visually dark preset even when dark is not its primary style", () => {
  const darkCoverRoadmap = preset({
    id: "19-Product Roadmap and Release Plan",
    score: 10,
    recommendation_profile: {
      use_cases: ["strategy"],
      industries: ["technology"],
      audiences: ["employee"],
      formats: ["roadmap"],
      primary_styles: ["formal"],
      visual_traits: ["formal", "data-dense", "dark"],
    },
  });
  const lightRoadmap = preset({
    id: "light-roadmap",
    score: 1,
    recommendation_profile: {
      use_cases: ["strategy"],
      industries: ["technology"],
      audiences: ["employee"],
      formats: ["roadmap"],
      primary_styles: ["formal"],
      visual_traits: ["formal", "data-dense"],
    },
  });

  const result = recommendVisualStylePresetByIntent({
    use_cases: ["strategy"], industries: ["technology"], audiences: [], formats: ["roadmap"],
    explicit_styles: ["formal"], inferred_styles: [], excluded_styles: ["dark"],
  }, [darkCoverRoadmap, lightRoadmap]);

  assert.equal(result.preset.id, "light-roadmap");
  assert.deepEqual(result.trace.excluded_candidate_ids, ["19-Product Roadmap and Release Plan"]);
});

test("low-signal intent uses the reviewed neutral fallback pool instead of catalogue score", () => {
  const thematic = preset({ id: "thematic", score: 100 });
  const neutral = preset({ id: "135-Next Quarter Strategic Plan Cover", score: 1 });

  const result = recommendVisualStylePresetByIntent({
    use_cases: [], industries: [], audiences: [], formats: [],
    explicit_styles: [], inferred_styles: [], excluded_styles: [],
  }, [thematic, neutral]);

  assert.equal(result.preset.id, neutral.id);
  assert.equal(result.trace.fallback, "neutral");
  assert.deepEqual(result.user_choice, {
    selection_required: true,
    confidence: "low",
    trigger: "low_signal",
    candidates: [{
      preset: { id: neutral.id, version: 1, name: neutral.name, description: neutral.description },
      score: 0,
      matched_axes: [],
    }],
  });
});

test("a failed intent analysis requires the user to choose from the deterministic top candidates", async () => {
  const formal = preset({ id: "formal", score: 2 });
  const higherScore = preset({ id: "higher-score", score: 3 });

  const result = await recommendVisualStylePresetWithIntent({
    brief: "正式战略计划",
    presets: [formal, higherScore],
    analyzeIntent: async () => Promise.reject(new Error("intent service unavailable")),
  });

  assert.equal(result.trace.source, "rules");
  assert.equal(result.user_choice?.trigger, "rules_fallback");
  assert.equal(result.user_choice?.confidence, "low");
  assert.deepEqual(result.user_choice?.candidates.map((candidate) => candidate.preset.id), result.top_candidates.map((candidate) => candidate.preset.id));
});
