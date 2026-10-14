import { getResearchImageDownloadUrl } from "../../api/researchImageUrl";
import type { Locale } from "../../i18n/locales";
import { formatWebResearchRequirements } from "../../ai/requirementsFormatting";
import { runResearchSession, withResearchLiveProgress, researchProgressForPersistence, rememberResearchImagePreview } from "./researchLiveProgress";
import type { AgentImageAttachment } from "../../runtime/annaRuntime";
import {
  isAgentRunCancelledError,
  type AgentImageResearchSession,
  type AgentWebResearchSession,
} from "../../agent/agentClient";
import { readOutlineOutputLanguage, resolveResearchTextLocale, type ResearchTextLocale } from "../../ai/outputLanguage";
import type {
  ResearchDiscoveryProgress,
  ResearchDiscoveryProgressActivity,
  ResearchDiscoveryProgressPhaseRecord,
  ResearchDiscoveryProgressQuery,
  SharedResearchContextResult,
  SharedResearchImageBatch,
  SharedResearchImageCandidate,
  SharedResearchProgressOperation,
  SharedResearchStageState,
} from "../../api/types";
import type { AiOperationLogContext } from "../../ai/interactionLog";
import {
  createResearchWebOperationId,
  type ResearchImageSearchResult,
  type ResearchWebSearchResult,
  type ResearchWebCallContext,
  type ResearchWebFetchPage,
} from "../../api/researchWebClient";
import { emitRuntime } from "./progressProjection";
import { encodeDiagnostic } from "../../i18n/diagnostics";
import {
  getAttemptLimits,
  getImageResearchMaxSearches,
  getResearchImageSessionConcurrency,
  getWebResearchMaxRounds,
} from "./settings";
import { throwIfCancelled } from "./runtimeSupport";
import type { DeckGenerationRuntime } from "./types";
import { beginPerformanceSpan } from "../../performance/performanceRecorder";
import {
  buildWebFetchResultPrompt,
  buildWebResearchAgentInitialPrompt,
  buildWebResearchProtocolRepairPrompt,
  buildWebResearchRoundLimitFinishPrompt,
  buildWebResearchRoundLimitRepairPrompt,
  buildWebSearchResultPrompt,
  parseWebResearchAgentAction,
  WEB_RESEARCH_AGENT_MAX_CONSECUTIVE_PROTOCOL_ERRORS,
  WEB_RESEARCH_AGENT_MODEL,
  WEB_RESEARCH_AGENT_SYSTEM_PROMPT,
  type WebResearchAgentAction,
} from "../../ai/webResearchAgent";
import {
  buildImageResearchAgentInitialPrompt,
  buildImageResearchAgentProtocolRepairPrompt,
  buildImageResearchAgentResultPrompt,
  IMAGE_RESEARCH_AGENT_MAX_CONSECUTIVE_PROTOCOL_ERRORS,
  IMAGE_RESEARCH_AGENT_MODEL,
  IMAGE_RESEARCH_AGENT_SYSTEM_PROMPT,
  parseImageResearchAgentAction,
  type ImageResearchAgentAction,
} from "../../ai/imageResearchAgent";

type StageKey =
  | "web_decision"
  | "web_research"
  | "image_decision"
  | "image_research"
  | "image_search"
  | "image_deduplication"
  | "image_prefetch"
  | "image_analysis"
  | "image_import";

type ImageWorkState = "waiting" | "running" | "completed" | "warning";

interface ResearchSearchResultForSelection extends ResearchWebSearchResult {
  result_id: string;
}

async function measureResearchOperation<T>(
  runtime: DeckGenerationRuntime,
  operationName: string,
  task: () => Promise<T>,
  attributes: Record<string, string | number | boolean | null> = {},
  layer = "workflow",
): Promise<T> {
  const span = beginPerformanceSpan({
    operationName,
    workspaceId: runtime.workspace.workspace_id,
    attributes: { layer, ...attributes },
  });
  try {
    const result = await task();
    span?.finish("ok");
    return result;
  } catch (error) {
    span?.finish(isAgentRunCancelledError(error) || runtime.isCancelled() ? "interrupted" : "error");
    throw error;
  }
}

interface ImageSearchOccurrence extends ResearchImageSearchResult {
  occurrence_id: string;
  query: string;
  query_index: number;
  result_index: number;
}

interface ImageDeduplicationGroup {
  dedup_key: string;
  candidate_id: string;
  representative_occurrence_id: string;
  occurrence_ids: string[];
  matched_query_indexes: number[];
}

interface ImageAnalysisBatchCheckpoint {
  batch_id: string;
  candidate_ids: string[];
  status: "pending" | "running" | "completed" | "failed";
  attempt: number;
  interaction_ids: string[];
  started_at?: string;
  completed_at?: string;
  error?: string;
}

interface QueryCheckpoint<T> {
  query: string;
  status: "running" | "completed" | "warning";
  result?: T;
  error?: string;
}

interface WebAgentLoopRound {
  session_attempt: number;
  round: number;
  status: "action" | "protocol_error";
  action?: "search" | "fetch" | "finish";
  queries?: string[];
  urls?: string[];
  result_status?: "completed" | "warning" | "cached";
  error?: string;
}

interface WebResearchDecisionCheckpoint {
  needs_search: boolean;
  queries: string[];
  rationale?: string;
  mode?: "agent-session-v1";
  session_attempt?: number;
  rounds?: WebAgentLoopRound[];
}

interface ImageAgentLoopRound {
  session_attempt: number;
  round: number;
  status: "action" | "protocol_error";
  action?: "search" | "finish";
  query?: string;
  result_status?: "completed" | "warning" | "cached";
  candidate_ids?: string[];
  error?: string;
}

interface ImageResearchDecisionCheckpoint {
  needs_search: boolean;
  queries: string[];
  rationale?: string;
  mode?: "agent-session-v2";
  session_attempt?: number;
  rounds?: ImageAgentLoopRound[];
}

export interface LinearResearchCheckpoint {
  schema_version: 2;
  status: SharedResearchStageState;
  stages: Record<StageKey, SharedResearchStageState>;
  web?: {
    decision?: WebResearchDecisionCheckpoint;
    searches?: Array<QueryCheckpoint<ResearchSearchResultForSelection[]>>;
    fetch_result_ids?: string[];
    fetched_pages?: ResearchWebFetchPage[];
    gaps?: string[];
    diagnostic_errors?: string[];
    prepared_batch?: string;
    written?: boolean;
  };
  image?: {
    decision?: ImageResearchDecisionCheckpoint;
    searches?: Array<QueryCheckpoint<ImageSearchOccurrence[]>>;
    search_status?: ImageWorkState;
    prepare_status?: ImageWorkState;
    deduplication?: {
      status: ImageWorkState;
      strategy: {
        version: 1;
        key: "normalized_image_url";
        remove_fragment: true;
        remove_default_port: true;
        sort_query_parameters: true;
        removed_tracking_parameters: string[];
      };
      statistics: {
        raw_occurrences: number;
        unique_urls: number;
        duplicate_occurrences: number;
        duplicate_groups: number;
      };
      groups: ImageDeduplicationGroup[];
      completed_at?: string;
    };
    candidates?: SharedResearchImageCandidate[];
    analysis_status?: ImageWorkState;
    analysis_batches?: ImageAnalysisBatchCheckpoint[];
    import_status?: ImageWorkState;
    content_deduplication?: {
      status: ImageWorkState;
      strategy?: {
        version: 2;
        key: "sha256";
        source: "anna.web.image_fetch";
      };
      statistics: {
        fetched_candidates: number;
        unique_content: number;
        duplicate_content_candidates: number;
      };
      groups: Array<{
        sha256: string;
        representative_candidate_id: string;
        candidate_ids: string[];
      }>;
      completed_at?: string;
    };
    gaps?: string[];
    diagnostic_errors?: string[];
    prepared_batch?: SharedResearchImageBatch;
    written?: boolean;
  };
  updated_at?: string;
}

const STAGE_ORDER: StageKey[] = [
  "web_decision",
  "web_research",
  "image_decision",
  "image_research",
  "image_search",
  "image_deduplication",
  "image_prefetch",
  "image_analysis",
  "image_import",
];

export function readCheckpoint(value: Record<string, unknown>): LinearResearchCheckpoint {
  const compatible = value.schema_version === 2;
  const stagesRecord = compatible && value.stages && typeof value.stages === "object" && !Array.isArray(value.stages)
    ? value.stages as Record<string, unknown>
    : {};
  const state = (key: StageKey): SharedResearchStageState => {
    const value = stagesRecord[key];
    return value === "running" || value === "completed" || value === "skipped" || value === "warning"
      ? value
      : "waiting";
  };
  return {
    schema_version: 2,
    status: compatible && (value.status === "running" || value.status === "completed" || value.status === "skipped" || value.status === "warning")
      ? value.status
      : "waiting",
    stages: Object.fromEntries(STAGE_ORDER.map((key) => [key, state(key)])) as Record<StageKey, SharedResearchStageState>,
    ...(compatible && value.web && typeof value.web === "object" && !Array.isArray(value.web) ? { web: value.web as LinearResearchCheckpoint["web"] } : {}),
    ...(compatible && value.image && typeof value.image === "object" && !Array.isArray(value.image) ? { image: value.image as LinearResearchCheckpoint["image"] } : {}),
  };
}

function migrateLegacyImageCheckpoint(checkpoint: LinearResearchCheckpoint): LinearResearchCheckpoint {
  const migrated = structuredClone(checkpoint);
  const image = migrated.image as (NonNullable<LinearResearchCheckpoint["image"]> & { prefetch_status?: ImageWorkState }) | undefined;
  if (!image) return migrated;
  if (!image.prepare_status && image.prefetch_status) image.prepare_status = image.prefetch_status;
  delete image.prefetch_status;
  image.candidates = image.candidates?.map((value) => {
    const candidate = value as SharedResearchImageCandidate & {
      prefetch_status?: "pending" | "running" | "completed" | "failed";
      prefetch_interaction_id?: string;
      prefetch_error?: string;
      download_status?: "pending" | "imported" | "failed";
    };
    if (!candidate.aps_fetch_status) candidate.aps_fetch_status = candidate.aps_path ? "completed" : "pending";
    if (!candidate.local_download_status && candidate.prefetch_status) {
      candidate.local_download_status = candidate.prefetch_status === "completed" ? "pending" : candidate.prefetch_status;
    }
    if (!candidate.upload_status) candidate.upload_status = candidate.content_duplicate_of ? "skipped" : "pending";
    if (!candidate.import_status && candidate.download_status) candidate.import_status = candidate.download_status;
    candidate.import_status ??= "pending";
    delete candidate.prefetch_status;
    delete candidate.prefetch_interaction_id;
    delete candidate.prefetch_error;
    delete candidate.download_status;
    return candidate;
  });
  return migrated;
}

const IMAGE_ANALYSIS_BATCH_SIZE = 6;
// Keep the provider's decimal MB limit explicit in bytes.
const IMAGE_AGENT_SINGLE_ATTACHMENT_BYTES_LIMIT = 3_000_000;
const IMAGE_AGENT_ATTACHMENT_BYTES_BUDGET = 30_000_000;
const IMAGE_CANDIDATE_IO_CONCURRENCY = 16;
const IMAGE_DEDUP_TRACKING_PARAMETERS = [
  "utm_*",
  "fbclid",
  "gclid",
];

interface ImageAttachmentSelection {
  selected: SharedResearchImageCandidate[];
  skippedForSize: SharedResearchImageCandidate[];
  skippedForBudget: SharedResearchImageCandidate[];
  skippedForBatchSize: SharedResearchImageCandidate[];
  totalBytes: number;
}

function selectImageAgentAttachments(
  candidates: SharedResearchImageCandidate[],
  usedBytes: number,
): ImageAttachmentSelection {
  const selected: SharedResearchImageCandidate[] = [];
  const skippedForSize: SharedResearchImageCandidate[] = [];
  const skippedForBudget: SharedResearchImageCandidate[] = [];
  const skippedForBatchSize: SharedResearchImageCandidate[] = [];
  let totalBytes = 0;

  for (const candidate of candidates) {
    if (selected.length >= IMAGE_ANALYSIS_BATCH_SIZE) {
      skippedForBatchSize.push(candidate);
      continue;
    }
    const bytes = candidate.bytes_size ?? 0;
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > IMAGE_AGENT_SINGLE_ATTACHMENT_BYTES_LIMIT) {
      skippedForSize.push(candidate);
      continue;
    }
    if (usedBytes + totalBytes + bytes > IMAGE_AGENT_ATTACHMENT_BYTES_BUDGET) {
      skippedForBudget.push(candidate);
      continue;
    }
    selected.push(candidate);
    totalBytes += bytes;
  }

  return { selected, skippedForSize, skippedForBudget, skippedForBatchSize, totalBytes };
}

function markImageCandidateSkipped(
  candidate: SharedResearchImageCandidate,
  reason: string,
  description: string,
) {
  Object.assign(candidate, {
    use_in_ppt: false,
    description,
    reason,
    analysis_status: "skipped" as const,
    import_status: "skipped" as const,
  });
}

function isImageDedupTrackingParameter(parameter: string) {
  const normalized = parameter.toLowerCase();
  return normalized.startsWith("utm_") || normalized === "fbclid" || normalized === "gclid";
}

function stableShortHash(value: string) {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function normalizeImageUrlForDedup(rawUrl: string) {
  const trimmed = rawUrl.trim();
  try {
    const url = new URL(trimmed);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = "";
    }
    const sorted = [...url.searchParams.entries()]
      .filter(([key]) => !isImageDedupTrackingParameter(key))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        const keyOrder = leftKey.localeCompare(rightKey);
        return keyOrder !== 0 ? keyOrder : leftValue.localeCompare(rightValue);
      });
    url.search = "";
    for (const [key, value] of sorted) url.searchParams.append(key, value);
    return url.toString();
  } catch {
    return trimmed;
  }
}

function createImageCandidateId(dedupKey: string) {
  return `image-${stableShortHash(dedupKey)}`;
}

function progressPublishInterval(total: number) {
  return Math.max(1, Math.ceil(total / 6));
}

function progressState(state: SharedResearchStageState): ResearchDiscoveryProgressPhaseRecord["state"] {
  return state;
}

export function buildLinearResearchUiProgress(
  checkpoint: LinearResearchCheckpoint,
  now = new Date().toISOString(),
): ResearchDiscoveryProgress {
  const webQueries = projectWebQueries(checkpoint);
  const imageQueries = projectImageQueries(checkpoint);
  const webSources = webQueries.flatMap((query) => query.sources ?? []).slice(0, 8);
  const imageCandidates = checkpoint.image?.candidates ?? [];
  const importedImages = imageCandidates.filter((candidate) => candidate.import_status === "imported").length;
  const gaps = [...(checkpoint.web?.gaps ?? []), ...(checkpoint.image?.gaps ?? [])];
  const records: ResearchDiscoveryProgressPhaseRecord[] = [
    {
      phase: "web-decision",
      state: progressState(checkpoint.stages.web_decision),
      activity: checkpoint.stages.web_decision === "running" ? { kind: "web-decision" } : undefined,
      rationale: trimUiText(checkpoint.web?.decision?.rationale, 320),
      gaps: checkpoint.stages.web_decision === "warning" ? checkpoint.web?.gaps?.slice(0, 6) : undefined,
      updatedAt: now,
    },
    {
      phase: "web-collection",
      state: progressState(checkpoint.stages.web_research),
      activity: webActivity(checkpoint),
      queries: checkpoint.stages.web_research === "waiting" ? undefined : webQueries,
      fetchedPages: projectFetchedPages(checkpoint),
      report: checkpoint.web?.prepared_batch,
      sources: webSources,
      gaps: checkpoint.web?.gaps?.slice(0, 8),
      counts: checkpoint.web?.gaps?.length ? { gaps: checkpoint.web.gaps.length } : undefined,
      updatedAt: now,
    },
    {
      phase: "visual-decision",
      state: progressState(checkpoint.stages.image_decision),
      activity: checkpoint.stages.image_decision === "running" ? { kind: "image-decision" } : undefined,
      rationale: trimUiText(checkpoint.image?.decision?.rationale, 320),
      gaps: checkpoint.stages.image_decision === "warning" ? checkpoint.image?.gaps?.slice(0, 6) : undefined,
      updatedAt: now,
    },
    {
      phase: "visual-collection",
      state: progressState(checkpoint.stages.image_research),
      activity: imageActivity(checkpoint),
      queries: checkpoint.stages.image_research === "waiting" ? undefined : imageQueries,
      gaps: checkpoint.image?.gaps?.slice(0, 8),
      counts: checkpoint.stages.image_research === "waiting"
        ? undefined
        : { visualAssets: importedImages, ...(checkpoint.image?.gaps?.length ? { gaps: checkpoint.image.gaps.length } : {}) },
      updatedAt: now,
    },
  ];
  return {
    status: progressState(checkpoint.status),
    records,
    summary: { facts: 0, derivedInsights: 0, visualAssets: importedImages, gaps: gaps.length, rejectedMaterial: 0 },
    updatedAt: now,
  };
}

function projectFetchedPages(checkpoint: LinearResearchCheckpoint) {
  const fetched = checkpoint.web?.fetched_pages ?? [];
  const requested = [...new Set((checkpoint.web?.decision?.rounds ?? []).flatMap((round) => round.urls ?? []))];
  return [...fetched.map((page) => ({ ...page })), ...requested.filter((url) => !fetched.some((page) => page.url === url))
    .map((url) => ({ url, ok: false, pending: true }))];
}

function projectWebQueries(checkpoint: LinearResearchCheckpoint): ResearchDiscoveryProgressQuery[] {
  const decisionQueries = checkpoint.web?.decision?.queries ?? [];
  const searches = new Map((checkpoint.web?.searches ?? []).map((search) => [search.query, search]));
  const fetchedPages = checkpoint.web?.fetched_pages ?? [];
  const fetchedUrls = new Set(fetchedPages
    .filter((page) => page.ok)
    .flatMap((page) => [page.url, page.final_url].filter((value): value is string => Boolean(value))));
  return decisionQueries.map((query) => {
    const search = searches.get(query);
    const results = search?.result ?? [];
    const fetchedResults = results.filter((result) => fetchedUrls.has(result.url));
    return {
      kind: "web",
      query,
      status: queryStatus(search),
      ...(search ? { resultCount: results.length } : {}),
      ...(fetchedResults.length > 0 ? { fetchCount: fetchedResults.length } : {}),
      sources: results.map((result) => ({ title: result.title, url: result.url, snippet: result.snippet })),
      message: search?.error,
    };
  });
}

export function projectImageQueries(checkpoint: LinearResearchCheckpoint): ResearchDiscoveryProgressQuery[] {
  const decisionQueries = checkpoint.image?.decision?.queries ?? [];
  const searches = new Map((checkpoint.image?.searches ?? []).map((search) => [search.query, search]));
  const candidates = checkpoint.image?.candidates ?? [];
  return decisionQueries.map((query) => {
    const search = searches.get(query);
    const downloaded = candidates.filter((candidate) => (
      (candidate.matched_queries ?? [candidate.query]).includes(query) && candidate.aps_fetch_status === "completed"
    )).length;
    return {
      kind: "visual",
      images: candidates.filter((candidate) => (candidate.matched_queries ?? [candidate.query]).includes(query)).map((candidate) => ({
        id: candidate.candidate_id, title: candidate.title ?? undefined, imageUrl: candidate.image_url, thumbnailUrl: candidate.thumbnail_url ?? undefined,
        pageUrl: candidate.source_url, reason: candidate.reason, visualSummary: candidate.description,
        state: candidate.content_duplicate_of ? "duplicate" as const
          : candidate.import_status === "imported" ? "available" as const
          : candidate.import_status === "failed" || candidate.aps_fetch_status === "failed" ? "unavailable" as const
          : candidate.use_in_ppt ? "selected" as const
          : candidate.analysis_status === "completed" || candidate.analysis_status === "skipped" ? "rejected" as const : "candidate" as const,
      })),
      message: search?.error,
      query,
      status: queryStatus(search),
      ...(search ? { resultCount: search.result?.length ?? 0 } : {}),
      ...(downloaded > 0 ? { downloadCount: downloaded } : {}),
    };
  });
}

function queryStatus(search: QueryCheckpoint<unknown> | undefined): ResearchDiscoveryProgressQuery["status"] {
  if (!search || search.status === "running") return "running";
  if (search.status === "completed") return "collected";
  return search.error ? "error" : "gap";
}

function webActivity(checkpoint: LinearResearchCheckpoint): ResearchDiscoveryProgressActivity | undefined {
  const state = checkpoint.stages.web_research;
  const decision = checkpoint.web?.decision;
  if (state === "waiting") return undefined;
  if (state === "skipped" || decision?.needs_search === false) return { kind: "web-skipped" };
  const searches = checkpoint.web?.searches ?? [];
  const queryTotal = decision?.queries.length ?? 0;
  const completedQueries = searches.filter((search) => search.status !== "running").length;
  if (state === "running" && (searches.length < queryTotal || searches.some((search) => search.status === "running"))) {
    return { kind: "web-search", completed: completedQueries, total: queryTotal };
  }
  const allResults = searches.flatMap((search) => search.result ?? []);
  if (state === "running" && checkpoint.web?.fetch_result_ids === undefined) return { kind: "web-fetch-selection" };
  const selectedUrls = new Set((checkpoint.web?.fetch_result_ids ?? []).map((resultId) => allResults.find((result) => result.result_id === resultId)?.url).filter((value): value is string => Boolean(value)));
  const fetchedPages = checkpoint.web?.fetched_pages ?? [];
  const fetchedUrls = new Set(fetchedPages.map((page) => page.url));
  const fetchedCount = [...selectedUrls].filter((url) => fetchedUrls.has(url)).length;
  if (state === "running" && fetchedCount < selectedUrls.size) {
    return { kind: "web-fetch", completed: fetchedCount, total: selectedUrls.size };
  }
  if (state === "running" && !checkpoint.web?.prepared_batch) return { kind: "web-synthesis" };
  if (state === "running" && !checkpoint.web?.written) return { kind: "web-publish" };
  return { kind: "web-complete", count: allResults.length, completed: fetchedPages.filter((page) => page.ok).length };
}

function imageActivity(checkpoint: LinearResearchCheckpoint): ResearchDiscoveryProgressActivity | undefined {
  const state = checkpoint.stages.image_research;
  const decision = checkpoint.image?.decision;
  if (state === "waiting") return undefined;
  if (state === "skipped" || decision?.needs_search === false) return { kind: "image-skipped" };
  const searches = checkpoint.image?.searches ?? [];
  const queryTotal = decision?.queries.length ?? 0;
  if (checkpoint.stages.image_search === "waiting" || checkpoint.stages.image_search === "running") {
    return { kind: "image-search", completed: searches.filter((search) => search.status !== "running").length, total: queryTotal };
  }
  const candidates = checkpoint.image?.candidates ?? [];
  if (checkpoint.stages.image_deduplication === "running") {
    return { kind: "image-deduplication", count: searches.reduce((count, search) => count + (search.result?.length ?? 0), 0) };
  }
  if (checkpoint.stages.image_prefetch === "waiting" || checkpoint.stages.image_prefetch === "running") {
    const downloaded = candidates.filter((candidate) => candidate.aps_fetch_status === "completed" || candidate.aps_fetch_status === "failed").length;
    const downloadFailed = candidates.filter((candidate) => candidate.aps_fetch_status === "failed").length;
    if (downloaded < candidates.length) {
      return { kind: "image-download", completed: downloaded, total: candidates.length, failed: downloadFailed };
    }
    return { kind: "image-prepare", completed: downloaded, total: candidates.length, failed: downloadFailed };
  }
  const batches = checkpoint.image?.analysis_batches ?? [];
  const selected = candidates.filter((candidate) => candidate.use_in_ppt).length;
  if (checkpoint.stages.image_analysis === "waiting" || checkpoint.stages.image_analysis === "running") {
    return {
      kind: "image-analysis",
      completed: batches.filter((batch) => batch.status === "completed" || batch.status === "failed").length,
      total: batches.length,
      selected,
    };
  }
  const imported = candidates.filter((candidate) => candidate.import_status === "imported").length;
  const importFailed = candidates.filter((candidate) => candidate.import_status === "failed").length;
  if (checkpoint.stages.image_import === "waiting" || checkpoint.stages.image_import === "running" || !checkpoint.image?.prepared_batch) {
    return { kind: "image-import", completed: imported, total: selected, failed: importFailed };
  }
  if (state === "running" && !checkpoint.image?.written) return { kind: "image-publish" };
  return { kind: "image-complete", selected, completed: imported };
}

function trimUiText(value: string | null | undefined, maxLength: number) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

const STAGE_MESSAGES: Record<Locale, Record<StageKey, string>> = {
  zh: {
    web_decision: "正在判断是否需要网页资料",
    web_research: "正在搜索并整理网页资料",
    image_decision: "正在判断是否需要图片素材",
    image_research: "正在搜索并筛选图片素材",
    image_search: "正在搜索图片候选",
    image_deduplication: "正在合并重复图片",
    image_prefetch: "正在获取并准备图片候选",
    image_analysis: "正在判断图片可用性",
    image_import: "正在保存可用图片",
  },
  en: {
    web_decision: "Deciding whether web research is needed",
    web_research: "Searching and organizing web research",
    image_decision: "Deciding whether image research is needed",
    image_research: "Searching and selecting image material",
    image_search: "Searching for image candidates",
    image_deduplication: "Deduplicating image candidates",
    image_prefetch: "Fetching and preparing image candidates",
    image_analysis: "Assessing image candidates",
    image_import: "Saving selected images",
  },
  ja: {
    web_decision: "Web 資料が必要かどうかを判断中",
    web_research: "Web 資料を検索・整理中",
    image_decision: "画像素材が必要かどうかを判断中",
    image_research: "画像素材を検索・選定中",
    image_search: "画像候補を検索中",
    image_deduplication: "重複画像を統合中",
    image_prefetch: "画像候補を取得・準備中",
    image_analysis: "画像候補の可用性を評価中",
    image_import: "選択された画像を保存中",
  },
  de: {
    web_decision: "Es wird geprüft, ob Web-Recherche nötig ist",
    web_research: "Web-Recherche wird durchsucht und aufbereitet",
    image_decision: "Es wird geprüft, ob Bildmaterial nötig ist",
    image_research: "Bildmaterial wird gesucht und ausgewählt",
    image_search: "Bildkandidaten werden gesucht",
    image_deduplication: "Doppelte Bilder werden zusammengeführt",
    image_prefetch: "Bildkandidaten werden abgerufen und vorbereitet",
    image_analysis: "Bildkandidaten werden bewertet",
    image_import: "Ausgewählte Bilder werden gespeichert",
  },
};

function stageMessage(runtime: DeckGenerationRuntime, stage: StageKey) {
  return STAGE_MESSAGES[runtime.locale][stage];
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function changedByKey(
  previous: unknown,
  next: unknown,
  key: string,
) {
  const previousByKey = new Map((Array.isArray(previous) ? previous : []).map((item) => {
    const record = plainRecord(item);
    return [String(record[key] ?? ""), record] as const;
  }));
  return (Array.isArray(next) ? next : []).map(plainRecord).filter((item) => {
    const identity = String(item[key] ?? "");
    return identity && !sameValue(previousByKey.get(identity), item);
  });
}

export const SHARED_RESEARCH_PATCH_MAX_BYTES = 32 * 1024;

function serializedWebSearchOperationBytes(workspaceDir: string, query: string, search: Record<string, unknown>) {
  return new TextEncoder().encode(JSON.stringify({
    workspace_dir: workspaceDir,
    operations: [{ op: "upsert_web_search", query, search }],
  })).byteLength;
}

/** Keep one Web search upsert within the inline patch budget without dropping its metadata. */
export function compactWebSearchRecordForPatch(
  workspaceDir: string,
  input: Record<string, unknown>,
  maxBytes = SHARED_RESEARCH_PATCH_MAX_BYTES,
) {
  const search = structuredClone(input);
  const query = String(search.query ?? "");
  const results = Array.isArray(search.result) ? search.result.map(plainRecord) : [];
  search.result = results;
  while (serializedWebSearchOperationBytes(workspaceDir, query, search) > maxBytes) {
    const candidates = results
      .map((result, index) => ({ result, index, bytes: new TextEncoder().encode(String(result.snippet ?? "")).byteLength }))
      .filter((candidate) => candidate.bytes > 0)
      .sort((left, right) => right.bytes - left.bytes);
    if (candidates.length === 0) {
      throw new Error(`Single shared research progress operation exceeds ${maxBytes} bytes`);
    }
    const candidate = candidates[0];
    const current = String(candidate.result.snippet ?? "");
    let low = 0;
    let high = Array.from(current).length;
    let best = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const prefix = Array.from(current).slice(0, middle).join("");
      const snippet = middle < Array.from(current).length ? `${prefix}…` : prefix;
      const next = { ...search, result: results.map((result, index) => index === candidate.index ? { ...result, snippet } : result) };
      if (serializedWebSearchOperationBytes(workspaceDir, query, next) <= maxBytes) {
        best = snippet;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    results[candidate.index] = { ...candidate.result, snippet: best };
  }
  return search;
}

export function chunkSharedResearchProgressOperations(
  workspaceDir: string,
  operations: SharedResearchProgressOperation[],
  maxBytes = SHARED_RESEARCH_PATCH_MAX_BYTES,
) {
  const batches: SharedResearchProgressOperation[][] = [];
  let current: SharedResearchProgressOperation[] = [];
  for (const operation of operations) {
    const candidate = [...current, operation];
    const bytes = new TextEncoder().encode(JSON.stringify({ workspace_dir: workspaceDir, operations: candidate })).byteLength;
    if (bytes <= maxBytes) {
      current = candidate;
      continue;
    }
    if (current.length === 0) throw new Error(`Single shared research progress operation exceeds ${maxBytes} bytes`);
    batches.push(current);
    current = [operation];
    const singleBytes = new TextEncoder().encode(JSON.stringify({ workspace_dir: workspaceDir, operations: current })).byteLength;
    if (singleBytes > maxBytes) throw new Error(`Single shared research progress operation exceeds ${maxBytes} bytes`);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function buildSharedResearchProgressOperations(
  workspaceDir: string,
  previous: LinearResearchCheckpoint,
  next: LinearResearchCheckpoint,
): SharedResearchProgressOperation[] {
  const operations: SharedResearchProgressOperation[] = [];
  const previousWeb = previous.web ?? {};
  const nextWeb = next.web ?? {};
  const previousImage = previous.image ?? {};
  const nextImage = next.image ?? {};

  if (!sameValue(previousWeb.decision, nextWeb.decision) && nextWeb.decision) {
    operations.push({ op: "set_web_decision", decision: structuredClone(nextWeb.decision) as unknown as Record<string, unknown> });
  }
  for (const search of changedByKey(previousWeb.searches, nextWeb.searches, "query")) {
    const query = String(search.query);
    operations.push({ op: "upsert_web_search", query, search: compactWebSearchRecordForPatch(workspaceDir, search) });
  }
  if (!sameValue(previousWeb.fetch_result_ids, nextWeb.fetch_result_ids) && nextWeb.fetch_result_ids) {
    operations.push({ op: "set_web_fetch_result_ids", result_ids: [...nextWeb.fetch_result_ids] });
  }
  for (const page of changedByKey(previousWeb.fetched_pages, nextWeb.fetched_pages, "url")) {
    operations.push({ op: "upsert_web_fetched_page", url: String(page.url), page });
  }
  if (!sameValue(previousWeb.prepared_batch, nextWeb.prepared_batch) && nextWeb.prepared_batch) {
    operations.push({ op: "set_web_prepared_batch", markdown: nextWeb.prepared_batch });
  }
  if (!sameValue(previousWeb.gaps, nextWeb.gaps) || !sameValue(previousWeb.diagnostic_errors, nextWeb.diagnostic_errors)) {
    operations.push({ op: "set_web_diagnostics", gaps: [...(nextWeb.gaps ?? [])], diagnostic_errors: [...(nextWeb.diagnostic_errors ?? [])] });
  }

  if (!sameValue(previousImage.decision, nextImage.decision) && nextImage.decision) {
    operations.push({ op: "set_image_decision", decision: structuredClone(nextImage.decision) as unknown as Record<string, unknown> });
  }
  for (const search of changedByKey(previousImage.searches, nextImage.searches, "query")) {
    operations.push({ op: "upsert_image_search", query: String(search.query), search });
  }
  for (const field of ["search_status", "prepare_status", "analysis_status", "import_status"] as const) {
    const value = nextImage[field];
    if (value && value !== previousImage[field]) operations.push({ op: "set_image_work_status", field, state: value });
  }

  const previousCandidates = new Map((previousImage.candidates ?? []).map((candidate) => [candidate.candidate_id, candidate]));
  const analysisCandidateIds = new Set<string>();
  if (nextImage.deduplication && !sameValue(previousImage.deduplication, nextImage.deduplication)) {
    for (const group of nextImage.deduplication.groups ?? []) {
      const candidate = (nextImage.candidates ?? []).find((item) => item.candidate_id === group.candidate_id);
      const previousGroup = previousImage.deduplication?.groups?.find((item) => item.candidate_id === group.candidate_id);
      if (candidate && (!sameValue(previousGroup, group) || !previousCandidates.has(candidate.candidate_id))) {
        operations.push({
          op: "upsert_image_deduplication_entry",
          candidate_id: candidate.candidate_id,
          group: structuredClone(group) as unknown as Record<string, unknown>,
          candidate: structuredClone(candidate) as unknown as Record<string, unknown>,
        });
      }
    }
    if (nextImage.deduplication.status === "completed") {
      operations.push({
        op: "set_image_deduplication_summary",
        strategy: structuredClone(nextImage.deduplication.strategy) as unknown as Record<string, unknown>,
        statistics: structuredClone(nextImage.deduplication.statistics) as unknown as Record<string, unknown>,
      });
    }
  }
  for (const batch of changedByKey(previousImage.analysis_batches, nextImage.analysis_batches, "batch_id")) {
    const candidateIds = new Set(Array.isArray(batch.candidate_ids) ? batch.candidate_ids.map(String) : []);
    const candidates = (nextImage.candidates ?? [])
      .filter((candidate) => candidateIds.has(candidate.candidate_id))
      .filter((candidate) => !sameValue(previousCandidates.get(candidate.candidate_id), candidate))
      .map((candidate) => ({ candidate_id: candidate.candidate_id, candidate: structuredClone(candidate) as unknown as Record<string, unknown> }));
    for (const candidate of candidates) analysisCandidateIds.add(candidate.candidate_id);
    operations.push({ op: "upsert_image_analysis_batch", batch_id: String(batch.batch_id), batch, candidates });
  }
  for (const candidate of nextImage.candidates ?? []) {
    const previousCandidate = previousCandidates.get(candidate.candidate_id);
    if (previousCandidate && !sameValue(previousCandidate, candidate) && !analysisCandidateIds.has(candidate.candidate_id)) {
      operations.push({ op: "upsert_image_candidate", candidate_id: candidate.candidate_id, candidate: structuredClone(candidate) as unknown as Record<string, unknown> });
    }
  }
  if (!sameValue(previousImage.gaps, nextImage.gaps) || !sameValue(previousImage.diagnostic_errors, nextImage.diagnostic_errors)) {
    operations.push({ op: "set_image_diagnostics", gaps: [...(nextImage.gaps ?? [])], diagnostic_errors: [...(nextImage.diagnostic_errors ?? [])] });
  }
  if (!sameValue(previousImage.content_deduplication, nextImage.content_deduplication) && nextImage.content_deduplication) {
    operations.push({ op: "set_image_content_deduplication", value: structuredClone(nextImage.content_deduplication) as unknown as Record<string, unknown> });
  }
  if (!sameValue(previousImage.prepared_batch, nextImage.prepared_batch) && nextImage.prepared_batch) {
    operations.push({
      op: "finalize_image_research",
      title: nextImage.prepared_batch.title,
      status: nextImage.prepared_batch.status,
      queries: structuredClone(nextImage.prepared_batch.queries) as unknown as Array<Record<string, unknown>>,
      gaps: [...nextImage.prepared_batch.gaps],
      statistics: structuredClone(nextImage.prepared_batch.statistics ?? {}) as unknown as Record<string, unknown>,
    });
  }

  for (const stage of STAGE_ORDER) {
    if (previous.stages[stage] !== next.stages[stage]) operations.push({ op: "set_stage", stage, state: next.stages[stage] });
  }
  if (previous.status !== next.status && next.status !== "running" && next.status !== "waiting") {
    operations.push({ op: "finalize_shared_research" });
  }
  return operations;
}

async function setStage(
  runtime: DeckGenerationRuntime,
  checkpoint: LinearResearchCheckpoint,
  stage: StageKey,
  state: SharedResearchStageState,
  persistAndPublish: (message: string) => Promise<void>,
) {
  checkpoint.status = state === "running" ? "running" : checkpoint.status;
  checkpoint.stages[stage] = state;
  await persistAndPublish(stageMessage(runtime, stage));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function researchImageErrorMessage(error: unknown) {
  const message = errorMessage(error);
  const status = message.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
  if (status) return `Anna image_fetch failed with HTTP ${status}.`;
  const compact = message.replace(/<!doctype html[\s\S]*$/i, "").replace(/<html[\s\S]*$/i, "").trim();
  return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
}

async function logResearchImageError(
  runtime: DeckGenerationRuntime,
  operation: string,
  error: unknown,
  detail?: Record<string, unknown>,
) {
  await logResearchError(runtime, operation, new Error(researchImageErrorMessage(error)), detail);
}

function appendUnique(list: string[] | undefined, value: string) {
  return [...new Set([...(list ?? []), value])];
}

function researchLogContext(runtime: DeckGenerationRuntime, operation: string, kind?: string): AiOperationLogContext | undefined {
  if (!runtime.aiLogger) return undefined;
  return {
    logger: runtime.aiLogger,
    workspace_dir: runtime.workspace.workspace_dir,
    domain: "research",
    operation,
    operation_id: runtime.aiLogger.createOperationId("research", operation),
    ...(kind ? { kind } : {}),
    provider: "anna",
    runtime_mode: "anna",
  };
}

async function logResearchError(runtime: DeckGenerationRuntime, operation: string, error: unknown, detail: Record<string, unknown> = {}) {
  await runtime.backend.appendWorkspaceLog({
    workspace_dir: runtime.workspace.workspace_dir,
    channel: "ai-research",
    entry: { event: "research.warning", operation, error: errorMessage(error), ...detail, at: new Date().toISOString() },
  }).catch(() => undefined);
}

/** 研究批次文案语言：跟随 OutputLanguage（PPT 内容语言），不跟随界面语言。
 *  这些文本会经 prepared_batch → web-summary.md 进入后续生成 prompt。 */
function researchTextLocale(runtime: DeckGenerationRuntime): ResearchTextLocale {
  return resolveResearchTextLocale(readOutlineOutputLanguage(runtime.confirmedOutline));
}

function batchTitle(runtime: DeckGenerationRuntime) {
  const locale = researchTextLocale(runtime);
  if (runtime.refinementRunKind === "page-refinement") {
    const pageId = Object.keys(runtime.pageRefinementReasons ?? {})[0];
    const page = runtime.confirmedOutline.items.find((item) => item.page_id === pageId);
    return locale === "zh" ? `优化“${page?.title || "当前页"}”页面` : `Refine “${page?.title || "current page"}”`; // output-language: R 类跟随 OutputLanguage（方案 §4.4）
  }
  if (runtime.refinementRunKind === "deck-refinement") return locale === "zh" ? "整套优化" : "Deck refinement"; // output-language: R 类跟随 OutputLanguage（方案 §4.4）
  return locale === "zh" ? "首次生成" : "Initial generation"; // output-language: R 类跟随 OutputLanguage（方案 §4.4）
}

function buildWebBatch(locale: ResearchTextLocale, title: string, status: "completed" | "skipped" | "warning", body: string) {
  const statusLabel = locale === "zh" // output-language: R 类跟随 OutputLanguage（方案 §4.4）
    ? ({ completed: "已完成", skipped: "已跳过", warning: "有缺口" } as const)[status]
    : status;
  return [
    locale === "zh" ? `## 研究批次：${title}` : `## Research batch: ${title}`, // output-language: R 类跟随 OutputLanguage（方案 §4.4）
    "",
    locale === "zh" ? `状态：${statusLabel}` : `Status: ${statusLabel}`, // output-language: R 类跟随 OutputLanguage（方案 §4.4）
    "",
    body.trim(),
  ].filter(Boolean).join("\n");
}

function webResearchAgentFailure(
  locale: DeckGenerationRuntime["locale"],
  kind: "protocol_limit" | "round_limit" | "missing_markdown",
  maxRounds = WEB_RESEARCH_AGENT_MAX_CONSECUTIVE_PROTOCOL_ERRORS,
) {
  const messages = locale === "zh" // output-language: R 类跟随 OutputLanguage（方案 §4.4）
    ? {
        protocol_limit: "Web 研究 Agent 连续 3 次返回了无效协议，研究已中断。",
        round_limit: `Web 研究 Agent 在 ${maxRounds} 轮内未返回合法 finish，且在轮次用尽后连续 ${WEB_RESEARCH_AGENT_MAX_CONSECUTIVE_PROTOCOL_ERRORS} 次仍未按协议输出总结，研究已中断。`,
        missing_markdown: "Web 研究 Agent 未返回可发布的 Markdown 总结。",
      }
    : {
        protocol_limit: "The Web research Agent returned invalid protocol output 3 consecutive times, so research was stopped.",
        round_limit: `The Web research Agent did not return a valid finish action within ${maxRounds} rounds and then failed to summarize ${WEB_RESEARCH_AGENT_MAX_CONSECUTIVE_PROTOCOL_ERRORS} consecutive times, so research was stopped.`,
        missing_markdown: "The Web research Agent did not return a publishable Markdown summary.",
      };
  return messages[kind];
}

function webResearchRoundLimitGap(locale: DeckGenerationRuntime["locale"], maxRounds: number) {
  return locale === "zh" // output-language: R 类跟随 OutputLanguage（方案 §4.4）
    ? `Web 研究已达到 ${maxRounds} 轮上限，最终总结仅基于已收集到的资料。`
    : `Web research reached its limit of ${maxRounds} rounds; the summary only covers the material collected so far.`;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function runWorker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return results;
}

interface ImportedResearchImageAsset {
  candidate_id: string;
  file_path: string;
  sha256: string;
  mime_type: string;
  bytes_size: number;
  width: number | null;
  height: number | null;
}

function researchWebCallContext(runtime: DeckGenerationRuntime, operationId: string): ResearchWebCallContext {
  return {
    workspace_dir: runtime.workspace.workspace_dir,
    operation_id: operationId,
  };
}

async function getApsResearchImageUrl(
  runtime: DeckGenerationRuntime,
  candidate: SharedResearchImageCandidate,
) {
  if (!candidate.aps_path) throw new Error(`Image candidate ${candidate.candidate_id} has no APS path`);
  return getResearchImageDownloadUrl(runtime.researchWebClient, candidate.aps_path);
}

async function fetchResearchImageCandidate(
  runtime: DeckGenerationRuntime,
  candidate: SharedResearchImageCandidate,
  operationId: string,
): Promise<AgentImageAttachment> {
  try {
    const alreadyFetched = candidate.aps_fetch_status === "completed" && Boolean(candidate.aps_path);
    candidate.aps_fetch_status = "running";
    let fetched: {
      path: string;
      mime_type: string;
      bytes_size: number;
      sha256: string;
      source_url: string;
      final_url: string;
      quota_consumed?: number;
    };
    if (alreadyFetched && candidate.aps_path) {
      fetched = {
        path: candidate.aps_path,
        mime_type: candidate.mime_type ?? "image/jpeg",
        bytes_size: candidate.bytes_size ?? 0,
        sha256: candidate.sha256 ?? "",
        source_url: candidate.source_url,
        final_url: candidate.final_url ?? candidate.source_url,
      };
    } else {
      fetched = await measureResearchOperation(
        runtime,
        "research.image.fetch",
        () => runtime.researchWebClient.imageFetch(
          {
            url: candidate.image_url,
            max_bytes: 20 * 1024 * 1024,
            purpose: "ppt-sdk-web-search-demo",
          },
          researchWebCallContext(runtime, operationId),
        ),
        { candidate_id: candidate.candidate_id },
        "anna-web",
      );
    }
    if (!fetched.path || !fetched.mime_type || !fetched.sha256 || !Number.isFinite(fetched.bytes_size) || fetched.bytes_size <= 0) {
      throw new Error(`Anna image_fetch returned an incomplete artifact for ${candidate.candidate_id}`);
    }
    Object.assign(candidate, {
      aps_path: fetched.path,
      aps_fetch_status: "completed" as const,
      sha256: fetched.sha256,
      mime_type: fetched.mime_type,
      bytes_size: fetched.bytes_size,
      final_url: fetched.final_url || candidate.source_url,
      ...(fetched.quota_consumed !== undefined ? { aps_quota_consumed: fetched.quota_consumed } : {}),
    });
    delete candidate.aps_fetch_error;
  } catch (error) {
    candidate.aps_fetch_status = "failed";
    candidate.aps_fetch_error = researchImageErrorMessage(error);
    throw error;
  }

  try {
    // Both newly fetched and resumed candidates resolve their stable APS path.
    const url = await getApsResearchImageUrl(runtime, candidate);
    const mimeType = candidate.mime_type!;
    delete candidate.error;
    rememberResearchImagePreview(runtime, candidate.candidate_id, url);
    return {
      type: mimeType,
      url,
      filename: `${candidate.candidate_id}${mimeType === "image/png" ? ".png" : mimeType === "image/webp" ? ".webp" : mimeType === "image/gif" ? ".gif" : ".jpg"}`,
      detail: "auto",
    };
  } catch (error) {
    candidate.analysis_status = "failed";
    candidate.import_status = "skipped";
    candidate.use_in_ppt = false;
    candidate.error = `APS image URL preparation failed: ${errorMessage(error)}`;
    throw new Error(candidate.error);
  }
}

async function materializeSelectedResearchImageCandidate(
  runtime: DeckGenerationRuntime,
  candidate: SharedResearchImageCandidate,
  operationId: string,
  apsUrl?: string,
) {
  if (candidate.aps_fetch_status !== "completed") {
    throw new Error(`Image candidate ${candidate.candidate_id} has no completed APS image_fetch`);
  }
  const sourceUrl = apsUrl ?? await getApsResearchImageUrl(runtime, candidate);
  try {
    const downloaded = await measureResearchOperation(
      runtime,
      "research.image.download_selected",
      () => runtime.backend.prepareSharedResearchImageCandidate({
        workspace_dir: runtime.workspace.workspace_dir,
        operation_id: operationId,
        candidate_id: candidate.candidate_id,
        source_url: sourceUrl,
        ...(candidate.local_file_path && candidate.sha256 ? {
          existing_file_path: candidate.local_file_path,
          expected_sha256: candidate.sha256,
        } : {}),
      }),
      { candidate_id: candidate.candidate_id },
      "research-image-transfer",
    );
    Object.assign(candidate, {
      local_download_status: "completed" as const,
      local_file_path: downloaded.local_file_path,
      sha256: downloaded.sha256,
      mime_type: downloaded.mime_type,
      bytes_size: downloaded.bytes_size,
      width: downloaded.width,
      height: downloaded.height,
      final_url: downloaded.final_url,
    });
    delete candidate.local_download_error;
  } catch (error) {
    candidate.local_download_status = "failed";
    candidate.local_download_error = errorMessage(error);
    throw error;
  }
}

async function importSelectedImage(
  runtime: DeckGenerationRuntime,
  candidate: SharedResearchImageCandidate,
  operationId: string,
  apsUrl?: string,
) {
  await materializeSelectedResearchImageCandidate(runtime, candidate, operationId, apsUrl);
  if (!candidate.local_file_path || !candidate.sha256 || !candidate.mime_type || !candidate.bytes_size) {
    throw new Error(`Image candidate ${candidate.candidate_id} has no validated local file`);
  }
  const imported: ImportedResearchImageAsset = await measureResearchOperation(
    runtime,
    "research.image.import",
    () => runtime.backend.importSharedResearchImageLocal({
      workspace_dir: runtime.workspace.workspace_dir,
      candidate_id: candidate.candidate_id,
      local_file_path: candidate.local_file_path as string,
      mime_type: candidate.mime_type as string,
      size_bytes: candidate.bytes_size as number,
      sha256: candidate.sha256 as string,
    }),
    { candidate_id: candidate.candidate_id, size_bytes: candidate.bytes_size },
    "research-image-transfer",
  );
  Object.assign(candidate, {
    file_path: imported.file_path,
    import_status: "imported" as const,
    sha256: imported.sha256,
    mime_type: imported.mime_type,
    bytes_size: imported.bytes_size,
    width: imported.width,
    height: imported.height,
  });
}

function createImageCandidateFromOccurrence(occurrence: ImageSearchOccurrence): SharedResearchImageCandidate {
  const dedupKey = normalizeImageUrlForDedup(occurrence.image_url);
  return {
    candidate_id: createImageCandidateId(dedupKey),
    query: occurrence.query,
    dedup_key: `urlhash:${stableShortHash(dedupKey)}`,
    representative_occurrence_id: occurrence.occurrence_id,
    matched_occurrence_ids: [occurrence.occurrence_id],
    matched_queries: [occurrence.query],
    image_url: occurrence.image_url,
    thumbnail_url: occurrence.thumbnail_url,
    source_url: occurrence.source_url,
    title: occurrence.title,
    width: occurrence.width,
    height: occurrence.height,
    ...(occurrence.mime_type ? { mime_type: occurrence.mime_type } : {}),
    use_in_ppt: false,
    description: "Not returned by image analysis.",
    reason: "Not returned by image analysis; defaulted to use_in_ppt: false.",
    aps_fetch_status: "pending",
    local_download_status: "pending",
    upload_status: "pending",
    analysis_status: "pending",
    import_status: "pending",
  };
}

function ensureImageDeduplication(checkpoint: LinearResearchCheckpoint) {
  checkpoint.image ??= {};
  checkpoint.image.deduplication ??= {
    status: "running",
    strategy: {
      version: 1,
      key: "normalized_image_url",
      remove_fragment: true,
      remove_default_port: true,
      sort_query_parameters: true,
      removed_tracking_parameters: [...IMAGE_DEDUP_TRACKING_PARAMETERS],
    },
    statistics: { raw_occurrences: 0, unique_urls: 0, duplicate_occurrences: 0, duplicate_groups: 0 },
    groups: [],
  };
  return checkpoint.image.deduplication;
}

function mergeImageCandidateOccurrence(
  candidate: SharedResearchImageCandidate,
  occurrence: ImageSearchOccurrence,
) {
  candidate.matched_occurrence_ids = [...new Set([...(candidate.matched_occurrence_ids ?? []), occurrence.occurrence_id])];
  candidate.matched_queries = [...new Set([...(candidate.matched_queries ?? [candidate.query]), occurrence.query])];
}

function filterImageAgentDecisions(
  action: ImageResearchAgentAction,
  candidates: SharedResearchImageCandidate[],
) {
  const expected = new Map(candidates.map((candidate, index) => [candidate.candidate_id, index + 1]));
  const acceptedIds = new Set<string>();
  const ignored: Array<{ candidate_id: string; attachment_index: number; reason: string }> = [];
  const decisions = action.decisions.filter((decision) => {
    const expectedIndex = expected.get(decision.candidate_id);
    const reason = expectedIndex === undefined
      ? "unknown_candidate"
      : expectedIndex !== decision.attachment_index
        ? "wrong_attachment_index"
        : acceptedIds.has(decision.candidate_id)
          ? "duplicate_candidate"
          : undefined;
    if (reason) {
      ignored.push({ candidate_id: decision.candidate_id, attachment_index: decision.attachment_index, reason });
      return false;
    }
    acceptedIds.add(decision.candidate_id);
    return true;
  });
  return { decisions, ignored };
}

/** Shared image execution loop. Page searches own their prompt and persistence. */
export interface ImageResearchPolicy {
  systemPrompt: string;
  initialPrompt: (checkpoint: LinearResearchCheckpoint) => string;
  resultPrompt: typeof buildImageResearchAgentResultPrompt;
  parseAction: (text: string) => ImageResearchAgentAction;
  initialAttachments?: AgentImageAttachment[];
  initialAttachmentBytes?: number;
  requireSearch?: boolean;
  onAction?: (action: ImageResearchAgentAction) => void;
  onExistingAttachments?: () => void;
  onFreshSession?: () => void;
}

export async function runImageResearchSession(input: {
  policy?: ImageResearchPolicy;
  runtime: DeckGenerationRuntime;
  checkpoint: LinearResearchCheckpoint;
  context: SharedResearchContextResult;
  researchWebOperationId: string;
  resume: boolean;
  persist: (snapshot?: LinearResearchCheckpoint) => Promise<void>;
  persistAndPublish: (message: string) => Promise<void>;
}) {
  const { runtime, checkpoint, context, researchWebOperationId, persist, persistAndPublish } = input;
  const maxSearches = getImageResearchMaxSearches(runtime);

  checkpoint.image ??= {};
  const image = checkpoint.image;
  const decision: ImageResearchDecisionCheckpoint = image.decision ?? {
    needs_search: true,
    queries: [],
    rationale: encodeDiagnostic("IMG_SESSION_DECIDES_SCOPE"),
    mode: "agent-session-v2",
    session_attempt: 0,
    rounds: [],
  };
  decision.mode = "agent-session-v2";
  decision.session_attempt = (decision.session_attempt ?? 0) + 1;
  decision.rounds ??= [];
  image.decision = decision;

  const logContext = researchLogContext(runtime, "image_research_agent", "image");
  const attachmentByCandidateId = new Map<string, AgentImageAttachment>();
  const candidates = image.candidates ?? (image.candidates = []);
  const gaps = [...(image.gaps ?? [])];
  let pendingCandidates: SharedResearchImageCandidate[] = [];
  let agentAttachmentBytes = input.policy?.initialAttachmentBytes ?? 0;
  let attachmentBudgetExhausted = false;
  const attachmentBudgetMb = IMAGE_AGENT_ATTACHMENT_BYTES_BUDGET / (1024 * 1024);
  const attachmentBudgetGap = encodeDiagnostic("IMG_ATTACHMENT_BUDGET_REACHED_SKIPPED", { budgetMb: attachmentBudgetMb });
  const attachmentBudgetSummary = encodeDiagnostic("IMG_ATTACHMENT_BUDGET_REACHED_PRESERVED", { budgetMb: attachmentBudgetMb });

  const recordAttachmentSelection = (selection: ImageAttachmentSelection) => {
    for (const candidate of selection.skippedForSize) {
      markImageCandidateSkipped(
        candidate,
        encodeDiagnostic("IMG_SKIPPED_SINGLE_SIZE_LIMIT"),
        encodeDiagnostic("IMG_SKIPPED_SINGLE_SIZE_LIMIT"),
      );
    }
    for (const candidate of selection.skippedForBudget) {
      markImageCandidateSkipped(
        candidate,
        encodeDiagnostic("IMG_SKIPPED_BUDGET_REACHED", { budgetMb: attachmentBudgetMb }),
        encodeDiagnostic("IMG_SKIPPED_BUDGET_REACHED", { budgetMb: attachmentBudgetMb }),
      );
    }
    for (const candidate of selection.skippedForBatchSize) {
      candidate.analysis_status = "skipped";
      candidate.import_status = "skipped";
      candidate.reason = "Not sent to the current image research run because only the first six successful APS image fetches are analyzed.";
    }
    if (selection.skippedForSize.length > 0) {
      gaps.push(encodeDiagnostic("IMG_SOME_EXCEEDED_SIZE_LIMIT"));
    }
    if (selection.skippedForBudget.length > 0) {
      gaps.push(attachmentBudgetGap);
    }
    agentAttachmentBytes += selection.totalBytes;
  };

  if (input.resume) {
    const interruptedSearches = (image.searches ?? []).filter((search) => search.status === "running");
    if (interruptedSearches.length > 0) {
      const message = encodeDiagnostic("IMG_SEARCH_INTERRUPTED_RESUMED");
      for (const search of interruptedSearches) {
        search.status = "warning";
        search.error = message;
      }
      image.search_status = "running";
      if (checkpoint.stages.image_search === "waiting") checkpoint.stages.image_search = "running";
      image.diagnostic_errors = appendUnique(image.diagnostic_errors, message);
      gaps.push(message);
      await persistAndPublish(stageMessage(runtime, "image_search"));
    }
  }

  // APS presigned URLs are deliberately not persisted. Rebuild the attachment
  // map when a process resumes with a pending analysis batch.
  const pendingBatch = image.analysis_batches?.find((batch) => (
    batch.status !== "completed"
    && batch.status !== "failed"
    && batch.candidate_ids.some((candidateId) => candidates.some((candidate) => candidate.candidate_id === candidateId))
  ));
  const recoveryIds = pendingBatch?.candidate_ids ?? candidates
    .filter((candidate) => candidate.analysis_status !== "completed" && candidate.analysis_status !== "skipped" && !candidate.content_duplicate_of)
    .map((candidate) => candidate.candidate_id);
  const recoveryCandidates = recoveryIds
    .map((candidateId) => candidates.find((candidate) => candidate.candidate_id === candidateId))
    .filter((candidate): candidate is SharedResearchImageCandidate => Boolean(candidate))
    .filter((candidate) => candidate.analysis_status !== "completed" && candidate.analysis_status !== "skipped" && !candidate.content_duplicate_of);
  if (recoveryCandidates.length > 0) {
    if (checkpoint.stages.image_deduplication === "waiting") checkpoint.stages.image_deduplication = "running";
    if (checkpoint.stages.image_prefetch === "waiting") checkpoint.stages.image_prefetch = "running";
    if (checkpoint.stages.image_analysis === "waiting") checkpoint.stages.image_analysis = "running";
    if (checkpoint.stages.image_import === "waiting") checkpoint.stages.image_import = "running";
    if (checkpoint.stages.image_prefetch === "running") image.prepare_status = "running";
    if (checkpoint.stages.image_analysis === "running") image.analysis_status = "running";
    if (checkpoint.stages.image_import === "running") image.import_status = "running";
    await persistAndPublish(stageMessage(runtime, "image_prefetch"));
    await mapWithConcurrency(recoveryCandidates, IMAGE_CANDIDATE_IO_CONCURRENCY, async (candidate) => {
      candidate.analysis_status = "pending";
      try {
        attachmentByCandidateId.set(
          candidate.candidate_id,
          await fetchResearchImageCandidate(runtime, candidate, researchWebOperationId),
        );
        if (candidate.import_status === "failed") candidate.import_status = "pending";
      } catch (error) {
        candidate.analysis_status = "failed";
        gaps.push(encodeDiagnostic("IMG_RECOVERY_REATTACH_FAILED"));
        await logResearchError(runtime, "image-recovery", error, { candidate_id: candidate.candidate_id });
      }
    });
    const recoverySelection = selectImageAgentAttachments(
      recoveryCandidates.filter((candidate) => attachmentByCandidateId.has(candidate.candidate_id)),
      agentAttachmentBytes,
    );
    recordAttachmentSelection(recoverySelection);
    pendingCandidates = recoverySelection.selected;
    if (pendingCandidates.length === 0 && (recoverySelection.skippedForBudget.length > 0 || agentAttachmentBytes >= IMAGE_AGENT_ATTACHMENT_BYTES_BUDGET)) {
      attachmentBudgetExhausted = true;
    }
    if (pendingBatch) {
      pendingBatch.candidate_ids = pendingCandidates.map((candidate) => candidate.candidate_id);
      if (pendingCandidates.length === 0) {
        pendingBatch.status = "failed";
        pendingBatch.error = "No uploaded image candidates remain for resumed analysis";
        pendingBatch.completed_at = new Date().toISOString();
      } else {
        pendingBatch.status = "pending";
      }
    } else if (pendingCandidates.length > 0) {
      image.analysis_batches ??= [];
      image.analysis_batches.push({
        batch_id: `image-analysis-recovery-${decision.session_attempt ?? 1}`,
        candidate_ids: pendingCandidates.map((candidate) => candidate.candidate_id),
        status: "pending",
        attempt: 1,
        interaction_ids: logContext?.interaction_ids ?? [],
        started_at: new Date().toISOString(),
      });
    }
  }
  for (const candidate of candidates.filter((item) => item.use_in_ppt && item.analysis_status === "completed" && item.import_status !== "imported")) {
    throwIfCancelled(runtime);
    await importSelectedImage(runtime, candidate, researchWebOperationId);
    await persist();
  }
  const buildInitialImagePrompt = () => input.policy?.initialPrompt(checkpoint) ?? buildImageResearchAgentInitialPrompt({
    refinementRequest: runtime.refinementRequest,
    requirements: runtime.workspace.requirements,
    brief: runtime.workspace.requirements.source?.brief,
    imageCatalog: context.image_catalog,
    selectedHistory: image.candidates ?? [],
    searches: (image.searches ?? []).map((search) => ({
      query: search.query,
      resultCount: search.result?.length ?? 0,
      ...(search.error ? { error: search.error } : {}),
    })),
  });
  let prompt = buildInitialImagePrompt();
  if (pendingCandidates.length > 0) {
    const lastSearch = image.searches?.at(-1);
    prompt += "\n\n" + (input.policy?.resultPrompt ?? buildImageResearchAgentResultPrompt)({
      query: lastSearch?.query ?? pendingCandidates[0]?.query ?? "image research",
      candidates: pendingCandidates,
      selectedHistory: candidates,
      ...(lastSearch?.error ? { searchError: lastSearch.error } : {}),
    });
    image.analysis_status = "running";
    checkpoint.stages.image_analysis = "running";
  }
  const buildFreshImagePrompt = () => {
    if (pendingCandidates.length > 0) {
      const lastSearch = image.searches?.at(-1);
      return buildInitialImagePrompt() + "\n\n" + (input.policy?.resultPrompt ?? buildImageResearchAgentResultPrompt)({
        query: lastSearch?.query ?? pendingCandidates[0]?.query ?? "image research",
        candidates: pendingCandidates,
        selectedHistory: candidates,
        ...(lastSearch?.error ? { searchError: lastSearch.error } : {}),
      });
    }
    return buildInitialImagePrompt();
  };
  const session: AgentImageResearchSession = await runtime.agentClient.createImageResearchSession(
    input.policy?.systemPrompt ?? IMAGE_RESEARCH_AGENT_SYSTEM_PROMPT,
    {
      freshPrompt: buildFreshImagePrompt,
      freshRunOptions: () => {
        if (!pendingCandidates.length) input.policy?.onExistingAttachments?.();
        return {
          modelPreference: IMAGE_RESEARCH_AGENT_MODEL,
          logContext,
          signal: runtime.cancelSignal,
          isCancelled: runtime.isCancelled,
          sessionTools: [],
          toolAccessPolicy: "off",
          ...(pendingCandidates.length > 0
            ? {
                attachments: pendingCandidates
                  .map((candidate) => attachmentByCandidateId.get(candidate.candidate_id))
                  .filter((attachment): attachment is AgentImageAttachment => Boolean(attachment)),
              }
            : input.policy?.initialAttachments?.length ? { attachments: input.policy.initialAttachments } : {}),
        };
      },
      onFreshSession: () => {
        input.policy?.onFreshSession?.();
        decision.session_attempt = (decision.session_attempt ?? 0) + 1;
      },
    },
  );
  let searchCount = image.searches?.length ?? 0;
  let consecutiveProtocolErrors = 0;
  let finished = false;
  let finalSummary = attachmentBudgetExhausted ? attachmentBudgetSummary : "";

  try {
    for (let turn = 1; turn <= maxSearches + 1 && !attachmentBudgetExhausted; turn += 1) {
      throwIfCancelled(runtime);
      let action: ImageResearchAgentAction | null = null;
      let protocolRepair = false;
      while (!action) {
        const attachments = !protocolRepair && pendingCandidates.length > 0
          ? pendingCandidates
            .map((candidate) => attachmentByCandidateId.get(candidate.candidate_id))
            .filter((attachment): attachment is AgentImageAttachment => Boolean(attachment))
          : !protocolRepair && turn === 1 ? input.policy?.initialAttachments : undefined;
        if (!protocolRepair && !pendingCandidates.length && turn === 1) input.policy?.onExistingAttachments?.();
        const rawText = await measureResearchOperation(
          runtime,
          "research.image.agent_round",
          () => runResearchSession(runtime, "image", session, prompt, {
            modelPreference: IMAGE_RESEARCH_AGENT_MODEL,
            logContext,
            signal: runtime.cancelSignal,
            isCancelled: runtime.isCancelled,
            ...(attachments?.length ? { attachments } : {}),
          }),
          { round: turn, search_count: searchCount, session_attempt: decision.session_attempt ?? 1 },
          "anna-agent",
        );
        try {
          const parsed = (input.policy?.parseAction ?? parseImageResearchAgentAction)(rawText);
          if (input.policy?.requireSearch && searchCount === 0 && parsed.action === "finish") {
            throw new Error("用户主动请求补图，必须先执行至少一次新的图片搜索。");
          }
          input.policy?.onAction?.(parsed);
          action = parsed;
          consecutiveProtocolErrors = 0;
        } catch (error) {
          consecutiveProtocolErrors += 1;
          decision.rounds.push({
            session_attempt: decision.session_attempt ?? 1,
            round: turn,
            status: "protocol_error",
            error: errorMessage(error),
          });
          await persistAndPublish(stageMessage(runtime, "image_analysis"));
          if (consecutiveProtocolErrors >= IMAGE_RESEARCH_AGENT_MAX_CONSECUTIVE_PROTOCOL_ERRORS) {
            if (typeof session.restartFreshSession !== "function") {
              throw new Error(encodeDiagnostic("IMG_AGENT_PROTOCOL_ERRORS"));
            }
            await session.restartFreshSession();
            consecutiveProtocolErrors = 0;
            protocolRepair = false;
            prompt = buildFreshImagePrompt();
            continue;
          }
          protocolRepair = true;
          prompt = buildImageResearchAgentProtocolRepairPrompt(error);
        }
      }

      const selection = filterImageAgentDecisions(action, pendingCandidates);
      action.decisions = selection.decisions;
      if (selection.ignored.length > 0) {
        const diagnostic = `Ignored invalid image candidate selections: ${JSON.stringify(selection.ignored)}`;
        image.diagnostic_errors = appendUnique(image.diagnostic_errors, diagnostic);
        await logResearchError(runtime, "image-selection", new Error(diagnostic), { round: turn, ignored: selection.ignored });
      }
      const roundRecord: ImageAgentLoopRound = {
        session_attempt: decision.session_attempt ?? 1,
        round: turn,
        status: "action",
        action: action.action,
        ...(action.action === "search" ? { query: action.query } : {}),
        candidate_ids: pendingCandidates.map((candidate) => candidate.candidate_id),
      };
      decision.rounds.push(roundRecord);
      finalSummary = action.summary;
      for (const candidate of pendingCandidates) {
        Object.assign(candidate, {
          use_in_ppt: false,
          description: "Not selected by the image research Agent.",
          reason: "The candidate was omitted from this round's selected-image decisions.",
          analysis_status: "completed" as const,
          import_status: "skipped" as const,
        });
      }
      for (const item of action.decisions) {
        const candidate = candidates.find((value) => value.candidate_id === item.candidate_id);
        if (!candidate) continue;
        Object.assign(candidate, {
          use_in_ppt: item.use_in_ppt,
          description: item.description,
          reason: item.reason,
          analysis_status: "completed" as const,
          import_status: item.use_in_ppt ? "pending" as const : "skipped" as const,
        });
      }
      const activeBatch = image.analysis_batches?.find((batch) => (
        batch.candidate_ids.length === pendingCandidates.length
        && batch.candidate_ids.every((candidateId) => pendingCandidates.some((candidate) => candidate.candidate_id === candidateId))
        && batch.status === "pending"
      ));
      if (activeBatch) {
        activeBatch.status = "completed";
        activeBatch.completed_at = new Date().toISOString();
      }
      await mapWithConcurrency(pendingCandidates.filter((candidate) => candidate.use_in_ppt), IMAGE_CANDIDATE_IO_CONCURRENCY, async (candidate) => {
        try {
          await importSelectedImage(
            runtime,
            candidate,
            researchWebOperationId,
            attachmentByCandidateId.get(candidate.candidate_id)?.url,
          );
        } catch (error) {
          candidate.import_status = "failed";
          gaps.push(encodeDiagnostic("IMG_IMPORT_SAVE_FAILED"));
          await logResearchError(runtime, "image-import", error, { candidate_id: candidate.candidate_id });
        }
      });
      await persistAndPublish(stageMessage(runtime, "image_analysis"));

      if (action.action === "finish") {
        finished = true;
        break;
      }
      if (agentAttachmentBytes >= IMAGE_AGENT_ATTACHMENT_BYTES_BUDGET) {
        gaps.push(attachmentBudgetGap);
        attachmentBudgetExhausted = true;
        finalSummary = attachmentBudgetSummary;
        roundRecord.result_status = "warning";
        break;
      }
      if (searchCount >= maxSearches) {
        gaps.push(encodeDiagnostic("IMG_SEARCH_LIMIT_REACHED", { limit: maxSearches }));
        for (const candidate of pendingCandidates) {
          if (candidate.analysis_status === "pending") {
            candidate.analysis_status = "skipped";
            candidate.import_status = "skipped";
            candidate.reason = "Not analyzed because the image research search limit was reached.";
          }
        }
        roundRecord.result_status = "warning";
        break;
      }
      throwIfCancelled(runtime);
      const normalizedQuery = action.query.trim().toLocaleLowerCase();
      if ((image.searches ?? []).some((search) => search.query.trim().toLocaleLowerCase() === normalizedQuery)) {
        gaps.push(encodeDiagnostic("IMG_DUPLICATE_QUERY", { query: action.query }));
        roundRecord.result_status = "warning";
        break;
      }
      searchCount += 1;
      decision.queries.push(action.query);
      if (checkpoint.stages.image_search === "waiting") checkpoint.stages.image_search = "running";
      image.search_status = "running";
      const searchRecord: QueryCheckpoint<ImageSearchOccurrence[]> = { query: action.query, status: "running" };
      image.searches ??= [];
      image.searches.push(searchRecord);
      await persistAndPublish(stageMessage(runtime, "image_search"));

      let batchCandidates: SharedResearchImageCandidate[] = [];
      try {
        const response = await measureResearchOperation(
          runtime,
          "research.image.search",
          () => runtime.researchWebClient.imageSearch(
            { query: action.query, max_results: 10, min_width: 800, min_height: 600, aspect: "any" },
            researchWebCallContext(runtime, researchWebOperationId),
          ),
          { query: action.query, max_results: 10 },
        );
        const queryIndex = image.searches.length;
        const occurrences: ImageSearchOccurrence[] = response.results.slice(0, 10).map((item, resultIndex) => ({
          occurrence_id: `image-q${queryIndex}-r${resultIndex + 1}`,
          query: action.query,
          query_index: queryIndex - 1,
          result_index: resultIndex,
          ...item,
        }));
        searchRecord.result = occurrences;
        searchRecord.status = occurrences.length > 0 ? "completed" : "warning";
        const deduplication = ensureImageDeduplication(checkpoint);
        for (const occurrence of occurrences) {
          const normalizedUrl = normalizeImageUrlForDedup(occurrence.image_url);
          let candidate = candidates.find((value) => normalizeImageUrlForDedup(value.image_url) === normalizedUrl);
          let group = deduplication.groups.find((value) => value.dedup_key === `urlhash:${stableShortHash(normalizedUrl)}`);
          if (!candidate) {
            candidate = createImageCandidateFromOccurrence(occurrence);
            candidates.push(candidate);
          } else {
            mergeImageCandidateOccurrence(candidate, occurrence);
          }
          if (!group) {
            group = {
              dedup_key: candidate.dedup_key ?? `urlhash:${stableShortHash(normalizedUrl)}`,
              candidate_id: candidate.candidate_id,
              representative_occurrence_id: candidate.representative_occurrence_id ?? occurrence.occurrence_id,
              occurrence_ids: [],
              matched_query_indexes: [],
            };
            deduplication.groups.push(group);
          }
          if (!group.occurrence_ids.includes(occurrence.occurrence_id)) group.occurrence_ids.push(occurrence.occurrence_id);
          if (!group.matched_query_indexes.includes(occurrence.query_index)) group.matched_query_indexes.push(occurrence.query_index);
          if (!batchCandidates.some((value) => value.candidate_id === candidate?.candidate_id)) batchCandidates.push(candidate);
        }
        deduplication.status = "completed";
        const rawOccurrences = (image.searches ?? []).reduce((sum, search) => sum + (search.result?.length ?? 0), 0);
        deduplication.statistics = {
          raw_occurrences: rawOccurrences,
          unique_urls: deduplication.groups.length,
          duplicate_occurrences: rawOccurrences - deduplication.groups.length,
          duplicate_groups: deduplication.groups.filter((group) => group.occurrence_ids.length > 1).length,
        };
      } catch (error) {
        searchRecord.status = "warning";
        searchRecord.error = errorMessage(error);
        gaps.push(encodeDiagnostic("IMG_QUERY_NO_CANDIDATES", { query: action.query }));
        await logResearchError(runtime, "image-search", error, { query: action.query });
      }
      if (checkpoint.stages.image_deduplication === "waiting") checkpoint.stages.image_deduplication = "running";
      if (checkpoint.stages.image_prefetch === "waiting") checkpoint.stages.image_prefetch = "running";
      image.prepare_status = "running";
      image.gaps = [...new Set(gaps)];
      image.diagnostic_errors ??= [];
      await persistAndPublish(stageMessage(runtime, "image_prefetch"));

      const newCandidates = batchCandidates.filter((candidate) => candidate.analysis_status === "pending");
      await mapWithConcurrency(newCandidates, IMAGE_CANDIDATE_IO_CONCURRENCY, async (candidate) => {
        try {
          attachmentByCandidateId.set(
            candidate.candidate_id,
            await fetchResearchImageCandidate(runtime, candidate, researchWebOperationId),
          );
        } catch (error) {
          const urlPreparationFailed = candidate.aps_fetch_status === "completed";
          gaps.push(encodeDiagnostic(urlPreparationFailed ? "IMG_ATTACHMENT_URL_FAILED" : "IMG_APS_FETCH_FAILED"));
          if (urlPreparationFailed) {
            await logResearchError(runtime, "image-attachment-url", error, { candidate_id: candidate.candidate_id });
          } else {
            await logResearchImageError(runtime, "image-fetch", error, { candidate_id: candidate.candidate_id });
          }
        }
      });
      const shaRepresentatives = new Map<string, SharedResearchImageCandidate>();
      for (const candidate of candidates) {
        if (candidate.aps_fetch_status !== "completed" || candidate.analysis_status === "failed" || !candidate.sha256 || candidate.content_duplicate_of) continue;
        shaRepresentatives.set(candidate.sha256, candidate);
      }
      for (const candidate of newCandidates) {
        if (candidate.aps_fetch_status !== "completed" || candidate.analysis_status === "failed" || !candidate.sha256) continue;
        const representative = shaRepresentatives.get(candidate.sha256);
        if (representative && representative.candidate_id !== candidate.candidate_id) {
          representative.matched_queries = [...new Set([...(representative.matched_queries ?? [representative.query]), ...(candidate.matched_queries ?? [candidate.query])])];
          representative.matched_occurrence_ids = [...new Set([...(representative.matched_occurrence_ids ?? []), ...(candidate.matched_occurrence_ids ?? [])])];
          candidate.content_duplicate_of = representative.candidate_id;
          candidate.upload_status = "skipped";
          candidate.analysis_status = "skipped";
          candidate.import_status = "skipped";
          candidate.use_in_ppt = false;
          candidate.description = `Content duplicate of ${representative.candidate_id}.`;
          candidate.reason = "Skipped because another candidate has identical SHA-256 content.";
        } else {
          shaRepresentatives.set(candidate.sha256, candidate);
        }
      }
      const successfulCandidates = newCandidates.filter((candidate) => (
        candidate.aps_fetch_status === "completed"
        && !candidate.content_duplicate_of
        && attachmentByCandidateId.has(candidate.candidate_id)
      ));
      const attachmentSelection = selectImageAgentAttachments(successfulCandidates, agentAttachmentBytes);
      recordAttachmentSelection(attachmentSelection);
      pendingCandidates = attachmentSelection.selected;
      if (pendingCandidates.length === 0 && (attachmentSelection.skippedForBudget.length > 0 || agentAttachmentBytes >= IMAGE_AGENT_ATTACHMENT_BYTES_BUDGET)) {
        attachmentBudgetExhausted = true;
        finalSummary = attachmentBudgetSummary;
      }
      image.analysis_batches ??= [];
      const analysisBatch: ImageAnalysisBatchCheckpoint = {
        batch_id: `image-analysis-round-${searchCount}`,
        candidate_ids: pendingCandidates.map((candidate) => candidate.candidate_id),
        status: attachmentBudgetExhausted ? "failed" : "pending",
        attempt: 1,
        interaction_ids: logContext?.interaction_ids ?? [],
        started_at: new Date().toISOString(),
        ...(attachmentBudgetExhausted ? {
          completed_at: new Date().toISOString(),
          error: finalSummary,
        } : {}),
      };
      image.analysis_batches.push(analysisBatch);
      image.analysis_status = "running";
      image.import_status = "running";
      if (checkpoint.stages.image_analysis === "waiting") checkpoint.stages.image_analysis = "running";
      if (checkpoint.stages.image_import === "waiting") checkpoint.stages.image_import = "running";
      const contentGroups = new Map<string, { sha256: string; representative_candidate_id: string; candidate_ids: string[] }>();
      for (const candidate of candidates) {
        if (!candidate.sha256 || candidate.content_duplicate_of) continue;
        const group = contentGroups.get(candidate.sha256);
        if (group) group.candidate_ids.push(candidate.candidate_id);
        else contentGroups.set(candidate.sha256, { sha256: candidate.sha256, representative_candidate_id: candidate.candidate_id, candidate_ids: [candidate.candidate_id] });
      }
      image.content_deduplication = {
        status: "completed",
        strategy: { version: 2, key: "sha256", source: "anna.web.image_fetch" },
        statistics: {
          fetched_candidates: candidates.filter((candidate) => candidate.aps_fetch_status === "completed").length,
          unique_content: contentGroups.size,
          duplicate_content_candidates: candidates.filter((candidate) => candidate.content_duplicate_of).length,
        },
        groups: [...contentGroups.values()],
        completed_at: new Date().toISOString(),
      };
      prompt = (input.policy?.resultPrompt ?? buildImageResearchAgentResultPrompt)({
        query: action.query,
        candidates: pendingCandidates,
        ...(searchRecord.error ? { searchError: searchRecord.error } : {}),
      });
      await persistAndPublish(stageMessage(runtime, "image_prefetch"));
      if (attachmentBudgetExhausted) break;
    }
    if (!finished && searchCount >= maxSearches) {
      finalSummary ||= encodeDiagnostic("IMG_SEARCH_LIMIT_REACHED_GENERIC");
    }
    if (searchCount === 0) {
      decision.needs_search = false;
      decision.rationale = finalSummary || encodeDiagnostic("IMG_EXISTING_SUFFICIENT");
      for (const stage of ["image_search", "image_deduplication", "image_prefetch", "image_analysis", "image_import"] as const) {
        if (checkpoint.stages[stage] === "waiting" || checkpoint.stages[stage] === "running") checkpoint.stages[stage] = "skipped";
      }
    } else {
      decision.needs_search = true;
      decision.rationale = finalSummary;
      const searchState: ImageWorkState = image.searches?.some((search) => search.status === "warning") ? "warning" : "completed";
      const prepareState: ImageWorkState = candidates.some((candidate) => candidate.aps_fetch_status === "failed") ? "warning" : "completed";
      const analysisState: ImageWorkState = attachmentBudgetExhausted || candidates.some((candidate) => candidate.analysis_status === "failed") || image.analysis_batches?.some((batch) => batch.status !== "completed")
        ? "warning"
        : "completed";
      const importState: ImageWorkState = candidates.some((candidate) => candidate.import_status === "failed") ? "warning" : "completed";
      if (checkpoint.stages.image_search === "running") {
        image.search_status = searchState;
        checkpoint.stages.image_search = searchState;
      }
      if (checkpoint.stages.image_deduplication === "running") {
        checkpoint.stages.image_deduplication = image.deduplication?.status === "completed" ? "completed" : "warning";
      } else if (checkpoint.stages.image_deduplication === "waiting") {
        checkpoint.stages.image_deduplication = "skipped";
      }
      if (checkpoint.stages.image_prefetch === "running") {
        image.prepare_status = prepareState;
        checkpoint.stages.image_prefetch = prepareState;
      } else if (checkpoint.stages.image_prefetch === "waiting") {
        checkpoint.stages.image_prefetch = "skipped";
      }
      if (checkpoint.stages.image_analysis === "running") {
        image.analysis_status = analysisState;
        checkpoint.stages.image_analysis = analysisState;
      } else if (checkpoint.stages.image_analysis === "waiting") {
        checkpoint.stages.image_analysis = "skipped";
      }
      if (checkpoint.stages.image_import === "running") {
        image.import_status = importState;
        checkpoint.stages.image_import = importState;
      } else if (checkpoint.stages.image_import === "waiting") {
        checkpoint.stages.image_import = "skipped";
      }
    }
    image.gaps = [...new Set(gaps)];
    image.diagnostic_errors = image.diagnostic_errors ?? [];
    await persist();
  } finally {
    await session.close().catch((error) => logResearchError(runtime, "image-session-close", error));
  }
  return { candidates, gaps: [...new Set(gaps)], searchCount };
}

/**
 * Spend the last word of a Web research Session on a summary instead of losing
 * the batch. Once the round budget is gone the Session may only finish; any
 * other action is treated as a protocol error and repaired within the same
 * consecutive-error budget used by the main loop.
 */
async function finishWebResearchAtRoundLimit(input: {
  runtime: DeckGenerationRuntime;
  session: AgentWebResearchSession;
  web: NonNullable<LinearResearchCheckpoint["web"]>;
  decision: WebResearchDecisionCheckpoint & { rounds: WebAgentLoopRound[] };
  title: string;
  maxRounds: number;
  sessionAttempt: number;
  lastResultPrompt: string;
  agentLogContext: AiOperationLogContext | undefined;
  persistAndPublish: (message: string) => Promise<void>;
}) {
  const { runtime, session, web, decision, maxRounds, persistAndPublish } = input;
  let prompt = [input.lastResultPrompt, buildWebResearchRoundLimitFinishPrompt(maxRounds)]
    .filter(Boolean)
    .join("\n\n");

  for (let attempt = 1; attempt <= WEB_RESEARCH_AGENT_MAX_CONSECUTIVE_PROTOCOL_ERRORS; attempt += 1) {
    throwIfCancelled(runtime);
    const round = maxRounds + attempt;
    const rawText = await measureResearchOperation(
      runtime,
      "research.web.agent_round",
      () => runResearchSession(runtime, "web", session, prompt, {
        modelPreference: WEB_RESEARCH_AGENT_MODEL,
        logContext: input.agentLogContext,
        signal: runtime.cancelSignal,
        isCancelled: runtime.isCancelled,
      }),
      { round, session_attempt: input.sessionAttempt, round_limit_finish: true },
      "anna-agent",
    );
    let action: WebResearchAgentAction;
    try {
      action = parseWebResearchAgentAction(rawText);
      if (action.action !== "finish") {
        throw new Error(`研究轮次已用尽，只能返回 finish 动作，收到：${action.action}`);
      }
    } catch (error) {
      decision.rounds.push({
        session_attempt: input.sessionAttempt,
        round,
        status: "protocol_error",
        error: errorMessage(error),
      });
      web.diagnostic_errors = appendUnique(
        web.diagnostic_errors,
        `Agent round limit finish ${attempt}: ${errorMessage(error)}`,
      );
      await persistAndPublish(stageMessage(runtime, "web_research"));
      if (attempt >= WEB_RESEARCH_AGENT_MAX_CONSECUTIVE_PROTOCOL_ERRORS) {
        throw new Error(webResearchAgentFailure(runtime.locale, "round_limit", maxRounds));
      }
      prompt = buildWebResearchRoundLimitRepairPrompt(error);
      continue;
    }

    decision.rounds.push({
      session_attempt: input.sessionAttempt,
      round,
      status: "action",
      action: "finish",
      result_status: "warning",
    });
    web.gaps = appendUnique(web.gaps, webResearchRoundLimitGap(runtime.locale, maxRounds));
    web.prepared_batch = buildWebBatch(researchTextLocale(runtime), input.title, "warning", action.markdown);
    await persistAndPublish(stageMessage(runtime, "web_research"));
    return;
  }
}

export async function runLinearSharedResearch(runtime: DeckGenerationRuntime, input: {
  resume: boolean;
  phase?: "all" | "web" | "image";
  webEnabled?: boolean;
  imageEnabled?: boolean;
  publishToPageProgress?: boolean;
  /** Reuse a coordinator-prepared checkpoint when running research branches in parallel. */
  initialContext?: SharedResearchContextResult;
  /** Leave overall finalization to a parallel coordinator. */
  finalizeSharedResearch?: boolean;
  webBrief?: string;
  webRequirementsText?: string;
  webUploadedSourceAnalysis?: string;
}) {
  const phase = input.phase ?? "all";
  const shouldRunWebPhase = phase !== "image";
  const researchWebOperationId = createResearchWebOperationId();
  let context = input.initialContext ?? await runtime.backend.prepareSharedResearchWorkspace({
    workspace_dir: runtime.workspace.workspace_dir,
    reset_progress: phase !== "image" && !input.resume,
  });
  const storedCheckpoint = readCheckpoint(context.progress);
  const checkpoint = migrateLegacyImageCheckpoint(storedCheckpoint);
  let persistedCheckpoint = structuredClone(storedCheckpoint);
  let persistQueue = Promise.resolve();
  const persist = (snapshot = structuredClone(checkpoint)) => {
    persistQueue = persistQueue.then(async () => {
      const operations = buildSharedResearchProgressOperations(runtime.workspace.workspace_dir, persistedCheckpoint, snapshot);
      for (const batch of chunkSharedResearchProgressOperations(runtime.workspace.workspace_dir, operations)) {
        await runtime.backend.patchSharedResearchProgress({ workspace_dir: runtime.workspace.workspace_dir, operations: batch });
      }
      persistedCheckpoint = structuredClone(snapshot);
    });
    return persistQueue;
  };
  let publishQueue = Promise.resolve();
  const publish = (message: string, snapshot: LinearResearchCheckpoint) => {
    publishQueue = publishQueue.then(async () => {
      runtime.researchDiscoveryProgress = withResearchLiveProgress(runtime, buildLinearResearchUiProgress(snapshot));
      const publishToPageProgress = input.publishToPageProgress !== false;
      if (publishToPageProgress) {
        const nextProgress = await runtime.backend.recordPageProgress({
          workspace_dir: runtime.workspace.workspace_dir,
          patch: { research_discovery: researchProgressForPersistence(runtime.researchDiscoveryProgress) },
        });
        runtime.setProgress(nextProgress);
      }
      emitRuntime(runtime, {
        step: "prepare",
        message,
        currentPageIndex: null,
        totalPages: runtime.confirmedOutline.items.length,
      }, publishToPageProgress ? runtime.getProgress() : null, undefined, getAttemptLimits(runtime));
    });
    return publishQueue;
  };
  const persistAndPublish = async (message: string) => {
    const snapshot = structuredClone(checkpoint);
    await persist(snapshot);
    await publish(message, snapshot);
  };
  // Image research runs after Web research has already been handled before
  // outline creation. When that earlier phase was explicitly disabled, close
  // both Web stages here so the shared checkpoint can be finalized. If the
  // caller does not provide an explicit Web decision, keep the waiting state
  // and let finalization fail rather than silently discarding required work.
  if (phase === "image" && input.webEnabled === false && input.finalizeSharedResearch !== false) {
    checkpoint.web ??= {};
    if (checkpoint.stages.web_decision === "waiting") {
      checkpoint.web.decision ??= {
        needs_search: false,
        queries: [],
        rationale: researchTextLocale(runtime) === "zh" ? "网页搜索已在设置中关闭。" : "Web research is disabled in settings.",
      };
      await setStage(runtime, checkpoint, "web_decision", "skipped", persistAndPublish);
    }
    if (checkpoint.stages.web_research === "waiting") {
      await setStage(runtime, checkpoint, "web_research", "skipped", persistAndPublish);
    }
  }
  if (shouldRunWebPhase && (checkpoint.stages.web_decision === "waiting" || checkpoint.stages.web_decision === "running")) {
    await setStage(runtime, checkpoint, "web_decision", "running", persistAndPublish);
    checkpoint.web ??= {};
    const enabled = input.webEnabled !== false;
    checkpoint.web.decision = enabled
      ? {
          needs_search: true,
          queries: [],
          rationale: researchTextLocale(runtime) === "zh" ? "用户已确认执行 Web 研究。" : "The user confirmed Web research.",
          mode: "agent-session-v1",
          session_attempt: 0,
          rounds: [],
        }
      : {
          needs_search: false,
          queries: [],
          rationale: researchTextLocale(runtime) === "zh" ? "网页搜索已在设置中关闭。" : "Web research is disabled in settings.",
        };
    await setStage(runtime, checkpoint, "web_decision", enabled ? "completed" : "skipped", persistAndPublish);
  }
  throwIfCancelled(runtime);

  if (shouldRunWebPhase && !checkpoint.web?.written) {
    await setStage(runtime, checkpoint, "web_research", "running", persistAndPublish);
    const decision = checkpoint.web?.decision ?? { needs_search: false, queries: [] };
    const title = batchTitle(runtime);
    if (!decision.needs_search) {
      const body = decision.rationale || (researchTextLocale(runtime) === "zh" ? "本轮无需新增网页资料。" : "No new web research is needed for this run.");
      checkpoint.web ??= {};
      checkpoint.web.prepared_batch = buildWebBatch(researchTextLocale(runtime), title, checkpoint.web.gaps?.length ? "warning" : "skipped", body);
    } else {
      checkpoint.web ??= {};
      checkpoint.web.searches ??= [];
      checkpoint.web.fetched_pages ??= [];
      checkpoint.web.fetch_result_ids ??= [];
      const webCheckpoint = checkpoint.web;
      const webSearches = webCheckpoint.searches ?? (webCheckpoint.searches = []);
      const webFetchedPages = webCheckpoint.fetched_pages ?? (webCheckpoint.fetched_pages = []);
      const webFetchResultIds = webCheckpoint.fetch_result_ids ?? (webCheckpoint.fetch_result_ids = []);
      decision.mode = "agent-session-v1";
      decision.rounds ??= [];
      const maxRounds = getWebResearchMaxRounds(runtime);
      decision.session_attempt = (decision.session_attempt ?? 0) + 1;
      let sessionAttempt = decision.session_attempt;
      const agentLogContext = researchLogContext(runtime, "web_research_agent", "web");
      let prompt = buildWebResearchAgentInitialPrompt({
        outline: runtime.confirmedOutline,
        brief: input.webBrief ?? runtime.workspace.requirements.source?.brief,
        presentationTitle: runtime.confirmedOutline.title,
        confirmedRequirementsText: input.webRequirementsText ?? formatWebResearchRequirements(runtime.workspace.requirements),
        uploadedSourceAnalysisContext: input.webUploadedSourceAnalysis,
        attachmentContext: runtime.attachmentContext,
        slideCount: runtime.workspace.requirements.selections.slide_count,
        outputLanguage: runtime.workspace.requirements.selections.output_language,
        existingWebSummary: context.web_summary,
        completedResearch: {
          searches: checkpoint.web.searches.map((search) => ({
            query: search.query,
            result: search.result ?? [],
            ...(search.error ? { error: search.error } : {}),
          })),
          fetchedPages: checkpoint.web.fetched_pages,
        },
      });
      const buildFreshWebPrompt = () => buildWebResearchAgentInitialPrompt({
        outline: runtime.confirmedOutline,
        brief: input.webBrief ?? runtime.workspace.requirements.source?.brief,
        presentationTitle: runtime.confirmedOutline.title,
        confirmedRequirementsText: input.webRequirementsText ?? formatWebResearchRequirements(runtime.workspace.requirements),
        uploadedSourceAnalysisContext: input.webUploadedSourceAnalysis,
        attachmentContext: runtime.attachmentContext,
        slideCount: runtime.workspace.requirements.selections.slide_count,
        outputLanguage: runtime.workspace.requirements.selections.output_language,
        existingWebSummary: context.web_summary,
        completedResearch: {
          searches: checkpoint.web?.searches?.map((search) => ({
            query: search.query,
            result: search.result ?? [],
            ...(search.error ? { error: search.error } : {}),
          })) ?? [],
          fetchedPages: checkpoint.web?.fetched_pages ?? [],
        },
      });
      const session = await runtime.agentClient.createWebResearchSession(
        WEB_RESEARCH_AGENT_SYSTEM_PROMPT,
        {
          freshPrompt: buildFreshWebPrompt,
          onFreshSession: () => {
            sessionAttempt = (decision.session_attempt ?? sessionAttempt) + 1;
            decision.session_attempt = sessionAttempt;
          },
        },
      );
      let consecutiveProtocolErrors = 0;
      let finished = false;
      try {
        for (let round = 1; round <= maxRounds; round += 1) {
          throwIfCancelled(runtime);
          const rawText = await measureResearchOperation(
            runtime,
            "research.web.agent_round",
            () => runResearchSession(runtime, "web", session, prompt, {
              modelPreference: WEB_RESEARCH_AGENT_MODEL,
              logContext: agentLogContext,
              signal: runtime.cancelSignal,
              isCancelled: runtime.isCancelled,
            }),
            { round, session_attempt: sessionAttempt },
            "anna-agent",
          );
          let action: WebResearchAgentAction;
          try {
            action = parseWebResearchAgentAction(rawText);
            if (action.action === "fetch") {
              const knownUrls = new Set(webSearches.flatMap((search) => search.result ?? []).map((result) => result.url.trim()));
              const unknownUrl = action.urls.find((url) => !knownUrls.has(url));
              if (unknownUrl) throw new Error("fetch.urls 中的 URL 必须来自已经返回的搜索结果：" + unknownUrl);
            }
          } catch (error) {
            consecutiveProtocolErrors += 1;
            decision.rounds.push({
              session_attempt: sessionAttempt,
              round,
              status: "protocol_error",
              error: errorMessage(error),
            });
            checkpoint.web.diagnostic_errors = appendUnique(
              checkpoint.web.diagnostic_errors,
              `Agent protocol round ${round}: ${errorMessage(error)}`,
            );
            await persistAndPublish(stageMessage(runtime, "web_research"));
            if (consecutiveProtocolErrors >= WEB_RESEARCH_AGENT_MAX_CONSECUTIVE_PROTOCOL_ERRORS) {
              if (typeof session.restartFreshSession !== "function") {
                throw new Error(webResearchAgentFailure(runtime.locale, "protocol_limit"));
              }
              await session.restartFreshSession();
              consecutiveProtocolErrors = 0;
              prompt = buildFreshWebPrompt();
              continue;
            }
            prompt = buildWebResearchProtocolRepairPrompt(error);
            continue;
          }

          consecutiveProtocolErrors = 0;
          const roundRecord: WebAgentLoopRound = {
            session_attempt: sessionAttempt,
            round,
            status: "action",
            action: action.action,
            ...(action.action === "search" ? { queries: action.queries } : {}),
            ...(action.action === "fetch" ? { urls: action.urls } : {}),
          };
          decision.rounds.push(roundRecord);
          if (action.action === "finish") {
            roundRecord.result_status = "completed";
            checkpoint.web.prepared_batch = buildWebBatch(
              researchTextLocale(runtime),
              title,
              (checkpoint.web.gaps?.length ?? 0) > 0 ? "warning" : "completed",
              action.markdown,
            );
            await persistAndPublish(stageMessage(runtime, "web_research"));
            finished = true;
            break;
          }

          if (action.action === "search") {
            const newQueries = action.queries.filter((query) => !webSearches.some((search) => search.query === query));
            decision.queries.push(...newQueries);
            await persistAndPublish(stageMessage(runtime, "web_research"));
            const rawBatchItems = await Promise.all(action.queries.map(async (query) => {
              const existing = webSearches.find((search) => search.query === query);
              if (existing) {
                return { query, results: existing.result ?? [], ...(existing.error ? { error: existing.error } : {}), cached: true };
              }
              try {
                const response = await measureResearchOperation(
                  runtime,
                  "research.web.search",
                  () => runtime.researchWebClient.search(
                    { query, max_results: 6 },
                    researchWebCallContext(runtime, researchWebOperationId),
                  ),
                  { round, session_attempt: sessionAttempt, query },
                );
                return { query, results: response.results, ...(response.results.length === 0 ? { error: "No results" } : {}), cached: false };
              } catch (error) {
                const message = errorMessage(error);
                await logResearchError(runtime, "web-search", error, { query });
                return { query, results: [], error: message, cached: false };
              }
            }));
            const batchItems = rawBatchItems.map((item) => {
              const existing = webSearches.find((search) => search.query === item.query);
              if (existing) return item;
              const queryIndex = decision.queries.indexOf(item.query) + 1;
              const results = item.results.map((result, resultIndex) => ({
                ...result,
                result_id: `web-q${queryIndex}-r${resultIndex + 1}`,
              }));
              webSearches.push(compactWebSearchRecordForPatch(runtime.workspace.workspace_dir, {
                query: item.query,
                status: item.error || results.length === 0 ? "warning" : "completed",
                result: results,
                ...(item.error ? { error: item.error } : results.length === 0 ? { error: "No results" } : {}),
              }) as unknown as typeof webSearches[number]);
              if (item.error) {
                webCheckpoint.gaps = appendUnique(
                  webCheckpoint.gaps,
                  encodeDiagnostic("WEB_QUERY_FAILED", { query: item.query }),
                );
                webCheckpoint.diagnostic_errors = appendUnique(webCheckpoint.diagnostic_errors, `${item.query}: ${item.error}`);
              } else if (results.length === 0) {
                webCheckpoint.gaps = appendUnique(
                  webCheckpoint.gaps,
                  encodeDiagnostic("WEB_QUERY_NO_RESULTS", { query: item.query }),
                );
              }
              return { ...item, results };
            });
            const warningItems = batchItems.filter((item) => item.error || item.results.length === 0);
            const allCached = batchItems.every((item) => item.cached);
            roundRecord.result_status = warningItems.length > 0 ? "warning" : allCached ? "cached" : "completed";
            if (warningItems.length > 0) roundRecord.error = warningItems.map((item) => `${item.query}: ${item.error || "No results"}`).join("; ");
            prompt = buildWebSearchResultPrompt({ searches: batchItems });
          } else {
            await persistAndPublish(stageMessage(runtime, "web_research"));
            const uncachedUrls = action.urls.filter((url) => !webFetchedPages.some((page) => page.url === url));
            const fetchedByUrl = new Map<string, ResearchWebFetchPage>();
            let batchFetchError = "";
            if (uncachedUrls.length > 0) {
              try {
                const response = await measureResearchOperation(
                  runtime,
                  "research.web.fetch",
                  () => runtime.researchWebClient.fetch(
                    { urls: uncachedUrls, max_chars: 8000 },
                    researchWebCallContext(runtime, researchWebOperationId),
                  ),
                  { round, session_attempt: sessionAttempt, url_count: uncachedUrls.length },
                );
                uncachedUrls.forEach((url, index) => {
                  const positionalPage = response.pages[index];
                  const fetchedPage = response.pages.find((item) => item.url === url || item.final_url === url)
                    ?? (positionalPage && (!positionalPage.url || uncachedUrls.includes(positionalPage.url)) ? positionalPage : undefined)
                    ?? { url, ok: false, error: "No page returned" };
                  fetchedByUrl.set(url, { ...fetchedPage, url });
                });
              } catch (error) {
                batchFetchError = errorMessage(error);
                await logResearchError(runtime, "web-fetch", error, { urls: uncachedUrls });
                uncachedUrls.forEach((url) => fetchedByUrl.set(url, { url, ok: false, error: batchFetchError }));
              }
            }
            const allResults = webSearches.flatMap((search) => search.result ?? []);
            const batchItems = action.urls.map((url) => {
              const existing = webFetchedPages.find((page) => page.url === url);
              if (existing) return { url, page: existing, ...(existing.ok ? {} : { error: existing.error || "Fetch failed" }), cached: true };
              const result = allResults.find((item) => item.url.trim() === url);
              if (result && !webFetchResultIds.includes(result.result_id)) {
                webFetchResultIds.push(result.result_id);
              }
              const page = fetchedByUrl.get(url) ?? { url, ok: false, error: batchFetchError || "No page returned" };
              webFetchedPages.push(page);
              if (!page.ok) {
                const message = page.error || "Fetch failed";
                webCheckpoint.gaps = appendUnique(
                  webCheckpoint.gaps,
                  encodeDiagnostic("WEB_PAGE_READ_FAILED", { url }),
                );
                webCheckpoint.diagnostic_errors = appendUnique(webCheckpoint.diagnostic_errors, `${url}: ${message}`);
              }
              return { url, page, ...(page.ok ? {} : { error: page.error || "Fetch failed" }), cached: false };
            });
            const warningItems = batchItems.filter((item) => item.error);
            const allCached = batchItems.every((item) => item.cached);
            roundRecord.result_status = warningItems.length > 0 ? "warning" : allCached ? "cached" : "completed";
            if (warningItems.length > 0) roundRecord.error = warningItems.map((item) => `${item.url}: ${item.error}`).join("; ");
            prompt = buildWebFetchResultPrompt({ pages: batchItems });
          }
          await persistAndPublish(stageMessage(runtime, "web_research"));
        }
        if (!finished) {
          // The round budget is spent. Ask for a summary of what was collected
          // instead of discarding the whole batch.
          await finishWebResearchAtRoundLimit({
            runtime,
            session,
            web: webCheckpoint,
            decision: decision as WebResearchDecisionCheckpoint & { rounds: WebAgentLoopRound[] },
            title,
            maxRounds,
            sessionAttempt,
            lastResultPrompt: prompt,
            agentLogContext,
            persistAndPublish,
          });
          finished = true;
        }
      } finally {
        await session.close();
      }
      if (!finished || !checkpoint.web.prepared_batch) {
        throw new Error(webResearchAgentFailure(runtime.locale, "missing_markdown"));
      }
    }
    await persistAndPublish(stageMessage(runtime, "web_research"));
    await measureResearchOperation(
      runtime,
      "research.web.publish",
      () => runtime.backend.publishPreparedWebResearchBatch({ workspace_dir: runtime.workspace.workspace_dir }).then(() => undefined),
    );
    checkpoint.web.written = true;
    persistedCheckpoint.web ??= {};
    persistedCheckpoint.web.written = true;
    await setStage(runtime, checkpoint, "web_research", checkpoint.web.gaps?.length ? "warning" : decision.needs_search ? "completed" : "skipped", persistAndPublish);
  }
  context = await runtime.backend.getSharedResearchContext({ workspace_dir: runtime.workspace.workspace_dir });
  throwIfCancelled(runtime);

  if (phase === "web") {
    return {
      status: checkpoint.web?.gaps?.length ? "warning" as const : checkpoint.web?.decision?.needs_search ? "completed" as const : "skipped" as const,
      context,
    };
  }

  if (checkpoint.stages.image_decision === "waiting" || checkpoint.stages.image_decision === "running") {
    await setStage(runtime, checkpoint, "image_decision", "running", persistAndPublish);
    checkpoint.image ??= {};
    if (input.imageEnabled === false) {
      checkpoint.image.decision = {
        needs_search: false,
        queries: [],
        rationale: encodeDiagnostic("IMG_DISABLED_IN_SETTINGS"),
        mode: "agent-session-v2",
        session_attempt: 0,
        rounds: [],
      };
      await setStage(runtime, checkpoint, "image_decision", "skipped", persistAndPublish);
    } else {
      checkpoint.image.decision ??= {
        needs_search: true,
        queries: [],
        rationale: encodeDiagnostic("IMG_SESSION_DECIDES_SCOPE"),
        mode: "agent-session-v2",
        session_attempt: 0,
        rounds: [],
      };
      await setStage(runtime, checkpoint, "image_decision", "completed", persistAndPublish);
    }
  }
  throwIfCancelled(runtime);

  if (!checkpoint.image?.written) {
    checkpoint.image ??= {};
    if (input.imageEnabled === false) {
      checkpoint.stages.image_search = "skipped";
      checkpoint.stages.image_deduplication = "skipped";
      checkpoint.stages.image_prefetch = "skipped";
      checkpoint.stages.image_analysis = "skipped";
      checkpoint.stages.image_import = "skipped";
    } else {
      await setStage(runtime, checkpoint, "image_research", "running", persistAndPublish);
      try {
        await runImageResearchSession({
          runtime,
          checkpoint,
          context,
          researchWebOperationId,
          resume: input.resume,
          persist,
          persistAndPublish,
        });
      } catch (error) {
        if (isAgentRunCancelledError(error) || runtime.isCancelled()) throw error;
        checkpoint.image.gaps = appendUnique(
          checkpoint.image.gaps,
          encodeDiagnostic("IMG_SESSION_INCOMPLETE"),
        );
        checkpoint.image.diagnostic_errors = appendUnique(checkpoint.image.diagnostic_errors, errorMessage(error));
        for (const stage of ["image_search", "image_deduplication", "image_prefetch", "image_analysis", "image_import"] as const) {
          if (checkpoint.stages[stage] === "waiting" || checkpoint.stages[stage] === "running") checkpoint.stages[stage] = "skipped";
        }
        checkpoint.image.search_status = checkpoint.image.search_status === "completed" ? "completed" : "warning";
        checkpoint.image.prepare_status = checkpoint.image.prepare_status === "completed" ? "completed" : "warning";
        checkpoint.image.analysis_status = checkpoint.image.analysis_status === "completed" ? "completed" : "warning";
        checkpoint.image.import_status = checkpoint.image.import_status === "completed" ? "completed" : "warning";
        await logResearchError(runtime, "image-session", error);
        await persist();
      }
    }
    const image = checkpoint.image;
    const decision = image.decision ?? { needs_search: false, queries: [] };
    const candidates = image.candidates ?? [];
    const gaps = [...new Set(image.gaps ?? [])];
    if (!decision.needs_search) {
      checkpoint.stages.image_search = "skipped";
      checkpoint.stages.image_deduplication = "skipped";
      checkpoint.stages.image_prefetch = "skipped";
      checkpoint.stages.image_analysis = "skipped";
      checkpoint.stages.image_import = "skipped";
    }
    const queries: SharedResearchImageBatch["queries"] = (image.searches ?? []).map((search) => ({
      query: search.query,
      status: search.status === "completed" ? "completed" : "warning",
      candidate_count: new Set((search.result ?? []).map((occurrence) => normalizeImageUrlForDedup(occurrence.image_url))).size,
      ...(search.error ? { message: encodeDiagnostic("IMG_NO_USABLE_CANDIDATES") } : {}),
    }));
    image.prepared_batch = {
      title: batchTitle(runtime),
      status: !decision.needs_search ? "skipped" : gaps.length > 0 || candidates.length === 0 ? "warning" : "completed",
      queries,
      candidates: candidates.map((candidate) => {
        const { error: _diagnosticError, ...formalCandidate } = candidate;
        return formalCandidate;
      }),
      gaps,
      statistics: {
        queries: queries.length,
        candidates: candidates.length,
        raw_candidates: image.deduplication?.statistics.raw_occurrences ?? candidates.length,
        unique_url_candidates: image.deduplication?.statistics.unique_urls ?? candidates.length,
        duplicate_url_occurrences: image.deduplication?.statistics.duplicate_occurrences ?? 0,
        downloaded: candidates.filter((candidate) => candidate.aps_fetch_status === "completed").length,
        uploaded: 0,
        aps_fetched: candidates.filter((candidate) => candidate.aps_fetch_status === "completed").length,
        unique_content_candidates: image.content_deduplication?.statistics.unique_content ?? new Set(candidates.filter((candidate) => candidate.sha256).map((candidate) => candidate.sha256)).size,
        download_failed: candidates.filter((candidate) => candidate.aps_fetch_status === "failed").length,
        upload_failed: 0,
        aps_fetch_failed: candidates.filter((candidate) => candidate.aps_fetch_status === "failed").length,
        selected: candidates.filter((candidate) => candidate.use_in_ppt).length,
        imported: candidates.filter((candidate) => candidate.import_status === "imported").length,
        unique_content_imported: new Set(candidates.filter((candidate) => candidate.import_status === "imported" && candidate.sha256).map((candidate) => candidate.sha256)).size,
        failed: candidates.filter((candidate) => candidate.aps_fetch_status === "failed" || candidate.analysis_status === "failed" || candidate.import_status === "failed").length,
        gaps: gaps.length,
      },
    };
    await persistAndPublish(stageMessage(runtime, "image_research"));
    await measureResearchOperation(
      runtime,
      "research.image.publish",
      () => runtime.backend.publishPreparedImageResearchBatch({ workspace_dir: runtime.workspace.workspace_dir }).then(() => undefined),
    );
    image.written = true;
    persistedCheckpoint.image ??= {};
    persistedCheckpoint.image.written = true;
    const status = image.prepared_batch!.status;
    const stageStates = Object.values(checkpoint.stages);
    const noNewResearch = checkpoint.web?.decision?.needs_search !== true && checkpoint.image?.decision?.needs_search !== true;
    if (input.finalizeSharedResearch !== false) {
      checkpoint.status = status === "warning" || stageStates.includes("warning")
        ? "warning"
        : noNewResearch
          ? "skipped"
          : "completed";
    }
    await setStage(runtime, checkpoint, "image_research", status, persistAndPublish);
    try {
      await runtime.backend.cleanupSharedResearchImageStaging({
        workspace_dir: runtime.workspace.workspace_dir,
        operation_id: researchWebOperationId,
      });
    } catch (error) {
      await logResearchError(runtime, "image-staging-cleanup", error);
    }
  }
  return {
    status: checkpoint.status,
    context: await runtime.backend.getSharedResearchContext({ workspace_dir: runtime.workspace.workspace_dir }),
  };
}

/**
 * Run Web and image research as independent sessions after one checkpoint
 * initialization. Each branch patches its own namespace; the engine's final
 * operation is issued only after both branches have settled, so one branch
 * cannot overwrite the other's progress or finalize an unfinished stage.
 */
export async function runParallelSharedResearch(runtime: DeckGenerationRuntime, input: {
  resume: boolean;
  webEnabled?: boolean;
  imageEnabled?: boolean;
  publishToPageProgress?: boolean;
  webBrief?: string;
  webRequirementsText?: string;
  webUploadedSourceAnalysis?: string;
}) {
  const initialContext = await runtime.backend.prepareSharedResearchWorkspace({
    workspace_dir: runtime.workspace.workspace_dir,
    reset_progress: !input.resume,
  });
  const initialDiscovery = buildLinearResearchUiProgress(readCheckpoint(initialContext.progress));
  let webDiscovery = initialDiscovery;
  let imageDiscovery = initialDiscovery;
  const branchRuntime = (kind: "web" | "image"): DeckGenerationRuntime => ({
    ...runtime,
    onProgress: (progress) => {
      if (progress.researchDiscovery) {
        if (kind === "web") webDiscovery = progress.researchDiscovery;
        else imageDiscovery = progress.researchDiscovery;
      }
      const merged = mergeParallelResearchProgress(webDiscovery, imageDiscovery);
      runtime.researchDiscoveryProgress = merged;
      runtime.onProgress({ ...progress, researchDiscovery: merged });
    },
  });
  const branchInput = {
    resume: input.resume,
    initialContext,
    publishToPageProgress: input.publishToPageProgress,
    finalizeSharedResearch: false,
  };
  const results = await Promise.allSettled([
    runLinearSharedResearch(branchRuntime("web"), {
      ...branchInput,
      phase: "web",
      webEnabled: input.webEnabled,
      webBrief: input.webBrief,
      webRequirementsText: input.webRequirementsText,
      webUploadedSourceAnalysis: input.webUploadedSourceAnalysis,
    }),
    runLinearSharedResearch(branchRuntime("image"), {
      ...branchInput,
      phase: "image",
      imageEnabled: input.imageEnabled,
    }),
  ]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  const context = await runtime.backend.getSharedResearchContext({
    workspace_dir: runtime.workspace.workspace_dir,
  });
  const checkpoint = readCheckpoint(context.progress);
  const stages = Object.values(checkpoint.stages);
  if (stages.some((state) => state === "waiting" || state === "running")) {
    throw new Error("Shared research branches did not settle all stages.");
  }
  await runtime.backend.patchSharedResearchProgress({
    workspace_dir: runtime.workspace.workspace_dir,
    operations: [{ op: "finalize_shared_research" }],
  });
  const finalizedContext = await runtime.backend.getSharedResearchContext({
    workspace_dir: runtime.workspace.workspace_dir,
  });
  const finalizedCheckpoint = readCheckpoint(finalizedContext.progress);
  runtime.researchDiscoveryProgress = buildLinearResearchUiProgress(finalizedCheckpoint);
  return {
    status: finalizedCheckpoint.status === "warning"
      ? "warning" as const
      : finalizedCheckpoint.status,
    context: finalizedContext,
  };
}

function mergeParallelResearchProgress(
  web: ResearchDiscoveryProgress,
  image: ResearchDiscoveryProgress,
): ResearchDiscoveryProgress {
  const webPhases = new Set(["web-decision", "web-collection"]);
  const records = web.records.map((record) =>
    webPhases.has(record.phase)
      ? record
      : image.records.find((candidate) => candidate.phase === record.phase) ?? record,
  );
  const states = records.map((record) => record.state);
  const status = states.includes("running")
    ? "running"
    : states.includes("warning")
      ? "warning"
      : states.includes("waiting")
        ? "waiting"
        : states.every((state) => state === "skipped")
          ? "skipped"
          : "completed";
  const gaps = [...new Set(records.flatMap((record) => record.gaps ?? []))];
  return {
    status,
    records,
    summary: {
      facts: records.reduce((total, record) => total + (record.counts?.facts ?? 0), 0),
      derivedInsights: records.reduce((total, record) => total + (record.counts?.derivedInsights ?? 0), 0),
      visualAssets: image.summary.visualAssets,
      gaps: gaps.length,
      rejectedMaterial: records.reduce((total, record) => total + (record.counts?.rejectedMaterial ?? 0), 0),
    },
    updatedAt: new Date().toISOString(),
  };
}
