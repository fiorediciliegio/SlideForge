/** 用户指令独立于正文和视觉参考，仅传全局及当前页要求。 */
export function creationRequirementsPrompt(globalRequirements?: string, pageRequirements?: string): string[] {
  if (!globalRequirements?.trim() && !pageRequirements?.trim()) return [];
  return [
    "## 用户创作要求",
    "以下是用户明确的制作指令，不是页面正文。准确遵守数字、否定词、适用范围和例外；优先于模板、视觉母版和默认排版建议。本页明确例外只覆盖对应全局要求，其余全局要求仍有效。",
    ...(globalRequirements?.trim() ? ["### 全局创作要求", globalRequirements] : []),
    ...(pageRequirements?.trim() ? ["### 本页创作要求", pageRequirements] : []),
  ];
}
