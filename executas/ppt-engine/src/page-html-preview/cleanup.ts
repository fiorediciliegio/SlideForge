import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

async function regularFile(file: string) {
  return Boolean(await lstat(file).then((info) => info.isFile() && !info.isSymbolicLink()).catch(() => false));
}

/** Only known generated artifacts. Never traverse source images or asset directories. */
export async function cleanupGeneratedPageImages(workspaceDir: string, pages: Array<{ last_html_path?: string }>): Promise<void> {
  const root = await realpath(workspaceDir);
  async function contained(directory: string) {
    const resolved = await realpath(directory).catch(() => null);
    if (!resolved) return false;
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }
  // Leave an incomplete/legacy workspace intact until HTML can replace its images.
  if (!pages.length || !(await Promise.all(pages.map((page) => page.last_html_path ? regularFile(page.last_html_path) : false))).every(Boolean)) return;
  async function removeFiles(directory: string, matches: (name: string) => boolean) {
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink() || !await contained(directory)) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && matches(entry.name)) await rm(path.join(directory, entry.name), { force: true });
    }
  }
  for (const directory of ["screenshots", "app-render"]) {
    await removeFiles(path.join(workspaceDir, "output", directory), (name) => name.endsWith(".png"));
  }
  for (const directory of ["covers", "page-previews"]) {
    await removeFiles(path.join(workspaceDir, "output", directory), (name) => name.endsWith(".webp"));
  }
  async function walk(directory: string, visit: (directory: string) => Promise<void>) {
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink() || !await contained(directory)) return;
    await visit(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path.join(directory, entry.name), visit);
    }
  }
  await walk(path.join(workspaceDir, "manual-edits"), async (directory) => {
    if (await regularFile(path.join(directory, "current.html"))) {
      await removeFiles(directory, (name) => name === "current.png");
    }
  });
  await walk(path.join(workspaceDir, "output", "page-regenerations"), async (directory) => {
    if (await regularFile(path.join(directory, "page.html"))) await removeFiles(directory, (name) => name === "page.png");
  });
  const batchesRoot = path.join(workspaceDir, ".page-regenerations");
  await walk(batchesRoot, async (directory) => {
    if (!await regularFile(path.join(directory, "batch.json"))) return;
    const batch = await readFile(path.join(directory, "batch.json"), "utf8").then(JSON.parse).catch(() => null);
    for (const candidate of batch?.candidates ?? []) {
      if (typeof candidate.html_path !== "string" || !await regularFile(candidate.html_path) || typeof candidate.screenshot_path !== "string") continue;
      const relative = path.relative(directory, candidate.screenshot_path);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      // Reject symlinked parents as well as symlinked files.
      const parts = relative.split(path.sep);
      let parent = directory;
      let safe = true;
      for (const part of parts.slice(0, -1)) {
        parent = path.join(parent, part);
        const info = await lstat(parent).catch(() => null);
        if (!info?.isDirectory() || info.isSymbolicLink()) { safe = false; break; }
      }
      if (safe && await regularFile(candidate.screenshot_path)) await rm(candidate.screenshot_path, { force: true });
    }
    // Old beautification input is rebuildable from the retained source HTML.
    if (batch?.mode === "beautify" && batch.status !== "running") {
      await removeFiles(path.join(directory, "input"), (name) => name.endsWith(".png"));
    }
  });
}
