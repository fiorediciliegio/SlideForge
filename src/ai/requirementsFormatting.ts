import { normalizeSlideAspectRatio } from "../slideFormat";
import type { PresentationRequirements } from "../api/types";

export function formatResearchRequirements(requirements: PresentationRequirements): string {
  const selections = requirements.selections;
  const preset = selections.visual_style_preset;
  return [
    `页数：${selections.slide_count ?? "未提供"}`,
    `输出语言：${selections.output_language ?? "未提供"}`,
    `页面比例：${normalizeSlideAspectRatio(selections.aspect_ratio)}`,
    `视觉效果：${preset ? `${preset.name}。${preset.description}` : "未提供"}`,
  ].join("\n");
}

export function formatConfirmedRequirementsForPrompt(requirements: PresentationRequirements): string {
  const preset = requirements.selections.visual_style_preset;
  return [
    formatWebResearchRequirements(requirements),
    "",
    `视觉风格预设：${preset?.name ?? "未指定"}`,
    ...(preset ? [`预设说明：${preset.description}`] : []),
    "",
    `Web 搜索：${requirements.research?.web.enabled ? "已开启" : "未开启"}`,
    `图片搜索：${requirements.research?.images.enabled ? "已开启" : "未开启"}`,
  ].join("\n");
}

/** 网页研究仅接收生成规格，原始需求由调用方单独传入。 */
export function formatWebResearchRequirements(requirements: PresentationRequirements): string {
  if (requirements.status !== "confirmed" || !requirements.source) {
    throw new Error("Confirmed Presentation Requirements are required for prompt formatting.");
  }
  return [
    `目标页数：${requirements.selections.slide_count ?? "未提供"}`,
    `输出语言：${requirements.selections.output_language ?? "未提供"}`,
    `页面比例：${normalizeSlideAspectRatio(requirements.selections.aspect_ratio)}`,
  ].join("\n");
}

/** 显式投影需求协议，防止旧对象的内容目标随 JSON 整体序列化进入提示词。 */
export function requirementsForPrompt(requirements: PresentationRequirements): PresentationRequirements {
  return {
    version: requirements.version,
    status: requirements.status,
    source: requirements.source,
    candidates: {
      slide_count: requirements.candidates.slide_count,
      output_language: requirements.candidates.output_language,
    },
    selections: {
      slide_count: requirements.selections.slide_count,
      output_language: requirements.selections.output_language,
      ...(requirements.selections.aspect_ratio === undefined ? {} : { aspect_ratio: normalizeSlideAspectRatio(requirements.selections.aspect_ratio) }),
      ...(requirements.selections.visual_style_preset !== undefined
        ? { visual_style_preset: requirements.selections.visual_style_preset }
        : {}),
    },
    research: requirements.research,
    updated_at: requirements.updated_at,
    confirmed_at: requirements.confirmed_at,
  };
}
