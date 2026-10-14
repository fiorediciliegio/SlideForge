import { creationRequirementsPrompt } from "../../ai/creationRequirementsPrompt";
import { slideFormat, type SlideAspectRatio } from "../../slideFormat";
import { resolveOutlineImage, type OutlineImageAsset } from "../outline/images";
import type {
  PresentationRequirements,
  WorkspaceOutline,
} from "../../api/types";
import type { AuthoringPage } from "./types";
import type { PreparedPageImages } from "./pageImageAttachments";

function deckDescription(input: { requirements: PresentationRequirements; outline: WorkspaceOutline }) {
  const selections = input.requirements.selections;
  const { width, height, aspectRatio } = slideFormat(selections.aspect_ratio);
  return [
    `用户输入：${input.requirements.source?.brief ?? ""}`,
    `主题：${input.outline.title}`,
    `语言：${selections.output_language ?? "中文"}`,
    `预计页数：${input.outline.items.length} 页`,
    `画布：${width} × ${height}，${aspectRatio}`,
  ].join("\n");
}

export function buildVisualMasterHtmlPrompt(input: { requirements: PresentationRequirements; outline: WorkspaceOutline; referenceHtml: string }) {
  const { width, height } = slideFormat(input.requirements.selections.aspect_ratio);
  return [
    "你是一名HTML视觉总监。现在需要你根据我提供的参考 HTML，提炼其最有代表性的美观风格，生成一份供多页 HTML 共同使用的全局视觉母版。",
    "", "## HTML 简要描述", "这份多页 HTML 需求如下：", deckDescription(input),
    ...creationRequirementsPrompt(input.outline.global_creation_requirements),
    "", "## 输出要求",
    "只输出一个完整、可运行的 HTML 文件，不要输出文字规范、分析过程、设计理由、Markdown 代码块或其他说明。",
    "HTML 必须简洁，并包含：",
    `- 固定为 ${width}×${height} 的 .slide 根容器`,
    "- 参考 HTML 只提供美学风格；必须按目标画布重新组织布局，不得沿用参考页的尺寸或拉伸整页。",
    "- 使用 `:root` 定义的全局视觉变量",
    "- 最多四种字体", "- 最多六种颜色", "- 最多五级字号",
    "- 固定背景及必要的背景装饰", "- 固定页眉", "- 固定页面标题区域",
    "- 可编辑的主内容区域", "- 固定页脚和页码",
    "使用以下占位符：", "- `{{PAGE_CONTENT}}`", "- `{{PAGE_TITLE}}`" ,
    "固定区域添加 `data-fixed=\"true\"`。" , "字号不要过小，要让观众能够看清，主要正文字号最低不应小于20px,次级解释文字最低不应小于18px",
    "页码区域必须使用具体数字展示最终格式，例如 08 或者 08/10 或者用户输入的页面具体要求（如果有），禁止使用 PAGE_NUM、{{PAGE_NUMBER}} 等页码占位符。",
    "禁止生成面向具体内容结构的预设组件，包括但不限于：.card、.card-grid、.badge、.tag、.timeline、.chart、.table、.metric、.kpi、.quote、.step、.process、.comparison、.hero、.image-panel、.profile、.ranking 等。",
    "最终 HTML 尽量控制在 80 行以内。", "",
    "", "## 参考 HTML", input.referenceHtml, "",
    "不要写磁盘上的文件，直接输出 HTML 给我，不要返回除了 HTML 外任何内容，也不要用代码块包裹 HTML。",
  ].join("\n");
}

/**
 * 当前页内容。大纲已经提供封面文案或普通页的成稿散文，
 * 版面由本 Agent 自行决定，只追加本页已选择的图片，不注入整套素材库。
 */
function pageContentSection(input: { outline: WorkspaceOutline; page: AuthoringPage; availableImages?: OutlineImageAsset[]; preparedPageImages?: PreparedPageImages }) {
  const ids = input.outline.items[input.page.index]?.selected_image_ids ?? [];
  const images = ids.map((id) => {
    const prepared = input.preparedPageImages?.images.find((image) => image.asset_id === id);
    const asset = prepared ?? resolveOutlineImage(input.availableImages ?? [], id);
    if (!asset) throw new Error(`Assigned image is unavailable: ${id}`);
    return { ...asset, attachment_index: prepared?.attachment_index ?? null };
  });
  return [
    ...creationRequirementsPrompt(input.outline.global_creation_requirements, input.outline.items[input.page.index]?.creation_requirements),
    "## 当前页内容",
    `页面类型：${input.page.page_type === "cover" ? "封面页" : "普通内容页"}`,
    "### 页面标题",
    input.page.title,
    "### 页面大纲",
    input.page.outline,
    "### 用户指定的本页配图",
    ...(images.length ? [
      `以下 ${images.length} 张图片是用户为本页选定的配图，属于明确的创作要求，必须全部在最终页面中清晰展示。不得自行筛选、遗漏、隐藏或用其他图片替代。请根据图片数量调整布局；模板参考和默认排版建议不能成为省略图片的理由。`,
      "原图附件数量只影响可查看的原图数量，不影响配图展示要求；未附原图的已选图片也必须展示。",
    ] : []),
    "attachment_index 对应本次消息中原始配图附件的顺序，从 1 开始；null 表示未附原图，只有文字信息。页面截图不属于原始配图。",
    images.length ? JSON.stringify(images.map(({ attachment_index, asset_id, file_path, title, description, reason, width, height }) =>
      ({ attachment_index, asset_id, file_path, title, description, reason, width, height })), null, 2) : "本页未选择图片。",
    "使用图片时必须将 file_path 的绝对路径原样写入 HTML 的 img src，不得改成相对路径、远程链接或虚构路径。图片应服务于页面内容。图片描述和标题只帮助理解画面，不自动作为事实依据。",
    "使用已附图片前，先查看对应附件，以实际画面为准；描述和选图理由可能不准确。",
    "描述为空是正常素材状态，不影响用户选图要求。未附原图且缺少描述时，仅按真实路径和尺寸安排展示，不从标题猜画面，不做依赖画面细节的精确裁切或标注。",
  ];
}

function pageHtmlConstraints(aspectRatio?: SlideAspectRatio) {
  const { width, height } = slideFormat(aspectRatio);
  return [
  "## HTML 生成约束",
  "字号不要过小，要让观众能够看清，主要正文字号最低不应小于20px,次级解释文字最低不应小于18px",
  `页面必须是完整、可运行的 HTML 文档，并包含唯一一个固定为 ${width}×${height} 的 .slide 根容器。`,
  "按目标画布重新构图，尤其竖版应合理调整分栏、阅读顺序和图表布局；不得拉伸横版页面，模板参考尺寸不能覆盖目标尺寸。",
];
}

const AESTHETIC_REFERENCE_INTRO =
  "主导美学(只参考美学设计，不要参考文字内容)参考如下 HTML，要求页面设计美观高级，具备强信息传递效率，布局合理，没有特别空或特别局促的地方：";

function pageVisualContext(input: { page: AuthoringPage; visualMasterHtml: string | null; referenceHtml: string }) {
  const isCover = input.page.page_type === "cover";
  return [
    ...(isCover
      ? [
        "", "## 封面设计要求",
        "当前页是封面页，请按照演示文稿封面的样式设计：突出主标题，建立清晰的主副标题层级，可使用大字号、自然换行、简洁构图和充分留白。",
        "只呈现当前页提供的必要封面信息，不要扩写正文、添加目录、数据分析或编造汇报人、机构、日期。不要为了填满画面增加内容模块；有意的留白是封面设计的一部分。",
      ]
      : ["", "## 需要遵守的【全局视觉母版】：", "```html", input.visualMasterHtml, "```"]),
    "", "## 主导美学参考",
    isCover
      ? "只参考以下 HTML 的美学设计，不要参考文字内容；结合封面需求组织构图、字体和色彩，保持简约和清晰的视觉层级，允许充分留白。"
      : AESTHETIC_REFERENCE_INTRO,
    "```html", input.referenceHtml, "```",
  ];
}

export function buildPageHtmlPrompt(input: {
  preparedPageImages?: PreparedPageImages;
  aspectRatio?: SlideAspectRatio;
  outline: WorkspaceOutline;
  page: AuthoringPage;
  visualMasterHtml: string | null;
  referenceHtml: string;
  availableImages?: OutlineImageAsset[];
}) {
  return [
    "你是一名 HTML 演示页面设计专家。",
    `你需要生成一套 HTML 中的第 ${input.page.index + 1} 页`,
    "",
    "## 事实性要求",
    "请注意，当前页大纲是本页唯一的业务事实来源。你负责组织和展示已有内容，不得虚构大纲未提供的数字。",
    "模板和视觉母版只提供样式，其文字和数字不能成为业务事实。事实不足时允许减少内容或留白。",
    ...pageContentSection(input),
    ...pageVisualContext(input),
    "",
    ...pageHtmlConstraints(input.aspectRatio),
    "不要写磁盘上的文件，直接输出 HTML 给我，不要返回除了 HTML 外任何内容，也不要用代码块包裹 HTML。",
  ].join("\n");
}

export function buildPageHtmlRefinementPrompt(input: {
  aspectRatio?: SlideAspectRatio;
  outline: WorkspaceOutline;
  page: AuthoringPage;
  visualMasterHtml: string | null;
  referenceHtml: string;
  refinementRequest: string;
  originalHtml: string;
  availableImages?: OutlineImageAsset[];
}) {
  return [
    "你是一名 HTML 演示页面设计专家。",
    "这是一次当前页 HTML 精修。你必须在原 HTML 基础上按照用户本轮修改意见修改，不要从零生成另一页。",
    "只允许修改当前页 HTML，不要修改其它页面、Manifest、Outline 或共享文件。",
    "",
    ...pageContentSection(input),
    "",
    "## 用户本轮修改意见",
    input.refinementRequest.trim(),
    "本轮明确修改只覆盖与其冲突的已有创作要求，未涉及的要求继续有效。",
    "",
    "## 当前页原始 HTML",
    "以下 HTML 是当前页面已经存在的版本。请保留其中已有事实、数字、名称、日期和有效图片路径，只按本轮修改意见调整结构、样式和表达。",
    "```html",
    input.originalHtml.trim(),
    "```",
    ...pageVisualContext(input),
    "",
    "## 精修约束",
    "附件截图是当前页原始 HTML 渲染后的截图。",
    ...pageHtmlConstraints(input.aspectRatio).slice(1),
    "不要写磁盘上的文件，直接输出修改后的完整 HTML，不要返回除了 HTML 外任何内容，也不要用代码块包裹 HTML。",
  ].join("\n");
}
