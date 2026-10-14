import { ASSET_REGION_KEYS, parseRegionFromRule, setRegionInRule, type AssetRegionKey } from "./assetRegions";

/** Compact 3x3 grid picker for a fixed asset's placement region. Clicking a
 *  cell writes a [region] prefix into the asset's position_rule (shared
 *  convention, no schema change); the master prompt turns it into an
 *  explicit data-region so the engine composes at exact grid coordinates. */
export function AssetRegionPicker(props: { rule: string | undefined; onChange: (rule: string | undefined) => void; labels: Record<AssetRegionKey, string>; title: string }) {
  const selected = parseRegionFromRule(props.rule);
  return (
    <div className="user-template-asset-region" role="group" aria-label={props.title}>
      <div className="user-template-asset-region-grid">
        {ASSET_REGION_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={`user-template-asset-region-cell${selected === key ? " selected" : ""}`}
            title={props.labels[key]}
            aria-pressed={selected === key}
            onClick={() => props.onChange(setRegionInRule(props.rule, selected === key ? undefined : key))}
          />
        ))}
      </div>
      <span className="user-template-asset-region-name">{selected ? props.labels[selected] : props.title}</span>
    </div>
  );
}
