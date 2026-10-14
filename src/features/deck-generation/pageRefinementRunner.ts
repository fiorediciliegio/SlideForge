import { pickLocale } from "../../i18n/locales";
import type { AgentImageAttachment } from "../../runtime/annaRuntime";
import type { PageProgress } from "../../api/types";
import { createProgress } from "./progressProjection";
import { failedCompletion } from "./deckGenerationCompletion";
import { authoringDeckFromConfirmedOutline } from "./deckGenerationStartArtifacts";
import { runDeckGeneration } from "./deckGenerationWorkflow";
import { getAttemptLimits } from "./settings";
import type { DeckGenerationCompletion, PageRefinementVisualContext, RunDeckRefinementInput } from "./types";

function visualContext(progress: PageProgress, pageId: string): PageRefinementVisualContext {
  const page = progress.pages.find((item) => item.page_id === pageId);
  return page?.last_screenshot_path?.trim()
    ? { source: "progress", screenshotPath: page.last_screenshot_path.trim() }
    : { source: "unavailable", unavailableReason: "No previous successful screenshot is available." };
}

async function loadHtmlRefinementContext(input: RunDeckRefinementInput, pageId: string) {
  const context = await input.backend.getPageEditContext({
    workspace_dir: input.workspace.workspace_dir,
    page_id: pageId,
    purpose: "refinement",
  });
  const html = context.html;
  if (!html.trim()) {
    throw new Error(pickLocale(input.locale, {
      zh: "当前页 HTML 为空，无法进行页面优化。",
      en: "The current page HTML is empty and cannot be refined.",
      ja: "現在のページ HTML が空のため、ページを最適化できません。",
      de: "Die HTML der aktuellen Seite ist leer und kann nicht optimiert werden.",
    }));
  }
  if (!context.screenshot_upload?.url) {
    throw new Error(pickLocale(input.locale, {
      zh: "当前页没有可用的实际截图，无法进行页面优化。",
      en: "No screenshot is available for the current page, so it cannot be refined.",
      ja: "現在のページに利用可能なスクリーンショットがないため、最適化できません。",
      de: "Für die aktuelle Seite ist kein Screenshot verfügbar, daher kann sie nicht optimiert werden.",
    }));
  }
  const screenshotAttachment: AgentImageAttachment = {
    type: context.screenshot_upload.mime_type,
    url: context.screenshot_upload.url,
    filename: context.screenshot_upload.filename ?? `${pageId}.png`,
    detail: "auto",
  };
  return { html, screenshotAttachment };
}

async function prepareHtmlPageRefinement(input: RunDeckRefinementInput, pageId: string, request: string) {
  const current = await input.backend.getPageProgress({ workspace_dir: input.workspace.workspace_dir });
  const existing = current.pages.find((item) => item.page_id === pageId);
  if (!existing) throw new Error(`Page Progress is missing for page_id "${pageId}"`);
  const updatedAt = new Date().toISOString();
  const progress = await input.backend.recordPageProgress({
    workspace_dir: input.workspace.workspace_dir,
    page_id: pageId,
    patch: {
      status: "pending",
      render_attempts: 0,
      visual_review_attempts: 0,
      agent_failures: 0,
      agent_infrastructure_failures: 0,
      last_error: "",
      visual_review: null,
      deck_status: "running",
      recovery: {
        status: "running",
        run_kind: "page-refinement",
        step: "page-authoring",
        target_page_ids: [pageId],
        refinement_request: request,
        page_refinement_reasons: { [pageId]: request },
        error: null,
        updated_at: updatedAt,
      },
      final_deck_render: {
        status: "idle",
        message: null,
        error: null,
        output_dir: null,
        deck_html_path: null,
        rendered_at: null,
        updated_at: updatedAt,
      },
    },
  });
  return progress;
}

export async function runPageRefinement(input: RunDeckRefinementInput, instruction: string): Promise<DeckGenerationCompletion> {
  const attemptLimits = getAttemptLimits(input);
  const authoringDeck = authoringDeckFromConfirmedOutline(input.confirmedOutline);
  const pageId = input.pageId ?? input.resumePageIds?.[0];
  const page = authoringDeck.pages.find((item) => item.page_id === pageId);
  if (!page) {
    const progress = createProgress({
      step: "failed",
      message: pickLocale(input.locale, { zh: "没有找到要优化的页面。", en: "Could not find the page to refine.", ja: "最適化するページが見つかりませんでした。", de: "Die zu optimierende Seite wurde nicht gefunden." }),
      currentPageIndex: null,
      totalPages: authoringDeck.pages.length,
    }, null, undefined, undefined, attemptLimits);
    input.onProgress(progress);
    return failedCompletion({ progress, error: { type: "page_failed", message: progress.message } });
  }

  let progress: PageProgress;
  let reason = instruction;
  const htmlContext = await loadHtmlRefinementContext(input, page.page_id);
  if (input.skipIntentReview) {
    progress = await input.backend.getPageProgress({ workspace_dir: input.workspace.workspace_dir });
    reason = progress.recovery?.page_refinement_reasons?.[page.page_id] || progress.recovery?.refinement_request || instruction;
  } else {
    input.onProgress(createProgress({
      step: "page-refinement-prepare",
      message: pickLocale(input.locale, { zh: "正在准备当前页优化", en: "Preparing current-page refinement", ja: "現在のページの最適化を準備中", de: "Optimierung der aktuellen Seite wird vorbereitet" }),
      currentPageIndex: page.index,
      totalPages: authoringDeck.pages.length,
    }, null, undefined, undefined, attemptLimits));
    progress = await prepareHtmlPageRefinement(input, page.page_id, instruction);
  }

  return runDeckGeneration({
    backend: input.backend,
    aiClient: input.aiClient,
    researchWebClient: input.researchWebClient,
    agentClient: input.agentClient,
    hostUploadClient: input.hostUploadClient,
    aiLogger: input.aiLogger,
    workspace: input.workspace,
    confirmedOutline: input.confirmedOutline,
    locale: input.locale,
    startMode: "resume",
    onProgress: input.onProgress,
    isCancelled: input.isCancelled,
    cancelSignal: input.cancelSignal,
    refinementRequest: instruction,
    pageRefinementReasons: { [page.page_id]: reason },
    pageRefinementVisualContexts: { [page.page_id]: visualContext(progress, page.page_id) },
    pageRefinementHtmlContexts: { [page.page_id]: htmlContext },
    refinementRunKind: "page-refinement",
    reuseExistingResearch: true,
  });
}
