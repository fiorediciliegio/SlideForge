/**
 * M5 · 自动模板推荐：基于 brief 与预设元数据的确定性二元组打分（不用模型）。
 * 权重：name 3 / use_case 2 / industry 2 / description 1；中英混用按字符二元组匹配。
 */
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

const PRESETS_DIR = path.resolve(import.meta.dirname, "..", "features", "templates", "presets");

interface PresetMeta {
  id: string;
  name: string;
  description?: string;
  use_case?: string;
  industry?: string;
  score?: number;
}

let cache: PresetMeta[] | null = null;
async function loadMetas(): Promise<PresetMeta[]> {
  if (cache) return cache;
  const entries = await readdir(PRESETS_DIR, { withFileTypes: true });
  const metas: PresetMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(await readFile(path.join(PRESETS_DIR, entry.name, "preset.json"), "utf8"));
      metas.push(meta);
    } catch { /* skip */ }
  }
  cache = metas;
  return metas;
}

/** 文本 → 特征集合：英文/数字按整词，中文按字符二元组（避免 "an" 这类噪音二元组） */
function bigrams(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const grams = new Set<string>();
  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) {
    if (word.length >= 2) grams.add(word);
  }
  const cjkOnly = normalized.replace(/[a-z0-9\s]/g, "");
  for (let i = 0; i < cjkOnly.length - 1; i++) grams.add(cjkOnly.slice(i, i + 2));
  return grams;
}

export interface TemplateRecommendation {
  templateId: string;
  templateName: string;
  score: number;
  reason: string;
}

const FIELDS: Array<{ key: "name" | "use_case" | "industry" | "description"; weight: number; label: string }> = [
  { key: "name", weight: 3, label: "名称" },
  { key: "use_case", weight: 2, label: "场景" },
  { key: "industry", weight: 2, label: "行业" },
  { key: "description", weight: 1, label: "描述" },
];

const MIN_SCORE = 4; // 低于此分视为"没有合适的"，回退默认风格

/** 中文概念 → 英文元数据关键词映射（解决中文 brief × 英文元数据的匹配鸿沟） */
const CONCEPT_MAP: Array<{ cn: RegExp; en: string }> = [
  { cn: /融资|路演|轮次|投资人/, en: "fundraising pitch deck investor seed series" },
  { cn: /销售|营收|业绩|复盘|经营|回款/, en: "sales revenue business review quarterly performance" },
  { cn: /培训|入职|课程|教学|课件/, en: "training onboarding course education" },
  { cn: /旅行|旅游|行程|攻略/, en: "travel vacation trip guide" },
  { cn: /日本|赏樱|樱花|京都|东京/, en: "japan travel sakura cherry blossom" },
  { cn: /制造|工厂|工业|生产/, en: "manufacturing factory industrial smart factory" },
  { cn: /能源|新能源|充电桩|光伏|碳/, en: "energy renewable climate cleantech sustainability" },
  { cn: /医疗|健康|医院/, en: "healthcare medical health" },
  { cn: /教育|学校|校园/, en: "education school learning" },
  { cn: /营销|推广|品牌|市场/, en: "marketing brand campaign market" },
  { cn: /发布|新品|产品/, en: "product launch release" },
  { cn: /金融|银行|证券|保险/, en: "fintech finance banking" },
  { cn: /数据|大数据|分析|报表|BI/, en: "data analytics dashboard report" },
  { cn: /人工智能|AI|大模型|智能/, en: "ai artificial intelligence saas" },
  { cn: /电商|零售|商城/, en: "ecommerce retail shop" },
  { cn: /年报|年度|年终/, en: "annual report year review" },
  { cn: /技术|研发|工程|架构/, en: "technology engineering architecture" },
  { cn: /安全|合规|风控/, en: "security compliance risk" },
  { cn: /招聘|人力|团队|组织/, en: "hr hiring team organization" },
  { cn: /地产|建筑|城市/, en: "real estate architecture city" },
  { cn: /餐饮|食品|农业/, en: "food restaurant agriculture" },
];

function expandBrief(brief: string): string {
  const expansions = CONCEPT_MAP.filter(({ cn }) => cn.test(brief)).map(({ en }) => en);
  return `${brief} ${expansions.join(" ")}`;
}

export async function recommendTemplate(brief: string): Promise<TemplateRecommendation | null> {
  const metas = await loadMetas();
  const briefGrams = bigrams(expandBrief(brief));
  if (briefGrams.size === 0) return null;

  let best: { meta: PresetMeta; score: number; reasons: string[] } | null = null;
  for (const meta of metas) {
    let score = 0;
    const reasons: string[] = [];
    for (const field of FIELDS) {
      const value = meta[field.key];
      if (!value) continue;
      const grams = bigrams(value);
      let hits = 0;
      for (const gram of briefGrams) if (grams.has(gram)) hits++;
      if (hits > 0) {
        score += hits * field.weight;
        reasons.push(`${field.label}命中 ${hits} 个特征`);
      }
    }
    // 元数据自带质量分微调
    if (meta.score) score += Math.min(2, meta.score / 10);
    if (score > 0 && (!best || score > best.score)) best = { meta, score, reasons };
  }

  if (!best || best.score < MIN_SCORE) return null;
  return {
    templateId: best.meta.id,
    templateName: best.meta.name,
    score: Math.round(best.score * 10) / 10,
    reason: best.reasons.join("、") || "综合相似度最高",
  };
}
