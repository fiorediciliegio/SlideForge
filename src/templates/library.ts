/**
 * M5 · 内置模板库：98 套 Visual Style Preset 的目录与参考页读取。
 * 参考页 HTML 作为风格锚点注入生成提示词（学风格，不抄内容）。
 */
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

const PRESETS_DIR = path.resolve(import.meta.dirname, "..", "features", "templates", "presets");

export interface TemplateSummary {
  id: string;
  name: string;
  theme: "dark" | "light";
  description: string;
}

export async function listTemplates(): Promise<TemplateSummary[]> {
  const entries = await readdir(PRESETS_DIR, { withFileTypes: true });
  const templates: TemplateSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(await readFile(path.join(PRESETS_DIR, entry.name, "preset.json"), "utf8"));
      templates.push({
        id: meta.id ?? entry.name,
        name: meta.name ?? entry.name,
        theme: meta.theme === "dark" ? "dark" : "light",
        description: meta.description ?? "",
      });
    } catch { /* 跳过无元数据目录 */ }
  }
  return templates.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** 读取模板参考页（封面 + 一个内容页），压缩到预算内。 */
export async function getTemplateReference(templateId: string): Promise<string> {
  const dir = path.join(PRESETS_DIR, templateId, "html");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".html")).sort();
  if (files.length === 0) throw new Error(`模板 ${templateId} 无参考页`);
  const picks = [files[0], files[Math.min(1, files.length - 1)]];
  const parts: string[] = [];
  for (const file of new Set(picks)) {
    const html = await readFile(path.join(dir, file), "utf8");
    parts.push(`<参考页 ${file}>\n${html.slice(0, 5000)}`);
  }
  return parts.join("\n\n").slice(0, 10000);
}
