import { pickLocale } from "../../i18n/locales";
import type { AgentClient } from "../../agent/agentClient";
import type { Locale } from "../../i18n/locales";
import type {
  ResearchWebClient,
  ResearchWebFetchPage,
  ResearchWebSearchResult,
} from "../../api/researchWebClient";
import { createResearchWebOperationId } from "../../api/researchWebClient";
import {
  buildWebFetchResultPrompt,
  buildWebResearchProtocolRepairPrompt,
  buildWebSearchResultPrompt,
  parseWebResearchAgentAction,
  WEB_RESEARCH_AGENT_MAX_CONSECUTIVE_PROTOCOL_ERRORS,
  WEB_RESEARCH_AGENT_MAX_FETCH_URLS_PER_ACTION,
  WEB_RESEARCH_AGENT_MAX_ROUNDS,
  WEB_RESEARCH_AGENT_MAX_SEARCH_QUERIES_PER_ACTION,
  type WebResearchAgentAction,
} from "../../ai/webResearchAgent";

export type WebResearchLabFileName = "input.json" | "rounds.jsonl" | "result.md" | "meta.json";

export interface WebResearchLabRound {
  round: number;
  started_at: string;
  ended_at: string;
  prompt: string;
  raw_text?: string;
  action?: WebResearchAgentAction["action"];
  queries?: string[];
  urls?: string[];
  result_status: "completed" | "cached" | "warning" | "protocol_error";
  response?: unknown;
  error?: string;
}

export interface WebResearchLabEvent {
  type: "started" | "agent" | "action" | "tool" | "protocol_error" | "completed" | "failed";
  round?: number;
  message: string;
  data?: unknown;
}

export interface WebResearchLabWorkflowResult {
  run_id: string;
  run_dir: string;
  markdown: string;
  rounds: WebResearchLabRound[];
  searches: Array<{ query: string; results: ResearchWebSearchResult[]; error?: string }>;
  fetched_pages: ResearchWebFetchPage[];
  status: "completed";
}

export interface WebResearchLabWorkflowInput {
  agentClient: AgentClient;
  researchWebClient: ResearchWebClient;
  run_id: string;
  systemPrompt: string;
  userPrompt: string;
  modelPreference: string;
  locale?: Locale;
  persistFile: (fileName: WebResearchLabFileName, content: string, append?: boolean) => Promise<{ run_dir: string }>;
  onEvent?: (event: WebResearchLabEvent) => void;
  signal?: AbortSignal;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function json(value: unknown) {
  return `${JSON.stringify(value, null, 2) ?? "null"}\n`;
}

function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Research cancelled", "AbortError");
}

function emit(input: WebResearchLabWorkflowInput, event: WebResearchLabEvent) {
  input.onEvent?.(event);
}

// 内部实验工具：ja/de 显式回退英文（v1.3 已清零二元判断）
function localized(input: WebResearchLabWorkflowInput, zh: string, en: string) {
  return pickLocale(input.locale ?? "en", { zh, en, ja: en, de: en });
}

export async function runWebResearchLab(
  input: WebResearchLabWorkflowInput,
): Promise<WebResearchLabWorkflowResult> {
  const startedAt = new Date().toISOString();
  const operationId = createResearchWebOperationId();
  const rounds: WebResearchLabRound[] = [];
  const searches: Array<{ query: string; results: ResearchWebSearchResult[]; error?: string }> = [];
  const fetchedPages: ResearchWebFetchPage[] = [];
  let runDir = "";

  const persist = async (fileName: WebResearchLabFileName, content: string, append = false) => {
    const result = await input.persistFile(fileName, content, append);
    runDir = result.run_dir;
  };

  await persist("input.json", json({
    schema_version: 1,
    run_id: input.run_id,
    operation_id: operationId,
    started_at: startedAt,
    system_prompt: input.systemPrompt,
    user_prompt: input.userPrompt,
    model_preference: input.modelPreference,
    max_rounds: WEB_RESEARCH_AGENT_MAX_ROUNDS,
    max_consecutive_protocol_errors: WEB_RESEARCH_AGENT_MAX_CONSECUTIVE_PROTOCOL_ERRORS,
    max_search_queries_per_action: WEB_RESEARCH_AGENT_MAX_SEARCH_QUERIES_PER_ACTION,
    max_fetch_urls_per_action: WEB_RESEARCH_AGENT_MAX_FETCH_URLS_PER_ACTION,
  }));
  await persist("meta.json", json({
    schema_version: 1,
    run_id: input.run_id,
    operation_id: operationId,
    status: "running",
    started_at: startedAt,
  }));
  emit(input, { type: "started", message: localized(input, "研究已开始。", "Research run started."), data: runDir });

  let prompt = input.userPrompt.trim();
  let consecutiveProtocolErrors = 0;
  let markdown = "";
  let session: Awaited<ReturnType<AgentClient["createWebResearchSession"]>> | null = null;
  try {
    const buildFreshPrompt = () => [
      input.userPrompt.trim(),
      "\n以下是当前研究 checkpoint（检查点）。新会话必须复用已经完成的搜索和抓取，不要重复执行；请继续补足研究或输出 finish：",
      JSON.stringify({ searches, fetched_pages: fetchedPages }),
    ].join("\n");
    session = await input.agentClient.createWebResearchSession(input.systemPrompt.trim() || "", {
      freshPrompt: buildFreshPrompt,
    });
    for (let round = 1; round <= WEB_RESEARCH_AGENT_MAX_ROUNDS; round += 1) {
      throwIfCancelled(input.signal);
      const roundStartedAt = new Date().toISOString();
      let rawText = "";
      try {
        rawText = await session.run(prompt, {
          modelPreference: input.modelPreference.trim() || undefined,
          signal: input.signal,
          isCancelled: () => Boolean(input.signal?.aborted),
        });
        emit(input, { type: "agent", round, message: localized(input, "Agent 已返回响应。", "Agent response received."), data: rawText });
      } catch (error) {
        const message = errorMessage(error);
        const record: WebResearchLabRound = {
          round,
          started_at: roundStartedAt,
          ended_at: new Date().toISOString(),
          prompt,
          result_status: "warning",
          error: message,
        };
        rounds.push(record);
        await persist("rounds.jsonl", `${json(record)}`, true);
        throw error;
      }

      let action: WebResearchAgentAction;
      try {
        const parsedAction = parseWebResearchAgentAction(rawText);
        if (parsedAction.action === "fetch") {
          const knownUrls = new Set(searches.flatMap((search) => search.results).map((result) => result.url.trim()));
          const unknownUrl = parsedAction.urls.find((url) => !knownUrls.has(url));
          if (unknownUrl) throw new Error("fetch.urls 中的 URL 必须来自已经返回的搜索结果：" + unknownUrl);
        }
        action = parsedAction;
      } catch (error) {
        const message = errorMessage(error);
        consecutiveProtocolErrors += 1;
        const record: WebResearchLabRound = {
          round,
          started_at: roundStartedAt,
          ended_at: new Date().toISOString(),
          prompt,
          raw_text: rawText,
          result_status: "protocol_error",
          error: message,
        };
        rounds.push(record);
        await persist("rounds.jsonl", `${json(record)}`, true);
        emit(input, { type: "protocol_error", round, message: localized(input, `协议错误：${message}`, `Protocol error: ${message}`), data: rawText });
        if (consecutiveProtocolErrors >= WEB_RESEARCH_AGENT_MAX_CONSECUTIVE_PROTOCOL_ERRORS) {
          if (typeof session.restartFreshSession !== "function") {
            throw new Error(`Web Research Agent 连续协议错误已达到上限：${message}`);
          }
          await session.restartFreshSession();
          consecutiveProtocolErrors = 0;
          prompt = buildFreshPrompt();
          continue;
        }
        prompt = buildWebResearchProtocolRepairPrompt(error);
        continue;
      }

      consecutiveProtocolErrors = 0;
      const record: WebResearchLabRound = {
        round,
        started_at: roundStartedAt,
        ended_at: new Date().toISOString(),
        prompt,
        raw_text: rawText,
        action: action.action,
        result_status: "completed",
      };
      if (action.action === "search") record.queries = action.queries;
      if (action.action === "fetch") record.urls = action.urls;
      emit(input, { type: "action", round, message: localized(input, `Agent 动作：${action.action}`, `Agent action: ${action.action}`), data: action });

      if (action.action === "finish") {
        markdown = action.markdown;
        record.response = { markdown };
        record.ended_at = new Date().toISOString();
        rounds.push(record);
        await persist("rounds.jsonl", `${json(record)}`, true);
        await persist("result.md", `${markdown.trim()}\n`);
        await persist("meta.json", json({
          schema_version: 1,
          run_id: input.run_id,
          operation_id: operationId,
          status: "completed",
          started_at: startedAt,
          ended_at: new Date().toISOString(),
          round_count: rounds.length,
          search_count: searches.length,
          fetched_page_count: fetchedPages.length,
        }));
        emit(input, { type: "completed", round, message: localized(input, "研究已完成。", "Research completed."), data: markdown });
        return {
          run_id: input.run_id,
          run_dir: runDir,
          markdown,
          rounds,
          searches,
          fetched_pages: fetchedPages,
          status: "completed",
        };
      }

      if (round === WEB_RESEARCH_AGENT_MAX_ROUNDS) {
        throw new Error(`Web Research Agent 已达到轮次上限（${WEB_RESEARCH_AGENT_MAX_ROUNDS}）`);
      }

      if (action.action === "search") {
        const batchItems = await Promise.all(action.queries.map(async (query) => {
          const existing = searches.find((search) => search.query === query);
          if (existing) {
            return { query, results: existing.results, ...(existing.error ? { error: existing.error } : {}), cached: true };
          }
          try {
            const response = await input.researchWebClient.search(
              { query, max_results: 6 },
              { workspace_dir: runDir, operation_id: operationId },
            );
            return {
              query,
              results: response.results,
              ...(response.results.length === 0 ? { error: "No results" } : {}),
              cached: false,
            };
          } catch (error) {
            return { query, results: [], error: errorMessage(error), cached: false };
          }
        }));
        for (const item of batchItems) {
          if (!searches.some((search) => search.query === item.query)) {
            searches.push({ query: item.query, results: item.results, ...(item.error ? { error: item.error } : {}) });
          }
        }
        const warningItems = batchItems.filter((item) => item.error);
        const allCached = batchItems.every((item) => item.cached);
        record.result_status = warningItems.length > 0 ? "warning" : allCached ? "cached" : "completed";
        if (warningItems.length > 0) record.error = warningItems.map((item) => `${item.query}: ${item.error}`).join("; ");
        record.response = { searches: batchItems };
        prompt = buildWebSearchResultPrompt({ searches: batchItems });
        const resultCount = batchItems.reduce((count, item) => count + item.results.length, 0);
        emit(input, {
          type: "tool",
          round,
          message: localized(input, `搜索完成：${batchItems.length} 个 query，共 ${resultCount} 条结果。`, `Search completed: ${batchItems.length} queries, ${resultCount} results.`),
          data: batchItems,
        });
      } else {
        const uncachedUrls = action.urls.filter((url) => !fetchedPages.some((page) => page.url === url));
        const fetchedByUrl = new Map<string, ResearchWebFetchPage>();
        let batchFetchError = "";
        if (uncachedUrls.length > 0) {
          try {
            const response = await input.researchWebClient.fetch(
              { urls: uncachedUrls, max_chars: 8000 },
              { workspace_dir: runDir, operation_id: operationId },
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
            uncachedUrls.forEach((url) => fetchedByUrl.set(url, { url, ok: false, error: batchFetchError }));
          }
        }
        const batchItems = action.urls.map((url) => {
          const existing = fetchedPages.find((page) => page.url === url);
          if (existing) return { url, page: existing, ...(existing.ok ? {} : { error: existing.error || "Fetch failed" }), cached: true };
          const page = fetchedByUrl.get(url) ?? { url, ok: false, error: batchFetchError || "No page returned" };
          fetchedPages.push(page);
          return { url, page, ...(page.ok ? {} : { error: page.error || "Fetch failed" }), cached: false };
        });
        const warningItems = batchItems.filter((item) => item.error);
        const allCached = batchItems.every((item) => item.cached);
        record.result_status = warningItems.length > 0 ? "warning" : allCached ? "cached" : "completed";
        if (warningItems.length > 0) record.error = warningItems.map((item) => `${item.url}: ${item.error}`).join("; ");
        record.response = { pages: batchItems };
        prompt = buildWebFetchResultPrompt({ pages: batchItems });
        const successfulCount = batchItems.filter((item) => item.page?.ok).length;
        emit(input, {
          type: "tool",
          round,
          message: localized(input, `网页抓取完成：${successfulCount}/${batchItems.length} 个 URL 成功。`, `Page fetch completed: ${successfulCount}/${batchItems.length} URLs succeeded.`),
          data: batchItems,
        });
      }

      record.ended_at = new Date().toISOString();
      rounds.push(record);
      await persist("rounds.jsonl", `${json(record)}`, true);
    }
  } catch (error) {
    const message = errorMessage(error);
    await persist("meta.json", json({
      schema_version: 1,
      run_id: input.run_id,
      operation_id: operationId,
      status: "failed",
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      round_count: rounds.length,
      search_count: searches.length,
      fetched_page_count: fetchedPages.length,
      error: message,
    }));
    emit(input, { type: "failed", message: localized(input, `研究失败：${message}`, `Research failed: ${message}`), data: error });
    throw error;
  } finally {
    await session?.close().catch(() => undefined);
  }

  throw new Error("Web Research Agent 未返回完成结果");
}
