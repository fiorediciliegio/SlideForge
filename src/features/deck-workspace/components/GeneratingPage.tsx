import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, Circle, LoaderCircle, Play } from "lucide-react";
import { useMemo } from "react";
import type { Messages } from "../../../i18n/messages";
import type { DeckGenerationProgress, DeckGenerationStep } from "../../deck-generation";
import { buildPageGenerationStageRecords, type PageGenerationStageRecordGroup } from "../generationStageRecords";
import { buildResearchDiscoveryStageRecords } from "../researchDiscoveryStageRecords";
import {
  buildGenerationPageSummary,
  formatGenerationPageSummary,
  getGenerationProgressDisplayMessage,
} from "../generationProgressDisplay";
import type { GenerationStreamSnapshot } from "../types";
import type { GenerationViewState } from "../generationViewState";
import type { GenerationPagePreviews } from "../generationPagePreviews";
import { summarizeUserFacingError } from "../userFacingError";
import { GenerationPagePreviewPanel } from "./GenerationPagePreviewPanel";
import { ThinkingStatusText } from "./BriefPage";
import { ResearchDiscoveryStageGroupView, useResearchDiscoveryDisclosure } from "./ResearchDiscoveryStageView";

interface GeneratingPageProps {
  previewWorkspaceDir: string;
  t: Messages;
  viewState: GenerationViewState;
  progress: DeckGenerationProgress | null;
  history: GenerationStreamSnapshot[];
  pagePreviews: GenerationPagePreviews;
  pinnedPreviewPageId: string | null;
  onSelectPreviewPage: (pageId: string | null) => void;
  onBack: () => void;
  onForward?: () => void;
  onBackToOutline: () => void;
  onStop: () => void;
  onResume: () => Promise<void>;
  canBackToOutline: boolean;
}

const majorSteps: Array<{
  id: string;
  labelKey: keyof Messages["generating"]["steps"];
  steps: DeckGenerationStep[];
}> = [
  { id: "authoring-setup", labelKey: "authoringSetup", steps: [
    "visual-master",
    "page-sources",
    "prepare",
  ] },
  {
    id: "pages",
    labelKey: "pages",
    steps: [
      "page-authoring",
      "page-render",
      "page-layout-check",
      "page-layout-rewrite",
      "interrupted",
      "failed",
      "cancelled",
    ],
  },
  { id: "final-render", labelKey: "finalRender", steps: ["final-render", "complete"] }
];

function majorStepIndex(step: DeckGenerationStep | null) {
  if (!step) return 0;
  return Math.max(0, majorSteps.findIndex((item) => item.steps.includes(step)));
}

function stepState(
  index: number,
  activeIndex: number,
  progress: DeckGenerationProgress | null,
  viewStatus: GenerationViewState["status"],
) {
  if (viewStatus === "complete" || progress?.step === "complete") {
    return "done";
  }
  if (viewStatus === "interrupted") {
    return index === activeIndex ? "interrupted" : index < activeIndex ? "done" : "pending";
  }
  if (viewStatus === "unresumable") {
    return index === activeIndex ? "failed" : index < activeIndex ? "done" : "pending";
  }
  if (progress?.step === "interrupted") {
    return index === activeIndex ? "interrupted" : index < activeIndex ? "done" : "pending";
  }
  if (progress?.step === "failed" || progress?.step === "cancelled") {
    return index === activeIndex ? "failed" : index < activeIndex ? "done" : "pending";
  }
  if (index < activeIndex) return "done";
  if (index === activeIndex) return "active";
  return "pending";
}

export function GeneratingPage(props: GeneratingPageProps) {
  const {
    t,
    viewState,
    progress,
    history,
    pagePreviews,
    pinnedPreviewPageId,
    onSelectPreviewPage,
    onBack,
    onForward,
    onBackToOutline,
    onStop,
    onResume,
    canBackToOutline,
  } = props;
  const activeIndex = majorStepIndex(progress?.step ?? null);
  const progressMessage = getGenerationProgressDisplayMessage(t, progress);
  const pageTitle = generationPageTitle(t, viewState.status);
  const backLabel = t.controls.back;

  return (
    <section className="page active generating-page">
      <div className="page-header compact">
        <div className="page-header-left">
          <div>
            <div className="page-title">{pageTitle}</div>
            <p><ThinkingStatusText text={progressMessage} active={viewState.status === "preparing" || viewState.status === "running"} /></p>
          </div>
        </div>
      </div>

      {/* The timeline reports state, so it is a list rather than a row of
          buttons that would take focus without doing anything. */}
      <ol className="generation-major-timeline" aria-label={t.generating.progressTitle}>
        {majorSteps.map((step, index) => {
          const state = stepState(index, activeIndex, progress, viewState.status);
          const label = t.generating.steps[step.labelKey];
          return (
            <li
              key={step.id}
              className={`generation-major-node ${state}`}
              aria-current={state === "active" ? "step" : undefined}
            >
              {state === "done" ? <CheckCircle2 size={15} aria-hidden="true" /> : state === "failed" || state === "interrupted" ? <AlertCircle size={15} aria-hidden="true" /> : state === "active" ? <LoaderCircle className="generation-running-icon" size={15} aria-hidden="true" /> : <Circle size={15} aria-hidden="true" />}
              <span>{label}</span>
            </li>
          );
        })}
      </ol>

      {/* The run reports two things at once: what it has produced and what it is
          doing. The finished pages lead, because that is what the user is
          waiting for; the page status summary follows underneath. */}
      <div className="generation-stage-stack">
        <GenerationPagePreviewPanel
          workspaceDir={props.previewWorkspaceDir}
          t={t}
          previews={pagePreviews}
          pinnedPageId={pinnedPreviewPageId}
          onSelectPage={onSelectPreviewPage}
          activePageIndex={progress?.currentPageIndex}
          activeStreams={progress?.activeStreams}
          pageProgress={progress?.pages}
        />
        {progress ? (
          <GenerationProgressPanel
            t={t}
            progress={progress}
            history={history}
          />
        ) : (
          <div className="generation-progress-panel">
            <strong>{t.status.creatingDeck}</strong>
          </div>
        )}
      </div>

      {/* Stage navigation only browses existing artifacts. It stays separate
          from resume/recovery actions and locks while a run is writing them. */}
      <div className="generation-page-footer">
        <div className="stage-navigation">
          <button data-performance-id="generation.back" className="secondary-btn" type="button" onClick={onBack} disabled={viewState.navigationLocked || viewState.isActive}>
            <ArrowLeft size={16} aria-hidden="true" />{backLabel}
          </button>
          {onForward ? (
            <button data-performance-id="generation.forward" className="secondary-btn" type="button" onClick={onForward} disabled={viewState.navigationLocked || viewState.isActive}>
              {t.controls.forward}<ArrowRight size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {(viewState.isActive || viewState.status === "preparing") && !viewState.isStopping ? (
          <button
            data-performance-id="generation.stop"
            className="danger-btn"
            type="button"
            onClick={onStop}
          >
            {t.controls.stop}
          </button>
        ) : null}
        {viewState.showResume || viewState.showBackToOutline ? (
          <div className="generation-recovery-actions">
            {viewState.showResume ? (
              <button data-performance-id="generation.resume" className="primary-btn" onClick={() => void onResume()} disabled={!viewState.canResume}>
                <Play size={14} aria-hidden="true" />
                {viewState.resumeAction === "refinement"
                  ? t.controls.resumeRefinement
                  : t.controls.resumeGeneration}
              </button>
            ) : null}
            {viewState.showBackToOutline ? (
              <button data-performance-id="generation.back-to-outline" className="secondary-btn" onClick={onBackToOutline} disabled={!canBackToOutline}>
                {t.stages.outline}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function GenerationProgressPanel(props: {
  t: Messages;
  progress: DeckGenerationProgress;
  history: GenerationStreamSnapshot[];
}) {
  const { t, progress, history } = props;
  const pageSummary = buildGenerationPageSummary(progress);
  const showPageAcceptedSummary = isPageGenerationStep(progress.step) && pageSummary !== null;
  const progressMessage = getGenerationProgressDisplayMessage(t, progress);
  const stageGroups = useMemo(
    () => buildPageGenerationStageRecords({ t, progress, history }),
    [t, progress, history],
  );
  const researchGroup = useMemo(
    () => buildResearchDiscoveryStageRecords({ t, progress }),
    [t, progress],
  );
  const researchDisclosure = useResearchDiscoveryDisclosure(researchGroup);
  const running = isProgressRunning(progress);

  return (
    <section className="generation-progress-panel">
      <div className="generation-progress-header">
        <div>
          <div className="section-label">{t.generating.progressTitle}</div>
          <strong><ThinkingStatusText text={progressMessage} active={running} /></strong>
          {running ? (
            <span className="generation-stay-hint">{t.generating.stayOnPageHint}</span>
          ) : null}
          {showPageAcceptedSummary && pageSummary ? (
            <span className="generation-pages-passed" role="status" aria-live="polite">
              <span className="visually-hidden">{t.generating.pageSummary.label}</span>
              {formatGenerationPageSummary(t, pageSummary).map((part, index) => (
                <span key={`${index}-${part}`} className="generation-page-summary-part">{part}</span>
              ))}
            </span>
          ) : null}
        </div>
      </div>
      {researchGroup && researchGroup.records.length > 0 ? (
        <div className="generation-page-list generation-stage-record-list">
          <ResearchDiscoveryStageGroupView
            group={researchGroup}
            t={t}
            disclosure={researchDisclosure}
            togglePerformanceId="generation.research-stage.toggle"
          />
        </div>
      ) : null}
      {stageGroups.length > 0 ? (
        <div className="generation-page-list generation-stage-record-list">
          {stageGroups.map((group) => (
            <PageProgressCard
              key={group.pageId}
              group={group}
              t={t}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function isProgressRunning(progress: DeckGenerationProgress) {
  return !["complete", "interrupted", "failed", "cancelled"].includes(progress.step);
}

function isPageGenerationStep(step: DeckGenerationStep) {
  return ![
    "research-planning",
    "prepare",
    "research-discovery",
    "research-collection",
    "research-curation",
    "evidence-page-planning",
  ].includes(step);
}

function PageProgressCard(props: {
  group: PageGenerationStageRecordGroup;
  t: Messages;
}) {
  const { group, t } = props;

  return (
    <article className={`generation-page-item generation-stage-page ${group.state} ${group.pageStatus}`}>
      <div className="generation-page-item-header">
        <div>
          <strong>{group.pageIndex + 1}. {group.title}</strong>
        </div>
        <span className={`generation-status-badge ${group.state}`}>{group.pageStatusLabel}</span>
      </div>
      {group.lastError ? (
        <p className="generation-page-error">{summarizeUserFacingError(t, group.lastError).summary}</p>
      ) : null}
    </article>
  );
}

function generationPageTitle(t: Messages, status: GenerationViewState["status"]) {
  switch (status) {
    case "preparing":
      return t.generating.preparingTitle;
    case "running":
      return t.stages.generating;
    case "stopping":
      return t.generating.stoppingTitle;
    case "interrupted":
      return t.generating.interruptedTitle;
    case "unresumable":
      return t.generating.unresumableTitle;
    case "complete":
      return t.generating.generationComplete;
  }
}
