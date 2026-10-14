import { normalizeStage1ResultsDocument } from "./contracts.mjs";

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function round(value) {
  return value === null ? null : Number(value.toFixed(6));
}

function emptyCounts() {
  return { tp: 0, fp: 0, fn: 0, tn: 0 };
}

function addCount(counts, expected, actual) {
  if (expected && actual) counts.tp += 1;
  else if (!expected && actual) counts.fp += 1;
  else if (expected && !actual) counts.fn += 1;
  else counts.tn += 1;
}

function summarizeCounts(counts) {
  const total = counts.tp + counts.fp + counts.fn + counts.tn;
  const precision = ratio(counts.tp, counts.tp + counts.fp);
  const recall = ratio(counts.tp, counts.tp + counts.fn);
  const f1 = precision === null || recall === null || precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  return {
    ...counts,
    total,
    accuracy: round(ratio(counts.tp + counts.tn, total)),
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
  };
}

function mean(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length === 0 ? null : valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

export function scoreRoutingItems(items) {
  const web = emptyCounts();
  const images = emptyCounts();
  let exactMatches = 0;
  let repairs = 0;
  let retries = 0;
  const failures = { json_format: 0, invocation: 0, cancelled: 0, unknown: 0 };
  const latency = [];
  const tokens = [];
  for (const item of items) {
    if (!item.actual) continue;
    addCount(web, item.expected.web, item.actual.web);
    addCount(images, item.expected.images, item.actual.images);
    if (item.expected.web === item.actual.web && item.expected.images === item.actual.images) exactMatches += 1;
    repairs += item.json_repair_count;
    retries += item.retry_count;
    latency.push(item.latency_ms);
    tokens.push(item.token_usage?.total_tokens);
  }
  for (const item of items) {
    if (!item.actual && item.failure_kind) failures[item.failure_kind] += 1;
  }
  const completed = items.filter((item) => item.actual).length;
  const failed = items.length - completed;
  const webScore = summarizeCounts(web);
  const imageScore = summarizeCounts(images);
  return {
    runs: items.length,
    completed,
    failed,
    failure_rate: round(ratio(failed, items.length)),
    json_error_rate: round(ratio(failures.json_format, items.length)),
    failures,
    json_repair_count: repairs,
    retry_count: retries,
    web: webScore,
    images: imageScore,
    macro_f1: round((webScore.f1 + imageScore.f1) / 2),
    exact_match_rate: round(ratio(exactMatches, completed)),
    mean_latency_ms: round(mean(latency)),
    mean_total_tokens: round(mean(tokens)),
  };
}

function flakyCases(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = `${item.prompt_version}:${item.case_id}`;
    const values = byKey.get(key) ?? [];
    if (item.actual) values.push(`${item.actual.web}:${item.actual.images}`);
    byKey.set(key, values);
  }
  return [...byKey].flatMap(([key, values]) => new Set(values).size > 1 ? [{ key, outcomes: [...new Set(values)] }] : []);
}

function caseDetails(items) {
  return items.map((item) => ({
    case_id: item.case_id,
    prompt_version: item.prompt_version,
    requested_model: item.requested_model,
    actual_model: item.actual_model,
    expected: item.expected,
    actual: item.actual,
    correct: item.actual
      ? item.expected.web === item.actual.web && item.expected.images === item.actual.images
      : false,
    failure_kind: item.failure_kind,
    error: item.error,
    json_repair_count: item.json_repair_count,
    retry_count: item.retry_count,
    retry_reasons: item.retry_reasons,
  }));
}

export function scoreStage1(value) {
  const document = normalizeStage1ResultsDocument(value);
  const byPrompt = new Map();
  for (const item of document.results) {
    const items = byPrompt.get(item.prompt_version) ?? [];
    items.push(item);
    byPrompt.set(item.prompt_version, items);
  }
  const prompts = [...byPrompt.entries()].map(([prompt_version, items]) => ({
    prompt_version,
    prompt_hashes: [...new Set(items.map((item) => item.prompt_hash))],
    models: [...new Set(items.map((item) => item.actual_model).filter(Boolean))],
    requested_models: [...new Set(items.map((item) => item.requested_model).filter(Boolean))],
    ...scoreRoutingItems(items),
  })).sort((left, right) => right.macro_f1 - left.macro_f1 || right.exact_match_rate - left.exact_match_rate || left.json_error_rate - right.json_error_rate || (left.mean_total_tokens ?? Infinity) - (right.mean_total_tokens ?? Infinity) || (left.mean_latency_ms ?? Infinity) - (right.mean_latency_ms ?? Infinity));
  return {
    schema_version: 1,
    phase: "stage-1",
    generated_at: new Date().toISOString(),
    source_run_id: document.run_id,
    git_commit: document.git_commit,
    prompt_comparison: prompts,
    flaky_cases: flakyCases(document.results),
    case_details: caseDetails(document.results),
  };
}
