/** Fixed-asset region helpers shared by the ProfileEditor UI and the master
 *  generation prompt. Region is carried inside position_rule as a `[region]`
 *  prefix (e.g. "[top-right] 与标题同行") so no schema change is needed; the
 *  master prompt turns a valid prefix into an explicit data-region, removing
 *  the model's guesswork. Keys mirror the engine's ASSET_REGIONS grid. */

export const ASSET_REGION_KEYS = [
  "top-left", "top-center", "top-right",
  "mid-left", "center", "mid-right",
  "bottom-left", "bottom-center", "bottom-right",
] as const;

export type AssetRegionKey = (typeof ASSET_REGION_KEYS)[number];

const REGION_PREFIX_RE = /^\[([a-z-]+)\]\s*/;

export function isAssetRegionKey(value: string | undefined): value is AssetRegionKey {
  return !!value && (ASSET_REGION_KEYS as readonly string[]).includes(value);
}

/** Extract the [region] prefix from a position_rule, if present and valid. */
export function parseRegionFromRule(rule: string | undefined): AssetRegionKey | undefined {
  const match = rule?.match(REGION_PREFIX_RE);
  return isAssetRegionKey(match?.[1]) ? match![1] as AssetRegionKey : undefined;
}

/** Strip the [region] prefix, returning the free-text remainder. */
export function ruleTextWithoutRegion(rule: string | undefined): string {
  return rule?.replace(REGION_PREFIX_RE, "").trim() ?? "";
}

/** Write (or replace) the [region] prefix, preserving any free-text note. */
export function setRegionInRule(rule: string | undefined, region: AssetRegionKey | undefined): string | undefined {
  const text = ruleTextWithoutRegion(rule);
  if (!region) return text || undefined;
  return text ? `[${region}] ${text}` : `[${region}]`;
}
