/* Re-render page previews + final deck for a workspace, mirroring the plugin's
 * auto-rerender-after-restore logic but runnable on demand (e.g. when a restore
 * was idempotently skipped and output/ previews are missing).
 *
 * Usage: node scripts/regenerate-workspace-previews.cjs <workspace_dir> [page_id]
 */
const path = require("node:path");
const fs = require("node:fs");
const engine = require(path.join(__dirname, "..", "dist", "index.js"));

const WORKSPACE_DIR = process.argv[2];
const ONLY_PAGE = process.argv[3] || null;

if (!WORKSPACE_DIR) {
  console.error("usage: node scripts/regenerate-workspace-previews.cjs <workspace_dir> [page_id]");
  process.exit(1);
}

const POLL_MS = 2000;
const PAGE_TIMEOUT_MS = 5 * 60_000;
const DECK_TIMEOUT_MS = 10 * 60_000;

function exists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

async function waitForPagePreview(workspaceDir, pageId) {
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const progress = await engine.getAppPageProgress({ workspace_dir: workspaceDir });
    const page = progress.pages.find((x) => x.page_id === pageId);
    if (!page) throw new Error(`Page "${pageId}" is missing from page-progress.json`);
    if (["render_failed", "failed", "interrupted"].includes(page.status)) {
      throw new Error(`Page preview render failed for "${pageId}": ${page.last_error || page.status}`);
    }
    if (page.last_screenshot_path && exists(page.last_screenshot_path)) return;
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out after ${PAGE_TIMEOUT_MS / 1000}s waiting for page preview render of "${pageId}"`);
}

async function waitForDeckRender(workspaceDir) {
  const deadline = Date.now() + DECK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const progress = await engine.getAppPageProgress({ workspace_dir: workspaceDir });
    const final = progress.final_deck_render;
    if (final.status === "completed" && final.deck_html_path && exists(final.deck_html_path)) return;
    if (["failed", "interrupted"].includes(final.status)) {
      throw new Error(`Final Deck render failed: ${final.error || final.message || final.status}`);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out after ${DECK_TIMEOUT_MS / 1000}s waiting for Final Deck render`);
}

async function main() {
  const startedAt = Date.now();
  const progress = await engine.getAppPageProgress({ workspace_dir: WORKSPACE_DIR });
  let pages = progress.pages;
  if (ONLY_PAGE) pages = pages.filter((p) => p.page_id === ONLY_PAGE);
  console.log(`[rerender] ${pages.length} page(s) to render in ${WORKSPACE_DIR}`);

  let rendered = 0;
  let failed = 0;
  for (const page of pages) {
    try {
      const submit = await engine.renderAppWorkspacePagePreview({ workspace_dir: WORKSPACE_DIR, page_id: page.page_id });
      await waitForPagePreview(WORKSPACE_DIR, page.page_id);
      if (submit.already_queued) {
        console.log(`[rerender] page ${page.page_id} already current (skipped)`);
      } else {
        rendered += 1;
        console.log(`[rerender] page ${page.page_id} rendered`);
      }
    } catch (error) {
      failed += 1;
      console.error(`[rerender] page ${page.page_id} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    await engine.renderAppWorkspaceDeckHtml({ workspace_dir: WORKSPACE_DIR });
    await waitForDeckRender(WORKSPACE_DIR);
    console.log(`[rerender] deck rendered in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (error) {
    failed += 1;
    console.error(`[rerender] deck FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`[rerender] done: ${rendered} rendered, ${failed} failed, ${Math.round((Date.now() - startedAt) / 1000)}s total`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("[rerender] FATAL:", error);
  process.exit(1);
});
