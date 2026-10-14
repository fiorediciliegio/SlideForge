export interface ManualToolbarItemSize {
  id: string;
  width: number;
  priority: number;
  pinned?: boolean;
}

/** Lower priorities stay on the toolbar longer; overflow keeps its original order. */
export function manualToolbarOverflow(
  items: readonly ManualToolbarItemSize[],
  availableWidth: number,
  gap: number,
): string[] {
  const hidden = new Set<string>();
  let width = items.reduce((total, item) => total + item.width, 0) + Math.max(0, items.length - 1) * gap;
  const candidates = items.map((item, index) => ({ ...item, index })).filter((item) => !item.pinned)
    .sort((left, right) => right.priority - left.priority || right.index - left.index);
  for (const item of candidates) {
    if (width <= availableWidth) break;
    width -= item.width + (hidden.size < items.length - 1 ? gap : 0);
    hidden.add(item.id);
  }
  return items.filter((item) => hidden.has(item.id)).map((item) => item.id);
}
