/**
 * M0/M1 命令行入口（能力层的薄客户端）。
 *
 * 用法：
 *   OPENAI_API_KEY=sk-... node --import tsx/esm scripts/m0-generate.ts \
 *     --brief "Q3 销售复盘" --pages 8 --out artifacts/m0-runs/q3.pptx
 */
import path from "node:path";
import { createDeck, exportDeck, type DeckEvent } from "../src/capabilities/deck.js";

const args = process.argv.slice(2);
function argOf(name: string, fallback?: string): string {
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing argument ${name}`);
}
const brief = argOf("--brief");
const pageCount = Number(argOf("--pages", "8"));
const concurrency = Number(argOf("--concurrency", "3"));
const outPath = path.resolve(argOf("--out", "artifacts/m0-runs/deck.pptx"));

const onEvent = (event: DeckEvent) => {
  console.log(`  [${event.stage}]${event.page ? ` p${event.page}` : ""} ${event.message}`);
};

  console.log(`SlideForge · brief="${brief}" · pages=${pageCount} · 并发=${concurrency}`);
  const deck = await createDeck({ brief, pageCount, concurrency, onEvent });
  console.log(`工作区：${deck.runDir}`);
  const result = await exportDeck({ runDir: deck.runDir, outPath });
  console.log(`\n✅ 完成：${result.outPath}`);
  console.log(`页数=${result.slideCount} · 大小=${result.sizeBytes}B · 导出警告=${result.warnings.length}`);
  if (deck.overflowWarnings.length > 0) {
    console.log(`⚠ 溢出遗留：${deck.overflowWarnings.map((w) => `第${w.page}页`).join("、")}`);
  }
