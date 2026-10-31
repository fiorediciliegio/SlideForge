/**
 * F4 · 母版对话优化：用自然语言调整品牌视觉档案，输出字段级偏离度报告。
 * 模型只做语义映射（指令 → 字段），字段合法性由代码校验。
 */
import { llmComplete } from "../../scripts/m0/llmClient.js";
import type { BrandProfile } from "./profile.js";

export interface ProfileDrift {
  field: string;
  from?: string;
  to?: string;
}

export async function optimizeBrandProfile(
  profile: BrandProfile & Record<string, unknown>,
  instruction: string,
): Promise<{ profile: BrandProfile & Record<string, unknown>; drift: ProfileDrift[] }> {
  const messages = [
    {
      role: "system" as const,
      content: `你是品牌视觉档案编辑器。只输出 JSON，不要其他文字。
档案字段：primary/accent/background/text/muted（6 位 hex，不带 #）、fontFamily（字体栈）、layout（版式对象，含 padding/titleSize/cardRadius）。
只修改用户指令涉及的字段，其余原样保留。hex 必须合法。`,
    },
    {
      role: "user" as const,
      content: `当前档案：${JSON.stringify(profile)}
用户指令：${instruction}
输出修改后的完整档案 JSON（保持相同结构）。`,
    },
  ];
  const result = await llmComplete(messages);
  let json = result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const begin = json.indexOf("{");
  const end = json.lastIndexOf("}");
  if (begin >= 0 && end > begin) json = json.slice(begin, end + 1);
  const next = JSON.parse(json) as BrandProfile & Record<string, unknown>;

  // 字段合法性校验：hex 不合规则回退到旧值
  for (const field of ["primary", "accent", "background", "text", "muted"] as const) {
    const value = next[field];
    if (typeof value !== "string" || !/^[0-9a-fA-F]{6}$/.test(value)) {
      next[field] = profile[field];
    }
  }

  const drift: ProfileDrift[] = [];
  for (const key of new Set([...Object.keys(profile), ...Object.keys(next)])) {
    const from = JSON.stringify(profile[key]);
    const to = JSON.stringify(next[key]);
    if (from !== to) drift.push({ field: key, from, to });
  }
  return { profile: next, drift };
}
