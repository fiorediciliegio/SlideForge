import { requirementsForPrompt } from "./requirementsFormatting";
import type { LlmCompleteInput } from "../runtime/annaRuntime";
import type {
  DeckRefinementOutlineOperation,
  DeckRefinementPlan,
  PlanDeckRefinementInput,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

function assertOnlyKeys(record: Record<string, unknown>, keys: string[], path: string, errors: string[]) {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) errors.push(`${path} has unsupported field "${key}"`);
  }
}

function cleanOperation(value: unknown, index: number, errors: string[]): DeckRefinementOutlineOperation | null {
  if (!isRecord(value)) {
    errors.push(`operations[${index}] must be an object`);
    return null;
  }
  assertOnlyKeys(value, ["op", "page_id", "page_type", "title", "content", "reason"], `operations[${index}]`, errors);
  const op = cleanString(value.op);
  const pageId = cleanString(value.page_id);
  const reason = cleanString(value.reason);
  if (op === "keep" || op === "delete") {
    if (!pageId) errors.push(`operations[${index}].page_id is required for ${op}`);
    if (!reason) errors.push(`operations[${index}].reason must be non-empty`);
    return { op, page_id: pageId, reason } as DeckRefinementOutlineOperation;
  }
  if (op === "update" || op === "add") {
    if (op === "update" && !pageId) errors.push(`operations[${index}].page_id is required for update`);
    const title = cleanString(value.title);
    const pageType = cleanString(value.page_type);
    const content = cleanString(value.content);
    if (pageType !== "cover" && pageType !== "standard") errors.push(`operations[${index}].page_type must be cover or standard`);
    if (!title || /\r|\n/u.test(title)) errors.push(`operations[${index}].title must be one non-empty line`);
    if (!content) errors.push(`operations[${index}].content must be a non-empty string`);
    if (!reason) errors.push(`operations[${index}].reason must be non-empty`);
    return op === "update"
      ? { op, page_id: pageId, page_type: pageType as "cover" | "standard", title, content, reason }
      : { op, page_type: pageType as "cover" | "standard", title, content, reason };
  }
  errors.push(`operations[${index}].op must be keep, update, add, or delete`);
  return null;
}

export class DeckRefinementPlanningValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid Deck Refinement Planning result: ${errors.join("; ")}`);
    this.name = "DeckRefinementPlanningValidationError";
  }
}

export function normalizeDeckRefinementPlan(value: unknown, input: Pick<PlanDeckRefinementInput, "outline" | "visualStylePresetSelected">): DeckRefinementPlan {
  const errors: string[] = [];
  if (!isRecord(value)) throw new DeckRefinementPlanningValidationError(["root must be an object"]);
  const stylePresetSelected = input.visualStylePresetSelected === true;
  assertOnlyKeys(value, stylePresetSelected
    ? ["route", "title", "output_language_change", "visual_rhythm_action", "persistent_elements_action", "operations", "reason"]
    : ["route", "title", "output_language_change", "style_guide_change", "visual_rhythm_action", "persistent_elements_action", "operations", "reason"], "root", errors);
  const route = cleanString(value.route);
  if (route !== "proceed" && route !== "no_op") errors.push('route must be "proceed" or "no_op"');
  const title = cleanString(value.title);
  if (!title) errors.push("title must be non-empty");

  const languageRecord = isRecord(value.output_language_change) ? value.output_language_change : {};
  assertOnlyKeys(languageRecord, ["changed", "output_language", "reason"], "output_language_change", errors);
  const languageChanged = languageRecord.changed === true;
  const outputLanguage = cleanString(languageRecord.output_language);
  if (languageChanged && !outputLanguage) errors.push("output_language_change.output_language is required when changed is true");

  let styleAction: "preserve" | "regenerate" = "preserve";
  let styleReason = "Visual Style Preset Style Guide is immutable.";
  if (!stylePresetSelected) {
    const styleRecord = isRecord(value.style_guide_change) ? value.style_guide_change : {};
    assertOnlyKeys(styleRecord, ["action", "reason"], "style_guide_change", errors);
    const rawStyleAction = cleanString(styleRecord.action);
    if (rawStyleAction !== "preserve" && rawStyleAction !== "regenerate") {
      errors.push('style_guide_change.action must be "preserve" or "regenerate"');
    } else {
      styleAction = rawStyleAction;
    }
    styleReason = cleanString(styleRecord.reason);
    if (!styleReason) errors.push("style_guide_change.reason must be non-empty");
  }

  const persistentElementsAction = cleanString(value.persistent_elements_action);
  if (persistentElementsAction !== "preserve" && persistentElementsAction !== "revise") {
    errors.push('persistent_elements_action must be "preserve" or "revise"');
  }
  const visualRhythmAction = cleanString(value.visual_rhythm_action) || "preserve";
  if (visualRhythmAction !== "preserve" && visualRhythmAction !== "rewrite") errors.push('visual_rhythm_action must be "preserve" or "rewrite"');

  const rawOperations = Array.isArray(value.operations) ? value.operations : [];
  if (route === "proceed" && rawOperations.length === 0) errors.push("proceed requires at least one operation");
  if (route === "no_op" && rawOperations.length > 0) errors.push("no_op must return an empty operations array");
  const operations = rawOperations.map((operation, index) => cleanOperation(operation, index, errors)).filter((operation): operation is DeckRefinementOutlineOperation => Boolean(operation));

  const existingIds = input.outline.items.map((item) => item.page_id).filter((id): id is string => Boolean(id));
  const existingSet = new Set(existingIds);
  const seenExisting = new Set<string>();
  for (const operation of operations) {
    if (operation.op === "add") continue;
    if (!existingSet.has(operation.page_id)) errors.push(`operation references unknown page_id "${operation.page_id}"`);
    if (seenExisting.has(operation.page_id)) errors.push(`page_id "${operation.page_id}" appears more than once`);
    seenExisting.add(operation.page_id);
  }
  if (route === "proceed") {
    for (const pageId of existingIds) {
      if (!seenExisting.has(pageId)) errors.push(`missing operation for existing page_id "${pageId}"`);
    }
    if (operations.filter((operation) => operation.op !== "delete").length === 0) errors.push("at least one page must remain after reconciliation");
  }
  if (languageChanged && operations.some((operation) => operation.op === "keep")) {
    errors.push("output language changes require update operations for retained pages");
  }
  if (route === "no_op" && (languageChanged || (!stylePresetSelected && styleAction !== "preserve") || visualRhythmAction !== "preserve" || persistentElementsAction !== "preserve" || title !== input.outline.title)) {
    errors.push("no_op cannot change title, output language, or Style Guide");
  }
  const reason = cleanString(value.reason);
  if (!reason) errors.push("reason must be non-empty");
  if (errors.length > 0) throw new DeckRefinementPlanningValidationError(errors);
  return {
    route: route as DeckRefinementPlan["route"],
    title,
    output_language_change: {
      changed: languageChanged,
      output_language: languageChanged ? outputLanguage : undefined,
      reason: cleanString(languageRecord.reason) || undefined,
    },
    style_guide_change: { action: styleAction, reason: styleReason },
    visual_rhythm_action: visualRhythmAction as "preserve" | "rewrite",
    persistent_elements_action: persistentElementsAction as "preserve" | "revise",
    operations,
    reason,
  };
}

export function buildDeckRefinementPlanningRequest(input: PlanDeckRefinementInput): LlmCompleteInput {
  const expectedShape = {
    route: "proceed",
    title: input.outline.title,
    output_language_change: { changed: false, output_language: "", reason: "" },
    persistent_elements_action: "preserve",
    visual_rhythm_action: "preserve",
    ...(input.visualStylePresetSelected ? {} : { style_guide_change: { action: "preserve", reason: "" } }),
    operations: [
      { op: "keep", page_id: "page-uuid", reason: "" },
      { op: "update", page_id: "page-uuid", page_type: "standard", title: "", content: "", reason: "" },
      { op: "add", page_type: "standard", title: "", content: "", reason: "" },
      { op: "delete", page_id: "page-uuid", reason: "" },
    ],
    reason: "",
  };
  const currentPages = input.outline.items.map((item, index) => ({
    page_id: item.page_id,
    page_type: item.page_type,
    index,
    title: item.title,
    content: item.content,
    creation_requirements: item.creation_requirements,
  }));
  return {
    messages: [
      {
        role: "system",
        content: {
          type: "text",
          text: [
            "You are Deck Refinement Planning for an accepted PPT deck.",
            "Return exactly one JSON object. Do not include markdown, code fences, comments, explanations, or extra text.",
            "Plan the smallest coherent set of changes needed to satisfy the user's Deck Refinement Request.",
            "Preserve explicit global and page creation requirements and locked copy unless the active request explicitly overrides them. These are instructions, not slide text; do not silently rewrite them or add inferred requirements.",
            "Preserve the current deck title, page count, page order, page intents, output language, and shared visual direction unless the user explicitly requests that specific change.",
            "The only mutable deck-level requirement is output language. The final slide count is derived from the reconciled operations.",
            "Return operations in final desired page order. Every existing page must appear exactly once as keep, update, or delete. Add operations may be inserted anywhere.",
            "Keep and update retain the existing page_id. Add does not include page_id; the system allocates it. Delete references an existing page_id.",
            "Use update only when the page's Outline Entry or page content must change. Use keep for unchanged pages unless a global output-language or Style Guide change requires all retained pages to be targeted.",
            "Add, delete, or reorder pages only when the request explicitly asks for page count, structure, sequence, section organization, or narrative-flow changes.",
            "Set persistent_elements_action to revise only when the user explicitly asks to change the deck-wide header, footer, page number, or persistent decoration treatment. Ambiguous requests such as overall polish preserve it.",
            "Set visual_rhythm_action to rewrite only when the user clearly requests a deck-wide change to visual language, composition system, pacing, color expression, or brand presentation. General polish, content edits, and page-local visual requests must preserve it.",
            input.visualStylePresetSelected
              ? "A Visual Style Preset is selected. Do not return style_guide_change. Treat the selected Style Guide as immutable; express shared visual requests through page operations and reasons."
              : "Set style_guide_change.action to regenerate only for an explicit shared visual-direction change. A page-local visual change uses preserve.",
            "Set output_language_change.changed only when the user explicitly asks to change the generated presentation language. When it changes, all retained pages must use update operations.",
            "Do not invent facts, numbers, dates, names, claims, citations, or source-dependent visuals. Use only the provided Workspace material and the user's request.",
            "Page-level reason fields are concise English instructions for Page Authoring. Outline content must use the current or explicitly requested output language.",
            `Expected JSON shape: ${JSON.stringify(expectedShape, null, 2)}`,
          ].join("\n"),
        },
      },
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Plan this Deck Refinement Request using only the following accepted Workspace context.",
            `Locale: ${input.locale}`,
            `Deck Refinement Request: ${input.instruction}`,
            `Brief: ${input.requirements.source?.brief ?? ""}`,
            `Confirmed Presentation Requirements: ${JSON.stringify(requirementsForPrompt(input.requirements))}`,
            `Current Confirmed Outline: ${JSON.stringify({ title: input.outline.title, global_creation_requirements: input.outline.global_creation_requirements ?? "", items: currentPages })}`,
            `Current Workspace Style Guide: ${input.currentStyleGuide || ""}`,
            `Current Deck Visual Rhythm: ${input.currentVisualRhythm || ""}`,
            "Return one complete plan, not a patch.",
          ].join("\n"),
        },
      },
    ],
  };
}

export function buildDeckRefinementPlanningRepairRequest(
  previousRequest: LlmCompleteInput,
  rawResponse: string,
  errors: string[],
): LlmCompleteInput {
  return {
    ...previousRequest,
    messages: [
      ...previousRequest.messages,
      { role: "assistant", content: { type: "text", text: rawResponse } },
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "The previous Deck Refinement Planning response failed deterministic validation.",
            "Return one complete corrected JSON object. Do not return a partial patch.",
            "Validation errors:",
            ...errors.map((error) => `- ${error}`),
            "Preserve all valid decisions from the previous response while correcting every listed error.",
            "Do not include markdown, code fences, explanations, or extra text.",
          ].join("\n"),
        },
      },
    ],
  };
}
