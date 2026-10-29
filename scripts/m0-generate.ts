/**
 * M0 极简编排器：brief → 大纲 → 逐页 HTML → deck.html → pptx
 *
 * 用法：
 *   OPENAI_API_KEY=sk-... node --import tsx/esm scripts/m0-generate.ts \
 *     --brief "Q3 销售复盘" --pages 4 --out artifacts/m0-runs/q3.pptx
 *
 * 可选环境变量：OPENAI_BASE_URL（默认 https://api.deepseek.com）、OPENAI_MODEL（默认 deepseek-chat）、
 *              CHROME_PATH（不设置时自动探测常见安装路径）。
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";

import { llmComplete } from "./m0/llmClient.js";
import { buildOutlineMessages, buildPageMessages } from "./m0/prompts.js";
import { extractHtmlDocument, splitSlideDocument, buildDeckHtml } from "./m0/deck.js";
import { validateSlideHtmlFile, closeValidatorBrowser, type SlideIssue } from "./m0/validatePage.js";
import { runExportOnly } from "../executas/ppt-engine/src/export-only/index.js";

// ── 参数 ──
const args = process.argv.slice(2);
function argOf(name: string, fallback?: string): string {
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing argument ${name}`);
}
const brief = argOf("--brief");
const pageCount = Math.max(2, Math.min(20, Number(argOf("--pages", "8"))));
const outPath = path.resolve(argOf("--out", `artifacts/m0-runs/deck.pptx`));
const concurrency = Math.max(1, Math.min(5, Number(argOf("--concurrency", "3"))));

const repoRoot = path.resolve(import.meta.dirname, "..");
const runDir = path.resolve(repoRoot, "artifacts", "m0-runs", `run-${Date.now()}`);
const outputDir = path.dirname(outPath);

// ── Chrome 自动探测 ──
if (!process.env.CHROME_PATH) {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      process.env.CHROME_PATH = candidate;
      break;
    }
  }
}
process.env.SLIDEFORGE_WORKSPACE_DIR ??= path.join(os.tmpdir(), "slideforge-m0-workspace");

// ── 大纲 ──
interface OutlinePage { title: string; bullets: string[] }
interface Outline { title: string; pages: OutlinePage[] }

async function generateOutline(): Promise<Outline> {
  console.log(`[1/4] 生成大纲（${pageCount} 页）…`);
  const result = await llmComplete(buildOutlineMessages(brief, pageCount));
  let json = result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const begin = json.indexOf("{");
  const end = json.lastIndexOf("}");
  if (begin >= 0 && end > begin) json = json.slice(begin, end + 1);
  const outline = JSON.parse(json) as Outline;
  if (!Array.isArray(outline.pages) || outline.pages.length !== pageCount) {
    throw new Error(`大纲页数不符：期望 ${pageCount}，实际 ${outline.pages?.length}`);
  }
  console.log(`  标题：${outline.title}`);
  console.log(`  tokens: ${JSON.stringify(result.usage)}`);
  return outline;
}

// ── 逐页生成 ──
const overflowWarnings: Array<{ page: number; issues: SlideIssue[] }> = [];

async function generatePage(outline: Outline, index: number): Promise<{ styles: string; body: string }> {
  const page = outline.pages[index];
  const outlineJson = JSON.stringify(outline);
  let lastError: unknown;
  let lastIssues: SlideIssue[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const messages = buildPageMessages({
        deckTitle: outline.title,
        brief,
        outlineJson,
        pageIndex: index,
        pageCount,
        pageTitle: page.title,
        bullets: page.bullets,
      });
      // M1-1：把上次溢出的具体元素反馈给模型，定向修复
      if (lastIssues.length > 0) {
        messages.push({
          role: "user" as const,
          content: `上一次输出内容溢出了 1920×1080 画布：${lastIssues.map((i) => i.detail).join("；")}。请压缩内容量、字号与间距，确保所有元素都在画布内，重新输出完整 HTML 文档。`,
        });
      }
      const result = await llmComplete(messages);
      const html = extractHtmlDocument(result.text);
      const parts = splitSlideDocument(html);
      const pageFile = path.join(runDir, `page-${index + 1}.html`);
      await writeFile(pageFile, html, "utf8");

      // 确定性版面闸门
      const validation = await validateSlideHtmlFile(pageFile);
      if (!validation.ok) {
        lastIssues = validation.issues;
        if (attempt === 0) {
          console.warn(`  ↻ 第 ${index + 1} 页溢出（${validation.issues.map((i) => i.detail).join("；")}），定向重生成…`);
          continue;
        }
        overflowWarnings.push({ page: index + 1, issues: validation.issues });
        console.warn(`  ⚠ 第 ${index + 1} 页重生成后仍溢出，接受并记录：${validation.issues.map((i) => i.detail).join("；")}`);
      }
      console.log(`  ✔ 第 ${index + 1} 页「${page.title}」（tokens: ${result.usage?.total_tokens ?? "?"}）`);
      return parts;
    } catch (error) {
      lastError = error;
      console.warn(`  ✖ 第 ${index + 1} 页第 ${attempt + 1} 次失败：${error instanceof Error ? error.message.slice(0, 120) : error}`);
    }
  }
  throw new Error(`第 ${index + 1} 页生成失败：${lastError instanceof Error ? lastError.message : lastError}`);
}

// ── 主流程 ──
await mkdir(runDir, { recursive: true });
await mkdir(outputDir, { recursive: true });
console.log(`M0 编排器 · brief="${brief}" · pages=${pageCount} · 并发=${concurrency}`);
console.log(`工作目录：${runDir}`);

const outline = await generateOutline();
await writeFile(path.join(runDir, "outline.json"), JSON.stringify(outline, null, 2), "utf8");

console.log(`[2/4] 逐页生成（${concurrency} 并发）…`);
const slides: Array<{ styles: string; body: string }> = new Array(pageCount);
let cursor = 0;
async function worker() {
  while (cursor < pageCount) {
    const index = cursor++;
    slides[index] = await generatePage(outline, index);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

console.log(`[3/4] 组装 deck.html…`);
const deckHtml = buildDeckHtml({ title: outline.title, slides });
await writeFile(path.join(runDir, "deck.html"), deckHtml, "utf8");

console.log(`[4/4] 导出 PPTX…`);
const result = await runExportOnly({
  request_id: `m0-${Date.now()}`,
  format: "pptx",
  source_root: runDir,
  deck_html_file: "deck.html",
  expected_slide_count: pageCount,
  title: outline.title,
  output_dir: outputDir,
});

if (result.status !== "completed") {
  console.error("导出失败：", JSON.stringify(result.error, null, 2));
  process.exit(1);
}
const { rename } = await import("node:fs/promises");
await rename(result.output_path!, outPath);
console.log(`\n✅ 完成：${outPath}`);
console.log(`页数=${result.slide_count} · 大小=${result.size_bytes}B · 警告=${result.warning_count}`);
if (result.warning_count > 0) console.log("警告：", result.warnings.slice(0, 5));
if (overflowWarnings.length > 0) {
  console.log(`\n⚠ 版面溢出遗留 ${overflowWarnings.length} 页：${overflowWarnings.map((w) => `第${w.page}页`).join("、")}`);
}
await writeFile(
  path.join(runDir, "run-report.json"),
  JSON.stringify({ brief, pageCount, outline, overflowWarnings, export: { status: result.status, warnings: result.warnings } }, null, 2),
  "utf8",
);
await closeValidatorBrowser();
