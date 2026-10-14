function percentage(value) {
  return value === null || value === undefined ? "-" : `${(value * 100).toFixed(1)}%`;
}

function cell(value) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function outcomeCell(outcomes) {
  return outcomes?.length ? outcomes.join(" / ") : "-";
}

function expectedCell(expected) {
  return expected ? `web=${expected.web}, images=${expected.images}` : "-";
}

function disagreementTable(items, models) {
  return [
    `| Case | Expected | ${models.join(" | ")} |`,
    `| --- | --- | ${models.map(() => "---").join(" | ")} |`,
    ...items.map((item) => `| ${item.case_id} | ${expectedCell(item.expected)} | ${models.map((model) => outcomeCell(item.by_model[model])).join(" | ")} |`),
  ];
}

export function stage2MarkdownReport(score) {
  const lines = [
    "# Research Routing Eval - Stage 2",
    "",
    `Generated: ${score.generated_at}`,
    `Source runs: ${score.source_runs.join(", ") || "not recorded"}`,
    `Git commits: ${score.git_commits.join(", ") || "not recorded"}`,
    "",
    "## Prompt vs actual model",
    "",
    "| Prompt | Actual model | Valid v7 results | Macro F1 | Exact match | Web F1 | Image F1 | Final JSON errors (after retry) | Tokens | Latency |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...score.prompt_model_comparison.filter((item) => item.actual_model).map((item) => {
      const totalCases = score.cross_model_agreement.summaries.find((summary) => summary.prompt_version === item.prompt_version)?.total_cases ?? item.runs;
      return `| ${item.prompt_version} | ${cell(item.actual_model)} | ${item.completed}/${totalCases} | ${percentage(item.macro_f1)} | ${percentage(item.exact_match_rate)} | ${percentage(item.web.f1)} | ${percentage(item.images.f1)} | ${item.failures.json_format} | ${cell(item.mean_total_tokens)} | ${cell(item.mean_latency_ms)} ms |`;
    }),
    "",
    "## Cross-model agreement",
    "",
    "Only cases that completed on every listed model are used for the agreement rate. Incomplete cases failed before the routing result was produced and are reported as coverage, not as a routing disagreement.",
    "",
    "| Prompt | Models | All models completed | Exact agreement | Coverage |",
    "| --- | --- | ---: | ---: | ---: |",
    ...score.cross_model_agreement.summaries.map((item) => `| ${item.prompt_version} | ${item.models.join(", ")} | ${item.all_models_completed}/${item.total_cases} | ${item.exact_agreement}/${item.all_models_completed} (${percentage(item.exact_agreement_rate)}) | ${percentage(item.completion_coverage)} |`),
    ...score.cross_model_agreement.summaries.flatMap((item) => [
      item.incomplete_cases.length === 0 ? null : `- ${item.prompt_version} incomplete before routing: ${item.incomplete_cases.join(", ")}`,
      item.disagreement_cases.length === 0 ? null : `- ${item.prompt_version} cross-model disagreement: ${item.disagreement_cases.join(", ")}`,
    ].filter(Boolean)),
    "",
    "## Same-model repeat stability",
    "",
    `Mean case agreement: ${percentage(score.stability.mean_agreement)}`,
    `Flaky cases: ${score.stability.flaky_cases.length}`,
    ...score.stability.flaky_cases.map((item) => `- ${item.prompt_version} / ${item.actual_model ?? "unreported model"} / ${item.case_id}: ${item.outcomes.map((outcome) => `${outcome.outcome} ×${outcome.count}`).join(", ")}`),
    "",
    "## Model disagreements",
    "",
    "`Expected` is the manually labelled correct routing answer. `true:true` means `web=true, images=true`; `-` means the model did not reach v7 for that case.",
    "",
    ...(score.model_disagreements.length === 0
      ? ["None detected."]
      : (() => {
        const models = [...new Set(score.model_disagreements.flatMap((item) => Object.keys(item.by_model)))].sort();
        const allModelsCompleted = score.model_disagreements.filter((item) => models.every((model) => item.by_model[model]));
        const partial = score.model_disagreements.filter((item) => !models.every((model) => item.by_model[model]));
        return [
          "### All three models completed but disagreed",
          "",
          ...disagreementTable(allModelsCompleted, models),
          ...(partial.length === 0 ? [] : [
            "",
            "### Only partial comparison available",
            "",
            "These cases are not included in the three-model agreement rate because at least one model failed before producing a v7 result.",
            "",
            ...disagreementTable(partial, models),
          ]),
        ];
      })()),
    "",
    "## Notes",
    "",
    "- `requested_model` is a human-entered label for the Local Agent model selection; `actual_model` is the Anna response value and is the comparison key.",
    "- `Final JSON errors (after retry)` counts only calls that were still invalid after all retry attempts.",
    "- Same-model repeat stability requires repeated completed calls. Invocation failures are reported separately and do not count as JSON format errors.",
  ];
  return `${lines.join("\n")}\n`;
}
