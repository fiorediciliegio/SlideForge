import { normalizeSlideAspectRatio } from "../slideFormat";
import type { LlmCompleteInput } from "../runtime/hostRuntime";
import type {
  AttachmentContext,
  PresentationRequirements,
} from "../api/types";
import type { OutlineDetail } from "../data/mockDeck";
import {
  buildGenerateOutlineUserPrompt,
  buildOutlineRepairPrompt,
  buildOutlineSystemPrompt,
  buildReviseOutlineUserPrompt,
} from "./outlinePromptMessages";
import { formatAttachmentSourcesForPrompt } from "./attachmentSourceText";

interface GenerateOutlinePromptInput {
  requirements: PresentationRequirements;
  attachmentContext?: AttachmentContext | null;
  webResearchSummary?: string;
}

interface ReviseOutlinePromptInput {
  global_creation_requirements?: string;
  title?: string;
  outline: OutlineDetail[];
  feedback: string;
  requirements: PresentationRequirements;
  attachmentContext?: AttachmentContext | null;
  webResearchSummary?: string;
}

function buildConfirmedRequirementsInput(requirements: PresentationRequirements) {
  if (requirements.status !== "confirmed" || !requirements.source) {
    throw new Error("Confirmed Presentation Requirements are required for Outline Creation.");
  }
  return {
    brief: requirements.source.brief,
    requirements: {
      slide_count: requirements.selections.slide_count,
      output_language: requirements.selections.output_language,
      aspect_ratio: normalizeSlideAspectRatio(requirements.selections.aspect_ratio),
      visual_style_preset: requirements.selections.visual_style_preset ?? null,
    },
  };
}

function buildGenerateUserPrompt(input: GenerateOutlinePromptInput): string {
  if (input.requirements.status !== "confirmed" || !input.requirements.source) {
    throw new Error("Confirmed Presentation Requirements are required for Outline Creation.");
  }
  return buildGenerateOutlineUserPrompt({
    slideCount: input.requirements.selections.slide_count!,
    brief: input.requirements.source.brief,
    confirmedRequirementsText: JSON.stringify(buildConfirmedRequirementsInput(input.requirements)),
    attachmentSourcesText: formatAttachmentSourcesForPrompt(input.attachmentContext),
    webResearchSummary: input.webResearchSummary?.trim() ?? "",
  });
}

function buildReviseUserPrompt(input: ReviseOutlinePromptInput): string {
  if (input.requirements.status !== "confirmed" || !input.requirements.source) {
    throw new Error("Confirmed Presentation Requirements are required for Outline Revision.");
  }
  return buildReviseOutlineUserPrompt({
    brief: input.requirements.source.brief,
    confirmedRequirementsText: JSON.stringify(buildConfirmedRequirementsInput(input.requirements)),
    attachmentSourcesText: formatAttachmentSourcesForPrompt(input.attachmentContext),
    title: input.title,
    feedback: input.feedback,
    outlineJson: JSON.stringify({
      global_creation_requirements: input.global_creation_requirements ?? "",
      items: input.outline.map((item, index) => ({
        page_number: index + 1,
        page_type: item.page_type,
        title: item.title,
        content: item.content,
        ...(item.creation_requirements ? { creation_requirements: item.creation_requirements } : {}),
      })),
    }),
    webResearchSummary: input.webResearchSummary?.trim() ?? "",
  });
}

export function buildGenerateOutlineLlmRequest(
  input: GenerateOutlinePromptInput
): LlmCompleteInput {
  return {
    messages: [
      {
        role: "system",
        content: {
          type: "text",
          text: buildOutlineSystemPrompt(),
        },
      },
      {
        role: "user",
        content: {
          type: "text",
          text: buildGenerateUserPrompt(input),
        },
      },
    ],
  };
}

export function buildReviseOutlineLlmRequest(
  input: ReviseOutlinePromptInput
): LlmCompleteInput {
  return {
    messages: [
      {
        role: "system",
        content: {
          type: "text",
          text: buildOutlineSystemPrompt({ mode: "revise" }),
        },
      },
      {
        role: "user",
        content: {
          type: "text",
          text: buildReviseUserPrompt(input),
        },
      },
    ],
  };
}

export function buildOutlineRepairRequest(
  previousRequest: LlmCompleteInput,
  rawResponse: string,
  errors: string[],
): LlmCompleteInput {
  return {
    ...previousRequest,
    messages: [
      ...previousRequest.messages,
      { role: "assistant", content: { type: "text", text: rawResponse } },
      { role: "user", content: { type: "text", text: buildOutlineRepairPrompt(errors, "请修正上一轮 JSON，并保持当前阶段的输出结构；generation_notes 必须是字符串。") } },
    ],
  };
}
