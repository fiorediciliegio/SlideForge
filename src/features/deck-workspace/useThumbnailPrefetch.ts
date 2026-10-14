import { useCallback, useEffect, useState } from "react";

type Status = "loading" | "settled";
type Work = ReadonlyMap<string, Status>;

export function prioritizeThumbnailPrefetch(keys: string[], selectedKey: string | undefined, visible: ReadonlySet<string>): string[] {
  const selectedIndex = Math.max(0, selectedKey ? keys.indexOf(selectedKey) : 0);
  return keys.map((key, index) => ({ key, index }))
    .sort((a, b) => Number(b.key === selectedKey) - Number(a.key === selectedKey)
      || Number(visible.has(b.key)) - Number(visible.has(a.key))
      || Math.abs(a.index - selectedIndex) - Math.abs(b.index - selectedIndex) || b.index - a.index)
    .map(({ key }) => key);
}

/** Keep one of four slots available to selected/near-visible thumbnails. */
function planThumbnailPrefetch(keys: string[], selectedKey: string | undefined, visible: ReadonlySet<string>, work: Work): Work {
  const next = new Map(keys.filter((key) => work.has(key)).map((key) => [key, work.get(key)!]));
  const foreground = (key: string) => key === selectedKey || visible.has(key);
  let active = [...next.values()].filter((status) => status === "loading").length;
  let background = [...next].filter(([key, status]) => status === "loading" && !foreground(key)).length;
  for (const key of prioritizeThumbnailPrefetch(keys, selectedKey, visible)) {
    if (next.has(key) || active >= 4 || (!foreground(key) && background >= 3)) continue;
    next.set(key, "loading");
    active++;
    if (!foreground(key)) background++;
  }
  return next.size === work.size && [...next].every(([key, status]) => work.get(key) === status) ? work : next;
}

/** The rail owns its work; unmounting it stops scheduling unopened thumbnails. */
export function useThumbnailPrefetch(keys: string[], selectedKey: string | undefined, visible: ReadonlySet<string>, enabled: boolean) {
  const [work, setWork] = useState<Work>(() => new Map());
  const keysJson = JSON.stringify(keys);
  useEffect(() => {
    if (enabled) setWork((current) => planThumbnailPrefetch(JSON.parse(keysJson) as string[], selectedKey, visible, current));
  }, [keysJson, selectedKey, visible, enabled, work]);
  const settle = useCallback((key: string) => setWork((current) => {
    if (current.get(key) !== "loading") return current;
    return new Map(current).set(key, "settled");
  }), []);
  return { work, settle };
}
