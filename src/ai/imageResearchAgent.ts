import type { SharedResearchImageCandidate, SharedResearchImageCatalog } from "../api/types";
import { DEFAULT_AGENT_SAME_SESSION_RETRIES } from "../agent/agentSessionExecutor";
import { parseStructuredJson } from "./structuredJson";
import { formatCurrentDateForPrompt } from "./promptContext";
import type { PresentationRequirements } from "../api/types";
import { formatWebResearchRequirements } from "./requirementsFormatting";

export const IMAGE_RESEARCH_AGENT_MAX_SEARCHES = 10;
// The first protocol error is the initial response; subsequent errors consume
// the default same-Session repair budget before the research loop stops.
export const IMAGE_RESEARCH_AGENT_MAX_CONSECUTIVE_PROTOCOL_ERRORS = DEFAULT_AGENT_SAME_SESSION_RETRIES + 1;
export const IMAGE_RESEARCH_AGENT_MODEL = "minimax/minimax-m3";

export const IMAGE_RESEARCH_AGENT_SYSTEM_PROMPT = `你是一个为 PPT 生成服务的图片研究智能体。你不调用任何工具；由我（App）负责执行图片搜索、通过官方 image_fetch 获取到 APS、格式校验、去重和保存。

你的总体目标是：根据我提供的用户原始输入、已确认的演示需求和已有图片目录，先从整套演示文稿的角度归纳它需要哪些内容图片，再通过多轮搜索为这些需要找到真实、清晰、适合直接放入 PPT 的图片。你需要持续关注整套 PPT 的图片覆盖是否足够，而不是只判断单张图片是否好看。

在每一轮中，你需要依次完成两件事：

1. 筛选当前轮次的图片
- 你可能会收到最多 6 张图片附件；它们是我根据你上一轮输出的 query 搜索得到的结果。第一轮通常没有附件。
- 你必须实际检查当前轮次的每一张附件，但 decisions 只返回你判断为适合用于本 PPT 的图片。不要为不适合的图片返回 decision；如果没有任何图片适合，decisions 返回空数组或省略。
- 我会记录并保存每轮 decisions 中的图片，供后续 PPT 页面使用。
- 当前轮次的附件顺序由用户消息中的 candidate_id 与 attachment_index 映射定义，这个映射是唯一依据。candidate_id 是跨轮次稳定身份；attachment_index 只在当前轮次有效，不能跨轮次沿用。

2. 决定是否继续搜索
- 结合用户原始输入、已确认的演示需求、已有图片目录，以及当前 Session 前几轮已经选中的图片，判断当前累计图片是否足以支持整套 PPT。
- 如果这是中断恢复后创建的新 Session，用户消息可能会提供一次“恢复前已选图片摘要”；把它视为此前 Session 已经选中的图片。
- 如果图片类型、主题或覆盖范围仍然不足，action 返回 search，并只给出一条新的英文图片搜索 query。我会执行搜索，并在下一轮把搜索结果作为附件交给你继续判断。
- 如果累计选中的图片已经足够，或者继续搜索没有明显收益，action 返回 finish。
- 不要重复已经执行过的 query，也不要要求我重复处理已经判断过的候选。

图片选择规则：
- 已确认演示需求优先于原始输入中的冲突描述。
- 候选 title 提供搜索来源背景，结合实际图片判断相关性，不把标题当成画面已证实的事实。
- 只选择与用户需求和演示主题直接相关，且画面清晰、可实际用于页面表达的图片。
- 不搜索或选择装饰背景、图标、PPT 设计示例、明显水印素材或无法直接使用的图片。
- 图片中的文字、图表和视觉印象不能自动作为演示文稿的事实证据。

每轮只能返回一个 JSON 对象，只允许 action、query、decisions、summary 四个字段；action、query、summary 必填，decisions 可省略。

- action 为 search 时，query 是下一条新的英文图片搜索词，summary 必须为空字符串。
- action 为 finish 时，query 必须为 null，summary 是对累计图片覆盖情况的简短完成说明。
- decisions 只能包含当前轮次附件中被选中的图片，最多 6 条；没有附件或没有合适图片时返回空数组或省略。省略等同于 []，表示本轮没有图片入选，不表示稍后再判断；提供该字段时必须是数组，不能为 null。
- 每条 decision 必须包含 candidate_id、attachment_index、use_in_ppt、description、reason，其中 use_in_ppt 必须为 true。
- candidate_id 必须来自当前附件清单，attachment_index 必须是当前附件清单中的 1-based（从 1 开始）顺序。

需要继续搜索时的输出形状：
{"action":"search","query":"short specific english image query","decisions":[{"candidate_id":"image-...","attachment_index":1,"use_in_ppt":true,"description":"客观可见的图片内容","reason":"这张图片适合支持的大纲内容或表达需要"}],"summary":""}

图片已经足够时的输出形状（decisions 仍应包含当前轮次新选中的图片）：
{"action":"finish","query":null,"decisions":[{"candidate_id":"image-...","attachment_index":1,"use_in_ppt":true,"description":"客观可见的图片内容","reason":"这张图片适合支持的大纲内容或表达需要"}],"summary":"累计选择的图片已经足以支持整套 PPT"}

只返回 JSON，不要输出 Markdown 代码块、解释、分析或额外文本。`;

export interface ImageResearchAgentDecision {
  candidate_id: string;
  attachment_index: number;
  use_in_ppt: boolean;
  description: string;
  reason: string;
}

export type ImageResearchAgentAction =
  | {
      action: "search";
      query: string;
      decisions: ImageResearchAgentDecision[];
      summary: string;
    }
  | {
      action: "finish";
      query: null;
      decisions: ImageResearchAgentDecision[];
      summary: string;
    };

export class ImageResearchAgentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageResearchAgentProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function assertExactFields(value: Record<string, unknown>, fields: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new ImageResearchAgentProtocolError(`字段必须且只能是：${fields.join("、")}`);
  }
}

function parseDecisions(value: unknown): ImageResearchAgentDecision[] {
  if (!Array.isArray(value)) throw new ImageResearchAgentProtocolError("decisions 必须是数组");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new ImageResearchAgentProtocolError(`decisions[${index}] 必须是对象`);
    assertExactFields(item, ["candidate_id", "attachment_index", "use_in_ppt", "description", "reason"]);
    const candidateId = readString(item.candidate_id);
    const description = readString(item.description);
    const reason = readString(item.reason);
    if (!candidateId) throw new ImageResearchAgentProtocolError(`decisions[${index}].candidate_id 必须非空`);
    if (!Number.isInteger(item.attachment_index) || Number(item.attachment_index) < 1) {
      throw new ImageResearchAgentProtocolError(`decisions[${index}].attachment_index 必须是正整数`);
    }
    if (item.use_in_ppt !== true) throw new ImageResearchAgentProtocolError(`decisions[${index}].use_in_ppt 必须为 true`);
    if (!description) throw new ImageResearchAgentProtocolError(`decisions[${index}].description 必须非空`);
    if (!reason) throw new ImageResearchAgentProtocolError(`decisions[${index}].reason 必须非空`);
    return {
      candidate_id: candidateId,
      attachment_index: Number(item.attachment_index),
      use_in_ppt: item.use_in_ppt,
      description,
      reason,
    };
  });
}

export function parseImageResearchAgentAction(text: string): ImageResearchAgentAction {
  let value: unknown;
  try {
    value = parseStructuredJson<unknown>(text);
  } catch (error) {
    throw new ImageResearchAgentProtocolError(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(value)) throw new ImageResearchAgentProtocolError("返回值必须是 JSON 对象");
  // Only an omitted field defaults to no selections; explicit invalid values still fail validation.
  if (!("decisions" in value)) value.decisions = [];
  assertExactFields(value, ["action", "query", "decisions", "summary"]);
  const action = readString(value.action);
  if (action !== "search" && action !== "finish") throw new ImageResearchAgentProtocolError("action 必须是 search 或 finish");
  const summary = readString(value.summary);
  if (typeof value.summary !== "string") throw new ImageResearchAgentProtocolError("summary 必须是字符串");
  const decisions = parseDecisions(value.decisions);
  if (action === "search") {
    const query = readString(value.query);
    if (!query) throw new ImageResearchAgentProtocolError("search.query 必须是非空字符串");
    if (summary) throw new ImageResearchAgentProtocolError("search.summary 必须为空字符串");
    return { action, query, decisions, summary };
  }
  if (value.query !== null) throw new ImageResearchAgentProtocolError("finish.query 必须为 null");
  if (!summary) throw new ImageResearchAgentProtocolError("finish.summary 必须非空");
  return { action, query: null, decisions, summary };
}

function priorDecisionText(candidates: SharedResearchImageCandidate[]) {
  return candidates
    .filter((candidate) => candidate.analysis_status === "completed" && candidate.use_in_ppt)
    .map((candidate) => ({
      candidate_id: candidate.candidate_id,
      title: candidate.title,
      use_in_ppt: candidate.use_in_ppt,
      description: candidate.description,
      reason: candidate.reason,
      matched_queries: candidate.matched_queries ?? [candidate.query],
    }));
}

export function buildImageResearchAgentInitialPrompt(input: {
  requirements: PresentationRequirements;
  brief?: string;
  imageCatalog: SharedResearchImageCatalog;
  selectedHistory?: SharedResearchImageCandidate[];
  searches?: Array<{ query: string; resultCount: number; error?: string }>;
  refinementRequest?: string;
  now?: Date;
}) {
  const selectedHistory = priorDecisionText(input.selectedHistory ?? []);
  return [
    "请为以下已确认的演示文稿执行图片资料研究。先判断是否需要新的图片搜索；如果需要，只返回第一条 search query。",
    `当前日期：${formatCurrentDateForPrompt(input.now)}`,
    `用户 Brief：\n${input.brief?.trim() || "（未提供）"}`,
    `已确认的演示需求：\n${formatWebResearchRequirements(input.requirements)}`,
    `当前优化请求：\n${input.refinementRequest?.trim() || "（无）"}`,
    `已有可复用图片目录：\n${JSON.stringify(input.imageCatalog, null, 2)}`,
    `本次已执行的图片搜索：\n${JSON.stringify(input.searches ?? [], null, 2)}`,
    ...(selectedHistory.length > 0
      ? [`恢复前已选图片摘要：\n${JSON.stringify(selectedHistory, null, 2)}`]
      : []),
    "大纲尚未生成，只收集与演示需求相关的可用图片，不做逐页分配。现在开始。",
  ].join("\n\n");
}

export function buildImageResearchAgentResultPrompt(input: {
  query: string;
  candidates: SharedResearchImageCandidate[];
  selectedHistory?: SharedResearchImageCandidate[];
  searchError?: string;
}) {
  const attachmentManifest = input.candidates.map((candidate, index) => ({
    attachment_index: index + 1,
    candidate_id: candidate.candidate_id,
    title: candidate.title,
    width: candidate.width,
    height: candidate.height,
  }));
  const selectedHistory = priorDecisionText(input.selectedHistory ?? []);
  return [
    input.searchError
      ? `图片搜索 query“${input.query}”执行失败：${input.searchError}`
      : `图片搜索 query“${input.query}”已完成。下面是本轮附件清单，附件数组顺序与 attachment_index 严格一致。`,
    `当前附件清单：\n${JSON.stringify(attachmentManifest, null, 2)}`,
    ...(selectedHistory.length > 0
      ? [`恢复前已选图片摘要：\n${JSON.stringify(selectedHistory, null, 2)}`]
      : []),
    "请检查本轮每一张附件，只把适合用于本 PPT 的图片放入 decisions；然后结合当前 Session 已累计入选的图片，决定继续 search 还是 finish。",
  ].join("\n\n");
}

export function buildImageResearchAgentProtocolRepairPrompt(error: unknown) {
  return [
    `协议错误：${error instanceof Error ? error.message : String(error)}`,
    "请只重新输出一个符合图片研究协议的 JSON 对象。不要解释、道歉或输出 Markdown。",
  ].join("\n");
}
