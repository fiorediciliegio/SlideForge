/**
 * D3 · 从 PPTX 提取每页文本（确定性解析 slide XML，不经模型）。
 * 用于"用户在 WPS 改过的文件回传"：逐页比对原始 HTML 文本，识别用户改了哪几页。
 */
import { createRequire } from "node:module";

const engineRequire = createRequire(
  new URL("../../executas/ppt-engine/package.json", import.meta.url),
) as (id: string) => any;
const JSZip = engineRequire("jszip");

/** 返回按页码排序的文本数组（下标 0 = 第 1 页），每项为该页全部文本片段。 */
export async function extractPptxSlideTexts(pptxBuffer: Buffer): Promise<string[][]> {
  const zip = await JSZip.loadAsync(pptxBuffer);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)![1]) - Number(b.match(/slide(\d+)/)![1]));

  const pages: string[][] = [];
  for (const name of slideNames) {
    const xml = await zip.file(name)!.async("string");
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)]
      .map((match) => match[1].trim())
      .filter((text) => text.length > 0);
    pages.push(texts);
  }
  return pages;
}

/** 页面文本 → 规范化集合（用于与原始 HTML 文本比对）。 */
export function normalizeTextSet(texts: string[]): Set<string> {
  return new Set(texts.map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean));
}
