import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preparePreviewResources } from "./resources.js";
import { writeSlideScreenshots } from "../render/browser-artifacts.js";

/** Versions include local image/font bytes, without publishing resources or images. */
export async function fingerprintPageSnapshot(workspaceDir: string, htmlPath: string, html?: string): Promise<string> {
  const source = html ?? await readFile(htmlPath, "utf8");
  const prepared = await preparePreviewResources({ workspaceDir, htmlPath, html: source,
    resolve: async ({ bytes }) => ({
      url: `https://snapshot.invalid/${createHash("sha256").update(bytes).digest("hex")}`,
      expires_at: "9999-01-01T00:00:00Z",
    }),
  });
  return createHash("sha256").update(prepared.html).digest("hex");
}

const temporaryRoot = path.join(os.tmpdir(), "ppt-engine-session-screenshots");
const active = new Set<string>();

/** The upload transport currently requires a path. Never keep it in a Workspace. */
export async function withTransientPageScreenshot<T>(
  workspaceDir: string, htmlPath: string, consume: (screenshotPath: string) => Promise<T>,
  options: { expectedFingerprint?: string; capture?: typeof writeSlideScreenshots } = {},
): Promise<T> {
  await mkdir(temporaryRoot, { recursive: true });
  // Recover leftovers from crashes, without touching another live request.
  for (const name of await readdir(temporaryRoot)) {
    if (!name.startsWith("capture-")) continue;
    const target = path.join(temporaryRoot, name);
    if (active.has(target)) continue;
    const info = await stat(target).catch(() => null);
    if (info && Date.now() - info.mtimeMs > 24 * 60 * 60 * 1000) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const directory = await mkdtemp(path.join(temporaryRoot, "capture-"));
  active.add(directory);
  try {
    const version = await fingerprintPageSnapshot(workspaceDir, htmlPath);
    if (options.expectedFingerprint && version !== options.expectedFingerprint) throw new Error("Page changed before screenshot capture");
    const screenshotPath = path.join(directory, "page.png");
    await (options.capture ?? writeSlideScreenshots)([{ html: "", htmlPath, outputPath: screenshotPath }], "Session visual attachment", { requireTailwind: false });
    if (await fingerprintPageSnapshot(workspaceDir, htmlPath) !== version) throw new Error("Page changed during screenshot capture");
    const result = await consume(screenshotPath);
    if (await fingerprintPageSnapshot(workspaceDir, htmlPath) !== version) throw new Error("Page changed during screenshot upload");
    return result;
  } finally {
    active.delete(directory);
    await rm(directory, { recursive: true, force: true });
  }
}
