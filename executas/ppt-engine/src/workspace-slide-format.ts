import path from "node:path";
import { readFile } from "node:fs/promises";
import { slideFormat } from "./slide-format.js";

export async function readWorkspaceSlideFormat(workspaceDir: string) {
  try {
    const requirements = JSON.parse(await readFile(path.join(workspaceDir, "requirements.json"), "utf8"));
    return slideFormat(requirements.selections?.aspect_ratio);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return slideFormat();
    throw error;
  }
}
