import type { LlmCompleteInput } from "../runtime/hostRuntime";
import {
  type RecommendationAxis,
  VISUAL_STYLE_PRESET_RECOMMENDATION_TAG_IDS,
  VISUAL_STYLE_PRESET_RECOMMENDATION_VISUAL_TRAIT_IDS,
} from "../features/templates/visualStylePresetRecommendationRules";

export interface VisualStylePresetRecommendationIntent {
  use_cases: string[];
  industries: string[];
  audiences: string[];
  formats: string[];
  /** Styles the user directly requests, so they are allowed to decide alone. */
  explicit_styles: string[];
  /** Weak, non-binding styles inferred from the topic or tone. */
  inferred_styles: string[];
  /** Styles the user directly excludes. They are hard candidate constraints. */
  excluded_styles: string[];
}

const AXIS_TO_RESPONSE_FIELD: Readonly<Record<RecommendationAxis, keyof VisualStylePresetRecommendationIntent>> = {
  use_case: "use_cases",
  industry: "industries",
  audience: "audiences",
  format: "formats",
  style: "inferred_styles",
};

function controlledVocabulary() {
  return Object.fromEntries(
    (Object.keys(AXIS_TO_RESPONSE_FIELD) as RecommendationAxis[]).map((axis) => [
      AXIS_TO_RESPONSE_FIELD[axis],
      VISUAL_STYLE_PRESET_RECOMMENDATION_TAG_IDS[axis],
    ]),
  );
}

export function buildVisualStylePresetRecommendationIntentRequest(
  brief: string,
): LlmCompleteInput {
  return {
    messages: [
      {
        role: "system",
        content: {
          type: "text",
          text: [
            "You normalize a presentation Brief into controlled template-recommendation tags.",
            "Do not select a template. Do not infer facts that are absent from the Brief.",
            "Support Chinese, English, Japanese, and mixed-language Briefs.",
            "Use explicit_styles only for a visual style directly requested by the user. Use inferred_styles only for a weak visual inference; it must not duplicate explicit_styles.",
            "Use excluded_styles only for directly negated visual requests such as '不要卡通', 'not dark', or 'no magazine style'. These are hard candidate constraints and may use the broader visual-trait vocabulary.",
            "Every tag must be copied exactly from the supplied vocabulary. Return empty arrays when uncertain.",
            "Return JSON only, with exactly this shape: {\"use_cases\":[],\"industries\":[],\"audiences\":[],\"formats\":[],\"explicit_styles\":[],\"inferred_styles\":[],\"excluded_styles\":[]}.",
          ].join("\n"),
        },
      },
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `<brief>\n${brief.trim()}\n</brief>`,
            `<controlled_vocabulary>\n${JSON.stringify({
              ...controlledVocabulary(),
              explicit_styles: VISUAL_STYLE_PRESET_RECOMMENDATION_TAG_IDS.style,
              excluded_styles: VISUAL_STYLE_PRESET_RECOMMENDATION_VISUAL_TRAIT_IDS,
            })}\n</controlled_vocabulary>`,
            "Return JSON only.",
          ].join("\n\n"),
        },
      },
    ],
  };
}

const RESPONSE_FIELDS = [
  "use_cases",
  "industries",
  "audiences",
  "formats",
  "explicit_styles",
  "inferred_styles",
  "excluded_styles",
] as const;

function parseTagArray(value: unknown, field: keyof VisualStylePresetRecommendationIntent, allowed: readonly string[]): string[] {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string" || !allowed.includes(tag))) {
    throw new Error(`${field} must be an array of controlled tags.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${field} must not contain duplicate tags.`);
  return [...value];
}

export function parseVisualStylePresetRecommendationIntentResponse(
  value: unknown,
): VisualStylePresetRecommendationIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The template recommendation intent response must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== RESPONSE_FIELDS.length || RESPONSE_FIELDS.some((field) => !(field in record))) {
    throw new Error("The template recommendation intent response must contain exactly the required fields.");
  }
  const result: VisualStylePresetRecommendationIntent = {
    use_cases: parseTagArray(record.use_cases, "use_cases", VISUAL_STYLE_PRESET_RECOMMENDATION_TAG_IDS.use_case),
    industries: parseTagArray(record.industries, "industries", VISUAL_STYLE_PRESET_RECOMMENDATION_TAG_IDS.industry),
    audiences: parseTagArray(record.audiences, "audiences", VISUAL_STYLE_PRESET_RECOMMENDATION_TAG_IDS.audience),
    formats: parseTagArray(record.formats, "formats", VISUAL_STYLE_PRESET_RECOMMENDATION_TAG_IDS.format),
    explicit_styles: parseTagArray(record.explicit_styles, "explicit_styles", VISUAL_STYLE_PRESET_RECOMMENDATION_TAG_IDS.style),
    inferred_styles: parseTagArray(record.inferred_styles, "inferred_styles", VISUAL_STYLE_PRESET_RECOMMENDATION_TAG_IDS.style),
    excluded_styles: parseTagArray(record.excluded_styles, "excluded_styles", VISUAL_STYLE_PRESET_RECOMMENDATION_VISUAL_TRAIT_IDS),
  };
  if (result.explicit_styles.some((tag) => result.inferred_styles.includes(tag))) {
    throw new Error("explicit_styles and inferred_styles must not overlap.");
  }
  if (result.excluded_styles.some((tag) => result.explicit_styles.includes(tag) || result.inferred_styles.includes(tag))) {
    throw new Error("excluded_styles must not overlap with requested styles.");
  }
  return result;
}
