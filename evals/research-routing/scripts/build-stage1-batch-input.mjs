import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { sha256 } from "../src/fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const requestedVersions = args.flatMap((value, index) => value === "--prompt" ? [args[index + 1]] : [])
  .filter((value) => typeof value === "string" && /^v(?:[1-9]|10|11)$/u.test(value));
if (args.includes("--prompt") && requestedVersions.length === 0) {
  throw new Error("Each --prompt value must be v1 through v11.");
}
const cases = JSON.parse(await readFile(resolve(root, "cases", "research-routing-v1.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(root, "prompts", "manifest.json"), "utf8"));
const selectedVersions = requestedVersions.length === 0 ? null : new Set(requestedVersions);
const promptEntries = manifest.prompts.filter((item) => selectedVersions === null || selectedVersions.has(item.prompt_version));
if (promptEntries.length === 0) throw new Error("No requested Prompt version exists in prompts/manifest.json.");
const prompts = await Promise.all(promptEntries.map(async (item) => {
  const prompt = (await readFile(resolve(root, "prompts", `router-${item.prompt_version}.txt`), "utf8")).trimEnd();
  const promptHash = sha256(prompt);
  if (promptHash !== item.prompt_hash) throw new Error(`Prompt hash changed without manifest update: ${item.prompt_version}. Run sync-fixtures.mjs.`);
  return { prompt_version: item.prompt_version, prompt, prompt_hash: promptHash };
}));
const expected_by_brief_id = Object.fromEntries(cases.cases.map((item) => [item.case_id, item.expected]));
const git_commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const input = {
  test_id: `research-routing-stage1-${new Date().toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14)}`,
  target_stage: "research-routing-completed",
  repeat: 1,
  briefs: cases.cases.map((item) => ({ id: item.case_id, brief: item.brief })),
  research_routing: { git_commit, prompts, expected_by_brief_id },
};
const outputIndex = args.indexOf("--output");
const output = resolve(root, "config", outputIndex >= 0 && args[outputIndex + 1]
  ? args[outputIndex + 1]
  : selectedVersions === null ? "stage1-batch-input.json" : `stage1-smoke-${prompts.map((item) => item.prompt_version).join("-")}-batch-input.json`);
await writeFile(output, `${JSON.stringify(input, null, 2)}\n`, "utf8");
console.log(`Wrote ${prompts.length * cases.cases.length} routing cases to ${output}. Import this JSON in Batch Testing.`);
