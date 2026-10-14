import { requirementsForPrompt } from "./requirementsFormatting";
import type { LlmCompleteInput } from "../runtime/hostRuntime";
import type { PresentationRequirements, SharedResearchContextResult, WorkspaceOutline } from "../api/types";
import type { AiOperationLogContext } from "./interactionLog";

export interface GenerateVisualRhythmInput {
  brief: string;
  requirements: PresentationRequirements;
  outline: WorkspaceOutline;
  styleGuide: string;
  research: SharedResearchContextResult;
  refinementRequest?: string;
  currentRhythm?: string;
  logContext?: AiOperationLogContext;
}

export interface GeneratePageVisualPlanInput {
  brief: string;
  requirements: PresentationRequirements;
  outline: WorkspaceOutline;
  pageId: string;
  pageIndex: number;
  styleGuide: string;
  visualRhythm: string;
  research: SharedResearchContextResult;
  currentPlan?: string;
  refinementRequest?: string;
  logContext?: AiOperationLogContext;
}

function markdownRequest(system: string, user: string): LlmCompleteInput {
  return {
    messages: [
      { role: "system", content: { type: "text", text: system } },
      { role: "user", content: { type: "text", text: user } },
    ],
  };
}

export function buildVisualRhythmLlmRequest(input: GenerateVisualRhythmInput): LlmCompleteInput {
  return markdownRequest(
    [
      "You are a senior presentation narrative and visual director.",
      "Create one complete Markdown document named visual-rhythm.md for a PPT deck.",
      "Define deck-level visual rhythm: page-by-page focal type, density, brightness, reading direction, and deliberate differences between adjacent pages.",
      "This is not a page layout, not TSX, and not a replacement for the Workspace Style Guide.",
      "Return only Markdown. Do not use JSON, code fences, or commentary.",
      "Do not invent facts, claims, names, dates, numbers, sources, or image contents.",
    ].join("\n"),
    [
      "Create the visual rhythm for this deck.",
      `Brief: ${input.brief.trim()}`,
      `Presentation Requirements: ${JSON.stringify(requirementsForPrompt(input.requirements))}`,
      `Confirmed Outline: ${JSON.stringify(input.outline)}`,
      `Workspace Style Guide:\n${input.styleGuide.trim()}`,
      `Shared Research Web Summary:\n${input.research.web_summary.trim()}`,
      `Shared Research Image Catalog:\n${JSON.stringify(input.research.image_catalog)}`,
      `Current Visual Rhythm:\n${input.currentRhythm?.trim() ?? ""}`,
      `Deck Refinement Request:\n${input.refinementRequest?.trim() ?? ""}`,
    ].join("\n\n"),
  );
}

export function buildPageVisualPlanLlmRequest(input: GeneratePageVisualPlanInput): LlmCompleteInput {
  return markdownRequest(
    [
      "You are a senior presentation designer preparing a page-authoring brief.",
      "Create one complete Markdown Page Visual Plan for exactly one page.",
      "Translate the page intent into a concrete focal object, content-to-visual mapping, hierarchy, composition, asset plan, adjacent-page contrast, and implementation fallback.",
      "This is not TSX and must not rewrite the outline or style guide.",
      "Return only Markdown. Do not use JSON, code fences, or commentary.",
      "Do not invent facts, claims, names, dates, numbers, sources, or image contents.",
    ].join("\n"),
    [
      `Page ID: ${input.pageId}`,
      `Page number: ${input.pageIndex + 1} / ${input.outline.items.length}`,
      `Brief: ${input.brief.trim()}`,
      `Presentation Requirements: ${JSON.stringify(requirementsForPrompt(input.requirements))}`,
      `Confirmed Outline: ${JSON.stringify(input.outline)}`,
      `Workspace Style Guide:\n${input.styleGuide.trim()}`,
      `Deck Visual Rhythm:\n${input.visualRhythm.trim()}`,
      `Shared Research Web Summary:\n${input.research.web_summary.trim()}`,
      `Shared Research Image Catalog:\n${JSON.stringify(input.research.image_catalog)}`,
      `Current Page Visual Plan:\n${input.currentPlan?.trim() ?? ""}`,
      `Page or Deck Refinement Request:\n${input.refinementRequest?.trim() ?? ""}`,
    ].join("\n\n"),
  );
}
