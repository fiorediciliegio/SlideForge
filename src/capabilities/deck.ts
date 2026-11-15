/**
 * M1-2 · 能力层：create_deck / regenerate_page / export_deck。
 * CLI（scripts/m0-generate.ts）与 MCP Server 共用这一层，禁止 UI 专用后门。
 */
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { llmComplete } from "../../scripts/m0/llmClient.js";
import { buildOutlineMessagesViaBrain, buildPageMessagesViaBrain, generateOutlineViaBrain, remoteBrainEnabled } from "../server/brainClient.js";
import { extractHtmlDocument, splitSlideDocument, buildDeckHtml } from "../../scripts/m0/deck.js";
import type { SlideIssue } from "../../scripts/m0/validatePage.js";
import { validateEngineHTML, inspectEngineWorkspace, startWorkspaceExport, waitEngineJob } from "../server/engineClient.js";
import { engineTransport } from "../server/engineTransport.js";
import { computePageDrift } from "./drift.js";
import { validateHtmlDialect } from "../../scripts/m0/dialect.js";
import { extractPptxSlideTexts, normalizeTextSet } from "../documents/pptxText.js";
import { brandVisualSpec, type BrandProfile } from "../brand/profile.js";
import { BRANDS_DIR } from "../brand/store.js";
import { getTemplateReference } from "../templates/library.js";
import type { CreateDeckInput as ContractCreateDeckInput, DeckEvent } from "../contracts/deck.js";
import { newDeckId } from "../contracts/ids.js";
import { createDeckWorkspace } from "./workspace.js";
import { currentAgentCall } from "../server/agentClient.js";

export type { DeckEvent } from "../contracts/deck.js";

export interface OutlinePage { title: string; bullets: string[] }
export interface Outline { title: string; pages: OutlinePage[] }

export interface CreateDeckInput extends ContractCreateDeckInput<BrandProfile> {}

export interface CreateDeckResult {
  deckId: string;
  runDir: string;
  outline: Outline;
  overflowWarnings: Array<{ page: number; issues: SlideIssue[] }>;
}

export interface ExportDeckResult {
  outPath: string;
  slideCount: number;
  sizeBytes: number;
  warnings: string[];
  engineJobId?: string;
}

function defaultDecksRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..", "artifacts", "decks");
}

async function generateOutline(brief: string, pageCount: number): Promise<Outline> {
  if (remoteBrainEnabled()) return generateOutlineViaBrain(brief, pageCount);
  const result = await llmComplete(await buildOutlineMessagesViaBrain(brief, pageCount));
  let json = result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const begin = json.indexOf("{");
  const end = json.lastIndexOf("}");
  if (begin >= 0 && end > begin) json = json.slice(begin, end + 1);
  const outline = JSON.parse(json) as Outline;
  if (!Array.isArray(outline.pages) || outline.pages.length !== pageCount) {
    throw new Error(`大纲页数不符：期望 ${pageCount}，实际 ${outline.pages?.length}`);
  }
  return outline;
}

interface PageContext {
  currentHtml?: string;
  brief: string;
  outline: Outline;
  runDir: string;
  pageCount: number;
  visualSpec?: string;
  referenceHtml?: string;
  onEvent?: (event: DeckEvent) => void;
}

async function generatePage(
  ctx: PageContext,
  index: number,
  overflowWarnings: Array<{ page: number; issues: SlideIssue[] }>,
  instruction?: string,
): Promise<{ styles: string; body: string }> {
  const page = ctx.outline.pages[index];
  let lastError: unknown;
  let lastIssues: SlideIssue[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let checkingEngine=false;
    try {
      const messages = await buildPageMessagesViaBrain({
        deckTitle: ctx.outline.title,
        brief: ctx.brief,
        outlineJson: JSON.stringify(ctx.outline),
        pageIndex: index,
        pageCount: ctx.pageCount,
        pageTitle: page.title,
        bullets: page.bullets,
        visualSpec: ctx.visualSpec,
        referenceHtml: ctx.referenceHtml,
      });
      if (instruction) {
        messages.push({ role: "user", content: `用户对这一页的修改要求：${instruction}。请在遵守全部约束的前提下输出修改后的完整 HTML 文档。` });
      }
      if (ctx.currentHtml) messages.push({role:"user",content:`【当前页面，修改必须以此为基础】\n${ctx.currentHtml}`});
      if (lastIssues.length > 0) {
        messages.push({
          role: "user",
          content: `上一次输出存在以下问题：${lastIssues.map((i) => i.detail).join("；")}。请修复后重新输出完整 HTML 文档（所有元素在 1920×1080 画布内，且遵守方言契约：无 script/外链/远程资源/fixed/filter/blend/动画）。`,
        });
      }
      const result = await llmComplete(messages);
      const html = extractHtmlDocument(result.text);
      const parts = splitSlideDocument(html);

      // D2 方言静态校验（结构/外部资源/不可映射 CSS）
      const dialect = validateHtmlDialect(html);
      if (!dialect.ok) {
        if (currentAgentCall()) throw new Error(dialect.errors.map(item=>item.detail).join("；"));
        lastIssues = dialect.errors.map((e) => ({ kind: "overflow-y" as const, detail: `${e.rule}: ${e.detail}` }));
        if (attempt === 0) {
          ctx.onEvent?.({ stage: "page", page: index + 1, message: `第 ${index + 1} 页违反方言契约，定向重生成` });
          continue;
        }
        overflowWarnings.push({ page: index + 1, issues: lastIssues });
      }

      const pageFile = path.join(ctx.runDir, `page-${index + 1}.html`);
      await writeFile(pageFile, html, "utf8");

      checkingEngine=true;
      const validation = await validateEngineHTML(await readFile(pageFile,"utf8"),{runDir:ctx.runDir});
      checkingEngine=false;
      if (!validation.ok) {
        if (currentAgentCall()) throw new Error(validation.issues.map(item=>item.detail).join("；"));
        lastIssues = validation.issues;
        if (attempt === 0) {
          ctx.onEvent?.({ stage: "page", page: index + 1, message: `第 ${index + 1} 页溢出，定向重生成` });
          continue;
        }
        overflowWarnings.push({ page: index + 1, issues: validation.issues });
      }
      ctx.onEvent?.({ stage: "page", page: index + 1, totalPages: ctx.pageCount, message: `第 ${index + 1} 页完成「${page.title}」` });
      return parts;
    } catch (error) {
      if(checkingEngine)throw error;
      if (currentAgentCall()) throw error;
      lastError = error;
      ctx.onEvent?.({ stage: "page", page: index + 1, message: `第 ${index + 1} 页第 ${attempt + 1} 次失败` });
    }
  }
  throw new Error(`第 ${index + 1} 页生成失败：${lastError instanceof Error ? lastError.message : lastError}`);
}

async function assembleDeck(runDir: string, title: string, pageCount: number): Promise<void> {
  const slides = [];
  for (let i = 1; i <= pageCount; i++) {
    const html = await readFile(path.join(runDir, `page-${i}.html`), "utf8");
    slides.push(splitSlideDocument(html));
  }
  let logo: { src: string; position?: "top-right" | "top-left" | "bottom-right" | "bottom-left" } | undefined;
  try {
    const brand = JSON.parse(await readFile(path.join(runDir, "brand.json"), "utf8"));
    logo = brand.logo;
  } catch { /* 无品牌资产 */ }
  await writeFile(path.join(runDir, "deck.html"), buildDeckHtml({ title, slides, logo }), "utf8");
}

export async function createDeck(input: CreateDeckInput): Promise<CreateDeckResult> {
  const pageCount = Math.max(2, Math.min(20, input.pageCount ?? 8));
  const concurrency = Math.max(1, Math.min(5, input.concurrency ?? 3));
  const decksRoot = input.decksRoot ?? defaultDecksRoot();
  const deckId = input.deckId ?? newDeckId();
  const runDir = await createDeckWorkspace(decksRoot, deckId);

  // M4 固定资产：logo 拷贝进工作区，组装时确定性合成（不经模型）
  let logo: { src: string; position?: "top-right" | "top-left" | "bottom-right" | "bottom-left" } | undefined;
  const brand = input.brandProfile as (BrandProfile & { brand_id?: string; logoFile?: string; logoPosition?: "top-right" | "top-left" | "bottom-right" | "bottom-left" }) | undefined;
  if (brand?.logoFile && brand.brand_id) {
    const ext = brand.logoFile.split(".").pop();
    await mkdir(path.join(runDir, "assets"), { recursive: true });
    const { copyFile } = await import("node:fs/promises");
    await copyFile(path.join(BRANDS_DIR, brand.brand_id, brand.logoFile), path.join(runDir, "assets", `logo.${ext}`));
    logo = { src: `assets/logo.${ext}`, position: brand.logoPosition };
    await writeFile(path.join(runDir, "brand.json"), JSON.stringify({ logo }), "utf8");
  }

  const emit = input.onEvent ?? (() => {});
  const sourceBlock = input.sourceText?.trim()
    ? `\n\n【用户提供的原始文档，所有事实与数据必须以此为准，不得编造文档外信息】\n${input.sourceText.trim().slice(0, 12000)}`
    : "";
  // F1 联网研究：检索资料与来源注入（在文档之后，标注来源归属）
  let researchBlock = "";
  if (input.research) {
    const { researchWeb, researchContextBlock } = await import("../research/web.js");
    emit({ stage: "outline", message: "联网检索中…" });
    try {
      const research = await researchWeb(input.brief);
      researchBlock = `\n\n${researchContextBlock(research)}`;
      emit({ stage: "outline", message: `检索到 ${research.sources.length} 条资料，已注入来源` });
    } catch (error) {
      emit({ stage: "outline", message: `检索失败（按无资料继续）：${error instanceof Error ? error.message.slice(0, 80) : error}` });
    }
  }
  const effectiveBrief = input.brief + sourceBlock + researchBlock;
  emit({ stage: "outline", message: `生成大纲（${pageCount} 页）` });
  const outline = await generateOutline(effectiveBrief, pageCount);
  await writeFile(path.join(runDir, "outline.json"), JSON.stringify(outline, null, 2), "utf8");
  await writeFile(path.join(runDir, "brief.txt"), effectiveBrief, "utf8");

  const overflowWarnings: Array<{ page: number; issues: SlideIssue[] }> = [];
  // M5 零选择启动：未指定模板/品牌时自动推荐
  let templateId = input.templateId;
  if (!templateId && !input.brandProfile) {
    const { recommendTemplate } = await import("../templates/recommend.js");
    const recommendation = await recommendTemplate(input.brief);
    if (recommendation) {
      templateId = recommendation.templateId;
      emit({ stage: "outline", message: `自动选择模板：${recommendation.templateName}（${recommendation.reason}）` });
    }
  }
  const ctx: PageContext = {
    brief: effectiveBrief,
    outline,
    runDir,
    pageCount,
    visualSpec: input.brandProfile
      ? brandVisualSpec(input.brandProfile)
      : templateId
        ? "视觉规范：以下方【风格参照】参考页的视觉风格为唯一标准（配色/字体/布局/卡片语言），不得套用其他风格。"
        : undefined,
    referenceHtml: templateId ? await getTemplateReference(templateId) : undefined,
    onEvent: emit,
  };
  const slides: Array<{ styles: string; body: string }> = new Array(pageCount);
  let cursor = 0;
  const worker = async () => {
    while (cursor < pageCount) {
      const index = cursor++;
      slides[index] = await generatePage(ctx, index, overflowWarnings);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  emit({ stage: "assemble", message: "组装 deck.html" });
  await writeFile(path.join(runDir, "deck.html"), buildDeckHtml({ title: outline.title, slides, logo }), "utf8");
  await writeFile(path.join(runDir, "run-report.json"), JSON.stringify({ brief: input.brief, pageCount, outline, overflowWarnings }, null, 2), "utf8");
  return { deckId, runDir, outline, overflowWarnings };
}

export async function regeneratePage(input: {
  runDir: string;
  page: number;
  instruction: string;
  onEvent?: (event: DeckEvent) => void;
}): Promise<{
  overflowWarnings: Array<{ page: number; issues: SlideIssue[] }>;
  drift?: ReturnType<typeof computePageDrift>;
}> {
  const versioning=await import("./agent.js");
  if(await versioning.isVersionedWorkspace(input.runDir))return versioning.versionedDeckEdit(input.runDir,input.instruction,directory=>regeneratePage({...input,runDir:directory}),{page:input.page});
  input = { ...input, runDir: path.resolve(input.runDir) };
  const outline = JSON.parse(await readFile(path.join(input.runDir, "outline.json"), "utf8")) as Outline;
  const brief = await readFile(path.join(input.runDir, "brief.txt"), "utf8");
  const index = input.page - 1;
  if (index < 0 || index >= outline.pages.length) {
    throw new Error(`页码越界：${input.page}（共 ${outline.pages.length} 页）`);
  }
  // 偏离度报告：改动前留档
  const pageFile = path.join(input.runDir, `page-${input.page}.html`);
  let oldHtml = "";
  try { oldHtml = await readFile(pageFile, "utf8"); } catch { /* 首次生成 */ }

  const overflowWarnings: Array<{ page: number; issues: SlideIssue[] }> = [];
  const emit = input.onEvent ?? (() => {});
  emit({ stage: "regenerate", page: input.page, message: `重生成第 ${input.page} 页` });
  let visualContext: {visualSpec?:string;referenceHtml?:string}={};
  try {visualContext=JSON.parse(await readFile(path.join(input.runDir,"agent-context.json"),"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  await generatePage(
    { brief, outline, runDir: input.runDir, pageCount: outline.pages.length, onEvent: emit,currentHtml:oldHtml,...visualContext },
    index,
    overflowWarnings,
    input.instruction,
  );
  await assembleDeck(input.runDir, outline.title, outline.pages.length);

  let drift: ReturnType<typeof computePageDrift> | undefined;
  if (oldHtml) {
    const newHtml = await readFile(pageFile, "utf8");
    drift = computePageDrift(oldHtml, newHtml);
    await writeFile(
      path.join(input.runDir, `drift-report-page-${input.page}.json`),
      JSON.stringify(drift, null, 2),
      "utf8",
    );
  }
  return { overflowWarnings, drift };
}

function extractTextLinesLocal(html: string): string[] {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * D3 · 回传续改：用户在 WPS 改过的 pptx 传回来。
 * 分支语义：不做格式同步，而是逐页识别用户改动 → 仅对改动页做语义吸收式重生成 → 重组装。
 */
export async function reimportDeck(input: {
  runDir: string;
  pptxBuffer: Buffer;
  onEvent?: (event: DeckEvent) => void;
}): Promise<{
  changedPages: number[];
  unchangedPages: number[];
  report: Array<{ page: number; added: number; removed: number }>;
}> {
  const versioning=await import("./agent.js");
  if(await versioning.isVersionedWorkspace(input.runDir))return versioning.versionedDeckEdit(input.runDir,"吸收 WPS 手工修改",directory=>reimportDeck({...input,runDir:directory}),{source:input.pptxBuffer});
  input = { ...input, runDir: path.resolve(input.runDir) };
  const emit = input.onEvent ?? (() => {});
  const outline = JSON.parse(await readFile(path.join(input.runDir, "outline.json"), "utf8")) as Outline;
  const brief = await readFile(path.join(input.runDir, "brief.txt"), "utf8");
  const slideTexts = await extractPptxSlideTexts(input.pptxBuffer);
  let visualContext:{visualSpec?:string;referenceHtml?:string}={};
  try{visualContext=JSON.parse(await readFile(path.join(input.runDir,"agent-context.json"),"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  if (slideTexts.length !== outline.pages.length) {
    throw new Error(`页数不一致：原 deck ${outline.pages.length} 页，回传文件 ${slideTexts.length} 页`);
  }

  const changedPages: number[] = [];
  const unchangedPages: number[] = [];
  const report: Array<{ page: number; added: number; removed: number }> = [];
  const overflowWarnings: Array<{ page: number; issues: SlideIssue[] }> = [];

  for (let index = 0; index < outline.pages.length; index++) {
    const pageNumber = index + 1;
    const oldHtml = await readFile(path.join(input.runDir, `page-${pageNumber}.html`), "utf8");
    const oldSet = normalizeTextSet(extractTextLinesLocal(oldHtml));
    const newSet = normalizeTextSet(slideTexts[index]);
    const added = [...newSet].filter((text) => !oldSet.has(text));
    const removed = [...oldSet].filter((text) => !newSet.has(text));

    if (added.length === 0 && removed.length === 0) {
      unchangedPages.push(pageNumber);
      continue;
    }
    changedPages.push(pageNumber);
    report.push({ page: pageNumber, added: added.length, removed: removed.length });
    emit({ stage: "regenerate", page: pageNumber, message: `吸收 WPS 手工改动（新增 ${added.length} 条/删除 ${removed.length} 条）` });

    const instruction = `用户已在 WPS 中手工修改了此页，以下是修改后的页面文本（以其为准完整吸收，保留所有修改，不得回退到旧文本）：
${slideTexts[index].join("；").slice(0, 1500)}
请保持原有的版式结构、配色与品牌风格，仅按上述新文本更新内容。`;
    await generatePage(
      { brief, outline, runDir: input.runDir, pageCount: outline.pages.length, onEvent: emit,currentHtml:oldHtml,...visualContext },
      index,
      overflowWarnings,
      instruction,
    );
  }

  await assembleDeck(input.runDir, outline.title, outline.pages.length);
  await writeFile(
    path.join(input.runDir, "reimport-report.json"),
    JSON.stringify({ changedPages, unchangedPages, report, overflowWarnings, ts: new Date().toISOString() }, null, 2),
    "utf8",
  );
  return { changedPages, unchangedPages, report };
}

/** 直接写入手动编辑后的页面 HTML（不经模型），随后重组装并输出偏离度报告。 */
export async function updatePageHtml(input: {
  runDir: string;
  page: number;
  html: string;
}): Promise<{
  drift?: ReturnType<typeof computePageDrift>;
  overflowWarnings: Array<{ page: number; issues: SlideIssue[] }>;
}> {
  const versioning=await import("./agent.js");
  if(await versioning.isVersionedWorkspace(input.runDir))return versioning.versionedDeckEdit(input.runDir,`手动编辑第${input.page}页`,directory=>updatePageHtml({...input,runDir:directory}),{page:input.page});
  const runDir = path.resolve(input.runDir);
  const outline = JSON.parse(await readFile(path.join(runDir, "outline.json"), "utf8")) as Outline;
  if (input.page < 1 || input.page > outline.pages.length) {
    throw new Error(`页码越界：${input.page}`);
  }
  const dialect = validateHtmlDialect(input.html);
  if (!dialect.ok) {
    throw new Error(`违反方言契约：${dialect.errors.map((e) => e.detail).join("；")}`);
  }
  const pageFile = path.join(runDir, `page-${input.page}.html`);
  const oldHtml = await readFile(pageFile, "utf8");
  await writeFile(pageFile, input.html, "utf8");
  await assembleDeck(runDir, outline.title, outline.pages.length);

  const drift = computePageDrift(oldHtml, input.html);
  await writeFile(
    path.join(runDir, `drift-report-page-${input.page}.json`),
    JSON.stringify(drift, null, 2),
    "utf8",
  );

  const overflowWarnings: Array<{ page: number; issues: SlideIssue[] }> = [];
  const validation = await validateEngineHTML(await readFile(pageFile,"utf8"),{runDir});
  if (!validation.ok) overflowWarnings.push({ page: input.page, issues: validation.issues });
  return { drift, overflowWarnings };
}

/** 一键换肤：保留大纲与内容，仅按新模板视觉规范重生成全部页面。 */
export async function applyTheme(input: {
  runDir: string;
  templateId?: string;
  brandProfile?: BrandProfile;
  onEvent?: (event: DeckEvent) => void;
}): Promise<{ templateId?: string }> {
  const versioning=await import("./agent.js");
  if(await versioning.isVersionedWorkspace(input.runDir))return versioning.versionedDeckEdit(input.runDir,"调整视觉主题",directory=>applyTheme({...input,runDir:directory}));
  const runDir = path.resolve(input.runDir);
  const outline = JSON.parse(await readFile(path.join(runDir, "outline.json"), "utf8")) as Outline;
  const brief = await readFile(path.join(runDir, "brief.txt"), "utf8");
  const emit = input.onEvent ?? (() => {});

  let templateId = input.templateId;
  if (!templateId && !input.brandProfile) {
    const { recommendTemplate } = await import("../templates/recommend.js");
    const recommendation = await recommendTemplate(brief);
    templateId = recommendation?.templateId;
  }
  const visualSpec = input.brandProfile
    ? brandVisualSpec(input.brandProfile)
    : templateId
      ? "视觉规范：以下方【风格参照】参考页的视觉风格为唯一标准（配色/字体/布局/卡片语言），不得套用其他风格。"
      : undefined;
  const referenceHtml = templateId ? await getTemplateReference(templateId) : undefined;

  const overflowWarnings: Array<{ page: number; issues: SlideIssue[] }> = [];
  const instruction = "这是一次纯换肤重生成：保持本页全部文字内容、事实与信息结构不变，只按新的视觉规范改变配色、字体与卡片风格，不得改写文字内容。";
  for (let index = 0; index < outline.pages.length; index++) {
    emit({ stage: "regenerate", page: index + 1, message: `换肤第 ${index + 1} 页` });
    const pageFile = path.join(runDir, `page-${index + 1}.html`);
    const oldHtml = await readFile(pageFile, "utf8");
    await generatePage(
      { brief, outline, runDir, pageCount: outline.pages.length, visualSpec, referenceHtml, onEvent: emit,currentHtml:oldHtml },
      index,
      overflowWarnings,
      `${instruction}\n【本页原文（仅供保留内容，不要学习其旧风格）】\n${extractTextLinesLocal(oldHtml).join("；").slice(0, 1500)}`,
    );
  }
  await assembleDeck(runDir, outline.title, outline.pages.length);
  if(currentAgentCall())await writeFile(path.join(runDir,"agent-context.json"),JSON.stringify({themeChanged:true,templateId,visualSpec,referenceHtml,brand:input.brandProfile}));
  return { templateId };
}

export async function exportDeck(input: {
  runDir: string;
  outPath?: string;
  format?: "pptx" | "pdf";
}): Promise<ExportDeckResult> {
  const managed=await (await import("./agent.js")).isVersionedWorkspace(input.runDir);
  if(managed&&(managed.pages.length!==managed.outline.pages.length||managed.pages.length<2))throw new Error("页面尚未完整生成，不能导出不完整文件");
  const outline = JSON.parse(await readFile(path.join(input.runDir, "outline.json"), "utf8")) as Outline;
  const safeTitle = outline.title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 60) || "deck";
  const format = input.format ?? "pptx";
  const outPath = path.resolve(input.outPath ?? path.join(input.runDir, `${safeTitle}.${format}`));
  input = { ...input, runDir: path.resolve(input.runDir), outPath };
  await mkdir(path.dirname(outPath), { recursive: true });
  const job=await startWorkspaceExport(input.runDir,format);
  const result=await waitEngineJob(job);
  await writeFile(outPath,await engineTransport.read(result.file_ref!,job.owner_key_hash));
  return {outPath,slideCount:result.slide_count!,sizeBytes:(await (await import("node:fs/promises")).stat(outPath)).size,warnings:result.warnings??[],engineJobId:job.job_id};
}

export interface DeckPreviewImage {
  page: number;
  base64: string;
  mimeType: "image/jpeg";
}

/** 渲染 deck 页面缩略图（默认前 4 页），供 MCP 图片消息回传。 */
export async function getDeckPreview(input: {
  runDir: string;
  pages?: number[];
  maxPages?: number;
}): Promise<DeckPreviewImage[]> {
  const maxPages = input.maxPages ?? 4;
  const pages = input.pages?.slice(0, maxPages) ?? Array.from({ length: maxPages }, (_, i) => i + 1);
  const result=await inspectEngineWorkspace(input.runDir,{pages,layout:false,visual:true});
  return (result.pages??[]).map(page=>({page:page.page,base64:page.image!,mimeType:"image/jpeg" as const}));
}
