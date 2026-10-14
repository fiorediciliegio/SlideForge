import { pickLocale } from "../../i18n/locales";
import { isAgentRunCancelledError } from "../../agent/agentClient";
import type { PageProgress, SharedResearchContextResult } from "../../api/types";
import { generationText } from "./messages";
import { createProgress } from "./progressProjection";
import {
  type DeckGenerationCompletion,
  type DeckGenerationRuntime,
  type RunPageGenerationRetryInput,
} from "./types";
import { getAttemptLimits } from "./settings";
import { runPageGeneration } from "./pageGenerationRunner";
import { createFailedPageError } from "./pageFailure";
import { runFinalDeckRender } from "./finalDeckRender";
import {
  cancelledCompletion,
  failedCompletion,
  preflightAgentToolAccess,
} from "./deckGenerationCompletion";
import { authoringDeckFromConfirmedOutline } from "./deckGenerationStartArtifacts";
import { prepareSelectedImageDescriptions } from "./prepareImageDescriptions";
import {
  recordDeckRecovery,
  recordProgress,
} from "./runtimeSupport";

async function cancelPageRetry(input: RunPageGenerationRetryInput, progress: PageProgress, totalPages: number) {
  const cancelledProgress = createProgress({ step: "cancelled", message: generationText(input.locale).cancelled,
    currentPageIndex: null, totalPages }, progress, undefined, undefined, getAttemptLimits(input));
  input.onProgress(cancelledProgress);
  await recordDeckRecovery(input, {
    status: "interrupted", run_kind: "page-generation-retry", step: "interrupted",
    target_page_ids: [input.pageId], error: null, deck_status: "interrupted",
  });
  return cancelledCompletion(cancelledProgress);
}

export async function runPageGenerationRetry(
  input: RunPageGenerationRetryInput,
): Promise<DeckGenerationCompletion> {
  const text = generationText(input.locale);
  const attemptLimits = getAttemptLimits(input);
  const initialProgress = await input.backend.getPageProgress({ workspace_dir: input.workspace.workspace_dir });
  const authoringDeck = authoringDeckFromConfirmedOutline(input.confirmedOutline);
  const page = authoringDeck.pages.find((item) => item.page_id === input.pageId);
  if (!page) {
    const missingProgress = createProgress(
      {
        step: "failed",
        message: pickLocale(input.locale, { zh: "没有找到要重跑的页面。", en: "Could not find the page to retry.", ja: "再実行するページが見つかりませんでした。", de: "Die zu wiederholende Seite wurde nicht gefunden." }),
        currentPageIndex: null,
        totalPages: authoringDeck.pages.length,
      },
      initialProgress,
      undefined,
      undefined,
      attemptLimits,
    );
    input.onProgress(missingProgress);
    return failedCompletion({
      progress: missingProgress,
      error: {
        type: "page_failed",
        message: missingProgress.message,
      },
    });
  }

  const preflightFailure = await preflightAgentToolAccess({
    agentClient: input.agentClient,
    locale: input.locale,
    onProgress: input.onProgress,
    progress: initialProgress,
    attemptLimits,
    totalPages: authoringDeck.pages.length,
    currentPageIndex: page.index,
  });
  if (preflightFailure) return preflightFailure;

  await recordDeckRecovery(input, {
    status: "running",
    run_kind: "page-generation-retry",
    step: "page-authoring",
    target_page_ids: [page.page_id],
    refinement_request: null,
    page_refinement_reasons: {},
    error: null,
    deck_status: "running",
  });
  let progress = await recordProgress(input, page, {
    status: "pending",
    render_attempts: 0,
    visual_review_attempts: 0,
    agent_failures: 0,
    agent_infrastructure_failures: 0,
    last_error: "",
    visual_review: null,
  });
  let sharedResearchContext: SharedResearchContextResult;
  try {
    const research = await input.backend.getSharedResearchContext({ workspace_dir: input.workspace.workspace_dir });
    sharedResearchContext = input.pageRefinementReasons || input.refinementRunKind ? research : await prepareSelectedImageDescriptions({
      backend: input.backend, agent: input.agentClient, workspaceDir: input.workspace.workspace_dir,
      locale: input.locale, logger: input.aiLogger, runKey: input.generationRunId,
      signal: input.cancelSignal, isCancelled: input.isCancelled, context: research,
      selectedImageIds: input.confirmedOutline.items.find((item) => item.page_id === page.page_id)?.selected_image_ids ?? [],
    });
  } catch (error) {
    if (isAgentRunCancelledError(error) || input.isCancelled() || input.cancelSignal?.aborted) {
      return cancelPageRetry(input, progress, authoringDeck.pages.length);
    }
    throw error;
  }
  const runtime: DeckGenerationRuntime = {
    ...input,
    targetPageIds: [page.page_id],
    sharedResearchContext,
    attachmentContext: await input.backend.getAttachmentContext({ workspace_dir: input.workspace.workspace_dir }).catch(() => null),
    activeStreams: new Map(),
    getProgress: () => progress,
    setProgress: (nextProgress) => {
      progress = nextProgress;
    },
  };

  const result = await runPageGeneration(runtime, authoringDeck, page);
  if (result.reason === "agent_infrastructure" && result.error) {
    const failedProgress = createProgress(
      {
        step: "failed",
        message: result.error.message,
        currentPageIndex: page.index,
        totalPages: authoringDeck.pages.length,
      },
      result.progress,
      undefined,
      undefined,
      attemptLimits,
    );
    input.onProgress(failedProgress);
    return failedCompletion({
      progress: failedProgress,
      error: result.error,
    });
  }

  if (input.isCancelled() || result.reason === "cancelled") {
    return cancelPageRetry(input, progress, authoringDeck.pages.length);
  }

  progress = await input.backend.getPageProgress({
    workspace_dir: input.workspace.workspace_dir,
  });
  const failedPage = progress.pages.find((item) => item.status !== "accepted");
  if (failedPage) {
    const failedPageIndex = progress.pages.findIndex((item) => item.page_id === failedPage.page_id);
    const error = createFailedPageError(failedPage, input.locale, failedPageIndex);
    const failedCount = progress.pages.filter((item) => item.status !== "accepted").length;
    const failedProgress = createProgress(
      {
        step: "failed",
        message: failedCount > 1 ? text.failedSummary(failedCount) : error.message,
        currentPageIndex: failedPageIndex,
        totalPages: authoringDeck.pages.length,
      },
      progress,
      undefined,
      undefined,
      attemptLimits,
    );
    input.onProgress(failedProgress);
    return failedCompletion({
      progress: failedProgress,
      error,
    });
  }

  return runFinalDeckRender({
    flowInput: input,
    authoringDeck,
    progress,
  });
}
