import { generationText } from "./messages";
import { availableOutlineImages } from "../outline/images";
import { preparePageImageAttachments } from "./pageImageAttachments";
import { extractLatestHtmlPreview, isAgentInfrastructureError, isAgentRunCancelledError, HTML_GENERATION_SYSTEM_PROMPT, type AgentRunOptions, type AgentStreamEvent } from "../../agent/agentClient";
import type { PageProgress } from "../../api/types";
import { beginPerformanceSpan } from "../../performance/performanceRecorder";
import { buildDeckGenerationSummary, emitRuntime as emitRuntimeProgress } from "./progressProjection";
import { getGenerationTargetPageIds } from "./pageTargetSelection";
import { createFailedPageError } from "./pageFailure";
import { getPageGenerationConcurrency } from "./settings";
import { getProgressPage, recordProgress } from "./runtimeSupport";
import { waitForWorkspacePagePreview } from "./renderPolling";
import { buildPageHtmlPrompt, buildPageHtmlRefinementPrompt } from "./htmlPrompts";
import { isPageHtmlGenerationSystemPromptEnabled } from "./htmlGenerationConfig";
import { resolveWorkspaceTemplateReference } from "./templateReferenceResolver";
import { buildPageLayoutRewritePrompt, loadPageLayoutRewriteContext } from "./pageLayoutRewrite";
import type { AuthoringDeck, AuthoringPage, DeckGenerationRuntime, DeckGenerationStream, PageGenerationResult } from "./types";

type PageStep = "page-authoring" | "page-render" | "page-layout-check" | "page-layout-rewrite";

function emitRuntime(input: DeckGenerationRuntime, step: PageStep, page: AuthoringPage, totalPages: number, progress: PageProgress) {
  emitRuntimeProgress(input, {
    step,
    message: buildDeckGenerationSummary(input, progress, totalPages),
    currentPageIndex: page.index,
    totalPages,
  }, progress);
}

async function ensurePageReference(input: DeckGenerationRuntime, page: AuthoringPage) {
  const selections = await input.backend.getWorkspaceAestheticReferenceSelections({ workspace_dir: input.workspace.workspace_dir });
  return resolveWorkspaceTemplateReference({
    backend: input.backend,
    workspaceDir: input.workspace.workspace_dir,
    selectedPath: selections.pages[page.page_id]?.path ?? "",
    selectReference: async (candidates) => {
      const outlinePage = input.confirmedOutline.items.find((item) => item.page_id === page.page_id);
      const selectedPath = await input.aiClient.selectDominantAestheticReference({
        target: "page",
        brief: input.workspace.requirements.source?.brief ?? "",
        requirements: input.workspace.requirements,
        outline: input.confirmedOutline,
        page: outlinePage,
        candidates,
        logContext: input.aiLogger ? {
          logger: input.aiLogger,
          workspace_dir: input.workspace.workspace_dir,
          domain: "page_agent",
          operation: "select_aesthetic_reference",
          operation_id: input.aiLogger.createOperationId("page_agent", "select_aesthetic_reference"),
          provider: "host",
          runtime_mode: "host",
        } : undefined,
      });
      await input.backend.recordWorkspaceAestheticReferenceSelection({
        workspace_dir: input.workspace.workspace_dir,
        target: "page",
        page_id: page.page_id,
        path: selectedPath,
      });
      return selectedPath;
    },
  });
}

async function runPageGenerationInternal(input: DeckGenerationRuntime, authoringDeck: AuthoringDeck, page: AuthoringPage): Promise<PageGenerationResult> {
  const totalPages = authoringDeck.pages.length;
  let progress = input.getProgress() as PageProgress;
  // Each worker owns only its page. RPC responses contain the whole deck and
  // may arrive after another worker has advanced; never replace its page state.
  const updateProgress = (next: PageProgress) => {
    const current = input.getProgress() ?? next;
    const ownPage = next.pages.find((item) => item.page_id === page.page_id);
    progress = { ...current, pages: current.pages.map((item) =>
      item.page_id === page.page_id && ownPage ? ownPage : item) };
    input.setProgress(progress);
  };
  const existing = getProgressPage(progress, page.page_id);
  if (existing?.status === "accepted" && !input.pageRefinementReasons?.[page.page_id]?.trim()) {
    return { page, reason: "accepted", progress };
  }
  const visualMaster = page.page_type === "cover"
    ? null
    : await input.backend.getWorkspaceVisualMasterHtml({ workspace_dir: input.workspace.workspace_dir });
  const reference = await ensurePageReference(input, page);
  const streamId = `page-html:${page.page_id}`;
  const stream: DeckGenerationStream = {
    kind: "page-html",
    page_id: page.page_id,
    page_index: page.index,
    status: "authoring",
    lines: [],
    activities: [],
    started_at: new Date().toISOString(),
  };
  let streamedText = "";
  let lastPreviewEmissionAt = 0;
  let rewriteContext: Awaited<ReturnType<typeof loadPageLayoutRewriteContext>> | null = null;
  let activeStep: PageStep = "page-authoring";
  const publish = (step: PageStep) => {
    activeStep = step;
    stream.kind = step === "page-authoring" || step === "page-render" ? "page-html" : step;
    stream.status = step === "page-layout-check" ? "layout_checking"
      : step === "page-layout-rewrite" ? "layout_rewriting"
      : step === "page-authoring" ? "authoring" : "rendering";
    stream.updated_at = new Date().toISOString();
    input.activeStreams.set(streamId, stream);
    emitRuntime(input, step, page, totalPages, input.getProgress() ?? progress);
  };
  const publishLivePreview = (force = false) => {
    const previewHtml = extractLatestHtmlPreview(streamedText);
    if (!previewHtml) return;
    const now = Date.now();
    if (!force && now - lastPreviewEmissionAt < 180) return;
    lastPreviewEmissionAt = now;
    stream.preview_html = previewHtml;
    publish(rewriteContext ? "page-layout-rewrite" : "page-authoring");
  };
  const maxPageAttempts = 3;
  const recordAttemptFailure = async (status: string, error: string, attempt: number, willRetry: boolean) => {
    await input.aiLogger?.appendSemanticLog({
      workspace_dir: input.workspace.workspace_dir, domain: "page_agent", operation: "page_generation_attempt",
      page_id: page.page_id, page_index: page.index,
    }, { event: "page.generation.attempt.failed", attempt, max_attempts: maxPageAttempts, status, error, will_retry: willRetry });
    progress = await recordProgress(input, page, { status: willRetry ? "authoring" : status, last_error: error });
    updateProgress(progress);
    if (willRetry) {
      // Publish the retry state together with the persisted progress so the
      // page never briefly looks like an ordinary authoring run after a
      // failed upload, commit, render, or layout-rewrite pass.
      const retryMessage = generationText(input.locale).retryingPage(page.index + 1, attempt + 1, maxPageAttempts);
      stream.activities = [retryMessage];
      stream.lines = [retryMessage];
      publish("page-authoring");
    }
  };
  // A complete page attempt includes authoring, upload, commit, render, and
  // layout checking. Render/persistence failures retry the complete attempt
  // with a fresh Agent Session and the original prompt. A successful render
  // with serious layout findings may use one rewrite pass within that attempt.

  try {
    attempts: for (let attempt = 1; attempt <= maxPageAttempts; attempt += 1) {
      rewriteContext = null;
      for (let layoutPass = 0; layoutPass < 2; layoutPass += 1) {
        if (input.isCancelled()) return { page, reason: "cancelled", progress };
        stream.run_id = `${streamId}:${attempt}:${layoutPass}`;
        stream.preview_html = undefined;
        streamedText = "";
        lastPreviewEmissionAt = 0;
        progress = await recordProgress(input, page, { status: rewriteContext ? "layout_rewriting" : "authoring", last_error: "" });
        updateProgress(progress);
        if (attempt > 1 && !rewriteContext) {
          stream.activities = [generationText(input.locale).retryingPage(page.index + 1, attempt, maxPageAttempts)];
          stream.lines = [...stream.activities];
        }
        publish(rewriteContext ? "page-layout-rewrite" : "page-authoring");
        let generatedHtml = "";
        try {
          const refinementContext = input.pageRefinementHtmlContexts?.[page.page_id];
          const refinementRequest = input.pageRefinementReasons?.[page.page_id] ?? input.refinementRequest;
          const isRefinement = Boolean(refinementContext?.html && refinementRequest?.trim());
          const preparedPageImages = !rewriteContext && !isRefinement
            ? await preparePageImageAttachments({
                backend: input.backend,
                workspaceDir: input.workspace.workspace_dir,
                selectedImageIds: input.confirmedOutline.items[page.index]?.selected_image_ids ?? [],
                availableImages: input.sharedResearchContext ? availableOutlineImages(input.sharedResearchContext) : [],
              })
            : undefined;
          if (input.isCancelled()) return { page, reason: "cancelled", progress };
          const prompt = rewriteContext ? buildPageLayoutRewritePrompt(rewriteContext.html, input.workspace.requirements.selections.aspect_ratio, {
            global_creation_requirements: input.confirmedOutline.global_creation_requirements,
            creation_requirements: input.confirmedOutline.items[page.index]?.creation_requirements,
            refinementRequest,
          })
            : refinementContext?.html && refinementRequest?.trim()
            ? buildPageHtmlRefinementPrompt({
                aspectRatio: input.workspace.requirements.selections.aspect_ratio,
                outline: input.confirmedOutline,
                availableImages: input.sharedResearchContext ? availableOutlineImages(input.sharedResearchContext) : [],
                page,
                visualMasterHtml: visualMaster?.content ?? null,
                referenceHtml: reference.html,
                refinementRequest,
                originalHtml: refinementContext.html,
              })
            : buildPageHtmlPrompt({
                preparedPageImages,
                aspectRatio: input.workspace.requirements.selections.aspect_ratio,
                outline: input.confirmedOutline,
                availableImages: input.sharedResearchContext ? availableOutlineImages(input.sharedResearchContext) : [],
                page,
                visualMasterHtml: visualMaster?.content ?? null,
                referenceHtml: reference.html,
              });
          const runOptions: AgentRunOptions = {
            ...(rewriteContext?.screenshotAttachment || (isRefinement && refinementContext?.screenshotAttachment)
              ? { attachments: [(rewriteContext ?? refinementContext)!.screenshotAttachment!] }
              : preparedPageImages?.attachments.length ? { attachments: preparedPageImages.attachments } : {}),
            signal: input.cancelSignal,
            isCancelled: input.isCancelled,
            onStreamEvent: (event: AgentStreamEvent) => {
              if (event.type !== "content") return;
              streamedText += event.text;
              publishLivePreview();
            },
            logContext: input.aiLogger ? {
              logger: input.aiLogger,
              workspace_dir: input.workspace.workspace_dir,
              domain: "page_agent",
              operation: rewriteContext ? "rewrite_page_layout" : "generate_page_html",
              operation_id: input.aiLogger.createOperationId("page_agent", rewriteContext ? "rewrite_page_layout" : "generate_page_html"),
              page_id: page.page_id,
              page_index: page.index,
              provider: "host",
              runtime_mode: "host",
            } : undefined,
          };
          const generated = !rewriteContext && isPageHtmlGenerationSystemPromptEnabled()
            ? await input.agentClient.runHtmlGenerationPrompt(prompt, runOptions, HTML_GENERATION_SYSTEM_PROMPT)
            : await input.agentClient.runHtmlGenerationPrompt(prompt, runOptions);
          generatedHtml = generated.html;
          stream.preview_html = generatedHtml;
          publish(rewriteContext ? "page-layout-rewrite" : "page-authoring");
        } catch (error) {
          if (isAgentRunCancelledError(error) || input.isCancelled()) return { page, reason: "cancelled", progress };
          const message = error instanceof Error ? error.message : String(error);
          if (isAgentInfrastructureError(error)) {
            progress = await recordProgress(input, page, { status: "agent_infrastructure_failed", agent_infrastructure_failures: (existing?.agent_infrastructure_failures ?? 0) + 1, last_error: message });
            updateProgress(progress);
            return { page, reason: "agent_infrastructure", progress, error: { type: "agent_infrastructure", message, page_id: page.page_id, page_index: page.index, page_status: "agent_infrastructure_failed" } };
          }
          progress = await recordProgress(input, page, { status: "agent_failed", agent_failures: (existing?.agent_failures ?? 0) + 1, last_error: message });
          updateProgress(progress);
          break attempts;
        }

        try {
          if (input.isCancelled()) return { page, reason: "cancelled", progress };
          await input.backend.commitWorkspacePageHtml({
            workspace_dir: input.workspace.workspace_dir,
            page_id: page.page_id,
            content: generatedHtml,
          });
        } catch (error) {
          if (isAgentRunCancelledError(error) || input.isCancelled()) return { page, reason: "cancelled", progress };
          const message = error instanceof Error ? error.message : String(error);
          await recordAttemptFailure("workspace_commit_failed", message, attempt, attempt < maxPageAttempts);
          rewriteContext = null;
          if (attempt < maxPageAttempts) continue attempts;
          break attempts;
        }

        let failureStatus = "render_failed";
        try {
          if (input.isCancelled()) return { page, reason: "cancelled", progress };
          progress = await recordProgress(input, page, { status: "rendering", last_error: "" });
          updateProgress(progress);
          publish("page-render");
          const submission = await input.backend.renderWorkspacePagePreview({ workspace_dir: input.workspace.workspace_dir, page_id: page.page_id });
          const preview = await waitForWorkspacePagePreview({
            backend: input.backend,
            workspaceDir: input.workspace.workspace_dir,
            submission,
            isCancelled: input.isCancelled,
            onProgress: updateProgress,
          });
          if (!preview) return { page, reason: "cancelled", progress };
          if (!rewriteContext) {
            failureStatus = "layout_check_failed";
            progress = await recordProgress(input, page, { status: "layout_checking", last_error: "" });
            updateProgress(progress);
            publish("page-layout-check");
            const audit = await input.backend.auditWorkspacePageLayout({
              workspace_dir: input.workspace.workspace_dir,
              page_id: page.page_id,
              expected_source_sha256: submission.source_sha256,
            });
            if (input.isCancelled()) return { page, reason: "cancelled", progress };
            if (audit.page_id !== page.page_id || audit.source_sha256 !== submission.source_sha256 ||
              !Number.isInteger(audit.error_count) || audit.error_count < 0) {
              throw new Error(generationText(input.locale).layoutAuditInvalid);
            }
            if (audit.error_count > 0) {
              rewriteContext = await loadPageLayoutRewriteContext(audit, input.locale, input.cancelSignal);
              continue;
            }
          }
          if (input.isCancelled()) return { page, reason: "cancelled", progress };
          progress = await recordProgress(input, page, {
            status: "accepted",
            last_html_path: preview.html_path,
            last_screenshot_path: preview.screenshot_path,
            last_error: "",
          });
          updateProgress(progress);
          return { page, reason: "accepted", progress };
        } catch (error) {
          if (isAgentRunCancelledError(error) || input.isCancelled()) return { page, reason: "cancelled", progress };
          const message = error instanceof Error ? error.message : String(error);
          await recordAttemptFailure(failureStatus, message, attempt, failureStatus === "render_failed" && attempt < maxPageAttempts);
          // Keep the concrete failure for diagnostics, but never add it to the
          // next Agent prompt. The next iteration rebuilds the original prompt.
          rewriteContext = null;
          if (failureStatus === "render_failed" && attempt < maxPageAttempts) continue attempts;
          break attempts;
        }
      }
    }

    progress = input.getProgress() ?? await input.backend.getPageProgress({ workspace_dir: input.workspace.workspace_dir });
    const failedPage = getProgressPage(progress, page.page_id);
    const error = failedPage ? createFailedPageError(failedPage, input.locale, page.index) : {
      type: "page_failed" as const, message: `Page ${page.index + 1} failed`,
      page_id: page.page_id, page_index: page.index, page_status: "agent_failed",
    };
    return { page, reason: "page_failed", progress, error };
  } finally {
    input.activeStreams.delete(streamId);
    emitRuntime(input, activeStep, page, totalPages, input.getProgress() ?? progress);
  }
}

export async function runPageGeneration(input: DeckGenerationRuntime, authoringDeck: AuthoringDeck, page: AuthoringPage): Promise<PageGenerationResult> {
  const span = beginPerformanceSpan({ operationName: "page.generation", workspaceId: input.workspace.workspace_id, attributes: { layer: "page-workflow", page_id: page.page_id, page_index: page.index } });
  try {
    const result = await runPageGenerationInternal(input, authoringDeck, page);
    span?.finish(result.reason === "accepted" ? "ok" : result.reason === "cancelled" ? "interrupted" : "error", { result: result.reason });
    return result;
  } catch (error) {
    span?.finish(isAgentRunCancelledError(error) || input.isCancelled() ? "interrupted" : "error");
    throw error;
  }
}

export async function runPagesConcurrently(runtime: DeckGenerationRuntime, authoringDeck: AuthoringDeck): Promise<PageGenerationResult[]> {
  const targetPageIds = new Set(getGenerationTargetPageIds(runtime, authoringDeck, runtime.getProgress()));
  const pages = authoringDeck.pages.filter((page) => targetPageIds.has(page.page_id));
  const results: PageGenerationResult[] = [];
  let nextIndex = 0;
  let stopScheduling = false;
  async function worker() {
    while (!stopScheduling && !runtime.isCancelled()) {
      const page = pages[nextIndex++];
      if (!page) return;
      const result = await runPageGeneration(runtime, authoringDeck, page);
      results.push(result);
      if (result.reason === "agent_infrastructure") stopScheduling = true;
    }
  }
  await Promise.all(Array.from({ length: Math.min(getPageGenerationConcurrency(runtime), pages.length) }, worker));
  return results.sort((left, right) => left.page.index - right.page.index);
}
