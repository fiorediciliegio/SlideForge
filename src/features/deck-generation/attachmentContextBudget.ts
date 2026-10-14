import type { AttachmentBrief, AttachmentContext } from "../../api/types";

export const ATTACHMENT_CONTEXT_TOTAL_TOKEN_LIMIT = 64_000;

/** Must remain equivalent to the fixed preflight estimator in ppt-engine. */
export function estimateAttachmentContextTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  let symbols = 0;
  for (const char of text) {
    if (/\s/u.test(char)) continue;
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk += 1;
    else if (/[A-Za-z0-9_]/.test(char)) ascii += 1;
    else symbols += 1;
  }
  return cjk + Math.ceil(ascii / 4) + Math.ceil(symbols / 2);
}

export function buildAttachmentContextForBudget(input: {
  userBrief: string;
  briefs: AttachmentBrief[];
}): AttachmentContext {
  return {
    version: 1,
    user_brief: input.userBrief,
    attachment_context: input.briefs,
    updated_at: "1970-01-01T00:00:00.000Z",
  };
}

/**
 * The attachment routing decision is intentionally independent of Requirements,
 * Outline, and Research. It measures the user brief plus the structured
 * attachment context exactly once, before any later-generation work begins.
 */
export function estimateAttachmentContextInputTokens(input: {
  userBrief: string;
  briefs: AttachmentBrief[];
}): number {
  return estimateAttachmentContextTokens(JSON.stringify(buildAttachmentContextForBudget(input)));
}
