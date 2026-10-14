import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { getPptWorkspaceRoot } from "../workspace-root.js";

export const userTemplateRoot = () => path.join(getPptWorkspaceRoot(), "user-templates");
export function userTemplateDirectory(id: string): string {
  if (!/^user-[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid user template ID");
  return path.join(userTemplateRoot(), id);
}
export async function resolveUserTemplateDirectory(id: string): Promise<string> {
  const directory = userTemplateDirectory(id);
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("Unknown user template");
    throw error;
  });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid user template directory");
  const [root, resolved, pptRoot] = await Promise.all([realpath(userTemplateRoot()), realpath(directory), realpath(getPptWorkspaceRoot())]);
  if (root !== path.join(pptRoot, "user-templates") || resolved !== path.join(root, id)) throw new Error("User template directory escaped its root");
  return resolved;
}
