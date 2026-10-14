import { pickLocale } from "../i18n/locales";
import {
  initialDeck,
  outlineDetailToText,
  outlineDetails,
  type OutlineDetail,
  type Slide
} from "../data/mockDeck";
import { sleep } from "../features/deck-workspace/utils";
import {
  buildGenerateOutlineLlmRequest,
  buildReviseOutlineLlmRequest,
} from "./outlinePrompt";
import { validateGeneratedOutline, validateRevisedOutline } from "./outlineParser";
import type { OutlineAnalysis } from "../api/outlineTypes";
import type {
  AiClient,
  DeckRefinementPlan,
  DeckRefinementOutlineOperation,
  GenerateDeckInput,
  GenerateOutlineInput,
  GenerateSlidesFromOutlineInput,
  RefineDeckInput,
  RefineSlideInput,
  ReviseOutlineInput
} from "./types";
import type { AiOperationLogContext } from "./interactionLog";
import { inferVisualStylePresetRecommendationIntentFromRules } from "../features/templates/visualStylePresetRecommendation";

async function logMockInteraction(
  logContext: AiOperationLogContext | undefined,
  request: unknown,
  response: unknown
) {
  if (!logContext?.logger) return;
  const context = {
    ...logContext,
    provider: "mock",
    runtime_mode: "mock",
  };
  const handle = await logContext.logger.startInteraction(context, { request });
  await logContext.logger.finishInteraction(handle, {
    status: "succeeded",
    response,
    output: typeof response === "string" ? response : JSON.stringify(response),
    model: "mock",
    token_source: "llm",
  });
}

function cloneOutline(outline: OutlineDetail[]): OutlineDetail[] {
  return outline.map((item) => ({
    ...item,
    ...(item.title_segments ? { title_segments: item.title_segments.map((segment) => ({ ...segment })) } : {}),
    ...(item.research ? { research: structuredClone(item.research) } : {}),
    ...(item.analysis ? { analysis: { ...item.analysis } } : {}),
  }));
}

function toMockLlmPage(
  item: OutlineDetail,
  _requirements: GenerateOutlineInput["requirements"],
) {
  return {
    page_type: item.page_type,
    title: item.title,
    generation_notes: "",
    ...(item.creation_requirements ? { creation_requirements: item.creation_requirements } : {}),
    content: outlineDetailToText(item),
  };
}

function mockOutlineAnalysis(
  item: OutlineDetail,
  requirements: GenerateOutlineInput["requirements"],
): OutlineAnalysis {
  const content = outlineDetailToText(item);
  const firstLine = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || item.title;
  const chinese = requirements.selections.output_language === "中文";
  const research = requirements.research ?? { web: { enabled: false }, images: { enabled: false } };
  const webRelevant = /(数据|数字|比例|百分比|日期|截止|市场|法规|政策|官方|排名|引用|最新|202\d|%|data|date|deadline|market|regulation|policy|official|latest)/iu.test(`${item.title}\n${content}`);
  const imagesRelevant = /(图片|照片|场景|人物|产品|地点|地图|界面|实物|image|photo|scene|person|product|map|screenshot)/iu.test(`${item.title}\n${content}`);
  const webNeeded = research.web.enabled === true && webRelevant;
  const imagesNeeded = research.images.enabled === true && imagesRelevant;
  return {
    focus: chinese
      ? `视觉上突出“${firstLine}”，可通过更大字号、强调色或独立视觉层级呈现。`
      : `Visually emphasize “${firstLine}” with larger type, accent color, or a distinct visual hierarchy.`,
    ai_generated_content: chinese
      ? "未发现需要用户确认的 AI 新增内容。"
      : "No AI-added content requiring user confirmation was found.",
    web_needed: webNeeded,
    web_analysis: chinese
      ? (webNeeded ? "可补充与本页判断直接相关、可验证的外部事实。" : research.web.enabled ? "本页当前内容不需要新增 Web 搜索。" : "当前未开启 Web 搜索。")
      : (webNeeded ? "Look for verifiable external facts directly supporting this page." : research.web.enabled ? "This page does not need additional Web search." : "Web search is disabled for this presentation."),
    images_needed: imagesNeeded,
    images_analysis: chinese
      ? (imagesNeeded ? "可寻找与本页主题直接相关的真实场景或产品视觉素材。" : research.images.enabled ? "本页当前内容不需要新增图片搜索。" : "当前未开启图片搜索。")
      : (imagesNeeded ? "Look for real-world visual assets directly related to this page." : research.images.enabled ? "This page does not need additional image search." : "Image search is disabled for this presentation."),
  };
}

function applyMockOutlineAnalysis(
  items: OutlineDetail[],
  requirements: GenerateOutlineInput["requirements"],
): OutlineDetail[] {
  return items.map((item) => {
    const analysis = mockOutlineAnalysis(item, requirements);
    const research = {
      web: analysis.web_needed ? { directions: [analysis.web_analysis], reason: analysis.web_analysis } : null,
      images: analysis.images_needed ? { directions: [analysis.images_analysis], reason: analysis.images_analysis } : null,
    };
    return { ...item, analysis, research };
  });
}

function cloneSlides(slides: Slide[]): Slide[] {
  return slides.map((slide) => ({ ...slide }));
}

function fitOutlineCount(outline: OutlineDetail[], count: number | null): OutlineDetail[] {
  if (count === null || count === outline.length) {
    return cloneOutline(outline);
  }

  if (count < outline.length) {
    return cloneOutline(outline.slice(0, count));
  }

  const next = cloneOutline(outline);
  while (next.length < count) {
    next.push({
      page_type: "standard",
      title: `Supporting Point ${next.length + 1}`,
      content: "Add one clear takeaway, and connect it to the surrounding storyline.",
    });
  }
  return next;
}

function inferMockOutputLanguage(brief: string): string {
  const latinLetters = (brief.match(/[A-Za-z]/g) ?? []).length;
  const cjkCharacters = (brief.match(/[\u3400-\u9fff]/g) ?? []).length;
  return cjkCharacters > latinLetters ? "中文" : "English";
}

export function createMockAiClient(): AiClient {
  return {
    async detectOutputLanguage(input) {
      await sleep(120);
      const result = { output_language: inferMockOutputLanguage(input.brief) };
      await logMockInteraction(
        input.logContext,
        { method: "detectOutputLanguage", brief: input.brief },
        result,
      );
      return result;
    },

    async generatePresentationRequirements(input) {
      await sleep(700);
      const result = { slide_count: [8] };
      await logMockInteraction(
        input.logContext,
        { method: "generatePresentationRequirements", brief: input.brief },
        result,
      );
      return result;
    },

    async analyzeVisualStylePresetRecommendationIntent(input) {
      const intent = inferVisualStylePresetRecommendationIntentFromRules(input.brief);
      await logMockInteraction(
        input.logContext,
        { method: "analyzeVisualStylePresetRecommendationIntent", brief: input.brief },
        intent,
      );
      return {
        intent,
        attempts: [{
          attempt: 1,
          status: "success",
          request: { messages: [] },
          request_hash: "mock-template-intent",
          errors: [],
          will_retry: false,
        }],
      };
    },

    async selectVisualStylePresetColor(input) {
      await sleep(120);
      const color = input.colors[0];
      await logMockInteraction(input.logContext, { method: "selectVisualStylePresetColor", input }, { color });
      return color;
    },

    async selectVisualStylePreset(input) {
      await sleep(120);
      const presetId = input.candidates[0]?.id;
      if (!presetId) throw new Error("Mock visual style preset candidates are empty");
      await logMockInteraction(input.logContext, { method: "selectVisualStylePreset", input }, { preset_id: presetId });
      return presetId;
    },

    async selectDominantAestheticReference(input) {
      await sleep(80);
      const selectedPath = input.candidates[0]?.path;
      if (!selectedPath) throw new Error("Mock aesthetic reference candidates are empty");
      await logMockInteraction(input.logContext, { method: "selectDominantAestheticReference", input }, { path: selectedPath });
      return selectedPath;
    },

    async generateOutline(input) {
      await sleep(900);
      const llmRequest = buildGenerateOutlineLlmRequest(input);
      const expectedSlideCount = input.requirements.selections.slide_count;
      const usesChinese = input.requirements.selections.output_language === "中文";
      const rawOutline = {
        global_creation_requirements: "",
        title: usesChinese ? "AI Agent 工作流" : "AI Agent Workflows",
        items: fitOutlineCount(outlineDetails, expectedSlideCount).map((item) => toMockLlmPage(item, input.requirements)),
      };
      const llmRawResponse = {
        content: {
          type: "text",
          text: JSON.stringify(rawOutline),
        },
        model: "mock",
      };
      await logMockInteraction(input.logContext, llmRequest, llmRawResponse);
      const outline = validateGeneratedOutline(rawOutline);
      return {
        outline,
        attempts: [
          {
            operation: "generateOutline",
            attempt: 1,
            status: "success",
            transport: "llm",
            llmRequest,
            llmRawResponse,
            validation: {
              ok: true,
              errors: [],
            },
          },
        ],
      };
    },

    async analyzeOutline(input) {
      await sleep(160);
      return {
        items: input.outline.map((item) => mockOutlineAnalysis(item, input.requirements)),
      };
    },

    async generateThemeToken(input) {
      await sleep(120);
      const result = input.themeContext.default_token;
      await logMockInteraction(input.logContext, { method: "generateThemeToken", input }, result);
      return result;
    },

    async generateWorkspaceStyleGuide(input) {
      await sleep(120);
      const markdown = `# 艺术指导\n\n## 视觉概念\n以清晰、克制、适合屏幕演示的编辑设计为主。\n\n## 色彩\n- 背景：#F7F8FA\n- 主文字：#172033\n- 强调色：#2563EB\n- 辅助色：#14B8A6\n\n## 字体与层级\n优先使用 Arial、Helvetica、PingFang SC、Microsoft YaHei 等常见系统字体。页面标题 42–52px，核心数字 56–72px，正文 22–28px，注释不小于 16px。\n\n## 版式\n使用明确网格、充足留白和强对齐；每页只突出一个核心信息。画布固定为 1280 × 720。\n\n## 内容依据\n演示标题：${input.outline.title}`;
      await logMockInteraction(input.logContext, { method: "generateWorkspaceStyleGuide", input }, markdown);
      return markdown;
    },

    async generateVisualRhythm(input) {
      await sleep(120);
      const markdown = `# Deck Visual Rhythm\n\n- Deck: ${input.outline.title}\n- Vary focal composition, density, brightness, and reading direction across adjacent pages.\n- Keep the opening sparse, evidence pages structured, and the closing page decisive.`;
      await logMockInteraction(input.logContext, { method: "generateVisualRhythm", input }, markdown);
      return markdown;
    },

    async generatePageVisualPlan(input) {
      await sleep(120);
      const page = input.outline.items[input.pageIndex];
      const markdown = `# Page Visual Plan\n\n- page_id: \`${input.pageId}\`\n- Page: ${input.pageIndex + 1} / ${input.outline.items.length}\n\n## Page task and core conclusion\n\n- ${page?.title ?? input.pageId}: preserve the confirmed page intent.\n\n## Visual concept\n\nUse one dominant focal composition that supports the page conclusion and differs from adjacent pages.\n\n## Composition\n\nUse the Workspace Style Guide and Deck Visual Rhythm as shared authorities.`;
      await logMockInteraction(input.logContext, { method: "generatePageVisualPlan", input }, markdown);
      return markdown;
    },


    async planDeckRefinement(input) {
      await sleep(250);
      const lower = input.instruction.toLowerCase();
      const wantsNoOp = /no.?op|不用改|无需|没变化/.test(lower);
      const wantsThemeChange = /theme|palette|brand|color|dark|light|主题|配色|品牌色|深色|浅色|视觉风格/.test(lower);
      const wantsEnglish = /english|英文|英语/.test(lower);
      const wantsChinese = /中文|chinese|汉语/.test(lower);
      const wantsAdd = /add|增加|新增|加一页|加页/.test(lower);
      const wantsDelete = /delete|remove|删除|删掉|去掉/.test(lower);
      const wantsGlobalRewrite = /audience|style|受众|风格|表达|统一/.test(lower);
      const wantsUpdate = /update|rewrite|优化|调整|改/.test(lower);
      const wantsPersistentRevision = /header|footer|page number|页眉|页脚|页码|持续装饰/.test(lower);

      const result: DeckRefinementPlan = wantsNoOp
          ? {
              route: "no_op" as const,
              title: input.outline.title,
              output_language_change: { changed: false },
              style_guide_change: { action: "preserve", reason: "No shared visual change." },
              visual_rhythm_action: "preserve",
              persistent_elements_action: "preserve",
              operations: [],
              reason: "Mock no-op Deck Refinement.",
            }
          : {
              route: "proceed" as const,
              title: input.outline.title,
              output_language_change: {
                changed: wantsEnglish || wantsChinese,
                output_language: wantsEnglish ? "English" : wantsChinese ? "中文" : "",
                reason: wantsEnglish || wantsChinese ? "Mock explicit output language change." : "",
              },
              style_guide_change: {
                action: wantsThemeChange ? "regenerate" : "preserve",
                reason: wantsThemeChange ? "Mock explicit shared visual change." : "Preserve current shared direction.",
              },
              visual_rhythm_action: wantsGlobalRewrite ? "rewrite" : "preserve",
              persistent_elements_action: wantsPersistentRevision ? "revise" : "preserve",
              operations: input.outline.items.flatMap((page, index): DeckRefinementOutlineOperation[] => {
                if (wantsDelete && index === input.outline.items.length - 1) {
                  return [{ op: "delete" as const, page_id: page.page_id!, reason: "Mock delete last page." }];
                }
                const shouldUpdate = wantsEnglish || wantsChinese || wantsGlobalRewrite || (wantsUpdate && index === Math.min(1, input.outline.items.length - 1));
                const base = shouldUpdate
                  ? {
                      op: "update" as const,
                      page_id: page.page_id!,
                      page_type: page.page_type,
                      title: page.title.includes("Updated") ? page.title : `${page.title} Updated`,
                      content: page.content,
                      reason: wantsGlobalRewrite ? "Mock explicit whole-deck rewrite." : "Mock update page intent.",
                    }
                  : { op: "keep" as const, page_id: page.page_id!, reason: "Mock keep page." };
                if (wantsAdd && index === input.outline.items.length - 1) {
                  return [
                    base,
                    {
                      op: "add" as const,
                      page_type: "standard" as const,
                      title: pickLocale(input.locale, { zh: "新增补充页", en: "Additional Supporting Page", ja: "追加の補足ページ", de: "Zusätzliche ergänzende Seite" }),
                      content: input.instruction,
                      reason: "Mock add page.",
                    },
                  ];
                }
                return [base];
              }),
              reason: "Mock Deck Refinement proceed.",
            };
      await logMockInteraction(input.logContext, { method: "planDeckRefinement", input }, result);
      return {
        plan: result,
        attempts: [{
          attempt: 1,
          status: "success" as const,
          llmRequest: { messages: [] },
          llmRawResponse: result,
          validation: { ok: true, errors: [] },
        }],
      };
    },

    async generateDeck(input: GenerateDeckInput) {
      await sleep(input.outlineFirst ? 900 : 1100);
      const deck = {
        title: pickLocale(input.locale, { zh: "AI Agent 工作流", en: "AI Agent Workflows", ja: "AI エージェントワークフロー", de: "AI-Agent-Workflows" }),
        outline: cloneOutline(outlineDetails),
        slides: cloneSlides(initialDeck)
      };
      await logMockInteraction(input.logContext, { method: "generateDeck", input }, deck);
      return deck;
    },

    async reviseOutline(input: ReviseOutlineInput) {
      await sleep(700);
      const llmRequest = buildReviseOutlineLlmRequest(input);
      const revisedItems = !input.feedback.trim()
        ? cloneOutline(input.outline)
        : cloneOutline(input.outline).map((item, index) =>
            index === 5
              ? { ...item, title: "Security Boundaries for Real Action" }
              : { ...item }
          );
      const rawOutline = {
        global_creation_requirements: input.global_creation_requirements ?? "",
        title: input.title || "AI Agent Workflows",
        items: revisedItems.map((item) => toMockLlmPage(item, input.requirements)),
      };
      const llmRawResponse = {
        content: {
          type: "text",
          text: JSON.stringify(rawOutline),
        },
        model: "mock",
      };
      await logMockInteraction(input.logContext, llmRequest, llmRawResponse);
      const outline = validateRevisedOutline(rawOutline);

      return {
        outline,
        attempts: [
          {
            operation: "reviseOutline",
            attempt: 1,
            status: "success",
            transport: "llm",
            llmRequest,
            llmRawResponse,
            validation: {
              ok: true,
              errors: [],
            },
          },
        ],
      };
    },

    async generateSlidesFromOutline(input: GenerateSlidesFromOutlineInput) {
      await sleep(1200);
      const slides = input.outline.map((item) => ({
        title: item.title,
        subtitle: outlineDetailToText(item)
      }));
      await logMockInteraction(input.logContext, { method: "generateSlidesFromOutline", input }, slides);
      return slides;
    },

    async refineDeck(input: RefineDeckInput) {
      await sleep(1600);
      const slides = input.slides.map((slide) => ({
        ...slide,
        title: slide.title.includes("Refined")
          ? slide.title
          : `${slide.title} (Refined)`
      }));
      await logMockInteraction(input.logContext, { method: "refineDeck", input }, slides);
      return slides;
    },

    async refineSlide(input: RefineSlideInput) {
      await sleep(1200);
      const slide = {
        ...input.slide,
        title: input.slide.title.includes("Updated")
          ? input.slide.title
          : `${input.slide.title} (Updated)`
      };
      await logMockInteraction(input.logContext, { method: "refineSlide", input }, slide);
      return slide;
    }
  };
}
