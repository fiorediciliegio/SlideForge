import type { Locale } from "../../i18n/messages";
import {
  pageProgressToDeckGenerationProgress,
  type DeckGenerationProgress,
} from "../deck-generation";
import type { PageProgress, WorkspaceOutline } from "../../api/types";

export function normalizeWorkspacePageProgress(value: unknown): PageProgress | null {
  const progressRecord =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<PageProgress>)
      : null;
  const pages = Array.isArray(progressRecord?.pages)
    ? progressRecord.pages.filter(
        (page): page is PageProgress["pages"][number] =>
          page !== null &&
          typeof page === "object" &&
          typeof (page as PageProgress["pages"][number]).page_id === "string",
      )
    : [];
  const researchDiscovery =
    progressRecord?.research_discovery &&
    typeof progressRecord.research_discovery === "object" &&
    Array.isArray(progressRecord.research_discovery.records)
      ? progressRecord.research_discovery
      : undefined;

  if (pages.length === 0 && !researchDiscovery) return null;

  return {
    version: 1,
    status: typeof progressRecord?.status === "string" ? progressRecord.status : "prepared",
    recovery: progressRecord?.recovery,
    final_deck_render: progressRecord?.final_deck_render,
    research_discovery: researchDiscovery,
    pages,
    updated_at:
      typeof progressRecord?.updated_at === "string" ? progressRecord.updated_at : null,
  };
}

export function completedDeckIsAvailable(
  staleDeck: boolean,
  pageProgress: PageProgress | null,
) {
  return !staleDeck && pageProgress?.final_deck_render?.status === "completed";
}

export function restoreDeckGenerationProgress(input: {
  staleDeck: boolean;
  pageProgress: PageProgress | null;
  locale: Locale;
  outline?: WorkspaceOutline | null;
}): DeckGenerationProgress | null {
  if (input.staleDeck || !input.pageProgress) {
    return null;
  }

  return pageProgressToDeckGenerationProgress(input.pageProgress, input.locale, input.outline);
}
