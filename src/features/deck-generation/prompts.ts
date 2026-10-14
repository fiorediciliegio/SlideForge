import { pickLocale } from "../../i18n/locales";
import type { AgentPageVisualReviewResult } from "../../agent/agentClient";
import type { WorkspaceOutline } from "../../api/types";
import type { ManualPageRevisionManifest } from "../../api/types";
import type { Locale } from "../../i18n/messages";
import { currentDatePromptLine } from "../../ai/promptContext";
import type { AuthoringDeck, AuthoringPage, NoChangeAuthoringRetry, PageRefinementVisualContext, RenderFailureHistoryItem, RenderFailurePhase } from "./types";
import {
  createAgentFileToolPathContext,
  describeAgentFileToolPathContext,
  formatAgentFileToolPathBlock,
  toAgentFileToolPath,
} from "./agentFileToolPaths";

export function extractRenderFailureDiagnosticSummary(error: string): string {
  return error.split(/\r?\n/).map((line) => line.trim())
    .find((line) => /:\d+:\d+\s+TS\d+:/.test(line))
    ?? error.split(/\r?\n/).find((line) => line.trim())?.trim()
    ?? error;
}

export function extractRenderFailureDiagnosticKey(summary: string): string {
  const match = summary.match(/^(.+?:\d+:\d+)\s+(TS\d+):/);
  return match ? `${match[1]} ${match[2]}` : summary;
}

export function summarizeRenderFailureHistory(history: RenderFailureHistoryItem[]) {
  const grouped = new Map<string, { attempts: number[]; phases: Set<RenderFailurePhase>; diagnostic: string }>();
  for (const item of history) {
    const diagnostic = extractRenderFailureDiagnosticSummary(item.error);
    const key = extractRenderFailureDiagnosticKey(diagnostic);
    const existing = grouped.get(key);
    if (existing) {
      existing.attempts.push(item.attempt);
      existing.phases.add(item.phase);
    } else {
      grouped.set(key, { attempts: [item.attempt], phases: new Set([item.phase]), diagnostic });
    }
  }
  return [...grouped.values()].map((item) => ({
    attempts: item.attempts,
    phases: [...item.phases],
    repeated_count: item.attempts.length,
    diagnostic: item.diagnostic,
  }));
}

export function buildAuthoringPrompt(input: {
  workspaceRoot?: string;
  workspaceDir: string;
  page: AuthoringPage;
  authoringDeck: AuthoringDeck;
  outline: WorkspaceOutline;
  attemptKind: "initial" | "page-refinement" | "render-fix";
  renderError?: string;
  renderFailureHistory?: RenderFailureHistoryItem[];
  visualReview?: AgentPageVisualReviewResult | null;
  hasImageAttachment?: boolean;
  noChangeRetry?: NoChangeAuthoringRetry | null;
  refinementRequest?: string;
  refinementReason?: string;
  refinementVisualContext?: PageRefinementVisualContext;
  manualRevision?: ManualPageRevisionManifest | null;
}) {
  const context = createAgentFileToolPathContext({
    workspaceRoot: input.workspaceRoot,
    workspaceDir: input.workspaceDir,
  });
  const toolPath = (label: string, absolutePath: string) => formatAgentFileToolPathBlock({
    label,
    path: toAgentFileToolPath(context, absolutePath),
  });
  const pageSourcePath = `${input.workspaceDir}/slides/${input.page.page_id}.tsx`;
  const requirementsPath = `${input.workspaceDir}/requirements.json`;
  const outlinePath = `${input.workspaceDir}/outline.json`;
  const styleGuidePath = `${input.workspaceDir}/style-guide.md`;
  const visualRhythmPath = `${input.workspaceDir}/visual-rhythm.md`;
  const pageVisualPlanPath = `${input.workspaceDir}/page-visual-plans/${input.page.page_id}.md`;
  const persistentElementsPath = `${input.workspaceDir}/persistent-elements.tsx`;
  const authoringKitReadmePath = `${input.workspaceDir}/authoring-kit/README.md`;
  const safeMediaFramePath = `${input.workspaceDir}/authoring-kit/foundations/SafeMediaFrame.tsx`;
  const presentationPrinciplesPath = `${input.workspaceDir}/authoring-kit/presentation-principles.md`;
  const formalCoverReferencePath = `${input.workspaceDir}/authoring-kit/references/pages/FormalCover.tsx`;
  const webResearchSummaryPath = `${input.workspaceDir}/research/evidence/web-summary.md`;
  const imageCatalogPath = `${input.workspaceDir}/research/evidence/image-catalog.json`;
  const shouldReadResearch = input.attemptKind === "initial" || input.attemptKind === "page-refinement";
  const manualRevision = input.manualRevision;
  const refinementContext = input.refinementRequest?.trim() ? [
    "这是优化轮次。大纲和艺术指导是最初确定的基线；如果它们与用户本次优化要求冲突，只执行用户本次要求。",
    `用户本次优化要求: ${input.refinementRequest.trim()}`,
    `当前页优化原因: ${input.refinementReason?.trim() || "Apply the user's refinement request to this page."}`,
    input.hasImageAttachment
      ? "优化前页面截图已作为当前 Session 的原生图片附件提供，仅作视觉基线，不是事实来源。"
      : "优化前页面截图不可用。",
    "不得从截图推断或补造事实、数字、名称、日期、引用或来源依赖内容。",
  ].join("\n") : "";
  const repairContext = input.renderError
    ? [
        "这是渲染修复轮次。优先修复当前错误，不要做无关重构。",
        input.renderError,
        input.renderFailureHistory?.length
          ? JSON.stringify(summarizeRenderFailureHistory(input.renderFailureHistory), null, 2)
          : "",
      ].filter(Boolean).join("\n")
    : "这是首次页面创作。根据已确认页面意图和整套艺术指导完成当前页。";

  return [
    "你是本地文件编辑 Agent，负责创作一页 1280 × 720 的 TSX PPT 页面。",
    "你只允许修改当前页面源文件。不要修改 manifest.json、outline.json、requirements.json、style-guide.md、authoring-kit、其他页面或任何共享文件。",
    currentDatePromptLine(),
    "如果用户没有提供汇报人或组织，正式汇报封面的默认演示身份是 SlideForge。",
    "",
    describeAgentFileToolPathContext(context),
    "",
    "开始写代码前，必须严格按以下顺序完整读取文件：",
    ...(manualRevision ? [
      `1. ${toolPath("人工页面修订 manifest", `${input.workspaceDir}/manual-edits/${input.page.page_id}/manifest.json`)}`,
      `2. ${toolPath("用户最新人工 HTML", manualRevision.current_html_path)}`,
      `3. ${toolPath("当前旧 TSX（需要修改的源码）", pageSourcePath)}`,
      `4. ${toolPath("演示需求", requirementsPath)}`,
      `5. ${toolPath("已确认大纲", outlinePath)}`,
      `6. ${toolPath("艺术指导", styleGuidePath)}`,
      `7. ${toolPath("整套视觉节奏", visualRhythmPath)}`,
      `8. ${toolPath("当前页视觉计划", pageVisualPlanPath)}`,
      `9. ${toolPath("Presentation Principles（演示文稿创作原则）", presentationPrinciplesPath)}`,
      `10. ${toolPath("跨页固定元素参考", persistentElementsPath)}`,
      `11. ${toolPath("Authoring Kit 总说明", authoringKitReadmePath)}`,
      "12. 根据总说明判断当前页相关的 foundations / references 分类，并完整读取相关分类 README。",
      "13. 如果认为任何 Foundation Module（基础模块）或 Reference Implementation（参考实现）适合使用或参考，必须先完整读取对应组件的 TSX 文件，再开始写当前页面。不能只看文件名、README 摘要或局部代码。",
      `如果当前页承担 Deck 封面或 Formal Presentation Cover（正式汇报封面）职责，必须完整读取 ${toolPath("正式汇报封面参考", formalCoverReferencePath)}，再开始写当前页面。`,
      input.hasImageAttachment
        ? "用户最新人工页面截图已作为当前 Session 的原生图片附件提供，仅作视觉参考。"
        : "用户最新人工页面截图附件不可用。",
      "人工页面修订是用户最新内容与视觉结构，旧 TSX 只是需要修复的源码。除非本次优化要求明确冲突，不得回退人工文字、数字、新增对象或恢复 data-ppt-editor-deleted=\"true\" 的对象；data-ppt-editor-placeholder=\"true\" 仅是布局占位，不得写入新 TSX。",
    ] : [
      `1. ${toolPath("当前页面 TSX", pageSourcePath)}`,
      `2. ${toolPath("演示需求", requirementsPath)}`,
      `3. ${toolPath("已确认大纲", outlinePath)}`,
      `4. ${toolPath("艺术指导", styleGuidePath)}`,
      `5. ${toolPath("整套视觉节奏", visualRhythmPath)}`,
      `6. ${toolPath("当前页视觉计划", pageVisualPlanPath)}`,
      `7. ${toolPath("Presentation Principles（演示文稿创作原则）", presentationPrinciplesPath)}`,
      `8. ${toolPath("跨页固定元素参考", persistentElementsPath)}`,
      `9. ${toolPath("Authoring Kit 总说明", authoringKitReadmePath)}`,
      "10. 根据总说明判断当前页相关的 foundations / references 分类，并完整读取相关分类 README。",
      "11. 如果认为任何 Foundation Module（基础模块）或 Reference Implementation（参考实现）适合使用或参考，必须先完整读取对应组件的 TSX 文件，再开始写当前页面。不能只看文件名、README 摘要或局部代码。",
      `如果当前页承担 Deck 封面或 Formal Presentation Cover（正式汇报封面）职责，必须完整读取 ${toolPath("正式汇报封面参考", formalCoverReferencePath)}，再开始写当前页面。`,
    ]),
    ...(shouldReadResearch ? [
      "",
      "开始创作前还必须完整读取以下共享研究资料：",
      `- ${toolPath("Web 研究总结", webResearchSummaryPath)}`,
      `- ${toolPath("图片素材目录", imageCatalogPath)}`,
      "Web 研究总结是允许使用的事实依据；不要使用搜索原始结果、URL 列表或研究进度文件补充事实。",
      "图片素材目录只包含已通过视觉筛选并成功导入当前 Workspace 的可用本地图片。",
    ] : []),
    "本地图片路径规则：image-catalog.json 中每个 asset 的 file_path 是当前 Workspace 中已导入图片的绝对路径。",
    "在 TSX 的 <img src> 或图片组件 url 中必须原样使用该 file_path；不得改成相对路径、添加 ./ 或 ../，也不得使用远程 image_url 或 thumbnail_url。",
    "只要当前页面使用图片，就必须读取 image-catalog.json 中对应 asset 的 width、height、aspect_ratio 和 file_path；不要凭图片外观自行猜测宽高比。",
    `如果当前轮次不是 initial 或 page-refinement，但当前页面已有图片或需要新增图片，仍必须先读取 ${toolPath("图片素材目录", imageCatalogPath)}。`,
    "只要当前页面使用图片，优先完整读取并使用 SafeMediaFrame.tsx（安全媒体容器）：",
    `- ${toolPath("SafeMediaFrame（安全媒体容器）", safeMediaFramePath)}`,
    "图片必须放进有明确宽高边界的媒体槽位；SafeMediaFrame 的父级必须先由 Grid/Flex/绝对定位布局确定可用尺寸。SafeMediaFrame 只负责在槽位内裁切或包含图片，不能替代父级的布局预算。",
    "",
    "几何布局硬约束（写 JSX 前先在内部完成计算，不要只凭视觉比例估算）：",
    "- 根画布固定为 1280 × 720 CSS px，SlideCanvas 会裁切所有超出画布的内容。",
    "- 先计算左右安全边距、页眉/标题/正文/页脚的垂直区间，以及每个主要区域的 x、y、width、height；把 padding、border、gap 和列/行尺寸都计入预算。",
    "- 所有主要区域必须满足：x >= 0、y >= 0、x + width <= 1280、y + height <= 720。绝对定位内容不得与页脚或相邻内容重叠。",
    "- Grid/Flex 子项默认设置 minWidth: 0 和 minHeight: 0；可收缩的 Grid 行列使用 minmax(0, 1fr)，不要直接让图片或长文本的最小内容尺寸决定轨道大小。",
    "- 不要在父级高度尚未明确时使用 height: \"100%\"；不要让 img 使用 height: \"auto\" 参与决定卡片或 Grid 行高。",
    "- 图片标题、遮罩、标签等叠加内容使用 position: \"absolute\" 放在有边界的媒体槽位内部，不能作为额外流内容把父容器撑高。",
    "- 普通页的 eyebrow、标题、可选副标题和正文必须属于同一个正常文档流或 flex 流；副标题存在时，正文必须自然排在副标题之后。推荐只对整个页面安全区使用 position: \"absolute\"，再在安全区内部使用 flexDirection: \"column\" 组织标题块和正文区。",
    "- 普通页禁止把标题区和正文区分别放在互不关联的 position: \"absolute\" 层中，也不要使用固定 top: 160/180/200px 之类的数值猜测正文起点；正文起点必须由标题、可选副标题及其间距在文档流中自然推导。标题或副标题不存在时，不要保留依赖固定 top 的空白。",
    "",
    "图片几何规则：",
    "- 使用 image-catalog.json 的 aspect_ratio 评估图片在目标槽位中的裁切/留白；照片通常使用 fit=\"cover\"，图表、地图、截图和文档通常使用 fit=\"contain\"。",
    "- 图片固有尺寸不能改变页面区域、Grid 行高或 Flex 容器高度；如果预算不足，先缩小图片槽位或调整布局结构，再考虑减少内容密度，不要把溢出交给 SlideCanvas 裁切。",
    "",
    "完成 TSX 后在内部复核：布局区域的加法是否超过父区域；Grid 行高加 gap 是否超过父容器；图片 aspect_ratio 是否可能触发最小内容尺寸；页脚是否与正文争夺空间；是否存在 minHeight:auto 导致子项无法收缩。",
    "",
    "页面要求：",
    `- page_id: ${input.page.page_id}`,
    `- 页面序号: ${input.page.index + 1} / ${input.authoringDeck.pages.length}`,
    `- 页面类型: ${input.page.page_type === "cover" ? "cover（封面页）" : "standard（普通页）"}`,
    `- 页面标题: ${input.page.title}`,
    `- 页面意图: ${input.page.outline}`,
    `- Deck 标题: ${input.outline.title}`,
    "- 保持 Page Source Bootstrap（页面源引导文件）要求的固定画布和导出行为。",
    "- 先判断当前页是否需要页眉、页脚、页码、持续装饰、页面标题或副标题；特殊页可以省略或选择适用的标题处理变体。只要使用其中任一元素，必须仿照 persistent-elements.tsx 对应示例的 JSX 结构、位置、字体、字号、字重、是否斜体、颜色和间距；不要 import 它，也不要自行设计近似版本。",
    "- 如果当前页承担 Deck 封面或 Formal Presentation Cover（正式汇报封面）职责，不要套用普通内容页的顶部模块导航、复杂页眉、页码、标准页面标题/副标题处理或密集正文布局；优先采用 FormalCover.tsx 的封面层级和结构。封面可以省略页码、复杂页眉和正文图表，但必须保留清晰的演示标题、主题/场景识别，以及 Workspace 已提供的身份、周期或日期信息；不得虚构缺失的元数据。",
    "- 页面类型规则必须严格执行：page_type=cover（封面页）时，标题和副标题允许自然换行；标题如需换行，使用显式 <br />，并可使用比普通页更大的字号，封面可以采用专门的特殊布局。page_type=standard（普通页）时，标题必须保持视觉单行，标题和副标题的 style 都必须包含 whiteSpace: \"nowrap\"（例如 style={{ whiteSpace: \"nowrap\" }}）；标题和副标题不得使用 <br />，不得通过换行解决宽度问题；普通页标题字号必须与 persistent-elements.tsx 中的 StandardPageTitleTreatment（普通页标题处理）保持一致，并将标题、可选副标题和正文放入同一个文档流或 flex 流中。",
    "- persistent-elements.tsx 中的标题和副标题文字只是视觉示意，不是当前页面的内容或事实依据。普通页面创作时，页面标题默认使用当前页 Outline 标题；如果是人工页面修订，必须保留用户最新人工内容，除非本次优化明确要求改变标题。副标题只有在当前页确实需要时才添加，并且必须来自已读 Workspace 文件或当前页面意图，不能复制参考文件中的示例文案，也不要仅为填充空间而添加。",
    "- persistent-elements.tsx 中的页码数字只是示意；复制页码时保留 data-presenton-page-number 标记，current 为当前页（1-based），total 为总页数。",
    "- 用清晰的视觉层级表达当前页唯一核心信息；事实和数字只能来自已读 Workspace 文件，不要自行补造。",
    "",
    "当前轮次：",
    refinementContext,
    repairContext,
    input.noChangeRetry ? [
      "上一次响应没有改变当前 TSX 的文件指纹。此次必须实际编辑当前 TSX，不能只返回说明。",
      `重试次数: ${input.noChangeRetry.retryCount}`,
      `上次摘要: ${input.noChangeRetry.previousSummary}`,
      `上次 changed_files: ${JSON.stringify(input.noChangeRetry.previousChangedFiles)}`,
    ].join("\n") : "",
    "",
    "完成编辑后，只返回一个 JSON 对象用于诊断记录：",
    '{"summary":"...","files_read":["..."],"authoring_kit_sources_read":["..."],"changed_files":["..."],"needs_render":true}',
    "Agent 返回值不决定是否通过；系统只根据当前 TSX 文件指纹是否变化执行确定性门禁。",
  ].filter(Boolean).join("\n");
}

export function targetPageNoChangeMessage(locale: Locale, page: AuthoringPage) {
  return pickLocale(locale, {
    zh: `页面生成失败：Agent 完成响应但没有实际修改当前页 TSX（${page.title || page.page_id}）。`,
    en: `Page generation failed: the Agent completed without modifying the current page TSX (${page.title || page.page_id}).`,
    ja: `ページ生成に失敗しました：エージェントは応答を完了しましたが、現在のページの TSX を変更していません（${page.title || page.page_id}）。`,
    de: `Seitengenerierung fehlgeschlagen: Der Agent hat geantwortet, ohne die TSX-Datei der aktuellen Seite zu ändern (${page.title || page.page_id}).`,
  });
}

export function targetPageFingerprintReadErrorMessage(locale: Locale, page: AuthoringPage, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return pickLocale(locale, {
    zh: `页面生成失败：无法读取当前页 TSX 文件用于指纹校验（${page.title || page.page_id}）：${detail}`,
    en: `Page generation failed: unable to fingerprint the current page TSX (${page.title || page.page_id}): ${detail}`,
    ja: `ページ生成に失敗しました：フィンガープリント検証用に現在のページの TSX ファイルを読み取れません（${page.title || page.page_id}）：${detail}`,
    de: `Seitengenerierung fehlgeschlagen: Die TSX-Datei der aktuellen Seite konnte für die Fingerabdruckprüfung nicht gelesen werden (${page.title || page.page_id}): ${detail}`,
  });
}

export function buildPageVisualReviewPrompt(input: {
  workspaceDir: string;
  page: AuthoringPage;
}) {
  const pageSourcePath = `${input.workspaceDir}/slides/${input.page.page_id}.tsx`;
  return [
    "You are a Page Visual Inspection and Repair agent for one generated PPT slide.",
    `Inspect the attached screenshot and the existing TSX file at: ${pageSourcePath}`,
    "Read only that TSX file. Do not read other workspace files unless strictly required to edit this file.",
    "Judge only visual usability: overflow, clipping, overlap, occlusion, footer conflicts, unreadable text or charts, and content outside the 1280 × 720 canvas. Do not judge wording, facts, data, narrative, or personal taste.",
    "If there is no clear usability problem, do not write the file and return changed=false.",
    "If there is a problem, fix it in this same Session. Preserve the existing content and visual intent. Use fs_write_file to write the complete modified TSX to the exact path above.",
    "When repairing the page, keep the root canvas at exactly 1280 × 720 and modify only the specified TSX file. Preserve the existing wording, numbers, color system, visual intent, and core page structure. Do not delete, rewrite, or summarize visible content to make it fit.",
    "Before editing, calculate the actual heights of the main vertical regions: top metadata, header and title area; main body, charts, cards, or content grids; bottom conclusion, callout, or action area; footer; and every gap, padding, and border.",
    "For vertical siblings in the same parent container, the sum of child heights + gaps + padding + borders must be less than or equal to the parent's available height.",
    "Any region that occupies the remaining space must use an explicit fixed height or a calculable Flex remaining-space constraint. Do not let Grid or Flex children grow indefinitely from their natural content size.",
    "After editing, verify every main content region satisfies y + height <= 720, remains fully above the footer, and preserves the required safe spacing above the footer.",
    "Do not hide problems with z-index, overflow:hidden, transform, clipping, moving content off-canvas, or deleting visible content. Include padding, borders, gaps, headers, footers, and all sibling heights in the layout budget.",
    "After the necessary edit, return only this JSON object. The changed field means you attempted a TSX edit; blocked means the screenshot or file could not be inspected or written:",
    '{"changed":true,"blocked":false,"summary":"short description"}',
    `Page id: ${input.page.page_id}`,
  ].join("\n");
}
