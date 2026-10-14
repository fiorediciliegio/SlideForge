import type { PptBackend } from "../../api/pptBackend";
import type { SaveManualPageRevisionInput } from "../../api/types";

export interface ManualPageDraft {
  html: string;
  baseline: string;
  baseRevision: number;
}

/** Both live and stashed drafts use the same transport and conflict policy. */
export async function persistManualPageDraft(
  backend: Pick<PptBackend, "saveManualPageRevision">,
  input: SaveManualPageRevisionInput,
  baseline: string,
  fetchLatest: () => Promise<{ html: string; revision: number }>,
) {
  try {
    return await backend.saveManualPageRevision(input);
  } catch (error) {
    if (!/revision conflict/i.test(error instanceof Error ? error.message : String(error))) throw error;
    const latest = await fetchLatest();
    if (latest.html !== baseline) throw error;
    return backend.saveManualPageRevision({ ...input, base_revision: latest.revision });
  }
}

/** Successful pages remain saved if a later page fails; newer drafts survive. */
export async function saveManualPageDrafts(
  drafts: Map<string, ManualPageDraft>,
  save: (pageId: string, draft: ManualPageDraft) => Promise<void>,
  onSaved: () => void,
) {
  for (const [pageId, draft] of [...drafts]) {
    if (drafts.get(pageId) !== draft) continue;
    await save(pageId, draft);
    if (drafts.get(pageId) === draft) drafts.delete(pageId);
    onSaved();
  }
}
