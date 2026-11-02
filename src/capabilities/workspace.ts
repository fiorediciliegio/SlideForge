import path from "node:path";
import { mkdir } from "node:fs/promises";
import { assertDeckId, type DeckId } from "../contracts/ids.js";

/** 将外部 deck_id 安全映射为唯一工作区，禁止路径逃逸和静默复用。 */
export function resolveDeckRunDir(decksRoot: string, deckId: string): string {
  const id: DeckId = assertDeckId(deckId);
  const root = path.resolve(decksRoot);
  const runDir = path.resolve(root, id);
  if (path.dirname(runDir) !== root) throw new Error("deck 工作区路径越界");
  return runDir;
}

export async function createDeckWorkspace(decksRoot: string, deckId: string): Promise<string> {
  const root = path.resolve(decksRoot);
  const runDir = resolveDeckRunDir(root, deckId);
  await mkdir(root, { recursive: true });
  await mkdir(runDir, { recursive: false });
  return runDir;
}
