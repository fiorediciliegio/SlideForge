import type { ResearchDiscoveryProgress } from "./types";

/** Full bodies, image previews and streaming text are view-only; checkpoints own raw material. */
export function researchProgressForPersistence(progress: ResearchDiscoveryProgress): ResearchDiscoveryProgress {
  return { ...progress, records: progress.records.map(({ liveRounds: _rounds, fetchedPages: _pages, report: _report, ...record }) => ({
    ...record,
    sources: record.sources?.map(({ snippet: _snippet, ...source }) => source),
    queries: record.queries?.map(({ images: _images, ...query }) => ({ ...query,
      sources: query.sources?.map(({ snippet: _snippet, ...source }) => source),
    })),
  })) };
}
