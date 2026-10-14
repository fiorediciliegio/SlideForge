import { mainWorkflowAttachmentContext } from "./attachmentBriefPolicy";
import type { LlmCompleteInput } from "../runtime/hostRuntime";
import type { AttachmentContext } from "../api/types";
import {
  buildRequirementsRepairPrompt,
  buildRequirementsSystemPrompt,
  buildRequirementsUserPrompt,
} from "./requirementsPromptMessages";

export function buildPresentationRequirementsRequest(
  brief: string,
  outputLanguage: string,
  attachmentContext?: AttachmentContext | null,
): LlmCompleteInput {
  attachmentContext = mainWorkflowAttachmentContext(attachmentContext);
  const hasAttachmentContext = Boolean(attachmentContext?.attachment_context?.length);
  return {
    messages: [
      {
        role: "system",
        content: { type: "text", text: buildRequirementsSystemPrompt(outputLanguage, hasAttachmentContext) },
      },
      {
        role: "user",
        content: { type: "text", text: buildRequirementsUserPrompt(brief, outputLanguage, attachmentContext) },
      },
    ],
  };
}

export function buildPresentationRequirementsRepairRequest(
  previousRequest: LlmCompleteInput,
  rawResponse: string,
  validationErrors: string[],
  outputLanguage: string,
): LlmCompleteInput {
  return {
    ...previousRequest,
    messages: [
      ...previousRequest.messages,
      {
        role: "assistant",
        content: { type: "text", text: rawResponse },
      },
      {
        role: "user",
        content: {
          type: "text",
          text: buildRequirementsRepairPrompt(validationErrors, outputLanguage),
        },
      },
    ],
  };
}
