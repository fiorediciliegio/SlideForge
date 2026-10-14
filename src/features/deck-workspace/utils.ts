import type { Messages } from "../../i18n/messages";
import type { WorkspaceResult } from "../../api/types";
import type { MainStage } from "./types";

export const sleep = (ms: number) =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

export function formatSlideNumber(index: number) {
  return String(index + 1).padStart(2, "0");
}

export function formatSlideCount(count: number) {
  return String(count).padStart(2, "0");
}

export function deckReadyStatus(t: Messages, count: number) {
  return `${t.status.draftReady} · ${count} slides`;
}

export function stageOrder(stage: MainStage) {
  return {
    brief: 1,
    requirements: 2,
    // Kept only as a recovery/navigation compatibility value. Web research is
    // now rendered inside Generating after the outline is confirmed.
    "web-research": 2.5,
    "uploaded-source-analysis": 2.5,
    outline: 3,
    generating: 4,
    deck: 5,
  }[stage];
}

export function stageLabel(t: Messages, stage: MainStage) {
  if (stage === "uploaded-source-analysis") return t.stages.uploadedSourceAnalysis;
  if (stage === "web-research") return t.stages.webResearch;
  return t.stages[stage];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

export function hasDownstreamArtifacts(workspace: WorkspaceResult) {
  const progressRecord = isRecord(workspace.page_progress) ? workspace.page_progress : null;

  return Array.isArray(progressRecord?.pages) && progressRecord.pages.length > 0;
}

export function isWorkspaceDeckStale(_workspace: WorkspaceResult) {
  return false;
}
