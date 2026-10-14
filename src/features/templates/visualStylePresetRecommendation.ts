import type {
  PresentationRequirementsTemplateRecommendation,
  PresentationRequirementsTemplateRecommendationCandidate,
  PresentationRequirementsTemplateRecommendationMatchAxis,
  VisualStylePreset,
  VisualStylePresetRecommendationProfile,
} from "../../api/types";
import type { VisualStylePresetRecommendationIntent } from "../../ai/visualStylePresetRecommendationIntent";
import {
  type RecommendationAxis,
  VISUAL_STYLE_PRESET_RECOMMENDATION_RULES,
} from "./visualStylePresetRecommendationRules";

interface ExtractedTag {
  axis: RecommendationAxis;
  id: string;
}

type RecommendationTagsByAxis = Record<RecommendationAxis, string[]>;

export interface VisualStylePresetRecommendationTrace {
  input_tags: RecommendationTagsByAxis;
  explicit_styles: string[];
  inferred_styles: string[];
  excluded_styles: string[];
  source: "llm-intent" | "rules";
  intent_attempt_count: number;
  fallback: "none" | "neutral";
  excluded_candidate_ids: string[];
  low_signal: boolean;
  candidates: Array<{
    id: string;
    total: number;
    use_case_match: number | null;
    industry_match: number | null;
    audience_match: number | null;
    format_match: number | null;
    style_color_match: number | null;
  }>;
}

export interface VisualStylePresetRecommendation {
  preset: VisualStylePreset;
  trace: VisualStylePresetRecommendationTrace;
  top_candidates: PresentationRequirementsTemplateRecommendationCandidate[];
  user_choice: PresentationRequirementsTemplateRecommendation | null;
}

const AXIS_WEIGHTS = {
  use_case: 0.25,
  industry: 0.20,
  audience: 0.15,
  format: 0.25,
  style: 0.10,
} as const;

const EXPLICIT_STYLE_WEIGHT = 0.55;
const INFERRED_STYLE_WEIGHT = 0.10;

/** A deliberately small, reviewed fallback pool; never use the whole catalogue as a tie-break. */
export const NEUTRAL_VISUAL_STYLE_PRESET_IDS = [
  "134-Adaptive Systems Editorial Cover",
  "135-Next Quarter Strategic Plan Cover",
  "141-Lightweight AI Brand Glass Cover",
] as const;

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  const normalizedPhrase = normalize(phrase);
  if (!normalizedPhrase) return false;
  if (/[^a-z0-9 ]/u.test(normalizedPhrase)) return text.includes(normalizedPhrase);
  return (` ${text} `).includes(` ${normalizedPhrase} `);
}

function extractTags(text: string): ExtractedTag[] {
  const normalized = normalize(text);
  return VISUAL_STYLE_PRESET_RECOMMENDATION_RULES.flatMap((tag) => (
    tag.phrases.some((phrase) => containsPhrase(normalized, phrase))
      ? [{ axis: tag.axis, id: tag.id }]
      : []
  ));
}

function tagsForAxis(tags: readonly ExtractedTag[], axis: RecommendationAxis): string[] {
  return [...new Set(tags.filter((tag) => tag.axis === axis).map((tag) => tag.id))];
}

function toTagsByAxis(tags: readonly ExtractedTag[]): RecommendationTagsByAxis {
  return {
    use_case: tagsForAxis(tags, "use_case"),
    industry: tagsForAxis(tags, "industry"),
    audience: tagsForAxis(tags, "audience"),
    format: tagsForAxis(tags, "format"),
    style: tagsForAxis(tags, "style"),
  };
}

export function inferVisualStylePresetRecommendationIntentFromRules(
  brief: string,
): VisualStylePresetRecommendationIntent {
  const inputTags = toTagsByAxis(extractTags(brief));
  return {
    use_cases: inputTags.use_case,
    industries: inputTags.industry,
    audiences: inputTags.audience,
    formats: inputTags.format,
    explicit_styles: [],
    inferred_styles: inputTags.style,
    excluded_styles: [],
  };
}

function tagsFromIntent(intent: VisualStylePresetRecommendationIntent): RecommendationTagsByAxis {
  return {
    use_case: intent.use_cases,
    industry: intent.industries,
    audience: intent.audiences,
    format: intent.formats,
    style: [...intent.explicit_styles, ...intent.inferred_styles],
  };
}

function tagMatch(inputTags: readonly string[], candidateTags: readonly string[]): number | null {
  if (inputTags.length === 0) return null;
  if (candidateTags.length === 0) return 0;
  const candidateSet = new Set(candidateTags);
  const matched = inputTags.reduce((total, inputTag) => total + Number(candidateSet.has(inputTag)), 0);
  return matched / inputTags.length;
}

function isEligible(preset: VisualStylePreset): boolean {
  if (preset.source !== "user") return true;
  return Boolean(
    preset.name.trim()
    && preset.description.trim()
    && preset.reference_html_pages.length > 0
    && preset.reference_html_pages.every((page) => page.description.trim()),
  );
}

function tagsFromProfile(profile: VisualStylePresetRecommendationProfile): RecommendationTagsByAxis {
  return {
    use_case: profile.use_cases ?? [],
    industry: profile.industries ?? [],
    audience: profile.audiences ?? [],
    format: profile.formats ?? [],
    style: profile.primary_styles ?? profile.styles ?? [],
  };
}

function visualTraitsFromProfile(profile: VisualStylePresetRecommendationProfile): string[] {
  return profile.visual_traits ?? profile.primary_styles ?? profile.styles ?? [];
}

/**
 * A user template currently has no catalogue profile field. Its completed
 * description and page descriptions are the metadata supplied by the user.
 * Official templates intentionally do not fall back to free-text inference:
 * their profile is curated in preset.json.
 */
function candidateTags(preset: VisualStylePreset): RecommendationTagsByAxis {
  if (preset.recommendation_profile) return tagsFromProfile(preset.recommendation_profile);
  if (preset.source !== "user") return toTagsByAxis([]);
  return toTagsByAxis(extractTags([
    preset.name,
    preset.description,
    preset.user,
    preset.use_case,
    preset.industry,
    ...preset.reference_html_pages.map((page) => page.description),
  ].join(" ")));
}

/**
 * Visual traits deliberately differ from primary styles: the former are a
 * hard safety filter for an explicit user exclusion, while the latter are a
 * soft positive recommendation signal. Older and user-owned profiles retain
 * their existing single-style behaviour until they provide visual traits.
 */
function candidateVisualTraits(preset: VisualStylePreset): string[] {
  if (preset.recommendation_profile) return visualTraitsFromProfile(preset.recommendation_profile);
  return candidateTags(preset).style;
}

function weightedTotal(parts: Array<{ weight: number; score: number | null }>): number {
  const active = parts.filter((part) => part.score !== null);
  if (active.length === 0) return 0;
  const denominator = active.reduce((sum, part) => sum + part.weight, 0);
  return active.reduce((sum, part) => sum + part.weight * (part.score ?? 0), 0) / denominator;
}

function rankCandidates(input: {
  presets: readonly VisualStylePreset[];
  tags: RecommendationTagsByAxis;
  explicitStyles: readonly string[];
  inferredStyles: readonly string[];
}) {
  const semanticSignal = input.tags.use_case.length > 0
    || input.tags.industry.length > 0
    || input.tags.format.length > 0
    || input.explicitStyles.length > 0;
  return input.presets.map((preset) => {
    const profileTags = candidateTags(preset);
    const useCaseMatch = tagMatch(input.tags.use_case, profileTags.use_case);
    const industryMatch = tagMatch(input.tags.industry, profileTags.industry);
    const audienceMatch = tagMatch(input.tags.audience, profileTags.audience);
    const formatMatch = tagMatch(input.tags.format, profileTags.format);
    const explicitStyleMatch = tagMatch(input.explicitStyles, profileTags.style);
    const inferredStyleMatch = tagMatch(input.inferredStyles, profileTags.style);
    const total = semanticSignal ? weightedTotal([
      { weight: AXIS_WEIGHTS.use_case, score: useCaseMatch },
      { weight: AXIS_WEIGHTS.industry, score: industryMatch },
      { weight: AXIS_WEIGHTS.audience, score: audienceMatch },
      { weight: AXIS_WEIGHTS.format, score: formatMatch },
      { weight: EXPLICIT_STYLE_WEIGHT, score: explicitStyleMatch },
      { weight: INFERRED_STYLE_WEIGHT, score: inferredStyleMatch },
    ]) : 0;
    return {
      preset,
      total,
      useCaseMatch,
      industryMatch,
      audienceMatch,
      formatMatch,
      styleScore: explicitStyleMatch ?? inferredStyleMatch,
    };
  }).sort((left, right) => (
    right.total - left.total
    || (right.preset.score ?? 0) - (left.preset.score ?? 0)
    || left.preset.id.localeCompare(right.preset.id)
  ));
}

function toTrace(input: {
  inputTags: RecommendationTagsByAxis;
  explicitStyles: readonly string[];
  inferredStyles: readonly string[];
  excludedStyles: readonly string[];
  source: VisualStylePresetRecommendationTrace["source"];
  fallback: VisualStylePresetRecommendationTrace["fallback"];
  excludedCandidateIds: readonly string[];
  ranked: ReturnType<typeof rankCandidates>;
}): VisualStylePresetRecommendationTrace {
  return {
    input_tags: input.inputTags,
    explicit_styles: [...input.explicitStyles],
    inferred_styles: [...input.inferredStyles],
    excluded_styles: [...input.excludedStyles],
    source: input.source,
    intent_attempt_count: 0,
    fallback: input.fallback,
    excluded_candidate_ids: [...input.excludedCandidateIds],
    low_signal: input.inputTags.use_case.length === 0
      && input.inputTags.industry.length === 0
      && input.inputTags.format.length === 0
      && input.explicitStyles.length === 0,
    candidates: input.ranked.map((item) => ({
      id: item.preset.id,
      total: item.total,
      use_case_match: item.useCaseMatch,
      industry_match: item.industryMatch,
      audience_match: item.audienceMatch,
      format_match: item.formatMatch,
      style_color_match: item.styleScore,
    })),
  };
}

function toRecommendationCandidate(input: ReturnType<typeof rankCandidates>[number]): PresentationRequirementsTemplateRecommendationCandidate {
  const matchedAxes: PresentationRequirementsTemplateRecommendationMatchAxis[] = [];
  if ((input.useCaseMatch ?? 0) > 0) matchedAxes.push("use_case");
  if ((input.industryMatch ?? 0) > 0) matchedAxes.push("industry");
  if ((input.audienceMatch ?? 0) > 0) matchedAxes.push("audience");
  if ((input.formatMatch ?? 0) > 0) matchedAxes.push("format");
  if ((input.styleScore ?? 0) > 0) matchedAxes.push("style");
  return {
    preset: {
      id: input.preset.id,
      version: input.preset.version,
      name: input.preset.name,
      description: input.preset.description,
    },
    score: input.total,
    matched_axes: matchedAxes,
  };
}

function toUserChoice(
  trigger: PresentationRequirementsTemplateRecommendation["trigger"],
  candidates: PresentationRequirementsTemplateRecommendationCandidate[],
): PresentationRequirementsTemplateRecommendation {
  return { selection_required: true, confidence: "low", trigger, candidates };
}

export function recommendVisualStylePresetByIntent(
  intent: VisualStylePresetRecommendationIntent,
  presets: readonly VisualStylePreset[],
): VisualStylePresetRecommendation {
  const eligible = presets.filter(isEligible);
  if (eligible.length === 0) throw new Error("No eligible Visual Style Preset candidates are available.");
  const excludedCandidateIds = eligible
    .filter((preset) => candidateVisualTraits(preset).some((trait) => intent.excluded_styles.includes(trait)))
    .map((preset) => preset.id);
  const allowed = eligible.filter((preset) => !excludedCandidateIds.includes(preset.id));
  if (allowed.length === 0) {
    throw new Error("All eligible Visual Style Preset candidates violate the requested excluded styles.");
  }
  const inputTags = tagsFromIntent(intent);
  const ranked = rankCandidates({
    presets: allowed,
    tags: inputTags,
    explicitStyles: intent.explicit_styles,
    inferredStyles: intent.inferred_styles,
  });
  const lowSignal = inputTags.use_case.length === 0
    && inputTags.industry.length === 0
    && inputTags.format.length === 0
    && intent.explicit_styles.length === 0;
  const neutralCandidates = ranked.filter((candidate) => NEUTRAL_VISUAL_STYLE_PRESET_IDS.includes(candidate.preset.id as typeof NEUTRAL_VISUAL_STYLE_PRESET_IDS[number]));
  const choiceRanked = lowSignal && neutralCandidates.length > 0 ? neutralCandidates : ranked;
  const topCandidates = choiceRanked.slice(0, 3).map(toRecommendationCandidate);
  const selected = choiceRanked[0]!;
  return {
    preset: selected.preset,
    top_candidates: topCandidates,
    user_choice: lowSignal ? toUserChoice("low_signal", topCandidates) : null,
    trace: toTrace({
      inputTags,
      explicitStyles: intent.explicit_styles,
      inferredStyles: intent.inferred_styles,
      excludedStyles: intent.excluded_styles,
      source: "llm-intent",
      fallback: lowSignal && neutralCandidates.length > 0 ? "neutral" : "none",
      excludedCandidateIds,
      ranked,
    }),
  };
}

/**
 * Shared application path: normalize the original Brief once, then make the
 * final candidate choice locally. Rules are only an LLM transport/format
 * fallback; a valid hard-constraint failure is never silently weakened.
 */
export async function recommendVisualStylePresetWithIntent(input: {
  brief: string;
  presets: readonly VisualStylePreset[];
  analyzeIntent: () => Promise<{ intent: VisualStylePresetRecommendationIntent; attempts: readonly unknown[] }>;
}): Promise<VisualStylePresetRecommendation> {
  let analysis: { intent: VisualStylePresetRecommendationIntent; attempts: readonly unknown[] };
  try {
    analysis = await input.analyzeIntent();
  } catch {
    const fallback = recommendVisualStylePresetByIntent(
      inferVisualStylePresetRecommendationIntentFromRules(input.brief),
      input.presets,
    );
    return {
      ...fallback,
      user_choice: toUserChoice("rules_fallback", fallback.top_candidates),
      trace: { ...fallback.trace, source: "rules", intent_attempt_count: 0 },
    };
  }
  const result = recommendVisualStylePresetByIntent(analysis.intent, input.presets);
  return {
    ...result,
    trace: { ...result.trace, intent_attempt_count: analysis.attempts.length },
  };
}

export function recommendVisualStylePresetByRules(
  brief: string,
  presets: readonly VisualStylePreset[],
): VisualStylePresetRecommendation {
  const eligible = presets.filter(isEligible);
  if (eligible.length === 0) throw new Error("No eligible Visual Style Preset candidates are available.");
  const inputTags = toTagsByAxis(extractTags(brief));
  const ranked = rankCandidates({
    presets: eligible,
    tags: inputTags,
    explicitStyles: [],
    inferredStyles: inputTags.style,
  });
  const selected = ranked[0]!;
  return {
    preset: selected.preset,
    top_candidates: ranked.slice(0, 3).map(toRecommendationCandidate),
    user_choice: null,
    trace: toTrace({
      inputTags,
      explicitStyles: [],
      inferredStyles: inputTags.style,
      excludedStyles: [],
      source: "rules",
      fallback: "none",
      excludedCandidateIds: [],
      ranked,
    }),
  };
}
