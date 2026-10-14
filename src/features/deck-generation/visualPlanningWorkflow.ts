import type { AiInteractionLogger } from "../../ai/interactionLog";
import type { SharedResearchContextResult, WorkspaceOutline } from "../../api/types";
import type { RunDeckGenerationInput, DeckGenerationRuntime, AuthoringDeck, AuthoringPage, DeckGenerationStream, VisualPlanningContext } from "./types";
import { generationText } from "./messages";
import { buildDeckGenerationSummary, emitRuntime } from "./progressProjection";
import { getAttemptLimits } from "./settings";
import { throwIfCancelled } from "./runtimeSupport";

function logContext(input: RunDeckGenerationInput, domain: "visual_rhythm" | "page_visual_plan", operation: string) {
  const logger = input.aiLogger as AiInteractionLogger | null | undefined;
  return logger ? { logger, workspace_dir: input.workspace.workspace_dir, domain, operation, operation_id: logger.createOperationId(domain, operation), provider: "host", runtime_mode: "host" } : undefined;
}

async function ensureRhythm(input: RunDeckGenerationInput, outline: WorkspaceOutline, research: SharedResearchContextResult, forceRewrite = false) {
  const status = await input.backend.getVisualRhythmStatus({ workspace_dir: input.workspace.workspace_dir });
  if (status.non_empty && !forceRewrite) return;
  const rhythm = await input.aiClient.generateVisualRhythm({
    brief: input.workspace.requirements.source?.brief ?? "",
    requirements: input.workspace.requirements,
    outline,
    styleGuide: (await input.backend.getWorkspaceStyleGuide({ workspace_dir: input.workspace.workspace_dir })).content,
    research,
    refinementRequest: input.refinementRequest,
    currentRhythm: status.non_empty ? (await input.backend.getVisualRhythm({ workspace_dir: input.workspace.workspace_dir })).content : undefined,
    logContext: logContext(input, "visual_rhythm", "generate_visual_rhythm"),
  });
  await input.backend.commitVisualRhythm({ workspace_dir: input.workspace.workspace_dir, content: rhythm });
}

async function generatePageVisualPlanArtifact(input: RunDeckGenerationInput, outline: WorkspaceOutline, page: AuthoringDeck["pages"][number], context: VisualPlanningContext) {
  const current = await input.backend.getPageVisualPlanStatus({ workspace_dir: input.workspace.workspace_dir, page_id: page.page_id });
  const isRefinement = Boolean(input.refinementRequest?.trim() || input.pageRefinementReasons?.[page.page_id]?.trim());
  if (current.non_empty && !isRefinement) return;
  const currentPlan = current.non_empty ? (await input.backend.getPageVisualPlan({ workspace_dir: input.workspace.workspace_dir, page_id: page.page_id })).content : undefined;
  const markdown = await input.aiClient.generatePageVisualPlan({
    brief: input.workspace.requirements.source?.brief ?? "",
    requirements: input.workspace.requirements,
    outline,
    pageId: page.page_id,
    pageIndex: page.index,
    styleGuide: context.styleGuide,
    visualRhythm: context.visualRhythm,
    research: context.research,
    currentPlan,
    refinementRequest: input.pageRefinementReasons?.[page.page_id] ?? input.refinementRequest,
    logContext: logContext(input, "page_visual_plan", "generate_page_visual_plan"),
  });
  await input.backend.commitPageVisualPlan({ workspace_dir: input.workspace.workspace_dir, page_id: page.page_id, content: markdown });
}

export async function prepareDeckVisualPlanning(runtime: DeckGenerationRuntime, authoringDeck: AuthoringDeck, options: { forceRhythmRewrite?: boolean } = {}): Promise<VisualPlanningContext> {
  const text = generationText(runtime.locale);
  const now = new Date().toISOString();
  const stream: DeckGenerationStream = {
    run_id: runtime.aiLogger?.createOperationId("visual_rhythm", "generate_visual_rhythm")
      ?? `visual-rhythm-${Date.now().toString(36)}`,
    kind: "visual-rhythm",
    page_id: "__visual-rhythm__",
    page_index: -1,
    status: text.visualRhythm,
    lines: [],
    activities: [],
    started_at: now,
    updated_at: now,
  };
  const operationId = stream.run_id as string;
  const emitStream = () => {
    stream.updated_at = new Date().toISOString();
    runtime.activeStreams.set(operationId, stream);
    emitRuntime(runtime, {
      step: "visual-rhythm",
      message: text.visualRhythm,
      currentPageIndex: null,
      totalPages: authoringDeck.pages.length,
    }, runtime.getProgress(), stream, getAttemptLimits(runtime));
  };
  emitStream();

  try {
    const research = await runtime.backend.getSharedResearchContext({ workspace_dir: runtime.workspace.workspace_dir });
    await ensureRhythm(runtime, runtime.confirmedOutline, research, options.forceRhythmRewrite);
    throwIfCancelled(runtime);
    const context = {
      styleGuide: (await runtime.backend.getWorkspaceStyleGuide({ workspace_dir: runtime.workspace.workspace_dir })).content,
      visualRhythm: (await runtime.backend.getVisualRhythm({ workspace_dir: runtime.workspace.workspace_dir })).content,
      research,
    };
    stream.status = "completed";
    emitStream();
    return context;
  } catch (error) {
    stream.status = "error";
    stream.lines = [error instanceof Error ? error.message : String(error)];
    emitStream();
    throw error;
  } finally {
    runtime.activeStreams.delete(operationId);
  }
}

async function loadExistingVisualPlanningContext(runtime: DeckGenerationRuntime): Promise<VisualPlanningContext> {
  const [styleGuide, visualRhythm, research] = await Promise.all([
    runtime.backend.getWorkspaceStyleGuide({ workspace_dir: runtime.workspace.workspace_dir }),
    runtime.backend.getVisualRhythm({ workspace_dir: runtime.workspace.workspace_dir }),
    runtime.backend.getSharedResearchContext({ workspace_dir: runtime.workspace.workspace_dir }),
  ]);
  return {
    styleGuide: styleGuide.content,
    visualRhythm: visualRhythm.content,
    research,
  };
}

function pageVisualPlanStream(runtime: DeckGenerationRuntime, page: AuthoringPage): DeckGenerationStream {
  const now = new Date().toISOString();
  return {
    run_id: runtime.aiLogger?.createOperationId("page_visual_plan", "generate_page_visual_plan")
      ?? `page-visual-plan-${page.page_id}-${Date.now().toString(36)}`,
    kind: "page-visual-plan",
    page_id: page.page_id,
    page_index: page.index,
    status: generationText(runtime.locale).pageVisualPlan(page),
    lines: [],
    activities: [],
    started_at: now,
    updated_at: now,
  };
}

function emitPageVisualPlanStream(runtime: DeckGenerationRuntime, page: AuthoringPage, totalPages: number, stream: DeckGenerationStream) {
  stream.updated_at = new Date().toISOString();
  runtime.activeStreams.set(stream.run_id as string, stream);
  emitRuntime(runtime, {
    step: "page-visual-plans",
    message: buildDeckGenerationSummary(runtime, runtime.getProgress(), totalPages),
    currentPageIndex: page.index,
    totalPages,
  }, runtime.getProgress(), stream, getAttemptLimits(runtime));
}

export async function ensurePageVisualPlan(
  runtime: DeckGenerationRuntime,
  authoringDeck: AuthoringDeck,
  page: AuthoringPage,
) {
  throwIfCancelled(runtime);
  const context = runtime.visualPlanningContext ?? await loadExistingVisualPlanningContext(runtime);
  runtime.visualPlanningContext = context;
  const stream = pageVisualPlanStream(runtime, page);
  const operationId = stream.run_id as string;
  emitPageVisualPlanStream(runtime, page, authoringDeck.pages.length, stream);

  try {
    await generatePageVisualPlanArtifact(runtime, runtime.confirmedOutline, page, context);
    throwIfCancelled(runtime);
    stream.status = "completed";
    emitPageVisualPlanStream(runtime, page, authoringDeck.pages.length, stream);
  } catch (error) {
    stream.status = "error";
    stream.lines = [error instanceof Error ? error.message : String(error)];
    emitPageVisualPlanStream(runtime, page, authoringDeck.pages.length, stream);
    throw error;
  } finally {
    runtime.activeStreams.delete(operationId);
  }
}
