import { generationStreamStageId } from "../deck-generation/progressProjection";
import type { Messages } from "../../i18n/messages";
import type {
  DeckGenerationProgress,
  DeckGenerationProgressPage,
  DeckGenerationStep,
  DeckGenerationStream,
} from "../deck-generation";
import {
  isActivePageGenerationStatus,
  isGenuinelyFailedPageGenerationStatus,
} from "../deck-generation/pageStatusPolicy";
import { isDiscoveryPageId, isDiscoveryStream } from "./researchDiscoveryStageRecords";
import type { GenerationStreamSnapshot } from "./types";
import { classifyUserFacingError } from "./userFacingError";

type StageLabelKey =
  | "visualRhythm"
  | "pageVisualPlan"
  | "researchPlanning"
  | "researchDiscovery"
  | "researchCollection"
  | "researchCuration"
  | "evidencePagePlanning"
  | "webResearchCuration"
  | "visualResearchCuration"
  | "prepare"
  | "persistentElements"
  | "authoring"
  | "deckRefinement"
  | "rendering"
  | "layoutChecking"
  | "layoutRewriting"
  | "renderFix"
  | "visualReview"
  | "visualReviewFix"
  | "finalRender"
  | "accepted"
  | "failed"
  | "pending"
  | "unknown";

type PageStatusLabelKey =
  | "pending"
  | "researchCollecting"
  | "researchCurating"
  | "authoring"
  | "rendering"
  | "layoutChecking"
  | "layoutRewriting"
  | "renderFixing"
  | "visualReview"
  | "visualReviewFixing"
  | "accepted"
  | "renderFailed"
  | "layoutCheckFailed"
  | "agentFailed"
  | "uploadFailed"
  | "workspaceCommitFailed"
  | "needsUserReview"
  | "agentInfrastructureFailed"
  | "interrupted"
  | "cancelled"
  | "unknown";

export type PageStageRecordState = "active" | "completed" | "failed" | "pending";

export interface PageGenerationStageRecord {
  id: string;
  stageKey: StageLabelKey;
  label: string;
  statusLabel: string;
  state: PageStageRecordState;
  lines: string[];
  activities: string[];
  hasStream: boolean;
  lastError?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface PageGenerationStageRecordGroup {
  pageId: string;
  pageIndex: number;
  title: string;
  pageStatus: string;
  pageStatusLabel: string;
  state: PageStageRecordState;
  lastError?: string;
  stages: PageGenerationStageRecord[];
}

export interface PersistentElementsStageGroup {
  title: string;
  statusLabel: string;
  state: PageStageRecordState;
  records: PageGenerationStageRecord[];
}

function buildDeckLevelStageGroup(input: {
  t: Messages;
  progress: DeckGenerationProgress | null;
  history: GenerationStreamSnapshot[];
  kind: "persistent-elements" | "visual-rhythm";
  stageKey: "persistentElements" | "visualRhythm";
  title: string;
  activeLabel?: string;
}): PersistentElementsStageGroup | null {
  const { t, progress, history, kind, stageKey, title, activeLabel } = input;
  const activeStream = (progress?.activeStreams ?? (progress?.stream ? [progress.stream] : []))
    .find((stream) => stream.kind === kind);
  const activeId = activeStream && progress
    ? buildActiveStageId(progress.step, activeStream)
    : null;
  const snapshotRecords = history
    .filter((snapshot) => snapshot.kind === kind && snapshot.id !== activeId)
    .map((snapshot): PageGenerationStageRecord => {
      const state = snapshot.status === "error"
        ? "failed"
        : snapshot.status === "completed"
          ? "completed"
          : "active";
      return {
        id: snapshot.id,
        stageKey,
        label: state === "active" ? (activeLabel ?? snapshot.label) : title,
        statusLabel: stateLabel(t, state),
        state,
        lines: [...snapshot.lines],
        activities: [...snapshot.activities],
        hasStream: snapshot.lines.some((line) => line.trim()) || snapshot.activities.length > 0,
        updatedAt: snapshot.updated_at,
      };
    });
  const activeState: PageStageRecordState = activeStream?.status === "error"
    ? "failed"
    : activeStream?.status === "completed"
      ? "completed"
      : "active";
  const activeRecords: PageGenerationStageRecord[] = activeStream ? [{
    id: activeId as string,
    stageKey,
    label: activeState === "active" ? (activeLabel ?? activeStream.status) : title,
    statusLabel: stateLabel(t, activeState),
    state: activeState,
    lines: [...activeStream.lines],
    activities: [...activeStream.activities],
    hasStream: activeStream.lines.some((line) => line.trim()) || activeStream.activities.length > 0,
    startedAt: activeStream.started_at,
    updatedAt: activeStream.updated_at,
  }] : [];
  let records = sortStageRecords([...snapshotRecords, ...activeRecords]);
  if (records.length === 0) return null;
  const latest = records[records.length - 1];
  const state: PageStageRecordState = activeRecords.length > 0
    ? activeState
    : latest?.state ?? "pending";
  records = hideRecoveredFailures(t, records, state === "failed");
  return { title, statusLabel: stateLabel(t, state), state, records };
}

export function buildPersistentElementsStageGroup(input: {
  t: Messages;
  progress: DeckGenerationProgress | null;
  history: GenerationStreamSnapshot[];
}): PersistentElementsStageGroup | null {
  const { t, progress, history } = input;
  return buildDeckLevelStageGroup({
    t,
    progress,
    history,
    kind: "persistent-elements",
    stageKey: "persistentElements",
    title: t.generating.persistentElements.title,
    activeLabel: t.generating.persistentElements.session,
  });
}

export function buildVisualRhythmStageGroup(input: {
  t: Messages;
  progress: DeckGenerationProgress | null;
  history: GenerationStreamSnapshot[];
}): PersistentElementsStageGroup | null {
  return buildDeckLevelStageGroup({
    ...input,
    kind: "visual-rhythm",
    stageKey: "visualRhythm",
    title: input.t.generating.stageRecords.stages.visualRhythm,
  });
}

export function buildPageGenerationStageRecords(input: {
  t: Messages;
  progress: DeckGenerationProgress | null;
  history: GenerationStreamSnapshot[];
}): PageGenerationStageRecordGroup[] {
  const { t, progress, history } = input;
  if (!progress) return [];

  const activeStreams = (progress.activeStreams ?? (progress.stream ? [progress.stream] : []))
    // Page HTML streams feed the visual preview directly. They are not a
    // separate user-facing generation stage, so do not expose their internal
    // identifier alongside the normal page authoring/rendering records.
    .filter((stream) => !isDiscoveryStream(stream) && stream.kind !== "page-html");
  const activeIds = new Set(activeStreams.map((stream) => buildActiveStageId(progress.step, stream)));
  const activeByPageId = groupBy(
    activeStreams.map((stream) => buildActiveStageRecord(t, progress.step, stream)),
    (record) => record.pageId,
  );
  const snapshotsByPageId = groupBy(
    history
      .filter((snapshot) => snapshot.page_id && !isDiscoveryPageId(snapshot.page_id) && !activeIds.has(snapshot.id))
      .map((snapshot) => buildSnapshotStageRecord(t, snapshot)),
    (record) => record.pageId,
  );

  return [...progress.pages]
    .filter((page) => !isDiscoveryPageId(page.page_id))
    .sort((left, right) => left.index - right.index)
    .map((page) => {
      const activeRecords = activeByPageId.get(page.page_id)?.map(({ pageId: _pageId, ...record }) => record) ?? [];
      const snapshotRecords = snapshotsByPageId.get(page.page_id)?.map(({ pageId: _pageId, ...record }) => record) ?? [];
      const statusRecord = buildPageStatusStageRecord(t, page);
      const shouldIncludeStatusRecord =
        activeRecords.length === 0 ||
        statusRecord.state === "failed" ||
        statusRecord.stageKey === "rendering" ||
        statusRecord.stageKey === "accepted";
      const pageHasFinallyFailed = isGenuinelyFailedPageGenerationStatus(page.status);
      const hasActiveStage = page.status !== "accepted" && activeRecords.some((record) => record.state === "active");
      const stages = hideRecoveredFailures(
        t,
        sortStageRecords([
          ...snapshotRecords,
          ...activeRecords,
          ...(shouldIncludeStatusRecord ? [statusRecord] : []),
        ]),
        pageHasFinallyFailed,
      );

      return {
        pageId: page.page_id,
        pageIndex: page.index,
        title: page.title,
        pageStatus: page.status,
        pageStatusLabel: hasActiveStage
          ? t.generating.stageRecords.running
          : pageStatusLabel(t, page),
        state: hasActiveStage ? "active" : pageStatusState(page.status),
        // GEN-005: a retried attempt is not the user's problem, so the error is
        // only surfaced once the page itself has finally failed.
        lastError: pageHasFinallyFailed ? page.last_error : undefined,
        stages,
      };
    });
}

/**
 * GEN-005: an internal failure that the run is still retrying, or already
 * recovered from, must not read as a red step. Only a page whose final status
 * is genuinely failed keeps its failure records.
 */
function hideRecoveredFailures(
  t: Messages,
  stages: PageGenerationStageRecord[],
  pageHasFinallyFailed: boolean,
): PageGenerationStageRecord[] {
  if (pageHasFinallyFailed) return stages;

  const visible = stages
    .filter((stage) => stage.state !== "failed")
    .map((stage) => (stage.lastError ? { ...stage, lastError: undefined } : stage));
  if (visible.length > 0) return visible;

  // Every record for this page is a retried attempt; keep the page on the
  // timeline as still in progress rather than dropping it entirely.
  return stages.map((stage) => ({
    ...stage,
    state: "pending" as const,
    statusLabel: stateLabel(t, "pending"),
    lastError: undefined,
  }));
}

function groupBy<T>(items: T[], keyFor: (item: T) => string | undefined) {
  const groups = new Map<string, T[]>();
  items.forEach((item) => {
    const key = keyFor(item);
    if (!key) return;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  });
  return groups;
}

function buildActiveStageId(step: DeckGenerationStep, stream: DeckGenerationStream) {
  return generationStreamStageId(step, stream);
}

function buildActiveStageRecord(
  t: Messages,
  step: DeckGenerationStep,
  stream: DeckGenerationStream,
): PageGenerationStageRecord & { pageId: string } {
  const state = stream.status === "completed"
    ? "completed"
    : stream.status === "error"
      ? "failed"
      : "active";
  const stageKey = stageLabelKey(stream.kind, step);

  return {
    pageId: stream.page_id,
    id: buildActiveStageId(step, stream),
    stageKey,
    label: (stageKey === "layoutChecking" || stageKey === "layoutRewriting")
      ? t.generating.stageRecords.stages[stageKey]
      : state === "active" && stream.status.trim()
      ? stream.status
      : t.generating.stageRecords.stages[stageKey],
    statusLabel: stateLabel(t, state),
    state,
    lines: [...stream.lines],
    activities: [...stream.activities],
    hasStream: true,
    startedAt: stream.started_at,
    updatedAt: stream.updated_at,
  };
}

function buildSnapshotStageRecord(
  t: Messages,
  snapshot: GenerationStreamSnapshot,
): PageGenerationStageRecord & { pageId: string | undefined } {
  const state = snapshot.status === "error" || snapshot.phase === "failed"
    ? "failed"
    : snapshot.status === "completed"
      ? "completed"
      : "completed";
  const stageKey = stageLabelKey(snapshot.kind, snapshot.phase);

  return {
    pageId: snapshot.page_id,
    id: snapshot.id,
    stageKey,
    label: t.generating.stageRecords.stages[stageKey],
    statusLabel: stateLabel(t, state),
    state,
    lines: [...snapshot.lines],
    activities: [...snapshot.activities],
    hasStream: snapshot.lines.some((line) => line.trim()) || snapshot.activities.length > 0,
    updatedAt: snapshot.updated_at,
  };
}

function buildPageStatusStageRecord(
  t: Messages,
  page: DeckGenerationProgressPage,
): PageGenerationStageRecord {
  const state = pageStatusState(page.status);
  const stageKey = stageLabelKey(undefined, undefined, page.status);
  const statusLabel = pageStatusLabel(t, page);

  return {
    id: `status:${page.page_id}:${page.status}`,
    stageKey,
    label: statusLabel,
    statusLabel: stateLabel(t, state),
    state,
    lines: [],
    activities: [],
    hasStream: false,
    lastError: page.last_error,
  };
}

function pageStatusLabel(t: Messages, page: DeckGenerationProgressPage): string {
  if (page.status === "agent_infrastructure_failed") {
    const kind = classifyUserFacingError(page.last_error ?? "");
    if (kind === "quotaExceeded") return t.errors.summaryQuotaExceeded;
    if (kind === "modelBusy") return t.errors.summaryModelBusy;
  }
  return t.generating.stageRecords.pageStatuses[pageStatusLabelKey(page.status)];
}

function sortStageRecords(records: PageGenerationStageRecord[]) {
  const order: StageLabelKey[] = [
    "pending",
    "persistentElements",
    "researchPlanning",
    "researchDiscovery",
    "researchCollection",
    "researchCuration",
    "evidencePagePlanning",
    "webResearchCuration",
    "visualResearchCuration",
    "pageVisualPlan",
    "authoring",
    "deckRefinement",
    "renderFix",
    "rendering",
    "visualReview",
    "visualReviewFix",
    "accepted",
    "failed",
  ];

  return [...records].sort((left, right) => {
    const leftTime = stageSortTime(left);
    const rightTime = stageSortTime(right);
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    if (leftTime !== null && rightTime === null) return -1;
    if (leftTime === null && rightTime !== null) return 1;

    const leftIndex = order.indexOf(left.stageKey);
    const rightIndex = order.indexOf(right.stageKey);
    if (leftIndex === rightIndex) {
      return left.id.localeCompare(right.id);
    }
    return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
      - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
  });
}

function stageSortTime(record: PageGenerationStageRecord) {
  const timestamp = record.startedAt ?? record.updatedAt;
  if (!timestamp) return null;
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? null : value;
}

function stageLabelKey(
  kind?: string,
  phase?: string,
  pageStatus?: string,
): StageLabelKey {
  if (kind === "page-layout-check") return "layoutChecking";
  if (kind === "page-layout-rewrite") return "layoutRewriting";
  if (kind === "page-authoring") return "authoring";
  if (kind === "page-render") return "rendering";
  if (kind === "authoring") return "authoring";
  if (kind === "deck-refinement") return "deckRefinement";
  if (kind === "render-fix") return "renderFix";
  if (kind === "visual-review-fix") return "visualReview";
  if (kind === "page-visual-review") return "visualReview";
  if (kind === "web-research-curation") return "webResearchCuration";
  if (kind === "visual-research-curation") return "visualResearchCuration";
  if (kind === "research-curation") return "researchCuration";
  if (kind === "page-visual-plan") return "pageVisualPlan";

  if (phase === "visual-rhythm") return "visualRhythm";
  if (phase === "page-visual-plans") return "pageVisualPlan";
  if (phase === "research-planning") return "researchPlanning";
  if (phase === "research-discovery") return "researchDiscovery";
  if (phase === "research-collection") return "researchCollection";
  if (phase === "research-curation") return "researchCuration";
  if (phase === "evidence-page-planning") return "evidencePagePlanning";
  if (phase === "prepare") return "prepare";
  if (phase === "page-authoring") return "authoring";
  if (phase === "page-layout-check") return "layoutChecking";
  if (phase === "page-layout-rewrite") return "layoutRewriting";
  if (phase === "page-render") return "rendering";
  if (phase === "page-visual-review") return "visualReview";
  if (phase === "final-render") return "finalRender";

  switch (pageStatus) {
    case "research_collecting":
      return "researchCollection";
    case "research_curating":
      return "researchCuration";
    case "pending":
      return "pending";
    case "authoring":
      return "authoring";
    case "layout_checking":
      return "layoutChecking";
    case "layout_rewriting":
      return "layoutRewriting";
    case "rendering":
      return "rendering";
    case "render_fixing":
      return "renderFix";
    case "visual_review":
      return "visualReview";
    case "visual_review_fixing":
      return "visualReview";
    case "accepted":
      return "accepted";
    case "layout_check_failed":
    case "render_failed":
    case "agent_failed":
    case "upload_failed":
    case "workspace_commit_failed":
    case "needs_user_review":
    case "agent_infrastructure_failed":
    case "interrupted":
      return "failed";
    default:
      return "unknown";
  }
}

function pageStatusLabelKey(status: string): PageStatusLabelKey {
  switch (status) {
    case "research_collecting":
      return "researchCollecting";
    case "research_curating":
      return "researchCurating";
    case "pending":
      return "pending";
    case "authoring":
      return "authoring";
    case "layout_checking":
      return "layoutChecking";
    case "layout_rewriting":
      return "layoutRewriting";
    case "rendering":
      return "rendering";
    case "render_fixing":
      return "renderFixing";
    case "visual_review":
      return "visualReview";
    case "visual_review_fixing":
      return "visualReview";
    case "accepted":
      return "accepted";
    case "layout_check_failed":
      return "layoutCheckFailed";
    case "render_failed":
      return "renderFailed";
    case "agent_failed":
      return "agentFailed";
    case "upload_failed":
      return "uploadFailed";
    case "workspace_commit_failed":
      return "workspaceCommitFailed";
    case "needs_user_review":
      return "needsUserReview";
    case "agent_infrastructure_failed":
      return "agentInfrastructureFailed";
    case "interrupted":
      return "interrupted";
    case "cancelled":
      return "cancelled";
    default:
      return "unknown";
  }
}

function pageStatusState(status: string): PageStageRecordState {
  switch (status) {
    case "pending":
      return "pending";
    case "accepted":
      return "completed";
    case "cancelled":
      return "failed";
    case "interrupted":
    case "agent_infrastructure_failed":
      return "pending";
    default:
      if (isGenuinelyFailedPageGenerationStatus(status)) return "failed";
      return isActivePageGenerationStatus(status) ? "active" : "pending";
  }
}

function stateLabel(t: Messages, state: PageStageRecordState) {
  switch (state) {
    case "active":
      return t.generating.stageRecords.running;
    case "completed":
      return t.generating.stageRecords.completed;
    case "failed":
      return t.generating.stageRecords.failed;
    case "pending":
      return t.generating.stageRecords.pending;
  }
}
