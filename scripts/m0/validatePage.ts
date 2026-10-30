/**
 * M1-1 · 确定性版面闸门：无头 Chrome 测量单页 HTML 是否溢出 1920×1080 画布。
 * 可确定性不赌模型：越界由代码判定，重生成时把具体溢出元素反馈给模型。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const engineRequire = createRequire(
  new URL("../../executas/ppt-engine/package.json", import.meta.url),
) as (id: string) => any;
const puppeteer = engineRequire("puppeteer-core");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

function chromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("No Chrome/Edge executable found; set CHROME_PATH");
}

let browserPromise: Promise<any> | null = null;
async function getBrowser() {
  browserPromise ??= puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  return browserPromise;
}

export async function closeValidatorBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

/** 共享浏览器实例（缩略图渲染等复用）。 */
export async function getSharedBrowser() {
  return getBrowser();
}

export interface SlideIssue {
  kind: "overflow-y" | "overflow-x";
  detail: string;
}

export interface SlideValidation {
  ok: boolean;
  issues: SlideIssue[];
}

/** 测量整份 deck.html：逐 shell 检查溢出，返回有问题的页码及细节。 */
export async function validateDeckHtmlFile(filePath: string): Promise<{
  ok: boolean;
  pages: Array<{ page: number; issues: SlideIssue[] }>;
}> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(pathToFileURL(path.resolve(filePath)).href, {
      waitUntil: "networkidle0",
      timeout: 30_000,
    });
    const result = await page.evaluate(() => {
      const TOLERANCE = 8;
      const pages: Array<{ page: number; issues: Array<{ kind: "overflow-y" | "overflow-x"; detail: string }> }> = [];
      document.querySelectorAll("[data-presenton-slide-shell]").forEach((shell, idx) => {
        const shellRect = shell.getBoundingClientRect();
        const issues: Array<{ kind: "overflow-y" | "overflow-x"; detail: string }> = [];
        let count = 0;
        shell.querySelectorAll("*").forEach((el) => {
          if (count >= 3) return;
          const isMedia = /^(img|svg|video|canvas|table)$/.test(el.tagName.toLowerCase());
          const isTextLeaf = el.children.length === 0 && (el.textContent ?? "").trim().length > 0;
          if (!isMedia && !isTextLeaf) return;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return;
          const overY = Math.round(rect.bottom - shellRect.top - 1080);
          const overX = Math.round(rect.right - shellRect.left - 1920);
          if (overY > TOLERANCE || overX > TOLERANCE) {
            issues.push({
              kind: overY > TOLERANCE ? "overflow-y" : "overflow-x",
              detail: `${el.tagName.toLowerCase()} 溢出 ${Math.max(overY, overX)}px`,
            });
            count++;
          }
        });
        if (issues.length > 0) pages.push({ page: idx + 1, issues });
      });
      return pages;
    });
    return { ok: result.length === 0, pages: result };
  } finally {
    await page.close();
  }
}
export async function validateSlideHtmlFile(filePath: string): Promise<SlideValidation> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(pathToFileURL(path.resolve(filePath)).href, {
      waitUntil: "networkidle0",
      timeout: 30_000,
    });
    const issues = await page.evaluate(() => {
      const root = document.querySelector("main.slide");
      if (!root) return [{ kind: "overflow-y" as const, detail: "missing main.slide" }];
      const found: Array<{ kind: "overflow-y" | "overflow-x"; detail: string }> = [];
      const TOLERANCE = 8;
      const rootRect = root.getBoundingClientRect();
      const all = root.querySelectorAll("*");
      let count = 0;
      for (const el of all) {
        // 只测"内容型"元素：含文本的叶子节点或媒体元素。
        // 空装饰 div 出血（背景圆形等）是正常设计，不报。
        const isMedia = /^(img|svg|video|canvas|table)$/.test(el.tagName.toLowerCase());
        const isTextLeaf = el.children.length === 0 && (el.textContent ?? "").trim().length > 0;
        if (!isMedia && !isTextLeaf) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const bottom = rect.bottom - rootRect.top;
        const right = rect.right - rootRect.left;
        const overY = Math.round(bottom - 1080);
        const overX = Math.round(right - 1920);
        if (overY > TOLERANCE || overX > TOLERANCE) {
          const label = `${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").split(" ")[0]}`;
          found.push({
            kind: overY > TOLERANCE ? "overflow-y" : "overflow-x",
            detail: `${label} 溢出 ${Math.max(overY, overX)}px`,
          });
          if (++count >= 5) break;
        }
      }
      return found;
    });
    return { ok: issues.length === 0, issues };
  } finally {
    await page.close();
  }
}
