/**
 * M2-1 · deck 缩略图渲染：逐 shell 截图，供 MCP 图片消息回传。
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { getSharedBrowser } from "./validatePage.js";

export interface DeckThumbnail {
  page: number;
  filePath: string;
}

/** 把 deck.html 的指定页渲染为 JPEG 缩略图（默认全部页）。 */
export async function renderDeckThumbnails(
  runDir: string,
  pages?: number[],
): Promise<DeckThumbnail[]> {
  const deckPath = path.resolve(runDir, "deck.html");
  const outDir = path.join(path.resolve(runDir), "thumbnails");
  await mkdir(outDir, { recursive: true });

  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(pathToFileURL(deckPath).href, { waitUntil: "networkidle0", timeout: 60_000 });
    const shellCount = await page.evaluate(
      () => document.querySelectorAll("[data-presenton-slide-shell]").length,
    );
    const targets = pages?.length ? pages : Array.from({ length: shellCount }, (_, i) => i + 1);
    const results: DeckThumbnail[] = [];
    for (const pageNumber of targets) {
      if (pageNumber < 1 || pageNumber > shellCount) continue;
      const handle = await page.$(`[data-presenton-page-id="page-${pageNumber}"]`);
      if (!handle) continue;
      await handle.evaluate((el) => el.scrollIntoView());
      const filePath = path.join(outDir, `page-${pageNumber}.jpg`);
      await handle.screenshot({ path: filePath, type: "jpeg", quality: 85 });
      results.push({ page: pageNumber, filePath });
    }
    return results;
  } finally {
    await page.close();
  }
}
