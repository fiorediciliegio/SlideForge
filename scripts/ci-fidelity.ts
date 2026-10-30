/**
 * D6 · 导出保真 CI 回归：对 evals/export/cases 全量夹具跑
 * ① deck 内容溢出检查（无头 Chrome 测量）② 导出零警告 ③ pptx 结构（页数+文本片段）。
 * 用法：node --import tsx/esm scripts/ci-fidelity.ts（任一用例失败则 exit 1）
 */
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import { existsSync } from "node:fs";

import { runExportOnly } from "../executas/ppt-engine/src/export-only/index.js";
import { validateDeckHtmlFile, closeValidatorBrowser } from "./m0/validatePage.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const casesRoot = path.join(repoRoot, "evals", "export", "cases");
const outDir = path.resolve(repoRoot, "..", "artifacts", "ci-fidelity", String(Date.now()));

process.env.SLIDEFORGE_WORKSPACE_DIR ??= path.join(os.tmpdir(), "slideforge-ci-workspace");
if (!process.env.CHROME_PATH) {
  for (const candidate of [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ]) {
    if (existsSync(candidate)) { process.env.CHROME_PATH = candidate; break; }
  }
}

interface CaseResult {
  id: string;
  overflow: boolean;
  exportStatus: string;
  exportWarnings: number;
  slideCount: number;
  textRuns: number;
  passed: boolean;
  error?: string;
}

const entries = await readdir(casesRoot, { withFileTypes: true });
const results: CaseResult[] = [];
const resultsMeta = new Map<string, string[]>();

for (const entry of entries) {
  if (!entry.isDirectory() || entry.name === "assets") continue;
  const caseId = entry.name;
  const meta = JSON.parse(await readFile(path.join(casesRoot, caseId, "case.json"), "utf8"));
  const result: CaseResult = { id: caseId, overflow: false, exportStatus: "", exportWarnings: 0, slideCount: 0, textRuns: 0, passed: false };
  try {
    const layout = await validateDeckHtmlFile(path.join(casesRoot, caseId, "deck.html"));
    result.overflow = !layout.ok;

    const exported = await runExportOnly({
      request_id: `ci-${caseId}`,
      format: "pptx",
      source_root: casesRoot,
      deck_html_file: `${caseId}/deck.html`,
      expected_slide_count: meta.expected_slide_count,
      title: caseId,
      output_dir: outDir,
    });
    result.exportStatus = exported.status;
    result.exportWarnings = exported.warning_count;
    result.slideCount = exported.slide_count;
    resultsMeta.set(caseId, [...exported.warnings, ...exported.font_embed_warnings]);
    if (exported.status === "failed" && exported.error) {
      console.log(`   导出错误：${exported.error.message.slice(0, 220)}`);
    }

    if (exported.status === "completed" && exported.output_path) {
      const { execSync } = await import("node:child_process");
      const runs = execSync(
        `python -c "import zipfile,re;z=zipfile.ZipFile(r'${exported.output_path}');print(sum(len(re.findall(r'<a:t>',z.read(n).decode('utf-8'))) for n in z.namelist() if re.match(r'ppt/slides/slide\\d+\\.xml$',n)))"`,
        { encoding: "utf8" },
      );
      result.textRuns = Number(runs.trim());
    }
    result.passed =
      !result.overflow &&
      exported.status === "completed" &&
      exported.warnings.length === 0 && // 非字体警告才算回归；字体嵌入警告为环境性提示
      exported.slide_count === meta.expected_slide_count &&
      result.textRuns > 0;
  } catch (error) {
    result.error = error instanceof Error ? error.message.slice(0, 200) : String(error);
  }
  results.push(result);
  console.log(`${result.passed ? "✅" : "❌"} ${caseId}  溢出=${result.overflow} 导出=${result.exportStatus} 警告=${result.exportWarnings} 页数=${result.slideCount} 文本=${result.textRuns}${result.error ? ` 错误=${result.error}` : ""}`);
  if (result.exportWarnings > 0) {
    const exported = resultsMeta.get(caseId);
    if (exported?.length) console.log(`   警告明细：${exported.join("；").slice(0, 300)}`);
  }
}

await closeValidatorBrowser();
const failed = results.filter((r) => !r.passed);
console.log(`\n保真回归：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exit(1);
