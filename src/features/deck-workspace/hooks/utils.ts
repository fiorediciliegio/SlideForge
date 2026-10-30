/**
 * deck-workspace 通用纯函数工具（自 useDeckWorkspace.ts 抽离，零状态依赖）。
 * 该 hook 的拆分计划见 docs/plans/20261030-useDeckWorkspace拆分计划.md
 */

export function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatWorkspaceDate(date = new Date()): string {
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join("-");
}

export function clampSlideIndex(index: number, slideCount: number): number {
  const maxIndex = Math.max(0, slideCount - 1);
  return Math.min(Math.max(0, index), maxIndex);
}

export function appendBounded(items: string[], value: string, limit: number): string[] {
  const trimmed = value.trim();
  if (!trimmed) return items;
  return [...items, trimmed].slice(-limit);
}

export function appendStreamText(lines: string[], text: string): string[] {
  if (!text) return lines;
  const current = lines.length > 0 ? lines.slice() : [""];
  const parts = text.split(/\r?\n/);
  current[current.length - 1] = `${current[current.length - 1]}${parts[0] ?? ""}`;
  for (const part of parts.slice(1)) current.push(part);
  return current.slice(-80);
}
