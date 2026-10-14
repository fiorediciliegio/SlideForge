import { normalizeStage1ResultsDocument } from "./contracts.mjs";
import { scoreRoutingItems } from "./scoring.mjs";

function modelKey(item) {
  return item.actual_model ?? "unreported";
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function stability(items) {
  const byCase = groupBy(items, (item) => `${item.prompt_version}\u0000${modelKey(item)}\u0000${item.case_id}`);
  const details = [...byCase.entries()].map(([key, entries]) => {
    const outcomes = entries.filter((item) => item.actual).map((item) => `${item.actual.web}:${item.actual.images}`);
    const counts = [...new Set(outcomes)].map((outcome) => ({ outcome, count: outcomes.filter((value) => value === outcome).length }));
    const dominant = counts.reduce((maximum, item) => Math.max(maximum, item.count), 0);
    const [prompt_version, actual_model, case_id] = key.split("\u0000");
    return {
      prompt_version,
      actual_model: actual_model === "unreported" ? null : actual_model,
      case_id,
      completed_runs: outcomes.length,
      outcomes: counts,
      agreement: outcomes.length === 0 ? null : Number((dominant / outcomes.length).toFixed(6)),
      flaky: counts.length > 1,
    };
  });
  const agreements = details.map((item) => item.agreement).filter((item) => item !== null);
  return {
    mean_agreement: agreements.length === 0 ? null : Number((agreements.reduce((sum, value) => sum + value, 0) / agreements.length).toFixed(6)),
    flaky_cases: details.filter((item) => item.flaky),
    details,
  };
}

function modelDisagreements(items) {
  const byPromptCase = groupBy(items.filter((item) => item.actual && item.actual_model), (item) => `${item.prompt_version}\u0000${item.case_id}`);
  return [...byPromptCase.entries()].flatMap(([key, entries]) => {
    const byModel = new Map();
    for (const item of entries) {
      const outcomes = byModel.get(item.actual_model) ?? new Set();
      outcomes.add(`${item.actual.web}:${item.actual.images}`);
      byModel.set(item.actual_model, outcomes);
    }
    const allOutcomes = new Set([...byModel.values()].flatMap((outcomes) => [...outcomes]));
    if (byModel.size < 2 || allOutcomes.size < 2) return [];
    const [prompt_version, case_id] = key.split("\u0000");
    return [{
      prompt_version,
      case_id,
      expected: entries[0].expected,
      by_model: Object.fromEntries([...byModel.entries()].map(([model, outcomes]) => [model, [...outcomes]])),
    }];
  });
}

/**
 * Compares the final routing decision for the same fixture across models.
 *
 * This deliberately differs from `stability()`: the latter measures repeat
 * consistency within one model, while this measures portability of a prompt
 * between the models that actually completed the production pipeline.
 */
function crossModelAgreement(items) {
  const completed = items.filter((item) => item.actual && item.actual_model);
  const expectedModelsByPrompt = groupBy(completed, (item) => item.prompt_version);
  const modelsByPrompt = new Map([...expectedModelsByPrompt.entries()].map(([promptVersion, entries]) => [
    promptVersion,
    [...new Set(entries.map((item) => item.actual_model))].sort(),
  ]));
  const byPromptCase = groupBy(completed, (item) => `${item.prompt_version}\u0000${item.case_id}`);
  const knownCasesByPrompt = groupBy(items, (item) => item.prompt_version);
  const details = [];

  for (const [promptVersion, entries] of knownCasesByPrompt.entries()) {
    const expectedModels = modelsByPrompt.get(promptVersion) ?? [];
    for (const caseId of [...new Set(entries.map((item) => item.case_id))].sort()) {
      const completedEntries = byPromptCase.get(`${promptVersion}\u0000${caseId}`) ?? [];
      const byModel = new Map();
      for (const item of completedEntries) {
        const outcomes = byModel.get(item.actual_model) ?? new Set();
        outcomes.add(`${item.actual.web}:${item.actual.images}`);
        byModel.set(item.actual_model, outcomes);
      }
      const outcomeSets = [...byModel.values()];
      const allModelsCompleted = expectedModels.length > 0 && expectedModels.every((model) => byModel.has(model));
      const allModelsInternallyConsistent = outcomeSets.every((outcomes) => outcomes.size === 1);
      const distinctOutcomes = new Set(outcomeSets.flatMap((outcomes) => [...outcomes]));
      details.push({
        prompt_version: promptVersion,
        case_id: caseId,
        expected_models: expectedModels,
        completed_model_count: byModel.size,
        all_models_completed: allModelsCompleted,
        exact_agreement: allModelsCompleted && allModelsInternallyConsistent && distinctOutcomes.size === 1,
        by_model: Object.fromEntries([...byModel.entries()].map(([model, outcomes]) => [model, [...outcomes]])),
      });
    }
  }

  const summaries = [...knownCasesByPrompt.keys()].sort().map((promptVersion) => {
    const promptDetails = details.filter((item) => item.prompt_version === promptVersion);
    const allCompleted = promptDetails.filter((item) => item.all_models_completed);
    const exactAgreement = allCompleted.filter((item) => item.exact_agreement);
    return {
      prompt_version: promptVersion,
      models: modelsByPrompt.get(promptVersion) ?? [],
      total_cases: promptDetails.length,
      all_models_completed: allCompleted.length,
      completion_coverage: promptDetails.length === 0 ? null : Number((allCompleted.length / promptDetails.length).toFixed(6)),
      exact_agreement: exactAgreement.length,
      exact_agreement_rate: allCompleted.length === 0 ? null : Number((exactAgreement.length / allCompleted.length).toFixed(6)),
      incomplete_cases: promptDetails.filter((item) => !item.all_models_completed).map((item) => item.case_id),
      disagreement_cases: allCompleted.filter((item) => !item.exact_agreement).map((item) => item.case_id),
    };
  });

  return { summaries, details };
}

/** Scores one or more manually model-labelled Stage 2 Batch Testing exports. */
export function scoreStage2(values) {
  const documents = values.map(normalizeStage1ResultsDocument);
  const results = documents.flatMap((document) => document.results);
  const byPromptModel = groupBy(results, (item) => `${item.prompt_version}\u0000${modelKey(item)}`);
  const comparison = [...byPromptModel.entries()].map(([key, items]) => {
    const [prompt_version, actualModelKey] = key.split("\u0000");
    return {
      prompt_version,
      actual_model: actualModelKey === "unreported" ? null : actualModelKey,
      requested_models: [...new Set(items.map((item) => item.requested_model).filter(Boolean))],
      prompt_hashes: [...new Set(items.map((item) => item.prompt_hash))],
      ...scoreRoutingItems(items),
    };
  }).sort((left, right) => right.macro_f1 - left.macro_f1 || right.exact_match_rate - left.exact_match_rate);
  const stabilityResult = stability(results);
  return {
    schema_version: 1,
    phase: "stage-2",
    generated_at: new Date().toISOString(),
    source_runs: documents.map((item) => item.run_id).filter(Boolean),
    git_commits: [...new Set(documents.map((item) => item.git_commit).filter(Boolean))],
    prompt_model_comparison: comparison,
    stability: stabilityResult,
    cross_model_agreement: crossModelAgreement(results),
    model_disagreements: modelDisagreements(results),
    case_details: results,
  };
}
