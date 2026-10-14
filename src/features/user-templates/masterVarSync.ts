/** Variable cascade: after the visual master is restyled (AI tuning, source
 *  edits), optionally push the master's `:root` variable block into every
 *  reference page so the template preview reads consistently.
 *
 *  Deliberately VARIABLE-LEVEL only: pages were generated FROM the master
 *  and share its class names and custom properties, so recoloring/re-fonting
 *  is a deterministic string rewrite — zero model involvement, zero
 *  confirmation cost. Layout/structure changes are NOT cascaded (that would
 *  require per-page regeneration and would break the pages' identity as
 *  faithful snapshots of the original deck — see 生产上线计划 P2.5 决策).
 */

/** Extract the first `:root { ... }` block (with braces), or null. */
export function extractRootBlock(html: string): string | null {
  const match = html.match(/:root\s*\{[\s\S]*?\}/);
  return match ? match[0] : null;
}

/** Replace the first `:root { ... }` block in `targetHtml` with `rootBlock`.
 *  No-op (returns the input unchanged) when either side lacks the block, so
 *  pages with unusual stylesheets are never corrupted. */
export function replaceRootBlock(targetHtml: string, rootBlock: string): string {
  if (!extractRootBlock(targetHtml)) return targetHtml;
  return targetHtml.replace(/:root\s*\{[\s\S]*?\}/, rootBlock);
}
