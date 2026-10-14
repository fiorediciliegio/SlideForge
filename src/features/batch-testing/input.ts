import { pickLocale } from "../../i18n/locales";
import type {
  BatchBriefAttachmentInput,
  BatchBriefInput,
  BatchResearchRoutingInput,
  BatchPageRefinementClassificationInput,
  BatchTestInput,
  BatchTestTargetStage,
} from "./types";
import type { BatchTestCaseInput, HostUploadRef, PresentationRequirements } from "../../api/types";
import type { Locale } from "../../i18n/messages";

const MAX_BRIEFS = 200;
const MAX_RESEARCH_ROUTING_CASES = 600;
const MAX_REPEAT = 20;
const PROMPT_VERSION_PATTERN = /^v(?:[1-9]|1[01])[a-z]?$/u;
const DEFAULT_TARGET_STAGE: BatchTestTargetStage = "pptx-exported";
const TARGET_STAGES = new Set<BatchTestTargetStage>([
  "template-recommendation-completed",
  "attachment-context-created",
  "requirements-confirmed",
  "research-routing-completed",
  "page-refinement-classification-completed",
  "web-research-completed",
  "outline-confirmed",
  "image-research-completed",
  "pptx-exported",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeId(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

// 内部测试工具：ja/de 显式回退英文（方案 §4.4：显式四语映射，无隐式二元兜底）
function translated(locale: Locale, zh: string, en: string) {
  return pickLocale(locale, { zh, en, ja: en, de: en });
}

function repeatCount(value: unknown, fallback = 1, locale: Locale = "zh"): number {
  const count = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_REPEAT) {
    throw new Error(translated(locale, `repeat 必须是 1 到 ${MAX_REPEAT} 的整数。`, `repeat must be an integer from 1 to ${MAX_REPEAT}.`));
  }
  return count;
}

function targetStage(value: unknown, locale: Locale): BatchTestTargetStage {
  const stage = value === undefined ? DEFAULT_TARGET_STAGE : value;
  if (typeof stage !== "string" || !TARGET_STAGES.has(stage as BatchTestTargetStage)) {
    throw new Error(translated(locale, "target_stage 不是有效的批量测试截止步骤。", "target_stage is not a valid batch test target stage."));
  }
  return stage as BatchTestTargetStage;
}

function reuseRequirements(value: unknown, locale: Locale): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new Error(pickLocale(locale, { zh: "reuse_requirements 必须是布尔值。", en: "reuse_requirements must be a boolean.", ja: "reuse_requirements は真偽値にしてください。", de: "reuse_requirements muss ein boolescher Wert sein." }));
  }
  return value;
}

function normalizeBrief(value: unknown, index: number, locale: Locale): BatchBriefInput {
  if (typeof value === "string") {
    const brief = value.trim();
    if (!brief) throw new Error(translated(locale, `第 ${index + 1} 个 Brief 不能为空。`, `Brief ${index + 1} must not be empty.`));
    return { id: `brief-${String(index + 1).padStart(3, "0")}`, brief };
  }
  if (!isRecord(value) || typeof value.brief !== "string" || !value.brief.trim()) {
    throw new Error(translated(locale, `第 ${index + 1} 个 Brief 必须包含非空 brief 字段。`, `Brief ${index + 1} must contain a non-empty brief field.`));
  }
  const providedRequirements = value.provided_requirements === undefined
    ? undefined
    : normalizeProvidedRequirements(value.provided_requirements, index, locale);
  const attachments = normalizeAttachments(value.attachments, index, locale);
  return {
    id: safeId(typeof value.id === "string" ? value.id : "", `brief-${String(index + 1).padStart(3, "0")}`),
    brief: value.brief.trim(),
    repeat: value.repeat === undefined ? undefined : repeatCount(value.repeat, 1, locale),
    ...(providedRequirements ? { provided_requirements: providedRequirements } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

function normalizeAttachments(value: unknown, index: number, locale: Locale): BatchBriefAttachmentInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(translated(locale, `第 ${index + 1} 个 Brief 的 attachments 必须是数组。`, `Brief ${index + 1} attachments must be an array.`));
  }
  return value.map((item, attachmentIndex) => {
    if (!isRecord(item) || typeof item.filename !== "string" || !item.filename.trim()) {
      throw new Error(translated(locale, `第 ${index + 1} 个 Brief 的附件 ${attachmentIndex + 1} 缺少 filename。`, `Brief ${index + 1} attachment ${attachmentIndex + 1} requires filename.`));
    }
    const strategy = item.expected_strategy;
    if (strategy !== undefined && strategy !== "full_context" && strategy !== "summarized_context") {
      throw new Error(translated(locale, `附件 ${item.filename} 的 expected_strategy 无效。`, `Attachment ${item.filename} has an invalid expected_strategy.`));
    }
    const upload = item.host_upload;
    if (upload !== undefined && (!isRecord(upload) || upload.transport !== "host_upload"
      || typeof upload.r2_key !== "string" || !upload.r2_key.trim()
      || typeof upload.url !== "string" || !upload.url.trim()
      || typeof upload.mime_type !== "string" || !upload.mime_type.trim()
      || typeof upload.size_bytes !== "number" || !Number.isInteger(upload.size_bytes) || upload.size_bytes < 0)) {
      throw new Error(translated(locale, `第 ${index + 1} 个 Brief 的附件上传引用无效。`, `Brief ${index + 1} attachment upload reference is invalid.`));
    }
    return {
      filename: item.filename.trim(),
      ...(upload ? {
        mime_type: typeof item.mime_type === "string" && item.mime_type.trim() ? item.mime_type.trim() : (upload as unknown as HostUploadRef).mime_type,
        size_bytes: (upload as unknown as HostUploadRef).size_bytes,
        host_upload: structuredClone(upload) as unknown as HostUploadRef,
      } : {}),
      ...(strategy ? { expected_strategy: strategy } : {}),
      ...(typeof item.expected_notes === "string" && item.expected_notes.trim() ? { expected_notes: item.expected_notes.trim() } : {}),
    };
  });
}

function normalizeProvidedRequirements(value: unknown, index: number, locale: Locale): PresentationRequirements {
  if (!isRecord(value) || value.status !== "confirmed" || !isRecord(value.source) || typeof value.source.brief !== "string" || !value.source.brief.trim()) {
    throw new Error(translated(locale, `第 ${index + 1} 个 Brief 的 provided_requirements 必须是包含 source.brief 的已确认 Requirements JSON。`, `Brief ${index + 1} provided_requirements must be confirmed Requirements JSON with source.brief.`));
  }
  if (!isRecord(value.research) || !isRecord(value.research.web) || !isRecord(value.research.images) || value.research.web.enabled !== false || value.research.images.enabled !== false) {
    throw new Error(translated(locale, `第 ${index + 1} 个 Brief 的 provided_requirements 必须关闭 Web 和图片搜索。`, `Brief ${index + 1} provided_requirements must disable Web and image research.`));
  }
  return structuredClone(value) as unknown as PresentationRequirements;
}

function normalizeResearchRouting(value: unknown, locale: Locale): BatchResearchRoutingInput {
  if (!isRecord(value) || !Array.isArray(value.prompts) || !isRecord(value.expected_by_brief_id) || typeof value.git_commit !== "string" || !/^[a-f0-9]{7,64}$/u.test(value.git_commit)) {
    throw new Error(translated(locale, "research_routing must contain git_commit, prompts and expected_by_brief_id.", "research_routing must contain git_commit, prompts and expected_by_brief_id."));
  }
  if (value.prompts.length === 0 || value.prompts.length > 11) {
    throw new Error(translated(locale, "research_routing.prompts 必须包含 1 到 11 个提示词。", "research_routing.prompts must contain 1 to 11 prompts."));
  }
  const seen = new Set<string>();
  const prompts = value.prompts.map((item, index) => {
    if (!isRecord(item) || typeof item.prompt_version !== "string" || typeof item.prompt !== "string" || typeof item.prompt_hash !== "string") {
      throw new Error(translated(locale, `Invalid research routing prompt ${index + 1}.`, `Invalid research routing prompt ${index + 1}.`));
    }
    const promptVersion = item.prompt_version.trim();
    if (!PROMPT_VERSION_PATTERN.test(promptVersion) || seen.has(promptVersion) || !item.prompt.trim() || !/^[a-f0-9]{64}$/u.test(item.prompt_hash)) {
      throw new Error(translated(locale, `Invalid or duplicated research routing prompt ${promptVersion || index + 1}.`, `Invalid or duplicated research routing prompt ${promptVersion || index + 1}.`));
    }
    seen.add(promptVersion);
    return { prompt_version: promptVersion, prompt: item.prompt.trim(), prompt_hash: item.prompt_hash };
  });
  const expectedByBriefId: BatchResearchRoutingInput["expected_by_brief_id"] = {};
  for (const [briefId, item] of Object.entries(value.expected_by_brief_id)) {
    if (!isRecord(item) || typeof item.web !== "boolean" || typeof item.images !== "boolean") {
      throw new Error(translated(locale, `Invalid research routing expectation: ${briefId}.`, `Invalid research routing expectation: ${briefId}.`));
    }
    expectedByBriefId[safeId(briefId, briefId)] = { web: item.web, images: item.images };
  }
  const requestedModel = value.requested_model === undefined || value.requested_model === null
    ? null
    : typeof value.requested_model === "string" && value.requested_model.trim()
      ? value.requested_model.trim()
      : (() => { throw new Error(translated(locale, "research_routing.requested_model must be a non-empty string or null.", "research_routing.requested_model must be a non-empty string or null.")); })();
  return { git_commit: value.git_commit, requested_model: requestedModel, prompts, expected_by_brief_id: expectedByBriefId };
}

function normalizePageRefinementClassification(value: unknown, locale: Locale): BatchPageRefinementClassificationInput {
  const taskTypes = new Set(["exact_text_edit", "content_rewrite", "style_edit", "layout_edit", "web_research", "image_research", "mixed", "unclear"]);
  const executionScopes = new Set(["local", "regenerate", "uncertain"]);
  if (!isRecord(value) || !Array.isArray(value.prompts) || typeof value.git_commit !== "string" || !/^[a-f0-9]{7,64}$/u.test(value.git_commit)) {
    throw new Error(translated(locale, "page_refinement_classification must contain git_commit and prompts.", "page_refinement_classification must contain git_commit and prompts."));
  }
  if (value.prompts.length === 0 || value.prompts.length > 10) {
    throw new Error(translated(locale, "page_refinement_classification.prompts must contain 1 to 10 prompts.", "page_refinement_classification.prompts must contain 1 to 10 prompts."));
  }
  const seen = new Set<string>();
  const prompts = value.prompts.map((item, index) => {
    if (!isRecord(item) || typeof item.prompt_version !== "string" || typeof item.prompt !== "string" || typeof item.prompt_hash !== "string") {
      throw new Error(translated(locale, `Invalid page refinement classification prompt ${index + 1}.`, `Invalid page refinement classification prompt ${index + 1}.`));
    }
    const promptVersion = item.prompt_version.trim();
    if (!/^v(?:[1-9]|10)[a-z]?$/u.test(promptVersion) || seen.has(promptVersion) || !item.prompt.trim() || !/^[a-f0-9]{64}$/u.test(item.prompt_hash)) {
      throw new Error(translated(locale, `Invalid or duplicated page refinement classification prompt ${promptVersion || index + 1}.`, `Invalid or duplicated page refinement classification prompt ${promptVersion || index + 1}.`));
    }
    seen.add(promptVersion);
    return { prompt_version: promptVersion, prompt: item.prompt.trim(), prompt_hash: item.prompt_hash };
  });
  const expectedByBriefId: NonNullable<BatchPageRefinementClassificationInput["expected_by_brief_id"]> = {};
  if (value.expected_by_brief_id !== undefined && !isRecord(value.expected_by_brief_id)) {
    throw new Error(translated(locale, "page_refinement_classification.expected_by_brief_id must be an object when provided.", "page_refinement_classification.expected_by_brief_id must be an object when provided."));
  }
  for (const [briefId, item] of Object.entries(value.expected_by_brief_id ?? {})) {
    if (!isRecord(item) || typeof item.task_type !== "string" || !taskTypes.has(item.task_type) || typeof item.execution_scope !== "string" || !executionScopes.has(item.execution_scope) || typeof item.web_research !== "boolean" || typeof item.image_research !== "boolean") {
      throw new Error(translated(locale, `Invalid page refinement classification expectation: ${briefId}.`, `Invalid page refinement classification expectation: ${briefId}.`));
    }
    expectedByBriefId[safeId(briefId, briefId)] = {
      task_type: item.task_type as typeof expectedByBriefId[string]["task_type"],
      execution_scope: item.execution_scope as typeof expectedByBriefId[string]["execution_scope"],
      web_research: item.web_research,
      image_research: item.image_research,
    };
  }
  const requestedModel = value.requested_model === undefined || value.requested_model === null
    ? null
    : typeof value.requested_model === "string" && value.requested_model.trim()
      ? value.requested_model.trim()
      : (() => { throw new Error(translated(locale, "page_refinement_classification.requested_model must be a non-empty string or null.", "page_refinement_classification.requested_model must be a non-empty string or null.")); })();
  return {
    git_commit: value.git_commit,
    requested_model: requestedModel,
    prompts,
    ...(Object.keys(expectedByBriefId).length > 0 ? { expected_by_brief_id: expectedByBriefId } : {}),
  };
}

export function parseBatchTestJson(text: string, locale: Locale = "zh"): BatchTestInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(translated(locale, "JSON 文件格式无效。", "The JSON file is invalid."));
  }
  const root = Array.isArray(parsed) ? { briefs: parsed } : parsed;
  if (!isRecord(root) || !Array.isArray(root.briefs)) {
    throw new Error(translated(locale, "JSON 必须是 Brief 数组，或包含 briefs 数组的对象。", "JSON must be a Brief array or an object containing a briefs array."));
  }
  if (root.briefs.length === 0 || root.briefs.length > MAX_BRIEFS) {
    throw new Error(translated(locale, `briefs 必须包含 1 到 ${MAX_BRIEFS} 项。`, `briefs must contain between 1 and ${MAX_BRIEFS} items.`));
  }
  const target = targetStage(root.target_stage, locale);
  const reuse = reuseRequirements(root.reuse_requirements, locale);
  const researchRouting = root.research_routing === undefined ? undefined : normalizeResearchRouting(root.research_routing, locale);
  const pageRefinementClassification = root.page_refinement_classification === undefined ? undefined : normalizePageRefinementClassification(root.page_refinement_classification, locale);
  if (researchRouting && target !== "research-routing-completed" && target !== "image-research-completed") {
    throw new Error(translated(locale, "research_routing can only use research-routing-completed or image-research-completed.", "research_routing can only use research-routing-completed or image-research-completed."));
  }
  if (pageRefinementClassification && target !== "page-refinement-classification-completed") {
    throw new Error(translated(locale, "page_refinement_classification can only use page-refinement-classification-completed.", "page_refinement_classification can only use page-refinement-classification-completed."));
  }
  if (target === "page-refinement-classification-completed" && !pageRefinementClassification) {
    throw new Error(translated(locale, "page-refinement-classification-completed requires page_refinement_classification.", "page-refinement-classification-completed requires page_refinement_classification."));
  }
  const briefs = root.briefs.map((value, index) => normalizeBrief(value, index, locale));
  if (briefs.some((item) => item.provided_requirements) && target !== "outline-confirmed") {
    throw new Error(translated(locale, "provided_requirements 只能用于 outline-confirmed 批量测试。", "provided_requirements can only be used with outline-confirmed batch tests."));
  }
  if (reuse && target !== "requirements-confirmed") {
    throw new Error(pickLocale(locale, { zh: "reuse_requirements 只能用于 requirements-confirmed 批量测试。", en: "reuse_requirements can only be used with requirements-confirmed batch tests.", ja: "reuse_requirements は requirements-confirmed の一括テストでのみ使用できます。", de: "reuse_requirements kann nur bei Stapeltests mit requirements-confirmed verwendet werden." }));
  }
  return {
    test_id: typeof root.test_id === "string" ? safeId(root.test_id, "") || undefined : undefined,
    repeat: repeatCount(root.repeat, 1, locale),
    target_stage: target,
    ...(reuse ? { reuse_requirements: true } : {}),
    briefs,
    ...(researchRouting ? { research_routing: researchRouting } : {}),
    ...(pageRefinementClassification ? { page_refinement_classification: pageRefinementClassification } : {}),
  };
}

export function parseBatchTestText(
  text: string,
  repeat = 1,
  locale: Locale = "zh",
  selectedTargetStage: BatchTestTargetStage = DEFAULT_TARGET_STAGE,
): BatchTestInput {
  const blocks = text
    .split(/\r?\n\s*\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (blocks.length === 0 || blocks.length > MAX_BRIEFS) {
    throw new Error(translated(locale, `请输入 1 到 ${MAX_BRIEFS} 个 Brief，Brief 之间用空行分隔。`, `Enter between 1 and ${MAX_BRIEFS} Briefs separated by blank lines.`));
  }
  return {
    repeat: repeatCount(repeat, 1, locale),
    target_stage: targetStage(selectedTargetStage, locale),
    briefs: blocks.map((brief, index) => ({
      id: `brief-${String(index + 1).padStart(3, "0")}`,
      brief,
    })),
  };
}

export function expandBatchTestInput(input: BatchTestInput, locale: Locale = "zh"): BatchTestCaseInput[] {
  const defaultRepeat = repeatCount(input.repeat, 1, locale);
  const researchRouting = input.research_routing;
  const pageRefinementClassification = input.page_refinement_classification;
  const seen = new Set<string>();
  const cases: BatchTestCaseInput[] = input.briefs.flatMap<BatchTestCaseInput>((item, briefIndex) => {
    const briefId = safeId(item.id ?? "", `brief-${String(briefIndex + 1).padStart(3, "0")}`);
    if (seen.has(briefId)) throw new Error(translated(locale, `Brief id 重复：${briefId}`, `Duplicate Brief id: ${briefId}`));
    seen.add(briefId);
    const total = repeatCount(item.repeat, defaultRepeat, locale);
    const attachments = item.attachments ? item.attachments.map((attachment) => {
      if (!attachment.host_upload || typeof attachment.size_bytes !== "number") {
        throw new Error(translated(locale, `请在开始批量测试前选择 ${attachment.filename} 对应的测试文件。`, `Select the fixture file for ${attachment.filename} before starting the batch.`));
      }
      return {
        filename: attachment.filename,
        mime_type: attachment.mime_type || attachment.host_upload.mime_type,
        size_bytes: attachment.size_bytes,
        host_upload: attachment.host_upload,
        expected_strategy: attachment.expected_strategy,
        expected_notes: attachment.expected_notes,
      };
    }) : undefined;
    if (researchRouting) {
      const expected = researchRouting.expected_by_brief_id[briefId];
      if (!expected) throw new Error(translated(locale, `Research routing expectation is missing for ${briefId}.`, `Research routing expectation is missing for ${briefId}.`));
      return researchRouting.prompts.flatMap((prompt) => Array.from({ length: total }, (_, repetition) => ({
        case_id: `${briefId}-${prompt.prompt_version}-${String(repetition + 1).padStart(3, "0")}`,
        brief_id: briefId,
        brief: item.brief,
        repetition: repetition + 1,
        total_repetitions: total,
        ...(attachments ? { attachments } : {}),
        research_routing: {
          baseline_id: briefId,
          prompt_version: prompt.prompt_version,
          prompt: prompt.prompt,
          prompt_hash: prompt.prompt_hash,
          git_commit: researchRouting.git_commit,
          requested_model: researchRouting.requested_model ?? null,
          expected,
        },
      })));
    }
    if (pageRefinementClassification) {
      const expected = pageRefinementClassification.expected_by_brief_id?.[briefId];
      return pageRefinementClassification.prompts.flatMap((prompt) => Array.from({ length: total }, (_, repetition) => ({
        case_id: `${briefId}-${prompt.prompt_version}-${String(repetition + 1).padStart(3, "0")}`,
        brief_id: briefId,
        brief: item.brief,
        repetition: repetition + 1,
        total_repetitions: total,
        page_refinement_classification: {
          prompt_version: prompt.prompt_version,
          prompt: prompt.prompt,
          prompt_hash: prompt.prompt_hash,
          git_commit: pageRefinementClassification.git_commit,
          requested_model: pageRefinementClassification.requested_model ?? null,
          ...(expected ? { expected } : {}),
        },
      })));
    }
    return Array.from({ length: total }, (_, repetition) => ({
      case_id: `${briefId}-${String(repetition + 1).padStart(3, "0")}`,
      brief_id: briefId,
      brief: item.brief,
      repetition: repetition + 1,
      total_repetitions: total,
      ...(attachments ? { attachments } : {}),
      ...(item.provided_requirements ? { provided_requirements: item.provided_requirements } : {}),
    }));
  });
  const maximum = researchRouting || pageRefinementClassification ? MAX_RESEARCH_ROUTING_CASES : MAX_BRIEFS;
  if (cases.length > maximum) throw new Error(translated(locale, `Expanded batch cases cannot exceed ${maximum}.`, `Expanded batch cases cannot exceed ${maximum}.`));
  return cases;
}
