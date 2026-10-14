export function isPageHtmlGenerationSystemPromptEnabled(
  value: unknown = import.meta.env?.VITE_HTML_GENERATION_SYSTEM_PROMPT_ENABLED,
): boolean {
  return value === "true";
}
