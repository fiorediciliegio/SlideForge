import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../src/fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const versions = args.flatMap((value, index) => value === "--prompt" ? [args[index + 1]] : [])
  .filter((value) => typeof value === "string" && /^v(?:[1-9]|10)$/u.test(value));
const modelIndex = args.indexOf("--requested-model");
const requestedModel = modelIndex >= 0 ? args[modelIndex + 1]?.trim() : "";
const repeatIndex = args.indexOf("--repeat");
const repeat = repeatIndex >= 0 ? Number(args[repeatIndex + 1]) : 3;
if (versions.length < 1 || versions.length > 4 || new Set(versions).size !== versions.length) {
  throw new Error("Stage 2 requires 1-4 distinct --prompt versions.");
}
if (!requestedModel) throw new Error("Stage 2 requires --requested-model <Local-Agent-model-label>.");
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error("--repeat must be an integer from 1 through 20.");

const cases = JSON.parse(await readFile(resolve(root, "cases", "research-routing-v1.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(root, "prompts", "manifest.json"), "utf8"));
const selected = new Set(versions);
const prompts = await Promise.all(manifest.prompts.filter((item) => selected.has(item.prompt_version)).map(async (item) => {
  const prompt = (await readFile(resolve(root, "prompts", `router-${item.prompt_version}.txt`), "utf8")).trimEnd();
  if (sha256(prompt) !== item.prompt_hash) throw new Error(`Prompt hash changed without manifest update: ${item.prompt_version}.`);
  return { prompt_version: item.prompt_version, prompt, prompt_hash: item.prompt_hash };
}));
const git_commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const input = {
  test_id: `research-routing-stage2-${requestedModel.replace(/[^a-zA-Z0-9_-]+/gu, "-").slice(0, 32)}-${new Date().toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14)}`,
  target_stage: "research-routing-completed",
  repeat,
  briefs: cases.cases.map((item) => ({ id: item.case_id, brief: item.brief })),
  research_routing: {
    git_commit,
    requested_model: requestedModel,
    prompts,
    expected_by_brief_id: Object.fromEntries(cases.cases.map((item) => [item.case_id, item.expected])),
  },
};
const outputIndex = args.indexOf("--output");
const output = resolve(root, "config", outputIndex >= 0 && args[outputIndex + 1]
  ? args[outputIndex + 1]
  : `stage2-${requestedModel.replace(/[^a-zA-Z0-9_-]+/gu, "-").slice(0, 32)}-batch-input.json`);
await writeFile(output, `${JSON.stringify(input, null, 2)}\n`, "utf8");
console.log(`Wrote ${prompts.length * cases.cases.length * repeat} Stage 2 cases to ${output}. Select ${requestedModel} in Local Agent before starting Batch Testing.`);
