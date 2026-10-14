import type { PresentationRequirements } from "../api/types";
import type { OutlineAnalysis } from "../api/outlineTypes";
import type { OutlineDetail } from "../data/mockDeck";
import { formatConfirmedRequirementsForPrompt } from "./requirementsFormatting";
import { parseStructuredJson } from "./structuredJson";

export type OutlineAnalysisKind = "focus" | "ai-generated" | "research";

export interface AnalyzeOutlineInput {
  brief: string;
  requirements: PresentationRequirements;
  outline: OutlineDetail[];
  uploadedSourceAnalysisContext?: unknown;
}

function outlineText(outline: OutlineDetail[]): string {
  return JSON.stringify(outline.map((item) => ({
    title: item.title,
    content: item.content,
  })), null, 2);
}

function uploadedContext(value: unknown): string {
  if (typeof value === "string") return value.trim() || "null";
  return JSON.stringify(value ?? null);
}

function commonContext(input: AnalyzeOutlineInput): string[] {
  if (input.requirements.status !== "confirmed" || !input.requirements.source) {
    throw new Error("Confirmed Presentation Requirements are required for Outline Analysis.");
  }
  return [
    `输出语言：${input.requirements.selections.output_language ?? "使用已确认的演示输出语言"}`,
    "",
    "## 用户原始需求",
    input.brief,
    "",
    "## 已确认的演示需求",
    formatConfirmedRequirementsForPrompt(input.requirements),
    "",
    "## 上传资料分析上下文（JSON 或文本）",
    uploadedContext(input.uploadedSourceAnalysisContext),
    "",
    "## 已生成的大纲（JSON）",
    outlineText(input.outline),
  ];
}

export function buildOutlineFocusAnalysisRequest(input: AnalyzeOutlineInput) {
  return {
    messages: [
      {
        role: "system" as const,
        content: {
          type: "text" as const,
          text: [
            "你是 PPT 视觉编辑。请分析每一页应该如何安排视觉注意力，而不是复述页面内容重点。",
            "找出本页最应该被视觉强调的 1 至 3 个对象或信息，例如关键数字、百分比、日期、结论短语、对比关系、步骤节点或警示词。",
            "每页返回一句简洁、可执行的视觉重点说明，明确建议突出什么；例如“突出 30% 和 25% 两个权重数字，其余说明文字弱化”。不要重写整页内容，不要补充没有依据的事实。",
            '只返回 JSON：{"pages":[{"analysis":"..."}]}。pages 数量和顺序必须与输入大纲完全一致。',
            "analysis 必须是非空字符串，全部使用已确认的输出语言。",
          ].join("\n"),
        },
      },
      {
        role: "user" as const,
        content: { type: "text" as const, text: ["请分析每页的 PPT 视觉重点，指出需要在页面上重点突出显示的数字、短语、节点或关系。", ...commonContext(input)].join("\n") },
      },
    ],
  };
}

export function buildOutlineAiGeneratedAnalysisRequest(input: AnalyzeOutlineInput) {
  return {
    messages: [
      {
        role: "system" as const,
        content: {
          type: "text" as const,
          text: [
            "你是演示文稿 AI 幻觉检查编辑。请逐页核对大纲内容与用户原始需求、已确认演示需求及上传资料。",
            "找出不是来自这些原始内容、而是 AI 自行新增的事实、数字、日期、流程细节、因果关系、状态判断、材料解释或结论，列出具体内容并提示用户确认。",
            "不要总结页面内容，也不要把用户原始需求或上传资料中的原话列为幻觉。如果某页全部内容都有来源依据，返回“未发现需要用户确认的 AI 新增内容”。",
            '只返回 JSON：{"pages":[{"analysis":"..."}]}。pages 数量和顺序必须与输入大纲完全一致。',
            "analysis 必须是非空字符串，全部使用已确认的输出语言。",
          ].join("\n"),
        },
      },
      {
        role: "user" as const,
        content: { type: "text" as const, text: ["请进行每页的 AI 幻觉检查，列出需要用户确认的 AI 新增内容。", ...commonContext(input)].join("\n") },
      },
    ],
  };
}

export function buildOutlineResearchAnalysisRequest(input: AnalyzeOutlineInput) {
  const research = input.requirements.research ?? { web: { enabled: false }, images: { enabled: false } };
  const webEnabled = research.web.enabled === true;
  const imagesEnabled = research.images.enabled === true;
  return {
    messages: [
      {
        role: "system" as const,
        content: {
          type: "text" as const,
          text: [
            "你是演示文稿研究规划编辑。请判断大纲每一页是否需要新增 Web 搜索或图片搜索。",
            "Web 搜索和图片搜索开关只表示允许搜索，不表示每页都必须搜索；即使开关已开启，也必须根据当前页面内容逐页判断。",
            "只有缺少外部、当前或可验证事实时才建议 Web 搜索；只有确实需要真实世界视觉素材时才建议图片搜索。可选方向关闭时必须返回 false。",
            '只返回 JSON：{"pages":[{"web_needed":false,"web_analysis":"...","images_needed":false,"images_analysis":"..."}]}。pages 数量和顺序必须与输入大纲完全一致。',
            "web_analysis 和 images_analysis 必须是非空字符串；需要搜索时说明要查找的内容，不需要时说明原因。全部使用已确认的输出语言。",
            `Web 搜索当前${webEnabled ? "已开启" : "未开启"}；图片搜索当前${imagesEnabled ? "已开启" : "未开启"}。`,
          ].join("\n"),
        },
      },
      {
        role: "user" as const,
        content: { type: "text" as const, text: ["请根据每页当前内容逐页分析 Web / 图片搜索需求；搜索开关开启也不代表每页都需要搜索。", ...commonContext(input)].join("\n") },
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPages(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!isRecord(value) || !Array.isArray(value.pages) || value.pages.length === 0) {
    throw new Error(`${label} 必须返回包含非空 pages 数组的 JSON 对象。`);
  }
  return value.pages.map((page, index) => {
    if (!isRecord(page)) throw new Error(`${label}.pages[${index}] 必须是对象。`);
    return page;
  });
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串。`);
  return value.trim();
}

export function parseOutlineFocusAnalysis(text: string, expectedPages: number): string[] {
  const pages = readPages(parseStructuredJson(text), "重点分析");
  if (pages.length !== expectedPages) throw new Error(`重点分析返回了 ${pages.length} 页，预期为 ${expectedPages} 页。`);
  return pages.map((page, index) => readString(page.analysis, `重点分析.pages[${index}].analysis`));
}

export function parseOutlineAiGeneratedAnalysis(text: string, expectedPages: number): string[] {
  const pages = readPages(parseStructuredJson(text), "AI 幻觉检查");
  if (pages.length !== expectedPages) throw new Error(`AI 幻觉检查返回了 ${pages.length} 页，预期为 ${expectedPages} 页。`);
  return pages.map((page, index) => readString(page.analysis, `AI 幻觉检查.pages[${index}].analysis`));
}

interface ResearchAnalysisPage {
  web_needed: boolean;
  web_analysis: string;
  images_needed: boolean;
  images_analysis: string;
}

export function parseOutlineResearchAnalysis(text: string, expectedPages: number): ResearchAnalysisPage[] {
  const pages = readPages(parseStructuredJson(text), "研究需求分析");
  if (pages.length !== expectedPages) throw new Error(`研究需求分析返回了 ${pages.length} 页，预期为 ${expectedPages} 页。`);
  return pages.map((page, index) => {
    if (typeof page.web_needed !== "boolean") throw new Error(`研究需求分析.pages[${index}].web_needed 必须是布尔值。`);
    if (typeof page.images_needed !== "boolean") throw new Error(`研究需求分析.pages[${index}].images_needed 必须是布尔值。`);
    return {
      web_needed: page.web_needed,
      web_analysis: readString(page.web_analysis, `研究需求分析.pages[${index}].web_analysis`),
      images_needed: page.images_needed,
      images_analysis: readString(page.images_analysis, `研究需求分析.pages[${index}].images_analysis`),
    };
  });
}

export function applyOutlineAnalysis(
  outline: OutlineDetail[],
  focus: string[],
  aiGenerated: string[],
  research: ResearchAnalysisPage[],
  requirements: PresentationRequirements,
): OutlineDetail[] {
  if (focus.length !== outline.length || aiGenerated.length !== outline.length || research.length !== outline.length) {
    throw new Error("Outline analysis result page counts do not match the outline.");
  }
  const researchChoices = requirements.research ?? { web: { enabled: false }, images: { enabled: false } };
  return outline.map((item, index) => {
    const pageResearch = research[index]!;
    const webNeeded = researchChoices.web.enabled === true && pageResearch.web_needed;
    const imagesNeeded = researchChoices.images.enabled === true && pageResearch.images_needed;
    return {
      ...item,
      analysis: {
        focus: focus[index]!,
        ai_generated_content: aiGenerated[index]!,
        web_needed: webNeeded,
        web_analysis: pageResearch.web_analysis,
        images_needed: imagesNeeded,
        images_analysis: pageResearch.images_analysis,
      } satisfies OutlineAnalysis,
      research: {
        web: webNeeded
          ? { directions: [pageResearch.web_analysis], reason: pageResearch.web_analysis }
          : null,
        images: imagesNeeded
          ? { directions: [pageResearch.images_analysis], reason: pageResearch.images_analysis }
          : null,
      },
    };
  });
}

export type OutlineAnalysisPage = ResearchAnalysisPage;
