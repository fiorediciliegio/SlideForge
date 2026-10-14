import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--batch-dir");
if (sourceIndex < 0 || !args[sourceIndex + 1]) {
  throw new Error("Usage: node evals/research-routing/scripts/score-stage3.mjs --batch-dir <unzipped-batch-directory> [--output <directory>]");
}
const source = resolve(process.cwd(), args[sourceIndex + 1]);
const manifest = JSON.parse(await readFile(resolve(source, "batch-test.json"), "utf8"));
if (manifest.target_stage !== "image-research-completed") throw new Error("Stage 3 requires an image-research-completed batch export.");
const optionalJson = async (path) => {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
};
const elapsed = (item) => item.started_at && item.ended_at ? Math.max(0, Date.parse(item.ended_at) - Date.parse(item.started_at)) : null;
const tokenTotal = (item) => {
  const value = item.token_usage?.total?.total_tokens ?? item.token_usage?.total_tokens;
  return Number.isFinite(value) ? Number(value) : null;
};
const fields = ["audience", "purpose", "desired_outcome", "slide_count", "output_language", "visual_tone", "visual_style_preset"];
const caseDirs = (await readdir(source, { withFileTypes: true })).filter((entry) => entry.isDirectory());
const entries = await Promise.all(caseDirs.map(async (entry) => {
  const item = JSON.parse(await readFile(resolve(source, entry.name, "case.json"), "utf8"));
  if (!item.research_routing) return null;
  const requirements = await optionalJson(resolve(source, entry.name, "workspace", item.workspace_id, "requirements.json"));
  const outline = await optionalJson(resolve(source, entry.name, "workspace", item.workspace_id, "outline.json"));
  return {
    case_id: item.research_routing.baseline_id,
    prompt_version: item.research_routing.prompt_version,
    status: item.status,
    error: item.error,
    requirements,
    outline_present: Boolean(outline),
    token_total: tokenTotal(item),
    latency_ms: elapsed(item),
  };
})).then((items) => items.filter(Boolean));
const byCase = new Map();
for (const item of entries) {
  const group = byCase.get(item.case_id) ?? [];
  group.push(item);
  byCase.set(item.case_id, group);
}
const comparisons = [...byCase.entries()].map(([case_id, items]) => {
  const production = items.find((item) => item.prompt_version === "v1") ?? null;
  const candidates = items.filter((item) => item.prompt_version !== "v1");
  return candidates.map((candidate) => {
    const invariant_violations = production?.requirements && candidate.requirements
      ? fields.filter((field) => JSON.stringify(production.requirements.selections?.[field]) !== JSON.stringify(candidate.requirements.selections?.[field]) || (field === "output_language" && production.requirements.source?.brief !== candidate.requirements.source?.brief))
      : ["requirements unavailable"];
    const recommendation_enabled = (requirements) => requirements
      ? requirements.research?.web?.enabled === requirements.research?.web?.recommended && requirements.research?.images?.enabled === requirements.research?.images?.recommended
      : false;
    return {
      case_id,
      candidate_prompt: candidate.prompt_version,
      production_status: production?.status ?? "missing",
      candidate_status: candidate.status,
      invariant_violations,
      production_outline_present: production?.outline_present ?? false,
      candidate_outline_present: candidate.outline_present,
      production_recommendation_enabled: recommendation_enabled(production?.requirements),
      candidate_recommendation_enabled: recommendation_enabled(candidate.requirements),
      production_tokens: production?.token_total ?? null,
      candidate_tokens: candidate.token_total,
      production_latency_ms: production?.latency_ms ?? null,
      candidate_latency_ms: candidate.latency_ms,
      production_error: production?.error ?? null,
      candidate_error: candidate.error,
    };
  });
}).flat();
const mean = (values) => {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};
const growth = (before, after) => before === null || after === null || before === 0 ? null : (after - before) / before;
const summary = {
  comparisons: comparisons.length,
  repaired_cases: comparisons.filter((item) => item.production_status !== "completed" && item.candidate_status === "completed"),
  regressions: comparisons.filter((item) => item.production_status === "completed" && item.candidate_status !== "completed"),
  sustained_failures: comparisons.filter((item) => item.production_status !== "completed" && item.candidate_status !== "completed"),
  invariant_violations: comparisons.filter((item) => item.invariant_violations.length > 0),
  outline_regressions: comparisons.filter((item) => item.production_outline_present && !item.candidate_outline_present),
  mean_token_growth: growth(mean(comparisons.map((item) => item.production_tokens)), mean(comparisons.map((item) => item.candidate_tokens))),
  mean_latency_growth: growth(mean(comparisons.map((item) => item.production_latency_ms)), mean(comparisons.map((item) => item.candidate_latency_ms))),
};
const result = { schema_version: 1, phase: "stage-3", generated_at: new Date().toISOString(), source_run_id: manifest.test_id, summary, comparisons };
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 && args[outputIndex + 1] ? resolve(process.cwd(), args[outputIndex + 1]) : resolve(process.cwd(), "evals", "research-routing", "reports", `stage3-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
await mkdir(output, { recursive: true });
const lines = [
  "# Research Routing Eval - Stage 3", "", `Source run: ${manifest.test_id}`, "",
  `- Repaired cases: ${summary.repaired_cases.length}`,
  `- New regressions: ${summary.regressions.length}`,
  `- Sustained failures: ${summary.sustained_failures.length}`,
  `- Requirements invariant violations: ${summary.invariant_violations.length}`,
  `- Outline regressions: ${summary.outline_regressions.length}`,
  `- Mean token growth: ${summary.mean_token_growth === null ? "unavailable" : `${(summary.mean_token_growth * 100).toFixed(1)}%`}`,
  `- Mean latency growth: ${summary.mean_latency_growth === null ? "unavailable" : `${(summary.mean_latency_growth * 100).toFixed(1)}%`}`,
  "", "See comparisons.json for the per-case production versus candidate detail.",
];
await writeFile(resolve(output, "score.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
await writeFile(resolve(output, "comparisons.json"), `${JSON.stringify(comparisons, null, 2)}\n`, "utf8");
await writeFile(resolve(output, "report.md"), `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote Stage 3 report to ${output}.`);
