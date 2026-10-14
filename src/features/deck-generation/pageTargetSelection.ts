import { shouldResumePageGenerationStatus } from "./pageStatusPolicy";
import { getProgressPage } from "./runtimeSupport";
import type { AuthoringDeck, RunDeckGenerationInput } from "./types";
import type { PageProgress } from "../../api/types";

/**
 * Resolve the Page Generation Units owned by one generation run.
 *
 * Page Refinement is deliberately allow-list based: only page ids carrying a
 * refinement reason may be authored. Ordinary generation/resume keeps the
 * existing unfinished-page recovery semantics.
 */
export function getGenerationTargetPageIds(
  input: RunDeckGenerationInput,
  authoringDeck: AuthoringDeck,
  progress: PageProgress | null,
): string[] {
  const isPageRefinement = input.refinementRunKind === "page-refinement";
  return authoringDeck.pages
    .filter((page) => {
      const reason = input.pageRefinementReasons?.[page.page_id]?.trim();
      if (isPageRefinement) return Boolean(reason);
      const pageProgress = progress ? getProgressPage(progress, page.page_id) : undefined;
      return Boolean(reason) || shouldResumePageGenerationStatus(pageProgress?.status ?? "pending");
    })
    .map((page) => page.page_id);
}
