import type { OutlineDetail } from "../../data/mockDeck";

export interface EditableOutline {
  title: string;
  global_creation_requirements?: string;
  items: OutlineDetail[];
}

export function cloneOutlineItems(items: OutlineDetail[]): OutlineDetail[] {
  return items.map((item) => ({
    ...item,
    ...(item.selected_image_ids ? { selected_image_ids: [...item.selected_image_ids] } : {}),
    ...(item.title_segments ? { title_segments: item.title_segments.map((segment) => ({ ...segment })) } : {}),
    ...(item.research ? { research: structuredClone(item.research) } : {}),
    ...(item.analysis ? { analysis: { ...item.analysis } } : {}),
  }));
}

/** 校验正文但不重写用户文案、分点、空白或换行。 */
export function normalizeOutlineContentText(value: string): string {
  if (!value.trim()) throw new Error("页面内容不能为空。");
  return value;
}

function normalizeSingleLine(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空。`);
  if (/\r|\n/u.test(normalized)) throw new Error(`${label}必须为单行文本。`);
  return normalized;
}

export function normalizeValidOutline(input: EditableOutline): EditableOutline {
  const title = normalizeSingleLine(input.title, "演示文稿标题");
  if (input.items.length === 0) throw new Error("大纲至少需要保留一页。");
  return {
    title,
    global_creation_requirements: input.global_creation_requirements ?? "",
    items: input.items.map((item, index) => {
      const content = normalizeOutlineContentText(item.content ?? "");
      return {
        page_type: item.page_type,
        ...(item.selected_image_ids ? { selected_image_ids: [...item.selected_image_ids] } : {}),
        title: normalizeSingleLine(item.title, `第 ${index + 1} 页标题`),
        content,
        ...(item.creation_requirements?.trim() ? { creation_requirements: item.creation_requirements } : {}),
        ...(item.title_segments ? { title_segments: item.title_segments.map((segment) => ({ ...segment })) } : {}),
        ...(item.research ? { research: structuredClone(item.research) } : {}),
        ...(item.analysis ? { analysis: { ...item.analysis } } : {}),
      };
    }),
  };
}

export function outlinesEqual(left: EditableOutline, right: EditableOutline): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
