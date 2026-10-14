import type { WorkspaceOutline, WorkspaceSettings } from "../api/types";

export const AUTO_OUTPUT_LANGUAGE = "auto";
export const DEFAULT_OUTPUT_LANGUAGE_OPTIONS = ["auto", "中文", "English"] as const;

export function normalizeOutputLanguage(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : AUTO_OUTPUT_LANGUAGE;
}

export function readSettingOutputLanguage(setting?: WorkspaceSettings | Record<string, unknown>): string {
  return normalizeOutputLanguage(setting?.output_language);
}

export function readOutlineOutputLanguage(
  outline: Pick<WorkspaceOutline, "output_language" | "source">
): string {
  const outlineLanguage = normalizeOutputLanguage(outline.output_language);
  if (outlineLanguage !== AUTO_OUTPUT_LANGUAGE) {
    return outlineLanguage;
  }

  const settingLanguage = readSettingOutputLanguage(outline.source?.setting);
  if (settingLanguage !== AUTO_OUTPUT_LANGUAGE) {
    return settingLanguage;
  }

  return "中文";
}

/**
 * 研究材料结构化文案（研究批次标题/状态等会写入 web-summary.md 并进入
 * 后续 prompt 的文本）的语言：跟随 PPT 输出语言（OutputLanguage），
 * 绝不跟随界面语言（UiLocale）。非中文一律英文——英文对 AI 是中性语言，
 * 避免日文界面生成德文 PPT 时研究材料混入日文（leader 反馈 #1）。
 */
export type ResearchTextLocale = "zh" | "en";

export function resolveResearchTextLocale(outputLanguage: string): ResearchTextLocale {
  return /中文|汉语|中國語|chinese|^zh([-_]|$)/i.test(outputLanguage.trim()) ? "zh" : "en";
}
