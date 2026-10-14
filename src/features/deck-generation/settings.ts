import type { WorkspaceResult } from "../../api/types";
import { readPageGenerationConcurrency } from "../deck-workspace/generationConcurrency";
import { readResearchImageSessionConcurrency } from "../deck-workspace/researchImageSessionConcurrency";
import {
  readResearchImageMaxSearches,
  readResearchWebMaxRounds,
} from "../deck-workspace/researchRoundLimits";
import { ATTEMPT_LIMITS } from "./types";

export function readWorkspaceSetting(workspace: WorkspaceResult): Record<string, unknown> {
  return workspace.setting && typeof workspace.setting === "object" && !Array.isArray(workspace.setting)
    ? (workspace.setting as Record<string, unknown>)
    : {};
}

export function getAttemptLimits(input: { workspace: WorkspaceResult }) {
  void input;
  return ATTEMPT_LIMITS;
}

export function getPageGenerationConcurrency(input: { workspace: WorkspaceResult }) {
  return readPageGenerationConcurrency(readWorkspaceSetting(input.workspace));
}

export function getResearchImageSessionConcurrency(input: { workspace: WorkspaceResult }) {
  return readResearchImageSessionConcurrency(readWorkspaceSetting(input.workspace));
}

export function getWebResearchMaxRounds(input: { workspace: WorkspaceResult }) {
  return readResearchWebMaxRounds(readWorkspaceSetting(input.workspace));
}

export function getImageResearchMaxSearches(input: { workspace: WorkspaceResult }) {
  return readResearchImageMaxSearches(readWorkspaceSetting(input.workspace));
}
