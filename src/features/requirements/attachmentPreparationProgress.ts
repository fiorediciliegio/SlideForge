import type { Messages } from "../../i18n/messages";
import type { AttachmentPreparationState } from "../deck-workspace/types";

export function attachmentPreparationLabel(t: Messages, state: AttachmentPreparationState) {
  const progress = t.requirements.loadingProgress;
  const labelByPhase: Record<Exclude<AttachmentPreparationState["phase"], "idle">, string> = {
    preflight: progress.preflight,
    reading: progress.reading,
    analyzing: progress.analyzing,
    requirements: progress.requirements,
    "detecting-language": progress.detectingLanguage,
    "generating-requirements": progress.generatingRequirements,
    "selecting-style": progress.selectingStyle,
    "research-routing": progress.researchRouting,
  };
  const batchSuffix = state.phase === "analyzing" && state.chunkIndex && state.chunkCount
    ? ` · ${progress.analyzingBatch
      .replace("{current}", String(state.chunkIndex))
      .replace("{total}", String(state.chunkCount))}`
    : "";
  return state.phase === "idle" ? "" : `${labelByPhase[state.phase]}${batchSuffix}`;
}

export function attachmentPreparationInsight(t: Messages, state: AttachmentPreparationState) {
  // OCR progress is only meaningful during attachment preflight. Later phases
  // intentionally retain the attachment metadata, but must render their own
  // status rather than a stale OCR message.
  if (!state.ocrProgress || state.phase !== "preflight") return state.insight;
  const template = state.ocrProgress.currentPage === null
    ? t.requirements.loadingProgress.ocrProgress
    : t.requirements.loadingProgress.ocrProgressPage;
  return template
    .replace("{processed}", String(state.ocrProgress.processed))
    .replace("{total}", String(state.ocrProgress.total))
    .replace("{page}", String(state.ocrProgress.currentPage ?? ""));
}

