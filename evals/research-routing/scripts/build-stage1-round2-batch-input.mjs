import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFixturesFromWorkbook } from "../src/fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const source = resolve(process.cwd(), valueAfter("--source")
  ?? resolve(root, "..", "..", "..", "eval", "search测试数据_new.xlsx"));
const fixtures = await readFixturesFromWorkbook(source, { promptStageIndex: 1 });
if (fixtures.cases.length !== 50 || fixtures.prompts.length !== 4) {
  throw new Error(`Expected exactly 50 cases and 4 round-two prompts; found ${fixtures.cases.length} cases and ${fixtures.prompts.length} prompts.`);
}
const expected_by_brief_id = Object.fromEntries(fixtures.cases.map((item) => [item.case_id, item.expected]));
const git_commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const input = {
  test_id: `research-routing-stage1-round2-${new Date().toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14)}`,
  target_stage: "research-routing-completed",
  repeat: 1,
  briefs: fixtures.cases.map((item) => ({ id: item.case_id, brief: item.brief })),
  research_routing: {
    git_commit,
    prompts: fixtures.prompts.map(({ prompt_version, prompt, prompt_hash }) => ({ prompt_version, prompt, prompt_hash })),
    expected_by_brief_id,
  },
};
const output = resolve(root, "config", valueAfter("--output") ?? "stage1-round2-batch-input.json");
await writeFile(output, `${JSON.stringify(input, null, 2)}\n`, "utf8");
console.log(`Wrote ${fixtures.prompts.length * fixtures.cases.length} routing cases to ${output}. Import this JSON in Batch Testing.`);
