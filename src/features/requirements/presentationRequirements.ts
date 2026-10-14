import type {
  PresentationRequirements,
  PresentationRequirementsCandidates,
  PresentationRequirementsSelections,
  PresentationResearchRequirements,
  PresentationRequirementsTemplateRecommendation,
} from "../../api/types";
import { IMAGE_RESEARCH_ENABLED } from "../deck-generation/featureFlags";

export function createEmptyRequirementsSelections(): PresentationRequirementsSelections {
  return {
    slide_count: null,
    output_language: null,
    visual_style_preset: null,
  };
}

export function createEmptyPresentationRequirements(): PresentationRequirements {
  return {
    version: 1,
    status: "empty",
    source: null,
    candidates: {
      slide_count: [], output_language: [],
    },
    selections: createEmptyRequirementsSelections(),
    template_recommendation: null,
    research: createEmptyPresentationResearchRequirements(),
    updated_at: null,
    confirmed_at: null,
  };
}

/**
 * 图片搜索被关闭时，把推荐结果里的图片选项强制改写为不启用。
 * 需求页的图片开关也据此变为不可用，避免用户看到一个无效的选择。
 */
export function applyImageResearchFlag(
  research: PresentationResearchRequirements,
): PresentationResearchRequirements {
  if (IMAGE_RESEARCH_ENABLED) return research;
  return { ...research, images: { ...research.images, recommended: false, enabled: false } };
}

export function createEmptyPresentationResearchRequirements(): PresentationResearchRequirements {
  return {
    web: { recommended: null, reason: "", enabled: null },
    images: { recommended: null, reason: "", enabled: null },
  };
}

export function createRequirementsDraft(
  brief: string,
  candidates: PresentationRequirementsCandidates,
  visualStylePreset: PresentationRequirementsSelections["visual_style_preset"] = null,
  research: PresentationResearchRequirements = createEmptyPresentationResearchRequirements(),
  templateRecommendation: PresentationRequirementsTemplateRecommendation | null = null,
): PresentationRequirements {
  return {
    version: 1,
    status: "draft",
    source: { brief },
    candidates,
    selections: {
      slide_count: candidates.slide_count[0] ?? null,
      output_language: candidates.output_language[0] ?? null,
      visual_style_preset: visualStylePreset,
    },
    template_recommendation: templateRecommendation,
    research,
    updated_at: new Date().toISOString(),
    confirmed_at: null,
  };
}

export function createManualRequirementsDraft(brief: string): PresentationRequirements {
  return createRequirementsDraft(brief, {
    slide_count: [],
    output_language: [],
  }, null, {
    web: { recommended: false, reason: "", enabled: false },
    images: { recommended: false, reason: "", enabled: false },
  });
}

export function requirementsAreComplete(requirements: PresentationRequirements) {
  return requirementsAreCompleteWithoutVisualSelection(requirements) &&
    requirements.selections.visual_style_preset != null;
}

export function requirementsAreCompleteWithoutVisualSelection(requirements: PresentationRequirements) {
  const { slide_count, output_language } = requirements.selections;
  return Number.isInteger(slide_count) && Number(slide_count) > 0 &&
    Boolean(output_language?.trim()) &&
    typeof requirements.research.web.enabled === "boolean" &&
    typeof requirements.research.images.enabled === "boolean" &&
    requirements.selections.output_language?.trim().toLowerCase() !== "auto";
}

/** A deferred automatic recommendation must be explicitly resolved before confirmation. */
export function requiresTemplateRecommendationChoice(requirements: PresentationRequirements): boolean {
  return requirements.template_recommendation?.selection_required === true
    && requirements.selections.visual_style_preset === null;
}

export function confirmedRequirementsAllowOutline(
  requirements: Pick<PresentationRequirements, "status"> | null | undefined,
) {
  return requirements?.status === "confirmed";
}

export function requirementsOwnedRecoveryStage(
  requirements: Pick<PresentationRequirements, "status">,
): "brief" | "requirements" | null {
  if (requirements.status === "empty") return "brief";
  if (requirements.status === "draft") return "requirements";
  return null;
}
