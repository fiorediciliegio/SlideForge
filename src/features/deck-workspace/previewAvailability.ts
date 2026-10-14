import { useSyncExternalStore } from "react";

const unavailable = new Set<string>();
const listeners = new Set<() => void>();
const identity = (workspaceDir: string, pageId: string) => JSON.stringify([workspaceDir, pageId]);
export function setPagePreviewUnavailable(workspaceDir: string, pageId: string, value: boolean) {
  const key = identity(workspaceDir, pageId);
  if (unavailable.has(key) === value) return;
  if (value) unavailable.add(key); else unavailable.delete(key);
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function usePagePreviewUnavailable(workspaceDir = "", pageId = "") {
  return useSyncExternalStore(subscribe, () => unavailable.has(identity(workspaceDir, pageId)), () => false);
}
