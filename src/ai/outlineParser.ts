import type { OutlineDetail } from "../data/mockDeck";
import type { GeneratedOutline } from "./types";

export class OutlineValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid outline JSON: ${errors.join("; ")}`);
    this.name = "OutlineValidationError";
  }
}

export function parseOutlineJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("大纲 LLM 没有返回 JSON 内容。");

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // LLM 偶尔会包一层 JSON 代码块；允许去掉代码块，但不能从一个
    // 已损坏的顶层大纲中提取内部 segment，否则会产生误导性的旧协议错误。
  }

  const fencedBlocks = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
  for (const match of fencedBlocks) {
    const candidate = match[1]?.trim() ?? "";
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // 继续检查完整的顶层对象候选。
    }
  }

  const firstObjectStart = trimmed.indexOf("{");
  const lastObjectEnd = trimmed.lastIndexOf("}");
  if (firstObjectStart >= 0 && lastObjectEnd > firstObjectStart) {
    const candidate = trimmed.slice(firstObjectStart, lastObjectEnd + 1);
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // 统一返回顶层 JSON 不完整错误，不降级提取内部对象。
    }
  }

  throw new Error("大纲 LLM 返回的顶层 JSON 不完整或格式无效。");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanLine(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string, errors: string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    errors.push(`${label} must contain only ${expected.join(", ")}`);
  }
}

function normalizeProductionOutline(value: unknown): GeneratedOutline {
  const errors: string[] = [];
  if (!isRecord(value)) throw new OutlineValidationError(["root must be a JSON object"]);
  exactKeys(value, ["title", "global_creation_requirements", "items"], "root", errors);
  if (typeof value.global_creation_requirements !== "string") errors.push("global_creation_requirements must be a string");
  const title = cleanLine(value.title);
  if (!title) errors.push("title must be a non-empty string");
  if (/\r|\n/u.test(title)) errors.push("title must be a single line");
  const rawItems = Array.isArray(value.items) ? value.items : [];
  if (!Array.isArray(value.items)) errors.push("items must be an array");
  if (rawItems.length === 0) errors.push("items must contain at least one page");

  const items: OutlineDetail[] = rawItems.map((item, index) => {
    const label = `items[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${label} must be an object`);
      return { page_type: index === 0 ? "cover" : "standard", title: "", content: "" };
    }
    exactKeys(item, ["page_type", "title", "generation_notes", "content", ...("creation_requirements" in item ? ["creation_requirements"] : [])], label, errors);
    if ("creation_requirements" in item && typeof item.creation_requirements !== "string") errors.push(`${label}.creation_requirements must be a string`);
    if (typeof item.generation_notes !== "string") {
      errors.push(`${label}.generation_notes must be a string`);
    }
    const pageType = cleanLine(item.page_type);
    const itemTitle = cleanLine(item.title);
    if (pageType !== "cover" && pageType !== "standard") errors.push(`${label}.page_type must be cover or standard`);
    if (!itemTitle) errors.push(`${label}.title must be a non-empty string`);
    if (/\r|\n/u.test(itemTitle)) errors.push(`${label}.title must be a single line`);
    // 正文保持字符串协议，允许用户指定的分点和段落。
    if (Array.isArray(item.content)) {
      errors.push(`${label}.content must be a single string, not an array`);
    } else if (typeof item.content !== "string" || !item.content.trim()) {
      errors.push(`${label}.content must be a non-empty string`);
    }
    // generation_notes 只约束模型本轮输出，不进入持久化大纲或页面生成输入。
    return {
      page_type: pageType === "cover" ? "cover" : "standard",
      title: itemTitle,
      ...(typeof item.creation_requirements === "string" && item.creation_requirements.trim() ? { creation_requirements: item.creation_requirements } : {}),
      content: typeof item.content === "string" ? item.content : "",
    };
  });
  if (errors.length > 0) throw new OutlineValidationError(errors);
  return { title, global_creation_requirements: value.global_creation_requirements as string, items };
}

export function validateGeneratedOutline(value: unknown): GeneratedOutline {
  return normalizeProductionOutline(value);
}

/** 大纲创建和改写共用输出协议，解析时丢弃生成说明。 */
export function validateRevisedOutline(value: unknown): GeneratedOutline {
  return normalizeProductionOutline(value);
}

export interface OutlineHeader {
  title: string;
  total_pages: number;
  global_creation_requirements: string;
}

export function validateOutlineHeader(value: unknown, expected?: number): OutlineHeader {
  const errors: string[] = [];
  if (!isRecord(value)) throw new OutlineValidationError(["标题和总页数必须是 JSON 对象。"]);
  exactKeys(value, ["title", "total_pages", "global_creation_requirements"], "header", errors);
  const title = cleanLine(value.title);
  if (!title || /[\r\n]/u.test(title)) errors.push("title 必须为非空单行字符串。");
  if (!Number.isSafeInteger(value.total_pages) || Number(value.total_pages) < 1) errors.push("total_pages 必须为正整数。");
  if (typeof value.global_creation_requirements !== "string") errors.push("global_creation_requirements 必须为字符串。");
  if (expected !== undefined && value.total_pages !== expected) errors.push(`total_pages 必须为已确认的 ${expected} 页，实际返回 ${value.total_pages}。`);
  if (errors.length) throw new OutlineValidationError(errors);
  return { title, total_pages: Number(value.total_pages), global_creation_requirements: value.global_creation_requirements as string };
}

export function validateOutlineChunk(value: unknown, start: number, end: number): OutlineDetail[] {
  const errors: string[] = [];
  if (!isRecord(value)) throw new OutlineValidationError(["分段响应必须为 JSON 对象。"]);
  exactKeys(value, ["items"], "chunk", errors);
  if (!Array.isArray(value.items)) throw new OutlineValidationError([...errors, "items 必须为数组。"]);
  const expected = end - start + 1;
  if (value.items.length !== expected) errors.push(`本段返回 ${value.items.length} 页，实际要求第 ${start}～${end} 页，共 ${expected} 页。`);
  const items = value.items.map((item, index) => {
    if (!isRecord(item)) return item;
    const { page_number, ...content } = item;
    if (page_number !== start + index) errors.push(`items[${index}].page_number 必须为 ${start + index}，实际为 ${page_number}。`);
    return content;
  });
  if (errors.length) throw new OutlineValidationError(errors);
  // 复用页面内容校验；临时页码和生成说明均不进入持久化大纲。
  return normalizeProductionOutline({ title: "分段校验", global_creation_requirements: "", items }).items;
}
