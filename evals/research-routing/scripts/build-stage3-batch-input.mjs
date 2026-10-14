import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../src/fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const versions = args.flatMap((value, index) => value === "--prompt" ? [args[index + 1]] : [])
  .filter((value) => typeof value === "string" && /^v(?:[1-9]|10)$/u.test(value));
const caseIds = args.flatMap((value, index) => value === "--case" ? [args[index + 1]] : [])
  .filter((value) => typeof value === "string" && /^case-\d{3}$/u.test(value));
if (versions.length !== 2 || new Set(versions).size !== 2 || !versions.includes("v1")) {
  throw new Error("Stage 3 requires exactly two --prompt values, including production v1.");
}
if (caseIds.length === 0 || caseIds.length > 20 || new Set(caseIds).size !== caseIds.length) {
  throw new Error("Stage 3 requires 1-20 distinct --case values (normally about 10 high-risk cases).");
}
const modelIndex = args.indexOf("--requested-model");
const requestedModel = modelIndex >= 0 ? args[modelIndex + 1]?.trim() : "";
if (!requestedModel) throw new Error("Stage 3 requires --requested-model <Local-Agent-model-label>.");
const fixtures = JSON.parse(await readFile(resolve(root, "cases", "research-routing-v1.json"), "utf8"));
const selectedCases = fixtures.cases.filter((item) => caseIds.includes(item.case_id));
if (selectedCases.length !== caseIds.length) throw new Error("One or more requested --case values do not exist in the fixture.");
const manifest = JSON.parse(await readFile(resolve(root, "prompts", "manifest.json"), "utf8"));
const prompts = await Promise.all(manifest.prompts.filter((item) => versions.includes(item.prompt_version)).map(async (item) => {
  const prompt = (await readFile(resolve(root, "prompts", `router-${item.prompt_version}.txt`), "utf8")).trimEnd();
  if (sha256(prompt) !== item.prompt_hash) throw new Error(`Prompt hash changed without manifest update: ${item.prompt_version}.`);
  return { prompt_version: item.prompt_version, prompt, prompt_hash: item.prompt_hash };
}));
const git_commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const input = {
  test_id: `research-routing-stage3-${new Date().toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14)}`,
  target_stage: "image-research-completed",
  repeat: 1,
  briefs: selectedCases.map((item) => ({ id: item.case_id, brief: item.brief })),
  research_routing: {
    git_commit,
    requested_model: requestedModel,
    prompts,
    expected_by_brief_id: Object.fromEntries(selectedCases.map((item) => [item.case_id, item.expected])),
  },
};
const outputIndex = args.indexOf("--output");
const output = resolve(root, "config", outputIndex >= 0 && args[outputIndex + 1] ? args[outputIndex + 1] : "stage3-batch-input.json");
await writeFile(output, `${JSON.stringify(input, null, 2)}\n`, "utf8");
console.log(`Wrote ${selectedCases.length * prompts.length} Stage 3 pipeline cases to ${output}.`);
