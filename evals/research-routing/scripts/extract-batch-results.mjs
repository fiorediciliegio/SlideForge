import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--batch-dir");
if (sourceIndex < 0 || !args[sourceIndex + 1]) {
  throw new Error("Usage: node evals/research-routing/scripts/extract-batch-results.mjs --batch-dir <unzipped-batch-directory> [--output <results.json>]");
}
const source = resolve(process.cwd(), args[sourceIndex + 1]);
const outputIndex = args.indexOf("--output");
const output = resolve(process.cwd(), outputIndex >= 0 && args[outputIndex + 1] ? args[outputIndex + 1] : "research-routing-stage1-results.json");
const manifest = JSON.parse(await readFile(resolve(source, "batch-test.json"), "utf8"));
if (manifest.target_stage !== "research-routing-completed") throw new Error("The batch directory is not a research-routing run.");
function failureKind(error) {
  if (!error) return "unknown";
  if (/cancelled|canceled|abort/iu.test(error)) return "cancelled";
  if (/parseable JSON|invalid JSON|JSON value|incomplete recommendation/iu.test(error)) return "json_format";
  return "invocation";
}
const results = await Promise.all((await readdir(source, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map(async (entry) => JSON.parse(await readFile(resolve(source, entry.name, "case.json"), "utf8"))));
const normalized = results.map((item) => ({
  case_id: item.research_routing?.baseline_id ?? item.brief_id,
  prompt_version: item.research_routing?.prompt_version,
  prompt_hash: item.research_routing?.prompt_hash,
  status: item.status === "completed" && item.research_routing_result ? "completed" : "failed",
  expected: item.research_routing?.expected,
  actual: item.research_routing_result?.actual,
  requested_model: item.research_routing_result?.requested_model ?? null,
  actual_model: item.research_routing_result?.actual_model ?? null,
  latency_ms: item.research_routing_result?.latency_ms ?? null,
  token_usage: item.research_routing_result?.token_usage ?? null,
  json_repair_count: item.research_routing_result?.json_repair_count ?? 0,
  retry_count: item.research_routing_result?.retry_count ?? 0,
  retry_reasons: item.research_routing_result?.retry_reasons ?? [],
  failure_kind: item.status === "completed" && item.research_routing_result ? null : failureKind(item.error),
  error: item.error ?? null,
}));
const gitCommit = new Set(results.map((item) => item.research_routing?.git_commit).filter(Boolean));
if (gitCommit.size > 1) throw new Error("The batch contains more than one Git commit.");
await writeFile(output, `${JSON.stringify({ schema_version: 1, run_id: manifest.test_id, generated_at: new Date().toISOString(), git_commit: [...gitCommit][0] ?? null, results: normalized }, null, 2)}\n`, "utf8");
console.log(`Extracted ${normalized.length} routing results to ${output}.`);
