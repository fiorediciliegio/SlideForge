import type { ResearchWebFetchPage, ResearchWebSearchResult } from "../api/researchWebClient";
import { DEFAULT_AGENT_SAME_SESSION_RETRIES } from "../agent/agentSessionExecutor";
import { formatCurrentDateForPrompt } from "./promptContext";
import type { AttachmentContext } from "../api/types";
import { formatUserProvidedAttachmentContextForPrompt } from "./attachmentContextPrompt";

export const WEB_RESEARCH_AGENT_MODEL = "openai/gpt-5-mini";
/** Fallback when a Workspace setting is unavailable; see research_web_max_rounds. */
export const WEB_RESEARCH_AGENT_MAX_ROUNDS = 10;
export const WEB_RESEARCH_AGENT_MAX_SEARCH_QUERIES_PER_ACTION = 3;
export const WEB_RESEARCH_AGENT_MAX_FETCH_URLS_PER_ACTION = 5;
// The first protocol error is the initial response; subsequent errors consume
// the default same-Session repair budget before the research loop stops.
export const WEB_RESEARCH_AGENT_MAX_CONSECUTIVE_PROTOCOL_ERRORS = DEFAULT_AGENT_SAME_SESSION_RETRIES + 1;

export const WEB_RESEARCH_AGENT_SYSTEM_PROMPT = `你是一个为 PPT 生成服务的 Web 资料研究智能体。你的任务是通过多轮交互完成资料研究，而不是直接调用搜索或访问网页，不要调用任何工具。由我负责执行搜索、抓取网页、保存文件。你只负责根据当前研究目标、历史搜索结果和网页正文，决定下一步动作。

我会提供用户 Brief、演示文稿主题、结构化演示需求和（如有）上传资料分析结果。你的目标是通过 Web 搜索收集足够、可靠且与这份 PPT 相关的资料，供后续 PPT 内容生成使用。
你只负责资料研究和总结，不负责设计 PPT 大纲、页面结构或视觉方案。

你每一轮只能执行以下三种动作之一：

1. search：提出 1～3 个新的搜索查询
2. fetch：请求获取 1～5 个搜索结果的详细正文
3. finish：结束研究并返回最终 Markdown 总结

# 输出协议

每次回复必须先包含一个合法 JSON 动作头：

- 不要使用 Markdown 代码块包裹动作头
- 不要在动作头前添加解释
- 不要一次返回多个动作
- 不要输出 JSON 数组
- JSON 字符串中的换行必须正确转义
- 不要添加协议未定义的字段

## 搜索动作

当现有资料不足、存在事实缺口、实体歧义、来源失效或需要交叉验证时，返回：

{"action":"search","queries":["一个明确、具体、可直接提交给搜索引擎的查询"]}

每次提出 1～3 个 query；如果有多个相互独立的研究方向，可以放在同一个 queries 数组中。不要重复已经执行过的 query。

## 抓取动作

当搜索结果中存在值得阅读全文的来源时，返回：

{"action":"fetch","urls":["搜索结果中出现过的完整 URL"]}

每次提交 1～5 个 URL；所有 URL 都必须来自已经返回的搜索结果。不要重复已经抓取过的 URL。

## 完成动作

在你认为核心研究目标已经得到充分覆盖时，先返回：

{"action":"finish"}

然后紧接最终 Markdown 正文。动作头和 Markdown 正文之间至少换行一次。
请注意：输出要求是 Markdown 正文放到 {"action":"finish"} 动作头之后，不要将 Markdown 正文放到 json 字段中。

最终 Markdown 必须：

1. 围绕用户 Brief、演示主题和结构化演示需求整理可直接用于内容生成的事实、数据、案例和关键信息。
2. 不得引用未出现在搜索结果中的来源。
3. 不得把抓取失败、错误页、乱码页面或无关页面当作有效证据。
4. 对未解决的问题明确说明，不得编造内容填补缺口。
5. 不要出现 PPT 大纲、页面结构或视觉方案等内容，也不要对每页的 PPT 主题进行建议，只提供客观的事实资料即可。
6. 不要在文档最后加上推荐下一步做什么的结束语，文档只输出研究事实。

# 研究决策规则

- 优先根据我提供的当前日期（搜索资料截止日期），判断事件所处阶段后开始针对性研究。
- 优先选择第一方资料、官方资料、权威媒体、专业数据库和可信行业来源。
- 避免重复搜索、重复抓取和无目的扩展研究范围。
- 不要向用户提问；信息不足时通过 search 补充，无法补充时记录到最终 Markdown 中。

# 错误修复

如果 App 返回 JSON 格式错误或协议错误，说明你上一次输出不符合协议。你必须根据错误信息重新输出一个合法动作。

修复协议错误时：

- 不要解释错误原因
- 不要道歉
- 不要继续上一次动作之外的讨论
- 只返回修复后的动作`;

export type WebResearchAgentAction =
  | { action: "search"; queries: string[] }
  | { action: "fetch"; urls: string[] }
  | { action: "finish"; markdown: string };

export class WebResearchAgentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebResearchAgentProtocolError";
  }
}

interface JsonCandidate {
  start: number;
  end: number;
  value: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findActionCandidate(text: string): JsonCandidate | null {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth < 0) break;
        if (depth === 0) {
          try {
            const value = JSON.parse(text.slice(start, index + 1)) as unknown;
            if (isRecord(value) && ["search", "fetch", "finish"].includes(String(value.action))) {
              return { start, end: index + 1, value };
            }
          } catch {
            // Continue searching for a later valid action object.
          }
          break;
        }
      }
    }
  }
  return null;
}

function stripFenceClosingActionHeader(text: string, candidate: JsonCandidate) {
  const prefix = text.slice(0, candidate.start);
  const tail = text.slice(candidate.end);
  if (!/```(?:json)?\s*$/i.test(prefix)) return tail;
  const afterHeaderFence = tail.replace(/^\s*```(?:\r?\n)?/, "");
  if (afterHeaderFence !== tail) return afterHeaderFence;
  return tail.replace(/(?:\r?\n)?```\s*$/, "");
}

function assertExactFields(value: Record<string, unknown>, fields: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new WebResearchAgentProtocolError(`动作字段必须且只能是：${fields.join("、")}`);
  }
}

function parseActionStringArray(
  value: unknown,
  field: "queries" | "urls",
  maxLength: number,
) {
  if (!Array.isArray(value)) {
    throw new WebResearchAgentProtocolError(field + " 必须是数组");
  }
  if (value.length < 1 || value.length > maxLength) {
    throw new WebResearchAgentProtocolError(field + " 数量必须在 1～" + maxLength + " 个之间");
  }
  const values = value.map((item) => typeof item === "string" ? item.trim() : "");
  if (values.some((item) => !item)) {
    throw new WebResearchAgentProtocolError(field + " 中每一项都必须是非空字符串");
  }
  if (new Set(values).size !== values.length) {
    throw new WebResearchAgentProtocolError(field + " 中不能包含重复项");
  }
  return values;
}

export function parseWebResearchAgentAction(text: string): WebResearchAgentAction {
  const candidate = findActionCandidate(text);
  if (!candidate) throw new WebResearchAgentProtocolError("没有找到合法的 JSON 动作头");
  const tail = stripFenceClosingActionHeader(text, candidate);
  if (candidate.value.action === "search") {
    assertExactFields(candidate.value, ["action", "queries"]);
    const queries = parseActionStringArray(
      candidate.value.queries,
      "queries",
      WEB_RESEARCH_AGENT_MAX_SEARCH_QUERIES_PER_ACTION,
    );
    if (tail.trim()) throw new WebResearchAgentProtocolError("search 动作后不能包含额外内容");
    return { action: "search", queries };
  }
  if (candidate.value.action === "fetch") {
    assertExactFields(candidate.value, ["action", "urls"]);
    const urls = parseActionStringArray(
      candidate.value.urls,
      "urls",
      WEB_RESEARCH_AGENT_MAX_FETCH_URLS_PER_ACTION,
    );
    if (tail.trim()) throw new WebResearchAgentProtocolError("fetch 动作后不能包含额外内容");
    return { action: "fetch", urls };
  }
  assertExactFields(candidate.value, ["action"]);
  const markdown = tail.trim();
  if (!markdown) throw new WebResearchAgentProtocolError("finish 动作后必须包含非空 Markdown 正文");
  return { action: "finish", markdown };
}

export function buildWebResearchAgentInitialPrompt(input: {
  brief?: string;
  presentationTitle?: string;
  confirmedRequirementsText?: string;
  uploadedSourceAnalysisContext?: string;
  attachmentContext?: AttachmentContext | null;
  /** @deprecated retained for resume callers; title is read when provided. */
  outline?: { title: string; items?: Array<{ title: string }> };
  slideCount?: number | null;
  outputLanguage?: string | null;
  existingWebSummary: string;
  completedResearch?: {
    searches: Array<{ query: string; result: unknown; error?: string }>;
    fetchedPages: ResearchWebFetchPage[];
  };
  now?: Date;
}) {
  const completed = input.completedResearch;
  const uploadedSourceAnalysis = input.uploadedSourceAnalysisContext?.trim();
  const existingWebSummary = input.existingWebSummary.trim();
  const existingWebSummaryBody = existingWebSummary.replace(/^# Web Research Summary\s*/i, "").trim();
  const attachmentSection = formatUserProvidedAttachmentContextForPrompt(input.attachmentContext);
  const legacyDirections = input.outline && !input.brief && !input.presentationTitle && !input.confirmedRequirementsText
    ? input.outline.items?.map((item: any, index: number) => {
        const directions = item.research?.web?.directions;
        const suffix = Array.isArray(directions) && directions.length > 0
          ? `：${directions.join("；")}`
          : "";
        return `第 ${index + 1} 页《${item.title}》${suffix}`;
      }).join("\n")
    : "";
  return [
    "请根据以下 Brief、演示主题和结构化演示需求执行 Web 资料研究。",
    `当前日期（搜索资料截止日期）：${formatCurrentDateForPrompt(input.now)}`,
    `## 用户 Brief：\n\n${input.brief?.trim() || "（未提供）"}`,
    `## 演示主题：\n\n${input.presentationTitle?.trim() || input.outline?.title?.trim() || "（未提供）"}`,
    `## 结构化演示需求：\n\n${input.confirmedRequirementsText?.trim() || "（未提供）"}`,
    legacyDirections ? `## 逐页 Web 研究方向：\n\n${legacyDirections}` : "",
    uploadedSourceAnalysis ? `## 上传资料分析：\n\n${uploadedSourceAnalysis}` : "",
    ...(attachmentSection ? [attachmentSection] : []),
    `## 研究总结语言：\n\n${input.outputLanguage?.trim() || "使用演示文稿的输出语言"}`,
    existingWebSummaryBody ? `## 已有 Web 研究总结：\n\n${existingWebSummary}` : "",
    completed && (completed.searches.length > 0 || completed.fetchedPages.length > 0)
      ? [
          "## 本次研究已完成的动作（从中断检查点恢复）：",
          JSON.stringify(completed, null, 2),
          "不要重复这些动作。请在已有结果基础上继续研究。",
        ].join("\n\n")
      : "",
    "现在开始研究。",
    `这份研究将用于支持一套约 ${input.slideCount ?? "若干"} 页的演示文稿。你需要建立起足以支撑整套演示文稿的研究覆盖面。`,
  ].filter(Boolean).join("\n\n");
}

export function buildWebSearchResultPrompt(input: {
  searches: Array<{
    query: string;
    results?: ResearchWebSearchResult[];
    error?: string;
    cached?: boolean;
  }>;
}) {
  return [
    "search 批量执行完成。",
    ...input.searches.map((search) => [
      `${search.cached ? "已缓存 query" : "query"}：${search.query}`,
      search.error
        ? `执行结果：失败（${search.error}）`
        : `搜索结果：\n${JSON.stringify(search.results ?? [], null, 2)}`,
    ].join("\n")),
    "请根据这些统一返回的搜索结果决定下一步动作。",
  ].join("\n\n");
}

export function buildWebFetchResultPrompt(input: {
  pages: Array<{
    url: string;
    page?: ResearchWebFetchPage;
    error?: string;
    cached?: boolean;
  }>;
}) {
  return [
    "fetch 批量执行完成。",
    ...input.pages.map((item) => [
      `${item.cached ? "已缓存 URL" : "URL"}：${item.url}`,
      item.error
        ? `执行结果：失败（${item.error}）`
        : `网页结果：\n${JSON.stringify(item.page ?? { url: item.url, ok: false }, null, 2)}`,
    ].join("\n")),
    "请根据这些统一返回的网页结果决定下一步动作。",
  ].join("\n\n");
}

export function buildWebResearchProtocolRepairPrompt(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return `协议错误：${message}\n请只重新输出一个符合系统协议的当前动作。`;
}

/**
 * Sent once the research round budget is spent. The Session must summarize what
 * it already collected instead of losing the whole batch to a hard failure.
 */
export function buildWebResearchRoundLimitFinishPrompt(maxRounds: number) {
  return [
    `本次研究的轮次上限（${maxRounds} 轮）已经用尽，不能再执行 search 或 fetch。`,
    "现在你只能执行 finish 动作：先输出 {\"action\":\"finish\"}，换行后紧接最终 Markdown 正文。",
    "总结只能使用本次研究中已经获得的搜索结果和网页正文；没有覆盖到的问题在正文中明确写成缺口，不要编造事实、数据或来源。",
  ].join("\n");
}

export function buildWebResearchRoundLimitRepairPrompt(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return [
    `协议错误：${message}`,
    "研究轮次已经用尽，search 和 fetch 都不再被接受。",
    "请只输出 {\"action\":\"finish\"} 动作头，并在换行后给出最终 Markdown 总结。",
  ].join("\n");
}
