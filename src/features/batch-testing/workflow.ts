import type { ImageAttachmentBriefClient } from "../../ai/imageAttachmentBriefTest";
import { assignOutlineImages } from "../outline/imageAssignment";
import { availableOutlineImages } from "../outline/images";
import { isMainWorkflowAttachmentSource } from "../../ai/attachmentBriefPolicy";
import type { AgentClient } from "../../agent/agentClient";
import type { AttachmentBriefCompletionClient } from "../../ai/attachmentBriefCompletion";
import type { AiClient } from "../../ai/aiClient";
import type { AiInteractionLogger, AiOperationLogContext } from "../../ai/interactionLog";
import type { ResearchAiClient } from "../../ai/researchAiClient";
import type { PageRefinementClassifier } from "../../ai/pageRefinementClassifier";
import { toPerfReportLocale, type PptBackend } from "../../api/pptBackend";
import type { ResearchWebClient } from "../../api/researchWebClient";
import type {
  BatchTestCaseInput,
  BatchTestCaseRecord,
  BatchTestRunRecord,
  PresentationRequirements,
  WorkspaceOutline,
  WorkspaceResult,
  PerformanceOperationMetric,
} from "../../api/types";
import { ensureAttachmentBriefs } from "../deck-generation/attachmentBriefWorkflow";
import type { Locale } from "../../i18n/messages";
import { pickLocale } from "../../i18n/locales";
import { beginPerformanceSpan } from "../../performance/performanceRecorder";
import type { AppHostUploadClient } from "../../runtime/appHostUploadClient";
import { runDeckGeneration, runParallelSharedResearch } from "../deck-generation";
import {
  ensureFreshUploadedSourceAnalysis,
} from "../deck-generation/uploadedSourceAnalysisWorkflow";
import {
  renderUploadedSourceAnalysisMarkdown,
} from "../deck-generation/uploadedSourceAnalysis";
import { normalizeValidOutline } from "../outline";
import { formatWebResearchRequirements } from "../../ai/requirementsFormatting";
import { createRequirementsDraft } from "../requirements";
import {
  findVisualStylePreset,
  loadVisualStylePresetReferenceHtmlPages,
  toVisualStylePresetSelection,
  VISUAL_STYLE_PRESETS,
} from "../templates/visualStylePresets";
import { recommendVisualStylePresetWithIntent } from "../templates/visualStylePresetRecommendation";
import { expandBatchTestInput } from "./input";
import { assertBatchTestResumeCompatible } from "./resume";
import { batchTestTargetIncludes, type BatchTestInput } from "./types";
import { prepareBatchTestRunCreationInput } from "./createRunInput";
import { applyImageResearchFlag } from "../requirements/presentationRequirements";

export interface BatchTestWorkflowDependencies {
  backend: PptBackend;
  aiClient: AiClient;
  researchAiClient: ResearchAiClient;
  pageRefinementClassifier: PageRefinementClassifier;
  researchWebClient: ResearchWebClient;
  agentClient: AgentClient;
  hostUploadClient: AppHostUploadClient;
  attachmentBriefCompletionClient?: AttachmentBriefCompletionClient;
  imageBriefClient?: ImageAttachmentBriefClient;
  aiLogger: AiInteractionLogger | null;
  locale: Locale;
  appVersion: string;
  signal: AbortSignal;
  onRun: (run: BatchTestRunRecord) => void;
  onProgress: (caseId: string | null, step: string) => void;
  frozenRequirementsByBaseline?: Map<string, PresentationRequirements>;
}

function aggregatePerformanceMetrics(cases: BatchTestCaseRecord[]): PerformanceOperationMetric[] {
  const map = new Map<string, PerformanceOperationMetric>();
  for (const item of cases) for (const metric of item.performance_metrics ?? []) {
    const current = map.get(metric.operation_name) ?? { operation_name: metric.operation_name, count: 0, wall_clock_ms: 0, total_duration_ms: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, calls: 0 };
    current.count += metric.count; current.wall_clock_ms += metric.wall_clock_ms; current.total_duration_ms += metric.total_duration_ms;
    current.input_tokens += metric.input_tokens; current.output_tokens += metric.output_tokens; current.total_tokens += metric.total_tokens; current.calls += metric.calls;
    map.set(metric.operation_name, current);
  }
  return [...map.values()].sort((a, b) => b.total_duration_ms - a.total_duration_ms);
}

class BatchTestCancelledError extends Error {
  constructor() {
    super("Batch test was cancelled.");
    this.name = "BatchTestCancelledError";
  }
}

function throwIfCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new BatchTestCancelledError();
}

async function measureBatchOperation<T>(
  operationName: string,
  workspaceDir: string,
  task: () => Promise<T>,
): Promise<T> {
  const span = beginPerformanceSpan({
    operationName,
    workspaceId: workspaceDir.split(/[\\/]/).filter(Boolean).at(-1),
    attributes: { layer: "workflow" },
  });
  try {
    const result = await task();
    span?.finish("ok");
    return result;
  } catch (error) {
    span?.finish(error instanceof BatchTestCancelledError ? "interrupted" : "error");
    throw error;
  }
}

function logContext(
  dependencies: BatchTestWorkflowDependencies,
  workspace: WorkspaceResult,
  domain: AiOperationLogContext["domain"],
  operation: string,
): AiOperationLogContext | undefined {
  const logger = dependencies.aiLogger;
  if (!logger) return undefined;
  return {
    logger,
    workspace_dir: workspace.workspace_dir,
    domain,
    operation,
    operation_id: logger.createOperationId(domain, operation),
    provider: "anna",
    runtime_mode: "anna",
  };
}

function outlineForGeneration(workspace: WorkspaceResult): WorkspaceOutline {
  const outline = workspace.outline as WorkspaceOutline;
  const outputLanguage = workspace.requirements.selections.output_language ?? "中文";
  const setting = workspace.setting && typeof workspace.setting === "object" && !Array.isArray(workspace.setting)
    ? { ...(workspace.setting as Record<string, unknown>) }
    : {};
  delete setting.audience;
  delete setting.goal;
  delete setting.style_notes;
  delete setting.slide_count;
  return {
    ...outline,
    output_language: outputLanguage,
    source: {
      prompt: workspace.requirements.source?.brief ?? "",
      context: [],
      setting: { ...setting, output_language: outputLanguage },
    },
  };
}

async function selectPreset(
  dependencies: BatchTestWorkflowDependencies,
  brief: string,
  workspace?: WorkspaceResult,
) {
  throwIfCancelled(dependencies.signal);
  const recommendation = await recommendVisualStylePresetWithIntent({
    brief,
    presets: VISUAL_STYLE_PRESETS,
    analyzeIntent: () => dependencies.aiClient.analyzeVisualStylePresetRecommendationIntent({
      brief,
      logContext: workspace ? logContext(dependencies, workspace, "requirements", "analyze_template_recommendation_intent") : undefined,
    }),
  });
  throwIfCancelled(dependencies.signal);
  return recommendation;
}

async function prepareRequirementsDraft(
  dependencies: BatchTestWorkflowDependencies,
  workspace: WorkspaceResult,
  brief: string,
) {
  const attachmentContext = await dependencies.backend.getAttachmentContext({ workspace_dir: workspace.workspace_dir }).catch(() => null);
  dependencies.onProgress(workspace.workspace_id, "requirements");
  const outputLanguage = await dependencies.aiClient.detectOutputLanguage({
    brief,
    logContext: logContext(dependencies, workspace, "requirements", "detect_output_language"),
  });
  throwIfCancelled(dependencies.signal);
  const generated = await dependencies.aiClient.generatePresentationRequirements({
    brief,
    outputLanguage: outputLanguage.output_language,
    attachmentContext,
    logContext: logContext(dependencies, workspace, "requirements", "generate_requirements"),
  });
  const candidates = { ...generated, output_language: [outputLanguage.output_language] };
  const recommendation = await selectPreset(dependencies, brief, workspace);
  return createRequirementsDraft(brief, candidates, toVisualStylePresetSelection(recommendation.preset));
}

async function prepareBatchAttachments(
  dependencies: BatchTestWorkflowDependencies,
  workspace: WorkspaceResult,
  batchCase: BatchTestCaseRecord,
): Promise<void> {
  if (!batchCase.attachments?.length) return;
  dependencies.onProgress(batchCase.case_id, "attachment-upload");
  await measureBatchOperation("attachment.import", workspace.workspace_dir, async () => {
    for (const attachment of batchCase.attachments ?? []) {
      await dependencies.backend.commitUploadedSourceHostUpload({
        workspace_dir: workspace.workspace_dir,
        filename: attachment.filename,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
        host_upload: attachment.host_upload,
      });
      throwIfCancelled(dependencies.signal);
    }
  });
  const activeSources = (await dependencies.backend.listUploadedSources({
    workspace_dir: workspace.workspace_dir,
    include_removed: false,
  })).active.filter(isMainWorkflowAttachmentSource);
  if (activeSources.length === 0) return;
  if (!dependencies.attachmentBriefCompletionClient) throw new Error("Attachment analysis is unavailable for this batch test.");
  await measureBatchOperation("attachment.analysis", workspace.workspace_dir, async () => {
    dependencies.onProgress(batchCase.case_id, "attachment-preflight");
    let preflightRun = await dependencies.backend.runUploadedSourcePreflight({ workspace_dir: workspace.workspace_dir });
    throwIfCancelled(dependencies.signal);
    if (preflightRun.results.some((result) => result.pdf_ocr_progress?.status === "processing")) {
      const runtimeInfo = await dependencies.backend.getRuntimeInfo();
      if (!runtimeInfo.uploaded_source_preflight?.pdf_ocr_continuation) {
        throw new Error(pickLocale(dependencies.locale, {
          zh: "当前 PPT 引擎不支持 PDF 文字识别续跑，请更新引擎后重试。",
          en: "The connected PPT engine does not support PDF OCR continuation. Update the engine and retry.",
          ja: "接続中の PPT エンジンは PDF 文字認識の続行に対応していません。エンジンを更新してから再試行してください。",
          de: "Die verbundene PPT-Engine unterstützt die Fortsetzung der PDF-Texterkennung nicht. Aktualisieren Sie die Engine und versuchen Sie es erneut.",
        }));
      }
    }
    while (preflightRun.results.some((result) => result.pdf_ocr_progress?.status === "processing")) {
      throwIfCancelled(dependencies.signal);
      dependencies.onProgress(batchCase.case_id, "attachment-ocr");
      const continuation = await dependencies.backend.continueUploadedSourcePdfOcr({ workspace_dir: workspace.workspace_dir });
      preflightRun = { ...preflightRun, results: continuation.results };
    }
    throwIfCancelled(dependencies.signal);
    dependencies.onProgress(batchCase.case_id, "attachment-context");
    await ensureAttachmentBriefs({
      backend: dependencies.backend,
      completionClient: dependencies.attachmentBriefCompletionClient!,
      imageBriefClient: dependencies.imageBriefClient,
      aiLogger: dependencies.aiLogger,
      workspace,
      userBrief: batchCase.brief,
      preflightRun,
    });
    throwIfCancelled(dependencies.signal);
  });
}

async function analyzeBatchUploadedSources(
  dependencies: BatchTestWorkflowDependencies,
  workspace: WorkspaceResult,
): Promise<string | undefined> {
  if (!dependencies.agentClient) throw new Error("Uploaded Source Analysis is unavailable for this batch test.");
  try {
    const analysis = await measureBatchOperation("uploaded_source.analysis", workspace.workspace_dir, () =>
      ensureFreshUploadedSourceAnalysis({
        backend: dependencies.backend,
        agentClient: dependencies.agentClient,
        aiLogger: dependencies.aiLogger,
        workspace,
      }),
    );
    return analysis ? renderUploadedSourceAnalysisMarkdown(analysis) : undefined;
  } catch (error) {
    // The UI flow treats the rich C-line as a degraded, non-blocking gate for
    // Outline/Web prompts. Preserve that behavior in headless batch runs while
    // retaining the failed span in the performance report.
    console.warn("Uploaded source analysis unavailable for batch prompts", error);
    return undefined;
  }
}

async function confirmRecommendedRequirements(
  dependencies: BatchTestWorkflowDependencies,
  workspace: WorkspaceResult,
  brief: string,
) {
  const draftWithPreset = await prepareRequirementsDraft(dependencies, workspace, brief);
  const preset = findVisualStylePreset(draftWithPreset.selections.visual_style_preset?.id ?? "");
  if (!preset) throw new Error("The selected Visual Style Preset is unavailable.");
  const research = applyImageResearchFlag(await dependencies.researchAiClient.recommendResearch({
    brief,
    requirements: draftWithPreset,
    attachmentContext: await dependencies.backend.getAttachmentContext({ workspace_dir: workspace.workspace_dir }).catch(() => null),
    locale: dependencies.locale,
    logContext: logContext(dependencies, workspace, "requirements", "recommend_research"),
  }));
  throwIfCancelled(dependencies.signal);
  const now = new Date().toISOString();
  const confirmed: PresentationRequirements = {
    ...draftWithPreset,
    research,
    status: "confirmed",
    updated_at: now,
    confirmed_at: now,
  };
  await dependencies.backend.updateWorkspaceRequirements({
    workspace_dir: workspace.workspace_dir,
    requirements: { ...draftWithPreset, research },
  });
  const snapshot = {
    version: 1,
    preset: toVisualStylePresetSelection(preset)!,
    reference_html_pages: await loadVisualStylePresetReferenceHtmlPages(preset),
  };
  return dependencies.backend.confirmWorkspaceRequirements({
    workspace_dir: workspace.workspace_dir,
    requirements: confirmed,
    template_snapshot: snapshot,
  }).then((result) => result.workspace);
}

async function confirmFrozenRequirements(
  dependencies: BatchTestWorkflowDependencies,
  workspace: WorkspaceResult,
  brief: string,
  frozenRequirements: PresentationRequirements,
) {
  const preset = (await selectPreset(dependencies, brief, workspace)).preset;
  const draftWithPreset: PresentationRequirements = {
    ...structuredClone(frozenRequirements),
    source: { brief },
    status: "draft",
    selections: {
      ...structuredClone(frozenRequirements.selections),
      visual_style_preset: toVisualStylePresetSelection(preset),
    },
    confirmed_at: null,
  };
  const now = new Date().toISOString();
  const confirmed: PresentationRequirements = {
    ...draftWithPreset,
    status: "confirmed",
    updated_at: now,
    confirmed_at: now,
  };
  await dependencies.backend.updateWorkspaceRequirements({
    workspace_dir: workspace.workspace_dir,
    requirements: draftWithPreset,
  });
  const snapshot = {
    version: 1,
    preset: toVisualStylePresetSelection(preset)!,
    reference_html_pages: await loadVisualStylePresetReferenceHtmlPages(preset),
  };
  return dependencies.backend.confirmWorkspaceRequirements({
    workspace_dir: workspace.workspace_dir,
    requirements: confirmed,
    template_snapshot: snapshot,
  }).then((result) => result.workspace);
}

async function confirmBatchRequirements(
  dependencies: BatchTestWorkflowDependencies,
  workspace: WorkspaceResult,
  batchCase: BatchTestCaseRecord,
) {
  const frozen = dependencies.frozenRequirementsByBaseline;
  const baselineId = batchCase.brief_id;
  const existing = frozen?.get(baselineId);
  if (existing) {
    dependencies.onProgress(workspace.workspace_id, "requirements-reused");
    return confirmFrozenRequirements(dependencies, workspace, batchCase.brief, existing);
  }
  const confirmedWorkspace = await confirmRecommendedRequirements(dependencies, workspace, batchCase.brief);
  frozen?.set(baselineId, structuredClone(confirmedWorkspace.requirements));
  return confirmedWorkspace;
}

/**
 * Outline evaluation fixtures deliberately skip Requirements generation,
 * style selection, and research routing. The supplied Requirements document
 * is already confirmed and has both research channels disabled.
 */
async function useProvidedOutlineRequirements(
  dependencies: BatchTestWorkflowDependencies,
  workspace: WorkspaceResult,
  requirements: PresentationRequirements,
) {
  throwIfCancelled(dependencies.signal);
  dependencies.onProgress(workspace.workspace_id, "requirements-provided");
  if (requirements.status !== "confirmed" || !requirements.source?.brief.trim()) {
    throw new Error("Provided outline Requirements must be confirmed and include source.brief.");
  }
  if (requirements.research.web.enabled !== false || requirements.research.images.enabled !== false) {
    throw new Error("Provided outline Requirements must disable Web and image research.");
  }
  return dependencies.backend.updateWorkspaceRequirements({
    workspace_dir: workspace.workspace_dir,
    requirements: structuredClone(requirements),
  });
}

async function runResearchRoutingCase(
  dependencies: BatchTestWorkflowDependencies,
  workspace: WorkspaceResult,
  batchCase: BatchTestCaseRecord,
) {
  const routing = batchCase.research_routing;
  if (!routing) throw new Error("Research routing metadata is missing.");
  dependencies.onProgress(workspace.workspace_id, "research-routing");
  const frozen = dependencies.frozenRequirementsByBaseline ?? new Map<string, PresentationRequirements>();
  let requirements = frozen.get(routing.baseline_id);
  if (!requirements) {
    requirements = await prepareRequirementsDraft(dependencies, workspace, batchCase.brief);
    frozen.set(routing.baseline_id, requirements);
  }
  const decision = await dependencies.researchAiClient.recommendResearchForEvaluation({
    brief: batchCase.brief,
    requirements: structuredClone(requirements),
    attachmentContext: await dependencies.backend.getAttachmentContext({ workspace_dir: workspace.workspace_dir }).catch(() => null),
    locale: dependencies.locale,
    promptTemplate: routing.prompt,
    promptVersion: routing.prompt_version,
    logContext: logContext(dependencies, workspace, "requirements", "recommend_research_eval"),
  });
  throwIfCancelled(dependencies.signal);
  if (typeof decision.research.web.recommended !== "boolean" || typeof decision.research.images.recommended !== "boolean") {
    throw new Error("Research routing evaluation returned an incomplete recommendation.");
  }
  const now = new Date().toISOString();
  const updatedWorkspace = await dependencies.backend.updateWorkspaceRequirements({
    workspace_dir: workspace.workspace_dir,
    requirements: {
      ...structuredClone(requirements),
      research: decision.research,
      status: "confirmed",
      updated_at: now,
      confirmed_at: now,
    },
  });
  return {
    workspace: updatedWorkspace,
    result: {
      actual: {
        web: decision.research.web.recommended,
        images: decision.research.images.recommended,
      },
      requested_model: routing.requested_model ?? null,
      actual_model: decision.actual_model,
      latency_ms: decision.latency_ms,
      token_usage: decision.token_usage,
      json_repair_count: decision.json_repair_count,
      retry_count: decision.retry_count,
      retry_reasons: decision.retry_reasons,
    },
  };
}

async function runPageRefinementClassificationCase(
  dependencies: BatchTestWorkflowDependencies,
  batchCase: BatchTestCaseRecord,
) {
  const classification = batchCase.page_refinement_classification;
  if (!classification) throw new Error("Page refinement classification metadata is missing.");
  dependencies.onProgress(batchCase.case_id, "page-refinement-classification");
  const decision = await dependencies.pageRefinementClassifier.classifyForEvaluation({
    request: batchCase.brief,
    locale: dependencies.locale,
    promptTemplate: classification.prompt,
  });
  throwIfCancelled(dependencies.signal);
  return {
    actual: decision.classification,
    requested_model: classification.requested_model ?? null,
    actual_model: decision.actual_model,
    latency_ms: decision.latency_ms,
    token_usage: decision.token_usage,
    json_repair_count: decision.json_repair_count,
    retry_count: decision.retry_count,
    retry_reasons: decision.retry_reasons,
  };
}

function enrichResearchRoutingTransportRun(
  run: BatchTestRunRecord,
  sourceCaseById: ReadonlyMap<string, BatchTestCaseInput>,
) {
  if (run.target_stage !== "research-routing-completed") return run;
  return {
    ...run,
    cases: run.cases.map((storedItem) => {
      const sourceItem = sourceCaseById.get(storedItem.case_id);
      return sourceItem ? { ...storedItem, ...sourceItem } : storedItem;
    }),
  };
}

async function runWebResearch(
  dependencies: BatchTestWorkflowDependencies,
  workspace: WorkspaceResult,
  uploadedSourceAnalysisContext?: string,
) {
  dependencies.onProgress(workspace.workspace_id, "web-research");
  let progress = await dependencies.backend.getPageProgress({ workspace_dir: workspace.workspace_dir });
  await runParallelSharedResearch({
    backend: dependencies.backend,
    aiClient: dependencies.aiClient,
    researchWebClient: dependencies.researchWebClient,
    agentClient: dependencies.agentClient,
    hostUploadClient: dependencies.hostUploadClient,
    aiLogger: dependencies.aiLogger,
    workspace,
    attachmentContext: await dependencies.backend.getAttachmentContext({ workspace_dir: workspace.workspace_dir }).catch(() => null),
    confirmedOutline: outlineForGeneration(workspace),
    locale: dependencies.locale,
    onProgress: () => undefined,
    isCancelled: () => dependencies.signal.aborted,
    cancelSignal: dependencies.signal,
    activeStreams: new Map(),
    getProgress: () => progress,
    setProgress: (nextProgress) => { progress = nextProgress; },
  }, {
    resume: false,
    webEnabled: workspace.requirements.research.web.enabled === true,
    imageEnabled: workspace.requirements.research.images.enabled === true,
    publishToPageProgress: false,
    webBrief: workspace.requirements.source?.brief,
    webRequirementsText: formatWebResearchRequirements(workspace.requirements),
    webUploadedSourceAnalysis: uploadedSourceAnalysisContext,
  });
  throwIfCancelled(dependencies.signal);
}

async function createOutline(
  dependencies: BatchTestWorkflowDependencies,
  workspace: WorkspaceResult,
  uploadedSourceAnalysisContext?: string,
) {
  throwIfCancelled(dependencies.signal);
  dependencies.onProgress(workspace.workspace_id, "outline");
  const result = await dependencies.aiClient.generateOutline({
    requirements: workspace.requirements,
    uploadedSourceAnalysisContext,
    attachmentContext: await dependencies.backend.getAttachmentContext({ workspace_dir: workspace.workspace_dir }).catch(() => null),
    webResearchSummary: (await dependencies.backend.getSharedResearchContext({ workspace_dir: workspace.workspace_dir }).catch(() => ({ web_summary: "" }))).web_summary,
    logContext: logContext(dependencies, workspace, "outline", "generate_outline"),
  });
  throwIfCancelled(dependencies.signal);
  const outline = await assignOutlineImages({
    agent: dependencies.agentClient, requirements: workspace.requirements,
    outline: normalizeValidOutline(result.outline),
    assets: availableOutlineImages(await dependencies.backend.getSharedResearchContext({ workspace_dir: workspace.workspace_dir })),
    options: { signal: dependencies.signal, isCancelled: () => dependencies.signal.aborted,
      logContext: logContext(dependencies, workspace, "outline", "assign_images") },
  });
  throwIfCancelled(dependencies.signal);
  return dependencies.backend.saveWorkspaceOutlineDraft({
    workspace_dir: workspace.workspace_dir,
    outline,
  });
}

async function confirmOutline(
  dependencies: BatchTestWorkflowDependencies,
  workspace: WorkspaceResult,
) {
  dependencies.onProgress(workspace.workspace_id, "outline-confirmation");
  const draft = workspace.outline as WorkspaceOutline;
  return measureBatchOperation("outline.confirm", workspace.workspace_dir, () => dependencies.backend.confirmWorkspaceOutline({
    workspace_dir: workspace.workspace_dir,
    outline: normalizeValidOutline(draft),
  }));
}

async function generateAndExport(
  dependencies: BatchTestWorkflowDependencies,
  workspace: WorkspaceResult,
) {
  let transaction: Awaited<ReturnType<PptBackend["beginGenerationRun"]>> | null = null;
  let committed = false;
  try {
    dependencies.onProgress(workspace.workspace_id, "generation-prepare");
    transaction = await dependencies.backend.beginGenerationRun({
      workspace_dir: workspace.workspace_dir,
      run_kind: "deck-generation",
    });
    const prepared = await dependencies.backend.prepareGenerationRun({ run_id: transaction.run_id });
    if (!prepared.workspace || prepared.transaction.state !== "active") {
      throw new Error("Batch generation shadow Workspace was not prepared.");
    }
    const confirmedWorkspace = await confirmOutline(dependencies, prepared.workspace);
    dependencies.onProgress(workspace.workspace_id, "generation");
    const completion = await measureBatchOperation("generation.run", confirmedWorkspace.workspace_dir, () => runDeckGeneration({
      backend: dependencies.backend,
      aiClient: dependencies.aiClient,
      researchWebClient: dependencies.researchWebClient,
      agentClient: dependencies.agentClient,
      hostUploadClient: dependencies.hostUploadClient,
      aiLogger: dependencies.aiLogger,
      workspace: confirmedWorkspace,
      confirmedOutline: outlineForGeneration(confirmedWorkspace),
      locale: dependencies.locale,
      startMode: "new",
      onProgress: () => dependencies.onProgress(workspace.workspace_id, "generation"),
      isCancelled: () => dependencies.signal.aborted,
      cancelSignal: dependencies.signal,
      // Web research is completed before Outline in the main flow. Resume
      // from that checkpoint so generation only performs the remaining image
      // research branch instead of issuing duplicate Web searches.
      resumeResearch: true,
    }));
    if (completion.status === "cancelled") throw new BatchTestCancelledError();
    if (completion.status === "failed") throw new Error(completion.error.message);
    const commit = await dependencies.backend.commitGenerationRun({ run_id: transaction.run_id });
    committed = true;
    dependencies.onProgress(workspace.workspace_id, "pptx-export");
    const exported = await measureBatchOperation("pptx_export.run", commit.workspace.workspace_dir, () => dependencies.backend.runPptxExport({
      workspace_dir: commit.workspace.workspace_dir,
      signal: dependencies.signal,
    }));
    if (exported.status !== "completed" || !exported.pptx_path) {
      throw new Error(exported.error?.message ?? "PPTX export did not complete.");
    }
    return exported.pptx_path;
  } finally {
    if (transaction) {
      if (committed) {
        await dependencies.backend.cleanupGenerationRun({ run_id: transaction.run_id }).catch(() => undefined);
      } else {
        await dependencies.backend.abandonGenerationRun({ run_id: transaction.run_id }).catch(() => undefined);
      }
    }
  }
}

async function runCase(
  dependencies: BatchTestWorkflowDependencies,
  batchRun: BatchTestRunRecord,
  batchCase: BatchTestCaseRecord,
) {
  const caseDependencies: BatchTestWorkflowDependencies = {
    ...dependencies,
    onProgress: (_caseId, step) => dependencies.onProgress(batchCase.case_id, step),
  };
  if (batchRun.target_stage === "template-recommendation-completed") {
    dependencies.onProgress(batchCase.case_id, "template-recommendation");
    const recommendation = await selectPreset(caseDependencies, batchCase.brief);
    const preset = toVisualStylePresetSelection(recommendation.preset);
    if (!preset) throw new Error("Template recommendation did not return a selectable preset.");
    return {
      pptxPath: null,
      researchRoutingResult: null,
      pageRefinementClassificationResult: null,
      templateRecommendationResult: {
        preset,
        trace: recommendation.trace,
      },
    };
  }
  let performanceRunId: string | null = null;
  let outcomeError: unknown = null;
  let pptxPath: string | null = null;
  let researchRoutingResult: BatchTestCaseRecord["research_routing_result"] = null;
  let pageRefinementClassificationResult: BatchTestCaseRecord["page_refinement_classification_result"] = null;
  let tokenUsage: BatchTestCaseRecord["token_usage"] = null;
  try {
    throwIfCancelled(dependencies.signal);
    const performanceRun = await dependencies.backend.startPerformanceRun({
      app_version: dependencies.appVersion,
      environment: {
        mode: "batch-test",
        test_id: batchRun.test_id,
        case_id: batchCase.case_id,
        target_stage: batchRun.target_stage,
      },
      initial_settings: {
        repeat: batchCase.repetition,
        total_repetitions: batchCase.total_repetitions,
        target_stage: batchRun.target_stage,
      },
    });
    performanceRunId = performanceRun.run_id;
    const span = beginPerformanceSpan({
      operationName: "batch.case",
      workspaceId: batchCase.workspace_id,
      attributes: {
        layer: "workflow",
        test_id: batchRun.test_id,
        case_id: batchCase.case_id,
        target_stage: batchRun.target_stage,
      },
    });
    try {
      if (batchRun.target_stage === "page-refinement-classification-completed") {
        pageRefinementClassificationResult = await measureBatchOperation(
          "page_refinement.classification",
          batchCase.workspace_dir,
          () => runPageRefinementClassificationCase(caseDependencies, batchCase),
        );
      } else {
        let workspace = await dependencies.backend.openWorkspace({ workspace_dir: batchCase.workspace_dir });
        if (batchRun.target_stage === "attachment-context-created" && !batchCase.attachments?.length) {
          throw new Error(pickLocale(dependencies.locale, {
            zh: "附件专项测试至少需要一个附件。",
            en: "Attachment-only tests require at least one attachment.",
            ja: "添付ファイル専用テストには少なくとも 1 つの添付ファイルが必要です。",
            de: "Für reine Anhangstests ist mindestens ein Anhang erforderlich.",
          }));
        }
        await prepareBatchAttachments(caseDependencies, workspace, batchCase);
        if (batchRun.target_stage !== "attachment-context-created") {
          const shouldAnalyzeUploadedSources = Boolean(batchCase.attachments?.length)
            && batchTestTargetIncludes(batchRun.target_stage, "web-research-completed");
          // The interactive flow kicks off the rich C-line before the pre-Outline
          // gate. Keep the promise scoped to this case and await it after
          // Requirements, so the headless path has the same gating semantics.
          const uploadedSourceAnalysisPromise = shouldAnalyzeUploadedSources
            ? analyzeBatchUploadedSources(caseDependencies, workspace)
            : null;
          const requirementsWorkspace = workspace;
          if (batchCase.provided_requirements) {
            workspace = await measureBatchOperation(
              "requirements.provided",
              requirementsWorkspace.workspace_dir,
              () => useProvidedOutlineRequirements(caseDependencies, requirementsWorkspace, batchCase.provided_requirements!),
            );
          } else if (batchCase.research_routing) {
            const routingOutcome = await measureBatchOperation("research.routing", requirementsWorkspace.workspace_dir, () => runResearchRoutingCase(caseDependencies, requirementsWorkspace, batchCase));
            researchRoutingResult = routingOutcome.result;
            workspace = routingOutcome.workspace;
          } else {
            workspace = await measureBatchOperation("requirements.create", requirementsWorkspace.workspace_dir, () => confirmBatchRequirements(caseDependencies, requirementsWorkspace, batchCase));
          }

          // Match the main flow's blocking pre-outline gate: Requirements are
          // prepared first, then the complete factual/visual uploaded-source
          // analysis is awaited and supplied to Web Research and Outline.
          const uploadedSourceAnalysisContext = uploadedSourceAnalysisPromise
            ? await uploadedSourceAnalysisPromise
            : undefined;

          const targetNeedsResearch = batchRun.target_stage === "web-research-completed" ||
            batchRun.target_stage === "image-research-completed";
          const targetIncludesWebResearch = batchTestTargetIncludes(batchRun.target_stage, "web-research-completed");
          if (targetIncludesWebResearch) {
            await runWebResearch(caseDependencies, workspace, uploadedSourceAnalysisContext);
          }
          if (batchRun.target_stage !== "research-routing-completed" && batchRun.target_stage !== "web-research-completed" && batchRun.target_stage !== "image-research-completed" && (targetNeedsResearch || batchTestTargetIncludes(batchRun.target_stage, "outline-confirmed"))) {
            const outlineWorkspace = workspace;
            workspace = await measureBatchOperation("outline.create", outlineWorkspace.workspace_dir, () => createOutline(caseDependencies, outlineWorkspace, uploadedSourceAnalysisContext));
            if (batchRun.target_stage === "outline-confirmed" || targetNeedsResearch) {
              workspace = await confirmOutline(caseDependencies, workspace);
            }
          }

          if (batchRun.target_stage === "pptx-exported") {
            pptxPath = await generateAndExport(caseDependencies, workspace);
          }
        }
      }
      span?.finish("ok");
    } catch (error) {
      span?.finish(error instanceof BatchTestCancelledError ? "interrupted" : "error");
      throw error;
    }
  } catch (error) {
    outcomeError = error;
  }

  if (performanceRunId) {
    try {
      const finalized = await dependencies.backend.finalizePerformanceRun({
        run_id: performanceRunId,
        locale: toPerfReportLocale(dependencies.locale),
        force: true,
      });
        tokenUsage = finalized.run.token_usage ?? null;
      const metrics = finalized.run.operation_metrics ?? null;
      await dependencies.backend.updateBatchTestCase({
        root_dir: batchRun.root_dir,
        case_id: batchCase.case_id,
        status: "running",
        token_usage: tokenUsage,
        performance_metrics: metrics,
      }).catch((error) => {
        console.warn("Failed to persist batch test token usage", error);
      });
      if (finalized.run.status !== "completed" || !finalized.run.report_available) {
        throw new Error("Performance report was not generated for the batch test case.");
      }
      const materialized = await dependencies.backend.materializePerformanceRun({
        run_id: performanceRunId,
        destination_dir: batchCase.performance_dir,
      });
      if (!materialized.files.some((file) => file.endsWith("/report.html") || file.endsWith("\\report.html"))) {
        throw new Error("Performance report was not copied into the batch test case.");
      }
    } catch (error) {
      await dependencies.backend.abandonPerformanceRun({ run_id: performanceRunId }).catch(() => undefined);
      await dependencies.backend.materializePerformanceRun({
        run_id: performanceRunId,
        destination_dir: batchCase.performance_dir,
      }).catch(() => undefined);
      outcomeError ??= error;
    }
  }

  if (outcomeError) throw outcomeError;
  if (batchRun.target_stage === "pptx-exported" && !pptxPath) {
    throw new Error("Batch case completed without a PPTX path.");
  }
  return { pptxPath, researchRoutingResult, pageRefinementClassificationResult, templateRecommendationResult: null };
}

export async function runBatchTestWorkflow(
  input: BatchTestInput,
  dependencies: BatchTestWorkflowDependencies,
  options: { resumeRun?: BatchTestRunRecord } = {},
) {
  const workflowDependencies: BatchTestWorkflowDependencies = input.target_stage === "research-routing-completed" || input.reuse_requirements
    ? { ...dependencies, frozenRequirementsByBaseline: new Map<string, PresentationRequirements>() }
    : dependencies;
  const existingPerformance = await workflowDependencies.backend.listPerformanceRuns();
  if (existingPerformance.active_run) {
    throw new Error("Finish or abandon the active Performance Run before starting a batch test.");
  }
  const expandedCases = options.resumeRun
    ? assertBatchTestResumeCompatible(input, options.resumeRun, workflowDependencies.locale)
    : expandBatchTestInput(input, workflowDependencies.locale);
  const sourceCaseById = new Map(expandedCases.map((item) => [item.case_id, item]));
  const created = options.resumeRun
    ? null
    : await workflowDependencies.backend.createBatchTestRun(
      await prepareBatchTestRunCreationInput(
        input,
        expandedCases,
      ),
    );
  let run = options.resumeRun ?? created!.run;
  const publishRun = () => workflowDependencies.onRun(enrichResearchRoutingTransportRun(run, sourceCaseById));
  const reloadRun = async () => {
    const listed = await workflowDependencies.backend.listBatchTestRuns();
    const stored = listed.runs.find((entry) => entry.root_dir === run.root_dir);
    if (!stored) throw new Error("Batch test disappeared while recovering a lost response.");
    return stored;
  };
  // Mutations commit before their uploaded response is downloaded. Recover by
  // reading the stored state instead of treating a lost receipt as task failure.
  const persist = async (
    mutation: () => Promise<BatchTestRunRecord>,
    committed: (stored: BatchTestRunRecord) => boolean,
  ): Promise<BatchTestRunRecord> => {
    try {
      run = await mutation();
      return run;
    } catch (error) {
      const stored = await reloadRun().catch(() => null);
      if (stored) {
        run = stored;
        if (committed(stored)) return stored;
      }
      throw error;
    }
  };
  const updateCase = (update: Parameters<PptBackend["updateBatchTestCase"]>[0]) => persist(
    () => workflowDependencies.backend.updateBatchTestCase(update),
    (stored) => stored.cases.some((item) => item.case_id === update.case_id && item.status === update.status),
  );
  const updateRun = (status: BatchTestRunRecord["status"], withMetrics = false) => persist(
    () => workflowDependencies.backend.updateBatchTestRun({
      root_dir: run.root_dir,
      status,
      ...(withMetrics ? { performance_metrics: aggregatePerformanceMetrics(run.cases) } : {}),
    }),
    (stored) => stored.status === status,
  );
  const terminalStatus = (): BatchTestRunRecord["status"] => {
    const completed = run.cases.filter((item) => item.status === "completed").length;
    return completed === run.cases.length ? "completed" : completed > 0 ? "partial_failure" : "failed";
  };
  let cancelled = false;
  try {
    run = await updateRun("running");
    publishRun();
    for (const storedItem of run.cases) {
      const sourceItem = sourceCaseById.get(storedItem.case_id);
      const item = sourceItem && (
        sourceItem.provided_requirements
        || sourceItem.attachments
        || (input.target_stage === "research-routing-completed" && sourceItem.research_routing)
        || (input.target_stage === "page-refinement-classification-completed" && sourceItem.page_refinement_classification)
      ) ? { ...storedItem, ...sourceItem } : storedItem;
      if (storedItem.status === "completed") continue;
      if (dependencies.signal.aborted) {
        cancelled = true;
        break;
      }
      run = await updateCase({ root_dir: run.root_dir, case_id: item.case_id, status: "running", error: null });
      publishRun();
      workflowDependencies.onProgress(item.case_id, "starting");
      let outcome: Awaited<ReturnType<typeof runCase>> | undefined;
      try {
        outcome = await runCase(workflowDependencies, run, item);
      } catch (error) {
        const wasCancelled = dependencies.signal.aborted || error instanceof BatchTestCancelledError;
        run = await updateCase({
          root_dir: run.root_dir,
          case_id: item.case_id,
          status: wasCancelled ? "cancelled" : "failed",
          error: wasCancelled ? null : (error instanceof Error ? error.message : String(error)).slice(0, 4_000),
        });
        if (wasCancelled) cancelled = true;
      }
      // Persist success outside the execution catch: response transport errors
      // must never change an already successful case into a failed case.
      if (outcome) {
        run = await updateCase({
          root_dir: run.root_dir,
          case_id: item.case_id,
          status: "completed",
          error: null,
          ...(outcome.pptxPath ? { pptx_path: outcome.pptxPath } : {}),
          ...(outcome.researchRoutingResult ? { research_routing_result: outcome.researchRoutingResult } : {}),
          ...(outcome.pageRefinementClassificationResult ? { page_refinement_classification_result: outcome.pageRefinementClassificationResult } : {}),
          ...(outcome.templateRecommendationResult ? { template_recommendation_result: outcome.templateRecommendationResult } : {}),
        });
      }
      publishRun();
      if (cancelled) break;
    }
    if (cancelled) {
      for (const item of run.cases.filter((entry) => entry.status === "pending")) {
        run = await updateCase({ root_dir: run.root_dir, case_id: item.case_id, status: "cancelled" });
      }
    }
    run = await updateRun(cancelled ? "cancelled" : terminalStatus(), true);
    publishRun();
    return enrichResearchRoutingTransportRun(run, sourceCaseById);
  } catch (error) {
    // Also cover failures while writing "running" or while handling another
    // failure, so a stopped loop does not leave the batch marked as active.
    run = await reloadRun().catch(() => run);
    try {
      run = await updateRun(cancelled ? "cancelled" : terminalStatus());
      publishRun();
    } catch (finalizeError) {
      const detail = `${String(error)}; ${String(finalizeError)}`;
      throw new Error(pickLocale(workflowDependencies.locale, {
        zh: `批次已中断，最终状态也未能确认；请恢复连接后重新查询。${detail}`,
        en: `Batch interrupted and final status could not be confirmed; reconnect and reload. ${detail}`,
        ja: `バッチが中断され、最終ステータスも確認できませんでした。接続を回復してから再取得してください。${detail}`,
        de: `Der Batch wurde unterbrochen und der Endstatus konnte nicht bestätigt werden. Stellen Sie die Verbindung wieder her und laden Sie erneut. ${detail}`,
      }));
    }
    if (run.status === "completed") return enrichResearchRoutingTransportRun(run, sourceCaseById);
    throw error;
  } finally {
    workflowDependencies.onProgress(null, "");
  }
}
