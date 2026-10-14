import path from "node:path";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

/** Named-region grid: the model only names a region (semantic instruction it is
 *  good at); the engine owns the coordinates (precision it must guarantee).
 *  1920x1080 design canvas. */
export const ASSET_REGIONS: Record<string, { x: number; y: number; h: number; align: "left" | "center" | "right" }> = {
  "top-left": { x: 96, y: 72, h: 72, align: "left" },
  "top-center": { x: 960, y: 72, h: 72, align: "center" },
  "top-right": { x: 1824, y: 72, h: 72, align: "right" },
  "mid-left": { x: 96, y: 504, h: 72, align: "left" },
  center: { x: 960, y: 504, h: 96, align: "center" },
  "mid-right": { x: 1824, y: 504, h: 72, align: "right" },
  "bottom-left": { x: 96, y: 936, h: 72, align: "left" },
  "bottom-center": { x: 960, y: 936, h: 72, align: "center" },
  "bottom-right": { x: 1824, y: 936, h: 72, align: "right" },
};

const ASSET_SLOT_RE = /<div\b[^>]*class="[^"]*asset-slot[^"]*"[^>]*data-asset="([^"]+)"[^>]*data-region="([^"]+)"[^>]*>(?:\s*<\/div>)?/i;
/** Per-asset inline budget: several assets share one HTML document, and that
 *  document rides the invoke transfer (the 69KB lesson) — keep each asset
 *  small so a 4-asset master stays well under the danger zone. */
const ASSET_INLINE_BUDGET = 100 * 1024;

/** Fill model-emitted fixed-asset placeholders with the original brand asset.
 *  M2 of the image-asset plan: deck pages must never redraw logos (the redraw
 *  distorts); the model emits <div class="asset-slot" data-asset data-region>,
 *  the engine inlines the pristine asset at the region's grid coordinates.
 *  Idempotent via data-composed; unknown asset/region leaves the slot visible. */
export async function composeAssetSlots(html: string, resolveAsset: (filename: string) => Promise<string | undefined>): Promise<string> {
  if (!ASSET_SLOT_RE.test(html) || html.includes("data-composed-asset")) return html;
  let result = html;
  for (;;) {
    const match = result.match(new RegExp(ASSET_SLOT_RE.source, "i"));
    if (!match) break;
    const [, filename, regionName] = match;
    const region = ASSET_REGIONS[regionName];
    const assetPath = await resolveAsset(filename);
    if (!region || !assetPath) {
      result = result.replace(match[0], `<div class="asset-missing-marker" data-asset="${filename}" data-region="${regionName}"></div>`);
      continue;
    }
    const dataUri = await inlineAsset(assetPath);
    const img = `<img data-composed-asset data-asset="${filename}" src="${dataUri}" alt="" style="position:absolute;left:${region.x}px;top:${region.y}px;height:${region.h}px;transform:translateX(${region.align === "center" ? "-50%" : region.align === "right" ? "-100%" : "0"});object-fit:contain;z-index:5;" />`;
    result = result.replace(match[0], img);
  }
  return result;
}

async function inlineAsset(assetPath: string): Promise<string> {
  // WebP first (logos compress 30-50% smaller than PNG at visual parity);
  // compressed PNG as the compat fallback for consumers that predate WebP;
  // raw inline as the last resort so the save never fails on encoding.
  try {
    const webp = await sharp(assetPath)
      .resize({ height: 256, withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
    if (webp.length <= ASSET_INLINE_BUDGET) return `data:image/webp;base64,${webp.toString("base64")}`;
  } catch { /* fall through to PNG */ }
  try {
    const png = await sharp(assetPath)
      .resize({ height: 256, withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    if (png.length <= ASSET_INLINE_BUDGET) return `data:image/png;base64,${png.toString("base64")}`;
  } catch { /* fall through to the raw inline */ }
  const raw = await readFile(path.resolve(assetPath));
  return `data:image/png;base64,${raw.toString("base64")}`;
}
