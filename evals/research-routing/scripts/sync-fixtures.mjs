import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixturesFromWorkbook, v11PromptFromV7 } from "../src/fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--source");
const source = sourceIndex >= 0
  ? resolve(process.cwd(), args[sourceIndex + 1] ?? "")
  : resolve(root, "..", "..", "..", "eval", "search测试数据.xlsx");
const workbook = await readFile(source);
const fixtures = fixturesFromWorkbook(workbook);
const prompts = [...fixtures.prompts, v11PromptFromV7(fixtures.prompts.find((item) => item.prompt_version === "v7"))];
const casesDir = resolve(root, "cases");
const promptsDir = resolve(root, "prompts");
await mkdir(casesDir, { recursive: true });
await mkdir(promptsDir, { recursive: true });
const workbookDestination = resolve(casesDir, "research-routing-v1.xlsx");
await writeFile(workbookDestination, workbook);
await writeFile(resolve(casesDir, "research-routing-v1.json"), `${JSON.stringify({ schema_version: 1, cases: fixtures.cases }, null, 2)}\n`, "utf8");
for (const item of prompts) {
  await writeFile(resolve(promptsDir, `router-${item.prompt_version}.txt`), `${item.prompt}\n`, "utf8");
}
for (const name of ["router-v12.txt"]) {
  await rm(resolve(promptsDir, name), { force: true });
}
await writeFile(resolve(promptsDir, "manifest.json"), `${JSON.stringify({ schema_version: 1, prompts: prompts.map(({ prompt, ...item }) => item) }, null, 2)}\n`, "utf8");
console.log(`Synchronized ${fixtures.cases.length} cases and ${prompts.length} prompts from ${source}.`);
