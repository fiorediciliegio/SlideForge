import { buildPageLayoutRewritePrompt, loadPageLayoutRewriteContext } from "../deck-generation/pageLayoutRewrite";
import type { Locale } from "../../i18n/messages";
import { availableOutlineImages } from "../outline/images";
import type { AgentClient } from "../../agent/agentClient";
import { HTML_GENERATION_SYSTEM_PROMPT } from "../../agent/agentClient";
import type { AiClient } from "../../ai/aiClient";
import type { AiInteractionLogger } from "../../ai/interactionLog";
import type { PptBackend } from "../../api/pptBackend";
import type { PageRegenerationBatch } from "../../api/pageRegenerationTypes";
import type { WorkspaceOutline, WorkspaceOutlineItem, WorkspaceResult } from "../../api/types";
import { authoringDeckFromConfirmedOutline } from "../deck-generation/deckGenerationStartArtifacts";
import { buildPageHtmlPrompt } from "../deck-generation/htmlPrompts";
import { preparePageImageAttachments, type PreparedPageImages } from "../deck-generation/pageImageAttachments";
import { prepareSelectedImageDescriptions, type ImageDescriptionProgress } from "../deck-generation/prepareImageDescriptions";
import { isPageHtmlGenerationSystemPromptEnabled } from "../deck-generation/htmlGenerationConfig";
import { resolveWorkspaceTemplateReference } from "../deck-generation/templateReferenceResolver";

export function validRegenerationInput(count: number, outline: WorkspaceOutlineItem): boolean {
  return validAlternativeCount(count)
    && [outline.title, outline.content].every((value) => typeof value === "string" && Boolean(value.trim()));
}

export function validAlternativeCount(count: number): boolean {
  return Number.isInteger(count) && count >= 1 && count <= 10;
}

export function editedRegenerationOutline(original: WorkspaceOutlineItem, title: string, content: string): WorkspaceOutlineItem {
  return {
    ...original, title: title.trim(), content,
    ...(title.trim() !== original.title ? { title_segments: undefined } : {}),
    ...(content !== original.content ? { analysis: undefined } : {}),
  };
}

export async function generatePageAlternatives(input: {
  backend: PptBackend; agent: AgentClient; ai: AiClient;
  workspace: WorkspaceResult; outline: WorkspaceOutlineItem; count: number;
  logger?: AiInteractionLogger | null;
  mode?: "regenerate" | "beautify"; locale?: Locale;
  onImagePreparation?: (progress: ImageDescriptionProgress) => void;
  onBatch: (batch: PageRegenerationBatch) => void;
}): Promise<PageRegenerationBatch> {
  if (!(input.mode === "beautify" ? validAlternativeCount(input.count) : validRegenerationInput(input.count, input.outline))) throw new Error("PAGE_REGENERATION_INVALID_COUNT");
  const workspaceDir = input.workspace.workspace_dir;
  const ownerId = crypto.randomUUID();
  const original = input.workspace.outline as WorkspaceOutline;
  const outline = { ...original, items: original.items.map((page) => page.page_id === input.outline.page_id ? input.outline : page) };
  const page = authoringDeckFromConfirmedOutline(outline).pages.find((item) => item.page_id === input.outline.page_id);
  if (!page) throw new Error("PAGE_REGENERATION_PAGE_NOT_FOUND");
  const beautify = input.mode === "beautify";
  let prompt = "";
  let referencePath = "";
  let preparedPageImages: PreparedPageImages | undefined;
  if (!beautify) {
    const selections = await input.backend.getWorkspaceAestheticReferenceSelections({ workspace_dir: workspaceDir });
    const reference = await resolveWorkspaceTemplateReference({
      backend: input.backend, workspaceDir, selectedPath: selections.pages[page.page_id]?.path ?? "",
      selectReference: (candidates) => input.ai.selectDominantAestheticReference({
        target: "page", brief: input.workspace.requirements.source?.brief ?? "", requirements: input.workspace.requirements,
        outline, page: input.outline, candidates,
      }),
    });
    const master = page.page_type === "cover" ? null : await input.backend.getWorkspaceVisualMasterHtml({ workspace_dir: workspaceDir });
    const research = await prepareSelectedImageDescriptions({ backend: input.backend, agent: input.agent,
      workspaceDir, locale: input.locale ?? "zh", logger: input.logger, runKey: ownerId,
      context: await input.backend.getSharedResearchContext({ workspace_dir: workspaceDir }),
      selectedImageIds: input.outline.selected_image_ids ?? [], onProgress: input.onImagePreparation,
    });
    const images = availableOutlineImages(research);
    preparedPageImages = await preparePageImageAttachments({ backend: input.backend, workspaceDir,
      selectedImageIds: input.outline.selected_image_ids ?? [], availableImages: images });
    prompt = buildPageHtmlPrompt({ aspectRatio: input.workspace.requirements.selections.aspect_ratio, outline, page, preparedPageImages, visualMasterHtml: master?.content ?? null, referenceHtml: reference.html });
    referencePath = reference.path;
  }
  const batch = await input.backend.pageRegeneration({ action: "create", workspace_dir: workspaceDir,
    page_id: page.page_id, count: input.count, outline: input.outline, reference_path: referencePath, owner_id: ownerId, mode: input.mode });
  if (!batch) throw new Error("Could not create page alternatives");
  input.onBatch(batch);
  // One immutable input is shared by all independent Sessions in this batch.
  // Await it inside each candidate so preparation failures settle every candidate.
  const context = beautify ? loadPageLayoutRewriteContext({
    page_id: page.page_id,
    source_html: batch.source_html, screenshot_upload: batch.source_screenshot_upload,
  }, input.locale ?? "zh") : Promise.resolve(null);

  // Start all requested Sessions without the main workflow's page scheduler.
  // Each failure is scoped to its own candidate.
  const failures: unknown[] = [];
  let generationSettled = false;
  const generation = Promise.all(batch.candidates.map(async (candidate) => {
    try {
      const source = await context;
      const result = await input.agent.runHtmlGenerationPrompt(source ? buildPageLayoutRewritePrompt(source.html, input.workspace.requirements.selections.aspect_ratio, { global_creation_requirements: original.global_creation_requirements, creation_requirements: original.items[page.index]?.creation_requirements }) : prompt, {
        ...(source ? { attachments: [source.screenshotAttachment] }
          : preparedPageImages?.attachments.length ? { attachments: preparedPageImages.attachments } : {}),
        logContext: input.logger ? {
          logger: input.logger, workspace_dir: workspaceDir, domain: "page_agent", operation: beautify ? "beautify_page_alternative" : "generate_page_alternative",
          operation_id: input.logger.createOperationId("page_agent", beautify ? "beautify_page_alternative" : "generate_page_alternative"),
          page_id: page.page_id, page_index: page.index, provider: "host", runtime_mode: "host",
        } : undefined,
      }, !beautify && isPageHtmlGenerationSystemPromptEnabled() ? HTML_GENERATION_SYSTEM_PROMPT : undefined);
      await input.backend.pageRegeneration({ action: "submit", workspace_dir: workspaceDir, batch_id: batch.id,
        candidate_id: candidate.id, content: result.html });
    } catch (error) {
      try {
        await input.backend.pageRegeneration({ action: "fail", workspace_dir: workspaceDir, batch_id: batch.id,
          candidate_id: candidate.id, error: error instanceof Error ? error.message : String(error) });
      } catch (failure) { failures.push(failure); }
    }
  })).finally(() => { generationSettled = true; });
  let latest = batch;
  let pollingFailures = 0;
  while (!generationSettled || latest.status === "running") {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      latest = await input.backend.pageRegeneration({ action: "get", workspace_dir: workspaceDir, batch_id: batch.id, owner_id: ownerId }) ?? latest;
      pollingFailures = 0;
      input.onBatch(latest);
    } catch (error) {
      pollingFailures++;
      if (generationSettled && pollingFailures >= 3) throw error;
    }
    if (generationSettled && failures.length) throw failures[0];
  }
  await generation;
  return latest;
}
