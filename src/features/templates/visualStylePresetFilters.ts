import type { VisualStylePreset } from "../../api/types";

export const VISUAL_STYLE_PRESET_FILTER_FIELDS = ["user", "use_case", "industry", "theme", "color"] as const;

export type VisualStylePresetFilterField = (typeof VISUAL_STYLE_PRESET_FILTER_FIELDS)[number];
export type VisualStylePresetFilters = Record<VisualStylePresetFilterField, string>;

export function sortVisualStylePresetsByScore(
  presets: readonly VisualStylePreset[],
): VisualStylePreset[] {
  const byScore = [...presets].sort((left, right) => {
    if (left.score === undefined) return right.score === undefined ? 0 : 1;
    if (right.score === undefined) return -1;
    return right.score - left.score;
  });

  const ordered: VisualStylePreset[] = [];
  for (let start = 0; start < byScore.length;) {
    const score = byScore[start].score;
    let end = start + 1;
    while (end < byScore.length && byScore[end].score === score) end += 1;
    const cohort = byScore.slice(start, end);
    const established = cohort.filter((preset) => preset.catalog_cohort !== "new");
    const newlyAdded = cohort.filter((preset) => preset.catalog_cohort === "new");
    const sharedLength = Math.min(established.length, newlyAdded.length);
    for (let index = 0; index < sharedLength; index += 1) {
      ordered.push(established[index], newlyAdded[index]);
    }
    ordered.push(...established.slice(sharedLength), ...newlyAdded.slice(sharedLength));
    start = end;
  }
  return ordered;
}

export function matchesVisualStylePresetFilters(
  preset: VisualStylePreset,
  filters: VisualStylePresetFilters,
): boolean {
  return VISUAL_STYLE_PRESET_FILTER_FIELDS.every((field) => {
    const selected = filters[field];
    if (!selected) return true;
    const value = preset[field];
    return Array.isArray(value) ? value.some((entry) => entry === selected) : value === selected;
  });
}

export function filterVisualStylePresets(
  presets: readonly VisualStylePreset[],
  filters: VisualStylePresetFilters,
): VisualStylePreset[] {
  return sortVisualStylePresetsByScore(
    presets.filter((preset) => matchesVisualStylePresetFilters(preset, filters)),
  );
}

export function createEmptyVisualStylePresetFilters(): VisualStylePresetFilters {
  return { user: "", use_case: "", industry: "", theme: "", color: "" };
}

export function buildVisualStylePresetFilterOptions(
  presets: readonly VisualStylePreset[],
): Record<VisualStylePresetFilterField, string[]> {
  return Object.fromEntries(
    VISUAL_STYLE_PRESET_FILTER_FIELDS.map((field) => [
      field,
      [...new Set(presets.flatMap((preset) => {
        const value = preset[field];
        return Array.isArray(value) ? value : [value];
      }).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right)),
    ]),
  ) as Record<VisualStylePresetFilterField, string[]>;
}
