import { readFile } from "node:fs/promises";
import sharp from "sharp";

/** Placeholder the page-generation prompt asks the model to emit for
 *  photographic content (see templatePagePrompt's image protocol). */
const IMAGE_SLOT_RE = /<div\b[^>]*class="[^"]*image-slot[^"]*"[^>]*data-photo[^>]*>(?:\s*<\/div>)?/i;
const COMPOSED_MARKER = "data-composed";
const INLINE_BUDGET_BYTES = 300 * 1024;
/** P4 dedup: the composed background IS the full original page raster, so the
 *  model's redraw layer (titles, numbering, decorations) duplicates it and
 *  ghosts. Hide every direct .slide child except the photo itself and asset
 *  slots. Elements stay in the DOM (placeholder semantics for deck reuse);
 *  only the visual duplication is removed. Siblings are hidden, not deleted,
 *  so per-element overrides can still re-show a child via CSS if needed. */
const DEDUP_STYLE = `<style data-photo-dedup>
.slide>*:not(img[data-photo]):not([data-composed-asset]):not(.asset-slot):not(.asset-missing-marker){visibility:hidden!important}
</style>`;

/** Replace model-emitted photo placeholders with the page's original
 *  reference image, inlined as base64 (pages must stay self-contained).
 *
 *  The model cannot and should not recreate photography - it leaves a
 *  full-bleed `.image-slot[data-photo]` and the engine fills it with the
 *  real raster, compressed to keep the HTML lean, then hides the redraw
 *  layer (P4: the raster already shows the whole original page).
 *  Idempotent: already composed documents pass through untouched.
 *  v1 covers pages only.
 *
 *  The caller resolves the reference image path (undefined = leave the
 *  slot untouched, e.g. unknown page). */
export async function composeImageSlots(html: string, referencePath: string | undefined): Promise<string> {
  if (!referencePath || !IMAGE_SLOT_RE.test(html) || html.includes(COMPOSED_MARKER)) return html;
  const dataUri = await inlineReferenceImage(referencePath);
  const img = `<img ${COMPOSED_MARKER} data-photo src="${dataUri}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;" />`;
  const replaced = html.replace(new RegExp(IMAGE_SLOT_RE.source, "gi"), img);
  return injectDedupStyle(replaced);
}

/** Insert the P4 dedup style before </head> (fall back to document start). */
function injectDedupStyle(html: string): string {
  if (html.includes("data-photo-dedup")) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${DEDUP_STYLE}</head>`);
  return DEDUP_STYLE + html;
}

async function inlineReferenceImage(referencePath: string): Promise<string> {
  try {
    const compressed = await sharp(referencePath)
      .resize({ width: 1280, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    if (compressed.length <= INLINE_BUDGET_BYTES) return `data:image/jpeg;base64,${compressed.toString("base64")}`;
  } catch { /* fall through to the raw inline */ }
  const raw = await readFile(referencePath);
  return `data:image/png;base64,${raw.toString("base64")}`;
}
