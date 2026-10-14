import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stage1MarkdownReport } from "../src/report.mjs";
import { scoreStage1 } from "../src/scoring.mjs";

const args = process.argv.slice(2);
const resultsIndex = args.indexOf("--results");
if (resultsIndex < 0 || !args[resultsIndex + 1]) {
  throw new Error("Usage: node evals/research-routing/scripts/score-stage1.mjs --results <batch-testing-results.json> [--output <directory>]");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 && args[outputIndex + 1]
  ? resolve(process.cwd(), args[outputIndex + 1])
  : resolve(root, "reports", `stage1-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
const result = scoreStage1(JSON.parse(await readFile(resolve(process.cwd(), args[resultsIndex + 1]), "utf8")));
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "score.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
await writeFile(resolve(output, "case-details.json"), `${JSON.stringify(result.case_details, null, 2)}\n`, "utf8");
await writeFile(resolve(output, "report.md"), stage1MarkdownReport(result), "utf8");
console.log(`Wrote Stage 1 report to ${output}.`);
