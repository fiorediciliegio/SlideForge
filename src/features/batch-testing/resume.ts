import { pickLocale } from "../../i18n/locales";
import type { BatchTestCaseInput, BatchTestRunRecord } from "../../api/types";
import type { Locale } from "../../i18n/messages";
import { expandBatchTestInput } from "./input";
import type { BatchTestInput } from "./types";

// 内部测试工具：ja/de 显式回退英文（方案 §4.4：显式四语映射，无隐式二元兜底）
function message(locale: Locale, zh: string, en: string) {
  return pickLocale(locale, { zh, en, ja: en, de: en });
}

function researchRoutingCasesFingerprint(cases: BatchTestCaseInput[]) {
  let hash = 0x811c9dc5;
  const source = JSON.stringify(cases.map((item) => [
    item.case_id,
    item.brief_id,
    item.brief,
    item.repetition,
    item.total_repetitions,
    item.research_routing?.prompt_hash,
    item.research_routing?.expected.web,
    item.research_routing?.expected.images,
  ]));
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function researchRoutingRunSignature(input: BatchTestInput) {
  const routing = input.research_routing;
  return routing ? JSON.stringify([routing.git_commit, routing.requested_model]) : undefined;
}

/**
 * A resumed run must use exactly the imported experiment that created it. This
 * protects completed cases from being combined with a changed prompt, model
 * label, expectation, or target stage under the same test ID.
 */
export function assertBatchTestResumeCompatible(
  input: BatchTestInput,
  run: BatchTestRunRecord,
  locale: Locale,
): BatchTestCaseInput[] {
  if (!input.test_id || input.test_id !== run.test_id) {
    throw new Error(message(locale, "续跑时必须导入与原测试 ID 完全一致的 JSON。", "Resume requires importing JSON with the exact original test ID."));
  }
  if (input.target_stage !== run.target_stage) {
    throw new Error(message(locale, "续跑配置的目标阶段与原测试不一致。", "The resume target stage does not match the existing test."));
  }
  if (run.status === "completed") {
    throw new Error(message(locale, "该测试已经完成；如需重新运行，请先删除旧测试。", "This test is already completed. Delete it before running it again."));
  }
  const sourceCases = expandBatchTestInput(input, locale);
  if (sourceCases.length !== run.cases.length) {
    throw new Error(message(locale, "续跑配置的用例数量与原测试不一致。", "The resume case count does not match the existing test."));
  }
  const hasResearchRoutingIdentity = input.research_routing !== undefined
    || run.research_routing_run_signature !== undefined
    || run.research_routing_cases_fingerprint !== undefined
    || run.cases.some((item) => item.research_routing_signature !== undefined);
  if (hasResearchRoutingIdentity) {
    if (researchRoutingRunSignature(input) !== run.research_routing_run_signature) {
      throw new Error(message(locale, "续跑配置的 Git 提交或模型标签不一致。", "The resume Git commit or model label does not match the existing test."));
    }
    if (run.research_routing_cases_fingerprint !== researchRoutingCasesFingerprint(sourceCases)) {
      throw new Error(message(locale, "续跑配置与原测试用例不一致。", "The resume cases do not match the existing test."));
    }
  }
  const storedById = new Map(run.cases.map((item) => [item.case_id, item]));
  for (const source of sourceCases) {
    const stored = storedById.get(source.case_id);
    if (!stored) {
      throw new Error(message(locale, `续跑配置与原测试用例不一致：${source.case_id}`, `Resume case does not match the existing test: ${source.case_id}`));
    }
    const expectedRouting = source.research_routing;
    if (stored.research_routing_signature !== undefined && Boolean(expectedRouting) !== Boolean(stored.research_routing_signature)) {
      throw new Error(message(locale, `续跑配置的研究判断设置不一致：${source.case_id}`, `Resume research-routing settings do not match: ${source.case_id}`));
    }
    if (expectedRouting && stored.research_routing_signature !== undefined && stored.research_routing_signature !== `${expectedRouting.prompt_hash}|${expectedRouting.expected.web ? "1" : "0"}${expectedRouting.expected.images ? "1" : "0"}`) {
      throw new Error(message(locale, `续跑配置的 Prompt 或评分基准不一致：${source.case_id}`, `Resume Prompt or scoring baseline does not match: ${source.case_id}`));
    }
    const expectedClassification = source.page_refinement_classification;
    const storedClassification = stored.page_refinement_classification;
    if (Boolean(expectedClassification) !== Boolean(storedClassification)) {
      throw new Error(message(locale, `续跑配置的单页修改分类设置不一致：${source.case_id}`, `Resume page refinement classification settings do not match: ${source.case_id}`));
    }
    if (expectedClassification && storedClassification && (
      expectedClassification.prompt_hash !== storedClassification.prompt_hash
      || expectedClassification.git_commit !== storedClassification.git_commit
      || expectedClassification.requested_model !== storedClassification.requested_model
      || JSON.stringify(expectedClassification.expected ?? null) !== JSON.stringify(storedClassification.expected ?? null)
    )) {
      throw new Error(message(locale, `续跑配置的单页修改分类 Prompt 或评分基准不一致：${source.case_id}`, `Resume page refinement classification Prompt or scoring baseline does not match: ${source.case_id}`));
    }
  }
  return sourceCases;
}
