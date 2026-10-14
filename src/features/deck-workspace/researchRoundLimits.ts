import type { WorkspaceSettings } from "../../api/types";

/** One Web research round is one Agent action: search, fetch or finish. */
export const RESEARCH_WEB_MAX_ROUNDS_MIN = 1;
export const RESEARCH_WEB_MAX_ROUNDS_MAX = 30;
export const DEFAULT_RESEARCH_WEB_MAX_ROUNDS = 10;

/** Image research counts search actions only; image fetches are not rounds. */
export const RESEARCH_IMAGE_MAX_SEARCHES_MIN = 1;
export const RESEARCH_IMAGE_MAX_SEARCHES_MAX = 30;
export const DEFAULT_RESEARCH_IMAGE_MAX_SEARCHES = 10;

function normalizeLimit(value: unknown, min: number, max: number, fallback: number) {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) return fallback;

  return Math.max(min, Math.min(max, Math.floor(numericValue)));
}

export function normalizeResearchWebMaxRounds(
  value: unknown,
  fallback = DEFAULT_RESEARCH_WEB_MAX_ROUNDS,
) {
  return normalizeLimit(value, RESEARCH_WEB_MAX_ROUNDS_MIN, RESEARCH_WEB_MAX_ROUNDS_MAX, fallback);
}

export function normalizeResearchImageMaxSearches(
  value: unknown,
  fallback = DEFAULT_RESEARCH_IMAGE_MAX_SEARCHES,
) {
  return normalizeLimit(value, RESEARCH_IMAGE_MAX_SEARCHES_MIN, RESEARCH_IMAGE_MAX_SEARCHES_MAX, fallback);
}

export function readResearchWebMaxRounds(
  setting: WorkspaceSettings | Record<string, unknown> | null | undefined,
) {
  return normalizeResearchWebMaxRounds(setting?.research_web_max_rounds);
}

export function readResearchImageMaxSearches(
  setting: WorkspaceSettings | Record<string, unknown> | null | undefined,
) {
  return normalizeResearchImageMaxSearches(setting?.research_image_max_searches);
}
