import type { RenderedPageSession } from "./renderedPageSession";

export interface PagePreviewSource {
  pageId: string;
  title: string;
  version: string;
  expectedFingerprint?: string;
}

export function pagePreviewKey(workspaceDir: string, page: PagePreviewSource): string {
  return JSON.stringify([workspaceDir, page.pageId, page.version, page.expectedFingerprint]);
}

/** Current page first, then nearby pages (next before previous), then the rest. */
export function prioritizePagePreviews<T extends { key: string }>(pages: T[], selectedKey: string): T[] {
  const selectedIndex = Math.max(0, pages.findIndex((page) => page.key === selectedKey));
  return pages.map((page, index) => ({ page, index }))
    .sort((a, b) => Math.abs(a.index - selectedIndex) - Math.abs(b.index - selectedIndex) || b.index - a.index)
    .map(({ page }) => page);
}

export function planPagePreviewWork(state: RenderedPageSession, keys: string[], pendingLoads: number, now = Date.now()) {
  const entries = new Map(state.entries.map((entry) => [entry.key, entry]));
  const ordered = keys.map((key) => entries.get(key)).filter((entry) => entry !== undefined);
  const expired = (entry: typeof ordered[number]) => entry.status === "downloaded" && (entry.expiresAt ?? 0) <= now;
  const preparing = state.entries.filter((entry) => entry.status === "prepared");
  const available = ordered.filter((entry) => entry.status === "downloaded" && !expired(entry));
  const selected = available.find((entry) => entry.key === state.selectedKey);
  const priority = new Map(keys.map((key, index) => [key, index]));
  // Keep one of four slots for the foreground. On a rapid jump, an unfinished
  // background frame yields its slot; already loaded frames are never evicted.
  const defer = selected && preparing.length >= 4
    ? preparing.filter((entry) => entry.key !== state.visibleKey)
      .sort((a, b) => (priority.get(b.key) ?? keys.length) - (priority.get(a.key) ?? keys.length)).slice(0, 1)
    : [];
  const render = selected ? [selected] : [];
  const active = preparing.filter((entry) => !defer.includes(entry));
  const backgroundSlots = Math.max(0, Math.min(
    3 - active.filter((entry) => entry.key !== state.selectedKey).length,
    4 - active.length - render.length,
  ));
  render.push(...available.filter((entry) => entry !== selected).slice(0, backgroundSlots));
  return {
    fetch: ordered.filter((entry) => entry.status === "queued" || expired(entry)).slice(0, Math.max(0, 10 - pendingLoads)),
    defer,
    render,
  };
}
