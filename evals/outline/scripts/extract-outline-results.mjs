import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const inputIndex = args.indexOf("--input");
if (inputIndex < 0 || !args[inputIndex + 1]) {
  throw new Error("Usage: node evals/outline/scripts/extract-outline-results.mjs --input <extracted-batch-directory> [--output <directory>]");
}
const inputDir = resolve(process.cwd(), args[inputIndex + 1]);
const outputIndex = args.indexOf("--output");
const outputDir = outputIndex >= 0 && args[outputIndex + 1]
  ? resolve(process.cwd(), args[outputIndex + 1])
  : resolve(inputDir, "outline-results");

const manifest = JSON.parse(await readFile(resolve(inputDir, "batch-test.json"), "utf8"));
if (!Array.isArray(manifest.cases)) throw new Error("Batch test manifest does not contain cases.");
const casesWithoutProvidedRequirements = manifest.cases
  .filter((item) => !item?.provided_requirements)
  .map((item) => item?.case_id)
  .filter(Boolean);
if (casesWithoutProvidedRequirements.length > 0) {
  throw new Error(
    `This is not a valid provided-Requirements Outline evaluation: ${casesWithoutProvidedRequirements.length} case(s) `
    + `did not persist provided_requirements (for example: ${casesWithoutProvidedRequirements.slice(0, 3).join(", ")}). `
    + "Rebuild the PPT app bundle, restart anna-app dev, and rerun the batch.",
  );
}
const caseDirectories = manifest.cases
  .map((item) => typeof item?.case_id === "string" ? item.case_id : "")
  .filter(Boolean)
  .sort();
const results = [];

for (const caseId of caseDirectories) {
  const caseDir = resolve(inputDir, caseId);
  const record = JSON.parse(await readFile(resolve(caseDir, "case.json"), "utf8"));
  const workspaceParent = resolve(caseDir, "workspace");
  const workspaces = (await readdir(workspaceParent, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  if (workspaces.length !== 1) throw new Error(`${caseId} must contain exactly one workspace.`);
  const outline = JSON.parse(await readFile(resolve(workspaceParent, workspaces[0].name, "outline.json"), "utf8"));
  results.push({
    case_id: caseId,
    brief: record.provided_requirements?.source?.brief ?? record.brief,
    outline,
  });
}

await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, "outlines.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
const markdown = [
  "# Outline Eval Results",
  "",
  `Cases: ${results.length}`,
  "",
  ...results.flatMap((result) => [
    `## ${result.case_id}`,
    "",
    "### Brief used",
    "",
    result.brief,
    "",
    "### Outline",
    "",
    "```json",
    JSON.stringify(result.outline, null, 2),
    "```",
    "",
  ]),
].join("\n");
await writeFile(resolve(outputDir, "outlines.md"), markdown, "utf8");
console.log(`Extracted ${results.length} outlines to ${outputDir}`);
