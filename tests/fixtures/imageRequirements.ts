import type { PresentationRequirements } from "../../src/api/types";

export function confirmedRequirements(): PresentationRequirements {
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
