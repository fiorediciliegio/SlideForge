/**
 * 三端共享的 deck 任务存储（CLI 除外，CLI 一次性进程）。
 * MCP stdio / MCP HTTP / REST 的 deck 任务互通：HTTP 创建的 deck，MCP 也能操作。
 */

export interface DeckJob {
  id: string;
  runDir?: string;
  title?: string;
  status: "creating" | "ready" | "error";
  events: string[];
  error?: string;
  overflowPages: number[];
  billing?: { points: number; balance?: number };
}

export const deckJobs = new Map<string, DeckJob>();
