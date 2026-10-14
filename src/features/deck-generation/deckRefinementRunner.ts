import { pickLocale } from "../../i18n/locales";
import type { AiOperationLogContext } from "../../ai/interactionLog";
import type { DeckRefinementOutlineOperation, DeckRefinementPlan } from "../../ai/types";
import type { PageProgress, RenderDeckHtmlResult, WorkspaceOutline, WorkspaceResult } from "../../api/types";
import { createProgress, emit as emitProgress } from "./progressProjection";
import { failedCompletion } from "./deckGenerationCompletion";
import { runDeckGeneration } from "./deckGenerationWorkflow";
import { authoringDeckFromConfirmedOutline, ensurePersistentElementsReference } from "./deckGenerationStartArtifacts";
import { getAttemptLimits } from "./settings";
import type { DeckGenerationCompletion, RunDeckRefinementInput } from "./types";

function readRenderedDeck(workspace: WorkspaceResult): RenderDeckHtmlResult | null {
  const pages = workspace.pages && typeof workspace.pages === "object" && !Array.isArray(workspace.pages)
    ? workspace.pages as Record<string, unknown>
    : null;
  const rawSlides = Array.isArray(pages?.pages) ? pages.pages : [];
  if (!pages || rawSlides.length === 0) return null;
  const slides = rawSlides.map((value) => {
    const slide = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return {
      slide_id: typeof slide.page_id === "string" ? slide.page_id : "",
      layout_id: typeof slide.layout_id === "string" ? slide.layout_id : "",
      title: typeof slide.title === "string" ? slide.title : "",
      html_path: typeof slide.html_path === "string" ? slide.html_path : "",
      screenshot_path: typeof slide.screenshot_path === "string" ? slide.screenshot_path : undefined,
      speaker_note: typeof slide.speaker_note === "string" ? slide.speaker_note : "",
    };
  });
  if (slides.some((slide) => !slide.html_path)) return null;
  return {
    workspace_dir: workspace.workspace_dir,
    manifest_path: typeof pages.manifest_path === "string" ? pages.manifest_path : "",
    output_dir: typeof pages.output_dir === "string" ? pages.output_dir : "",
    deck_html_path: typeof pages.deck_html_path === "string" ? pages.deck_html_path : "",
    slides,
    slide_count: slides.length,
    title: typeof pages.title === "string" ? pages.title : "",
    rendered_at: typeof pages.rendered_at === "string" ? pages.rendered_at : new Date().toISOString(),
  };
}

function emit(input: RunDeckRefinementInput, progress: PageProgress | null, step: "deck-refinement-planning" | "deck-refinement-style-guide" | "persistent-elements" | "deck-refinement-commit", message: string) {
  emitProgress(input, {
    step,
    message,
    currentPageIndex: null,
    totalPages: input.confirmedOutline.items.length,
  }, progress, undefined, undefined, getAttemptLimits(input));
}

function fail(input: RunDeckRefinementInput, progress: PageProgress | null, error: unknown): DeckGenerationCompletion {
  const message = error instanceof Error ? error.message : String(error);
  const failedProgress = createProgress({
    step: "failed",
    message,
    currentPageIndex: null,
    totalPages: input.confirmedOutline.items.length,
  }, progress, undefined, undefined, getAttemptLimits(input));
  input.onProgress(failedProgress);
  return failedCompletion({ progress: failedProgress, error: { type: "page_failed", message } });
}

function provisionalOutline(current: WorkspaceOutline, plan: DeckRefinementPlan): WorkspaceOutline {
  const currentById = new Map(current.items.map((item) => [item.page_id, item]));
  return {
    ...current,
    title: plan.title,
    items: plan.operations.flatMap((operation) => {
      if (operation.op === "delete") return [];
      if (operation.op === "keep") {
        const existing = currentById.get(operation.page_id);
        return existing ? [existing] : [];
      }
      if (operation.op === "update") {
        return [{
          page_id: operation.page_id,
          page_type: operation.page_type,
          title: operation.title,
          content: operation.content,
        }];
      }
      return [{
        page_type: operation.page_type,
        title: operation.title,
        content: operation.content,
      }];
    }),
  };
}

function refinementReasons(plan: DeckRefinementPlan, targetIds: string[], committedOutline: WorkspaceOutline) {
  const globalReasons = [
    plan.output_language_change.changed ? plan.output_language_change.reason || "Apply the new output language to this page." : "",
    plan.style_guide_change.action === "regenerate" ? plan.style_guide_change.reason : "",
  ].filter(Boolean);
  const byExistingId = new Map(plan.operations.flatMap((operation) => operation.op === "add" ? [] : [[
    operation.page_id,
    [operation.reason, ...globalReasons].filter(Boolean).join(" "),
  ] as const]));
  const addReasons = plan.operations.filter((operation): operation is Extract<DeckRefinementOutlineOperation, { op: "add" }> => operation.op === "add").map((operation) => operation.reason);
  const addedIds = committedOutline.items.map((item) => item.page_id).filter((id): id is string => typeof id === "string" && !byExistingId.has(id));
  const addedReasonById = new Map(addedIds.map((id, index) => [id, addReasons[index] ?? plan.reason]));
  return Object.fromEntries(targetIds.map((id) => [id, byExistingId.get(id) ?? addedReasonById.get(id) ?? plan.reason]));
}

function refinementVisualContexts(progress: PageProgress, targetIds: string[]) {
  const targetSet = new Set(targetIds);
  return Object.fromEntries(progress.pages.filter((page) => targetSet.has(page.page_id)).map((page) => [
    page.page_id,
    page.last_screenshot_path?.trim()
      ? { source: "progress" as const, screenshotPath: page.last_screenshot_path.trim() }
      : { source: "unavailable" as const, unavailableReason: "No previous successful screenshot is available." },
  ]));
}

export async function runDeckRefinementWorkflow(input: RunDeckRefinementInput, instruction: string): Promise<DeckGenerationCompletion> {
  let progress = await input.backend.getPageProgress({ workspace_dir: input.workspace.workspace_dir });
  if (input.skipIntentReview) {
    const reasons = progress.recovery?.page_refinement_reasons ?? {};
    const workspace = await input.backend.openWorkspace({ workspace_dir: input.workspace.workspace_dir });
    const outline = workspace.outline as WorkspaceOutline;
    return runDeckGeneration({
      ...input,
      workspace,
      confirmedOutline: outline,
      startMode: "resume",
      refinementRequest: progress.recovery?.refinement_request ?? instruction,
      pageRefinementReasons: reasons,
      pageRefinementVisualContexts: refinementVisualContexts(progress, Object.keys(reasons)),
      refinementRunKind: "deck-refinement",
      resumeResearch: true,
    });
  }

  try {
    // Do not project the previous completed deck progress while the refinement
    // plan is still being prepared. The durable progress is retained for
    // planning and visual context, but it is not current UI progress.
    emit(input, null, "deck-refinement-planning", pickLocale(input.locale, { zh: "正在规划整套优化", en: "Planning deck refinement", ja: "デッキの最適化を計画中", de: "Deck-Optimierung wird geplant" }));
    const styleGuide = await input.backend.getWorkspaceStyleGuide({ workspace_dir: input.workspace.workspace_dir });
    const rhythmStatus = await input.backend.getVisualRhythmStatus({ workspace_dir: input.workspace.workspace_dir });
    const logContext: AiOperationLogContext | undefined = input.aiLogger ? {
      logger: input.aiLogger,
      workspace_dir: input.workspace.workspace_dir,
      domain: "outline",
      operation: "deck_refinement_planning",
      operation_id: input.aiLogger.createOperationId("outline", "deck_refinement_planning"),
      provider: "anna",
      runtime_mode: "anna",
    } : undefined;
    const { plan } = await input.aiClient.planDeckRefinement({
      instruction,
      outline: input.confirmedOutline,
      requirements: input.workspace.requirements,
      currentStyleGuide: styleGuide.content,
      currentVisualRhythm: rhythmStatus.non_empty ? (await input.backend.getVisualRhythm({ workspace_dir: input.workspace.workspace_dir })).content : undefined,
      locale: input.locale,
      visualStylePresetSelected: Boolean(input.workspace.requirements.selections.visual_style_preset),
      logContext,
    });

    if (plan.route === "no_op") {
      const rendered = readRenderedDeck(input.workspace);
      if (!rendered) throw new Error(pickLocale(input.locale, { zh: "整套优化无需改动，但现有渲染产物不可用。", en: "No changes are needed, but existing rendered artifacts are unavailable.", ja: "デッキの最適化で変更は不要ですが、既存のレンダリング成果物が利用できません。", de: "Keine Änderungen erforderlich, aber die vorhandenen gerenderten Artefakte sind nicht verfügbar." }));
      progress = await input.backend.recordPageProgress({
        workspace_dir: input.workspace.workspace_dir,
        patch: {
          deck_status: "completed",
          recovery: {
            status: "completed",
            run_kind: "deck-refinement",
            step: "complete",
            target_page_ids: [],
            refinement_request: null,
            page_refinement_reasons: {},
            error: null,
          },
        },
      });
      return {
        status: "completed",
        noChange: true,
        result: {
          outline: input.confirmedOutline,
          authoringDeck: authoringDeckFromConfirmedOutline(input.confirmedOutline),
          progress,
          rendered,
        },
      };
    }

    let styleGuideContent;
    if (plan.style_guide_change.action === "regenerate") {
      emit(input, null, "deck-refinement-style-guide", pickLocale(input.locale, { zh: "正在重新生成艺术指导", en: "Regenerating Workspace Style Guide", ja: "スタイルガイドを再生成中", de: "Style Guide wird neu erstellt" }));
      const markdown = await input.aiClient.generateWorkspaceStyleGuide({
        brief: input.workspace.requirements.source?.brief ?? "",
        requirements: input.workspace.requirements,
        outline: provisionalOutline(input.confirmedOutline, plan),
        currentStyleGuide: styleGuide.content,
        refinementRequest: instruction,
        refinementReason: plan.style_guide_change.reason,
        logContext: input.aiLogger ? {
          logger: input.aiLogger,
          workspace_dir: input.workspace.workspace_dir,
          domain: "style_guide",
          operation: "regenerate_style_guide_for_deck_refinement",
          operation_id: input.aiLogger.createOperationId("style_guide", "regenerate_style_guide_for_deck_refinement"),
          provider: "anna",
          runtime_mode: "anna",
        } : undefined,
      });
      if (!markdown.trim()) throw new Error("Workspace Style Guide generation returned empty Markdown");
      styleGuideContent = markdown;
    }

    if (plan.persistent_elements_action === "revise") {
      emit(input, progress, "persistent-elements", pickLocale(input.locale, { zh: "正在重写跨页固定元素参考", en: "Revising persistent elements reference", ja: "ページ共通の固定要素リファレンスを更新中", de: "Referenz für seitenübergreifende feste Elemente wird überarbeitet" }));
      await ensurePersistentElementsReference(input, true);
    } else {
      emit(input, progress, "persistent-elements", pickLocale(input.locale, { zh: "沿用现有跨页固定元素参考", en: "Preserving the existing persistent elements reference", ja: "既存のページ共通固定要素リファレンスを継続使用", de: "Vorhandene Referenz für seitenübergreifende feste Elemente wird beibehalten" }));
    }

    emit(input, null, "deck-refinement-commit", pickLocale(input.locale, { zh: "正在提交整套优化方案", en: "Committing deck refinement", ja: "デッキの最適化プランを確定中", de: "Deck-Optimierung wird übernommen" }));
    const committed = await input.backend.commitDeckRefinement({
      workspace_dir: input.workspace.workspace_dir,
      refinement_request: instruction,
      title: plan.title,
      output_language_change: plan.output_language_change,
      style_guide_action: plan.style_guide_change.action,
      operations: plan.operations,
      style_guide_content: styleGuideContent,
    });
    progress = committed.progress;
    const workspace = await input.backend.openWorkspace({ workspace_dir: input.workspace.workspace_dir });
    const outline = committed.outline;
    const targetPageIds = plan.visual_rhythm_action === "rewrite"
      ? outline.items.map((item) => item.page_id).filter((id): id is string => Boolean(id))
      : committed.target_page_ids;
    const reasons = refinementReasons(plan, targetPageIds, outline);
    return runDeckGeneration({
      ...input,
      workspace,
      confirmedOutline: outline,
      startMode: "resume",
      refinementRequest: instruction,
      pageRefinementReasons: reasons,
      pageRefinementVisualContexts: refinementVisualContexts(progress, targetPageIds),
      refinementRunKind: "deck-refinement",
      rewriteVisualRhythm: plan.visual_rhythm_action === "rewrite",
      resumeResearch: false,
    });
  } catch (error) {
    return fail(input, progress, error);
  }
}
