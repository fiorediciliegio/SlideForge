/** Master-optimization asset desensitizing ("leave a slot, not the bytes").
 *
 *  Embedding an inline base64 logo in the optimize prompt makes the model a
 *  copy machine: the JSON payload balloons, escaping errors multiply, and a
 *  model under pressure "helpfully" drops the blob. Same philosophy as the
 *  reference-page image protocol (model leaves a reference, the engine/
 *  caller restores the real bytes), applied to the round trip into the LLM.
 *
 *  Round trip:
 *    strip:  <img ... src="data:image/png;base64,AAAA..." data-asset="logo-1.png">
 *         → <img ... src="x-asset-ref:logo-1.png" data-asset="logo-1.png">
 *    restore: src="x-asset-ref:<name>" → original data URI (unknown refs left as-is)
 */

export interface StrippedAsset {
  /** File name used inside the x-asset-ref token (e.g. "logo-1.png"). */
  name: string;
  /** Full original data URI, restored verbatim on the way back. */
  dataUri: string;
  /** The complete original <img> tag, used to deterministically re-insert the
   *  asset if the model drops it during optimization. */
  tag: string;
}

export interface StripInlineAssetsResult {
  html: string;
  assets: StrippedAsset[];
}

const INLINE_IMG_DATA_RE = /<img\b[^>]*?>/gi;
const SRC_DATA_URI_RE = /\bsrc="(data:image\/[a-z0-9.+-]+;base64,[^"]+)"/i;
const DATA_ASSET_ATTR_RE = /\bdata-asset="([^"]+)"/i;
const ASSET_REF_PREFIX = "x-asset-ref:";

/** Replace every inline data-URI image src with an x-asset-ref placeholder. */
export function stripInlineAssetData(html: string): StripInlineAssetsResult {
  const assets: StrippedAsset[] = [];
  let anonymous = 0;
  const stripped = html.replace(INLINE_IMG_DATA_RE, (tag) => {
    const srcMatch = tag.match(SRC_DATA_URI_RE);
    if (!srcMatch) return tag;
    const dataUri = srcMatch[1];
    let name = tag.match(DATA_ASSET_ATTR_RE)?.[1]?.trim();
    if (!name) {
      anonymous += 1;
      name = `asset-${anonymous}.png`;
    }
    // Same file inlined twice shares one ref entry (restore is idempotent).
    if (!assets.some((asset) => asset.name === name)) assets.push({ name, dataUri, tag });
    return tag.replace(srcMatch[1], `${ASSET_REF_PREFIX}${name}`);
  });
  return { html: stripped, assets };
}

/** Put the real data URIs back after the model returns. Unknown or malformed
 *  refs are left untouched so the caller can see exactly what was dropped. */
export function restoreInlineAssetData(html: string, assets: readonly StrippedAsset[]): string {
  if (!assets.length) return html;
  let restored = html;
  for (const asset of assets) {
    restored = restored.split(`${ASSET_REF_PREFIX}${asset.name}`).join(asset.dataUri);
  }
  return restored;
}

/** Deterministic guard against the silent logo-drop: check every stripped
 *  asset is still referenced in the model's output (either as an
 *  x-asset-ref token or a data-asset attribute) and, for each missing one,
 *  re-insert the original element before </body>. Absolute-positioned
 *  originals keep their coordinates, so body-level re-insertion preserves
 *  the visual position. Returns the names that had to be re-inserted. */
export function reinsertMissingAssets(html: string, assets: readonly StrippedAsset[]): { html: string; reinserted: string[] } {
  const missing = assets.filter((asset) =>
    !html.includes(`${ASSET_REF_PREFIX}${asset.name}`) && !html.includes(`data-asset="${asset.name}"`));
  if (!missing.length) return { html, reinserted: [] };
  const block = missing.map((asset) => asset.tag).join("\n    ");
  const reinserted = missing.map((asset) => asset.name);
  if (/<\/body>/i.test(html)) return { html: html.replace(/<\/body>/i, `    ${block}\n  </body>`), reinserted };
  return { html: `${html}\n${block}`, reinserted };
}
