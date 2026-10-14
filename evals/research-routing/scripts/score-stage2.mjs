import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stage2MarkdownReport } from "../src/stage2-report.mjs";
import { scoreStage2 } from "../src/stage2.mjs";

const args = process.argv.slice(2);
const resultPaths = args.flatMap((value, index) => value === "--results" && args[index + 1] ? [args[index + 1]] : []);
if (resultPaths.length === 0) {
  throw new Error("Usage: node evals/research-routing/scripts/score-stage2.mjs --results <run-1.json> [--results <run-2.json> ...] [--output <directory>]");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 && args[outputIndex + 1]
  ? resolve(process.cwd(), args[outputIndex + 1])
  : resolve(root, "reports", `stage2-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
const documents = await Promise.all(resultPaths.map(async (path) => JSON.parse(await readFile(resolve(process.cwd(), path), "utf8"))));
const result = scoreStage2(documents);
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "score.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
await writeFile(resolve(output, "case-details.json"), `${JSON.stringify(result.case_details, null, 2)}\n`, "utf8");
await writeFile(resolve(output, "report.md"), stage2MarkdownReport(result), "utf8");
console.log(`Wrote Stage 2 report to ${output}.`);
