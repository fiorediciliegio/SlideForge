function percentage(value) {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function cell(value) {
  return value === null || value === undefined ? "—" : String(value);
}

export function stage1MarkdownReport(score) {
  const lines = [
    "# Research Routing Eval — Stage 1",
    "",
    `Generated: ${score.generated_at}`,
    `Source run: ${score.source_run_id ?? "not recorded"}`,
    `Git commit: ${score.git_commit ?? "not recorded"}`,
    "",
    "## Prompt comparison",
    "",
    "| Rank | Prompt | Macro F1 | Exact match | Web FP/FN | Image FP/FN | JSON errors | Invocation failures | Mean tokens | Mean latency |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...score.prompt_comparison.map((item, index) => `| ${index + 1} | ${item.prompt_version} | ${percentage(item.macro_f1)} | ${percentage(item.exact_match_rate)} | ${item.web.fp}/${item.web.fn} | ${item.images.fp}/${item.images.fn} | ${percentage(item.json_error_rate)} | ${item.failures.invocation} | ${cell(item.mean_total_tokens)} | ${cell(item.mean_latency_ms)} ms |`),
    "",
    "## Recommended shortlist",
    "",
    ...score.prompt_comparison.slice(0, 3).map((item) => `- ${item.prompt_version}: Macro F1 ${percentage(item.macro_f1)}, exact match ${percentage(item.exact_match_rate)}.`),
    "",
    "## Flaky cases",
    "",
    score.flaky_cases.length === 0 ? "None detected in this run." : score.flaky_cases.map((item) => `- ${item.key}: ${item.outcomes.join(", ")}`).join("\n"),
    "",
    "## Notes",
    "",
    "- Stage 1 is a one-repeat screening run; no stability conclusion should be drawn from it.",
    "- Results only score `recommended`; `enabled` is deliberately excluded.",
    "- JSON format errors and invocation failures are reported separately; a quota, timeout, or network failure is not a JSON error.",
    "- Failed calls are excluded from classification denominators but remain visible in the per-case JSON detail.",
  ];
  return `${lines.join("\n")}\n`;
}
