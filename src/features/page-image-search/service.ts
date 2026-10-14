import { getResearchImageDownloadUrl } from "../../api/researchImageUrl";
import type { PageImageSearchContext, PageImageSearchResult, PageImageSearchTask } from "../../api/pageImageSearchTypes";
import type { DeckGenerationRuntime } from "../deck-generation/types";
import { readCheckpoint } from "../deck-generation/linearResearchWorkflow";
import { createOutlineImageLibraryService } from "../outline/imageLibrary";
import { throwIfCancelled } from "../deck-generation/runtimeSupport";
import { pageImageCandidate } from "./images";

export type PageImageSearchInput = Omit<PageImageSearchContext, "requirements" | "target_key"> & { target_key?: string };

const IMAGE_SEARCH_MAX_RESULTS = 20;
const IMAGE_FETCH_CONCURRENCY = 10;
const IMAGE_FETCH_MAX_BYTES = 20 * 1024 * 1024;
const PAGE_IMAGE_SEARCH_MAX_SEARCHES = 1;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export interface PageImageSearchService {
  preview(result: PageImageSearchResult): Promise<string>;
  load(context: PageImageSearchInput): Promise<PageImageSearchTask | null>;
  run(context: PageImageSearchInput, previous: PageImageSearchTask | null, onChange: (task: PageImageSearchTask) => void): Promise<PageImageSearchTask>;
  add(task: PageImageSearchTask, resultIds: string[]): Promise<string[]>;
  cancel(taskId?: string): void;
  isRunning(taskId?: string): boolean;
}

const running = new Map<string, { id: string; controller: AbortController }>();

export async function pageImageTargetKey(input: PageImageSearchInput): Promise<string> {
  if (input.target_key) return input.target_key;
  if (input.page.page_id) return input.page.page_id;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({
    title: input.title,
    global: input.global_creation_requirements,
    page: { title: input.page.title, content: input.page.content, creation_requirements: input.page.creation_requirements },
  })));
  return `draft-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function runWorker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }
  return Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker)).then(() => results);
}

function normalizeImageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"]) {
      parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function researchWebCallContext(runtime: DeckGenerationRuntime, operationId: string) {
  return { workspace_dir: runtime.workspace.workspace_dir, operation_id: operationId };
}

function createTask(context: PageImageSearchInput, base: DeckGenerationRuntime, id: string): PageImageSearchTask {
  const targetKey = context.target_key ?? context.page.page_id ?? "";
  return {
    id,
    context: {
      ...structuredClone(context),
      target_key: targetKey,
      requirements: structuredClone(base.workspace.requirements),
    },
    max_searches: PAGE_IMAGE_SEARCH_MAX_SEARCHES,
    status: "running",
    checkpoint: readCheckpoint({}),
    result_ids: [],
    results: [],
    updated_at: new Date().toISOString(),
  };
}

function isUsableFetchedImage(value: {
  path: string;
  mime_type: string;
  bytes_size: number;
  sha256: string;
}): boolean {
  return Boolean(value.path && SUPPORTED_IMAGE_MIME_TYPES.has(value.mime_type.toLowerCase()) && Number.isFinite(value.bytes_size) && value.bytes_size > 0 && /^[a-f0-9]{64}$/i.test(value.sha256));
}

async function logCandidateFailure(base: DeckGenerationRuntime, operationId: string, stage: string, detail: Record<string, unknown>, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/(?:https?:\/\/|data:)[^\s"'<>]+/gi, "[redacted]").slice(0, 500);
  // Diagnostics must not turn an isolated candidate failure into a batch failure.
  try {
    await base.backend.appendWorkspaceLog({ workspace_dir: base.workspace.workspace_dir, channel: "ai-research",
      entry: { event: "research.warning", operation: `page-image-${stage}`, operation_id: operationId, ...detail, error: message, at: new Date().toISOString() },
    });
  } catch { /* Logging is best effort. */ }
}

async function refreshResultUrl(base: DeckGenerationRuntime, result: PageImageSearchResult, operationId: string): Promise<PageImageSearchResult | null> {
  try {
    const getUrl = await resolveResultUrl(base, result);
    return { ...result, get_url: getUrl };
  } catch (error) {
    await logCandidateFailure(base, operationId, "attachment-url", {
      candidate_id: result.result_id, aps_path: result.aps_path, sha256: result.sha256,
      mime_type: result.mime_type, bytes_size: result.bytes_size, width: result.width, height: result.height,
      aps_fetch_status: "completed",
    }, error);
    return { ...result, get_url: "" };
  }
}

async function resolveResultUrl(base: DeckGenerationRuntime, result: PageImageSearchResult): Promise<string> {
  let failure: unknown;
  for (const apsPath of [...new Set([result.aps_path, ...(result.aps_paths ?? [])])]) {
    try { return await getResearchImageDownloadUrl(base.researchWebClient, apsPath); }
    catch (error) { failure = error; }
  }
  throw failure;
}

function usableResults(results: Array<PageImageSearchResult | null>): PageImageSearchResult[] {
  return results.filter((result): result is PageImageSearchResult => result !== null);
}

export function createPageImageSearchService(base: DeckGenerationRuntime): PageImageSearchService {
  const dir = base.workspace.workspace_dir;
  return {
    preview: (result) => resolveResultUrl(base, result),
    isRunning: (id) => running.has(dir) && (!id || running.get(dir)?.id === id),
    cancel: (id) => {
      if (!id || running.get(dir)?.id === id) running.get(dir)?.controller.abort();
    },
    load: async (context) => {
      const task = await base.backend.pageImageSearch({ workspace_dir: dir, action: "get", target_key: await pageImageTargetKey(context) });
      if (!task?.results?.length) return task;
      const refreshed = usableResults(await mapWithConcurrency(task.results, IMAGE_FETCH_CONCURRENCY, (result) => refreshResultUrl(base, result, `${task.id}-load`)));
      return { ...task, results: refreshed, result_ids: refreshed.map((result) => result.result_id),
        ...(refreshed.length < task.results.length ? { error: "PAGE_IMAGE_SEARCH_CANDIDATES_SKIPPED" } : {}),
      };
    },
    async run(context, previous, onChange) {
      if (running.has(dir)) throw new Error("PAGE_IMAGE_SEARCH_BUSY");
      const query = context.opinion.trim();
      if (!query) throw new Error("PAGE_IMAGE_SEARCH_QUERY_REQUIRED");
      const controller = new AbortController();
      const taskId = previous?.id ?? crypto.randomUUID();
      running.set(dir, { id: taskId, controller });
      const owner = crypto.randomUUID();
      let acquired = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      let heartbeatError: unknown;
      const targetKey = await pageImageTargetKey(context).catch((error) => {
        running.delete(dir);
        throw error;
      });
      const task = previous ? structuredClone(previous) : createTask({ ...context, target_key: targetKey }, base, taskId);
      task.context = { ...task.context, ...structuredClone(context), target_key: targetKey, requirements: structuredClone(base.workspace.requirements) };
      task.max_searches = PAGE_IMAGE_SEARCH_MAX_SEARCHES;
      task.status = "running";
      task.result_ids = [];
      task.results = [];
      task.checkpoint = readCheckpoint({});
      task.results ??= [];
      delete task.error;

      let savedSignature = "";
      const saveIfChanged = async () => {
        const persistedTask = structuredClone(task);
        persistedTask.results = (persistedTask.results ?? []).map((result) => ({ ...result, get_url: "" }));
        const signature = JSON.stringify(persistedTask);
        if (signature === savedSignature) return;
        await base.backend.pageImageSearch({ workspace_dir: dir, action: "save", owner, task: persistedTask });
        savedSignature = signature;
      };
      const persist = async () => {
        if (heartbeatError) throw heartbeatError;
        task.updated_at = new Date().toISOString();
        onChange(structuredClone(task));
        await saveIfChanged();
      };

      try {
        const acquiredTask = await base.backend.pageImageSearch({ workspace_dir: dir, action: "acquire", owner, task });
        if (acquiredTask) Object.assign(task, acquiredTask);
        acquired = true;
        savedSignature = JSON.stringify(task);
        onChange(structuredClone(task));
        timer = setInterval(() => {
          void base.backend.pageImageSearch({ workspace_dir: dir, action: "heartbeat", owner })
            .catch((error) => { heartbeatError = error; controller.abort(); });
        }, 25_000);

        const runtime = { ...base, isCancelled: () => controller.signal.aborted, cancelSignal: controller.signal };
        throwIfCancelled(runtime);
        const operationId = `${task.id}-${crypto.randomUUID()}`;
        const response = await base.researchWebClient.imageSearch(
          { query, max_results: IMAGE_SEARCH_MAX_RESULTS, min_width: 800, min_height: 600, aspect: "any" },
          researchWebCallContext(base, operationId),
        );
        const seenUrls = new Set<string>();
        const candidates = response.results.filter((item) => {
          const normalized = normalizeImageUrl(item.image_url);
          if (!normalized || seenUrls.has(normalized)) return false;
          seenUrls.add(normalized);
          return true;
        }).slice(0, IMAGE_SEARCH_MAX_RESULTS);
        const fetched = await mapWithConcurrency(candidates, IMAGE_FETCH_CONCURRENCY, async (item) => {
          if (controller.signal.aborted) return null;
          try {
            const image = await base.researchWebClient.imageFetch(
              { url: item.image_url, max_bytes: IMAGE_FETCH_MAX_BYTES, purpose: "ppt-page-image-search" },
              researchWebCallContext(base, operationId),
            );
            if (!isUsableFetchedImage(image)) throw new Error("image_fetch returned an incomplete or unsupported image artifact");
            return refreshResultUrl(base, {
              result_id: `page-image-${image.sha256}`,
              query,
              image_url: item.image_url,
              ...(item.thumbnail_url !== undefined ? { thumbnail_url: item.thumbnail_url } : {}),
              source_url: item.source_url,
              final_url: image.final_url || item.source_url,
              ...(item.title !== undefined ? { title: item.title } : {}),
              ...(item.width !== undefined ? { width: item.width } : {}),
              ...(item.height !== undefined ? { height: item.height } : {}),
              aps_path: image.path,
              get_url: "",
              mime_type: image.mime_type.toLowerCase(),
              bytes_size: image.bytes_size,
              sha256: image.sha256.toLowerCase(),
            } satisfies PageImageSearchResult, operationId);
          } catch (error) {
            await logCandidateFailure(base, operationId, "fetch", { candidate_index: candidates.indexOf(item) }, error);
            return null;
          }
        });
        const byHash = new Map<string, PageImageSearchResult>();
        for (const result of fetched) {
          if (!result) continue;
          const previous = byHash.get(result.sha256);
          byHash.set(result.sha256, previous ? { ...previous,
            aps_paths: [...new Set([...(previous.aps_paths ?? [previous.aps_path]), result.aps_path])],
            source_urls: [...new Set([...(previous.source_urls ?? [previous.source_url]), result.source_url])],
          } : result);
        }
        task.results = [...byHash.values()];
        task.result_ids = task.results.map((result) => result.result_id);
        throwIfCancelled(runtime);
        task.status = "completed";
        if (fetched.some((result) => result === null)) task.error = "PAGE_IMAGE_SEARCH_CANDIDATES_SKIPPED";
      } catch (error) {
        task.status = controller.signal.aborted && !heartbeatError ? "cancelled" : "failed";
        task.error = error instanceof Error ? error.message : String(error);
        if (!acquired) throw error;
      } finally {
        if (timer) clearInterval(timer);
        try {
          if (acquired) await persist();
        } finally {
          if (acquired) await base.backend.pageImageSearch({ workspace_dir: dir, action: "release", owner }).catch(() => undefined);
          if (running.get(dir)?.id === taskId) running.delete(dir);
        }
      }
      return task;
    },
    async add(task, resultIds) {
      const requested = new Set(resultIds);
      const selected = (task.results ?? []).filter((result) => requested.has(result.result_id));
      const library = createOutlineImageLibraryService({ backend: base.backend, web: base.researchWebClient, workspaceDir: dir, locale: base.locale });
      const adopted = await library.adoptMany(selected.map(pageImageCandidate));
      return adopted.map((image) => image.asset_id);
    },
  };
}
