import { researchProgressForPersistence } from "../../api/researchProgress";
import { isAgentRunCancelledError } from "../../agent/agentClient";
import type { PageProgress } from "../../api/types";
import { generationText } from "./messages";
import { createProgress } from "./progressProjection";
import {
  type DeckGenerationCompletion,
  type DeckGenerationRuntime,
  type AuthoringDeck,
  type RunDeckGenerationInput,
} from "./types";
import { getAttemptLimits } from "./settings";
import { runPagesConcurrently } from "./pageGenerationRunner";
import { createFailedPageError } from "./pageFailure";
import { runFinalDeckRender } from "./finalDeckRender";
import {
  cancelledCompletion,
  failedCompletion,
} from "./deckGenerationCompletion";
import {
  authoringDeckFromConfirmedOutline,
  createInitialArtifacts,
  loadResumeArtifacts,
  progressMatchesAuthoringDeck,
} from "./deckGenerationStartArtifacts";
import {
  getProgressPage,
  recordDeckRecovery,
} from "./runtimeSupport";
import { getGenerationTargetPageIds } from "./pageTargetSelection";
import { prepareSelectedImageDescriptions } from "./prepareImageDescriptions";
import { formatMessage, messages } from "../../i18n";

async function mergeResearchDiscoveryProgress(
  runtime: DeckGenerationRuntime,
  progress: PageProgress,
) {
  if (!runtime.researchDiscoveryProgress) return progress;
  const nextProgress = await runtime.backend.recordPageProgress({
    workspace_dir: runtime.workspace.workspace_dir,
    patch: { research_discovery: researchProgressForPersistence(runtime.researchDiscoveryProgress) },
  });
  runtime.setProgress(nextProgress);
  emitMergedResearchProgress(runtime, nextProgress);
  return nextProgress;
}

function emitMergedResearchProgress(runtime: DeckGenerationRuntime, progress: PageProgress) {
  runtime.onProgress(createProgress(
    {
      step: "visual-master",
      message: generationText(runtime.locale).visualMaster,
      currentPageIndex: null,
      totalPages: runtime.confirmedOutline.items.length,
    },
    progress,
    undefined,
    runtime.activeStreams.values(),
    getAttemptLimits(runtime),
    runtime.researchDiscoveryProgress,
  ));
}

function getActiveGenerationRunKind(input: RunDeckGenerationInput): NonNullable<PageProgress["recovery"]>["run_kind"] {
  return input.refinementRunKind ?? (input.pageRefinementReasons ? "page-refinement" : "deck-generation");
}

export async function runDeckGeneration(
  input: RunDeckGenerationInput,
): Promise<DeckGenerationCompletion> {
  const text = generationText(input.locale);
  const attemptLimits = getAttemptLimits(input);
  if (input.confirmedOutline.status !== "confirmed") {
    const progress = createProgress(
      {
        step: "failed",
        message: text.invalidOutline,
        currentPageIndex: null,
        totalPages: 0,
      },
      null,
      undefined,
      undefined,
      attemptLimits,
    );
    input.onProgress(progress);
    return failedCompletion({
      progress,
      error: {
        type: "invalid_confirmed_outline",
        message: progress.message,
      },
    });
  }

  const startMode = input.startMode ?? "new";
  let authoringDeck: AuthoringDeck;
  let progress: PageProgress;
  try {
    authoringDeck = authoringDeckFromConfirmedOutline(input.confirmedOutline);
    progress = await input.backend.getPageProgress({
      workspace_dir: input.workspace.workspace_dir,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedProgress = createProgress(
      {
        step: "failed",
        message,
        currentPageIndex: null,
        totalPages: input.confirmedOutline.items.length,
      },
      null,
      undefined,
      undefined,
      attemptLimits,
    );
    input.onProgress(failedProgress);
    return failedCompletion({
      progress: failedProgress,
      error: { type: "page_failed", message },
    });
  }
  if (startMode === "resume" && progress.pages.length > 0 && !progressMatchesAuthoringDeck(authoringDeck, progress)) {
    const staleProgress = createProgress(
      {
        step: "failed",
        message: text.staleArtifacts,
        currentPageIndex: null,
        totalPages: input.confirmedOutline.items.length,
      },
      progress,
      undefined,
      undefined,
      attemptLimits,
    );
    input.onProgress(staleProgress);
    return failedCompletion({
      progress: staleProgress,
      error: { type: "stale_artifacts", message: staleProgress.message },
    });
  }
  const runtime: DeckGenerationRuntime = {
    ...input,
    activeStreams: new Map(),
    getProgress: () => progress,
    setProgress: (nextProgress) => {
      progress = nextProgress;
    },
  };
  runtime.attachmentContext = input.attachmentContext ?? await input.backend.getAttachmentContext({
    workspace_dir: input.workspace.workspace_dir,
  }).catch(() => null);

  let preparationFailureStep: "research-discovery" | "visual-master" = "research-discovery";
  try {
    if (input.reuseExistingResearch) {
      // HTML Page Refinement must never start a new Web or image search. Reuse
      // only the persisted research summary and imported image catalog.
      runtime.sharedResearchContext = await input.backend.getSharedResearchContext({
        workspace_dir: input.workspace.workspace_dir,
      });
      preparationFailureStep = "visual-master";
      const artifacts = startMode === "resume"
        ? await loadResumeArtifacts(input, runtime.researchDiscoveryProgress)
        : await createInitialArtifacts(input, runtime.researchDiscoveryProgress);
      if (!artifacts) {
        const staleProgress = createProgress(
          {
            step: "failed",
            message: text.staleArtifacts,
            currentPageIndex: null,
            totalPages: input.confirmedOutline.items.length,
          },
          progress,
          undefined,
          runtime.activeStreams.values(),
          attemptLimits,
          runtime.researchDiscoveryProgress,
        );
        input.onProgress(staleProgress);
        return failedCompletion({
          progress: staleProgress,
          error: { type: "stale_artifacts", message: staleProgress.message },
        });
      }
      progress = await mergeResearchDiscoveryProgress(runtime, artifacts.progress);
    } else {
      if (input.stopAfterImageResearch) {
        runtime.sharedResearchContext = await input.backend.getSharedResearchContext({ workspace_dir: input.workspace.workspace_dir });
        return { status: "research-completed" };
      }

      const researchPromise = input.backend.getSharedResearchContext({ workspace_dir: input.workspace.workspace_dir })
        .then((context) => ({ context }));
      const artifactsPromise = (startMode === "resume"
        ? loadResumeArtifacts(input)
        : createInitialArtifacts(input)).catch((error) => {
          preparationFailureStep = "visual-master";
          throw error;
        });
      const [research, artifacts] = await Promise.all([researchPromise, artifactsPromise]);
      if (!artifacts) {
        const staleProgress = createProgress(
          {
            step: "failed",
            message: text.staleArtifacts,
            currentPageIndex: null,
            totalPages: input.confirmedOutline.items.length,
          },
          progress,
          undefined,
          runtime.activeStreams.values(),
          attemptLimits,
          runtime.researchDiscoveryProgress,
        );
        input.onProgress(staleProgress);
        return failedCompletion({
          progress: staleProgress,
          error: { type: "stale_artifacts", message: staleProgress.message },
        });
      }
      runtime.sharedResearchContext = research.context;
      progress = await mergeResearchDiscoveryProgress(runtime, artifacts.progress);
    }
    runtime.targetPageIds = getGenerationTargetPageIds(input, authoringDeck, progress);
    if (!input.pageRefinementReasons && !input.refinementRunKind && runtime.sharedResearchContext) {
      const targetIds = new Set(runtime.targetPageIds);
      runtime.sharedResearchContext = await prepareSelectedImageDescriptions({
        backend: input.backend, agent: input.agentClient, workspaceDir: input.workspace.workspace_dir, locale: input.locale,
        context: runtime.sharedResearchContext, logger: input.aiLogger, isCancelled: input.isCancelled,
        runKey: input.generationRunId, signal: input.cancelSignal,
        selectedImageIds: input.confirmedOutline.items.filter((page) => targetIds.has(page.page_id!)).flatMap((page) => page.selected_image_ids ?? []),
        onProgress: ({ completed, total, failed }) => input.onProgress(createProgress({ step: "prepare",
          message: formatMessage(failed && completed === total ? messages[input.locale].imagePreparation.fallback : messages[input.locale].imagePreparation.progress,
            { completed, total }), currentPageIndex: null, totalPages: authoringDeck.pages.length,
        }, progress, undefined, runtime.activeStreams.values(), attemptLimits, runtime.researchDiscoveryProgress)),
      });
    }
  } catch (error) {
    if (isAgentRunCancelledError(error) || input.isCancelled()) {
      const cancelledProgress = createProgress(
        {
          step: "cancelled",
          message: text.cancelled,
          currentPageIndex: null,
          totalPages: authoringDeck.pages.length,
        },
        progress,
        null,
        runtime.activeStreams.values(),
        attemptLimits,
        runtime.researchDiscoveryProgress,
      );
      input.onProgress(cancelledProgress);
      await recordDeckRecovery(input, {
        status: "interrupted",
        run_kind: getActiveGenerationRunKind(input),
        step: "interrupted",
        error: null,
        deck_status: "interrupted",
      });
      return cancelledCompletion(cancelledProgress);
    }
    const message = error instanceof Error ? error.message : String(error);
    const failedProgress = createProgress(
      {
        step: "failed",
        message,
        currentPageIndex: null,
        totalPages: authoringDeck.pages.length,
      },
      progress,
      null,
      runtime.activeStreams.values(),
      attemptLimits,
      runtime.researchDiscoveryProgress,
    );
    input.onProgress(failedProgress);
    await recordDeckRecovery(input, {
      status: "failed",
      run_kind: getActiveGenerationRunKind(input),
      step: preparationFailureStep,
      target_page_ids: input.pageRefinementReasons
        ? Object.keys(input.pageRefinementReasons)
        : authoringDeck.pages.map((page) => page.page_id),
      refinement_request: input.refinementRequest ?? null,
      page_refinement_reasons: input.pageRefinementReasons ?? {},
      error: message,
      deck_status: "failed",
    });
    return failedCompletion({
      progress: failedProgress,
      error: { type: "page_failed", message },
    });
  }

  runtime.targetPageIds = getGenerationTargetPageIds(input, authoringDeck, progress);

  const results = await runPagesConcurrently(runtime, authoringDeck);
  const infrastructureFailure = results.find((result) => result.reason === "agent_infrastructure");
  if (infrastructureFailure?.error) {
    const failedProgress = createProgress(
      {
        step: "failed",
        message: infrastructureFailure.error.message,
        currentPageIndex: infrastructureFailure.page.index,
        totalPages: authoringDeck.pages.length,
      },
      infrastructureFailure.progress,
      null,
      runtime.activeStreams.values(),
      attemptLimits,
      runtime.researchDiscoveryProgress,
    );
    input.onProgress(failedProgress);
    await recordDeckRecovery(input, {
      status: "failed",
      run_kind: getActiveGenerationRunKind(input),
      step: "page-authoring",
      target_page_ids: input.pageRefinementReasons
        ? Object.keys(input.pageRefinementReasons)
        : [infrastructureFailure.page.page_id],
      refinement_request: input.refinementRequest ?? null,
      page_refinement_reasons: input.pageRefinementReasons ?? {},
      error: infrastructureFailure.error.message,
      deck_status: "failed",
    });
    return failedCompletion({
      progress: failedProgress,
      error: infrastructureFailure.error,
    });
  }

  if (input.isCancelled() || results.some((result) => result.reason === "cancelled")) {
    const cancelledProgress = createProgress(
      {
        step: "cancelled",
        message: text.cancelled,
        currentPageIndex: null,
        totalPages: authoringDeck.pages.length,
      },
      progress,
      null,
      runtime.activeStreams.values(),
      attemptLimits,
      runtime.researchDiscoveryProgress,
    );
    input.onProgress(cancelledProgress);
    await recordDeckRecovery(input, {
      status: "interrupted",
      run_kind: getActiveGenerationRunKind(input),
      step: "interrupted",
      target_page_ids: input.pageRefinementReasons
        ? Object.keys(input.pageRefinementReasons)
        : authoringDeck.pages.filter((page) => getProgressPage(progress, page.page_id)?.status !== "accepted").map((page) => page.page_id),
      refinement_request: input.refinementRequest ?? null,
      page_refinement_reasons: input.pageRefinementReasons ?? {},
      error: null,
      deck_status: "interrupted",
    });
    return cancelledCompletion(cancelledProgress);
  }

  progress = await input.backend.getPageProgress({
    workspace_dir: input.workspace.workspace_dir,
  });
  const failedPageIds = input.refinementRunKind === "page-refinement"
    ? new Set(Object.keys(input.pageRefinementReasons ?? {}))
    : null;
  const failedPage = progress.pages.find((page) =>
    page.status !== "accepted" && (!failedPageIds || failedPageIds.has(page.page_id)),
  );
  if (failedPage) {
    const failedPageIndex = progress.pages.findIndex((page) => page.page_id === failedPage.page_id);
    const error = createFailedPageError(failedPage, input.locale, failedPageIndex);
    const failedCount = progress.pages.filter((page) =>
      page.status !== "accepted" && (!failedPageIds || failedPageIds.has(page.page_id)),
    ).length;
    const failedProgress = createProgress(
      {
        step: "failed",
        message: failedCount > 1 ? text.failedSummary(failedCount) : error.message,
        currentPageIndex: failedPageIndex,
        totalPages: authoringDeck.pages.length,
      },
      progress,
      null,
      runtime.activeStreams.values(),
      attemptLimits,
      runtime.researchDiscoveryProgress,
    );
    input.onProgress(failedProgress);
    await recordDeckRecovery(input, {
      status: "failed",
      run_kind: getActiveGenerationRunKind(input),
      step: "page-authoring",
      target_page_ids: input.pageRefinementReasons
        ? Object.keys(input.pageRefinementReasons)
        : [failedPage.page_id],
      refinement_request: input.refinementRequest ?? null,
      page_refinement_reasons: input.pageRefinementReasons ?? {},
      error: error.message,
      deck_status: "failed",
    });
    return failedCompletion({
      progress: failedProgress,
      error,
    });
  }

  return runFinalDeckRender({
    flowInput: input,
    authoringDeck,
    progress,
    activeStreams: runtime.activeStreams.values(),
    researchDiscoveryProgress: runtime.researchDiscoveryProgress,
  });
}
