/**
 * M0 第 0 步 spike：脱离宿主，进程内直调引擎导出 pptx。
 * 用法：node --import tsx/esm scripts/m0-spike-export.ts [caseId]
 */
import path from "node:path";
import os from "node:os";
import { runExportOnly } from "../executas/ppt-engine/src/export-only/index.js";

const caseId = process.argv[2] ?? "02-chinese-dashboard";
const repoRoot = path.resolve(import.meta.dirname, "..");
const casesRoot = path.join(repoRoot, "evals", "export", "cases");
const outputDir = path.join(repoRoot, "..", "artifacts", "m0-spike");

process.env.SLIDEFORGE_WORKSPACE_DIR = path.join(os.tmpdir(), "slideforge-m0-workspace");

console.log(`[spike] case=${caseId}`);
console.log(`[spike] output=${outputDir}`);

const result = await runExportOnly({
  request_id: `m0-spike-${caseId}`,
  format: "pptx",
  source_root: casesRoot,
  deck_html_file: `${caseId}/deck.html`,
  expected_slide_count: 1,
  title: "M0 spike 导出验证",
  output_dir: outputDir,
});

console.log(JSON.stringify({
  status: result.status,
  phase: result.phase,
  output_path: result.output_path,
  slide_count: result.slide_count,
  size_bytes: result.size_bytes,
  warnings: result.warnings,
  error: result.error,
  timings_ms: result.timings_ms,
}, null, 2));

process.exit(result.status === "completed" ? 0 : 1);
