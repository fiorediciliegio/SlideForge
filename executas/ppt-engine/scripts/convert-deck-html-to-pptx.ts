import path from "node:path";
import { rename } from "node:fs/promises";

import { convertDeckHtmlToPptx } from "../src/pptx-export/dom-to-pptx.js";

const [htmlPath, outputPath, title = "deck", selectionArg] = process.argv.slice(2);
if (!htmlPath || !path.isAbsolute(htmlPath) || !outputPath || !path.isAbsolute(outputPath)) {
  throw new Error("Usage: convert-deck-html-to-pptx.ts <absolute-html-path> <absolute-pptx-path> [title] [single-slide-index|--pages=2,3,4]");
}

const pageNumbers = selectionArg?.startsWith("--pages=")
  ? selectionArg.slice("--pages=".length).split(",").map((value) => Number(value.trim()))
  : undefined;
if (pageNumbers && (pageNumbers.length === 0 || pageNumbers.some((pageNumber) => !Number.isInteger(pageNumber) || pageNumber < 1))) {
  throw new Error("--pages must contain one or more positive one-based page numbers");
}
const singleSlideIndex = selectionArg === undefined || pageNumbers ? undefined : Number(selectionArg);
if (singleSlideIndex !== undefined && (!Number.isInteger(singleSlideIndex) || singleSlideIndex < 0)) {
  throw new Error("singleSlideIndex must be a non-negative integer");
}
const result = await convertDeckHtmlToPptx({
  htmlPath,
  outputPath,
  title,
  ...(singleSlideIndex === undefined ? {} : { singleSlideIndex }),
  ...(pageNumbers === undefined ? {} : { pageNumbers }),
});
await rename(result.outputPath, outputPath);
process.stdout.write(`${JSON.stringify({
  pptx_path: outputPath,
  slide_count: result.slideCount,
  size_bytes: result.sizeBytes,
  warning_count: result.warningCount,
})}\n`);
