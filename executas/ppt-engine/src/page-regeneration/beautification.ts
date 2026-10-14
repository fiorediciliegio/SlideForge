import path from "node:path";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { batchDirectory, fingerprint } from "./store.js";

// Capture source and its static snapshot once for all sessions in the batch.
// Saved manual edits already live in slides and participate like generated pages.
export async function prepareBeautificationSource(input: {
  workspaceDir: string; batchId: string; pageId: string; pageIndex: number;
  renderedSourceHash?: string | null; snapshotSourceHash?: string | null;
  snapshotHtmlPath?: string | null; manuallyEdited: boolean;
  render: (input: { manifestPath: string; outputDir: string; name: string; page: number }) => Promise<{ htmlPath: string }>;
}): Promise<{ source_html_path: string; source_snapshot_html_path: string }> {
  const slidesDir = await realpath(path.join(input.workspaceDir, "slides"));
  const sourcePath = await realpath(path.join(slidesDir, `${input.pageId}.html`));
  if (path.dirname(sourcePath) !== slidesDir) throw new Error("Beautification source must be inside slides/");
  const bytes = await readFile(sourcePath);
  if (!bytes.toString("utf8").trim()) throw new Error("PAGE_BEAUTIFICATION_SOURCE_UNAVAILABLE");
  const directory = path.join(batchDirectory(input.workspaceDir, input.batchId), "input");
  await mkdir(path.join(directory, "slides"), { recursive: true });
  const htmlPath = path.join(directory, "slides", `${input.pageId}.html`);
  await writeFile(htmlPath, bytes);
  if (input.snapshotHtmlPath && input.renderedSourceHash === fingerprint(bytes) && input.snapshotSourceHash === fingerprint(bytes)) {
    const snapshotPath = path.join(directory, "source.html");
    try {
      await copyFile(input.snapshotHtmlPath, snapshotPath);
      return { source_html_path: htmlPath, source_snapshot_html_path: snapshotPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const manifestPath = path.join(directory, "manifest.json");
  await copyFile(path.join(input.workspaceDir, "manifest.json"), manifestPath);
  const result = await input.render({ manifestPath, outputDir: directory, name: "source", page: input.pageIndex + 1 });
  return { source_html_path: htmlPath, source_snapshot_html_path: result.htmlPath };
}
