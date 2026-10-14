export { researchProgressForPersistence } from "../../api/researchProgress";
import { messages } from "../../i18n";
import { streamedResearchReport } from "../process-progress/model";
import type { AgentRunOptions, AgentWebResearchSession, AgentImageResearchSession } from "../../agent/agentClient";
import type { ResearchDiscoveryProgress, ResearchLiveRound } from "../../api/types";
import type { DeckGenerationRuntime } from "./types";
import { emitRuntime } from "./progressProjection";
import { getAttemptLimits } from "./settings";

// Ephemeral content belongs to the current runtime, never to the persisted checkpoint.
const previewsByRuntime = new WeakMap<DeckGenerationRuntime, Map<string, string>>();

export function rememberResearchImagePreview(runtime: DeckGenerationRuntime, id: string, url: string) {
  let previews = previewsByRuntime.get(runtime);
  if (!previews) { previews = new Map(); previewsByRuntime.set(runtime, previews); }
  previews.set(id, url);
}

const roundsByRuntime = new WeakMap<DeckGenerationRuntime, Record<"web" | "image", ResearchLiveRound[]>>();

export function withResearchLiveProgress(runtime: DeckGenerationRuntime, progress: ResearchDiscoveryProgress): ResearchDiscoveryProgress {
  const rounds = roundsByRuntime.get(runtime);
  const previews = previewsByRuntime.get(runtime);
  if (!rounds && !previews) return progress;
  return { ...progress, records: progress.records.map((record) => ({ ...record,
    queries: record.queries?.map((query) => ({ ...query, images: query.images?.map((asset) => previews?.has(asset.id)
      ? { ...asset, thumbnailUrl: previews.get(asset.id), imageUrl: previews.get(asset.id) } : asset) })),
    ...(record.phase === "web-collection" ? { liveRounds: rounds?.web.map((round) => ({ ...round })) }
      : record.phase === "visual-collection" ? { liveRounds: rounds?.image.map((round) => ({ ...round })) } : {}),
  })) };
}

export async function runResearchSession(
  runtime: DeckGenerationRuntime, kind: "web" | "image", session: AgentWebResearchSession | AgentImageResearchSession,
  prompt: string, options: AgentRunOptions,
) {
  let state = roundsByRuntime.get(runtime);
  if (!state) { state = { web: [], image: [] }; roundsByRuntime.set(runtime, state); }
  const rounds = state[kind];
  const round: ResearchLiveRound = { id: `${kind}-${rounds.length + 1}`, text: "", state: "running", startedAt: Date.now() };
  rounds.push(round);
  let lastPaint = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const paint = () => {
    clearTimeout(timer);
    timer = undefined;
    if (runtime.isCancelled() || !runtime.researchDiscoveryProgress) return;
    lastPaint = Date.now();
    runtime.researchDiscoveryProgress = withResearchLiveProgress(runtime, runtime.researchDiscoveryProgress);
    const t = messages[runtime.locale].processProgress;
    const message = kind === "web" ? (streamedResearchReport(round.text) !== undefined ? t.reportWriting : t.web) : t.image;
    emitRuntime(runtime, { step: "prepare", message, currentPageIndex: null, totalPages: runtime.confirmedOutline.items.length }, runtime.getProgress(), undefined, getAttemptLimits(runtime));
  };
  paint();
  try {
    const result = await session.run(prompt, { ...options, onStreamEvent(event) {
      options.onStreamEvent?.(event);
      if (event.type === "content") round.text += event.text;
      if (Date.now() - lastPaint >= 80) paint();
      else if (!timer) timer = setTimeout(paint, 80 - (Date.now() - lastPaint));
    } });
    // The final authoritative response excludes content from transport retries.
    round.text = result;
    round.state = "completed";
    return result;
  } catch (error) { round.state = "failed"; throw error; }
  finally { round.endedAt = Date.now(); paint(); }
}

