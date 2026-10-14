export interface RenderedPageEntry {
  key: string;
  pageId: string;
  title: string;
  html?: string;
  expiresAt?: number;
  frameFailed?: boolean;
  recoveryEligible?: boolean;
  status: "queued" | "loading" | "downloaded" | "prepared" | "ready" | "error";
}

export interface RenderedPageSession {
  entries: RenderedPageEntry[];
  selectedKey: string;
  visibleKey: string;
}

export const emptyRenderedPageSession: RenderedPageSession = { entries: [], selectedKey: "", visibleKey: "" };
export type RenderedPageAction =
  | { type: "sync"; entries: Array<{ key: string; pageId: string; title: string }>; selectedKey: string; complete: boolean }
  | { type: "loading"; key: string }
  | { type: "downloaded" | "replaced"; key: string; html: string; expiresAt: number }
  | { type: "select"; entry: Omit<RenderedPageEntry, "status" | "html">; retry?: boolean }
  | { type: "prepared"; key: string; html: string }
  | { type: "deferred"; key: string }
  | { type: "ready" | "error"; key: string; frameFailed?: boolean; recoveryEligible?: boolean };

export function pageFrameIsVisible(entry?: RenderedPageEntry): boolean {
  return entry?.status === "prepared" || entry?.status === "ready";
}

/** Owns live frames for one preview session. Text-cache expiry never evicts a loaded frame. */
export function reduceRenderedPageSession(state: RenderedPageSession, action: RenderedPageAction): RenderedPageSession {
  if (action.type === "sync") {
    const wanted = new Set(action.entries.map((entry) => entry.key));
    const pageIds = new Set(action.entries.map((entry) => entry.pageId));
    const entries = state.entries.filter((entry) => !action.complete || wanted.has(entry.key)
      || ((entry.status === "ready" || (entry.status === "prepared" && entry.key === state.visibleKey)) && pageIds.has(entry.pageId)));
    for (const input of action.entries) {
      if (!entries.some((entry) => entry.key === input.key)) entries.push({ ...input, status: "queued" });
    }
    const selected = entries.find((entry) => entry.key === action.selectedKey);
    const visibleKey = pageFrameIsVisible(selected) ? selected!.key
      : entries.some((entry) => entry.key === state.visibleKey) ? state.visibleKey : "";
    return { entries: entries.filter((entry) => wanted.has(entry.key) || !action.complete || entry.key === visibleKey
      || !entries.some((replacement) => replacement.pageId === entry.pageId && wanted.has(replacement.key) && replacement.status === "ready")),
      selectedKey: action.selectedKey, visibleKey };
  }
  if (action.type === "select") {
    const existing = state.entries.find((entry) => entry.key === action.entry.key);
    let entries = existing && !action.retry ? state.entries : [
      ...state.entries.filter((entry) => entry.key !== action.entry.key),
      { ...action.entry, status: action.retry ? "queued" as const : "loading" as const },
    ];
    if (existing?.status === "ready" && !action.retry) {
      entries = entries.filter((entry) => entry.pageId !== existing.pageId || entry.key === existing.key);
    }
    return { entries, selectedKey: action.entry.key,
      visibleKey: pageFrameIsVisible(existing) && !action.retry ? existing!.key : state.visibleKey };
  }
  const entry = state.entries.find((item) => item.key === action.key);
  // A superseded version can finish after its replacement; never resurrect it.
  if (!entry) return state;
  if (action.type === "loading") {
    return { ...state, entries: state.entries.map((item) => item.key === action.key
      ? { ...item, html: undefined, expiresAt: undefined, status: "loading" } : item) };
  }
  if (action.type === "downloaded" || action.type === "replaced") {
    if (action.type === "downloaded" && entry.status !== "loading") return state;
    return { ...state, entries: state.entries.map((item) => item.key === action.key
      ? { ...item, html: action.html, expiresAt: action.expiresAt,
          frameFailed: false, status: "downloaded" } : item) };
  }
  if (action.type === "deferred") {
    if (entry.status !== "prepared" || entry.key === state.visibleKey) return state;
    return { ...state, entries: state.entries.map((item) => item.key === action.key
      ? { ...item, status: "downloaded" } : item) };
  }
  if (action.type === "ready" && entry.status !== "prepared") return state;
  if (action.type === "error" && entry.status === "ready") return state;
  if (action.type !== "prepared" && action.type !== "ready" && action.type !== "error") return state;
  let entries = state.entries.map((item) => item.key !== action.key ? item : action.type === "prepared"
    ? { ...item, html: action.html, status: "prepared" as const }
    : { ...item, html: action.type === "error" ? undefined : item.html,
        frameFailed: action.type === "error" && action.frameFailed,
        recoveryEligible: action.type === "error" ? action.recoveryEligible : item.recoveryEligible,
        status: action.type });
  const show = (action.type === "prepared" || action.type === "ready") && state.selectedKey === action.key;
  if (action.type === "ready") entries = entries.filter((item) => item.pageId !== entry.pageId
    || item.key === entry.key || (!show && item.key === state.visibleKey));
  const failedSelected = action.type === "error" && state.selectedKey === action.key;
  const fallback = failedSelected
    ? entries.find((item) => item.pageId === entry.pageId && item.status === "ready")
    : undefined;
  return { ...state, entries, visibleKey: show ? action.key
    : failedSelected ? fallback?.key ?? "" : state.visibleKey };
}
