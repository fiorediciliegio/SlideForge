import { researchProgressForPersistence } from "../../api/researchProgress";
import type { PageProgress, WorkspaceOutline } from "../../api/types";
import { outlineDetailToText } from "../../data/mockDeck";
import { generationText } from "./messages";
import { emit } from "./progressProjection";
import type { AuthoringDeck, ResearchDiscoveryProgress, RunDeckGenerationInput } from "./types";
import { getAttemptLimits } from "./settings";
import { recordDeckRecovery, throwIfCancelled } from "./runtimeSupport";
import { buildVisualMasterHtmlPrompt } from "./htmlPrompts";
import { resolveWorkspaceTemplateReference } from "./templateReferenceResolver";

export function authoringDeckFromConfirmedOutline(outline: WorkspaceOutline): AuthoringDeck {
  if (outline.status !== "confirmed" || outline.items.some((item) => !item.page_id)) {
    throw new Error("Confirmed Outline entries must all own page_id before Deck Generation");
  }
  return {
    title: outline.title,
    pages: outline.items.map((item, index) => ({
      page_id: item.page_id as string,
      index,
      page_type: item.page_type,
      title: item.title,
      outline: outlineDetailToText(item),
      slide_path: `./slides/${item.page_id}.html`,
    })),
  };
}

export function progressMatchesAuthoringDeck(authoringDeck: AuthoringDeck, progress: PageProgress) {
  const progressIds = progress.pages.map((page) => page.page_id);
  return progressIds.length === authoringDeck.pages.length && authoringDeck.pages.every((page) => progressIds.includes(page.page_id));
}

function emitPreparation(
  input: RunDeckGenerationInput,
  message: string,
  progress: PageProgress | null,
  researchDiscovery?: ResearchDiscoveryProgress,
) {
  emit(
    input,
    { step: "visual-master", message, currentPageIndex: null, totalPages: input.confirmedOutline.items.length },
    progress,
    undefined,
    undefined,
    getAttemptLimits(input),
    researchDiscovery,
  );
}

async function preserveResearchDiscoveryProgress(
  input: RunDeckGenerationInput,
  progress: PageProgress,
  researchDiscovery?: ResearchDiscoveryProgress,
) {
  if (!researchDiscovery) return progress;
  return input.backend.recordPageProgress({
    workspace_dir: input.workspace.workspace_dir,
    patch: { research_discovery: researchProgressForPersistence(researchDiscovery) },
  });
}

async function ensureVisualMaster(input: RunDeckGenerationInput) {
  const existing = await input.backend.getWorkspaceVisualMasterHtml({ workspace_dir: input.workspace.workspace_dir }).catch(() => null);
  if (existing?.content.trim()) return existing;
  const selections = await input.backend.getWorkspaceAestheticReferenceSelections({ workspace_dir: input.workspace.workspace_dir });
  const reference = await resolveWorkspaceTemplateReference({
    backend: input.backend,
    workspaceDir: input.workspace.workspace_dir,
    selectedPath: selections.visual_master?.path ?? "",
    selectReference: async (candidates) => {
      const selectedPath = await input.aiClient.selectDominantAestheticReference({
        target: "visual-master",
        brief: input.workspace.requirements.source?.brief ?? "",
        requirements: input.workspace.requirements,
        outline: input.confirmedOutline,
        candidates,
        logContext: input.aiLogger ? {
          logger: input.aiLogger,
          workspace_dir: input.workspace.workspace_dir,
          domain: "style_guide",
          operation: "select_aesthetic_reference",
          operation_id: input.aiLogger.createOperationId("style_guide", "select_aesthetic_reference"),
          provider: "anna",
          runtime_mode: "anna",
        } : undefined,
      });
      await input.backend.recordWorkspaceAestheticReferenceSelection({ workspace_dir: input.workspace.workspace_dir, target: "visual-master", path: selectedPath });
      return selectedPath;
    },
  });
  const result = await input.agentClient.runHtmlGenerationPrompt(buildVisualMasterHtmlPrompt({
    requirements: input.workspace.requirements,
    outline: input.confirmedOutline,
    referenceHtml: reference.html,
  }), {
    signal: input.cancelSignal,
    isCancelled: input.isCancelled,
    logContext: input.aiLogger ? {
      logger: input.aiLogger,
      workspace_dir: input.workspace.workspace_dir,
      domain: "style_guide",
      operation: "generate_visual_master_html",
      operation_id: input.aiLogger.createOperationId("style_guide", "generate_visual_master_html"),
      provider: "anna",
      runtime_mode: "anna",
    } : undefined,
  });
  return input.backend.commitWorkspaceVisualMasterHtml({ workspace_dir: input.workspace.workspace_dir, content: result.html });
}

/** @deprecated HTML v1 does not use Persistent Elements. */
export async function ensurePersistentElementsReference(input: RunDeckGenerationInput, _force = false) {
  return input.backend.getWorkspacePersistentElementsReferenceStatus({ workspace_dir: input.workspace.workspace_dir });
}

export async function loadResumeArtifacts(
  input: RunDeckGenerationInput,
  researchDiscovery?: ResearchDiscoveryProgress,
) {
  const authoringDeck = authoringDeckFromConfirmedOutline(input.confirmedOutline);
  let progress = await input.backend.getPageProgress({ workspace_dir: input.workspace.workspace_dir });
  if (progress.pages.length === 0) {
    emitPreparation(input, generationText(input.locale).visualMaster, progress, researchDiscovery);
    await ensureVisualMaster(input);
    await input.backend.prepareWorkspacePageSources({ workspace_dir: input.workspace.workspace_dir });
    progress = await input.backend.initializePageProgress({ workspace_dir: input.workspace.workspace_dir });
    progress = await preserveResearchDiscoveryProgress(input, progress, researchDiscovery);
    return { authoringDeck, progress };
  }
  if (!progressMatchesAuthoringDeck(authoringDeck, progress)) return null;
  await ensureVisualMaster(input);
  await input.backend.reconcileWorkspacePageSources({ workspace_dir: input.workspace.workspace_dir });
  progress = await preserveResearchDiscoveryProgress(input, progress, researchDiscovery);
  return { authoringDeck, progress };
}

export async function createInitialArtifacts(
  input: RunDeckGenerationInput,
  researchDiscovery?: ResearchDiscoveryProgress,
) {
  const authoringDeck = authoringDeckFromConfirmedOutline(input.confirmedOutline);
  await recordDeckRecovery(input, {
    status: "running", run_kind: "deck-generation", step: "visual-master",
    target_page_ids: authoringDeck.pages.map((page) => page.page_id), refinement_request: null,
    page_refinement_reasons: {}, error: null,
    final_deck_render: { status: "idle", message: null, error: null, output_dir: null, deck_html_path: null, rendered_at: null },
    deck_status: "running",
  });
  emitPreparation(input, generationText(input.locale).visualMaster, null, researchDiscovery);
  await ensureVisualMaster(input);
  throwIfCancelled(input);
  await input.backend.prepareWorkspacePageSources({ workspace_dir: input.workspace.workspace_dir, reset_existing: true });
  throwIfCancelled(input);
  let progress = await input.backend.initializePageProgress({ workspace_dir: input.workspace.workspace_dir });
  progress = await preserveResearchDiscoveryProgress(input, progress, researchDiscovery);
  return { authoringDeck, progress };
}
