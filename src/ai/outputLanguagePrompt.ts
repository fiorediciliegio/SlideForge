import type { LlmCompleteInput } from "../runtime/hostRuntime";

export const OUTPUT_LANGUAGE_JSON_SHAPE = `{
  "output_language": "<language>"
}`;

export function buildOutputLanguageSystemPrompt() {
  return [
    "You are a presentation output-language specialist.",
    "Your task is to determine the concrete language for the final presentation from the user's Brief.",
    "Return exactly one JSON object with one field: output_language.",
    "",
    "Language decision rules, in priority order:",
    "- If the user explicitly says the presentation or PPT should be in a specific language, use that language.",
    "- If the user does not explicitly specify a presentation language, use the primary language of the Brief's natural-language instructions and narrative.",
    "- Determine the primary language from meaningful words, sentences, and explanatory paragraphs, not from isolated localized labels.",
    "- Ignore isolated taxonomy values such as audience, use-case, or industry labels when they are written in another language.",
    "- Ignore proper nouns, brand names, product names, quoted titles, URLs, file paths, code, numbers, and punctuation when determining the primary language.",
    "- For Latin-script languages, judge primarily by meaningful word count and the language of the instruction paragraphs.",
    "- For Chinese, Japanese, Korean, and other character-based languages, judge primarily by meaningful character count and the language of the instruction paragraphs.",
    "- A few words or labels in another language must not override the language used by most of the Brief's instructions and narrative.",
    "- Always return one concrete language. Never return auto, ambiguous, unknown, or a language choice list.",
    "",
    "Return JSON only with this exact shape:",
    OUTPUT_LANGUAGE_JSON_SHAPE,
    "Do not include Markdown, code fences, reasoning, comments, or any extra fields.",
  ].join("\n");
}

export function buildOutputLanguageUserPrompt(brief: string) {
  return [
    "Determine the output language for the final presentation from the Brief below.",
    "",
    "<brief>",
    brief,
    "</brief>",
    "Return JSON only.",
  ].join("\n");
}

export function buildOutputLanguageRequest(brief: string): LlmCompleteInput {
  return {
    messages: [
      {
        role: "system",
        content: { type: "text", text: buildOutputLanguageSystemPrompt() },
      },
      {
        role: "user",
        content: { type: "text", text: buildOutputLanguageUserPrompt(brief) },
      },
    ],
  };
}
